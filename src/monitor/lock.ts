// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Single instance of the Session Monitor (concept 7.9): monitor.lock holds the process ID of the running monitor as
// decimal text. The running monitor refreshes the modification time of the file in every tick.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { writeJsonAtomicSync } from '../core/storage/atomicJson';
import { readJsonTolerantSync, retryTransientSync } from '../core/storage/paths';

/**
 * A lock file that was not refreshed for this time counts as stale, also when its process ID belongs to a live process.
 * This covers a process ID that another program reuses after the monitor ended (for example after a restart of the
 * computer). The running monitor calls `refreshMonitorLock` in every tick, so it stays far below this time.
 */
export const MONITOR_LOCK_STALE_MS = 120_000;

/**
 * Protocol version of the Session Monitor (review finding F2 of PR #26). A window that finds a live monitor of a known,
 * older version asks it to exit (monitor.exit) and starts the current one, which waits for it (`waitForRetiringMonitor`).
 * A monitor whose version is unknown (no version file, or the file cannot be read) is left alone. Bump the version
 * whenever a monitor of the previous version would decide wrongly with the files that a window of this version writes.
 *
 * - 1 (no version file): monitors before Keep Running When Closed; they would stop kept environments. The extension was
 *   not published with them, so no window asks them to exit: after an update from such a version, restart VS Code once.
 * - 2: knows `keepRunning` of the registry, writes monitor.version, and ends on a request in monitor.exit.
 */
export const MONITOR_PROTOCOL_VERSION = 2;

/** A lock file without a valid process ID that is younger than this may still be written by its creator. */
const INCOMPLETE_LOCK_MS = 5_000;
const MAX_PID = 0x7fffffff;

/**
 * The process exists: `process.kill(pid, 0)` does not throw `ESRCH` (implementation notes 12). `EPERM` (a process of
 * another user) counts as alive. Works on macOS, Linux, and Windows. Invalid IDs (0, negative, not an integer) give false,
 * because `kill` with 0 or a negative ID would address a process group.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The process ID in the lock file. `undefined` if the file is missing or does not contain a valid process ID. */
export function readMonitorLockPid(lockFile: string): number | undefined {
  try {
    return parsePid(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return undefined;
  }
}

export interface MonitorLockOptions {
  /** Default: MONITOR_LOCK_STALE_MS. */
  staleMs?: number;
}

/**
 * Takes the lock for `pid`. Creates the file exclusively (`fs.openSync(file, 'wx')`). If the file exists and holds
 * `pid` already → true. If its process is dead, its process ID is invalid, or it was not refreshed for `staleMs`, the
 * file is replaced once. Returns true if this process holds the lock now. Throws only for unexpected file system
 * errors (for example missing permissions).
 *
 * Two monitors that start at the same moment can, in rare cases, both get true. Therefore the monitor calls
 * `refreshMonitorLock` in every tick, and ends when it returns false.
 */
export function acquireMonitorLock(
  lockFile: string,
  pid: number = process.pid,
  isAlive: (pid: number) => boolean = isProcessAlive,
  options: MonitorLockOptions = {},
): boolean {
  const staleMs = options.staleMs ?? MONITOR_LOCK_STALE_MS;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createExclusive(lockFile, pid)) return true;
    const lock = inspect(lockFile);
    // The file disappeared between the two calls: try to create it again.
    if (!lock) continue;
    if (lock.pid === pid) {
      touch(lockFile);
      return true;
    }
    if (attempt > 0 || !isStale(lock, isAlive, staleMs)) return false;
    if (!removeStale(lockFile, lock.text)) return false;
  }
  return false;
}

/**
 * Call in every tick of the monitor. Updates the modification time of the lock file, so that no other process takes it
 * over as stale. Returns false if the file does not hold `pid` anymore: another monitor took over, and this one must end.
 */
export function refreshMonitorLock(lockFile: string, pid: number = process.pid): boolean {
  if (readMonitorLockPid(lockFile) !== pid) return false;
  touch(lockFile);
  return true;
}

