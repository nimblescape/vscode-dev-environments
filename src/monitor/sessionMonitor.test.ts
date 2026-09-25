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
