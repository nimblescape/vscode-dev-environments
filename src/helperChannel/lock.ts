// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: the operation `lock` of the worker (protocol.ts, OP_LOCK): the lock of one environment on the Docker
// host. The worker opens the lock file (never through a symbolic link) and keeps it open; `flock` takes the kernel lock on
// that open file, which it inherits as its file descriptor 3, and exits; the lock then stays with the file of the worker
// until the operation is cancelled (the file is closed) or the worker ends (the kernel frees it). A lock is never taken
// over or forced, and the lock files are never deleted. Plan step 8, PR B: the open of the lock file and the start of
// `flock` are in src/core/helperChannel/lockFile.ts, which the Session Monitor container uses for its stops too (D2).
import * as fs from 'fs';
import {
  LOCK_BUSY_CODE,
  LOCK_BUSY_EXIT,
  LOCK_HELD_STEP,
  LOCK_HOLD_LIMIT_MS,
  LOCK_STATE_DIR,
  flockArgs,
  parseLockParams,
} from '../core/helperChannel/protocol';
import { FLOCK_FD, openLockFile, startFlockProcess, type FlockProcess } from '../core/helperChannel/lockFile';
import { OperationError, type OperationHandler } from './server';

export { FLOCK_FD, openLockFile, startFlockProcess, type FlockProcess };

export interface LockDeps {
  /** The mount point of the volume of the Session Monitor. */
  stateDir: string;
  /** Opens (creates) the lock file; returns its file descriptor. Throws when it is not a plain file of its own. */
  openLockFile(stateDir: string, environmentId: string): number;
  closeFile(fd: number): void;
  /** Starts `flock <args>` with `fd` as its file descriptor FLOCK_FD. */
  startFlock(args: readonly string[], fd: number): FlockProcess;
  /** Only for the tests: LOCK_HOLD_LIMIT_MS. */
  holdLimitMs?: number;
}

export const LOCK_DEPS: LockDeps = {
  stateDir: LOCK_STATE_DIR,
  openLockFile,
  closeFile: (fd) => fs.closeSync(fd),
  startFlock: startFlockProcess,
};

/** Resolves when `signal` aborts or after `ms`, whichever comes first. Plan step 6, PR B: also the hold of `batch`. */
export function abortedOrAfter(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Plan step 11B2: takes the lock of `environmentId` within the operation of `signal` (the open of the lock file, then
 * `flock` with `waitSeconds`), and resolves with the function that lets it go. Throws an OperationError: `busy`
 * (LOCK_BUSY_CODE) when another holder kept it for the whole wait, `cancelled`, or `failed`. The one way the worker takes
 * a lock: for `lock` and for every flow that changes an environment.
 */
export async function takeEnvironmentLock(deps: LockDeps, environmentId: string, waitSeconds: number, signal: AbortSignal): Promise<() => void> {
  let fd: number;
  try {
    fd = deps.openLockFile(deps.stateDir, environmentId);
  } catch (error) {
    throw new OperationError('failed', `The lock file could not be opened: ${(error as Error).message}`);
  }
  const release = () => {
    // Lets go of the lock (the only other holder of the open file, flock, has ended).
    try {
      deps.closeFile(fd);
    } catch {
      // Closed already.
    }
  };
  try {
    if (signal.aborted) throw new OperationError('cancelled', 'The lock operation was cancelled.');
    let flock: FlockProcess;
    try {
      flock = deps.startFlock(flockArgs(waitSeconds, FLOCK_FD), fd);
    } catch (error) {
      throw new OperationError('failed', `flock could not be started: ${(error as Error).message}`);
    }
    // A cancel while it waits: flock ends without the lock.
    const endFlock = () => flock.kill('SIGKILL');
    signal.addEventListener('abort', endFlock, { once: true });
    if (signal.aborted) endFlock();
    let outcome: { exitCode: number | null; error?: string; stderr?: string };
    try {
      outcome = await flock.exited;
    } finally {
      signal.removeEventListener('abort', endFlock);
    }
    if (signal.aborted) throw new OperationError('cancelled', 'The lock operation was cancelled.');
    if (outcome.error !== undefined) throw new OperationError('failed', `flock could not be started: ${outcome.error}`);
    if (outcome.exitCode === LOCK_BUSY_EXIT) {
      throw new OperationError(LOCK_BUSY_CODE, `The lock stayed held by another holder for ${waitSeconds} s.`);
    }
    if (outcome.exitCode !== 0) {
      throw new OperationError('failed', `flock failed (${outcome.exitCode === null ? 'ended by a signal' : `exit code ${outcome.exitCode}`})${outcome.stderr ? `: ${outcome.stderr}` : ''}`);
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

/** The operation `lock` (see the module comment). */
export function lockOperation(deps: LockDeps = LOCK_DEPS): OperationHandler {
  return async (params, context) => {
    const checked = parseLockParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the lock operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The lock operation takes no secret.');
    context.progress('lock', checked.environmentId);
    const release = await takeEnvironmentLock(deps, checked.environmentId, checked.waitSeconds, context.signal);
    try {
      context.progress(LOCK_HELD_STEP, checked.environmentId);
      await abortedOrAfter(context.signal, deps.holdLimitMs ?? LOCK_HOLD_LIMIT_MS);
      if (!context.signal.aborted) throw new OperationError('timeout', 'The lock was held for its longest time and was let go.');
      return {};
    } finally {
      release();
    }
  };
}
