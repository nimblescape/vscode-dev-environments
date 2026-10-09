// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #58: the heartbeats of the remote Session Monitor run under the kernel lock `flock` of
// heartbeatCommand. These tests run that command line with real processes: `flock` and `timeout` as in the helper image,
// and the monitor script built with esbuild (its state folder passed by a small entry instead of /state). Plan step 11I
// (U2, decision of 2026-10-08): the command lines are those of the entries monitorHeartbeat and monitorForget of the
// registry of the container scripts (scriptCommand), which replace heartbeatCommand and forgetCommand with the same lines.
import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HEARTBEAT_LOCK_PATH,
  RECORDS_LOCK_BUSY_EXIT,
  REMOTE_MONITOR_SCRIPT_PATH,
  forgetIfUnchangedCommand,
  heartbeatFileName,
  type HeartbeatInput,
} from '../core/remoteMonitor/protocol';
import { scriptCommand } from '../core/worker/containerScripts';
import { recordRemover } from './main';

/** Plan step 11I (U2, decision of 2026-10-08): the command line of a heartbeat, of the registry (heartbeatCommand before). */
function heartbeatCommand(input: HeartbeatInput): string[] {
  return scriptCommand('monitorHeartbeat', [JSON.stringify(input)]);
}

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

/** The command line of a heartbeat with the lock in the test folder and the test build of the script with its state folder. */
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

