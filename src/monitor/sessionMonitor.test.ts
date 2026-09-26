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
let gated: string;
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
  // Starts main() of the bundle only when a "go" file exists, so that a test knows the process ID of the monitor before
  // the monitor starts, and can prepare files that name it.
  gated = path.join(outDir, 'gated.js');
  fs.writeFileSync(
    gated,
    `const fs = require('fs');
const [bundle, root, go] = process.argv.slice(2);
const wait = () => {
  if (!fs.existsSync(go)) return void setTimeout(wait, 10);
  require(bundle).main(['', '', root]).then((code) => process.exit(code), () => process.exit(1));
};
wait();
`,
  );
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

/** A monitor that starts when `go()` is called; its process ID is known before. */
function startGated(root: string): { child: ChildProcess; go: () => void } {
  const goFile = path.join(outDir, `go-${path.basename(root)}`);
  const child = spawn(process.execPath, [gated, bundle, root, goFile], {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return { child, go: () => fs.writeFileSync(goFile, '') };
}

/** The modification time of the lock, which the monitor refreshes in every tick (0 if it cannot be read). */
function lockTime(root: string): number {
  try {
    return fs.statSync(path.join(root, 'monitor.lock')).mtimeMs;
  } catch {
    return 0;
  }
}

/** Waits until the monitor has run a whole tick (checked monitor.exit, then refreshed its lock) after this call. */
async function waitForWholeTick(root: string): Promise<void> {
  const before = lockTime(root);
  // The first refresh after `before` may belong to a tick that read monitor.exit before this call; the second may not.
  await waitFor(() => lockTime(root) > before, 15_000);
  const first = lockTime(root);
  await waitFor(() => lockTime(root) > first, 15_000);
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
  // does not end it. Round-3 review of PR #26: the monitor ignores exactly the request present at its start (by content,
  // not by time), so a request written later is honoured also when the clock was set back.
  it.skipIf(process.platform === 'win32')(
    'removes a leftover exit request that names its process ID at its start, when no lock is held',
    async () => {
      const root = storageRoot();
      writeLiveWindow(root);
      const exitFile = path.join(root, 'monitor.exit');
      const { child, go } = startGated(root);
      const exit = exitOf(child);
      try {
        // A leftover request for an earlier monitor that had the same process ID. After the monitor takes the lock, a
        // request that names the live lock holder is kept, so only the removal before the lock removes this one.
        fs.writeFileSync(exitFile, JSON.stringify({ pid: child.pid, requestedAt: new Date(Date.now() - 60_000).toISOString() }));
        go();
        await waitFor(() => readLog(root).includes('Session Monitor started'));
        expect(fs.existsSync(exitFile)).toBe(false);
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill('SIGTERM');
      }
      expect(await exit).toBe(0);
      expect(readLog(root)).not.toContain('asked this Session Monitor to exit');
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'is not ended by the exit request present at its start, but by a later one, also with an earlier time',
    async () => {
      const root = storageRoot();
      writeLiveWindow(root);
      const exitFile = path.join(root, 'monitor.exit');
      const { child, go } = startGated(root);
      const exit = exitOf(child);
      // A leftover request with a time after the start of the monitor: the clock was set back since it was written.
      const leftover = JSON.stringify({ pid: child.pid, requestedAt: new Date(Date.now() + 60_000).toISOString() });
      try {
        fs.writeFileSync(exitFile, leftover);
        go();
        // Past its start-up handling, which removed the request.
        await waitFor(() => readLog(root).includes('Session Monitor started'));
        // The same request appears again (for example written late by an earlier window): it is still ignored.
        fs.writeFileSync(exitFile, leftover);
        await waitForWholeTick(root);
        expect(child.exitCode).toBeNull();
        expect(readLog(root)).not.toContain('asked this Session Monitor to exit');
        // A new request of a window ends it, although its time lies before the start of the monitor.
        fs.writeFileSync(exitFile, JSON.stringify({ pid: child.pid, requestedAt: new Date(Date.now() - 60_000).toISOString() }));
        expect(await exit).toBe(0);
        expect(readLog(root)).toContain('A window of a newer version asked this Session Monitor to exit.');
      } finally {
        child.kill('SIGTERM');
      }
    },
    45_000,
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
