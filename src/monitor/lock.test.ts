// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireMonitorLock,
  isMonitorExitRequested,
  isMonitorRunning,
  isProcessAlive,
  MONITOR_LOCK_STALE_MS,
  MONITOR_PROTOCOL_VERSION,
  readMonitorExitRequest,
  readMonitorLockPid,
  readMonitorVersion,
  refreshMonitorLock,
  releaseMonitorLock,
  removeLeftoverExitRequest,
  requestMonitorExit,
  runningMonitor,
  waitForRetiringMonitor,
  writeMonitorVersion,
} from './lock';

const alive = () => true;
const dead = () => false;

// Transient file errors of Windows (round-2 review finding 3 of PR #26): a test sets a hook that may throw before the
// real call. The namespace of 'fs' cannot be spied on in ESM, so the module is mocked with pass-through functions.
const fsHooks: { readFileSync?: (file: unknown) => void; renameSync?: (from: unknown) => void } = {};
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    fsHooks.readFileSync?.(args[0]);
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  const renameSync = (...args: Parameters<typeof actual.renameSync>): void => {
    fsHooks.renameSync?.(args[0]);
    actual.renameSync(...args);
  };
  const mocked = { ...actual, readFileSync, renameSync };
  return { ...mocked, default: mocked };
});

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function setAge(file: string, ageMs: number): void {
  const time = new Date(Date.now() - ageMs);
  fs.utimesSync(file, time, time);
}

describe('isProcessAlive', () => {
  it('is true for this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('is false for invalid process IDs (0 and negative IDs address process groups)', () => {
    for (const pid of [0, -1, -process.pid, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(isProcessAlive(pid)).toBe(false);
    }
  });

  it('is false for a process that has ended', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeDefined();
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    // Give the operating system a moment to reap the process.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isProcessAlive(pid!)).toBe(false);
  });
});

