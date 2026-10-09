// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H2 (reviewer B, mutation testing: its probes, adopted; each kills a mutant that survived the
// tests of 11H2): the schedule of the background run never rejects when the end of a run cannot be stored (its callers
// are `void schedule.run()` and `void schedule.check()`: a rejection would be unhandled and end the process, and a
// permanent monitor would be restarted into the same failure); the state file keeps the fields that an update does not
// name (the end of the run never wipes the time of the last cleanup); `monitor.js run` checks the schedule at its first
// check (a restart runs nothing while the stored end is recent) and makes the VS Code part afresh for each run; that
// part reads the proxy of the daemon. The volume is a temporary folder; nothing needs root.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_RUN_FILE } from '../core/remoteMonitor/protocol';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { CacheSchedule, CurrentCacheSettings, STATE_TEMPORARY_FILE, cacheRunStore, main, removeStaleStateTemporaryFiles, vscodeBackgroundDeps } from './main';

const T0 = Date.parse('2026-10-09T10:00:00Z');
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-monitor-11h2r1-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('11H2 review round 1 (B): the end of a run that cannot be stored', () => {
  it('run() and check() resolve and log one line', async () => {
    const log: string[] = [];
    let passes = 0;
    const schedule = new CacheSchedule({
      now: () => T0,
      log: (message) => log.push(message),
      settings: new CurrentCacheSettings({ DEVENV_IMAGE_SCHEDULE: '17', DEVENV_IMAGE_TZ: 'UTC' }, stateDir, () => {}),
      pass: async () => void passes++,
      state: { read: async () => ({}), update: async () => Promise.reject(new Error('no space left on device')) },
    });
    await expect(schedule.check()).resolves.toBeUndefined();
    await expect(schedule.run()).resolves.toBeUndefined();
    expect(passes).toBe(2);
    expect(log.filter((line) => line === 'The end of the background run could not be stored: no space left on device')).toHaveLength(2);
  });
});

describe('11H2 review round 1 (B): the state file of the background run', () => {
  it('an update keeps the fields that it does not name', async () => {
    const store = cacheRunStore(stateDir);
    await store.update({ lastCleanupAt: T0 });
    await store.update({ lastEndAt: T0 + 1 });
    expect(await store.read()).toEqual({ lastEndAt: T0 + 1, lastCleanupAt: T0 });
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, CACHE_RUN_FILE), 'utf8'))).toEqual({ lastEndAt: T0 + 1, lastCleanupAt: T0 });
  });
});

/** `monitor.js run` over the volume of the test; the loop never ends (a permanent monitor). */
function startRun(env: NodeJS.ProcessEnv, vscodeBackground: () => undefined) {
  let mono = 0;
  let out = '';
  void main(['run'], {
    env: { DEVENV_MONITOR_PERMANENT: '1', ...env },
    stateDir,
    engine: { ...unusedEngine(), containerSummaries: async (): Promise<EngineContainerSummary[]> => [] },
    vscodeBackground,
    lockEnvironment: async () => ({ kind: 'locked', release: () => {} }),
    exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
    monotonic: () => mono,
    now: () => T0 + mono,
    sleep: async (ms) => {
      mono += ms;
      await new Promise(() => {});
    },
    out: (text) => (out += text),
  });
  return { out: () => out };
}

/** Lets real I/O (the reads of the volume) of a check finish while the timers are fake. */
async function settle(ms = 300): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((resolve) => setImmediate(resolve));
}

describe('11H2 review round 1 (B): monitor.js run', () => {
  it('the first check after a restart runs nothing while the stored end of the last run is younger than the interval', async () => {
    fs.writeFileSync(path.join(stateDir, CACHE_RUN_FILE), JSON.stringify({ lastEndAt: T0 - 60_000 }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const monitor = startRun({ DEVENV_IMAGE_FIRST_MS: '1000' }, () => undefined);
    await vi.waitFor(() => expect(monitor.out()).toContain('first check in 1 s'));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(monitor.out()).not.toContain('The background run starts.');
  });

  it('makes the VS Code part afresh for each run (a failed proxy read counts only for that run)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    let made = 0;
    const monitor = startRun({ DEVENV_IMAGE_FIRST_MS: '1000', DEVENV_IMAGE_INTERVAL_MS: '1000' }, () => void made++);
    await vi.waitFor(() => expect(monitor.out()).toContain('first check in 1 s'));
    const atStart = made;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(monitor.out().split('The background run ended.').length - 1).toBe(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(monitor.out().split('The background run ended.').length - 1).toBe(2));
    expect(made - atStart).toBe(2);
  });
});

describe('11H2 review round 1 (B): the HTTPS of the VS Code part', () => {
  it('reads the proxy of the daemon (decision C1)', async () => {
    let proxyReads = 0;
    const engine = {
      ...unusedEngine(),
      proxy: async () => {
        proxyReads++;
        return {};
      },
    };
    const deps = vscodeBackgroundDeps({ DEVENV_VSCODE_STORE: 'devenv-vscode' }, engine, () => {});
    const controller = new AbortController();
    const request = deps!.store.transport.request({ method: 'GET', url: 'https://127.0.0.1:1/', headers: {} }, controller.signal);
    await request.catch(() => undefined);
    expect(proxyReads).toBe(1);
  });
});

// Review round 1 of 11H2 (reviewer B, D2): the leftover temporary files of cache-run.json (written at the end of every
// background run) are removed at the start of `run` too.
describe('11H2 review round 1 (B, D2): the leftover temporary files of the state of the background run', () => {
  it('are removed like those of the other files of the volume', async () => {
    const stale = 'cache-run.json.123.4.tmp';
    fs.writeFileSync(path.join(stateDir, stale), '{}');
    const old = new Date(T0 - 2 * 60 * 60_000);
    fs.utimesSync(path.join(stateDir, stale), old, old);
    expect(STATE_TEMPORARY_FILE.test(stale)).toBe(true);
    expect(await removeStaleStateTemporaryFiles(stateDir, T0)).toEqual([stale]);
  });
});
