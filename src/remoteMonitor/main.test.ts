// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  timingFromEnv,
  type DockerResult,
} from './main';
import { REMOTE_GRACE_MS, REMOTE_TICK_MS, decide } from './rules';

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

  it('two heartbeats at the same time: the higher seq stays, whatever the order of the writes', async () => {
    const entry = (seq: number, keepRunning: boolean) => JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning, seq }] });
    await Promise.all([run(['heartbeat', entry(2, true)]), run(['heartbeat', entry(1, false)]), run(['heartbeat', entry(2, true)])]);
    expect(readRecord(SOURCE, A)).toMatchObject({ keepRunning: true, seq: 2 });
  });

  it('a left-over lock of a killed heartbeat is taken over after 10 seconds', async () => {
    const dir = heartbeatDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, `.${heartbeatFileName(SOURCE, A)}.lock`);
    fs.writeFileSync(lock, '1');
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(lock, old, old);
    await run(['heartbeat', JSON.stringify({ source: SOURCE, limitSeconds: 600, environments: [{ id: A, keepRunning: false, seq: 1 }] })]);
    expect(readRecord(SOURCE, A)).toMatchObject({ seq: 1 });
    expect(fs.existsSync(lock)).toBe(false);
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

  it.each<[string[]]>([[['records', '../x']], [['records']], [['forget', SOURCE, '../x']], [['forget', 'x', A]], [['forget', SOURCE]], [['run', 'x']], [['unknown']], [[]]])(
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

  beforeEach(() => {
    now = T0;
    lines = [];
    calls = [];
    stopResults = new Map();
    ps = { code: 0, stdout: `${DB_ID}\trunning\tdevenv-api-db-1\t${A}\tdb\n${DEV_ID}\trunning\tdevenv-api\t${A}\t\n`, stderr: '' };
    loop = new RemoteMonitorLoop({
      docker: async (args) => {
        calls.push([...args]);
        if (args[0] === 'ps') return ps;
        return stopResults.get(args[1]) ?? { code: 0, stdout: '', stderr: '' };
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(passes).toBe(1);
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
