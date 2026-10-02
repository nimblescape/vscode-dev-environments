// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 8, PR B (user decision D2 of 2026-09-30): the environment lock of an automatic stop of the Session Monitor
// container. Before it stops an environment, the monitor opens the same lock file as the worker
// (src/core/helperChannel/lockFile.ts: strict ID, O_NOFOLLOW, 0600, never deleted) and runs `flock -n` on it (no wait:
// a lock that an operation holds is not waited for; the monitor tries again at a later tick). The lock lives with the
// open file of the monitor; `release` closes it. When the monitor process ends (an exit, `docker stop`, a kill), the
// kernel frees it.
import * as fs from 'fs';
import { LOCK_BUSY_EXIT, flockNoWaitArgs } from '../core/helperChannel/protocol';
import { FLOCK_FD, openLockFile, startFlockProcess, type FlockProcess } from '../core/helperChannel/lockFile';

/** What an attempt to take the lock of an environment gave. `failed`: never stop without the lock (D2). */
export type StopLockAttempt = { kind: 'locked'; release(): void } | { kind: 'busy' } | { kind: 'failed'; detail: string };

/** Tries the lock of one environment without waiting. Never rejects. */
export type StopLocker = (environmentId: string) => Promise<StopLockAttempt>;

/** How long `flock -n` may take (it never waits for the lock; this only bounds a hung start). */
export const STOP_FLOCK_TIMEOUT_MS = 10_000;

export interface StopLockDeps {
  /** The mount point of the volume of the monitor (`/state`). */
  stateDir: string;
  openLockFile(stateDir: string, environmentId: string): number;
  closeFile(fd: number): void;
  startFlock(args: readonly string[], fd: number): FlockProcess;
  /** Only for the tests: STOP_FLOCK_TIMEOUT_MS. */
  timeoutMs?: number;
}

export function stopLockDeps(stateDir: string): StopLockDeps {
  return { stateDir, openLockFile, closeFile: (fd) => fs.closeSync(fd), startFlock: startFlockProcess };
}

/** The StopLocker of `run` (see the module comment). */
export function stopLocker(deps: StopLockDeps): StopLocker {
  const close = (fd: number) => {
    try {
      deps.closeFile(fd);
    } catch {
      // Closed already.
    }
  };
  return async (environmentId) => {
    let fd: number;
    try {
      fd = deps.openLockFile(deps.stateDir, environmentId);
    } catch (error) {
      return { kind: 'failed', detail: `the lock file could not be opened: ${error instanceof Error ? error.message : String(error)}` };
    }
    let outcome: { exitCode: number | null; error?: string; stderr?: string } | 'timeout';
    try {
      const flock = deps.startFlock(flockNoWaitArgs(FLOCK_FD), fd);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), deps.timeoutMs ?? STOP_FLOCK_TIMEOUT_MS)));
      outcome = await Promise.race([flock.exited, timeout]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        flock.kill('SIGKILL');
        await flock.exited;
      }
    } catch (error) {
      close(fd);
      return { kind: 'failed', detail: `flock could not be started: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (outcome !== 'timeout' && outcome.error === undefined && outcome.exitCode === 0) {
      let released = false;
      return {
        kind: 'locked',
        release: () => {
          if (released) return;
          released = true;
          close(fd);
        },
      };
    }
    // Not held by this monitor (a killed flock that took it lets it go with the close).
    close(fd);
    if (outcome === 'timeout') return { kind: 'failed', detail: `flock did not end within ${(deps.timeoutMs ?? STOP_FLOCK_TIMEOUT_MS) / 1000} s` };
    if (outcome.error !== undefined) return { kind: 'failed', detail: `flock could not be started: ${outcome.error}` };
    if (outcome.exitCode === LOCK_BUSY_EXIT) return { kind: 'busy' };
    return {
      kind: 'failed',
      detail: `flock failed (${outcome.exitCode === null ? 'ended by a signal' : `exit code ${outcome.exitCode}`})${outcome.stderr ? `: ${outcome.stderr}` : ''}`,
    };
  };
}
