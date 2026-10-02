// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 8, PR A: the heartbeats of a window to the Session Monitor container of the engine of each environment that
// it uses, on every engine (user decisions Q1 and Q4 of 2026-10-02).
import { describe, expect, it } from 'vitest';
import type { DockerTarget } from '../docker/dockerHost';
import { Messages } from '../messages';
import type { HeartbeatInput } from '../remoteMonitor/protocol';
import type { Environment, ExtensionSettings } from '../types';
import { HEARTBEAT_WARN_AFTER_FAILURES, WINDOW_HEARTBEAT_INTERVAL_MS, WindowHeartbeats, type HeartbeatSendResult, type WindowHeartbeatsDeps } from './windowHeartbeats';

const ID_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ID_B = '7c1d2e3f-0000-4000-8000-000000000002';
const SOURCE = '0123456789abcdef0123456789abcdef';
const T0 = Date.parse('2026-10-02T10:00:00.000Z');
const WINDOW = 'window-1';
const PID = 4242;

const LOCAL: DockerTarget = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock', context: 'default' };
const REMOTE: DockerTarget = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box', context: 'devenv-remote-11111111' };

function environment(id: string, repository: string, extra: Partial<Environment> = {}): Environment {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devenv-${id}`,
    containerName: `devenv-${id}`,
    owner: { id: '1', login: 'octo' },
    createdAt: '2026-10-01T10:00:00.000Z',
    ...extra,
  } as Environment;
}

interface Sent {
  target: DockerTarget;
  input: HeartbeatInput;
}

function harness(options: { engines?: Record<string, DockerTarget | undefined> } = {}) {
  const now = { value: T0 };
  const environments: Environment[] = [];
  const sent: Sent[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  const repairs: DockerTarget[] = [];
  const engineCalls: string[] = [];
  const settings: Pick<ExtensionSettings, 'stopOnClose' | 'respectShutdownActionNone' | 'stopAfterMinutes'> = {
    stopOnClose: true,
    respectShutdownActionNone: false,
    stopAfterMinutes: 10,
  };
  const state = {
    connected: null as string | null,
    answer: (_target: DockerTarget): HeartbeatSendResult => ({ ok: true }),
    repair: async (_target: DockerTarget): Promise<void> => {},
  };
  const deps: WindowHeartbeatsDeps = {
    owner: () => ({ windowId: WINDOW, pid: PID }),
    connected: () => state.connected,
    registry: { list: async () => environments.map((item) => structuredClone(item)) },
    settings: () => settings,
    sourceId: () => SOURCE,
    engineFor: async (env) => {
      engineCalls.push(env.id);
      if (options.engines && env.id in options.engines) return options.engines[env.id];
      return env.dockerHost === 'build-box' ? REMOTE : LOCAL;
    },
    send: async (target, input) => {
      sent.push({ target, input: structuredClone(input) });
      return state.answer(target);
    },
    repair: async (target) => {
      repairs.push(target);
      return state.repair(target);
    },
    warn: (message) => warnings.push(message),
    logger: {
      info: (message) => logs.push(`info ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
      error: (message) => logs.push(`error ${message}`),
      output: () => {},
    },
    clock: { now: () => now.value },
  };
  const heartbeats = new WindowHeartbeats(deps);
  return { heartbeats, now, environments, sent, warnings, logs, repairs, engineCalls, settings, state };
}

const entriesOf = (item: Sent) => item.input.environments.map(({ id, keepRunning }) => ({ id, keepRunning }));

