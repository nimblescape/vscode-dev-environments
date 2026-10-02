// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 8, PR A: the heartbeats of a window to the Session Monitor container of the engine of each environment that
// it uses, on every engine (user decisions Q1 and Q4 of 2026-10-02).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remoteContextName, type DockerTarget } from '../docker/dockerHost';
import { Messages } from '../messages';
import type { HeartbeatInput } from '../remoteMonitor/protocol';
import type { Environment, ExtensionSettings } from '../types';
import {
  HEARTBEAT_ATTEMPT_DEADLINE_MS,
  HEARTBEAT_NO_ANSWER,
  HEARTBEAT_WARN_AFTER_FAILURES,
  REPAIR_BACKOFF_MS,
  WINDOW_HEARTBEAT_INTERVAL_MS,
  WindowHeartbeats,
  repairBackoffMs,
  resolveHeartbeatEngine,
  type HeartbeatEngineSources,
  type HeartbeatSendResult,
  type WindowHeartbeatsDeps,
} from './windowHeartbeats';

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
  /** Review round 1 of PR #85 (A-R1-3): the role engineFor was asked for; A-R1-2: the signals of send and repair. */
  const engineRoles: boolean[] = [];
  const signals: AbortSignal[] = [];
  const settings: Pick<ExtensionSettings, 'stopOnClose' | 'respectShutdownActionNone' | 'stopAfterMinutes'> = {
    stopOnClose: true,
    respectShutdownActionNone: false,
    stopAfterMinutes: 10,
  };
  const state = {
    connected: null as string | null,
    answer: (_target: DockerTarget): HeartbeatSendResult | Promise<HeartbeatSendResult> => ({ ok: true }),
    repair: async (_target: DockerTarget): Promise<void> => {},
  };
  const deps: WindowHeartbeatsDeps = {
    owner: () => ({ windowId: WINDOW, pid: PID }),
    connected: () => state.connected,
    registry: { list: async () => environments.map((item) => structuredClone(item)) },
    settings: () => settings,
    sourceId: () => SOURCE,
    engineFor: async (env, use) => {
      engineCalls.push(env.id);
      engineRoles.push(use.connected);
      if (options.engines && env.id in options.engines) return options.engines[env.id];
      return env.dockerHost === 'build-box' ? REMOTE : LOCAL;
    },
    send: async (target, input, signal) => {
      sent.push({ target, input: structuredClone(input) });
      signals.push(signal);
      return state.answer(target);
    },
    repair: async (target, signal) => {
      repairs.push(target);
      signals.push(signal);
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
  return { heartbeats, now, environments, sent, warnings, logs, repairs, engineCalls, engineRoles, signals, settings, state };
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

  // Review round 1 of PR #85, A-R1-2: each attempt is bounded by a deadline, and each engine has its own in-flight guard.
  describe('deadline and per-engine calls (review round 1 of PR #85, A-R1-2)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Lets the pending promise callbacks run (without fake timers). */
    const settle = async (until: () => boolean): Promise<void> => {
      for (let i = 0; i < 100 && !until(); i += 1) await Promise.resolve();
    };

    it('is a deadline well below the smallest limit of 5 minutes', () => {
      expect(HEARTBEAT_ATTEMPT_DEADLINE_MS).toBe(120_000);
      expect(HEARTBEAT_ATTEMPT_DEADLINE_MS).toBeLessThan((5 * 60_000) / 2);
    });

    it('counts a send that hangs past the deadline as a failure, aborts its signal, and warns after 2', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      // A send that never answers, not even to its signal.
      h.state.answer = () => new Promise<HeartbeatSendResult>(() => {});
      const first = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
      await first;
      expect(h.signals[0].aborted).toBe(true);
      expect(h.logs.some((line) => line.includes(HEARTBEAT_NO_ANSWER))).toBe(true);
      expect(h.warnings).toEqual([]);
      // The call still hangs: the next due tick makes no new call on that engine, and counts one more failure.
      h.now.value = T0 + HEARTBEAT_ATTEMPT_DEADLINE_MS + 15_000;
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(1);
      // The limit is 10 minutes from the start of the series; 2 minutes 15 seconds have passed.
      expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', 'the local Docker', 7)]);
    });

    it('counts a repair that hangs past the deadline as a failure, and aborts the signal of the repair', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      h.state.answer = () => ({ ok: false, missing: true, detail: 'No such container' });
      let repairSignal: AbortSignal | undefined;
      h.state.repair = () =>
        new Promise<void>((_resolve, reject) => {
          repairSignal = h.signals[h.signals.length - 1];
          repairSignal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const first = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
      await first;
      expect(repairSignal?.aborted).toBe(true);
      // The aborted repair ended the call: the next tick sends again (no repair within the backoff, A-R1-4) and fails a
      // second time, which warns.
      h.now.value = T0 + 30_000;
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(2);
      expect(h.repairs).toHaveLength(1);
      expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', 'the local Docker', 9)]);
    });

    it('a hanging engine does not block the heartbeats of another engine', async () => {
      vi.useFakeTimers();
      const h = harness();
      const since = new Date(T0).toISOString();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.environments.push(environment(ID_B, 'acme/web', { dockerHost: 'build-box', busy: { operation: 'rebuild', since, pid: PID, windowId: WINDOW } }));
      h.state.connected = ID_A;
      // The remote engine hangs; the local one answers.
      h.state.answer = (target) => (target.kind === 'remote' ? new Promise<HeartbeatSendResult>(() => {}) : { ok: true });
      void h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sent.map((item) => item.target.kind)).toEqual(['local', 'remote']);
      // Later ticks reach the local engine at its interval while the remote call still runs within its deadline.
      h.now.value = T0 + WINDOW_HEARTBEAT_INTERVAL_MS;
      void h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(0);
      h.now.value = T0 + 2 * WINDOW_HEARTBEAT_INTERVAL_MS;
      void h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sent.map((item) => item.target.kind)).toEqual(['local', 'remote', 'local', 'local']);
      expect(h.warnings).toEqual([]);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
    });

    it('never overlaps two calls on the same engine, also not from sendFor', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      const releases: Array<(result: HeartbeatSendResult) => void> = [];
      let active = 0;
      let most = 0;
      h.state.answer = () => {
        active += 1;
        most = Math.max(most, active);
        return new Promise<HeartbeatSendResult>((resolve) => {
          releases.push((result) => {
            active -= 1;
            resolve(result);
          });
        });
      };
      const first = h.heartbeats.tick();
      await settle(() => h.sent.length === 1);
      expect(h.sent).toHaveLength(1);
      // Two more ticks while the call runs: nothing new on that engine.
      h.now.value = T0 + 15_000;
      await h.heartbeats.tick();
      h.now.value = T0 + 30_000;
      await h.heartbeats.tick();
      const flag = h.heartbeats.sendFor(ID_A);
      await settle(() => false);
      expect(h.sent).toHaveLength(1);
      releases[0]({ ok: true });
      await first;
      // sendFor waited for the call of the tick, then sent its own.
      await settle(() => h.sent.length === 2);
      expect(h.sent).toHaveLength(2);
      releases[1]({ ok: true });
      expect(await flag).toEqual({ ok: true });
      expect(most).toBe(1);
    });
  });

  // Review round 1 of PR #85, A-R1-3: the engine of the connected environment is the one of this window's own context.
  describe("the engine of the window's own context (review round 1 of PR #85, A-R1-3)", () => {
    const DESKTOP: DockerTarget = { kind: 'local', host: '', endpoint: 'unix:///home/me/.docker/desktop/docker.sock', context: 'desktop-linux' };
    function sources(options: { own?: string; current: DockerTarget; contexts: Record<string, DockerTarget | undefined> }) {
      const asked: string[] = [];
      const value: HeartbeatEngineSources = {
        windowContext: () => options.own,
        current: async () => options.current,
        ofContext: async (name) => {
          asked.push(name);
          return options.contexts[name];
        },
      };
      return { value, asked };
    }

    it("uses the window's own context for a connected local environment, even when the global context is remote", async () => {
      const s = sources({ own: 'desktop-linux', current: REMOTE, contexts: { 'desktop-linux': DESKTOP } });
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api'), { connected: true }, s.value)).toEqual(DESKTOP);
      expect(s.asked).toEqual(['desktop-linux']);
    });

    it("uses the window's own context also when the global context is another local one", async () => {
      const s = sources({ own: 'desktop-linux', current: LOCAL, contexts: { 'desktop-linux': DESKTOP } });
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api'), { connected: true }, s.value)).toEqual(DESKTOP);
    });

    it("finds no engine when the window's context is not on the host of the environment, or cannot be read", async () => {
      const s = sources({ own: 'desktop-linux', current: LOCAL, contexts: { 'desktop-linux': REMOTE } });
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api'), { connected: true }, s.value)).toBeUndefined();
      const t = sources({ own: 'gone', current: LOCAL, contexts: {} });
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api'), { connected: true }, t.value)).toBeUndefined();
    });

    it('without a context of its own: the current target on the host, else the context `default` for the local Docker', async () => {
      const s = sources({ current: REMOTE, contexts: { default: LOCAL } });
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api'), { connected: true }, s.value)).toEqual(LOCAL);
      expect(s.asked).toEqual(['default']);
      const t = sources({ current: DESKTOP, contexts: {} });
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api'), { connected: true }, t.value)).toEqual(DESKTOP);
    });

    it('a remote environment: its own context, else the context of its host', async () => {
      const own: DockerTarget = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box', context: 'my-box' };
      const s = sources({ own: 'my-box', current: LOCAL, contexts: { 'my-box': own } });
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api', { dockerHost: 'build-box' }), { connected: true }, s.value)).toEqual(own);
      const t = sources({ current: LOCAL, contexts: {} });
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api', { dockerHost: 'build-box' }), { connected: true }, t.value)).toEqual({
        kind: 'remote',
        host: 'build-box',
        endpoint: 'ssh://build-box',
        context: remoteContextName('build-box'),
      });
    });

    it('an environment this window is only busy with: the target of the operation on its host, not the context of the window', async () => {
      const s = sources({ own: 'desktop-linux', current: LOCAL, contexts: { 'desktop-linux': DESKTOP } });
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api'), { connected: false }, s.value)).toEqual(LOCAL);
      expect(s.asked).toEqual([]);
      const t = sources({ current: REMOTE, contexts: { default: LOCAL } });
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api'), { connected: false }, t.value)).toBeUndefined();
    });

    it('asks engineFor with the role of each environment', async () => {
      const h = harness();
      const since = new Date(T0).toISOString();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.environments.push(environment(ID_B, 'acme/web', { busy: { operation: 'rebuild', since, pid: PID, windowId: WINDOW } }));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      expect(h.engineRoles).toEqual([true, false]);
    });

    it('counts an engine that cannot be found for the connected environment as a failure, and warns after 2', async () => {
      const h = harness({ engines: { [ID_A]: undefined } });
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      expect(h.warnings).toEqual([]);
      h.now.value = T0 + 15_000;
      await h.heartbeats.tick();
      expect(h.sent).toEqual([]);
      expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', 'the local Docker', 9)]);
      // Once per streak.
      h.now.value = T0 + 30_000;
      await h.heartbeats.tick();
      expect(h.warnings).toHaveLength(1);
    });

    it('takes the time left from the last successful heartbeat of the environment', async () => {
      const engines: Record<string, DockerTarget | undefined> = {};
      const h = harness({ engines });
      // The open of this window (its busy mark) sent a heartbeat at T0; then the window connects, and the engine of its
      // own context cannot be found.
      h.environments.push(environment(ID_A, 'acme/api', { busy: { operation: 'create', since: new Date(T0).toISOString(), pid: PID, windowId: WINDOW } }));
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(1);
      engines[ID_A] = undefined;
      h.state.connected = ID_A;
      h.now.value = T0 + 3 * 60_000;
      await h.heartbeats.tick();
      h.now.value = T0 + 3 * 60_000 + 15_000;
      await h.heartbeats.tick();
      expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', 'the local Docker', 6)]);
    });

    it('does not warn for an environment this window is only busy with whose engine cannot be found', async () => {
      const h = harness({ engines: { [ID_A]: undefined } });
      h.environments.push(environment(ID_A, 'acme/api', { busy: { operation: 'update', since: new Date(T0).toISOString(), pid: PID, windowId: WINDOW } }));
      for (let i = 0; i < 3; i += 1) {
        h.now.value = T0 + i * 15_000;
        await h.heartbeats.tick();
      }
      expect(h.warnings).toEqual([]);
    });
  });

  // Review round 1 of PR #85, A-R1-4: after a failed repair, the next one waits 1, 2, then 5 minutes; a success resets.
  describe('repair backoff (review round 1 of PR #85, A-R1-4)', () => {
    it('waits 1, 2, then 5 minutes after failed repairs, and still sends the plain heartbeat at each tick', async () => {
      expect(REPAIR_BACKOFF_MS).toEqual([60_000, 120_000, 300_000]);
      expect([1, 2, 3, 4, 9].map(repairBackoffMs)).toEqual([60_000, 120_000, 300_000, 300_000, 300_000]);
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      h.state.answer = () => ({ ok: false, missing: true, detail: 'No such container' });
      h.state.repair = async () => {
        throw new Error('docker run failed');
      };
      const repairTimes: number[] = [];
      let ticks = 0;
      for (let t = 0; t <= 10 * 60_000; t += 15_000) {
        h.now.value = T0 + t;
        const before = h.repairs.length;
        await h.heartbeats.tick();
        ticks += 1;
        if (h.repairs.length > before) repairTimes.push(t);
      }
      // A send at every tick (a failure is due again at once), without a second send after a failed repair.
      expect(h.sent).toHaveLength(ticks);
      // Repairs at 0, 1 minute later, 2 minutes after that, then every 5 minutes.
      expect(repairTimes).toEqual([0, 60_000, 180_000, 480_000]);
    });

    it('resets the backoff after a success', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      let missing = true;
      let failRepair = true;
      h.state.answer = () => (missing ? { ok: false, missing: true, detail: 'No such container' } : { ok: true });
      h.state.repair = async () => {
        if (failRepair) throw new Error('docker run failed');
        missing = false;
      };
      await h.heartbeats.tick();
      h.now.value = T0 + 60_000;
      await h.heartbeats.tick();
      expect(h.repairs).toHaveLength(2);
      // The second repair failed too, so the next one would wait 2 minutes; the monitor answers again meanwhile.
      missing = false;
      h.now.value = T0 + 75_000;
      await h.heartbeats.tick();
      // Missing again: the repair is tried at once (the success reset the backoff), and succeeds.
      missing = true;
      failRepair = false;
      h.now.value = T0 + 75_000 + WINDOW_HEARTBEAT_INTERVAL_MS;
      await h.heartbeats.tick();
      expect(h.repairs).toHaveLength(3);
      expect(h.warnings).toHaveLength(1);
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
