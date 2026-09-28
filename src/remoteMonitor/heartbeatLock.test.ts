// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #58: the heartbeats of the remote Session Monitor run under the kernel lock `flock` of
// heartbeatCommand. These tests run that command line with real processes: `flock` and `timeout` as in the helper image,
// and the monitor script built with esbuild (its state folder passed by a small entry instead of /state).
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HEARTBEAT_LOCK_PATH,
  REMOTE_MONITOR_SCRIPT_PATH,
  heartbeatCommand,
  heartbeatFileName,
  type HeartbeatInput,
} from '../core/remoteMonitor/protocol';

const A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';

let buildDir: string;
let script: string;
let stateDir: string;
const started: ChildProcess[] = [];

beforeAll(async () => {
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-heartbeat-lock-build-'));
  script = path.join(buildDir, 'monitor.js');
  await esbuild.build({
    stdin: {
      contents: `import { main } from './main'; main(process.argv.slice(3), { stateDir: process.argv[2] }).then((code) => process.exit(code));`,
      resolveDir: __dirname,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: script,
    // Not the entry module of main.ts: its own start (argv without the state folder) stays out.
    define: { 'require.main': 'undefined' },
    logLevel: 'silent',
  });
});

afterAll(() => {
  fs.rmSync(buildDir, { recursive: true, force: true });
});

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-heartbeat-lock-'));
});

afterEach(() => {
  for (const child of started) if (child.exitCode === null && child.signalCode === null) killGroup(child);
  started.length = 0;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** heartbeatCommand with the lock in the test folder and the test build of the script with its state folder. */
function command(input: HeartbeatInput): string[] {
  return heartbeatCommand(input).flatMap((part) => {
    if (part === HEARTBEAT_LOCK_PATH) return [lockPath()];
    if (part === REMOTE_MONITOR_SCRIPT_PATH) return [script, stateDir];
    return [part];
  });
}

function lockPath(): string {
  return path.join(stateDir, path.basename(HEARTBEAT_LOCK_PATH));
}

/** Starts a process in its own process group, so that the group can be killed as `docker exec` leaves it. */
function start(argv: string[]): ChildProcess {
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  started.push(child);
  return child;
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

function killGroup(child: ChildProcess): void {
  try {
    process.kill(-(child.pid as number), 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Holds the lock with `flock` until the process group is killed; resolves once the lock is held. */
async function holdLock(): Promise<ChildProcess> {
  const marker = path.join(stateDir, 'held');
  const holder = start(['flock', lockPath(), 'sh', '-c', `touch '${marker}'; exec sleep 60`]);
  while (!fs.existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 10));
  return holder;
}

function heartbeat(seq: number, keepRunning: boolean): HeartbeatInput {
  return { source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning, seq }] };
}

function readRecord(): unknown {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'heartbeats', heartbeatFileName(SOURCE, A)), 'utf8'));
}

describe('the lock of the heartbeat records', () => {
  // Moved here from main.test.ts ("two heartbeats at the same time"): now with processes, as `docker exec` runs them.
  it('two heartbeats at the same time: the higher seq stays, whatever the order of the writes', { timeout: 20_000 }, async () => {
    const children = [2, 1, 2, 1, 2, 1].map((seq) => start(command(heartbeat(seq, seq === 2))));
    expect(await Promise.all(children.map(exited))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(readRecord()).toMatchObject({ keepRunning: true, seq: 2 });
  });

  it('a heartbeat waits while another holds the lock, and writes after it', { timeout: 20_000 }, async () => {
    const holder = await holdLock();
    const child = start(command(heartbeat(1, true)));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(child.exitCode).toBeNull();
    expect(fs.existsSync(path.join(stateDir, 'heartbeats', heartbeatFileName(SOURCE, A)))).toBe(false);
    killGroup(holder);
    expect(await exited(child)).toBe(0);
    expect(readRecord()).toMatchObject({ keepRunning: true, seq: 1 });
  });

  // Moved here from main.test.ts ("a left-over lock of a killed heartbeat"): the kernel releases the lock of a killed
  // holder at once, so nothing is left over and nothing is taken over.
  it('a killed holder leaves no lock behind', { timeout: 20_000 }, async () => {
    const holder = await holdLock();
    killGroup(holder);
    await exited(holder);
    const startedAt = Date.now();
    expect(await exited(start(command(heartbeat(1, false))))).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(readRecord()).toMatchObject({ keepRunning: false, seq: 1 });
  });

  it('gives up after 5 seconds while the lock stays held, and writes nothing', { timeout: 20_000 }, async () => {
    await holdLock();
    const startedAt = Date.now();
    expect(await exited(start(command(heartbeat(1, true))))).toBe(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_500);
    expect(fs.existsSync(path.join(stateDir, 'heartbeats', heartbeatFileName(SOURCE, A)))).toBe(false);
  });

  it('kills a heartbeat that holds the lock longer than 10 seconds, which frees the lock', { timeout: 30_000 }, async () => {
    // The command of a heartbeat with a script that never ends in place of the monitor.
    const hanging = heartbeatCommand(heartbeat(1, true));
    const nodeAt = hanging.indexOf('node');
    const child = start([...hanging.slice(0, nodeAt).map((part) => (part === HEARTBEAT_LOCK_PATH ? lockPath() : part)), 'sleep', '60']);
    const startedAt = Date.now();
    await exited(child);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_500);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(await exited(start(command(heartbeat(1, true))))).toBe(0);
  });
});
