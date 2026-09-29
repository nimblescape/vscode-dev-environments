// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heartbeatFileName, inUseByOtherComputer, type RecordsOutput } from '../core/remoteMonitor/protocol';
import {
  EXIT_INVALID,
  PS_FORMAT,
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
  removeRecord,
  removeStaleStateTemporaryFiles,
  timingFromEnv,
  type DockerResult,
} from './main';
import { REMOTE_GRACE_MS, REMOTE_TICK_MS, decide, type RemoteRecord } from './rules';

const A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const B = '7c1d2e3f-0000-4000-8000-000000000002';
const SOURCE = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const MINUTE = 60_000;
const DEV_ID = 'a'.repeat(64);
const DB_ID = 'b'.repeat(64);

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
    expect((await run(['forget', SOURCE, A])).code).toBe(0);
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
      now: () => now,
      log: (message) => lines.push(message),
    });
  });

  async function tickAt(time: number): Promise<string[]> {
    now = time;
    return loop.tick();
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

  // Review round 1 of PR #63 (F2): the removals come before the stops, which can take a minute each.
  it('removes the old records before it stops containers', async () => {
    writeRecord(SOURCE, A, { at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600 });
    for (let time = T0; time < T0 + REMOTE_GRACE_MS; time += REMOTE_TICK_MS) await tickAt(time);
    writeRecord(SOURCE, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    calls = [];
    expect(await tickAt(T0 + REMOTE_GRACE_MS)).toEqual([A]);
    expect(calls.map((call) => call[0])).toEqual(['ps', 'forget', 'stop', 'stop']);
    expect(recordFiles()).toEqual([heartbeatFileName(SOURCE, A)]);
  });

  it('logs a removal that failed', async () => {
    const failing = new RemoteMonitorLoop({ docker: async () => ps, removeRecord: async () => Promise.reject(new Error('the heartbeat records stayed locked')), dir: heartbeatDir(stateDir), now: () => T0, log: (message) => lines.push(message) });
    writeRecord(SOURCE, B, { at: T0 - 8 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600 });
    await failing.tick();
    expect(lines).toContain(`The old record of ${B} could not be removed: the heartbeat records stayed locked`);
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
    const removed = await removeStaleStateTemporaryFiles(stateDir, T0);
    expect(removed.sort()).toEqual(['image-settings.json.7.3.tmp', 'images.json.12.1.tmp', 'replaced-images.json.99.12.tmp']);
    expect(fs.readdirSync(stateDir).sort()).toEqual(['images.json', 'images.json.12.2.tmp', 'images.json.x.1.tmp', 'other.json.12.1.tmp']);
  });

  it('never removes a folder or a link with such a name, nor what a link points to', async () => {
    const target = path.join(stateDir, 'target');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(stateDir, 'images.json.1.1.tmp'));
    fs.mkdirSync(path.join(stateDir, 'images.json.2.1.tmp'));
    expect(await removeStaleStateTemporaryFiles(stateDir, T0 + 48 * HOUR)).toEqual([]);
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
