// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, D1 and D2): the one schedule of the Session Monitor's background run
// (CacheSchedule, the setting cacheUpdateSchedule): with an interval every N minutes from the end of the previous run, and
// at its start when the last run is older; with a cron schedule at its times, and at its start when a time passed since
// the last run; the end of the last run kept in the volume, so a restart does not run again at once. And `run`: the run
// at the first check after the start, the permanent monitor that never exits when idle, the VS Code part of the container.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_RUN_FILE, IMAGE_SETTINGS_FILE } from '../core/remoteMonitor/protocol';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { CacheSchedule, CurrentCacheSettings, REMOTE_IDLE_EXIT_MS, cacheRunStore, main, permanentFromEnv, vscodeBackgroundDeps } from './main';
import { REMOTE_TICK_MS } from './rules';

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-09T10:00:00Z');

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-monitor-11h2-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** A schedule over the volume of the test, with the settings of `env` and a clock that the test moves. */
function scheduleOf(env: NodeJS.ProcessEnv, start: number) {
  let time = start;
  let passes = 0;
  const log: string[] = [];
  const schedule = new CacheSchedule({
    now: () => time,
    log: (message) => log.push(message),
    settings: new CurrentCacheSettings(env, stateDir, () => {}),
    pass: async () => void passes++,
    state: cacheRunStore(stateDir),
  });
  return { schedule, log, passes: () => passes, at: (value: number) => (time = value) };
}

const storeEnd = (at: number) => fs.writeFileSync(path.join(stateDir, CACHE_RUN_FILE), JSON.stringify({ lastEndAt: at }));
const storedEnd = () => (JSON.parse(fs.readFileSync(path.join(stateDir, CACHE_RUN_FILE), 'utf8')) as { lastEndAt?: number }).lastEndAt;

describe('the schedule of the background run: an interval (plan step 11H2, D2)', () => {
  const ENV = { DEVENV_IMAGE_SCHEDULE: '17', DEVENV_IMAGE_TZ: 'UTC' };

  it('runs at its start when no run is known, then N minutes after the end of the previous run, and keeps that end', async () => {
    const s = scheduleOf(ENV, T0);
    await s.schedule.check();
    expect(s.passes()).toBe(1);
    expect(storedEnd()).toBe(T0);
    s.at(T0 + 17 * MINUTE - 1);
    await s.schedule.check();
    expect(s.passes()).toBe(1);
    s.at(T0 + 17 * MINUTE);
    await s.schedule.check();
    expect(s.passes()).toBe(2);
    expect(storedEnd()).toBe(T0 + 17 * MINUTE);
  });

  it('counts from the end of the run, not its start', async () => {
    let time = T0;
    let passes = 0;
    const schedule = new CacheSchedule({
      now: () => time,
      log: () => {},
      settings: new CurrentCacheSettings(ENV, stateDir, () => {}),
      // The run takes 10 minutes.
      pass: async () => {
        passes++;
        time += 10 * MINUTE;
      },
      state: cacheRunStore(stateDir),
    });
    await schedule.check();
    expect(storedEnd()).toBe(T0 + 10 * MINUTE);
    time = T0 + 17 * MINUTE;
    await schedule.check();
    expect(passes).toBe(1);
    time = T0 + 27 * MINUTE;
    await schedule.check();
    expect(passes).toBe(2);
  });

  it('a monitor that starts again: no run while the stored end is younger than the interval, a run once it is older', async () => {
    storeEnd(T0 - 10 * MINUTE);
    const restarted = scheduleOf(ENV, T0);
    await restarted.schedule.check();
    expect(restarted.passes()).toBe(0);
    restarted.at(T0 + 7 * MINUTE);
    await restarted.schedule.check();
    expect(restarted.passes()).toBe(1);
    storeEnd(T0 - 18 * MINUTE);
    const late = scheduleOf(ENV, T0);
    await late.schedule.check();
    expect(late.passes()).toBe(1);
  });

  it('follows the interval of new settings of another computer', async () => {
    const s = scheduleOf(ENV, T0);
    await s.schedule.check();
    fs.writeFileSync(path.join(stateDir, IMAGE_SETTINGS_FILE), JSON.stringify({ prefixes: [], schedule: '60', timeZone: 'UTC' }));
    s.at(T0 + 17 * MINUTE);
    await s.schedule.check();
    expect(s.passes()).toBe(1);
    s.at(T0 + 60 * MINUTE);
    await s.schedule.check();
    expect(s.passes()).toBe(2);
  });
});