describe('monitor lock', () => {
  let dir: string;
  let lockFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
    lockFile = path.join(dir, 'storage', 'monitor.lock');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the lock file with the process ID, also when the folder is missing', () => {
    expect(acquireMonitorLock(lockFile, 4242, alive)).toBe(true);
    expect(fs.readFileSync(lockFile, 'utf8')).toBe('4242\n');
    expect(readMonitorLockPid(lockFile)).toBe(4242);
  });

  it('uses the ID of this process by default', () => {
    expect(acquireMonitorLock(lockFile)).toBe(true);
    expect(readMonitorLockPid(lockFile)).toBe(process.pid);
    releaseMonitorLock(lockFile);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('refuses the lock while another live process holds it', () => {
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    expect(acquireMonitorLock(lockFile, 2222, alive)).toBe(false);
    expect(readMonitorLockPid(lockFile)).toBe(1111);
  });

  it('returns true when the file holds the own process ID already', () => {
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    setAge(lockFile, 60_000);
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    // The modification time was refreshed.
    expect(Date.now() - fs.statSync(lockFile).mtimeMs).toBeLessThan(10_000);
  });

  it('replaces a lock whose process has ended', () => {
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    const checked: number[] = [];
    const isAlive = (pid: number) => {
      checked.push(pid);
      return false;
    };
    expect(acquireMonitorLock(lockFile, 2222, isAlive)).toBe(true);
    expect(checked).toEqual([1111]);
    expect(readMonitorLockPid(lockFile)).toBe(2222);
    // No leftover files of the replacement.
    expect(fs.readdirSync(path.dirname(lockFile))).toEqual(['monitor.lock']);
  });

  it('replaces a lock that was not refreshed for the stale time, also with a live process ID (reused ID)', () => {
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    setAge(lockFile, MONITOR_LOCK_STALE_MS - 10_000);
    expect(acquireMonitorLock(lockFile, 2222, alive)).toBe(false);
    setAge(lockFile, MONITOR_LOCK_STALE_MS + 10_000);
    expect(acquireMonitorLock(lockFile, 2222, alive)).toBe(true);
    expect(readMonitorLockPid(lockFile)).toBe(2222);
  });

  it('accepts a custom stale time', () => {
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    setAge(lockFile, 20_000);
    expect(acquireMonitorLock(lockFile, 2222, alive, { staleMs: 10_000 })).toBe(true);
  });

  it('does not keep a lock forever whose time lies far in the future', () => {
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    setAge(lockFile, -(MONITOR_LOCK_STALE_MS + 60_000));
    expect(acquireMonitorLock(lockFile, 2222, alive)).toBe(true);
  });

  it('replaces an old file without a valid process ID, but not a new one (its creator may still write it)', () => {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    for (const content of ['', 'garbage', '0', '-5', '12abc', '99999999999']) {
      fs.writeFileSync(lockFile, content);
      expect(readMonitorLockPid(lockFile)).toBeUndefined();
      expect(acquireMonitorLock(lockFile, 2222, alive)).toBe(false);
      setAge(lockFile, 60_000);
      expect(acquireMonitorLock(lockFile, 2222, alive)).toBe(true);
      expect(readMonitorLockPid(lockFile)).toBe(2222);
      fs.rmSync(lockFile);
    }
  });

  it('reads a process ID with surrounding white space', () => {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, '  1234\r\n');
    expect(readMonitorLockPid(lockFile)).toBe(1234);
  });

  it('reads undefined for a missing file', () => {
    expect(readMonitorLockPid(lockFile)).toBeUndefined();
  });

  it('refreshes only its own lock, and reports when another monitor took over', () => {
    expect(refreshMonitorLock(lockFile, 1111)).toBe(false);
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    setAge(lockFile, 60_000);
    expect(refreshMonitorLock(lockFile, 1111)).toBe(true);
    expect(Date.now() - fs.statSync(lockFile).mtimeMs).toBeLessThan(10_000);
    expect(refreshMonitorLock(lockFile, 2222)).toBe(false);
    // Another monitor replaced the lock (for example after sleep): the first one must end.
    setAge(lockFile, MONITOR_LOCK_STALE_MS + 10_000);
    expect(acquireMonitorLock(lockFile, 2222, alive)).toBe(true);
    expect(refreshMonitorLock(lockFile, 1111)).toBe(false);
  });

  it('releases only its own lock', () => {
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    releaseMonitorLock(lockFile, 2222);
    expect(readMonitorLockPid(lockFile)).toBe(1111);
    releaseMonitorLock(lockFile, 1111);
    expect(fs.existsSync(lockFile)).toBe(false);
    // A missing file is no error.
    expect(() => releaseMonitorLock(lockFile, 1111)).not.toThrow();
    expect(acquireMonitorLock(lockFile, 2222, dead)).toBe(true);
  });

  it('gives a stale lock to the first candidate only; later candidates see the new live holder', () => {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, '1111\n');
    // Process 1111 is dead; the candidates are alive.
    const isAlive = (pid: number) => pid !== 1111;
    const results = [2001, 2002, 2003, 2004].map((pid) => acquireMonitorLock(lockFile, pid, isAlive));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(readMonitorLockPid(lockFile)).toBe(2001);
  });

  it('tells windows whether a monitor runs', () => {
    expect(isMonitorRunning(lockFile, alive)).toBe(false);
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    expect(isMonitorRunning(lockFile, alive)).toBe(true);
    expect(isMonitorRunning(lockFile, dead)).toBe(false);
    setAge(lockFile, MONITOR_LOCK_STALE_MS + 10_000);
    expect(isMonitorRunning(lockFile, alive)).toBe(false);
    expect(isMonitorRunning(lockFile, alive, { staleMs: MONITOR_LOCK_STALE_MS * 2 })).toBe(true);
  });
});

