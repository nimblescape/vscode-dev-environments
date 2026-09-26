// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Runs the real bundle (as dist/sessionMonitor.js is built) in a child process. No Docker is needed: without
// environments in the registry the monitor never calls Docker.
import { spawn, type ChildProcess } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let outDir: string;
let bundle: string;
const roots: string[] = [];

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  bundle = path.join(outDir, 'sessionMonitor.js');
  // Same options as esbuild.mjs.
  buildSync({
    entryPoints: [path.join(__dirname, 'sessionMonitor.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: bundle,
    logLevel: 'silent',
  });
});

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function storageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  roots.push(root);
  return root;
}

function start(args: string[]): ChildProcess {
  return spawn(process.execPath, [bundle, ...args], {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error('Timeout while waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readLog(root: string): string {
  try {
    return fs.readFileSync(path.join(root, 'monitor.log'), 'utf8');
  } catch {
    return '';
  }
}

/** A status file of a live window (this test process), so that the monitor does not end for lack of work. */
function writeLiveWindow(root: string): void {
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  const status = { windowId: 'w1', pid: process.pid, environmentId: null, state: 'active', updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, 'sessions', 'w1.json'), JSON.stringify(status));
}

describe('sessionMonitor bundle', () => {
  it('runs main() as the entry module, ends without work, and releases its lock', async () => {
    const root = storageRoot();
    expect(await exitOf(start([root]))).toBe(0);
    const log = readLog(root);
    expect(log).toContain('Session Monitor started');
    expect(log).toContain('Session Monitor ends (idle).');
    expect(fs.existsSync(path.join(root, 'monitor.lock'))).toBe(false);
  }, 20_000);

  it('ends at once when another live monitor holds the lock', async () => {
    const root = storageRoot();
    const lock = path.join(root, 'monitor.lock');
    fs.writeFileSync(lock, `${process.pid}\n`);
    expect(await exitOf(start([root]))).toBe(0);
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`);
    expect(readLog(root)).not.toContain('Session Monitor started');
  }, 20_000);

  // Review finding F2 of PR #26: monitor protocol version, and the hand-over from an older monitor.
  it.skipIf(process.platform === 'win32')(
    'writes its protocol version next to the lock, and ends after its step when a window asks it to exit',
    async () => {
      const root = storageRoot();
      writeLiveWindow(root);
      const child = start([root]);
      const exit = exitOf(child);
      await waitFor(() => readLog(root).includes('Session Monitor started'));
      expect(JSON.parse(fs.readFileSync(path.join(root, 'monitor.version'), 'utf8'))).toEqual({ pid: child.pid, version: 2 });
      fs.writeFileSync(path.join(root, 'monitor.exit'), JSON.stringify({ pid: child.pid, requestedAt: new Date().toISOString() }));
      expect(await exit).toBe(0);
      expect(readLog(root)).toContain('A window of a newer version asked this Session Monitor to exit.');
      expect(readLog(root)).toContain('Session Monitor ends (stopRequested).');
      expect(fs.existsSync(path.join(root, 'monitor.lock'))).toBe(false);
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'waits for an older monitor that was asked to exit, then takes the lock and removes the request',
    async () => {
      const root = storageRoot();
      writeLiveWindow(root);
      // The older monitor: a live process that holds the lock and was asked to exit.
      const older = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      const olderExit = exitOf(older);
      const lock = path.join(root, 'monitor.lock');
      fs.writeFileSync(lock, `${older.pid}\n`);
      // Of a known, older version: a request for a monitor without a version is left over (round-2 review of PR #26).
      fs.writeFileSync(path.join(root, 'monitor.version'), JSON.stringify({ pid: older.pid, version: 1 }));
      fs.writeFileSync(path.join(root, 'monitor.exit'), JSON.stringify({ pid: older.pid, requestedAt: new Date().toISOString() }));
      const child = start([root]);
      const exit = exitOf(child);
      try {
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(child.exitCode).toBeNull();
        expect(readLog(root)).not.toContain('Session Monitor started');
        expect(fs.readFileSync(lock, 'utf8')).toBe(`${older.pid}\n`);
        // The older monitor finishes its step, releases the lock, and ends.
        fs.rmSync(lock);
        older.kill('SIGKILL');
        await olderExit;
        await waitFor(() => readLog(root).includes('Session Monitor started'));
        expect(fs.readFileSync(lock, 'utf8').trim()).toBe(String(child.pid));
        expect(fs.existsSync(path.join(root, 'monitor.exit'))).toBe(false);
      } finally {
        older.kill('SIGKILL');
        child.kill('SIGTERM');
      }
      expect(await exit).toBe(0);
    },
    20_000,
  );

  // Round-2 review finding 2 of PR #26: a leftover exit request that names the process ID of a new, current monitor
  // does not end it; only a request written after its start does.
  it.skipIf(process.platform === 'win32')(
    'is not ended by a leftover exit request that names its process ID',
    async () => {
      const root = storageRoot();
      writeLiveWindow(root);
      const exitFile = path.join(root, 'monitor.exit');
      const child = start([root]);
      const exit = exitOf(child);
      const leftover = JSON.stringify({ pid: child.pid, requestedAt: new Date(Date.now() - 60_000).toISOString() });
      try {
        // Written as early as possible: the monitor removes it at its start, or it is older than the start.
        fs.writeFileSync(exitFile, leftover);
        await waitFor(() => readLog(root).includes('Session Monitor started'));
        // Also a leftover written after the start (older than the start) does not end it in the next ticks.
        fs.writeFileSync(exitFile, leftover);
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        expect(child.exitCode).toBeNull();
        expect(readLog(root)).not.toContain('asked this Session Monitor to exit');
        // A request of a window after the start ends it.
        fs.writeFileSync(exitFile, JSON.stringify({ pid: child.pid, requestedAt: new Date().toISOString() }));
        expect(await exit).toBe(0);
        expect(readLog(root)).toContain('A window of a newer version asked this Session Monitor to exit.');
      } finally {
        child.kill('SIGTERM');
      }
    },
    25_000,
  );

  // Round-2 review finding 3 of PR #26: a failed write of the version file does not end the new monitor.
  it.skipIf(process.platform === 'win32')(
    'keeps running when its version file cannot be written',
    async () => {
      const root = storageRoot();
      writeLiveWindow(root);
      // A folder in place of the file: the rename of the atomic write fails.
      fs.mkdirSync(path.join(root, 'monitor.version'));
      const child = start([root]);
      const exit = exitOf(child);
      try {
        await waitFor(() => readLog(root).includes('Session Monitor started'));
        expect(readLog(root)).toContain('The version file of the Session Monitor could not be written. It keeps running.');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(child.exitCode).toBeNull();
        expect(fs.readFileSync(path.join(root, 'monitor.lock'), 'utf8').trim()).toBe(String(child.pid));
      } finally {
        child.kill('SIGTERM');
      }
      expect(await exit).toBe(0);
    },
    20_000,
  );

  it('exits with code 2 without a storage folder argument, and does not create a missing folder', async () => {
    expect(await exitOf(start([]))).toBe(2);
    const missing = path.join(storageRoot(), 'missing');
    expect(await exitOf(start([missing]))).toBe(0);
    expect(fs.existsSync(missing)).toBe(false);
  }, 20_000);

  it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT'] as const)(
    'keeps running while a window is alive, and ends cleanly on %s',
    async (signal) => {
      const root = storageRoot();
      fs.mkdirSync(path.join(root, 'sessions'));
      const status = {
        windowId: 'w1',
        pid: process.pid,
        environmentId: null,
        state: 'active',
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(root, 'sessions', 'w1.json'), JSON.stringify(status));
      const child = start([root]);
      const exit = exitOf(child);
      await waitFor(() => readLog(root).includes('Session Monitor started'));
      // A few ticks: it must not end on its own while the window is alive.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(child.exitCode).toBeNull();
      expect(fs.readFileSync(path.join(root, 'monitor.lock'), 'utf8').trim()).toBe(String(child.pid));
      child.kill(signal);
      expect(await exit).toBe(0);
      expect(readLog(root)).toContain(`Received ${signal}.`);
      expect(readLog(root)).toContain('Session Monitor ends (stopRequested).');
      expect(fs.existsSync(path.join(root, 'monitor.lock'))).toBe(false);
    },
    20_000,
  );
});
