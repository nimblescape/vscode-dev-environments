// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_MONITOR_ENTRY, REMOTE_MONITOR_READY_TEXT, RECORDS_LOCK_BUSY_EXIT, forgetIfUnchangedCommand, heartbeatFileName, inUseByOtherComputer, type RecordsOutput } from '../core/remoteMonitor/protocol';
import {
  EXIT_INVALID,
  PS_FORMAT,
  REMOTE_IDLE_EXIT_MS,
  idleExitFromEnv,
  RemoteMonitorLoop,
  heartbeatDir,
  imageScheduleFromEnv,
  imageTimesFromEnv,
  CurrentImageSettings,
  ImageSchedule,
  main,
  readImageList,
  parseContainerLines,
  readRecords,
  recordRemover,
  removeRecord,
  removeStaleStateTemporaryFiles,
  runEntry,
  startMonitor,
  type EntryDeps,
  type ExecFile,
  timingFromEnv,
  type DockerResult,
} from './main';
import { lockFilePath, lockFolder } from '../core/helperChannel/protocol';
import { REMOTE_GAP_MS, REMOTE_GRACE_MS, REMOTE_TICK_MS, decide, type RemoteRecord } from './rules';
import type { StopLockAttempt } from './stopLock';

const A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const B = '7c1d2e3f-0000-4000-8000-000000000002';
const SOURCE = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const MINUTE = 60_000;
const DEV_ID = 'a'.repeat(64);
const DB_ID = 'b'.repeat(64);

/**
 * Plan step 8, PR B (D2): the lock of an automatic stop, always free (the tests of the lock are in the describe
 * 'RemoteMonitorLoop: the environment lock of a stop').
 */
const lockAlways = async () => ({ kind: 'locked' as const, release: () => {} });

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-monitor-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(argv: string[], now = T0): Promise<Run> {
  let out = '';
  let err = '';
  const code = await main(argv, { env: {}, stateDir, now: () => now, out: (text) => (out += text), err: (text) => (err += text) });
  return { code, out, err };
}

function recordFiles(): string[] {
  const dir = heartbeatDir(stateDir);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

/** Writes a record file; `seq` is 0 unless the record names one. */
function writeRecord(source: string, environmentId: string, record: Record<string, unknown>): void {
  const dir = heartbeatDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, heartbeatFileName(source, environmentId)), JSON.stringify({ seq: 0, ...record }));
}

function readRecord(source: string, environmentId: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(heartbeatDir(stateDir), heartbeatFileName(source, environmentId)), 'utf8'));
}

