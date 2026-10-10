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
import { errorMessage } from '../core/errors';
import { acquireFlock, flockFailure, openLockFile, startFlockProcess, type FlockAttempt, type FlockProcess } from '../core/helperChannel/lockFile';

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
  return async (environmentId) => {
    const timeoutMs = deps.timeoutMs ?? STOP_FLOCK_TIMEOUT_MS;
    // Cleanup C5 (plan step 11J, B3): the acquisition of lockFile.ts (no wait, bounded); the outcomes keep their texts.
    let attempt: FlockAttempt;
    try {
      attempt = await acquireFlock({
        open: () => deps.openLockFile(deps.stateDir, environmentId),
        close: (fd) => deps.closeFile(fd),
        start: (args, fd) => deps.startFlock(args, fd),
        timeoutMs,
      });
    } catch (error) {
      return { kind: 'failed', detail: `flock could not be started: ${errorMessage(error)}` };
    }
    switch (attempt.kind) {
      case 'locked':
        return { kind: 'locked', release: attempt.release };
      case 'busy':
        return { kind: 'busy' };
      case 'openFailed':
        return { kind: 'failed', detail: `the lock file could not be opened: ${errorMessage(attempt.error)}` };
      case 'startThrew':
        return { kind: 'failed', detail: `flock could not be started: ${errorMessage(attempt.error)}` };
      case 'startFailed':
        return { kind: 'failed', detail: `flock could not be started: ${attempt.detail}` };
      case 'timeout':
        return { kind: 'failed', detail: `flock did not end within ${timeoutMs / 1000} s` };
      case 'failed':
        return { kind: 'failed', detail: flockFailure(attempt, true) };
      case 'cancelled':
        // Never: no signal is given.
        return { kind: 'failed', detail: 'the lock was cancelled' };
    }
  };
}
