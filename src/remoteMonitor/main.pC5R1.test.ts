// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup C5 (plan step 11J, C1), review B: probes of the wiring that the tests of the PR left open:
// `monitor.js run` reads the tags of its image maintenance through the proxy of the daemon of its engine by default
// (MainDeps.registryTransport unset), and daemonProxyTransport reads that proxy within BACKGROUND_ENGINE_TIMEOUT_MS.
// The volume is a temporary folder; the registry is 127.0.0.1:1 (refused at once); nothing needs root.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_LIST_FILE } from '../core/remoteMonitor/protocol';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { BACKGROUND_ENGINE_TIMEOUT_MS } from './background';
import { daemonProxyTransport, main } from './main';

const T0 = Date.parse('2026-10-10T10:00:00Z');
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-monitor-pc5r1-'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('the registry requests of monitor.js run (review round 1 of cleanup C5, B)', () => {
  it('go through the proxy of the daemon of the engine by default', async () => {
    fs.writeFileSync(path.join(stateDir, IMAGE_LIST_FILE), JSON.stringify({ repositories: ['127.0.0.1:1/team/app'] }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    let proxyReads = 0;
    let mono = 0;
    let out = '';
    void main(['run'], {
      env: { DEVENV_MONITOR_PERMANENT: '1', DEVENV_IMAGE_FIRST_MS: '1000', DEVENV_IMAGE_PREFIXES: JSON.stringify(['127.0.0.1:1/team/']) },
      stateDir,
      engine: {
        ...unusedEngine(),
        containerSummaries: async (): Promise<EngineContainerSummary[]> => [],
        images: async () => [],
        proxy: async () => (proxyReads++, {}),
      },
      vscodeBackground: () => undefined,
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
    await vi.waitFor(() => expect(out).toContain('first check in 1 s'));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(out).toContain('The background run ended.'), { timeout: 4_000 });
    expect(out).toContain('The tags of 127.0.0.1:1/team/app could not be read; it is not updated: ');
    expect(proxyReads).toBe(1);
  });
});

describe('daemonProxyTransport (review round 1 of cleanup C5, B)', () => {
  it('reads the proxy of the daemon within BACKGROUND_ENGINE_TIMEOUT_MS', async () => {
    const original = AbortSignal.timeout.bind(AbortSignal);
    const limits: AbortSignal[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const signal = original(ms);
      if (ms === BACKGROUND_ENGINE_TIMEOUT_MS) limits.push(signal);
      return signal;
    });
    const given: (AbortSignal | undefined)[] = [];
    const transport = daemonProxyTransport({ proxy: async (signal) => (given.push(signal), {}) });
    await transport.request({ method: 'GET', url: 'https://127.0.0.1:1/v2/', headers: {} }).catch(() => undefined);
    expect(given).toHaveLength(1);
    expect(limits).toContain(given[0]);
  });
});
