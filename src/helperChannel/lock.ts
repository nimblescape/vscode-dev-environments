// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: the operation `lock` of the worker (protocol.ts, OP_LOCK): the lock of one environment on the Docker
// host. The worker opens the lock file (never through a symbolic link) and keeps it open; `flock` takes the kernel lock on
// that open file, which it inherits as its file descriptor 3, and exits; the lock then stays with the file of the worker
// until the operation is cancelled (the file is closed) or the worker ends (the kernel frees it). A lock is never taken
// over or forced, and the lock files are never deleted.
import { spawn } from 'child_process';
import * as fs from 'fs';
import {
  LOCK_BUSY_CODE,
  LOCK_BUSY_EXIT,
  LOCK_HELD_STEP,
  LOCK_HOLD_LIMIT_MS,
  LOCK_STATE_DIR,
  flockArgs,
  lockFilePath,
  lockFolder,
  parseLockParams,
} from '../core/helperChannel/protocol';
import { OperationError, type OperationHandler } from './server';

/** The file descriptor of the lock file in `flock`. */
export const FLOCK_FD = 3;

/** A started `flock`. */
export interface FlockProcess {
  /** Its exit code (null after a signal); `error` when it could not be started. */
  readonly exited: Promise<{ exitCode: number | null; error?: string; stderr?: string }>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

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

/**
 * Opens the lock file of an environment: the folder `locks` (0700, created when missing, never a symbolic link), then
 * the file with O_NOFOLLOW (0600; a symbolic link fails with ELOOP) and O_NONBLOCK (a FIFO put there would not hang the
 * open); anything but a plain file is refused. Node.js opens it with O_CLOEXEC, so the Docker calls of the worker never
 * inherit it (only `flock`, on purpose).
 */
export function openLockFile(stateDir: string, environmentId: string): number {
  const folder = lockFolder(stateDir);
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const folderStat = fs.lstatSync(folder);
  if (!folderStat.isDirectory()) throw new Error(`${folder} is not a folder.`);
  if ((folderStat.mode & 0o777) !== 0o700) fs.chmodSync(folder, 0o700);
  const { O_RDWR, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(lockFilePath(environmentId, stateDir), O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`The lock file of ${environmentId} is not a plain file.`);
    if ((stat.mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return fd;
}

/** `flock` without a shell and without variables of its own; `fd` becomes its file descriptor FLOCK_FD. */
export function startFlockProcess(args: readonly string[], fd: number): FlockProcess {
  const child = spawn('flock', [...args], { shell: false, stdio: ['ignore', 'ignore', 'pipe', fd] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2_000);
  });
  const exited = new Promise<{ exitCode: number | null; error?: string; stderr?: string }>((resolve) => {
    let done = false;
    child.on('error', (error) => {
      if (done) return;
      done = true;
      resolve({ exitCode: null, error: error.message });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      resolve({ exitCode: code, stderr: stderr.trim() });
    });
  });
  return {
    exited,
    kill: (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  };
}

export const LOCK_DEPS: LockDeps = {
  stateDir: LOCK_STATE_DIR,
  openLockFile,
  closeFile: (fd) => fs.closeSync(fd),
  startFlock: startFlockProcess,
};

/** Resolves when `signal` aborts or after `ms`, whichever comes first. */
function abortedOrAfter(signal: AbortSignal, ms: number): Promise<void> {
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

/** The operation `lock` (see the module comment). */
export function lockOperation(deps: LockDeps = LOCK_DEPS): OperationHandler {
  return async (params, context) => {
    const checked = parseLockParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the lock operation are invalid.');
    if (context.secret !== undefined) throw new OperationError('invalid', 'The lock operation takes no secret.');
    context.progress('lock', checked.environmentId);
    let fd: number;
    try {
      fd = deps.openLockFile(deps.stateDir, checked.environmentId);
    } catch (error) {
      throw new OperationError('failed', `The lock file could not be opened: ${(error as Error).message}`);
    }
    try {
      if (context.signal.aborted) throw new OperationError('cancelled', 'The lock operation was cancelled.');
      let flock: FlockProcess;
      try {
        flock = deps.startFlock(flockArgs(checked.waitSeconds, FLOCK_FD), fd);
      } catch (error) {
        throw new OperationError('failed', `flock could not be started: ${(error as Error).message}`);
      }
      // A cancel while it waits: flock ends without the lock.
      const endFlock = () => flock.kill('SIGKILL');
      context.signal.addEventListener('abort', endFlock, { once: true });
      if (context.signal.aborted) endFlock();
      let outcome: { exitCode: number | null; error?: string; stderr?: string };
      try {
        outcome = await flock.exited;
      } finally {
        context.signal.removeEventListener('abort', endFlock);
      }
      if (context.signal.aborted) throw new OperationError('cancelled', 'The lock operation was cancelled.');
      if (outcome.error !== undefined) throw new OperationError('failed', `flock could not be started: ${outcome.error}`);
      if (outcome.exitCode === LOCK_BUSY_EXIT) {
        throw new OperationError(LOCK_BUSY_CODE, `The lock stayed held by another holder for ${checked.waitSeconds} s.`);
      }
      if (outcome.exitCode !== 0) {
        throw new OperationError('failed', `flock failed (${outcome.exitCode === null ? 'ended by a signal' : `exit code ${outcome.exitCode}`})${outcome.stderr ? `: ${outcome.stderr}` : ''}`);
      }
      context.progress(LOCK_HELD_STEP, checked.environmentId);
      await abortedOrAfter(context.signal, deps.holdLimitMs ?? LOCK_HOLD_LIMIT_MS);
      if (!context.signal.aborted) throw new OperationError('timeout', 'The lock was held for its longest time and was let go.');
      return {};
    } finally {
      // Lets go of the lock (the only other holder of the open file, flock, has ended).
      try {
        deps.closeFile(fd);
      } catch {
        // Closed already.
      }
    }
  };
}