/** Removes the lock file, but only if it holds `pid`. Never throws. */
export function releaseMonitorLock(lockFile: string, pid: number = process.pid): void {
  if (readMonitorLockPid(lockFile) !== pid) return;
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    // The next monitor replaces the file: its process ID is dead.
  }
}

/**
 * For windows (Session Coordinator): a monitor runs if the lock file holds the ID of a live process and was refreshed
 * within `staleMs`. Otherwise start a new monitor process; it takes the lock over.
 */
export function isMonitorRunning(
  lockFile: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
  options: MonitorLockOptions = {},
): boolean {
  const lock = inspect(lockFile);
  return lock !== undefined && !isStale(lock, isAlive, options.staleMs ?? MONITOR_LOCK_STALE_MS);
}

/** A live, fresh monitor (see `isMonitorRunning`): its process ID. */
export interface RunningMonitor {
  pid: number;
}

/** The monitor that holds a live and fresh lock, or `undefined` (see `isMonitorRunning`). */
export function runningMonitor(
  lockFile: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
  options: MonitorLockOptions = {},
): RunningMonitor | undefined {
  const lock = inspect(lockFile);
  if (!lock || lock.pid === undefined || isStale(lock, isAlive, options.staleMs ?? MONITOR_LOCK_STALE_MS)) return undefined;
  return { pid: lock.pid };
}

/**
 * Writes monitor.version for the monitor `pid` (a JSON object `{ pid, version }`), atomically, and retries transient
 * file errors (Windows). The file is separate from monitor.lock because monitors and windows of version 1 accept only a
 * bare process ID in the lock file. Throws for file system errors.
 */
export function writeMonitorVersion(versionFile: string, pid: number = process.pid, version = MONITOR_PROTOCOL_VERSION): void {
  retryTransientSync(() => writeJsonAtomicSync(versionFile, { pid, version }));
}

/**
 * The protocol version of the monitor `pid`, or `undefined` (unknown) when monitor.version is missing, cannot be read,
 * is not valid, or was written by another process. Unknown is never "older": a window leaves such a monitor alone.
 */
export function readMonitorVersion(versionFile: string, pid: number): number | undefined {
  const value = readJsonObject(versionFile);
  return value?.pid === pid && typeof value.version === 'number' && Number.isInteger(value.version) && value.version > 0
    ? value.version
    : undefined;
}

/**
 * Asks the monitor `pid` to exit: monitor.exit names it (a JSON object `{ pid, requestedAt }`). The monitor honours it
 * only when `requestedAt` is later than its own start (`isMonitorExitRequested`). Throws for file errors.
 */
export function requestMonitorExit(exitFile: string, pid: number, requestedAt: Date = new Date()): void {
  retryTransientSync(() => writeJsonAtomicSync(exitFile, { pid, requestedAt: requestedAt.toISOString() }));
}

/** A request in monitor.exit: the process ID it names, and the time of the request in milliseconds. */
export interface MonitorExitRequest {
  pid: number;
  requestedAt: number;
}

/** The request in monitor.exit, or `undefined` if the file is missing, cannot be read, or is not valid. */
export function readMonitorExitRequest(exitFile: string): MonitorExitRequest | undefined {
  const value = readJsonObject(exitFile);
  const pid = value?.pid;
  const requestedAt = typeof value?.requestedAt === 'string' ? Date.parse(value.requestedAt) : NaN;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID && Number.isFinite(requestedAt)
    ? { pid, requestedAt }
    : undefined;
}

/**
 * For the running monitor `pid` that started at `startedAt` (milliseconds): monitor.exit names it, and the request was
 * written after its start. A leftover request for an earlier process with the same ID does not end it (review finding
 * R2-2 of PR #26).
 */
export function isMonitorExitRequested(exitFile: string, pid: number, startedAt: number): boolean {
  const request = readMonitorExitRequest(exitFile);
  return request !== undefined && request.pid === pid && request.requestedAt > startedAt;
}

/**
 * For a monitor that starts: removes monitor.exit unless it names the live monitor that holds the lock and has a known,
 * older protocol version (a request that `waitForRetiringMonitor` waits for). Any other request is left over, for
 * example for a monitor that has ended, whose process ID a new monitor may get. Never throws.
 */
