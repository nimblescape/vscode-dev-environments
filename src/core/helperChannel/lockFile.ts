// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The lock file of an environment on the Docker host and the `flock` on it (plan step 5, PR B; decision 2026-09-29,
// "Concurrency"), shared by the two bundles that take the lock: the worker (src/helperChannel/lock.ts, the operation
// `lock`) and, since plan step 8, PR B (user decision D2), the Session Monitor container before an automatic stop
// (src/remoteMonitor/stopLock.ts). Only Node.js built-ins and the pure protocol module. The lock lives with the open
// file of the process that opened it: `flock` takes the kernel lock on that open file (its file descriptor FLOCK_FD) and
// exits; closing the file, or the end of the process, frees it. The lock files are never deleted. Cleanup C5 (plan step
// 11J, B3): the one acquisition (acquireFlock: open, `flock`, its outcome) of every lock of this kind: the environment
// lock of the worker (takeEnvironmentLock), the stop lock of the monitor (stopLocker), and the locks of the shared VS
// Code store (storeLock, storeTryLock; also the lock of one extension file). Each caller maps the outcome to its own
// errors.
import { spawn } from 'child_process';
import * as fs from 'fs';
import { LOCK_BUSY_EXIT, flockArgs, flockNoWaitArgs, lockFilePath, lockFolder } from './protocol';
import { isStorageId } from '../storage/paths';

/** The file descriptor of the lock file in `flock`. */
export const FLOCK_FD = 3;

