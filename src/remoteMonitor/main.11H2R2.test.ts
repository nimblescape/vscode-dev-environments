// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11H2: while a monitor that ends when idle waits for a background run to end, its loop goes on ticking
// (the stops of environments whose windows closed, the heartbeats; reviewer A, A2-M1), and the run counts as running
// until its end is stored, so the idle exit never cuts that write (reviewer B, R1). The volume is a temporary folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_RUN_FILE } from '../core/remoteMonitor/protocol';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { CacheRunState } from './backgroundRules';
import { CacheSchedule, CurrentCacheSettings, main, vscodeBackgroundDeps } from './main';

const T0 = Date.parse('2026-10-09T10:00:00Z');

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-monitor-11h2r2-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe('the idle exit during a background run keeps the ticks going (review round 2 of 11H2, A2-M1)', () => {
  it('ticks (and lists the environments) during the run, logs the wait once, and exits at the first tick after the run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const gate = new Promise<string>((_resolve, reject) => (finish = () => reject(new Error('ended by the test'))));
    const store = path.join(stateDir, 'store');
    fs.mkdirSync(store);
    const vscode = {
      store: { root: store },
      storeVolume: 'devenv-vscode',
      // Integration of 11H3 with the final 11H2 (#135): the monitor's volume of the run (the extension lists of 11H3) is the temporary
      // state folder of the test, as main gives its own to vscodeBackgroundDeps; never the real /state.
      extensionStateDir: stateDir,
      engine: {
        ...unusedEngine(),
        architecture: async () => {
          started();
          return gate;
        },
      },
      tryLock: async () => ({ kind: 'busy' as const }),
    } as unknown as NonNullable<ReturnType<typeof vscodeBackgroundDeps>>;
    let mono = 0;
    let ticks = 0;
    let listed = 0;
    let out = '';
    const result = main(['run'], {
      env: { DEVENV_IMAGE_FIRST_MS: '1000' },
      stateDir,
      engine: {
        ...unusedEngine(),
        containerSummaries: async (): Promise<EngineContainerSummary[]> => {
          listed++;
          return [];
        },
      },
      vscodeBackground: () => vscode,
      lockEnvironment: async () => ({ kind: 'locked', release: () => {} }),
      exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
      monotonic: () => mono,
      now: () => T0 + mono,
      sleep: async (ms) => {
        ticks += 1;
        mono += ms;
        if (ticks === 1) await runStarted;
        // A tick of the loop gives the other work its turn (setImmediate is not faked here).
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      out: (text) => (out += text),
    });
    let exited: number | undefined;
    void result.then((code) => (exited = code));
    await vi.waitFor(() => expect(out).toContain('first check in 1 s'));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(out).toContain('a background run is running; the Session Monitor exits after its end.'));
    const before = listed;
    // Without the change (round 1: `await schedule.settled()` in place of the tick) no environment is listed any more.
    await vi.waitFor(() => expect(listed).toBeGreaterThanOrEqual(before + 20), { timeout: 4_000 });
    expect(exited).toBeUndefined();
    expect(occurrences(out, 'the Session Monitor exits after its end.')).toBe(1);
    expect(fs.existsSync(path.join(stateDir, CACHE_RUN_FILE))).toBe(false);
    finish();
    expect(await result).toBe(0);
    expect(out.indexOf('the Session Monitor exits. The next open starts it again.')).toBeGreaterThan(out.indexOf('The background run ended.'));
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, CACHE_RUN_FILE), 'utf8')).lastEndAt).toBeGreaterThanOrEqual(T0);
  });
});

describe('the end of a background run is stored before it counts as ended (review round 2 of 11H2, R1)', () => {
  it('is busy until the write of its end is done', async () => {
    let release!: () => void;
    const writing = new Promise<void>((resolve) => (release = resolve));
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => (writeStarted = resolve));
    let state: CacheRunState = {};
    const schedule = new CacheSchedule({
      now: () => T0,
      log: () => {},
      settings: new CurrentCacheSettings({ DEVENV_IMAGE_SCHEDULE: '17', DEVENV_IMAGE_TZ: 'UTC' }, stateDir, () => {}),
      pass: async () => {},
      state: {
        read: async () => state,
        update: async (change) => {
          writeStarted();
          await writing;
          state = { ...state, ...change };
        },
      },
    });
    const run = schedule.run();
    expect(schedule.busy).toBe(true);
    await started;
    // The pass ended; its end is being written: still busy (the idle exit waits).
    expect(schedule.busy).toBe(true);
    release();
    await run;
    expect(state.lastEndAt).toBe(T0);
    expect(schedule.busy).toBe(false);
  });

  it('is not busy after a failed write of its end (one line of the log)', async () => {
    const log: string[] = [];
    const schedule = new CacheSchedule({
      now: () => T0,
      log: (message) => log.push(message),
      settings: new CurrentCacheSettings({ DEVENV_IMAGE_SCHEDULE: '17', DEVENV_IMAGE_TZ: 'UTC' }, stateDir, () => {}),
      pass: async () => {},
      state: {
        read: async () => ({}),
        update: async () => {
          throw new Error('the state volume is full');
        },
      },
    });
    await schedule.run();
    expect(schedule.busy).toBe(false);
    expect(log).toContain('The end of the background run could not be stored: the state volume is full');
  });
});
