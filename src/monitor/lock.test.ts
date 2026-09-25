// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireMonitorLock,
  isMonitorRunning,
  isProcessAlive,
  MONITOR_LOCK_STALE_MS,
  readMonitorLockPid,
  refreshMonitorLock,
  releaseMonitorLock,
} from './lock';

const alive = () => true;
const dead = () => false;

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