/** Starts a process in its own process group, so that the test can kill it and what it started (killGroup). */
function start(argv: string[]): ChildProcess {
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  started.push(child);
  return child;
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

/**
 * Kills the process group of `child` and, first, the groups of all processes below it. Review round 3 of PR #58 (F4):
 * `timeout` puts itself into a process group of its own, which a kill of the group of `flock` does not reach.
 */
function killGroup(child: ChildProcess): void {
  killTree(child.pid as number);
}

function killTree(pid: number): void {
  let children: number[] = [];
  try {
    children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    // No children: pgrep exits 1. Review round 5 of PR #58 (J3): anything else (pgrep missing) fails the test loudly,
    // as the group of `timeout` would otherwise stay with the lock.
    if ((error as { status?: number }).status !== 1) throw error;
  }
  for (const below of children) killTree(below);
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Already gone, or no group of its own.
    }
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

// Review round 3 of PR #58 (F3): `flock`, GNU `timeout` and process groups exist on Linux only, where the helper image and
// CI run; as the other tests of real processes (describeUnix, it.skipIf(win32)).
describe.skipIf(process.platform !== 'linux')('the lock of the heartbeat records', () => {
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
    // Review round 3 of PR #58 (F7): with the exit code of a busy lock (`flock -E`), not 1.
    expect(await exited(start(command(heartbeat(1, true))))).toBe(RECORDS_LOCK_BUSY_EXIT);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_500);
    expect(fs.existsSync(path.join(stateDir, 'heartbeats', heartbeatFileName(SOURCE, A)))).toBe(false);
  });

  // Review round 3 of PR #58 (F4): the cleanup of the tests also ends `timeout` and its child, which hold the lock.
  it('killGroup ends a heartbeat under timeout with the lock it holds', { timeout: 20_000 }, async () => {
    const hanging = heartbeatCommand(heartbeat(1, true));
    const marker = path.join(stateDir, 'inside');
    const prefix = hanging.slice(0, hanging.indexOf('node')).map((part) => (part === HEARTBEAT_LOCK_PATH ? lockPath() : part));
    const child = start([...prefix, 'sh', '-c', `touch '${marker}'; exec sleep 60`]);
    // Review round 4 of PR #58 (H3): kills only once the whole tree runs (flock, timeout in its own group, the command),
    // instead of after 300 ms, so no `timeout` forked between the scan and the kill escapes with the lock.
    while (!fs.existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 10));
    killGroup(child);
    await exited(child);
    const startedAt = Date.now();
    expect(await exited(start(command(heartbeat(1, true))))).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  // Review round 3 of PR #58 (F6): `forget` waits for the lock too, so a heartbeat cannot write a forgotten record back.
  it('forget waits while a heartbeat holds the lock', { timeout: 20_000 }, async () => {
    expect(await exited(start(command(heartbeat(1, true))))).toBe(0);
    const holder = await holdLock();
    const forget = start(
      // Plan step 11I (U2, decision of 2026-10-08): the command line of the entry monitorForget (forgetCommand before).
      scriptCommand('monitorForget', [SOURCE, A]).flatMap((part) => (part === HEARTBEAT_LOCK_PATH ? [lockPath()] : part === REMOTE_MONITOR_SCRIPT_PATH ? [script, stateDir] : [part])),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(forget.exitCode).toBeNull();
    expect(readRecord()).toMatchObject({ seq: 1 });
    killGroup(holder);
    expect(await exited(forget)).toBe(0);
    expect(fs.existsSync(path.join(stateDir, 'heartbeats', heartbeatFileName(SOURCE, A)))).toBe(false);
  });

  // Review round 1 of PR #63 (F2): the removal of an old record by the loop waits for the lock too, and removes the record
  // only while it still has the `at` that the loop read; a heartbeat that wrote it meanwhile wins.
  it('forget with an `at` waits for the lock and keeps a record that a heartbeat wrote meanwhile', { timeout: 20_000 }, async () => {
    expect(await exited(start(command(heartbeat(1, false))))).toBe(0);
    const seen = (readRecord() as { at: number }).at;
    const local = (argv: string[]) => argv.flatMap((part) => (part === HEARTBEAT_LOCK_PATH ? [lockPath()] : part === REMOTE_MONITOR_SCRIPT_PATH ? [script, stateDir] : [part]));
    const holder = await holdLock();
    const forget = start(local(forgetIfUnchangedCommand(SOURCE, A, seen)));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(forget.exitCode).toBeNull();
    // A heartbeat under the lock (the holder) writes the record again with a new `at`.
    const file = path.join(stateDir, 'heartbeats', heartbeatFileName(SOURCE, A));
    fs.writeFileSync(file, JSON.stringify({ ...(readRecord() as object), at: seen + 1 }));
    killGroup(holder);
    expect(await exited(forget)).toBe(0);
    expect(readRecord()).toMatchObject({ at: seen + 1 });
    // With the `at` of the file, it removes it and says so.
    const [file0, ...args] = local(forgetIfUnchangedCommand(SOURCE, A, seen + 1));
    expect(execFileSync(file0, args, { encoding: 'utf8', timeout: 15_000 })).toBe('removed\n');
    expect(fs.existsSync(file)).toBe(false);
  });

  // Review round 2 of PR #63 (R2-4): recordRemover, the removal of `run`, with the real script under `flock`.
  it('recordRemover removes a record with its `at` under the lock, and rejects while the lock stays held', { timeout: 20_000 }, async () => {
    expect(await exited(start(command(heartbeat(1, false))))).toBe(0);
    const seen = (readRecord() as { at: number }).at;
    const local = (part: string) => (part === HEARTBEAT_LOCK_PATH ? [lockPath()] : part === REMOTE_MONITOR_SCRIPT_PATH ? [script, stateDir] : [part]);
    const remove = recordRemover((file, args, options, callback) => {
      const [file0, ...args0] = [file, ...args].flatMap(local);
      return execFile(file0, args0, options, (error, stdout, stderr) => callback(error, String(stdout), String(stderr)));
    });
    const record = { source: SOURCE, environmentId: A, keepRunning: false, limitSeconds: 600 };
    expect(await remove({ ...record, at: seen + 1 })).toBe(false);
    expect(readRecord()).toMatchObject({ at: seen });
    const holder = await holdLock();
    await expect(remove({ ...record, at: seen })).rejects.toThrow('the heartbeat records stayed locked by another command for 5 s');
    expect(readRecord()).toMatchObject({ at: seen });
    killGroup(holder);
    await exited(holder);
    expect(await remove({ ...record, at: seen })).toBe(true);
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