describe('monitor.js heartbeat', () => {
  it('writes one record per environment with the clock of the host, mode 0600', async () => {
    const heartbeat = { source: SOURCE, limitSeconds: 300, environments: [{ id: A, keepRunning: false, seq: 10 }, { id: B, keepRunning: true, seq: 10 }] };
    expect(await run(['heartbeat', JSON.stringify(heartbeat)])).toEqual({ code: 0, out: '', err: '' });
    expect(recordFiles()).toEqual([heartbeatFileName(SOURCE, A), heartbeatFileName(SOURCE, B)].sort());
    const file = path.join(heartbeatDir(stateDir), heartbeatFileName(SOURCE, B));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ at: T0, keepRunning: true, limitSeconds: 300, seq: 10 });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // A later heartbeat replaces the record.
    await run(['heartbeat', JSON.stringify({ ...heartbeat, environments: [{ id: B, keepRunning: false, seq: 11 }] })], T0 + 1000);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ at: T0 + 1000, keepRunning: false, limitSeconds: 300, seq: 11 });
    // The same seq replaces it too.
    await run(['heartbeat', JSON.stringify({ ...heartbeat, environments: [{ id: B, keepRunning: true, seq: 11 }] })], T0 + 2000);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ at: T0 + 2000, keepRunning: true });
    expect(fs.readdirSync(heartbeatDir(stateDir)).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  // Review round 2 of PR #39 (L1): a heartbeat of the Session Monitor that read the registry before Close and Keep Running
  // set the flag reaches the host after the window's heartbeat. The newer choice stays.
  it('ignores an entry with a lower seq than the record of the same source: the race of Close and Keep Running', async () => {
    const monitorSnapshotAt = T0 - 3000;
    const windowSetFlagAt = T0 - 1000;
    // 1. The window's heartbeat with keepRunning (seq: right after it set the flag) arrives first.
    const window = { source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: true, seq: windowSetFlagAt }] };
    expect((await run(['heartbeat', JSON.stringify(window)], T0)).code).toBe(0);
    // 2. The heartbeat of the monitor tick that read the registry before the flag was set arrives later.
    const monitor = { source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: false, seq: monitorSnapshotAt }, { id: B, keepRunning: false, seq: monitorSnapshotAt }] };
    expect((await run(['heartbeat', JSON.stringify(monitor)], T0 + 500)).code).toBe(0);
    expect(readRecord(SOURCE, A)).toEqual({ at: T0, keepRunning: true, limitSeconds: 600, seq: windowSetFlagAt });
    // The other entry of the same heartbeat is written.
    expect(readRecord(SOURCE, B)).toEqual({ at: T0 + 500, keepRunning: false, limitSeconds: 600, seq: monitorSnapshotAt });
    // 3. The next monitor tick (after the flag was set) replaces it.
    const next = { source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: true, seq: T0 + 2000 }] };
    await run(['heartbeat', JSON.stringify(next)], T0 + 5000);
    expect(readRecord(SOURCE, A)).toEqual({ at: T0 + 5000, keepRunning: true, limitSeconds: 600, seq: T0 + 2000 });
  });

  // Review round 3 of PR #39 (N2): the seq order holds only while the stored record is at most 60 s old.
  it('the race order within 60 s keeps the newer flag; an older record is replaced whatever its seq', async () => {
    writeRecord(SOURCE, A, { at: T0 - 59_000, keepRunning: true, limitSeconds: 600, seq: 5_000 });
    await run(['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: false, seq: 4_000 }] })]);
    expect(readRecord(SOURCE, A)).toMatchObject({ at: T0 - 59_000, keepRunning: true, seq: 5_000 });
  });

  it('a clock of the computer set back by an hour: the next heartbeat replaces the record and refreshes at', async () => {
    const hour = 3_600_000;
    // Written before the clock went back: its seq is an hour ahead of the heartbeats that follow.
    writeRecord(SOURCE, A, { at: T0 - 61_000, keepRunning: false, limitSeconds: 600, seq: T0 + hour });
    await run(['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: false, seq: T0 - 1000 }] })]);
    expect(readRecord(SOURCE, A)).toEqual({ at: T0, keepRunning: false, limitSeconds: 600, seq: T0 - 1000 });
  });

  it('a stale keep with a seq far ahead is replaced by a later keep=false after 60 s', async () => {
    writeRecord(SOURCE, A, { at: T0 - 120_000, keepRunning: true, limitSeconds: 600, seq: T0 + 3_600_000 });
    await run(['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: false, seq: T0 }] })]);
    expect(readRecord(SOURCE, A)).toEqual({ at: T0, keepRunning: false, limitSeconds: 600, seq: T0 });
  });

  // Review round 3 of PR #39 (N1): the entries of the full sync are clear-only.
  it('a clear-only entry clears the own earlier keep of this source', async () => {
    writeRecord(SOURCE, A, { at: T0 - 30 * MINUTE, keepRunning: true, limitSeconds: 600, seq: 1 });
    await run(['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: false, seq: 2, clearOnly: true }] })]);
    expect(readRecord(SOURCE, A)).toEqual({ at: T0, keepRunning: false, limitSeconds: 600, seq: 2 });
  });

  it('a clear-only entry creates no record, and refreshes no record without keep', async () => {
    writeRecord(SOURCE, B, { at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600, seq: 1 });
    const heartbeat = { source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: false, seq: 2, clearOnly: true }, { id: B, keepRunning: false, seq: 2, clearOnly: true }] };
    expect((await run(['heartbeat', JSON.stringify(heartbeat)])).code).toBe(0);
    expect(recordFiles()).toEqual([heartbeatFileName(SOURCE, B)]);
    expect(readRecord(SOURCE, B)).toMatchObject({ at: T0 - 30 * MINUTE, seq: 1 });
  });

  it("a shared engine: the keep of computer A survives the full sync of computer B", async () => {
    // A kept the environment and went offline long ago.
    writeRecord(OTHER, A, { at: T0 - 5 * 24 * 60 * MINUTE, keepRunning: true, limitSeconds: 600, seq: 1 });
    // B starts its Session Monitor: the full sync names the environment clear-only.
    await run(['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: false, seq: T0, clearOnly: true }] })]);
    expect(recordFiles()).toEqual([heartbeatFileName(OTHER, A)]);
    // The remote monitor keeps it.
    const records = await readRecords(heartbeatDir(stateDir));
    expect(decide({ now: T0, containers: [{ id: DEV_ID, state: 'running', name: 'x', environmentId: A, composeService: '' }], records, state: { lastTickAt: T0 - REMOTE_TICK_MS } }).kept).toEqual([A]);
    // And B's own shared-engine check still blocks its stop.
    const output = JSON.parse((await run(['records', A])).out) as RecordsOutput;
    expect(inUseByOtherComputer(output, SOURCE)).toBe(true);
  });

  it('a record of another source does not hold back an entry with a lower seq', async () => {
    writeRecord(OTHER, A, { at: T0, keepRunning: true, limitSeconds: 600, seq: 9_999_999_999_999 });
    await run(['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: false, seq: 1 }] })]);
    expect(readRecord(SOURCE, A)).toEqual({ at: T0, keepRunning: false, limitSeconds: 600, seq: 1 });
  });

  // Review round 2 of PR #58: the lock of the records moved from files in this folder to the kernel lock `flock` around
  // the `docker exec` (heartbeatCommand); the tests of two heartbeats at the same time, of a killed holder, and of the
  // wait run real processes in heartbeatLock.test.ts. No lock file is written here anymore.
  it('writes no lock file next to the records', async () => {
    await run(['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: false, seq: 1 }] })]);
    expect(fs.readdirSync(heartbeatDir(stateDir))).toEqual([heartbeatFileName(SOURCE, A)]);
  });

  // Review round 3 of PR #58 (F5): a heartbeat killed between its write and its rename leaves its temporary file; the
  // next heartbeat (under the lock of the records) removes it, and nothing else.
  it('removes the temporary files of killed heartbeats, and only those', async () => {
    const dir = heartbeatDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    const leftover = `.${heartbeatFileName(OTHER, B)}.4242.tmp`;
    const foreign = ['.other.4242.tmp', `${heartbeatFileName(OTHER, B)}.tmp`, 'notes.txt'];
    for (const name of [leftover, ...foreign]) fs.writeFileSync(path.join(dir, name), '{');
    await run(['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: false, seq: 1 }] })]);
    expect(fs.readdirSync(dir).sort()).toEqual([...foreign, heartbeatFileName(SOURCE, A)].sort());
  });

  it.each<[string, string[]]>([
    ['invalid JSON', ['heartbeat', '{']],
    ['an invalid environment id', ['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: '../../x', keepRunning: true, seq: 1 }] })]],
    ['a missing argument', ['heartbeat']],
    ['an argument too many', ['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [] }), 'x']],
    ['an entry without seq', ['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: true }] })]],
  ])('exits with 2 and writes nothing for %s', async (_name, argv) => {
    const result = await run(argv);
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.err).toContain('Invalid');
    expect(recordFiles()).toEqual([]);
  });
});

describe('monitor.js records and forget', () => {
  it('prints the records of one environment with the clock of the host', async () => {
    writeRecord(SOURCE, A, { at: T0 - 1000, keepRunning: false, limitSeconds: 600 });
    writeRecord(OTHER, A, { at: T0 - 2000, keepRunning: true, limitSeconds: 600 });
    writeRecord(SOURCE, B, { at: T0 - 3000, keepRunning: false, limitSeconds: 600 });
    const result = await run(['records', A]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.out) as { now: number; records: Array<{ source: string }> };
    expect(output.now).toBe(T0);
    expect(output.records.map((record) => record.source).sort()).toEqual([SOURCE, OTHER].sort());
  });

  it('prints no records when the folder does not exist yet', async () => {
    expect(JSON.parse((await run(['records', A])).out)).toEqual({ now: T0, records: [] });
  });

  it('removes one record; a missing one is no error', async () => {
    writeRecord(SOURCE, A, { at: T0, keepRunning: false, limitSeconds: 600 });
    writeRecord(OTHER, A, { at: T0, keepRunning: false, limitSeconds: 600 });
    // Review round 2 of PR #63 (R2-5): without an `at`, nothing is printed.
    expect(await run(['forget', SOURCE, A])).toEqual({ code: 0, out: '', err: '' });
    expect(recordFiles()).toEqual([heartbeatFileName(OTHER, A)]);
    expect((await run(['forget', SOURCE, A])).code).toBe(0);
  });

  // Review round 1 of PR #63 (F2): the removal of the loop, only while the record still has the `at` it read.
  it('with an `at`, removes the record only while it still has that `at`, and says so', async () => {
    writeRecord(SOURCE, A, { at: T0 - 1000, keepRunning: false, limitSeconds: 600 });
    expect(await run(['forget', SOURCE, A, String(T0 - 2000)])).toEqual({ code: 0, out: '', err: '' });
    expect(recordFiles()).toEqual([heartbeatFileName(SOURCE, A)]);
    expect(await run(['forget', SOURCE, A, String(T0 - 1000)])).toEqual({ code: 0, out: 'removed\n', err: '' });
    expect(recordFiles()).toEqual([]);
    expect(await run(['forget', SOURCE, A, String(T0 - 1000)])).toEqual({ code: 0, out: '', err: '' });
  });

  // Changed test, review round 4 of PR #63 (N4-1, N4-2: R3-9 reverted): was "with the `at` 0, removes a file without a
  // valid record". An `at` (also 0) never removes a file without a valid record, and a missing file prints nothing; the
  // plain forget of Delete removes such a file by name.
  it('with an `at`, keeps a file without a valid record and prints nothing for a missing file; without, removes it', async () => {
    writeRecord(SOURCE, A, { at: T0 - 1000, keepRunning: false, limitSeconds: 600 });
    fs.writeFileSync(path.join(heartbeatDir(stateDir), heartbeatFileName(OTHER, A)), '{"at":');
    expect(await run(['forget', SOURCE, A, '0'])).toEqual({ code: 0, out: '', err: '' });
    expect(await run(['forget', OTHER, A, '0'])).toEqual({ code: 0, out: '', err: '' });
    expect(await run(['forget', OTHER, B, '0'])).toEqual({ code: 0, out: '', err: '' });
    expect(await run(['forget', OTHER, B, String(T0)])).toEqual({ code: 0, out: '', err: '' });
    expect(recordFiles()).toEqual([heartbeatFileName(OTHER, A), heartbeatFileName(SOURCE, A)].sort());
    expect(await run(['forget', OTHER, A])).toEqual({ code: 0, out: '', err: '' });
    expect(recordFiles()).toEqual([heartbeatFileName(SOURCE, A)]);
  });

  it.each<[string[]]>([
    [['records', '../x']],
    [['records']],
    [['forget', SOURCE, '../x']],
    [['forget', 'x', A]],
    [['forget', SOURCE]],
    // Review round 1 of PR #63 (F2): an invalid `at`, or one argument too many.
    [['forget', SOURCE, A, '-1']],
    [['forget', SOURCE, A, '1.5']],
    [['forget', SOURCE, A, '99999999999999999']],
    // Review round 2 of PR #63 (R2-5): 16 digits, but not a safe integer.
    [['forget', SOURCE, A, '9999999999999999']],
    [['forget', SOURCE, A, String(T0), 'x']],
    [['run', 'x']],
    [['unknown']],
    [[]],
  ])(
    'refuses %j with exit code 2',
    async (argv) => {
      writeRecord(SOURCE, A, { at: T0, keepRunning: false, limitSeconds: 600 });
      expect((await run(argv)).code).toBe(EXIT_INVALID);
      expect(recordFiles()).toEqual([heartbeatFileName(SOURCE, A)]);
    },
  );
});

describe('readRecords', () => {
  it('ignores invalid names, invalid content, folders, links, and large files', async () => {
    const dir = heartbeatDir(stateDir);
    writeRecord(SOURCE, A, { at: T0, keepRunning: false, limitSeconds: 600 });
    writeRecord(OTHER, A, { at: T0, keepRunning: 'yes', limitSeconds: 600 });
    writeRecord('11111111111111111111111111111111', B, { at: T0, keepRunning: true, limitSeconds: 600, seq: undefined });
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
    fs.writeFileSync(path.join(dir, `.${heartbeatFileName(SOURCE, B)}.1.tmp`), JSON.stringify({ at: T0, keepRunning: true, limitSeconds: 600 }));
    fs.mkdirSync(path.join(dir, heartbeatFileName(OTHER, B)));
    const big = 'fedcba9876543210fedcba9876543211';
    fs.writeFileSync(path.join(dir, heartbeatFileName(big, B)), JSON.stringify({ at: T0, keepRunning: true, limitSeconds: 600, pad: 'x'.repeat(5000) }));
    if (process.platform !== 'win32') {
      const target = path.join(stateDir, 'outside.json');
      fs.writeFileSync(target, JSON.stringify({ at: T0, keepRunning: true, limitSeconds: 600 }));
      fs.symlinkSync(target, path.join(dir, heartbeatFileName('fedcba9876543210fedcba9876543212', B)));
    }
    expect(await readRecords(dir)).toEqual([{ source: SOURCE, environmentId: A, at: T0, keepRunning: false, limitSeconds: 600, seq: 0 }]);
    // Changed expectation, review round 4 of PR #63 (N4-1: R3-9 reverted): was the list of the files without a valid
    // record (the `invalid` argument, gone). They are ignored and stay. Review round 5 of PR #63 (R5-4): a regression guard
    // (readRecords removes nothing), kept although readRecords no longer takes the argument that removed them.
    for (const source of ['11111111111111111111111111111111', OTHER, big]) expect(fs.existsSync(path.join(dir, heartbeatFileName(source, source === OTHER ? A : B)))).toBe(true);
  });
});

describe('parseContainerLines', () => {
  it('reads the lines of docker ps and skips lines without a valid id', () => {
    const lines = [
      `${DEV_ID}\trunning\tdevenv-api\t${A}\t`,
      `${DB_ID}\texited\tdevenv-api-db-1\t${A}\tdb`,
      `${DEV_ID}\trunning\tforeign\tnot-an-id\t`,
      `zz\trunning\tx\t${A}\t`,
      '',
    ].join('\n');
    expect(parseContainerLines(lines)).toEqual([
      { id: DEV_ID, state: 'running', name: 'devenv-api', environmentId: A, composeService: '' },
      { id: DB_ID, state: 'exited', name: 'devenv-api-db-1', environmentId: A, composeService: 'db' },
    ]);
  });
});

describe('timingFromEnv', () => {
  it('takes a tick of the tests of the container, and scales the gap and the grace', () => {
    expect(timingFromEnv({ DEVENV_MONITOR_TICK_MS: '500' })).toEqual({ tickMs: 500, timing: { gapMs: 2000, graceMs: 4000 } });
  });

  it.each([undefined, '', '50', '99', '60001', 'abc', '5e3', '-500'])('uses the normal times for %j', (value) => {
    expect(timingFromEnv(value === undefined ? {} : { DEVENV_MONITOR_TICK_MS: value })).toEqual({
      tickMs: REMOTE_TICK_MS,
      timing: { gapMs: 60_000, graceMs: REMOTE_GRACE_MS },
    });
  });
});

describe('RemoteMonitorLoop', () => {
  let now: number;
  let lines: string[];
  let ps: DockerResult;
  let stopResults: Map<string, DockerResult>;
  let calls: string[][];
  let loop: RemoteMonitorLoop;
  /** Runs right before a removal: a heartbeat that comes between the read and the removal. */
  let beforeRemove: ((record: RemoteRecord) => void) | undefined;

  beforeEach(() => {
    now = T0;
    lines = [];
    calls = [];
    stopResults = new Map();
    ps = { code: 0, stdout: `${DB_ID}\trunning\tdevenv-api-db-1\t${A}\tdb\n${DEV_ID}\trunning\tdevenv-api\t${A}\t\n`, stderr: '' };
    beforeRemove = undefined;
    loop = new RemoteMonitorLoop({
      docker: async (args) => {
        calls.push([...args]);
        if (args[0] === 'ps') return ps;
        return stopResults.get(args[1]) ?? { code: 0, stdout: '', stderr: '' };
      },
      // Review round 1 of PR #63 (F2): the removal of `forget <source> <env id> <at>`, in the process (the lock is tested in
      // heartbeatLock.test.ts).
      removeRecord: async (record) => {
        calls.push(['forget', record.source, record.environmentId, String(record.at)]);
        beforeRemove?.(record);
        return removeRecord(heartbeatDir(stateDir), record.source, record.environmentId, record.at);
      },
      dir: heartbeatDir(stateDir),
      lockEnvironment: lockAlways,
      now: () => now,
      log: (message) => lines.push(message),
    });
  });

  // Review round 4 of PR #63 (N4-5): the removals run in the background; the tests wait for the pass after the tick.
  async function tickAt(time: number): Promise<string[]> {
    now = time;
    const stopped = await loop.tick();
    await loop.removals;
    return stopped;
  }

  it('lists only containers with the environment label, and stops a stale environment after the grace, dev container first', async () => {
    writeRecord(SOURCE, A, { at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600 });
    expect(await tickAt(T0)).toEqual([]);
    expect(calls[0]).toEqual(['ps', '-a', '--no-trunc', '--filter', 'label=nimblescape.devenv.environment-id', '--format', PS_FORMAT]);
    expect(lines.some((line) => line.includes('nothing is stopped until'))).toBe(true);
    for (let time = T0 + REMOTE_TICK_MS; time < T0 + REMOTE_GRACE_MS; time += REMOTE_TICK_MS) expect(await tickAt(time)).toEqual([]);
    expect(await tickAt(T0 + REMOTE_GRACE_MS)).toEqual([A]);
    expect(calls.filter((call) => call[0] === 'stop')).toEqual([['stop', DEV_ID], ['stop', DB_ID]]);
    expect(lines.filter((line) => line.startsWith('Stopping'))).toHaveLength(2);
    expect(lines.find((line) => line.startsWith('Stopping'))).toContain('no computer sent a heartbeat for 32 minutes');
  });

  it('never stops a container of an environment without any record', async () => {
    for (let time = T0; time <= T0 + 60 * MINUTE; time += MINUTE) expect(await tickAt(time)).toEqual([]);
    expect(calls.filter((call) => call[0] === 'stop')).toEqual([]);
  });

  it('keeps an environment that a record keeps running, and says so once', async () => {
    writeRecord(SOURCE, A, { at: T0 - 30 * MINUTE, keepRunning: true, limitSeconds: 600 });
    for (let time = T0; time <= T0 + 2 * REMOTE_GRACE_MS; time += REMOTE_TICK_MS) expect(await tickAt(time)).toEqual([]);
    expect(calls.filter((call) => call[0] === 'stop')).toEqual([]);
    expect(lines.filter((line) => line.includes('keeps running'))).toHaveLength(1);
  });

  it('tries a failed stop again at the next tick, and logs the failure once', async () => {
    writeRecord(SOURCE, A, { at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600 });
    stopResults.set(DEV_ID, { code: 1, stdout: '', stderr: 'Error response from daemon: cannot stop' });
    for (let time = T0; time <= T0 + REMOTE_GRACE_MS; time += REMOTE_TICK_MS) await tickAt(time);
    expect(await tickAt(T0 + REMOTE_GRACE_MS + REMOTE_TICK_MS)).toEqual([]);
    expect(lines.filter((line) => line.includes('could not be stopped'))).toHaveLength(1);
    stopResults.clear();
    expect(await tickAt(T0 + REMOTE_GRACE_MS + 2 * REMOTE_TICK_MS)).toEqual([A]);
  });

  it('stops nothing while Docker does not answer, and says so once', async () => {
    writeRecord(SOURCE, A, { at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600 });
    ps = { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
    for (let time = T0; time <= T0 + 2 * REMOTE_GRACE_MS; time += REMOTE_TICK_MS) expect(await tickAt(time)).toEqual([]);
    expect(lines.filter((line) => line.includes('Docker does not answer'))).toHaveLength(1);
    expect(calls.filter((call) => call[0] === 'stop')).toEqual([]);
  });

  it('removes old records of removed environments, and only those files', async () => {
    const old = T0 - 8 * 24 * 60 * MINUTE;
    writeRecord(SOURCE, B, { at: old, keepRunning: false, limitSeconds: 600 });
    writeRecord(SOURCE, A, { at: old, keepRunning: false, limitSeconds: 600 });
    fs.writeFileSync(path.join(heartbeatDir(stateDir), 'other-file'), 'x');
    await tickAt(T0);
    expect(recordFiles()).toEqual([heartbeatFileName(SOURCE, A), 'other-file'].sort());
    // Monitor cleanup, user decision 2026-09-29 (R1): the log line names the reason.
    expect(lines).toContain(`Removed the old record of ${B} (no container of it exists).`);
  });

  // Monitor cleanup, user decision 2026-09-29 (R1): an old record that a newer one of the same environment replaced.
  it('removes an old record that a newer one of the same environment replaced, and names the reason', async () => {
    writeRecord(SOURCE, A, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    writeRecord(OTHER, A, { at: T0 - MINUTE, keepRunning: false, limitSeconds: 600 });
    await tickAt(T0);
    expect(recordFiles()).toEqual([heartbeatFileName(OTHER, A)]);
    expect(lines).toContain(`Removed the old record of ${A} (a newer record of it exists).`);
  });

  // Review round 1 of PR #63 (F2): a computer that comes back after more than 7 days writes its record between the read of
  // the loop and the removal; the record stays, and nothing is logged.
  it('keeps a record that a heartbeat wrote again between the read and the removal', async () => {
    writeRecord(SOURCE, A, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    writeRecord(OTHER, A, { at: T0 - MINUTE, keepRunning: false, limitSeconds: 600 });
    beforeRemove = (record) => writeRecord(record.source, record.environmentId, { at: T0, keepRunning: false, limitSeconds: 600 });
    await tickAt(T0);
    expect(calls).toContainEqual(['forget', SOURCE, A, String(T0 - 8 * 24 * 60 * MINUTE)]);
    expect(recordFiles()).toEqual([heartbeatFileName(OTHER, A), heartbeatFileName(SOURCE, A)].sort());
    expect(readRecord(SOURCE, A)).toMatchObject({ at: T0 });
    expect(lines.filter((line) => line.startsWith('Removed'))).toEqual([]);
  });

  // Review round 1 of PR #63 (F2) put the removals before the stops; review round 2 (R2-1) moved them after the stops
  // again, which a removal (up to 20 s each) would otherwise delay.
  it('removes the old records after it stops containers', async () => {
    writeRecord(SOURCE, A, { at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600 });
    for (let time = T0; time < T0 + REMOTE_GRACE_MS; time += REMOTE_TICK_MS) await tickAt(time);
    writeRecord(SOURCE, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    calls = [];
    expect(await tickAt(T0 + REMOTE_GRACE_MS)).toEqual([A]);
    // Changed expectation, review round 2 of PR #63 (R2-1): was ['ps', 'forget', 'stop', 'stop']. Changed expectation,
    // plan step 8 PR B (D2): was ['ps', 'stop', 'stop', 'forget']; the second `ps` lists the containers of A again under
    // its lock.
    expect(calls.map((call) => call[0])).toEqual(['ps', 'ps', 'stop', 'stop', 'forget']);
    expect(recordFiles()).toEqual([heartbeatFileName(SOURCE, A)]);
  });

  it('logs a removal that failed', async () => {
    const failing = new RemoteMonitorLoop({ docker: async () => ps, removeRecord: async () => Promise.reject(new Error('the heartbeat records stayed locked')), dir: heartbeatDir(stateDir), lockEnvironment: lockAlways, now: () => T0, log: (message) => lines.push(message) });
    writeRecord(SOURCE, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    await failing.tick();
    // Review round 4 of PR #63 (N4-5): the removals run in the background.
    await failing.removals;
    expect(lines).toContain(`The old record of ${B} could not be removed: the heartbeat records stayed locked`);
  });

  // Review round 2 of PR #63 (R2-3): a removal that keeps failing is logged once per series, as a failed stop.
  it('logs a removal that keeps failing once, and again after it succeeded or the record changed', async () => {
    let fail = true;
    const failing = new RemoteMonitorLoop({
      docker: async () => ps,
      removeRecord: async () => (fail ? Promise.reject(new Error('locked')) : false),
      dir: heartbeatDir(stateDir),
      lockEnvironment: lockAlways,
      now: () => T0,
      log: (message) => lines.push(message),
    });
    const failed = () => lines.filter((line) => line.includes('could not be removed')).length;
    // Review round 4 of PR #63 (N4-5): the removals run in the background; each tick waits for its pass here.
    const tick = async () => {
      await failing.tick();
      await failing.removals;
    };
    writeRecord(SOURCE, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    await tick();
    await tick();
    await tick();
    expect(failed()).toBe(1);
    // Another record (another `at`) is a series of its own.
    writeRecord(SOURCE, B, { at: T0 - 9 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    await tick();
    await tick();
    expect(failed()).toBe(2);
    // A success ends the series.
    fail = false;
    await tick();
    fail = true;
    await tick();
    expect(failed()).toBe(3);
    // A tick without the removal ends it too.
    fs.rmSync(path.join(heartbeatDir(stateDir), heartbeatFileName(SOURCE, B)));
    await tick();
    writeRecord(SOURCE, B, { at: T0 - 9 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    await tick();
    expect(failed()).toBe(4);
  });

  /** A loop whose removals wait until the test ends them (`release`), with the clock `clock`. */
  function slowLoop(): { loop: RemoteMonitorLoop; attempts: string[]; release: (removed: boolean) => void; setClock: (time: number) => void } {
    let clock = T0;
    const pending: Array<(removed: boolean) => void> = [];
    const attempts: string[] = [];
    const slow = new RemoteMonitorLoop({
      docker: async (args) => (args[0] === 'ps' ? ps : { code: 0, stdout: '', stderr: '' }),
      removeRecord: (record) => {
        attempts.push(record.source);
        return new Promise<boolean>((resolve) => pending.push(resolve));
      },
      dir: heartbeatDir(stateDir),
      lockEnvironment: lockAlways,
      now: () => clock,
      log: (message) => lines.push(message),
    });
    return { loop: slow, attempts, release: (removed) => pending.shift()?.(removed), setClock: (time) => (clock = time) };
  }

  // Changed test, review round 4 of PR #63 (N4-5, R3-1 replaced): was "starts no removal after one tick interval, so slow
  // removals keep no grace on; the rest follow at the next ticks". The removals run in the background: a tick never waits
  // for them, so the next tick is no gap, and the stops come as without removals, while a removal still hangs.
  it('ends a tick while a slow removal is still pending, so the stops come without a gap', async () => {
    writeRecord(OTHER, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    writeRecord(SOURCE, A, { at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600 });
    const { loop: slow, attempts, setClock } = slowLoop();
    const stoppedAt: number[] = [];
    for (let tick = 0; tick <= REMOTE_GRACE_MS / REMOTE_TICK_MS + 1; tick++) {
      setClock(T0 + tick * REMOTE_TICK_MS);
      if ((await slow.tick()).includes(A)) stoppedAt.push(tick);
    }
    // The grace of the start ends after 120 s, and no gap starts another one.
    expect(stoppedAt).toEqual([REMOTE_GRACE_MS / REMOTE_TICK_MS, REMOTE_GRACE_MS / REMOTE_TICK_MS + 1]);
    expect(lines.filter((line) => line.includes('nothing is stopped until'))).toHaveLength(1);
    expect(attempts).toEqual([OTHER]);
    expect(slow.removals).toBeDefined();
  });

  // Review round 4 of PR #63 (N4-5): at most one pass at a time. Review round 5 (R5-7): a tick that reaches the end of its
  // stops while no pass runs starts the next one, with the records it read at its start.
  it('starts no second pass of removals while one runs', async () => {
    writeRecord(OTHER, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    const { loop: slow, attempts, release } = slowLoop();
    await slow.tick();
    const pass = slow.removals;
    await slow.tick();
    await slow.tick();
    expect(attempts).toEqual([OTHER]);
    expect(slow.removals).toBe(pass);
    release(true);
    await pass;
    expect(slow.removals).toBeUndefined();
    expect(lines).toContain(`Removed the old record of ${B} (no container of it exists).`);
    await slow.tick();
    expect(attempts).toEqual([OTHER, OTHER]);
    release(false);
    await slow.removals;
  });

  // Review round 5 of PR #63 (R5-6): a pass may end long after the tick that decided it, when containers of the environment
  // may exist again. The forgotten records of an environment go oldest first (of equal `at`, a keep last), and after one
  // that is not removed the rest of it stay: the newest records stay until all are gone, so no stop or keep changes.
  // Review round 6 of PR #63 (R6-1): the order is that of `decide`, by the times as the rules see them (clamped).
  it.each([
    ['removed', async () => true, ['D', 'T', 'C']],
    ['not removed', async () => false, ['D']],
    ['failed', async () => Promise.reject(new Error('locked')), ['D']],
  ])('removes the forgotten records of an environment oldest first, a keep last; the oldest %s', async (_, first, expected) => {
    const THIRD = '1'.repeat(32);
    const names: Record<string, string> = { [SOURCE]: 'C', [THIRD]: 'T', [OTHER]: 'D' };
    writeRecord(SOURCE, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: true, limitSeconds: 600 });
    writeRecord(THIRD, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    writeRecord(OTHER, B, { at: T0 - 9 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    const attempts: string[] = [];
    const removeRecord = (record: RemoteRecord) => (attempts.push(names[record.source]) === 1 ? first() : Promise.resolve(true));
    const ordered = new RemoteMonitorLoop({ docker: async () => ps, removeRecord, dir: heartbeatDir(stateDir), lockEnvironment: lockAlways, now: () => T0, log: (message) => lines.push(message) });
    await ordered.tick();
    await ordered.removals;
    expect(attempts).toEqual(expected);
  });

  // Review round 6 of PR #63 (R6-2): the records that stay after a removal that is not done are those of its environment
  // only; the forgotten records of other environments and the superseded ones are still removed in that pass.
  it('keeps only the rest of the environment whose removal failed', async () => {
    const C = '9e8d7c6b-0000-4000-8000-000000000003';
    writeRecord(OTHER, B, { at: T0 - 9 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    writeRecord(SOURCE, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    writeRecord(SOURCE, C, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    writeRecord(SOURCE, A, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    writeRecord(OTHER, A, { at: T0 - MINUTE, keepRunning: false, limitSeconds: 600 });
    const attempts: string[] = [];
    const removeRecord = async (record: RemoteRecord) => {
      attempts.push(`${record.environmentId}.${record.source}`);
      if (record.environmentId === B && record.source === OTHER) throw new Error('locked');
      return true;
    };
    const loop = new RemoteMonitorLoop({ docker: async () => ps, removeRecord, dir: heartbeatDir(stateDir), lockEnvironment: lockAlways, now: () => T0, log: (message) => lines.push(message) });
    await loop.tick();
    await loop.removals;
    expect([...attempts].sort()).toEqual([`${A}.${SOURCE}`, `${B}.${OTHER}`, `${C}.${SOURCE}`].sort());
  });

  // Review round 8 of PR #63 (R8-5): after a forgotten record that is not removed, only the forgotten records of its
  // environment stay; a superseded record of the same environment is still removed in that pass (it is never the
  // newest). One environment with both needs a record in the future: here one written while the clock of the host was
  // two weeks ahead, first seen eight days ago. Changed comment, review round 9 of PR #63 (B3): it named the container
  // of the first tick as the reason the record in the future was not forgotten then; the reason is that at the first
  // tick SOURCE's record is one day old (it stays) and, by the times as the rules see them (R6-1: the record in the
  // future counts as of now), earlier, so the record in the future is not forgotten then.
  it('still removes a superseded record of an environment whose forgotten record was not removed', async () => {
    const DAY = 24 * 60 * MINUTE;
    const THIRD = '1'.repeat(32);
    let clock = T0 - 8 * DAY;
    let listed: DockerResult = { code: 0, stdout: `${'c'.repeat(64)}\texited\tdevenv-b\t${B}\t\n`, stderr: '' };
    writeRecord(SOURCE, B, { at: T0 - 9 * DAY, keepRunning: false, limitSeconds: 600 });
    writeRecord(OTHER, B, { at: T0 + 6 * DAY, keepRunning: false, limitSeconds: 600 });
    const attempts: string[] = [];
    const remove = async (record: RemoteRecord) => {
      attempts.push(record.source);
      if (record.source === SOURCE) throw new Error('locked');
      return removeRecord(heartbeatDir(stateDir), record.source, record.environmentId, record.at);
    };
    const loop = new RemoteMonitorLoop({ docker: async () => listed, removeRecord: remove, dir: heartbeatDir(stateDir), lockEnvironment: lockAlways, now: () => clock, log: (message) => lines.push(message) });
    await loop.tick();
    await loop.removals;
    expect(attempts).toEqual([]);
    // Eight days later the environment has no container any more, and another computer sent a heartbeat a day ago: the
    // record of SOURCE is forgotten, the one in the future (first seen more than 7 days ago) superseded.
    listed = { code: 0, stdout: '', stderr: '' };
    writeRecord(THIRD, B, { at: T0 - DAY, keepRunning: false, limitSeconds: 600 });
    clock = T0;
    await loop.tick();
    await loop.removals;
    expect(attempts).toEqual([SOURCE, OTHER]);
    expect(lines).toContain(`The old record of ${B} could not be removed: locked`);
    expect(lines).toContain(`Removed the old record of ${B} (a newer record of it exists).`);
    expect(recordFiles()).toEqual([heartbeatFileName(SOURCE, B), heartbeatFileName(THIRD, B)].sort());
  });

  // Review round 6 of PR #63 (R6-3): a record that a pass skips (an older one of its environment was not removed) keeps
  // its logged failure, so it is logged once across that pass.
  // Changed test, review round 7 of PR #63 (R7-2): was three passes with results [true, false, true] (failure logged,
  // skipped, failure again); now four passes, [false, true, false, true]: skipped before the first failure (nothing to
  // keep), failure logged, skipped (keeps it), failure again not logged. So both keeping the logged failure of a skipped
  // record and keeping only a logged one are checked.
  it('logs a failed removal once across a pass that skipped it', async () => {
    const results: boolean[] = [false, true, false, true];
    const removeRecord = async (record: RemoteRecord) => {
      if (record.source === OTHER) return results.shift() ?? true;
      throw new Error('locked');
    };
    const loop = new RemoteMonitorLoop({ docker: async () => ps, removeRecord, dir: heartbeatDir(stateDir), lockEnvironment: lockAlways, now: () => T0, log: (message) => lines.push(message) });
    writeRecord(OTHER, B, { at: T0 - 9 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    writeRecord(SOURCE, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    for (let pass = 0; pass < 4; pass++) {
      await loop.tick();
      await loop.removals;
    }
    expect(results).toEqual([]);
    expect(lines.filter((line) => line.includes('could not be removed'))).toHaveLength(1);
  });

  // Changed test, review round 4 of PR #63 (N4-1: R3-9 reverted): was "removes a file without a valid record whose
  // modification time is more than 7 days from now". Such a file may hold a record in a newer format of a running
  // environment (monitors of different versions on one engine): it is kept, whatever its age and environment.
  it('keeps a file without a valid record, also one older than 7 days of a running environment', async () => {
    const dir = heartbeatDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    const files = [heartbeatFileName(SOURCE, A), heartbeatFileName(OTHER, A), heartbeatFileName(SOURCE, B), heartbeatFileName(OTHER, B)];
    for (const [index, name] of files.entries()) {
      const file = path.join(dir, name);
      // Review round 5 of PR #63 (R5-3): a file holds a record in an incompatible format (was a cut one, now the second
      // file); the others are corrupt. Changed fixture, review round 6 of PR #63 (R6-5): was the first file, with `at` T0;
      // now the third, of B (no container) and older than 7 days, so it would be removed if it counted as a record.
      const texts = ['not a record', JSON.stringify({ at: T0, keepRunning: false, limitSeconds: 600, seq: 0, format: 2 }).slice(0, -1), JSON.stringify({ at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600, seq: 'x' })];
      fs.writeFileSync(file, texts[index] ?? 'not a record');
      const time = (T0 + (index % 2 === 0 ? -8 : 8) * 24 * 60 * MINUTE) / 1000;
      fs.utimesSync(file, time, time);
    }
    for (let time = T0; time <= T0 + REMOTE_GRACE_MS + REMOTE_TICK_MS; time += REMOTE_TICK_MS) expect(await tickAt(time)).toEqual([]);
    expect(calls.filter((call) => call[0] === 'forget' || call[0] === 'stop')).toEqual([]);
    expect(recordFiles()).toEqual([...files].sort());
    expect(lines.filter((line) => line.startsWith('Removed'))).toEqual([]);
  });

  // Changed test, review round 4 of PR #63 (N4-1: R3-9 reverted): was "keeps a valid record that a heartbeat wrote over a
  // file without a valid record" (the race of the removal with the `at` 0, which is gone). Only a valid record is removed:
  // once a heartbeat wrote one over such a file, it is handled like any record.
  it('removes a file without a valid record only after it holds a valid old record', async () => {
    const file = path.join(heartbeatDir(stateDir), heartbeatFileName(SOURCE, B));
    fs.mkdirSync(heartbeatDir(stateDir), { recursive: true });
    fs.writeFileSync(file, 'not a record');
    fs.utimesSync(file, (T0 - 8 * 24 * 60 * MINUTE) / 1000, (T0 - 8 * 24 * 60 * MINUTE) / 1000);
    await tickAt(T0);
    expect(calls.filter((call) => call[0] === 'forget')).toEqual([]);
    writeRecord(SOURCE, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    await tickAt(T0 + REMOTE_TICK_MS);
    expect(calls.filter((call) => call[0] === 'forget')).toEqual([['forget', SOURCE, B, String(T0 - 8 * 24 * 60 * MINUTE)]]);
    expect(recordFiles()).toEqual([]);
  });
});

// Review round 2 of PR #63 (R2-4): the removal of the loop, `forget <source> <env id> <at>` under the lock of the records
// (with the real script and `flock` in heartbeatLock.test.ts).
// Plan step 8, PR B (user decision D2 of 2026-09-30): each automatic stop of the monitor takes the lock of its
// environment without waiting; a busy or unopenable lock skips the environment; under the lock the monitor reads the
// containers and records of it again and decides again.
describe('RemoteMonitorLoop: the environment lock of a stop (plan step 8 PR B, D2)', () => {
  let now: number;
  let lines: string[];
  let events: string[];
  let ps: DockerResult;
  let attempts: Array<() => StopLockAttempt>;
  let onLocked: (() => void) | undefined;
  let stopFails: Error | undefined;
  let loop: RemoteMonitorLoop;

  const locked = (): StopLockAttempt => ({ kind: 'locked', release: () => events.push('release') });

  beforeEach(() => {
    now = T0;
    lines = [];
    events = [];
    attempts = [];
    onLocked = undefined;
    stopFails = undefined;
    ps = { code: 0, stdout: `${DB_ID}\trunning\tdevenv-api-db-1\t${A}\tdb\n${DEV_ID}\trunning\tdevenv-api\t${A}\t\n`, stderr: '' };
    loop = new RemoteMonitorLoop({
      docker: async (args) => {
        if (args[0] === 'ps') {
          const filter = args[args.indexOf('--filter') + 1];
          events.push(filter === 'label=nimblescape.devenv.environment-id' ? 'ps' : `ps ${filter}`);
          return ps;
        }
        events.push(`${args[0]} ${args[1]}`);
        if (stopFails) throw stopFails;
        return { code: 0, stdout: '', stderr: '' };
      },
      removeRecord: async () => false,
      dir: heartbeatDir(stateDir),
      now: () => now,
      log: (message) => lines.push(message),
      lockEnvironment: async (environmentId) => {
        events.push(`lock ${environmentId}`);
        const attempt = (attempts.shift() ?? locked)();
        if (attempt.kind === 'locked') onLocked?.();
        return attempt;
      },
    });
  });

  /** Ticks through the grace of the start; the next tick wants to stop A. */
  async function pastGrace(): Promise<void> {
    writeRecord(SOURCE, A, { at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600 });
    for (let time = T0; time < T0 + REMOTE_GRACE_MS; time += REMOTE_TICK_MS) {
      now = time;
      expect(await loop.tick()).toEqual([]);
    }
    events = [];
  }

  async function tickAt(time: number): Promise<string[]> {
    now = time;
    const stopped = await loop.tick();
    await loop.removals;
    return stopped;
  }

  it('locks, lists the containers of the environment again, stops the dev container first, then releases', async () => {
    await pastGrace();
    expect(await tickAt(T0 + REMOTE_GRACE_MS)).toEqual([A]);
    expect(events).toEqual(['ps', `lock ${A}`, `ps label=nimblescape.devenv.environment-id=${A}`, `stop ${DEV_ID}`, `stop ${DB_ID}`, 'release']);
  });

  it('a busy lock: no stop in this tick, logged once per busy streak; a free lock at a later tick stops it', async () => {
    await pastGrace();
    attempts = [() => ({ kind: 'busy' }), () => ({ kind: 'busy' }), () => ({ kind: 'busy' })];
    for (let i = 0; i < 3; i += 1) expect(await tickAt(T0 + REMOTE_GRACE_MS + i * REMOTE_TICK_MS)).toEqual([]);
    expect(events.filter((event) => event.startsWith('stop') || event.startsWith('ps label'))).toEqual([]);
    expect(lines.filter((line) => line.includes('is busy with an operation'))).toEqual([
      `${A} is busy with an operation; it is not stopped now and is checked again at the next tick.`,
    ]);
    expect(await tickAt(T0 + REMOTE_GRACE_MS + 3 * REMOTE_TICK_MS)).toEqual([A]);
    // A new busy streak is logged again.
    attempts = [() => ({ kind: 'busy' })];
    expect(await tickAt(T0 + REMOTE_GRACE_MS + 4 * REMOTE_TICK_MS)).toEqual([]);
    expect(lines.filter((line) => line.includes('is busy with an operation'))).toHaveLength(2);
  });

  it('a heartbeat that arrives before the lock is taken: decided again under the lock, no stop, released', async () => {
    await pastGrace();
    onLocked = () => writeRecord(OTHER, A, { at: T0 + REMOTE_GRACE_MS, keepRunning: false, limitSeconds: 600 });
    expect(await tickAt(T0 + REMOTE_GRACE_MS)).toEqual([]);
    expect(events).toEqual(['ps', `lock ${A}`, `ps label=nimblescape.devenv.environment-id=${A}`, 'release']);
    expect(lines).toContain(`${A} is not stopped: a heartbeat or another change came before its lock was taken.`);
  });

  it('a keep that arrives before the lock is taken: no stop', async () => {
    await pastGrace();
    onLocked = () => writeRecord(SOURCE, A, { at: T0 + REMOTE_GRACE_MS, keepRunning: true, limitSeconds: 600 });
    expect(await tickAt(T0 + REMOTE_GRACE_MS)).toEqual([]);
    expect(events.filter((event) => event.startsWith('stop'))).toEqual([]);
    expect(events.at(-1)).toBe('release');
  });

  it('containers that stopped before the lock was taken: nothing to stop, released', async () => {
    await pastGrace();
    onLocked = () => (ps = { code: 0, stdout: `${DEV_ID}\texited\tdevenv-api\t${A}\t\n`, stderr: '' });
    expect(await tickAt(T0 + REMOTE_GRACE_MS)).toEqual([]);
    expect(events.filter((event) => event.startsWith('stop'))).toEqual([]);
    expect(events.at(-1)).toBe('release');
  });

  it('releases the lock after a failed list, records that cannot be read, or a stop that throws', async () => {
    await pastGrace();
    onLocked = () => (ps = { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' });
    expect(await tickAt(T0 + REMOTE_GRACE_MS)).toEqual([]);
    expect(events).toEqual(['ps', `lock ${A}`, `ps label=nimblescape.devenv.environment-id=${A}`, 'release']);
    expect(lines.some((line) => line.startsWith(`${A} is not stopped: its containers could not be listed again.`))).toBe(true);

    ps = { code: 0, stdout: `${DEV_ID}\trunning\tdevenv-api\t${A}\t\n`, stderr: '' };
    onLocked = undefined;
    stopFails = new Error('the Docker CLI broke');
    events = [];
    expect(await tickAt(T0 + REMOTE_GRACE_MS + REMOTE_TICK_MS)).toEqual([]);
    expect(events).toEqual(['ps', `lock ${A}`, `ps label=nimblescape.devenv.environment-id=${A}`, `stop ${DEV_ID}`, 'release']);
    expect(lines).toContain(`${A} is not stopped: the Docker CLI broke`);

    // The records folder is replaced by a file under the lock: readRecords fails.
    stopFails = undefined;
    events = [];
    onLocked = () => {
      fs.rmSync(heartbeatDir(stateDir), { recursive: true, force: true });
      fs.writeFileSync(heartbeatDir(stateDir), 'not a folder');
    };
    expect(await tickAt(T0 + REMOTE_GRACE_MS + 2 * REMOTE_TICK_MS)).toEqual([]);
    expect(events).toEqual(['ps', `lock ${A}`, `ps label=nimblescape.devenv.environment-id=${A}`, 'release']);
  });

  it('a lock that cannot be opened or taken: no stop, logged once per streak', async () => {
    await pastGrace();
    attempts = [
      () => ({ kind: 'failed', detail: 'the lock file could not be opened: ELOOP' }),
      () => ({ kind: 'failed', detail: 'the lock file could not be opened: ELOOP' }),
    ];
    expect(await tickAt(T0 + REMOTE_GRACE_MS)).toEqual([]);
    expect(await tickAt(T0 + REMOTE_GRACE_MS + REMOTE_TICK_MS)).toEqual([]);
    expect(events.filter((event) => event.startsWith('stop') || event.startsWith('ps label'))).toEqual([]);
    expect(lines.filter((line) => line.startsWith(`The lock of ${A} could not be taken; it is not stopped.`))).toEqual([
      `The lock of ${A} could not be taken; it is not stopped. the lock file could not be opened: ELOOP`,
    ]);
  });

  // Review round 1 of PR #86, B-R1-3 (mutant A20c): an environment that is no longer to be stopped under its lock ends
  // only its own stop; the next environment of the tick is still stopped, and the removal pass of the tick starts.
  it('an environment decided again to "no stop" does not end the tick: the next one is stopped, the removals start (review round 1 of PR #86, B-R1-3)', async () => {
    const OTHER_DEV = 'c'.repeat(64);
    ps = { code: 0, stdout: `${DEV_ID}\trunning\tdevenv-api\t${A}\t\n${OTHER_DEV}\trunning\tdevenv-web\t${B}\t\n`, stderr: '' };
    writeRecord(SOURCE, B, { at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600 });
    // An old record of an environment without any container: `forget` of the tick.
    const C = '00000000-0000-4000-8000-00000000000c';
    writeRecord(SOURCE, C, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    await pastGrace();
    let first = true;
    onLocked = () => {
      if (first) writeRecord(OTHER, A, { at: T0 + REMOTE_GRACE_MS, keepRunning: false, limitSeconds: 600 });
      first = false;
    };
    now = T0 + REMOTE_GRACE_MS;
    expect(await loop.tick()).toEqual([B]);
    expect(loop.removals).toBeDefined();
    await loop.removals;
    expect(events).toEqual([
      'ps',
      `lock ${A}`,
      `ps label=nimblescape.devenv.environment-id=${A}`,
      'release',
      `lock ${B}`,
      `ps label=nimblescape.devenv.environment-id=${B}`,
      `stop ${OTHER_DEV}`,
      'release',
    ]);
  });

  // Review round 1 of PR #86, B-R1-5 (mutant A11): the decision under the lock takes the time since the start of the tick
  // as no pause, so a clock that moved past the gap meanwhile (a long lock, a slow list) does not hold the stop.
  it('a clock that moved past the gap between the list of the tick and the lock still stops (review round 1 of PR #86, B-R1-5)', async () => {
    await pastGrace();
    onLocked = () => (now += 2 * REMOTE_GAP_MS);
    expect(await tickAt(T0 + REMOTE_GRACE_MS)).toEqual([A]);
    expect(events).toEqual(['ps', `lock ${A}`, `ps label=nimblescape.devenv.environment-id=${A}`, `stop ${DEV_ID}`, `stop ${DB_ID}`, 'release']);
  });
});

// Review round 1 of PR #86, B-R1-1 (mutant A41): `run` without an injected lock takes the lock files of the volume
// (deps.stateDir, as the workers open them), not a folder of the records; a lock that a worker holds keeps the stop.
describe('monitor.js run: the lock files of the volume (review round 1 of PR #86, B-R1-1)', () => {
  const holders: ChildProcess[] = [];

  afterEach(() => {
    for (const holder of holders) {
      if (holder.exitCode === null && holder.signalCode === null) {
        try {
          process.kill(-(holder.pid as number), 'SIGKILL');
        } catch {
          // Gone already.
        }
      }
    }
    holders.length = 0;
  });

  it('does not stop an environment whose lock file in stateDir another process holds', { timeout: 30_000 }, async () => {
    fs.mkdirSync(lockFolder(stateDir), { recursive: true, mode: 0o700 });
    const marker = path.join(stateDir, 'held');
    const holder = spawn('flock', [lockFilePath(A, stateDir), 'sh', '-c', `touch '${marker}'; exec sleep 60`], { detached: true, stdio: 'ignore' });
    holders.push(holder);
    while (!fs.existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 10));
    writeRecord(SOURCE, A, { at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600 });
    let mono = 0;
    let ticks = 0;
    let out = '';
    const dockerCalls: string[] = [];
    void main(['run'], {
      env: {},
      stateDir,
      docker: async (args) => {
        if (args[0] === 'ps') return { code: 0, stdout: `${DEV_ID}\trunning\tdevenv-api\t${A}\t\n`, stderr: '' };
        dockerCalls.push(`${args[0]} ${args[1]}`);
        return { code: 0, stdout: '', stderr: '' };
      },
      exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
      monotonic: () => mono,
      now: () => T0 + mono,
      sleep: async (ms) => {
        ticks += 1;
        mono += ms;
        // Past the grace of the start (8 ticks), a few ticks that want to stop it; then it waits for ever.
        if (ticks >= 12) await new Promise(() => {});
      },
      out: (text) => (out += text),
    });
    await vi.waitFor(() => expect(ticks).toBe(12), { timeout: 20_000 });
    expect(out).toContain(`${A} is busy with an operation; it is not stopped now and is checked again at the next tick.`);
    expect(dockerCalls).toEqual([]);
  });
});

// Plan step 8, PR B (user decision Q5 of 2026-10-02): `run` ends with 0 after REMOTE_IDLE_EXIT_MS without a running
// environment container while it maintains no images, between two ticks only.
describe('monitor.js run: the exit when idle (plan step 8 PR B, Q5)', () => {
  interface Monitor {
    result: Promise<number>;
    out: () => string;
    events: string[];
    ticks: () => number;
    mono: () => number;
  }

  /** `run` with a clock that the waits between the ticks move; `ps` gives the containers of each tick. */
  function startRun(options: {
    env?: NodeJS.ProcessEnv;
    ps: () => DockerResult;
    onStop?: () => void;
    stopMs?: number;
    lock?: () => StopLockAttempt;
    exec?: ExecFile;
    maxTicks?: number;
  }): Monitor {
    let mono = 0;
    let ticks = 0;
    let out = '';
    const events: string[] = [];
    const result = main(['run'], {
      env: options.env ?? {},
      stateDir,
      docker: async (args) => {
        if (args[0] === 'ps') return options.ps();
        events.push(`${args[0]} ${args[1]}`);
        mono += options.stopMs ?? 0;
        options.onStop?.();
        return { code: 0, stdout: '', stderr: '' };
      },
      exec: options.exec ?? ((_file, _args, _options, callback) => callback(null, 'removed\n', '')),
      lockEnvironment: async (id) => {
        events.push(`lock ${id}`);
        return options.lock?.() ?? { kind: 'locked', release: () => events.push('release') };
      },
      monotonic: () => mono,
      now: () => T0 + mono,
      sleep: async (ms) => {
        ticks += 1;
        mono += ms;
        if (ticks >= (options.maxTicks ?? 1_000)) await new Promise(() => {});
      },
      out: (text) => {
        out += text;
        if (text.includes('Session Monitor exits')) events.push('exit');
      },
    });
    return { result, out: () => out, events, ticks: () => ticks, mono: () => mono };
  }

  const listed = (stdout: string): DockerResult => ({ code: 0, stdout, stderr: '' });
  const pending = async (promise: Promise<unknown>) =>
    (await Promise.race([promise.then(() => 'ended'), new Promise((resolve) => setTimeout(() => resolve('pending'), 200))])) as string;

  it('the idle time is 5 minutes; the Docker tests can set another', () => {
    expect(REMOTE_IDLE_EXIT_MS).toBe(5 * 60_000);
    expect(idleExitFromEnv({})).toBe(REMOTE_IDLE_EXIT_MS);
    expect(idleExitFromEnv({ DEVENV_MONITOR_IDLE_MS: '3000' })).toBe(3000);
    expect(idleExitFromEnv({ DEVENV_MONITOR_IDLE_MS: '99' })).toBe(REMOTE_IDLE_EXIT_MS);
    expect(idleExitFromEnv({ DEVENV_MONITOR_IDLE_MS: '-1' })).toBe(REMOTE_IDLE_EXIT_MS);
    expect(idleExitFromEnv({ DEVENV_MONITOR_IDLE_MS: '99999999' })).toBe(REMOTE_IDLE_EXIT_MS);
  });

  it('exits with 0 after the idle time without a labelled container and with image updates off; the records stay', async () => {
    writeRecord(SOURCE, A, { at: T0, keepRunning: false, limitSeconds: 600 });
    const monitor = startRun({ ps: () => listed('') });
    expect(await monitor.result).toBe(0);
    // Changed expectation, review round 1 of PR #86, A-R1-1: the fresh record (10 minutes) counts as activity, so the
    // idle time starts when it aged past its limit (was: the idle time from the start of the loop).
    expect(monitor.mono()).toBeGreaterThanOrEqual(10 * MINUTE + REMOTE_IDLE_EXIT_MS);
    expect(monitor.mono()).toBeLessThan(10 * MINUTE + REMOTE_IDLE_EXIT_MS + 2 * REMOTE_TICK_MS);
    // Changed expectation, review round 1 of PR #86, A-R1-1: the text names the fresh heartbeats (was "No environment
    // container ran for 300 s and image updates are off; …").
    expect(monitor.out()).toContain('No environment container ran and no heartbeat was fresh for 300 s, and image updates are off; the Session Monitor exits.');
    expect(recordFiles()).toEqual([heartbeatFileName(SOURCE, A)]);
  });

  // Review round 1 of PR #86, A-R1-1: an open writes its first heartbeat, then clones and builds for longer than the idle
  // time before its container exists; the heartbeats of its window (its busy mark) keep the monitor.
  it('does not exit without a running container while a record is fresh (review round 1 of PR #86, A-R1-1)', async () => {
    writeRecord(SOURCE, A, { at: T0, keepRunning: false, limitSeconds: 600 });
    let monitor: Monitor | undefined = undefined;
    // The window refreshes the record every 30 s (as WindowHeartbeats), here every tick.
    monitor = startRun({
      ps: () => {
        if (monitor !== undefined) writeRecord(SOURCE, A, { at: T0 + monitor.mono(), keepRunning: false, limitSeconds: 600 });
        return listed('');
      },
      maxTicks: 200,
    });
    await vi.waitFor(() => expect(monitor!.ticks()).toBe(200));
    // 200 ticks of 15 s: 50 minutes, ten times the idle time.
    expect(monitor.mono()).toBeGreaterThanOrEqual(10 * REMOTE_IDLE_EXIT_MS);
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.out()).not.toContain('exits');
  });

  it('exits once the record aged past its limit (review round 1 of PR #86, A-R1-1)', async () => {
    // Aged past its limit (1 minute) at the start: only the idle time counts.
    writeRecord(SOURCE, A, { at: T0 - 2 * MINUTE, keepRunning: false, limitSeconds: 60 });
    const monitor = startRun({ ps: () => listed('') });
    expect(await monitor.result).toBe(0);
    expect(monitor.mono()).toBeLessThan(REMOTE_IDLE_EXIT_MS + 2 * REMOTE_TICK_MS);
    // A record that is fresh at the start keeps it until its limit has passed, then the idle time.
    writeRecord(SOURCE, B, { at: T0, keepRunning: false, limitSeconds: 120 });
    const later = startRun({ ps: () => listed('') });
    expect(await later.result).toBe(0);
    expect(later.mono()).toBeGreaterThanOrEqual(2 * MINUTE + REMOTE_IDLE_EXIT_MS);
    expect(later.mono()).toBeLessThan(2 * MINUTE + REMOTE_IDLE_EXIT_MS + 2 * REMOTE_TICK_MS);
  });

  // Changed expectation, review round 2 of PR #86, A-R2-1 (was: it did not exit while a labelled container was created):
  // a failed start after `up` (or a Compose service whose dependency never becomes healthy) leaves a container `created`
  // for ever; with only stale records the monitor exits after the idle time.
  it('exits for a lone created container with only stale records (review round 2 of PR #86, A-R2-1)', async () => {
    writeRecord(SOURCE, A, { at: T0 - 2 * MINUTE, keepRunning: false, limitSeconds: 60 });
    const monitor = startRun({ ps: () => listed(`${DEV_ID}\tcreated\tdevenv-api\t${A}\t\n`) });
    expect(await monitor.result).toBe(0);
    expect(monitor.mono()).toBeGreaterThanOrEqual(REMOTE_IDLE_EXIT_MS);
    expect(monitor.mono()).toBeLessThan(REMOTE_IDLE_EXIT_MS + 2 * REMOTE_TICK_MS);
    // Without any record too.
    const bare = startRun({ ps: () => listed(`${DEV_ID}\tcreated\tdevenv-api\t${B}\t\n`) });
    expect(await bare.result).toBe(0);
    expect(bare.mono()).toBeLessThan(REMOTE_IDLE_EXIT_MS + 2 * REMOTE_TICK_MS);
  });

  // Changed expectation, review round 2 of PR #86, A-R2-1 (was: an old keep with a created container kept the monitor):
  // an old keep counts only through a container of it that runs.
  it('exits for an old keep whose environment has only a created container; a running one keeps it (review round 2 of PR #86, A-R2-1)', async () => {
    writeRecord(SOURCE, A, { at: T0 - 60 * MINUTE, keepRunning: true, limitSeconds: 60 });
    const monitor = startRun({ ps: () => listed(`${DEV_ID}\tcreated\tdevenv-api\t${A}\t\n`) });
    expect(await monitor.result).toBe(0);
    expect(monitor.mono()).toBeLessThan(REMOTE_IDLE_EXIT_MS + 2 * REMOTE_TICK_MS);
    // A running one keeps it (running counts on its own).
    const running = startRun({ ps: () => listed(`${DEV_ID}\trunning\tdevenv-api\t${A}\t\n`), maxTicks: 100 });
    await vi.waitFor(() => expect(running.ticks()).toBe(100));
    expect(await pending(running.result)).toBe('pending');
  });

  it('exits for an old keep whose environment has only ended containers (review round 1 of PR #86, A-R1-1)', async () => {
    // Keep Running When Closed stays in the records after a Stop: it must not keep the monitor for ever.
    writeRecord(SOURCE, A, { at: T0 - 60 * MINUTE, keepRunning: true, limitSeconds: 60 });
    const monitor = startRun({ ps: () => listed(`${DEV_ID}\texited\tdevenv-api\t${A}\t\n`) });
    expect(await monitor.result).toBe(0);
    expect(monitor.mono()).toBeLessThan(REMOTE_IDLE_EXIT_MS + 2 * REMOTE_TICK_MS);
  });

  // Review round 1 of PR #86, A-R1-1 (third verifier): an open that failed after its container started leaves it running
  // and no window sends heartbeats; the monitor must stop it after the limit of its record, not exit before.
  it('stops a running container whose record aged past its limit, and exits only after that (review round 1 of PR #86, A-R1-1)', async () => {
    writeRecord(SOURCE, A, { at: T0, keepRunning: false, limitSeconds: 600 });
    let running = true;
    const monitor = startRun({
      ps: () => listed(running ? `${DEV_ID}\trunning\tdevenv-api\t${A}\t\n` : ''),
      onStop: () => (running = false),
    });
    expect(await monitor.result).toBe(0);
    expect(monitor.events).toEqual([`lock ${A}`, `stop ${DEV_ID}`, 'release', 'exit']);
    expect(monitor.out()).toContain(`Stopping the container devenv-api of ${A}: no computer sent a heartbeat`);
    // The stop came after the limit of the record (10 minutes), the exit the idle time after the stop.
    expect(monitor.mono()).toBeGreaterThanOrEqual(10 * MINUTE + REMOTE_IDLE_EXIT_MS);
  });

  it('exits with 0 also when only stopped labelled containers exist', async () => {
    const monitor = startRun({ ps: () => listed(`${DEV_ID}\texited\tdevenv-api\t${A}\t\n`) });
    expect(await monitor.result).toBe(0);
  });

  it('does not exit while a labelled container runs, also one that a record keeps running', async () => {
    writeRecord(SOURCE, A, { at: T0, keepRunning: true, limitSeconds: 600 });
    const monitor = startRun({ ps: () => listed(`${DEV_ID}\trunning\tdevenv-api\t${A}\t\n`), maxTicks: 100 });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(100));
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.out()).not.toContain('exits');
  });

  it('does not exit while a labelled container runs and the records cannot be read', async () => {
    fs.writeFileSync(heartbeatDir(stateDir), 'not a folder');
    const monitor = startRun({ ps: () => listed(`${DEV_ID}\trunning\tdevenv-api\t${A}\t\n`), maxTicks: 100 });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(100));
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.out()).toContain('The heartbeat records could not be read');
  });

  // Review round 1 of PR #86, B-R1-2 (mutant A25b): paused and restarting containers count as running.
  it('does not exit while a labelled container is paused or restarting (review round 1 of PR #86, B-R1-2)', async () => {
    for (const state of ['paused', 'restarting']) {
      const monitor = startRun({ ps: () => listed(`${DEV_ID}\t${state}\tdevenv-api\t${A}\t\n`), maxTicks: 100 });
      await vi.waitFor(() => expect(monitor.ticks()).toBe(100));
      expect(monitor.mono()).toBeGreaterThan(REMOTE_IDLE_EXIT_MS);
      expect(await pending(monitor.result)).toBe('pending');
      expect(monitor.out()).not.toContain('exits');
    }
  });

  // Review round 1 of PR #86, B-R1-6 (mutants A37, A40): the bounds of DEVENV_MONITOR_IDLE_MS, and `run` uses it.
  it('takes DEVENV_MONITOR_IDLE_MS from 100 ms on, and `run` exits after it (review round 1 of PR #86, B-R1-6)', async () => {
    expect(idleExitFromEnv({ DEVENV_MONITOR_IDLE_MS: '000' })).toBe(REMOTE_IDLE_EXIT_MS);
    expect(idleExitFromEnv({ DEVENV_MONITOR_IDLE_MS: '099' })).toBe(REMOTE_IDLE_EXIT_MS);
    expect(idleExitFromEnv({ DEVENV_MONITOR_IDLE_MS: '100' })).toBe(100);
    const monitor = startRun({ env: { DEVENV_MONITOR_IDLE_MS: '1000' }, ps: () => listed('') });
    expect(await monitor.result).toBe(0);
    // The first tick at 0 ms is not idle long enough; the one after the wait of one tick is.
    expect(monitor.mono()).toBe(REMOTE_TICK_MS);
    expect(monitor.out()).toContain('no heartbeat was fresh for 1 s');
  });

  it('does not exit while Docker does not answer', async () => {
    const monitor = startRun({ ps: () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }), maxTicks: 100 });
    await vi.waitFor(() => expect(monitor.ticks()).toBe(100));
    expect(await pending(monitor.result)).toBe('pending');
  });

  it('does not exit with image updates on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    try {
      const monitor = startRun({ env: { DEVENV_IMAGE_PREFIXES: JSON.stringify(['ghcr.io/example/']) }, ps: () => listed(''), maxTicks: 100 });
      await vi.waitFor(() => expect(monitor.ticks()).toBe(100));
      expect(monitor.out()).not.toContain('exits');
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the idle time from the end of the last stop, and exits only after the release', async () => {
    writeRecord(SOURCE, A, { at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600 });
    let running = true;
    // The `docker stop` takes 4 minutes; after it the container is gone.
    const monitor = startRun({
      ps: () => listed(running ? `${DEV_ID}\trunning\tdevenv-api\t${A}\t\n` : ''),
      stopMs: 4 * MINUTE,
      onStop: () => (running = false),
    });
    expect(await monitor.result).toBe(0);
    expect(monitor.events).toEqual([`lock ${A}`, `stop ${DEV_ID}`, 'release', 'exit']);
    // The grace of the start (2 minutes), the stop (4 minutes), then 5 minutes idle.
    expect(monitor.mono()).toBeGreaterThanOrEqual(REMOTE_GRACE_MS + 4 * MINUTE + REMOTE_IDLE_EXIT_MS);
  });

  it('waits for a removal of a record that runs before it exits', async () => {
    writeRecord(SOURCE, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    let finishRemoval: (() => void) | undefined;
    const monitor = startRun({
      env: { DEVENV_MONITOR_IDLE_MS: '1000' },
      ps: () => listed(''),
      exec: (_file, _args, _options, callback) => {
        finishRemoval = () => callback(null, 'removed\n', '');
      },
    });
    await vi.waitFor(() => expect(finishRemoval).toBeDefined());
    expect(await pending(monitor.result)).toBe('pending');
    expect(monitor.out()).not.toContain('exits');
    finishRemoval!();
    expect(await monitor.result).toBe(0);
    expect(monitor.out().indexOf(`Removed the old record of ${B}`)).toBeLessThan(monitor.out().indexOf('the Session Monitor exits'));
  });
});

describe('recordRemover', () => {
  const old: RemoteRecord = { source: SOURCE, environmentId: B, at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 };
  type Result = Parameters<Parameters<ExecFile>[3]>;
  function remover(...result: Result): { remove: ReturnType<typeof recordRemover>; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const remove = recordRemover((file, args, options, callback) => {
      calls.push([file, args, options]);
      callback(...result);
    });
    return { remove, calls };
  }

  it('runs forgetIfUnchangedCommand with a time limit, and says whether the script removed the record', async () => {
    const removed = remover(null, 'removed\n', '');
    expect(await removed.remove(old)).toBe(true);
    const [file, ...args] = forgetIfUnchangedCommand(SOURCE, B, old.at);
    expect(removed.calls).toEqual([[file, args, { timeout: 20_000, windowsHide: true }]]);
    expect(await remover(null, '', '').remove(old)).toBe(false);
  });

  it('rejects with the reason of a failure', async () => {
    await expect(remover({ code: RECORDS_LOCK_BUSY_EXIT, message: 'Command failed' }, '', '').remove(old)).rejects.toThrow('the heartbeat records stayed locked by another command');
    await expect(remover({ code: 1, message: 'Command failed' }, '', 'broken\n').remove(old)).rejects.toThrow(/^broken$/);
    // Review round 2 of PR #63 (R2-2): not "exit code null".
    await expect(remover({ code: null, killed: true, message: 'Command failed' }, '', '').remove(old)).rejects.toThrow('no answer within 20 s');
    await expect(remover({ code: 'ENOENT', message: 'spawn flock ENOENT' }, '', '').remove(old)).rejects.toThrow(/^spawn flock ENOENT$/);
    // Review round 3 of PR #63 (R3-2): the timeout kills only `flock`, whose child may still remove the record; a kill by
    // another signal is named.
    await expect(remover({ code: null, killed: true, signal: 'SIGTERM', message: 'Command failed' }, '', '').remove(old)).rejects.toThrow(/^no answer within 20 s \(it may still end\)$/);
    await expect(remover({ code: null, killed: false, signal: 'SIGKILL', message: 'Command failed' }, '', '').remove(old)).rejects.toThrow(/^killed by SIGKILL$/);
  });

  // Review round 9 of PR #63 (B2): also the removal of the leftover temporary files of the volume at the start of `run`.
  it('is the removal of `run`', async () => {
    vi.useFakeTimers();
    try {
      writeRecord(SOURCE, B, { at: old.at, keepRunning: false, limitSeconds: 600 });
      const leftover = (name: string, mtime: number) => {
        fs.writeFileSync(path.join(stateDir, name), 'x');
        fs.utimesSync(path.join(stateDir, name), mtime / 1000, mtime / 1000);
      };
      leftover('images.json.1.1.tmp', T0 - 2 * 60 * MINUTE);
      leftover('images.json.1.2.tmp', T0);
      let out = '';
      const called = new Promise<unknown[]>((resolve) => {
        void main(['run'], {
          env: {},
          stateDir,
          docker: async () => ({ code: 0, stdout: '', stderr: '' }),
          exec: (file, args, _options, callback) => {
            resolve([file, ...args]);
            callback(null, 'removed\n', '');
          },
          now: () => T0,
          out: (text) => (out += text),
        });
      });
      expect(await called).toEqual(forgetIfUnchangedCommand(SOURCE, B, old.at));
      await vi.waitFor(() => expect(out).toContain(`Removed the old record of ${B} (no container of it exists).`));
      expect(out).toContain('Removed 1 leftover temporary file(s) of the volume.');
      // Plan step 3 (pipe loading): the line that the extension waits for after `docker run`.
      expect(out).toMatch(new RegExp(`^\\S+ ${REMOTE_MONITOR_READY_TEXT} \\(Node\\.js `, 'm'));
      expect(fs.existsSync(path.join(stateDir, 'images.json.1.1.tmp'))).toBe(false);
      expect(fs.existsSync(path.join(stateDir, 'images.json.1.2.tmp'))).toBe(true);
    } finally {
      // The loop of `run` waits for a fake timer that never fires.
      vi.useRealTimers();
    }
  });
});

// Plan step 3 (pipe loading, user decisions 2026-09-29): the pipe loader of the container starts `startMonitor` (the
// loop); `docker exec … node /opt/devenv/monitor.js <subcommand>` runs the same entry with its arguments.
describe('startMonitor and runEntry', () => {
  function entryDeps(result: Promise<number>) {
    const signals = new Map<string, () => void>();
    const exits: number[] = [];
    const errors: string[] = [];
    const argvs: Array<readonly string[]> = [];
    const deps: EntryDeps = {
      onSignal: (signal, listener) => signals.set(signal, listener),
      exit: (code) => exits.push(code),
      err: (text) => errors.push(text),
      main: (argv) => {
        argvs.push(argv);
        return result;
      },
    };
    return { deps, signals, exits, errors, argvs };
  }

  it('is the entry that the loader starts', () => {
    expect(REMOTE_MONITOR_ENTRY).toBe('startMonitor');
    expect(typeof startMonitor).toBe('function');
  });

  it('startMonitor runs `run` whatever the input, with SIGTERM and SIGINT ending it with 0', () => {
    const { deps, signals, exits, argvs } = entryDeps(new Promise(() => {}));
    startMonitor('input after the script', deps);
    expect(argvs).toEqual([['run']]);
    expect([...signals.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    signals.get('SIGTERM')!();
    signals.get('SIGINT')!();
    expect(exits).toEqual([0, 0]);
  });

  it('runEntry ends the process with the exit code of the subcommand, or 1 after a failure', async () => {
    const done = entryDeps(Promise.resolve(2));
    await runEntry(['heartbeat', 'x'], done.deps);
    expect(done.argvs).toEqual([['heartbeat', 'x']]);
    expect(done.exits).toEqual([2]);
    const failed = entryDeps(Promise.reject(new Error('broken')));
    await runEntry(['run'], failed.deps);
    expect(failed.errors).toEqual(['broken\n']);
    expect(failed.exits).toEqual([1]);
  });
});

// Monitor cleanup, user decision 2026-09-29 (R4): the leftover temporary files of the state files, at the start of `run`.
describe('removeStaleStateTemporaryFiles', () => {
  const HOUR = 60 * MINUTE;
  function file(name: string, ageMs: number): void {
    const full = path.join(stateDir, name);
    fs.writeFileSync(full, 'x');
    const time = (T0 - ageMs) / 1000;
    fs.utimesSync(full, time, time);
  }

  it('removes the temporary files of images.json, image-settings.json and replaced-images.json older than an hour', async () => {
    file('images.json.12.1.tmp', HOUR + MINUTE);
    file('image-settings.json.7.3.tmp', 2 * HOUR);
    file('replaced-images.json.99.12.tmp', 24 * HOUR);
    file('images.json.12.2.tmp', HOUR - MINUTE);
    file('images.json', 48 * HOUR);
    file('other.json.12.1.tmp', 48 * HOUR);
    file('images.json.x.1.tmp', 48 * HOUR);
    // Review round 11 of PR #63 (B-R11-1): names that only resemble a temporary file (a prefix, a suffix, a count that
    // is not a number) are kept, so the pattern stays anchored and exact. The expected list below gained them.
    file('foo-images.json.1.1.tmp', 48 * HOUR);
    file('images.json.1.1.tmp.bak', 48 * HOUR);
    file('images.json.1.x.tmp', 48 * HOUR);
    const removed = await removeStaleStateTemporaryFiles(stateDir, T0);
    expect(removed.sort()).toEqual(['image-settings.json.7.3.tmp', 'images.json.12.1.tmp', 'replaced-images.json.99.12.tmp']);
    expect(fs.readdirSync(stateDir).sort()).toEqual([
      'foo-images.json.1.1.tmp',
      'images.json',
      'images.json.1.1.tmp.bak',
      'images.json.1.x.tmp',
      'images.json.12.2.tmp',
      'images.json.x.1.tmp',
      'other.json.12.1.tmp',
    ]);
  });

  it('never removes a folder or a link with such a name, nor what a link points to', async () => {
    const target = path.join(stateDir, 'target');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(stateDir, 'images.json.1.1.tmp'));
    fs.mkdirSync(path.join(stateDir, 'images.json.2.1.tmp'));
    // Changed fixture, review round 8 of PR #63 (R8-2): was the time of the test run for all three, with `now` T0 + 48
    // hours, so in a run within an hour of that time the age rule alone kept them; now they are 48 hours old at `now`
    // T0, so only the check of a regular file keeps them.
    const old = (T0 - 48 * HOUR) / 1000;
    fs.utimesSync(target, old, old);
    fs.lutimesSync(path.join(stateDir, 'images.json.1.1.tmp'), old, old);
    fs.utimesSync(path.join(stateDir, 'images.json.2.1.tmp'), old, old);
    expect(await removeStaleStateTemporaryFiles(stateDir, T0)).toEqual([]);
    expect(fs.readdirSync(stateDir).sort()).toEqual(['images.json.1.1.tmp', 'images.json.2.1.tmp', 'target']);
  });

  // Review round 1 of PR #63 (B4): the absolute age, so a file with a time in the future (a clock that was ahead) goes too.
  it('removes such a file whose modification time is more than an hour in the future', async () => {
    file('images.json.12.1.tmp', -2 * HOUR);
    expect(await removeStaleStateTemporaryFiles(stateDir, T0)).toEqual(['images.json.12.1.tmp']);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it('ignores a missing folder', async () => {
    expect(await removeStaleStateTemporaryFiles(path.join(stateDir, 'missing'), T0)).toEqual([]);
  });
});

// User request 2026-09-28 ("all images"): the list of repositories that the extension read from the registry.
describe('monitor.js images', () => {
  async function images(input: string): Promise<Run> {
    let out = '';
    let err = '';
    const code = await main(['images', '-'], {
      env: {},
      stateDir,
      readStdin: async () => input,
      out: (text) => (out += text),
      err: (text) => (err += text),
    });
    return { code, out, err };
  }

  it('stores a valid list, and readImageList gives it back', async () => {
    expect(await images(JSON.stringify({ repositories: ['ghcr.io/majikmate/devcontainer-dev', 'ghcr.io/majikmate/devcontainer-dev'] }))).toEqual({ code: 0, out: '', err: '' });
    expect(await readImageList(stateDir)).toEqual(['ghcr.io/majikmate/devcontainer-dev']);
  });

  it('refuses anything else and keeps the stored list', async () => {
    await images(JSON.stringify({ repositories: ['ghcr.io/a/b'] }));
    for (const input of ['not json', '{}', JSON.stringify({ repositories: ['UPPER/case'] }), JSON.stringify({ repositories: ['ghcr.io/a/b'], extra: 1 }), JSON.stringify({ repositories: ['ubuntu'] })]) {
      expect((await images(input)).code, input).toBe(EXIT_INVALID);
    }
    expect(await readImageList(stateDir)).toEqual(['ghcr.io/a/b']);
    expect((await main(['images'], { env: {}, stateDir, readStdin: async () => '{}', err: () => {} }))).toBe(EXIT_INVALID);
  });

  it('reads no list when none was stored', async () => {
    expect(await readImageList(stateDir)).toEqual([]);
  });

  // User request 2026-09-28: "1 minute after the monitor starts then in the morning again, at 6:07 CEST".
  it('passes one minute after the start, then by the schedule; the Docker tests can set a fixed interval', () => {
    expect(imageTimesFromEnv({})).toEqual({ firstMs: 60_000, intervalMs: undefined });
    expect(imageTimesFromEnv({ DEVENV_IMAGE_FIRST_MS: '500', DEVENV_IMAGE_INTERVAL_MS: '2000' })).toEqual({ firstMs: 500, intervalMs: 2000 });
    expect(imageTimesFromEnv({ DEVENV_IMAGE_FIRST_MS: '5', DEVENV_IMAGE_INTERVAL_MS: 'x' })).toEqual({ firstMs: 60_000, intervalMs: undefined });
    // User request 2026-09-28 ("in a guided cron style manner"): the daily time HH:MM became a cron schedule.
    const scheduleOf = (env: NodeJS.ProcessEnv) => {
      const { text, timeZone } = imageScheduleFromEnv(env);
      return { text, timeZone };
    };
    expect(scheduleOf({})).toEqual({ text: '7 6 * * *', timeZone: 'Europe/Vienna' });
    expect(scheduleOf({ DEVENV_IMAGE_SCHEDULE: '30 5 * * 1-5', DEVENV_IMAGE_TZ: 'America/New_York' })).toEqual({ text: '30 5 * * 1-5', timeZone: 'America/New_York' });
    expect(scheduleOf({ DEVENV_IMAGE_SCHEDULE: 'soon', DEVENV_IMAGE_TZ: 'nowhere' })).toEqual({ text: '7 6 * * *', timeZone: 'Europe/Vienna' });
    expect(imageScheduleFromEnv({ DEVENV_IMAGE_SCHEDULE: '30 5 * * 1-5' }).schedule.weekdays).toEqual(new Set([1, 2, 3, 4, 5]));
  });
});

// Review round 1 of PR #57 (C): the settings of the image maintenance come with `settings -`, not with the label; the
// schedule is a cron expression (user request 2026-09-28, "in a guided cron style manner").
describe('the settings and the schedule of the image maintenance', () => {
  const SETTINGS = { prefixes: ['ghcr.io/acme/base'], schedule: '0 5 * * 1-5', timeZone: 'America/New_York' };
  const ENV = { DEVENV_IMAGE_PREFIXES: JSON.stringify(['ghcr.io/majikmate/devcontainer-dev']), DEVENV_IMAGE_SCHEDULE: '7 6 * * *', DEVENV_IMAGE_TZ: 'Europe/Vienna' };

  async function settings(input: string): Promise<number> {
    return main(['settings', '-'], { env: {}, stateDir, readStdin: async () => input, err: () => {} });
  }

  it('stores valid settings; the monitor takes them instead of those of its container at the next check', async () => {
    const log: string[] = [];
    const current = new CurrentImageSettings(ENV, stateDir, (message) => log.push(message));
    await current.refresh();
    expect(current.value).toMatchObject({ prefixes: ['ghcr.io/majikmate/devcontainer-dev'], schedule: '7 6 * * *', timeZone: 'Europe/Vienna' });
    expect(await settings(JSON.stringify(SETTINGS))).toBe(0);
    await current.refresh();
    expect(current.value).toMatchObject(SETTINGS);
    expect(current.value.cron.hours).toEqual(new Set([5]));
    expect(log).toEqual(['Image update settings: ghcr.io/acme/base; at "0 5 * * 1-5" (cron, America/New_York).']);
    // Unchanged: no second log line.
    await current.refresh();
    expect(log).toHaveLength(1);
  });

  // Review round 10 of PR #57 (U2): a failed write leaves no temporary file in the volume.
  it('leaves no temporary file behind when a write fails', async () => {
    fs.mkdirSync(path.join(stateDir, 'image-settings.json'));
    await expect(settings(JSON.stringify(SETTINGS))).rejects.toThrow();
    expect(fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses anything else and keeps the stored settings', async () => {
    expect(await settings(JSON.stringify(SETTINGS))).toBe(0);
    for (const input of [
      'not json',
      '{}',
      JSON.stringify({ ...SETTINGS, schedule: '61 5 * * *' }),
      JSON.stringify({ ...SETTINGS, schedule: '05:00' }),
      JSON.stringify({ ...SETTINGS, timeZone: 'Mars/Base' }),
      JSON.stringify({ ...SETTINGS, prefixes: ['ubuntu*'] }),
      JSON.stringify({ ...SETTINGS, extra: 1 }),
    ]) {
      expect(await settings(input), input).toBe(EXIT_INVALID);
    }
    const current = new CurrentImageSettings(ENV, stateDir, () => {});
    await current.refresh();
    expect(current.value).toMatchObject(SETTINGS);
  });

  it('runs a pass when a time of the schedule came since the last check, at most one at a time', async () => {
    let time = Date.parse('2026-09-29T04:05:00Z');
    const log: string[] = [];
    const current = new CurrentImageSettings(ENV, stateDir, () => {});
    let passes = 0;
    let release: (() => void) | undefined;
    const schedule = new ImageSchedule({
      now: () => time,
      log: (message) => log.push(message),
      settings: current,
      pass: () => {
        passes++;
        return passes === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
      },
    });
    // 06:07 in Vienna is 04:07 UTC in summer.
    time += 60_000;
    await schedule.check();
    expect(passes).toBe(0);
    time += 120_000;
    const first = schedule.check();
    // Review round 3 of PR #58: waits for the pass to start instead of 10 ms, which a loaded full run exceeded.
    await vi.waitFor(() => expect(passes).toBe(1));
    // A pass that is still running: the next one is left out.
    await schedule.run();
    expect(passes).toBe(1);
    expect(log).toEqual(['An image update is still running; this time of the schedule is left out.']);
    release?.();
    await first;
    time += 60_000;
    await schedule.check();
    expect(passes).toBe(1);
    // The next day.
    time = Date.parse('2026-09-30T04:07:30Z');
    await schedule.check();
    expect(passes).toBe(2);
  });

  // Review round 2 of PR #57 (R3): a clock that steps back ran a time that was handled already again.
  it('does not run a time again after the clock stepped back', async () => {
    let time = Date.parse('2026-09-29T04:06:00Z');
    let passes = 0;
    const schedule = new ImageSchedule({ now: () => time, log: () => {}, settings: new CurrentImageSettings(ENV, stateDir, () => {}), pass: async () => void passes++ });
    time = Date.parse('2026-09-29T04:08:00Z');
    await schedule.check();
    expect(passes).toBe(1);
    time = Date.parse('2026-09-29T04:00:00Z');
    await schedule.check();
    time = Date.parse('2026-09-29T04:08:00Z');
    await schedule.check();
    expect(passes).toBe(1);
  });

  // Review round 4 of PR #57 (L1): after a clock that was far ahead was corrected, no pass came until it caught up.
  it('goes on from now after the clock stepped back by more than an hour', async () => {
    let time = Date.parse('2027-09-29T04:06:00Z');
    let passes = 0;
    const log: string[] = [];
    const schedule = new ImageSchedule({ now: () => time, log: (message) => log.push(message), settings: new CurrentImageSettings(ENV, stateDir, () => {}), pass: async () => void passes++ });
    time = Date.parse('2027-09-29T04:08:00Z');
    await schedule.check();
    expect(passes).toBe(1);
    time = Date.parse('2026-09-29T04:05:00Z');
    await schedule.check();
    expect(log[0]).toMatch(/^The clock of the host went back by \d+ minutes; the image schedule goes on from now\.$/);
    time = Date.parse('2026-09-29T04:08:00Z');
    await schedule.check();
    expect(passes).toBe(2);
  });

  // Review round 8 of PR #57 (S3): the IDs of the images are remembered at each check, not only at the passes.
  it('observes the images at each check while no pass runs', async () => {
    let observed = 0;
    let release!: () => void;
    const schedule = new ImageSchedule({
      now: () => Date.parse('2026-09-29T12:00:00Z'),
      log: () => {},
      settings: new CurrentImageSettings(ENV, stateDir, () => {}),
      pass: () => new Promise<void>((resolve) => (release = resolve)),
      observe: async () => void observed++,
    });
    await schedule.check();
    expect(observed).toBe(1);
    const running = schedule.run();
    await schedule.check();
    expect(observed).toBe(1);
    // Review round 9 of PR #57 (T1): the pass starts after a turn (it first waits for an observe of a check). Review round
    // 4 of PR #58 (H4): waits for the pass to start instead of 10 ms, after which `release` could still be unset.
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await running;
  });

  // Review round 9 of PR #57 (T1): a check that takes longer than the next one's start is not joined.
  it('runs no second check while one is still running', async () => {
    let observed = 0;
    let release!: () => void;
    const schedule = new ImageSchedule({
      now: () => Date.parse('2026-09-29T12:00:00Z'),
      log: () => {},
      settings: new CurrentImageSettings(ENV, stateDir, () => {}),
      pass: async () => {},
      observe: () => {
        observed++;
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    const first = schedule.check();
    // Review round 3 of PR #58: waits for the observe to start instead of 10 ms (a loaded full run can exceed it).
    await vi.waitFor(() => expect(observed).toBe(1));
    await schedule.check();
    expect(observed).toBe(1);
    release();
    await first;
    const next = schedule.check();
    // Review round 3 of PR #58: waits for the observe to start instead of 10 ms (a loaded full run can exceed it).
    await vi.waitFor(() => expect(observed).toBe(2));
    release();
    await next;
  });

  // Review round 9 of PR #57 (T1): a pass (the first one, one minute after the start) waits for a check's observe.
  it('starts a pass only after the observe of a running check', async () => {
    const order: string[] = [];
    let release!: () => void;
    const schedule = new ImageSchedule({
      now: () => Date.parse('2026-09-29T12:00:00Z'),
      log: () => {},
      settings: new CurrentImageSettings(ENV, stateDir, () => {}),
      pass: async () => void order.push('pass'),
      observe: () => {
        order.push('observe');
        return new Promise<void>((resolve) => (release = () => (order.push('observed'), resolve())));
      },
    });
    const check = schedule.check();
    // Review round 3 of PR #58: waits for the observe to start instead of 10 ms (a loaded full run can exceed it).
    await vi.waitFor(() => expect(order).toEqual(['observe']));
    const run = schedule.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['observe']);
    release();
    await Promise.all([check, run]);
    expect(order).toEqual(['observe', 'observed', 'pass']);
  });

  // Review round 10 of PR #57 (U1): the times during a pass that a check started are left out, not caught up at once.
  it('leaves out the times of the schedule during a pass that a check started, and logs it', async () => {
    let time = Date.parse('2026-09-29T06:04:30Z');
    const log: string[] = [];
    let passes = 0;
    const settings = new CurrentImageSettings({ ...ENV, DEVENV_IMAGE_SCHEDULE: '*/5 * * * *', DEVENV_IMAGE_TZ: 'UTC' }, stateDir, () => {});
    const schedule = new ImageSchedule({
      now: () => time,
      log: (message) => log.push(message),
      settings,
      pass: async () => {
        passes++;
        // The pass takes until 06:17.
        time = Date.parse('2026-09-29T06:17:00Z');
      },
    });
    time = Date.parse('2026-09-29T06:05:10Z');
    await schedule.check();
    expect(passes).toBe(1);
    expect(log).toEqual(['An image update was still running; the times of the schedule during it are left out.']);
    time = Date.parse('2026-09-29T06:18:00Z');
    await schedule.check();
    expect(passes).toBe(1);
    time = Date.parse('2026-09-29T06:20:10Z');
    await schedule.check();
    expect(passes).toBe(2);
  });

  it('follows new settings of another computer at the next check', async () => {
    let time = Date.parse('2026-09-29T08:58:00Z');
    const current = new CurrentImageSettings(ENV, stateDir, () => {});
    let passes = 0;
    const schedule = new ImageSchedule({ now: () => time, log: () => {}, settings: current, pass: async () => void passes++ });
    // 05:00 in New York (EDT) is 09:00 UTC; 2026-09-29 is a Tuesday.
    expect(await settings(JSON.stringify(SETTINGS))).toBe(0);
    time += 60_000;
    await schedule.check();
    expect(passes).toBe(0);
    time += 60_000;
    await schedule.check();
    expect(passes).toBe(1);
  });
});
