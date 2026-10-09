// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 3 of 11H2 (reviewer A, A3-L1; reviewer B, D1): the idle exit waits for the removals of old records; a run
// that the timer of the schedule starts during that wait is never cut: the exit looks again after the wait and waits for
// the run's end. The volume is a temporary folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heartbeatFileName } from '../core/remoteMonitor/protocol';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { heartbeatDir, main, vscodeBackgroundDeps } from './main';

const T0 = Date.parse('2026-10-09T10:00:00Z');
const DAY = 24 * 60 * 60_000;
const IDLE_MS = 60_000;
const SOURCE = '0123456789abcdef0123456789abcdef';
const A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const WAIT = 'a background run is running; the Session Monitor exits after its end.';
const EXIT = 'the Session Monitor exits. The next open starts it again.';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-monitor-11h2r3-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('the idle exit after the removals of old records (review round 3 of 11H2, A3-L1 / D1)', () => {
  it('does not exit when the schedule started a run while the removals ended; it exits after the run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    // A record of an environment without containers, older than RECORD_MAX_AGE_MS: the first tick removes it.
    const dir = heartbeatDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    const record = path.join(dir, heartbeatFileName(SOURCE, A));
    fs.writeFileSync(record, JSON.stringify({ seq: 0, at: T0 - 8 * DAY, keepRunning: false, limitSeconds: 600 }));
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const gate = new Promise<string>((_resolve, reject) => (finish = () => reject(new Error('ended by the test'))));
    const store = path.join(stateDir, 'store');
    fs.mkdirSync(store);
    const vscode = {
      store: { root: store },
      storeVolume: 'devenv-vscode',
      engine: {
        ...unusedEngine(),
        architecture: async () => {
          started();
          return gate;
        },
      },
      tryLock: async () => ({ kind: 'busy' as const }),
    } as unknown as NonNullable<ReturnType<typeof vscodeBackgroundDeps>>;
    // The first removal (`monitor.js forget` under the lock of the records) ends only when the test says so; it removes
    // the record as `forget` does.
    const removals: Array<() => void> = [];
    let mono = 0;
    let idleSeen = false;
    let out = '';
    const result = main(['run'], {
      env: { DEVENV_IMAGE_FIRST_MS: '1000', DEVENV_MONITOR_IDLE_MS: String(IDLE_MS) },
      stateDir,
      engine: { ...unusedEngine(), containerSummaries: async (): Promise<EngineContainerSummary[]> => [] },
      vscodeBackground: () => vscode,
      lockEnvironment: async () => ({ kind: 'locked', release: () => {} }),
      exec: (_file, _args, _options, callback) => {
        const remove = () => {
          fs.rmSync(record, { force: true });
          callback(null, 'removed\n', '');
        };
        if (removals.length === 0) removals.push(remove);
        else remove();
      },
      // Read by the idle check (nothing runs, no record is fresh): from IDLE_MS on, the loop is at its idle exit.
      monotonic: () => {
        if (mono >= IDLE_MS) idleSeen = true;
        return mono;
      },
      now: () => T0 + mono,
      sleep: async (ms) => {
        mono += ms;
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      out: (text) => (out += text),
    });
    let exited: number | undefined;
    void result.then((code) => (exited = code));
    await vi.waitFor(() => expect(out).toContain('first check in 1 s'));
    // The loop is idle, not busy, and waits for the removal of the record (started by its first tick).
    await vi.waitFor(() => expect(idleSeen).toBe(true));
    expect(removals).toHaveLength(1);
    expect(out).not.toContain(WAIT);
    // During that wait, the first check of the schedule starts the run.
    await vi.advanceTimersByTimeAsync(1_000);
    await runStarted;
    removals[0]();
    // Without the change (no second look at `busy` after the removals) the monitor exits here, during the run.
    await vi.waitFor(() => expect(out).toContain(WAIT));
    expect(out).toContain(`Removed the old record of ${A} (no container of it exists).`);
    expect(exited).toBeUndefined();
    expect(out).not.toContain(EXIT);
    finish();
    expect(await result).toBe(0);
    expect(out.indexOf(EXIT)).toBeGreaterThan(out.indexOf('The background run ended.'));
    expect(out.indexOf('The background run ended.')).toBeGreaterThan(-1);
  });
});