export function removeLeftoverExitRequest(
  lockFile: string,
  versionFile: string,
  exitFile: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): void {
  const request = readMonitorExitRequest(exitFile);
  if (request) {
    const monitor = runningMonitor(lockFile, isAlive);
    const version = monitor?.pid === request.pid ? readMonitorVersion(versionFile, request.pid) : undefined;
    if (version !== undefined && version < MONITOR_PROTOCOL_VERSION) return;
  }
  try {
    retryTransientSync(() => fs.rmSync(exitFile, { force: true }));
  } catch {
    // The request stays; a monitor honours it only when it was written after its start.
  }
}

/**
 * For a new monitor before it takes the lock: while the lock holds a live, fresh monitor that a window asked to exit
 * (monitor.exit names it), wait until it has ended or `timeoutMs` has passed. The older monitor finishes a
 * `docker stop` that it has started. Resolves with true if no retiring monitor holds the lock anymore.
 */
export async function waitForRetiringMonitor(
  lockFile: string,
  exitFile: string,
  options: { timeoutMs: number; pollMs?: number; isAlive?: (pid: number) => boolean; staleMs?: number },
): Promise<boolean> {
  const until = Date.now() + options.timeoutMs;
  for (;;) {
    const monitor = runningMonitor(lockFile, options.isAlive ?? isProcessAlive, { staleMs: options.staleMs });
    if (!monitor || readMonitorExitRequest(exitFile)?.pid !== monitor.pid) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
  }
}

interface LockInfo {
  text: string;
  pid: number | undefined;
  mtimeMs: number;
}

function parsePid(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[1-9]\d{0,9}$/.test(trimmed)) return undefined;
  const pid = Number(trimmed);
  return pid <= MAX_PID ? pid : undefined;
}

function inspect(lockFile: string): LockInfo | undefined {
  try {
    const text = fs.readFileSync(lockFile, 'utf8');
    const { mtimeMs } = fs.statSync(lockFile);
    return { text, pid: parsePid(text), mtimeMs };
  } catch {
    return undefined;
  }
}

function isStale(lock: LockInfo, isAlive: (pid: number) => boolean, staleMs: number): boolean {
  // Absolute value: a modification time in the future (the clock was set back) must not keep a lock forever.
  const age = Math.abs(Date.now() - lock.mtimeMs);
  // Without a valid process ID, the creator may be between its create and its write.
  if (lock.pid === undefined) return age > INCOMPLETE_LOCK_MS;
  if (!isAlive(lock.pid)) return true;
  return age > staleMs;
}

function createExclusive(lockFile: string, pid: number): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockFile, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // Windows refuses to create a file whose deletion is still pending.
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY')) return false;
    throw error;
  }
  try {
    fs.writeSync(fd, `${pid}\n`);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(lockFile, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  return true;
}

/**
 * Removes a stale lock file. The file is first renamed to a unique name, so that only one process removes it. If the
 * renamed file is not the stale file that was checked (another process replaced it in between), it is put back.
 * Returns true if the stale file is gone.
 */
function removeStale(lockFile: string, staleText: string): boolean {
  const aside = `${lockFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(lockFile, aside);
  } catch (error) {
    // Another process removed it already.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  let text: string | undefined;
  try {
    text = fs.readFileSync(aside, 'utf8');
  } catch {
    text = undefined;
  }
  if (text !== staleText) {
    try {
      // Exclusive: fails if a third process created a new lock in the meantime.
      fs.linkSync(aside, lockFile);
    } catch {
      // The new lock of the third process stays.
    }
  }
  try {
    fs.rmSync(aside, { force: true });
  } catch {
    // A leftover *.stale file does no harm.
  }
  return text === staleText;
}

function touch(lockFile: string): void {
  const now = new Date();
  try {
    fs.utimesSync(lockFile, now, now);
  } catch {
    // The lock stays valid until MONITOR_LOCK_STALE_MS; the next tick tries again.
  }
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  // Retries transient errors (Windows); a file that cannot be read gives undefined.
  const value = readJsonTolerantSync(file);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