describe('the schedule of the background run: a cron schedule (plan step 11H2, D2)', () => {
  const ENV = { DEVENV_IMAGE_SCHEDULE: '7 6 * * *', DEVENV_IMAGE_TZ: 'UTC' };

  it('a monitor that starts runs once when a time passed since its stored last run, and not when none passed', async () => {
    storeEnd(Date.parse('2026-10-08T06:30:00Z'));
    const passed = scheduleOf(ENV, Date.parse('2026-10-09T09:00:00Z'));
    await passed.schedule.check();
    expect(passed.passes()).toBe(1);
    passed.at(Date.parse('2026-10-09T09:01:00Z'));
    await passed.schedule.check();
    expect(passed.passes()).toBe(1);
    storeEnd(Date.parse('2026-10-09T06:30:00Z'));
    const notYet = scheduleOf(ENV, Date.parse('2026-10-09T09:00:00Z'));
    await notYet.schedule.check();
    expect(notYet.passes()).toBe(0);
    notYet.at(Date.parse('2026-10-10T06:07:00Z'));
    await notYet.schedule.check();
    expect(notYet.passes()).toBe(1);
  });

  it('runs at its start when no run is known', async () => {
    const s = scheduleOf(ENV, Date.parse('2026-10-09T09:00:00Z'));
    await s.schedule.check();
    expect(s.passes()).toBe(1);
  });
});

describe('monitor.js run: the background run and the mode (plan step 11H2)', () => {
  function startRun(env: NodeJS.ProcessEnv, maxTicks = 1_000) {
    let mono = 0;
    let ticks = 0;
    let out = '';
    const result = main(['run'], {
      env,
      stateDir,
      engine: { ...unusedEngine(), containerSummaries: async (): Promise<EngineContainerSummary[]> => [] },
      vscodeBackground: () => undefined,
      lockEnvironment: async () => ({ kind: 'locked', release: () => {} }),
      exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
      monotonic: () => mono,
      now: () => T0 + mono,
      sleep: async (ms) => {
        ticks += 1;
        mono += ms;
        if (ticks >= maxTicks) await new Promise(() => {});
      },
      out: (text) => (out += text),
    });
    return { result, out: () => out, ticks: () => ticks };
  }

  it('reads the mode of its container', () => {
    expect(permanentFromEnv({ DEVENV_MONITOR_PERMANENT: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true']) expect(permanentFromEnv({ DEVENV_MONITOR_PERMANENT: value })).toBe(false);
  });

  it('a permanent monitor never exits when idle; one that ends when idle exits after the idle time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const permanent = startRun({ DEVENV_MONITOR_PERMANENT: '1' }, Math.ceil((REMOTE_IDLE_EXIT_MS * 3) / REMOTE_TICK_MS));
    await vi.waitFor(() => expect(permanent.ticks()).toBe(Math.ceil((REMOTE_IDLE_EXIT_MS * 3) / REMOTE_TICK_MS)));
    expect(permanent.out()).not.toContain('exits');
    expect(permanent.out()).toContain('runs permanently.');
    const idle = startRun({});
    expect(await idle.result).toBe(0);
    expect(idle.out()).toContain(`ends after ${REMOTE_IDLE_EXIT_MS / 1000} s without a running environment.`);
  });

  it('runs the background at the first check after the start, also without prefixes, and keeps its end in the volume', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const monitor = startRun({ DEVENV_MONITOR_PERMANENT: '1', DEVENV_IMAGE_FIRST_MS: '1000' }, 3);
    await vi.waitFor(() => expect(monitor.out()).toContain('first check in 1 s, then every 17 minutes'));
    expect(monitor.out()).not.toContain('The background run starts.');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(monitor.out()).toContain('The background run ended.'));
    expect(monitor.out()).toContain('the background run leaves the VS Code server out');
    expect(fs.existsSync(path.join(stateDir, CACHE_RUN_FILE))).toBe(true);
  });
});

describe('the VS Code part of the container (plan step 11H2)', () => {
  it('only with the name of a store that the monitor mounts at /vscode', () => {
    const engine = unusedEngine();
    expect(vscodeBackgroundDeps({}, engine, () => {})).toBeUndefined();
    for (const name of ['', '-x', 'a/b', 'a b', '../x']) expect(vscodeBackgroundDeps({ DEVENV_VSCODE_STORE: name }, engine, () => {}), name).toBeUndefined();
    const deps = vscodeBackgroundDeps({ DEVENV_VSCODE_STORE: 'devenv-vscode' }, engine, () => {});
    expect(deps?.storeVolume).toBe('devenv-vscode');
    expect(deps?.store.root).toBe('/vscode');
    expect(deps?.store.background).toBe(true);
  });
});
