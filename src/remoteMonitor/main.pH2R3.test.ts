// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 3 of 11H2 (reviewer B, mutation testing): while an idle monitor waits for a background run (round 2,
// A2-M1), each tick of its loop is followed by one wait of the tick interval: no tick follows another without that wait
// (a loop that ticks back to back lists the containers of the engine without a pause for as long as the run takes), and
// the wait is the tick, not longer. The volume is a temporary folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { main, vscodeBackgroundDeps } from './main';
import { REMOTE_TICK_MS } from './rules';

const T0 = Date.parse('2026-10-09T10:00:00Z');
const WAIT = 'a background run is running; the Session Monitor exits after its end.';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-monitor-ph2r3-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('11H2 review round 3 (B): the ticks of an idle monitor while a background run runs', () => {
  it('waits REMOTE_TICK_MS after each tick during the run (never ticks back to back, never waits longer)', async () => {
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
    let out = '';
    // The loop's steps while it waits: 'tick' for each list of the containers, the length of each sleep.
    const steps: Array<'tick' | number> = [];
    const waiting = () => out.includes(WAIT);
    const result = main(['run'], {
      env: { DEVENV_IMAGE_FIRST_MS: '1000' },
      stateDir,
      engine: {
        ...unusedEngine(),
        containerSummaries: async (): Promise<EngineContainerSummary[]> => {
          if (waiting()) steps.push('tick');
          return [];
        },
      },
      vscodeBackground: () => vscode,
      lockEnvironment: async () => ({ kind: 'locked', release: () => {} }),
      exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
      monotonic: () => mono,
      now: () => T0 + mono,
      sleep: async (ms) => {
        if (waiting()) steps.push(ms);
        mono += ms;
        if (mono === ms) await runStarted;
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      out: (text) => (out += text),
    });
    await vi.waitFor(() => expect(out).toContain('first check in 1 s'));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(out).toContain(WAIT));
    await vi.waitFor(() => expect(steps.filter((step) => step === 'tick').length).toBeGreaterThanOrEqual(10), { timeout: 4_000 });
    finish();
    expect(await result).toBe(0);
    // The first step may be the sleep after the tick that logged the wait; then tick and sleep alternate, and the last
    // tick is the one after the run that exits.
    const during = steps[0] === 'tick' ? steps : steps.slice(1);
    const ticks = during.filter((step) => step === 'tick').length;
    expect(ticks).toBeGreaterThanOrEqual(10);
    for (let i = 0; i + 1 < during.length; i += 2) {
      expect(during[i], `step ${i}`).toBe('tick');
      expect(during[i + 1], `step ${i + 1}`).toBe(REMOTE_TICK_MS);
    }
  });
});