describe('WindowHeartbeats (plan step 8, PR A)', () => {
  it('sends nothing without an environment of this window', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    await h.heartbeats.tick();
    expect(h.sent).toEqual([]);
  });

  it('sends the heartbeat of the connected environment at once, then every 30 seconds, with the long limit (Q1)', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].input).toEqual({ source: SOURCE, limitSeconds: 600, environments: [{ id: ID_A, keepRunning: false, seq: T0 }] });
    // The window's tick is 15 s: the next one is not due yet.
    h.now.value = T0 + 15_000;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(1);
    h.now.value = T0 + WINDOW_HEARTBEAT_INTERVAL_MS;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].input.environments[0].seq).toBe(T0 + WINDOW_HEARTBEAT_INTERVAL_MS);
  });

  it('uses the setting stopAfterMinutes for the limit, and sends at once when it changes', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    h.settings.stopAfterMinutes = 30;
    await h.heartbeats.tick();
    expect(h.sent[0].input.limitSeconds).toBe(1800);
    h.settings.stopAfterMinutes = 15;
    h.now.value = T0 + 15_000;
    await h.heartbeats.tick();
    expect(h.sent.map((item) => item.input.limitSeconds)).toEqual([1800, 900]);
  });

  it('sends at once when a keep flag changes (series and flag change of MonitorLoop.sendHeartbeat)', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    h.environments[0].keepRunning = true;
    h.now.value = T0 + 15_000;
    await h.heartbeats.tick();
    expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_A, keepRunning: false }], [{ id: ID_A, keepRunning: true }]]);
    // Unchanged again: nothing before the interval.
    h.now.value = T0 + 30_000;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(2);
    // No longer kept: sent at once without the flag; then stopOnClose off counts as kept.
    h.environments[0].keepRunning = undefined;
    h.now.value = T0 + 31_000;
    await h.heartbeats.tick();
    h.settings.stopOnClose = false;
    h.now.value = T0 + 32_000;
    await h.heartbeats.tick();
    expect(h.sent.slice(2).map(entriesOf)).toEqual([[{ id: ID_A, keepRunning: false }], [{ id: ID_A, keepRunning: true }]]);
  });

  it('also reports an environment that this window holds a live busy mark for, and not one of another window or an ended mark', async () => {
    const h = harness();
    const since = new Date(T0 - 60_000).toISOString();
    h.environments.push(environment(ID_A, 'acme/api', { busy: { operation: 'update', since, pid: PID, windowId: WINDOW } }));
    h.environments.push(environment(ID_B, 'acme/web', { busy: { operation: 'update', since, pid: 1, windowId: 'other' } }));
    h.environments.push(environment('8d2e3f40-0000-4000-8000-000000000003', 'acme/lib', { busy: { operation: 'create', since: new Date(0).toISOString(), pid: PID, windowId: WINDOW } }));
    await h.heartbeats.tick();
    expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_A, keepRunning: false }]]);
  });

  it('routes each heartbeat to the engine the window opened the environment on, asked once', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api', { dockerHost: 'build-box' }));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    h.now.value = T0 + WINDOW_HEARTBEAT_INTERVAL_MS;
    await h.heartbeats.tick();
    expect(h.sent.map((item) => item.target)).toEqual([REMOTE, REMOTE]);
    expect(h.engineCalls).toEqual([ID_A]);
  });

  it('sends to the local Docker for a local environment, and one heartbeat per engine', async () => {
    const h = harness();
    const since = new Date(T0).toISOString();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.environments.push(environment(ID_B, 'acme/web', { dockerHost: 'build-box', busy: { operation: 'rebuild', since, pid: PID, windowId: WINDOW } }));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    expect(h.sent.map((item) => [item.target.kind, entriesOf(item)])).toEqual([
      ['local', [{ id: ID_A, keepRunning: false }]],
      ['remote', [{ id: ID_B, keepRunning: false }]],
    ]);
  });

  it('sends nothing for an environment whose engine cannot be reached, and logs it once', async () => {
    const h = harness({ engines: { [ID_A]: undefined } });
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    h.now.value = T0 + WINDOW_HEARTBEAT_INTERVAL_MS;
    await h.heartbeats.tick();
    expect(h.sent).toEqual([]);
    expect(h.logs.filter((line) => line.includes('cannot be reached from this window'))).toHaveLength(1);
  });

  it('starts a missing monitor again (repair) and sends the heartbeat once more (Q4)', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    let missing = true;
    h.state.answer = () => (missing ? { ok: false, missing: true, detail: 'No such container: devenv-session-monitor' } : { ok: true });
    h.state.repair = async () => {
      missing = false;
    };
    await h.heartbeats.tick();
    expect(h.repairs).toEqual([LOCAL]);
    expect(h.sent).toHaveLength(2);
    expect(h.warnings).toEqual([]);
  });

  it('does not repair after another failure (the worker repairs itself on the send)', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    h.state.answer = () => ({ ok: false, missing: false, detail: 'the worker could not be prepared' });
    await h.heartbeats.tick();
    expect(h.repairs).toEqual([]);
  });

  it('warns after 2 failures in a row with the time left, once per failure streak, and clears on success (Q4)', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    h.state.answer = () => ({ ok: false, missing: false, detail: 'ssh: connect to host build-box: timed out' });
    // Failures are tried again at each tick of the window (15 s).
    h.now.value = T0 + 30_000;
    await h.heartbeats.tick();
    expect(h.warnings).toEqual([]);
    expect(HEARTBEAT_WARN_AFTER_FAILURES).toBe(2);
    h.now.value = T0 + 45_000;
    await h.heartbeats.tick();
    // The last success was at T0 with a limit of 10 minutes: 9 minutes and 15 seconds are left.
    expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', 'the local Docker', 9)]);
    h.now.value = T0 + 60_000;
    await h.heartbeats.tick();
    expect(h.warnings).toHaveLength(1);
    // Success ends the streak; the next streak warns again.
    h.state.answer = () => ({ ok: true });
    h.now.value = T0 + 75_000;
    await h.heartbeats.tick();
    expect(h.logs.some((line) => line.includes('answers again'))).toBe(true);
    h.state.answer = () => ({ ok: false, missing: false, detail: 'timed out' });
    h.now.value = T0 + 105_000;
    await h.heartbeats.tick();
    h.now.value = T0 + 120_000;
    await h.heartbeats.tick();
    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[1]).toBe(Messages.heartbeatsFailing('acme/api', 'the local Docker', 9));
  });

  it('warns for a failed repair, and says "at any moment" when the limit has passed', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api', { dockerHost: 'build-box' }));
    h.state.connected = ID_A;
    h.settings.stopAfterMinutes = 5;
    h.state.answer = () => ({ ok: false, missing: true, detail: 'No such container: devenv-session-monitor' });
    h.state.repair = async () => {
      throw new Error('docker run failed: no space left on device');
    };
    await h.heartbeats.tick();
    h.now.value = T0 + 6 * 60_000;
    await h.heartbeats.tick();
    expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', 'build-box', 0)]);
    expect(h.warnings[0]).toContain('at any moment');
    expect(h.logs.some((line) => line.includes('no space left on device'))).toBe(true);
  });

  it('warns only for the connected environment, not for one this window is busy with', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api', { busy: { operation: 'update', since: new Date(T0).toISOString(), pid: PID, windowId: WINDOW } }));
    h.state.answer = () => ({ ok: false, missing: false, detail: 'timed out' });
    for (let i = 0; i < 4; i += 1) {
      h.now.value = T0 + i * 15_000;
      await h.heartbeats.tick();
    }
    expect(h.sent).toHaveLength(4);
    expect(h.warnings).toEqual([]);
  });

  it('skips a tick while the previous one runs', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    h.state.repair = () => blocked;
    h.state.answer = () => ({ ok: false, missing: true, detail: 'No such container' });
    const first = h.heartbeats.tick();
    await Promise.resolve();
    await h.heartbeats.tick();
    release();
    await first;
    // The first tick: the send, the repair, the send again; the second tick did nothing.
    expect(h.sent).toHaveLength(2);
  });

  describe('sendFor (Close and Keep Running, Keep Running When Closed)', () => {
    it('sends one heartbeat with the current flag at once, to the engine of the environment', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api', { dockerHost: 'build-box', keepRunningOnce: true }));
      expect(await h.heartbeats.sendFor(ID_A)).toEqual({ ok: true });
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].target).toEqual(REMOTE);
      expect(h.sent[0].input).toEqual({ source: SOURCE, limitSeconds: 600, environments: [{ id: ID_A, keepRunning: true, seq: T0 }] });
    });

    it('on the local Docker too, with the repair of a missing monitor', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api', { keepRunning: true }));
      let missing = true;
      h.state.answer = () => (missing ? { ok: false, missing: true, detail: 'No such container' } : { ok: true });
      h.state.repair = async () => {
        missing = false;
      };
      expect(await h.heartbeats.sendFor(ID_A)).toEqual({ ok: true });
      expect(h.repairs).toEqual([LOCAL]);
      expect(h.sent.map((item) => item.target)).toEqual([LOCAL, LOCAL]);
    });

    it('gives the cause of a failure, and of an environment that is gone', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.answer = () => ({ ok: false, missing: false, detail: 'timed out' });
      expect(await h.heartbeats.sendFor(ID_A)).toEqual({ ok: false, detail: 'timed out' });
      expect(await h.heartbeats.sendFor(ID_B)).toMatchObject({ ok: false });
    });

    it('a flag that sendFor sent is not sent again by the next tick before the interval', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      h.environments[0].keepRunning = true;
      h.now.value = T0 + 5_000;
      await h.heartbeats.sendFor(ID_A);
      h.now.value = T0 + 15_000;
      await h.heartbeats.tick();
      expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_A, keepRunning: false }], [{ id: ID_A, keepRunning: true }]]);
    });
  });

  it('sends nothing after dispose', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    h.heartbeats.dispose();
    await h.heartbeats.tick();
    expect(h.sent).toEqual([]);
  });
});