/** A started `flock`. */
export interface FlockProcess {
  /** Its exit code (null after a signal); `error` when it could not be started. */
  readonly exited: Promise<{ exitCode: number | null; error?: string; stderr?: string }>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

/**
 * Opens the lock file of an environment: the folder `locks` (0700, created when missing, never a symbolic link), then
 * the file with O_NOFOLLOW (0600; a symbolic link fails with ELOOP) and O_NONBLOCK (an open never waits; on Linux an
 * O_RDWR open of a FIFO does not wait anyway); anything but a plain file is refused (PR #74 review round 1, B-R1-6).
 * Node.js opens it with O_CLOEXEC, so the Docker calls of the process never inherit it (only `flock`, on purpose). Plan
 * step 8, PR B: the environment ID is checked here too (isStorageId: no separator, no dot), so no caller can name a
 * file outside the folder.
 */
export function openLockFile(stateDir: string, environmentId: string): number {
  if (!isStorageId(environmentId)) throw new Error('The environment ID of the lock is invalid.');
  const folder = lockFolder(stateDir);
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const folderStat = fs.lstatSync(folder);
  if (!folderStat.isDirectory()) throw new Error(`${folder} is not a folder.`);
  if ((folderStat.mode & 0o777) !== 0o700) fs.chmodSync(folder, 0o700);
  return openPlainLockFile(lockFilePath(environmentId, stateDir), `The lock file of ${environmentId}`);
}

/**
 * Opens (creates) the lock file `file` as openLockFile does it (O_NOFOLLOW, O_NONBLOCK, 0600, a plain file only; `what`
 * names it in the refusal). Plan step 11H1: also the lock file of the shared VS Code server store (vscodeServerStore.ts).
 */
export function openPlainLockFile(file: string, what: string): number {
  const { O_RDWR, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(file, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${what} is not a plain file.`);
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

/**
 * Cleanup C5 (plan step 11J, B3): what acquireFlock gave. `locked`: the lock is held until `release` closes the file
 * (once; a second call does nothing). Every other outcome has closed the file already: `openFailed` (the open threw
 * `error`), `cancelled` (`signal` aborted before `flock` started, or while it ran: flock is killed), `startThrew` (the
 * start of `flock` threw `error`), `startFailed` (`flock` could not be started: `detail`), `timeout` (it did not end
 * within `timeoutMs`; it is killed and its end awaited), `busy` (another holder kept the lock: LOCK_BUSY_EXIT), and
 * `failed` (another exit code, or `null` after a signal; its error output).
 */
export type FlockAttempt =
  | { kind: 'locked'; release(): void }
  | { kind: 'openFailed'; error: unknown }
  | { kind: 'cancelled' }
  | { kind: 'startThrew'; error: unknown }
  | { kind: 'startFailed'; detail: string }
  | { kind: 'timeout' }
  | { kind: 'busy' }
  | { kind: 'failed'; exitCode: number | null; stderr?: string };

/**
 * Cleanup C5 (plan step 11J, B3): opens the lock file (`open`; its descriptor becomes FLOCK_FD of `flock`) and takes the
 * lock with `flock`: with a wait of `waitSeconds` (flockArgs), or without a wait when it is undefined (flockNoWaitArgs).
 * `signal` ends the wait (flock is killed with SIGKILL); `timeoutMs` bounds a flock without a signal of its own (it is
 * killed with SIGKILL, and its end awaited). A cancellation counts before the outcome of flock, a time limit before the
 * rest. Rejects only when the end of flock rejects (never for startFlockProcess); the file is closed first.
 */
export async function acquireFlock(how: {
  open: () => number;
  close: (fd: number) => void;
  start: (args: readonly string[], fd: number) => FlockProcess;
  waitSeconds?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<FlockAttempt> {
  let fd: number;
  try {
    fd = how.open();
  } catch (error) {
    return { kind: 'openFailed', error };
  }
  const close = () => {
    try {
      how.close(fd);
    } catch {
      // Closed already.
    }
  };
  const { signal } = how;
  if (signal?.aborted) {
    close();
    return { kind: 'cancelled' };
  }
  let flock: FlockProcess;
  try {
    flock = how.start(how.waitSeconds === undefined ? flockNoWaitArgs(FLOCK_FD) : flockArgs(how.waitSeconds, FLOCK_FD), fd);
  } catch (error) {
    close();
    return { kind: 'startThrew', error };
  }
  // A cancel while it waits: flock ends without the lock.
  const end = () => flock.kill('SIGKILL');
  signal?.addEventListener('abort', end, { once: true });
  if (signal?.aborted) end();
  let timer: NodeJS.Timeout | undefined;
  let outcome: Awaited<FlockProcess['exited']> | 'timeout';
  try {
    const exited = flock.exited;
    outcome =
      how.timeoutMs === undefined
        ? await exited
        : await Promise.race([exited, new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), how.timeoutMs)))]);
    if (outcome === 'timeout') {
      flock.kill('SIGKILL');
      await exited;
    }
  } catch (error) {
    close();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', end);
  }
  if (signal?.aborted) {
    close();
    return { kind: 'cancelled' };
  }
  if (outcome !== 'timeout' && outcome.error === undefined && outcome.exitCode === 0) {
    let released = false;
    return {
      kind: 'locked',
      release: () => {
        if (released) return;
        released = true;
        close();
      },
    };
  }
  // Not held (a killed flock that took it lets it go with the close).
  close();
  if (outcome === 'timeout') return { kind: 'timeout' };
  if (outcome.error !== undefined) return { kind: 'startFailed', detail: outcome.error };
  if (outcome.exitCode === LOCK_BUSY_EXIT) return { kind: 'busy' };
  return { kind: 'failed', exitCode: outcome.exitCode, ...(outcome.stderr !== undefined ? { stderr: outcome.stderr } : {}) };
}

/** The text of a `failed` FlockAttempt: `flock failed (exit code N)` or `(ended by a signal)`, with its error output when asked. */
export function flockFailure(attempt: { exitCode: number | null; stderr?: string }, withStderr: boolean): string {
  return `flock failed (${attempt.exitCode === null ? 'ended by a signal' : `exit code ${attempt.exitCode}`})${withStderr && attempt.stderr ? `: ${attempt.stderr}` : ''}`;
}