// Review finding F2 of PR #26: a monitor of an older version is asked to exit, and the current one takes over.
describe('monitor protocol version and exit request', () => {
  let dir: string;
  let lockFile: string;
  let versionFile: string;
  let exitFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
    lockFile = path.join(dir, 'monitor.lock');
    versionFile = path.join(dir, 'monitor.version');
    exitFile = path.join(dir, 'monitor.exit');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is version 2 since Keep Running When Closed (version 1 wrote no version file)', () => {
    expect(MONITOR_PROTOCOL_VERSION).toBe(2);
  });

  it('writes and reads the version of a process ID, atomically and next to the lock', () => {
    writeMonitorVersion(versionFile, 1111);
    expect(JSON.parse(fs.readFileSync(versionFile, 'utf8'))).toEqual({ pid: 1111, version: MONITOR_PROTOCOL_VERSION });
    expect(readMonitorVersion(versionFile, 1111)).toBe(MONITOR_PROTOCOL_VERSION);
    // The version of another process (an earlier monitor) is not the version of this one.
    expect(readMonitorVersion(versionFile, 2222)).toBeUndefined();
    writeMonitorVersion(versionFile, 2222, 7);
    expect(readMonitorVersion(versionFile, 2222)).toBe(7);
    expect(fs.readdirSync(dir)).toEqual(['monitor.version']);
  });

  it('reads no version for a missing or invalid file', () => {
    expect(readMonitorVersion(versionFile, 1111)).toBeUndefined();
    for (const text of ['', '2', 'null', '[]', '{"pid":1111}', '{"pid":1111,"version":"2"}', '{"pid":1111,"version":0}']) {
      fs.writeFileSync(versionFile, text);
      expect(readMonitorVersion(versionFile, 1111)).toBeUndefined();
    }
  });

  it('writes and reads an exit request with its time', () => {
    expect(readMonitorExitRequest(exitFile)).toBeUndefined();
    requestMonitorExit(exitFile, 1111, new Date('2026-09-26T10:00:00.000Z'));
    expect(JSON.parse(fs.readFileSync(exitFile, 'utf8'))).toEqual({ pid: 1111, requestedAt: '2026-09-26T10:00:00.000Z' });
    expect(readMonitorExitRequest(exitFile)).toEqual({ pid: 1111, requestedAt: Date.parse('2026-09-26T10:00:00.000Z') });
    expect(fs.readdirSync(dir)).toEqual(['monitor.exit']);
    for (const text of ['{"pid":-1,"requestedAt":"2026-09-26T10:00:00.000Z"}', '{"pid":1111}', '{"pid":1111,"requestedAt":"soon"}', '[]']) {
      fs.writeFileSync(exitFile, text);
      expect(readMonitorExitRequest(exitFile)).toBeUndefined();
    }
  });

  // Round-2 review finding 2 of PR #26: a leftover request must not end a new monitor that got the same process ID.
  it('honours a request only when it names the monitor and was written after its start', () => {
    const startedAt = Date.parse('2026-09-26T10:00:00.000Z');
    expect(isMonitorExitRequested(exitFile, 1111, startedAt)).toBe(false);
    requestMonitorExit(exitFile, 1111, new Date(startedAt - 60_000));
    expect(isMonitorExitRequested(exitFile, 1111, startedAt)).toBe(false);
    requestMonitorExit(exitFile, 1111, new Date(startedAt));
    expect(isMonitorExitRequested(exitFile, 1111, startedAt)).toBe(false);
    requestMonitorExit(exitFile, 2222, new Date(startedAt + 1_000));
    expect(isMonitorExitRequested(exitFile, 1111, startedAt)).toBe(false);
    requestMonitorExit(exitFile, 1111, new Date(startedAt + 1_000));
    expect(isMonitorExitRequested(exitFile, 1111, startedAt)).toBe(true);
  });

  it('removes a leftover exit request at the start of a monitor, but keeps one for a live monitor of an older version', () => {
    const request = (): void => requestMonitorExit(exitFile, 1111);
    // No lock: the monitor that the request names has ended.
    request();
    removeLeftoverExitRequest(lockFile, versionFile, exitFile, alive);
    expect(fs.existsSync(exitFile)).toBe(false);
    // The lock holds a dead process.
    fs.writeFileSync(lockFile, '1111\n');
    writeMonitorVersion(versionFile, 1111, MONITOR_PROTOCOL_VERSION - 1);
    request();
    removeLeftoverExitRequest(lockFile, versionFile, exitFile, dead);
    expect(fs.existsSync(exitFile)).toBe(false);
    // Another process holds the lock.
    fs.writeFileSync(lockFile, '2222\n');
    request();
    removeLeftoverExitRequest(lockFile, versionFile, exitFile, alive);
    expect(fs.existsSync(exitFile)).toBe(false);
    // The live lock holder has the current version, or an unknown one.
    fs.writeFileSync(lockFile, '1111\n');
    writeMonitorVersion(versionFile, 1111, MONITOR_PROTOCOL_VERSION);
    request();
    removeLeftoverExitRequest(lockFile, versionFile, exitFile, alive);
    expect(fs.existsSync(exitFile)).toBe(false);
    fs.rmSync(versionFile);
    request();
    removeLeftoverExitRequest(lockFile, versionFile, exitFile, alive);
    expect(fs.existsSync(exitFile)).toBe(false);
    // An invalid request.
    fs.writeFileSync(exitFile, 'x');
    removeLeftoverExitRequest(lockFile, versionFile, exitFile, alive);
    expect(fs.existsSync(exitFile)).toBe(false);
    // The live lock holder has an older version: the new monitor waits for it.
    writeMonitorVersion(versionFile, 1111, MONITOR_PROTOCOL_VERSION - 1);
    request();
    removeLeftoverExitRequest(lockFile, versionFile, exitFile, alive);
    expect(readMonitorExitRequest(exitFile)?.pid).toBe(1111);
  });

  // Round-2 review finding 3 of PR #26: transient file errors of Windows (a virus scanner holds the file).
  it('retries transient errors when it reads the version, and an unreadable version is unknown, never older', () => {
    writeMonitorVersion(versionFile, 1111, MONITOR_PROTOCOL_VERSION - 1);
    let failures = 0;
    fsHooks.readFileSync = (file) => {
      if (file === versionFile && failures < 2) {
        failures++;
        throw fsError('EBUSY');
      }
    };
    try {
      expect(readMonitorVersion(versionFile, 1111)).toBe(MONITOR_PROTOCOL_VERSION - 1);
      expect(failures).toBe(2);
      fsHooks.readFileSync = (file) => {
        if (file === versionFile) throw fsError('EBUSY');
      };
      expect(readMonitorVersion(versionFile, 1111)).toBeUndefined();
    } finally {
      delete fsHooks.readFileSync;
    }
    // A file that cannot be read at all (here a folder) is unknown as well.
    fs.rmSync(versionFile);
    fs.mkdirSync(versionFile);
    expect(readMonitorVersion(versionFile, 1111)).toBeUndefined();
  });

  it('retries transient errors when it writes the version or an exit request', () => {
    let failures = 0;
    fsHooks.renameSync = () => {
      if (failures < 2) {
        failures++;
        throw fsError('EPERM');
      }
    };
    try {
      writeMonitorVersion(versionFile, 1111);
      expect(readMonitorVersion(versionFile, 1111)).toBe(MONITOR_PROTOCOL_VERSION);
      expect(failures).toBe(2);
      failures = 0;
      requestMonitorExit(exitFile, 1111);
      expect(readMonitorExitRequest(exitFile)?.pid).toBe(1111);
      expect(failures).toBe(2);
    } finally {
      delete fsHooks.renameSync;
    }
    expect(fs.readdirSync(dir).sort()).toEqual(['monitor.exit', 'monitor.version']);
  });

  it('gives the running monitor with its process ID', () => {
    expect(runningMonitor(lockFile, alive)).toBeUndefined();
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    setAge(lockFile, 3_000);
    expect(runningMonitor(lockFile, alive)).toEqual({ pid: 1111 });
    setAge(lockFile, MONITOR_LOCK_STALE_MS + 1_000);
    expect(runningMonitor(lockFile, alive)).toBeUndefined();
    setAge(lockFile, 3_000);
    expect(runningMonitor(lockFile, dead)).toBeUndefined();
    // A lock without a valid process ID yet is not a running monitor with a process ID.
    fs.writeFileSync(lockFile, '');
    expect(runningMonitor(lockFile, alive)).toBeUndefined();
  });

  it('waits for a monitor that was asked to exit, until it has released the lock', async () => {
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    requestMonitorExit(exitFile, 1111);
    const waiting = waitForRetiringMonitor(lockFile, exitFile, { timeoutMs: 5_000, pollMs: 10, isAlive: alive });
    let done = false;
    void waiting.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(done).toBe(false);
    releaseMonitorLock(lockFile, 1111);
    expect(await waiting).toBe(true);
  });

  it('does not wait for a monitor that nobody asked to exit, and gives up after the timeout', async () => {
    expect(acquireMonitorLock(lockFile, 1111, alive)).toBe(true);
    expect(await waitForRetiringMonitor(lockFile, exitFile, { timeoutMs: 5_000, pollMs: 10, isAlive: alive })).toBe(true);
    requestMonitorExit(exitFile, 2222);
    expect(await waitForRetiringMonitor(lockFile, exitFile, { timeoutMs: 5_000, pollMs: 10, isAlive: alive })).toBe(true);
    requestMonitorExit(exitFile, 1111);
    expect(await waitForRetiringMonitor(lockFile, exitFile, { timeoutMs: 50, pollMs: 10, isAlive: alive })).toBe(false);
  });
});
