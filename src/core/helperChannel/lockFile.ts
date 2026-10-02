// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The lock file of an environment on the Docker host and the `flock` on it (plan step 5, PR B; decision 2026-09-29,
// "Concurrency"), shared by the two bundles that take the lock: the worker (src/helperChannel/lock.ts, the operation
// `lock`) and, since plan step 8, PR B (user decision D2), the Session Monitor container before an automatic stop
// (src/remoteMonitor/stopLock.ts). Only Node.js built-ins and the pure protocol module. The lock lives with the open
// file of the process that opened it: `flock` takes the kernel lock on that open file (its file descriptor FLOCK_FD) and
// exits; closing the file, or the end of the process, frees it. The lock files are never deleted.
import { spawn } from 'child_process';
import * as fs from 'fs';
import { lockFilePath, lockFolder } from './protocol';
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
