// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 8, PR A: the heartbeats of a window to the Session Monitor container of the engine of each environment that
// it uses, on every engine (user decisions Q1 and Q4 of 2026-10-02).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeDockerHost, remoteContextNames, type DockerTarget } from '../docker/dockerHost';
import { HELPER_PREBUILD_TIMEOUT_MS } from '../helper/helperPrebuild';
import { abortError, isAbortError } from '../ports';
import { Messages } from '../messages';
import type { HeartbeatInput } from '../remoteMonitor/protocol';
import type { Environment, ExtensionSettings } from '../types';
import {
  HEARTBEAT_ATTEMPT_DEADLINE_MS,
  HEARTBEAT_NO_ANSWER,
  HEARTBEAT_WARN_AFTER_FAILURES,
  LOOKUP_ABANDON_MS,
  REPAIR_BACKOFF_MS,
  WINDOW_HEARTBEAT_INTERVAL_MS,
  WindowHeartbeats,
  engineKey,
  repairBackoffMs,
  resolveHeartbeatEngine,
  type HeartbeatEngineSources,
  type HeartbeatSendResult,
  type WindowHeartbeatsDeps,
} from './windowHeartbeats';
import { HeartbeatPreparation } from './heartbeatPreparation';
import { BUSY_MARK_MAX_AGE_MS } from '../busy';
import { errorMessage } from '../errors';
import { MAX_HEARTBEAT_ENVIRONMENTS, parseHeartbeatInput } from '../remoteMonitor/protocol';

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
    answer: (_target: DockerTarget, _signal?: AbortSignal): HeartbeatSendResult | Promise<HeartbeatSendResult> => ({ ok: true }),
    repair: async (_target: DockerTarget): Promise<void> => {},
    /** Review round 2 of PR #85, A-R2-1: whether the container of an environment is on an engine (default: yes). */
    containerExists: (_target: DockerTarget, _environment: Environment): boolean | Promise<boolean> => true,
    /** Review round 3 of PR #85: runs at each read of the registry (an advancing clock). */
    onList: () => {},
    /** Review round 3 of PR #85 (B-R3-6): replaces the answer of engineFor. */
    lookUp: undefined as ((environment: Environment, use: { connected: boolean }) => Promise<DockerTarget | undefined>) | undefined,
  };
  const containerChecks: Array<{ target: DockerTarget; id: string }> = [];
  /** Review round 3 of PR #85 (W75): the signals of the checks of a container. */
  const checkSignals: AbortSignal[] = [];
  const deps: WindowHeartbeatsDeps = {
    owner: () => ({ windowId: WINDOW, pid: PID }),
    connected: () => state.connected,
    registry: {
      list: async () => {
        state.onList();
        return environments.map((item) => structuredClone(item));
      },
    },
    settings: () => settings,
    sourceId: () => SOURCE,
    engineFor: async (env, use) => {
      engineCalls.push(env.id);
      engineRoles.push(use.connected);
      if (state.lookUp !== undefined) return state.lookUp(env, use);
      if (options.engines && env.id in options.engines) return options.engines[env.id];
      return env.dockerHost === 'build-box' ? REMOTE : LOCAL;
    },
    send: async (target, input, signal) => {
      sent.push({ target, input: structuredClone(input) });
      signals.push(signal);
      return state.answer(target, signal);
    },
    repair: async (target, signal) => {
      repairs.push(target);
      signals.push(signal);
      return state.repair(target);
    },
    containerExists: async (target, env, signal) => {
      containerChecks.push({ target, id: env.id });
      checkSignals.push(signal);
      return state.containerExists(target, env);
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
  return { heartbeats, deps, now, environments, sent, warnings, logs, repairs, engineCalls, engineRoles, signals, settings, state, containerChecks, checkSignals };
}

// Changed helper, plan step 8 PR C: the entries of the environments the window uses. The clear-only entries that the
// first heartbeat of a series carries for the environments of this computer that are not kept (the replacement of the
// full sync) are left out here and checked by their own tests (clearsOf).
const entriesOf = (item: Sent) => item.input.environments.filter((entry) => entry.clearOnly !== true).map(({ id, keepRunning }) => ({ id, keepRunning }));
/** Plan step 8, PR C: the ids of the clear-only entries of a heartbeat. */
const clearsOf = (item: Sent) => item.input.environments.filter((entry) => entry.clearOnly === true).map(({ id }) => id);

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
    // Changed expectation, review round 2 of PR #85, A-R2-1: the engine of the connected environment is first checked for
    // its container, so its heartbeat now comes after the one of the other engine (the engines run at the same time).
    expect(h.sent.map((item) => [item.target.kind, entriesOf(item)])).toEqual([
      ['remote', [{ id: ID_B, keepRunning: false }]],
      ['local', [{ id: ID_A, keepRunning: false }]],
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
      // Changed expectation, review round 2 of PR #85, A-R2-1: the connected environment's engine is checked for its
      // container first, so its heartbeat comes after the one of the other engine.
      expect(h.sent.map((item) => item.target.kind)).toEqual(['remote', 'local']);
      // Later ticks reach the local engine at its interval while the remote call still runs within its deadline.
      h.now.value = T0 + WINDOW_HEARTBEAT_INTERVAL_MS;
      void h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(0);
      h.now.value = T0 + 2 * WINDOW_HEARTBEAT_INTERVAL_MS;
      void h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(0);
      // Changed expectation, review round 2 of PR #85, A-R2-1 (the order of the first tick, see above).
      expect(h.sent.map((item) => item.target.kind)).toEqual(['remote', 'local', 'local', 'local']);
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
    // User decisions 2026-10-03: the context of a host comes from ensureRemoteContext (remoteContext; before:
    // remoteContextName); `remote` answers per host, by default the first name of remoteContextNames.
    function sources(options: { own?: string; current: DockerTarget; contexts: Record<string, DockerTarget | undefined>; remote?: Record<string, string | undefined> }) {
      const asked: string[] = [];
      const remoteAsked: string[] = [];
      const value: HeartbeatEngineSources = {
        windowContext: () => options.own,
        current: async () => options.current,
        ofContext: async (name) => {
          asked.push(name);
          return options.contexts[name];
        },
        remoteContext: async (host) => {
          remoteAsked.push(host);
          return options.remote === undefined ? remoteContextNames(host)[0] : options.remote[host];
        },
      };
      return { value, asked, remoteAsked };
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
        // User decisions 2026-10-03: the context named after the host (remoteContextNames; before: remoteContextName).
        context: remoteContextNames('build-box')[0],
      });
      expect(s.remoteAsked).toEqual([]);
      expect(t.remoteAsked).toEqual(['build-box']);
    });

    // User decisions 2026-10-03: the context of the host as ensureRemoteContext gives it (for example the name with the
    // pair of the host on a clash); no engine when it cannot be had.
    it('a remote environment without its own context: the context that remoteContext gives, none when it gives none', async () => {
      const remote = environment(ID_A, 'acme/api', { dockerHost: 'me@build-box:2222' });
      const pair = remoteContextNames('me@build-box:2222')[1];
      const s = sources({ current: LOCAL, contexts: {}, remote: { 'me@build-box:2222': pair } });
      expect(await resolveHeartbeatEngine(remote, { connected: true }, s.value)).toEqual({
        kind: 'remote',
        host: 'me@build-box:2222',
        endpoint: 'ssh://me@build-box:2222',
        context: pair,
      });
      const t = sources({ current: LOCAL, contexts: {}, remote: {} });
      expect(await resolveHeartbeatEngine(remote, { connected: true }, t.value)).toBeUndefined();
      expect(await resolveHeartbeatEngine(remote, { connected: false }, t.value)).toBeUndefined();
      expect(t.remoteAsked).toEqual(['me@build-box:2222', 'me@build-box:2222']);
      // A local environment never asks for the context of a host.
      const u = sources({ current: REMOTE, contexts: { default: LOCAL }, remote: {} });
      expect(await resolveHeartbeatEngine(environment(ID_B, 'acme/web'), { connected: true }, u.value)).toEqual(LOCAL);
      expect(u.remoteAsked).toEqual([]);
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

  // Review round 2 of PR #85, A-R2-1: the engine found for the connected environment is trusted only when its container
  // is there; never a repair on an engine where the environments of the heartbeat have no container.
  describe("the engine has the environment's container (review round 2 of PR #85, A-R2-1)", () => {
    it('a connected local environment whose container is not on the resolved engine: no heartbeat, no repair, a warning after 2', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      // The resolved engine has no monitor either: a repair there would start one for nothing.
      h.state.answer = () => ({ ok: false, missing: true, detail: 'No such container' });
      h.state.containerExists = () => false;
      await h.heartbeats.tick();
      expect(h.sent).toEqual([]);
      expect(h.repairs).toEqual([]);
      expect(h.warnings).toEqual([]);
      h.now.value = T0 + 15_000;
      await h.heartbeats.tick();
      expect(h.sent).toEqual([]);
      expect(h.repairs).toEqual([]);
      // 10 minutes from the start of the streak, 15 seconds passed.
      expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', describeDockerHost(''), 9)]);
      expect(h.logs.some((line) => line.includes(`its container devenv-${ID_A} is not on the local Docker`))).toBe(true);
      // Each tick checks again (the engine is resolved again too); one warning per streak.
      expect(h.containerChecks).toHaveLength(2);
      expect(h.engineCalls).toEqual([ID_A, ID_A]);
      h.now.value = T0 + 30_000;
      await h.heartbeats.tick();
      expect(h.warnings).toHaveLength(1);
    });

    it('a connected environment whose container is there: the heartbeat is sent, and the engine is checked again only after a failure', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(1);
      expect(h.containerChecks).toEqual([{ target: LOCAL, id: ID_A }]);
      h.now.value = T0 + WINDOW_HEARTBEAT_INTERVAL_MS;
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(2);
      expect(h.containerChecks).toHaveLength(1);
      // A failed heartbeat: the next tick checks the engine again before it sends.
      h.state.answer = () => ({ ok: false, missing: false, detail: 'timed out' });
      h.now.value = T0 + 2 * WINDOW_HEARTBEAT_INTERVAL_MS;
      await h.heartbeats.tick();
      expect(h.containerChecks).toHaveLength(1);
      h.state.answer = () => ({ ok: true });
      h.now.value = T0 + 2 * WINDOW_HEARTBEAT_INTERVAL_MS + 15_000;
      await h.heartbeats.tick();
      expect(h.containerChecks).toHaveLength(2);
      expect(h.sent).toHaveLength(4);
      expect(h.warnings).toEqual([]);
    });

    it('a failed check counts as an absent container', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      h.state.containerExists = () => Promise.reject(new Error('Cannot connect to the Docker daemon'));
      await h.heartbeats.tick();
      h.now.value = T0 + 15_000;
      await h.heartbeats.tick();
      expect(h.sent).toEqual([]);
      expect(h.warnings).toHaveLength(1);
    });

    it('still sends for a busy environment on that engine without the connected one', async () => {
      const h = harness();
      const since = new Date(T0).toISOString();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.environments.push(environment(ID_B, 'acme/web', { busy: { operation: 'rebuild', since, pid: PID, windowId: WINDOW } }));
      h.state.connected = ID_A;
      h.state.containerExists = (_target, env) => env.id === ID_B;
      await h.heartbeats.tick();
      expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_B, keepRunning: false }]]);
    });

    it('never repairs for a busy environment whose container is not on the engine; repairs when it is', async () => {
      const h = harness();
      const since = new Date(T0).toISOString();
      h.environments.push(environment(ID_B, 'acme/web', { dockerHost: 'build-box', busy: { operation: 'rebuild', since, pid: PID, windowId: WINDOW } }));
      h.state.answer = () => ({ ok: false, missing: true, detail: 'No such container' });
      h.state.containerExists = () => false;
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(1);
      expect(h.repairs).toEqual([]);
      expect(h.containerChecks).toEqual([{ target: REMOTE, id: ID_B }]);
      h.state.containerExists = () => true;
      h.now.value = T0 + 15_000;
      await h.heartbeats.tick();
      expect(h.repairs).toEqual([REMOTE]);
    });

    it('sendFor of the connected environment sends nothing to an engine without its container', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      h.state.containerExists = () => false;
      expect(await h.heartbeats.sendFor(ID_A)).toEqual({ ok: false, detail: 'The container of the environment is not on the local Docker.' });
      expect(h.sent).toEqual([]);
    });
  });

  // Review round 2 of PR #85, A-R2-2: the deadline of an attempt ends only the heartbeat's wait, not the build of the
  // helper image that the heartbeat started (HeartbeatPreparation, as extension.ts wires it into the worker's prepare).
  describe('the preparation outlives the deadline (review round 2 of PR #85, A-R2-2)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A shared build like HelperImages': started once, cancelled only by the signal of the caller that started it. */
    function sharedBuild() {
      const build = { count: 0, signal: undefined as AbortSignal | undefined, finish: () => {}, pending: undefined as Promise<void> | undefined };
      const ensure = (signal: AbortSignal | undefined): Promise<void> => {
        if (build.pending === undefined) {
          build.count += 1;
          build.signal = signal;
          build.pending = new Promise<void>((resolve, reject) => {
            build.finish = () => {
              build.pending = undefined;
              resolve();
            };
            signal?.addEventListener('abort', () => {
              build.pending = undefined;
              reject(abortError());
            });
          });
        }
        return build.pending;
      };
      return { build, ensure };
    }

    it('a build that a heartbeat started survives the deadline, and the next attempt joins it (one build)', async () => {
      vi.useFakeTimers();
      const h = harness();
      const preparation = new HeartbeatPreparation();
      const { build, ensure } = sharedBuild();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      // The send makes the worker ready first: its prepare runs in the scope of the heartbeat.
      h.state.answer = (_target, signal) =>
        preparation.scope(() => preparation.prepare(ensure, signal)).then((): HeartbeatSendResult => ({ ok: true }));
      const first = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
      await first;
      expect(h.signals[0].aborted).toBe(true);
      expect(build.count).toBe(1);
      expect(build.signal?.aborted).toBe(false);
      expect(h.logs.some((line) => line.includes(HEARTBEAT_NO_ANSWER))).toBe(true);
      // The next attempt joins the build that runs.
      h.now.value = T0 + HEARTBEAT_ATTEMPT_DEADLINE_MS + 15_000;
      const second = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sent).toHaveLength(2);
      expect(build.count).toBe(1);
      build.finish();
      await second;
      expect(build.count).toBe(1);
      expect(h.logs.some((line) => line.includes('answers again'))).toBe(true);
      expect(h.warnings).toEqual([]);
      preparation.dispose();
    });

    it('the long signal ends after HELPER_PREBUILD_TIMEOUT_MS, and dispose aborts it', async () => {
      vi.useFakeTimers();
      const preparation = new HeartbeatPreparation();
      const signals: AbortSignal[] = [];
      const work = (signal: AbortSignal): Promise<void> => {
        signals.push(signal);
        return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError())));
      };
      const timedOut = preparation.run(work, undefined);
      timedOut.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(HELPER_PREBUILD_TIMEOUT_MS - 1);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0].aborted).toBe(true);
      await expect(timedOut).rejects.toThrow('cancelled');
      // Dispose (the window closes): a preparation that runs is aborted, also when nobody waits for it anymore.
      const wait = new AbortController();
      const running = preparation.run(work, wait.signal);
      running.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      wait.abort();
      await expect(running).rejects.toThrow('cancelled');
      expect(signals[1].aborted).toBe(false);
      preparation.dispose();
      expect(signals[1].aborted).toBe(true);
      // After dispose, a new preparation starts aborted.
      const late = preparation.run(work, undefined);
      late.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(signals[2].aborted).toBe(true);
    });

    it('outside the scope of a heartbeat, the preparation gets the signal of its caller', async () => {
      const preparation = new HeartbeatPreparation();
      const caller = new AbortController();
      let given: AbortSignal | undefined;
      await preparation.prepare(async (signal) => {
        given = signal;
      }, caller.signal);
      expect(given).toBe(caller.signal);
      await preparation.scope(() =>
        preparation.prepare(async (signal) => {
          given = signal;
        }, caller.signal),
      );
      expect(given).not.toBe(caller.signal);
      preparation.dispose();
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

// Review rounds 1 and 3 of PR #85: the rules of the heartbeats that the mutation tests of these rounds found untested.
describe('WindowHeartbeats rules found by mutation (review rounds 1 and 3 of PR #85)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets the pending promise callbacks run (without fake timers). */
  const settle = async (until: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !until(); i += 1) await Promise.resolve();
  };
  const DESKTOP: DockerTarget = { kind: 'local', host: '', endpoint: 'unix:///home/me/.docker/desktop/docker.sock', context: 'desktop-linux' };
  const busyMark = (extra: Partial<{ since: string; pid: number; windowId: string }> = {}) => ({
    busy: { operation: 'update' as const, since: new Date(T0).toISOString(), pid: PID, windowId: WINDOW, ...extra },
  });
  const failed = (detail = 'timed out'): HeartbeatSendResult => ({ ok: false, missing: false, detail });
  const missingMonitor: HeartbeatSendResult = { ok: false, missing: true, detail: 'No such container: devenv-session-monitor' };

  describe('round 3', () => {
    it('sendFor fails at once for a call of a tick that passed its deadline, and sends nothing (W95)', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      h.state.answer = () => new Promise<HeartbeatSendResult>(() => {});
      const first = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
      await first;
      let answer: unknown;
      void h.heartbeats.sendFor(ID_A).then((value) => (answer = value));
      await vi.advanceTimersByTimeAsync(0);
      expect(answer).toEqual({ ok: false, detail: HEARTBEAT_NO_ANSWER });
      expect(h.sent).toHaveLength(1);
    });

    it('a check of the container past the deadline: no heartbeat, no repair, its signal aborted, a failure (W73, W75)', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      h.state.answer = () => missingMonitor;
      h.state.containerExists = () => new Promise<boolean>(() => {});
      const first = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS - 1);
      expect(h.checkSignals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await first;
      // W75: the inspect is ended at the deadline, not left running.
      expect(h.checkSignals[0].aborted).toBe(true);
      expect(h.sent).toEqual([]);
      expect(h.repairs).toEqual([]);
      h.now.value = T0 + HEARTBEAT_ATTEMPT_DEADLINE_MS + 15_000;
      const second = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
      await second;
      expect(h.sent).toEqual([]);
      expect(h.repairs).toEqual([]);
      expect(h.warnings).toHaveLength(1);
    });

    it('an unverified connected environment and a busy one on its engine, both without their container: no repair (W64)', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.environments.push(environment(ID_B, 'acme/web', busyMark()));
      h.state.connected = ID_A;
      h.state.answer = () => missingMonitor;
      h.state.containerExists = () => false;
      await h.heartbeats.tick();
      expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_B, keepRunning: false }]]);
      expect(h.repairs).toEqual([]);
    });

    it('sendFor of an environment this window does not show, without its container on the engine: no repair (W99)', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api', busyMark()));
      h.state.answer = () => missingMonitor;
      h.state.containerExists = () => false;
      expect(await h.heartbeats.sendFor(ID_A)).toMatchObject({ ok: false });
      expect(h.sent).toHaveLength(1);
      expect(h.repairs).toEqual([]);
    });

    it('a check of the container that rejects at the repair: no repair (W90)', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api', busyMark()));
      h.state.answer = () => missingMonitor;
      h.state.containerExists = () => Promise.reject(new Error('Cannot connect to the Docker daemon'));
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(1);
      expect(h.repairs).toEqual([]);
    });

    it('a slow heartbeat (60 s) within its deadline is no failure: one send, no warning at the ticks while it runs (W21)', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      h.state.answer = () => new Promise<HeartbeatSendResult>((resolve) => setTimeout(() => resolve({ ok: true }), 60_000));
      const first = h.heartbeats.tick();
      for (const t of [15_000, 30_000, 45_000]) {
        await vi.advanceTimersByTimeAsync(15_000);
        h.now.value = T0 + t;
        await h.heartbeats.tick();
      }
      expect(h.sent).toHaveLength(1);
      expect(h.warnings).toEqual([]);
      expect(h.logs.filter((line) => line.includes('failed'))).toEqual([]);
      await vi.advanceTimersByTimeAsync(15_000);
      await first;
      expect(h.warnings).toEqual([]);
    });

    it('sends a heartbeat when the clock was set back by an hour (W26)', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      h.now.value = T0 - 60 * 60_000;
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(2);
    });

    it('fail, succeed, fail: no warning, and nothing is sent 15 s after the success (W31)', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      h.state.answer = () => failed();
      h.now.value = T0 + 30_000;
      await h.heartbeats.tick();
      h.state.answer = () => ({ ok: true });
      h.now.value = T0 + 45_000;
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(3);
      h.state.answer = () => failed();
      h.now.value = T0 + 60_000;
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(3);
      h.now.value = T0 + 75_000;
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(4);
      expect(h.warnings).toEqual([]);
    });

    it('re-resolves and re-checks the engine of an environment that the window used again on another engine (W101, W41)', async () => {
      const engines: Record<string, DockerTarget | undefined> = { [ID_A]: LOCAL };
      const h = harness({ engines });
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      h.state.connected = null;
      h.now.value = T0 + 15_000;
      await h.heartbeats.tick();
      engines[ID_A] = DESKTOP;
      h.state.connected = ID_A;
      h.now.value = T0 + 30_000;
      await h.heartbeats.tick();
      expect(h.engineCalls).toEqual([ID_A, ID_A]);
      expect(h.containerChecks.map((check) => check.target)).toEqual([LOCAL, DESKTOP]);
      expect(h.sent.map((item) => item.target)).toEqual([LOCAL, DESKTOP]);
    });

    it('a check of an engine marks only that engine, not the one remembered meanwhile (W69)', async () => {
      const engines: Record<string, DockerTarget | undefined> = { [ID_A]: LOCAL };
      const h = harness({ engines });
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      const checks = new Map<string, (present: boolean) => void>();
      h.state.containerExists = (target) => new Promise<boolean>((resolve) => checks.set(target.context ?? '', resolve));
      const first = h.heartbeats.tick();
      await settle(() => checks.has('default'));
      // The window leaves the environment and shows it again on another engine while the first check still runs.
      h.state.connected = null;
      h.now.value = T0 + 15_000;
      await h.heartbeats.tick();
      engines[ID_A] = DESKTOP;
      h.state.connected = ID_A;
      h.now.value = T0 + 30_000;
      const third = h.heartbeats.tick();
      await settle(() => checks.has('desktop-linux'));
      checks.get('default')?.(true);
      await first;
      // The engine DESKTOP is not checked yet: sendFor joins its check and sends nothing before it.
      const flag = h.heartbeats.sendFor(ID_A);
      await settle(() => false);
      expect(h.sent.filter((item) => item.target.context === 'desktop-linux')).toEqual([]);
      checks.get('desktop-linux')?.(false);
      await third;
      expect(await flag).toMatchObject({ ok: false });
      expect(h.sent.filter((item) => item.target.context === 'desktop-linux')).toEqual([]);
    });

    it('warns again for a new streak of an unresolved engine after the window left the environment (W50)', async () => {
      const h = harness({ engines: { [ID_A]: undefined } });
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      h.now.value = T0 + 15_000;
      await h.heartbeats.tick();
      expect(h.warnings).toHaveLength(1);
      h.state.connected = null;
      h.now.value = T0 + 30_000;
      await h.heartbeats.tick();
      h.state.connected = ID_A;
      h.now.value = T0 + 45_000;
      await h.heartbeats.tick();
      h.now.value = T0 + 60_000;
      await h.heartbeats.tick();
      expect(h.warnings).toHaveLength(2);
    });

    it('takes the time left from the limit of the last successful heartbeat (W38)', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      h.settings.stopAfterMinutes = 30;
      h.state.answer = () => failed();
      h.now.value = T0 + 15_000;
      await h.heartbeats.tick();
      h.now.value = T0 + 30_000;
      await h.heartbeats.tick();
      // The monitor holds the limit of 10 minutes from T0: 9 minutes 30 seconds are left (not 29 minutes).
      expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', 'the local Docker', 9)]);
    });

    it('resolveHeartbeatEngine: a remote environment this window is busy with, the current target local: the context of its host (E07)', async () => {
      // User decisions 2026-10-03: the context of the host from ensureRemoteContext (remoteContext).
      const value: HeartbeatEngineSources = {
        windowContext: () => undefined,
        current: async () => LOCAL,
        ofContext: async () => undefined,
        remoteContext: async (host) => remoteContextNames(host)[0],
      };
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api', { dockerHost: 'build-box' }), { connected: false }, value)).toEqual({
        kind: 'remote',
        host: 'build-box',
        endpoint: 'ssh://build-box',
        // User decisions 2026-10-03: the context named after the host (remoteContextNames; before: remoteContextName).
        context: remoteContextNames('build-box')[0],
      });
    });

    it('resolveHeartbeatEngine: the context `default` on a remote engine is no engine for a local environment (E09)', async () => {
      const value: HeartbeatEngineSources = {
        windowContext: () => undefined,
        current: async () => REMOTE,
        ofContext: async () => REMOTE,
        remoteContext: async () => {
          throw new Error('a local environment asks for no context of a host');
        },
      };
      expect(await resolveHeartbeatEngine(environment(ID_A, 'acme/api'), { connected: true }, value)).toBeUndefined();
    });
  });

  // Review round 3 of PR #85 (B-R3-6): the lookup of an engine is bounded and never stops the other heartbeats.
  describe('the lookup of the engine is bounded (review round 3 of PR #85, B-R3-6)', () => {
    it('a lookup past the deadline counts as an engine not found; the others are sent at once; no second lookup piles up', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.environments.push(environment(ID_B, 'acme/web', { dockerHost: 'build-box', ...busyMark() }));
      h.state.connected = ID_A;
      h.state.lookUp = async (env) => (env.id === ID_A ? new Promise<DockerTarget | undefined>(() => {}) : REMOTE);
      const first = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
      await first;
      expect(h.sent.map((item) => [item.target, entriesOf(item)])).toEqual([[REMOTE, [{ id: ID_B, keepRunning: false }]]]);
      expect(h.warnings).toEqual([]);
      expect(h.logs.some((line) => line.includes(`The Docker engine of acme/api could not be found: ${HEARTBEAT_NO_ANSWER}`))).toBe(true);
      // The lookup still hangs: the next tick counts it at once as a failure (the warning), without a new lookup.
      h.now.value = T0 + HEARTBEAT_ATTEMPT_DEADLINE_MS + 15_000;
      await h.heartbeats.tick();
      expect(h.engineCalls.filter((id) => id === ID_A)).toHaveLength(1);
      expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', 'the local Docker', 7)]);
    });

    it('lookups that hang run at the same time: the heartbeat of another engine waits one deadline, not one per lookup', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.environments.push(environment(ID_B, 'acme/web', { dockerHost: 'build-box', ...busyMark() }));
      h.environments.push(environment('8d2e3f40-0000-4000-8000-000000000003', 'acme/lib', busyMark()));
      h.state.connected = ID_A;
      h.state.lookUp = async (env) => (env.id === ID_A || env.id === ID_B ? new Promise<DockerTarget | undefined>(() => {}) : LOCAL);
      const first = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
      expect(h.sent.map(entriesOf)).toEqual([[{ id: '8d2e3f40-0000-4000-8000-000000000003', keepRunning: false }]]);
      await first;
    });

    it('a lookup that throws counts as an engine not found and stops no other heartbeat', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.environments.push(environment(ID_B, 'acme/web', busyMark()));
      h.state.connected = ID_A;
      h.state.lookUp = async (env) => {
        if (env.id === ID_A) throw new Error('docker context inspect crashed');
        return LOCAL;
      };
      await h.heartbeats.tick();
      h.now.value = T0 + WINDOW_HEARTBEAT_INTERVAL_MS;
      await h.heartbeats.tick();
      expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_B, keepRunning: false }], [{ id: ID_B, keepRunning: false }]]);
      expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', 'the local Docker', 9)]);
      expect(h.logs.some((line) => line.includes('docker context inspect crashed'))).toBe(true);
      // A lookup that ended is asked again at the next tick.
      expect(h.engineCalls.filter((id) => id === ID_A)).toHaveLength(2);
    });

    it('sendFor with a lookup that throws gives a failure, never a rejection', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.lookUp = async () => {
        throw new Error('boom');
      };
      expect(await h.heartbeats.sendFor(ID_A)).toEqual({ ok: false, detail: 'The Docker engine of the environment cannot be reached from this window.' });
      expect(h.sent).toEqual([]);
    });
  });

  // Review round 3 of PR #85 (A-R3-1): a failed build of the helper image for a heartbeat backs off per engine.
  describe('the preparation of a heartbeat backs off per engine (review round 3 of PR #85, A-R3-1)', () => {
    function preparedHarness() {
      const h = harness();
      const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => h.now.value });
      const builds: number[] = [];
      const build = { fails: true };
      h.state.answer = (target, signal) =>
        preparation
          .scope(() =>
            preparation.prepare(
              // Review round 4 of PR #85, A-R4-1: only a failure after the build started (onBuild) starts the wait, so this
              // work reports its build; without a presence check (no `present`) a heartbeat within the wait is refused.
              async (_signal, onBuild) => {
                builds.push(h.now.value - T0);
                onBuild();
                if (build.fails) throw new Error('docker build failed: no space left on device');
              },
              signal,
              target,
            ),
          )
          .then(
            (): HeartbeatSendResult => ({ ok: true }),
            (error: unknown): HeartbeatSendResult => failed(`the helper image could not be prepared: ${errorMessage(error)}`),
          );
      return { h, preparation, builds, build };
    }

    it('builds again only after 1, 2, then 5 minutes; each heartbeat in the wait fails at once and counts (Q4); a success resets', async () => {
      const { h, preparation, builds, build } = preparedHarness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      let ticks = 0;
      for (let t = 0; t < 480_000; t += 15_000) {
        h.now.value = T0 + t;
        await h.heartbeats.tick();
        ticks += 1;
      }
      // A send at each tick (each fails), a build at 0, 1 minute later, 2 minutes after that, then after 5 minutes.
      expect(h.sent).toHaveLength(ticks);
      expect(builds).toEqual([0, 60_000, 180_000]);
      expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', 'the local Docker', 9)]);
      expect(h.logs.some((line) => line.includes('prepared again in'))).toBe(true);
      build.fails = false;
      h.now.value = T0 + 480_000;
      await h.heartbeats.tick();
      expect(builds).toEqual([0, 60_000, 180_000, 480_000]);
      expect(h.logs.some((line) => line.includes('answers again'))).toBe(true);
      // The success reset the wait: the next failure builds at once, then waits 1 minute again.
      build.fails = true;
      h.now.value = T0 + 480_000 + WINDOW_HEARTBEAT_INTERVAL_MS;
      await h.heartbeats.tick();
      h.now.value = T0 + 480_000 + WINDOW_HEARTBEAT_INTERVAL_MS + 15_000;
      await h.heartbeats.tick();
      expect(builds).toEqual([0, 60_000, 180_000, 480_000, 510_000]);
      for (let t = 540_000; t <= 570_000; t += 15_000) {
        h.now.value = T0 + t;
        await h.heartbeats.tick();
      }
      expect(builds).toEqual([0, 60_000, 180_000, 480_000, 510_000, 570_000]);
      preparation.dispose();
    });

    it('waits per engine, and never for the preparation of an operation (outside the scope of a heartbeat)', async () => {
      const now = { value: T0 };
      const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => now.value });
      let builds = 0;
      // Review round 4 of PR #85, A-R4-1: only a failed build (after onBuild) starts the wait, so the work reports it.
      const failing = async (_signal: AbortSignal | undefined, onBuild: () => void): Promise<void> => {
        builds += 1;
        onBuild();
        throw new Error('build failed');
      };
      await expect(preparation.scope(() => preparation.prepare(failing, undefined, LOCAL))).rejects.toThrow('build failed');
      await expect(preparation.scope(() => preparation.prepare(failing, undefined, LOCAL))).rejects.toThrow('prepared again in 60 seconds');
      expect(builds).toBe(1);
      // Another engine has its own wait; an operation of the user (no heartbeat scope) never waits.
      await expect(preparation.scope(() => preparation.prepare(failing, undefined, REMOTE))).rejects.toThrow('build failed');
      await expect(preparation.prepare(failing, undefined, LOCAL)).rejects.toThrow('build failed');
      expect(builds).toBe(3);
      // The build of a repair (run) shares the wait of its engine.
      await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('prepared again');
      now.value = T0 + 60_000;
      await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('build failed');
      await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('prepared again in 120 seconds');
      expect(builds).toBe(4);
      preparation.dispose();
    });

    it('preparations that fail together count once', async () => {
      const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => T0 });
      // Review round 4 of PR #85, A-R4-1: only a failed build (after onBuild) starts the wait, so the work reports it.
      const failing = async (_signal: AbortSignal, onBuild: () => void): Promise<void> => {
        onBuild();
        await Promise.resolve();
        throw new Error('build failed');
      };
      await Promise.allSettled([preparation.run(failing, undefined, LOCAL), preparation.run(failing, undefined, LOCAL)]);
      await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('prepared again in 60 seconds');
      preparation.dispose();
    });

    it('removes its dispose listener when the work ends: a later dispose does not abort the signal of a finished work (P11)', async () => {
      const preparation = new HeartbeatPreparation();
      let given: AbortSignal | undefined;
      await preparation.run(async (signal) => {
        given = signal;
      }, undefined);
      preparation.dispose();
      expect(given?.aborted).toBe(false);
    });
  });

  describe('round 1', () => {
    it('two remote engines: one series each, each heartbeat with only its own environment (W43)', async () => {
      // User decisions 2026-10-03: the context named after the host (remoteContextNames; before: remoteContextName).
      const OTHER_BOX: DockerTarget = { kind: 'remote', host: 'other-box', endpoint: 'ssh://other-box', context: remoteContextNames('other-box')[0] };
      const h = harness({ engines: { [ID_B]: OTHER_BOX } });
      h.environments.push(environment(ID_A, 'acme/api', { dockerHost: 'build-box' }));
      h.environments.push(environment(ID_B, 'acme/web', { dockerHost: 'other-box', ...busyMark() }));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      expect(h.sent.map((item) => [item.target.host, entriesOf(item)])).toEqual([
        ['other-box', [{ id: ID_B, keepRunning: false }]],
        ['build-box', [{ id: ID_A, keepRunning: false }]],
      ]);
    });

    it('two contexts of the same host are two engines (W42)', async () => {
      const MY_BOX: DockerTarget = { kind: 'remote', host: 'build-box', endpoint: 'ssh://me@build-box', context: 'my-box' };
      const h = harness({ engines: { [ID_A]: MY_BOX } });
      h.environments.push(environment(ID_A, 'acme/api', { dockerHost: 'build-box' }));
      h.environments.push(environment(ID_B, 'acme/web', { dockerHost: 'build-box', ...busyMark() }));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      expect(h.sent.map((item) => [item.target.context, entriesOf(item)])).toEqual([
        [REMOTE.context, [{ id: ID_B, keepRunning: false }]],
        ['my-box', [{ id: ID_A, keepRunning: false }]],
      ]);
    });

    it('the tick sends keepRunningOnce as kept (W11)', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api', { keepRunningOnce: true }));
      h.state.connected = ID_A;
      await h.heartbeats.tick();
      expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_A, keepRunning: true }]]);
    });

    it('sendFor sends keepRunning false without a keep flag, and false again after Keep Running is removed (W46)', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      await h.heartbeats.sendFor(ID_A);
      h.environments[0].keepRunning = true;
      await h.heartbeats.sendFor(ID_A);
      h.environments[0].keepRunning = undefined;
      await h.heartbeats.sendFor(ID_A);
      expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_A, keepRunning: false }], [{ id: ID_A, keepRunning: true }], [{ id: ID_A, keepRunning: false }]]);
    });

    it('leaves out an ID that the monitor cannot record, in the tick (W07) and in sendFor (W45)', async () => {
      const h = harness();
      h.environments.push(environment('legacy-1', 'acme/old', busyMark()));
      h.environments.push(environment(ID_A, 'acme/api', busyMark()));
      await h.heartbeats.tick();
      expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_A, keepRunning: false }]]);
      expect(await h.heartbeats.sendFor('legacy-1')).toEqual({ ok: false, detail: 'The environment has an ID that the Session Monitor cannot record.' });
      expect(h.sent).toHaveLength(1);
    });

    it(`sends at most ${MAX_HEARTBEAT_ENVIRONMENTS} environments to one engine (W08, W09)`, async () => {
      const h = harness();
      for (let i = 0; i <= MAX_HEARTBEAT_ENVIRONMENTS; i += 1) {
        h.environments.push(environment(`${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, `acme/r${i}`, busyMark()));
      }
      await h.heartbeats.tick();
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].input.environments).toHaveLength(MAX_HEARTBEAT_ENVIRONMENTS);
    });

    it('takes seq before the registry is read, in the tick (W19) and in sendFor (W51)', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      h.state.onList = () => {
        h.now.value += 1_000;
      };
      await h.heartbeats.tick();
      expect(h.sent[0].input.environments[0].seq).toBe(T0);
      const before = h.now.value;
      await h.heartbeats.sendFor(ID_A);
      expect(h.sent[1].input.environments[0].seq).toBe(before);
    });

    it('a busy mark of another process, of another window, or from beyond its life in the future does not count (W03, W04, W06)', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api', busyMark({ pid: PID + 1 })));
      h.environments.push(environment(ID_B, 'acme/web', busyMark({ windowId: 'window-2' })));
      h.environments.push(environment('8d2e3f40-0000-4000-8000-000000000003', 'acme/lib', busyMark({ since: new Date(T0 + BUSY_MARK_MAX_AGE_MS + 60_000).toISOString() })));
      await h.heartbeats.tick();
      expect(h.sent).toEqual([]);
    });
  });
  // Review round 4 of PR #85 (A-R4-1): the wait exists only to avoid repeated builds of the helper image; it never holds
  // back a heartbeat that needs no build.
  describe('only a failed build backs off, and never a heartbeat whose image is present (review round 4 of PR #85, A-R4-1)', () => {
    const IMAGE = { tag: 'devenv-helper:0123456789ab', id: 'sha256:1111' };
    type Image = typeof IMAGE;

    /** A heartbeat's send that prepares the worker like extension.ts does (ensureImagePresent, presentImage in the wait). */
    function imageHarness() {
      const h = harness();
      const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => h.now.value });
      const engine = { reachable: true, present: false, buildFails: true };
      const builds: number[] = [];
      const attempts: number[] = [];
      const checks: number[] = [];
      // ensureImagePresent: the presence query first (it fails when the engine does not answer), then the build.
      const work = async (_signal: AbortSignal | undefined, onBuild: () => void): Promise<Image> => {
        attempts.push(h.now.value - T0);
        if (!engine.reachable) throw new Error('ssh: connect to host build-box port 22: Connection refused');
        if (engine.present) return IMAGE;
        onBuild();
        builds.push(h.now.value - T0);
        if (engine.buildFails) throw new Error('docker build failed: no space left on device');
        engine.present = true;
        return IMAGE;
      };
      // presentImage: never builds; undefined when the tag is missing or cannot be checked.
      const present = async (): Promise<Image | undefined> => {
        checks.push(h.now.value - T0);
        return engine.reachable && engine.present ? IMAGE : undefined;
      };
      h.state.answer = (target, signal) =>
        preparation
          .scope(() => preparation.prepare(work, signal, target, present))
          .then(
            (): HeartbeatSendResult => ({ ok: true }),
            (error: unknown): HeartbeatSendResult => failed(`the helper image could not be prepared: ${errorMessage(error)}`),
          );
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      const tickAt = async (t: number): Promise<void> => {
        h.now.value = T0 + t;
        await h.heartbeats.tick();
      };
      return { h, preparation, engine, builds, attempts, checks, work, tickAt };
    }

    it('failures of an unreachable engine start no wait: after the recovery the next tick sends its heartbeat', async () => {
      const { h, preparation, engine, builds, attempts, tickAt } = imageHarness();
      engine.reachable = false;
      engine.present = true;
      await tickAt(0);
      await tickAt(WINDOW_HEARTBEAT_INTERVAL_MS);
      await tickAt(2 * WINDOW_HEARTBEAT_INTERVAL_MS);
      expect(attempts).toEqual([0, WINDOW_HEARTBEAT_INTERVAL_MS, 2 * WINDOW_HEARTBEAT_INTERVAL_MS]);
      expect(h.logs.some((line) => line.includes('prepared again in'))).toBe(false);
      engine.reachable = true;
      await tickAt(3 * WINDOW_HEARTBEAT_INTERVAL_MS);
      expect(attempts).toHaveLength(4);
      expect(builds).toEqual([]);
      expect(h.logs.some((line) => line.includes('answers again'))).toBe(true);
      preparation.dispose();
    });

    it('within the wait after a failed build, a heartbeat goes on when the image is present (and the wait ends)', async () => {
      const { h, preparation, engine, builds, checks, tickAt } = imageHarness();
      // Two failed builds: a wait until 3 minutes.
      await tickAt(0);
      await tickAt(30_000);
      await tickAt(60_000);
      expect(builds).toEqual([0, 60_000]);
      // Another window (or an operation) built the tag meanwhile.
      engine.present = true;
      await tickAt(90_000);
      expect(checks).toEqual([30_000, 90_000]);
      expect(builds).toEqual([0, 60_000]);
      expect(h.logs.some((line) => line.includes('answers again'))).toBe(true);
      // The presence ended the wait: when the tag is gone again, the next heartbeat builds at once.
      engine.present = false;
      await tickAt(120_000);
      expect(builds).toEqual([0, 60_000, 120_000]);
      preparation.dispose();
    });

    it('within the wait after a failed build, a heartbeat whose image is missing is refused and starts no build', async () => {
      const { h, preparation, builds, checks, attempts, tickAt } = imageHarness();
      await tickAt(0);
      await tickAt(WINDOW_HEARTBEAT_INTERVAL_MS);
      expect(builds).toEqual([0]);
      expect(attempts).toEqual([0]);
      expect(checks).toEqual([WINDOW_HEARTBEAT_INTERVAL_MS]);
      expect(h.logs.some((line) => line.includes('prepared again in 30 seconds') && line.includes('not on the Docker engine'))).toBe(true);
      preparation.dispose();
    });

    it("an operation's successful preparation (outside the scope of a heartbeat) ends the wait", async () => {
      const { preparation, engine, builds, checks, work, tickAt } = imageHarness();
      await tickAt(0);
      engine.buildFails = false;
      await preparation.prepare(work, undefined, LOCAL);
      expect(builds).toEqual([0, 0]);
      // The tag is gone again: the next heartbeat builds at once (no wait, no presence check).
      engine.present = false;
      await tickAt(WINDOW_HEARTBEAT_INTERVAL_MS);
      expect(builds).toEqual([0, 0, WINDOW_HEARTBEAT_INTERVAL_MS]);
      expect(checks).toEqual([]);
      preparation.dispose();
    });

    it('a failed build still waits 1, 2, then 5 minutes (only the presence is checked within), and a success resets', async () => {
      const { h, preparation, engine, builds, checks, tickAt } = imageHarness();
      for (let t = 0; t < 480_000; t += WINDOW_HEARTBEAT_INTERVAL_MS) await tickAt(t);
      expect(builds).toEqual([0, 60_000, 180_000]);
      // Each tick within a wait checked the presence only.
      expect(checks).toHaveLength(480_000 / WINDOW_HEARTBEAT_INTERVAL_MS - 3);
      expect(h.warnings).toEqual([Messages.heartbeatsFailing('acme/api', 'the local Docker', 9)]);
      engine.buildFails = false;
      await tickAt(480_000);
      expect(builds).toEqual([0, 60_000, 180_000, 480_000]);
      // The success reset the wait: the next failed build waits 1 minute again.
      engine.present = false;
      engine.buildFails = true;
      await tickAt(510_000);
      await tickAt(540_000);
      await tickAt(570_000);
      expect(builds).toEqual([0, 60_000, 180_000, 480_000, 510_000, 570_000]);
      preparation.dispose();
    });

    it('clear and clearAll end the wait (a build that succeeded, onImageBuilt)', async () => {
      const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => T0 });
      let builds = 0;
      const failing = async (_signal: AbortSignal, onBuild: () => void): Promise<void> => {
        builds += 1;
        onBuild();
        throw new Error('build failed');
      };
      await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('build failed');
      await expect(preparation.run(failing, undefined, REMOTE)).rejects.toThrow('build failed');
      await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('prepared again');
      preparation.clear(LOCAL);
      await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('build failed');
      await expect(preparation.run(failing, undefined, REMOTE)).rejects.toThrow('prepared again');
      preparation.clearAll();
      await expect(preparation.run(failing, undefined, REMOTE)).rejects.toThrow('build failed');
      expect(builds).toBe(4);
      preparation.dispose();
    });
  });

  // Review round 4 of PR #85: the rules that the mutation tests of this round found untested.
  describe('round 4', () => {
    it('a failed build that settles after a newer success starts no wait (B-R4-3)', async () => {
      const now = { value: T0 };
      const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => now.value });
      const failing = async (_signal: AbortSignal, onBuild: () => void): Promise<void> => {
        onBuild();
        throw new Error('build failed');
      };
      await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('build failed');
      now.value = T0 + 60_000;
      // A slow build that fails, and a newer one that succeeds before it.
      let failSlow: () => void = () => {};
      const slow = preparation.run(
        (_signal, onBuild) =>
          new Promise<void>((_resolve, reject) => {
            onBuild();
            failSlow = () => reject(new Error('build failed late'));
          }),
        undefined,
        LOCAL,
      );
      slow.catch(() => undefined);
      // Review round 5 of PR #85 (A-R5-1): a heartbeat's preparation on LOCAL now joins the slow one, so the newer success
      // is the one of an operation of the user (outside the scope of a heartbeat), which ends the wait too.
      await preparation.prepare(async (_signal, onBuild) => onBuild(), undefined, LOCAL);
      failSlow();
      await expect(slow).rejects.toThrow('build failed late');
      // The success ended the wait; the late failure does not start a new one.
      let ran = false;
      await preparation.run(
        async () => {
          ran = true;
        },
        undefined,
        LOCAL,
      );
      expect(ran).toBe(true);
      preparation.dispose();
    });

    it('a wait that was aborted before the preparation rejects at once, runs nothing and keeps the wait as it is (B-R4-5)', async () => {
      const now = { value: T0 };
      const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => now.value });
      let calls = 0;
      const failing = async (_signal: AbortSignal, onBuild: () => void): Promise<void> => {
        calls += 1;
        onBuild();
        throw new Error('build failed');
      };
      await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('build failed');
      now.value = T0 + 60_000;
      const aborted = new AbortController();
      aborted.abort();
      const error = await preparation.run(failing, aborted.signal, LOCAL).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      expect(isAbortError(error)).toBe(true);
      expect(calls).toBe(1);
      // Still 1 failure: the next build after the wait fails into a wait of 2 minutes.
      await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('build failed');
      await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('prepared again in 120 seconds');
      preparation.dispose();
    });

    it('the lookup of the connected environment does not join an expired lookup of its busy role (B-R4-2)', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api', busyMark()));
      h.state.lookUp = async (_env, use) => (use.connected ? LOCAL : new Promise<DockerTarget | undefined>(() => {}));
      const first = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
      await first;
      expect(h.sent).toEqual([]);
      h.state.connected = ID_A;
      h.now.value = T0 + HEARTBEAT_ATTEMPT_DEADLINE_MS + 15_000;
      const second = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(0);
      await second;
      expect(h.engineRoles).toEqual([false, true]);
      expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_A, keepRunning: false }]]);
    });

    it('an engineFor that throws at once for one environment stops no other heartbeat; sendFor gives a failure (B-R4-4)', async () => {
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.environments.push(environment(ID_B, 'acme/web', busyMark()));
      h.state.connected = ID_A;
      const asked = h.deps.engineFor;
      h.deps.engineFor = (env, use) => {
        if (env.id === ID_A) throw new Error('context store broken');
        return asked(env, use);
      };
      await h.heartbeats.tick();
      expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_B, keepRunning: false }]]);
      expect(h.logs.some((line) => line.includes('context store broken'))).toBe(true);
      expect(await h.heartbeats.sendFor(ID_A)).toEqual({ ok: false, detail: 'The Docker engine of the environment cannot be reached from this window.' });
    });

    it('the deadline of a lookup that answered is cleared: no false log of an engine not found (B-R4-6)', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      const first = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(0);
      await first;
      expect(h.sent).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
      expect(h.logs.some((line) => line.includes('could not be found'))).toBe(false);
    });

    it('a lookup that never settles is given up LOOKUP_ABANDON_MS after it started: then a new one starts', async () => {
      vi.useFakeTimers();
      const h = harness();
      h.environments.push(environment(ID_A, 'acme/api'));
      h.state.connected = ID_A;
      let hang = true;
      h.state.lookUp = async () => (hang ? new Promise<DockerTarget | undefined>(() => {}) : LOCAL);
      const first = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
      await first;
      h.now.value = T0 + LOOKUP_ABANDON_MS - 1;
      await h.heartbeats.tick();
      expect(h.engineCalls).toHaveLength(1);
      hang = false;
      h.now.value = T0 + LOOKUP_ABANDON_MS;
      const third = h.heartbeats.tick();
      await vi.advanceTimersByTimeAsync(0);
      await third;
      expect(h.engineCalls).toHaveLength(2);
      expect(h.sent.map(entriesOf)).toEqual([[{ id: ID_A, keepRunning: false }]]);
    });
  });
});

// Review round 5 of PR #85: rules found by mutation.
describe('WindowHeartbeats rules found by mutation (review round 5 of PR #85)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A preparation whose engine LOCAL waits after a failed build. */
  async function waitingPreparation(): Promise<HeartbeatPreparation> {
    const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => T0 });
    const failing = async (_signal: AbortSignal, onBuild: () => void): Promise<void> => {
      onBuild();
      throw new Error('build failed');
    };
    await expect(preparation.run(failing, undefined, LOCAL)).rejects.toThrow('build failed');
    return preparation;
  }

  it('within the wait, a presence check that never settles ends with the wait: an AbortError at once (B-R5-5, P08)', async () => {
    const preparation = await waitingPreparation();
    const wait = new AbortController();
    const waiting = preparation.run(async () => undefined, wait.signal, LOCAL, () => new Promise<undefined>(() => {}));
    const outcome = waiting.then(
      () => 'resolved',
      (error: unknown) => (isAbortError(error) ? 'abort' : 'other'),
    );
    wait.abort();
    const first = await Promise.race([outcome, new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 50))]);
    expect(first).toBe('abort');
    preparation.dispose();
  });

  it('within the wait, the presence check gets the signal of the wait (B-R5-5, P09)', async () => {
    const preparation = await waitingPreparation();
    const wait = new AbortController();
    const got: (AbortSignal | undefined)[] = [];
    await expect(
      preparation.run(async () => 'built', wait.signal, LOCAL, async (signal) => {
        got.push(signal);
        return 'present';
      }),
    ).resolves.toBe('present');
    expect(got).toEqual([wait.signal]);
    preparation.dispose();
  });

  it('a heartbeat on an engine whose build runs joins it, with no second build; it starts again once the build settled (A-R5-1)', async () => {
    const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => T0 });
    let builds = 0;
    let finish: (value: string) => void = () => {};
    const work = (_signal: AbortSignal, onBuild: () => void): Promise<string> => {
      builds += 1;
      onBuild();
      return new Promise<string>((resolve) => (finish = resolve));
    };
    const deadline = new AbortController();
    const first = preparation.run(work, deadline.signal, LOCAL);
    first.catch(() => undefined);
    await Promise.resolve();
    deadline.abort();
    await expect(first).rejects.toSatisfy(isAbortError);
    const second = preparation.run(work, undefined, LOCAL);
    const other = preparation.run(async () => 'remote', undefined, REMOTE);
    await expect(other).resolves.toBe('remote');
    expect(builds).toBe(1);
    finish('image');
    await expect(second).resolves.toBe('image');
    await Promise.resolve();
    const third = preparation.run(work, undefined, LOCAL);
    await Promise.resolve();
    expect(builds).toBe(2);
    finish('again');
    await expect(third).resolves.toBe('again');
    preparation.dispose();
  });

  it('LOOKUP_ABANDON_MS is at least one deadline and at most a few (B-R5-6, L08)', () => {
    expect(LOOKUP_ABANDON_MS).toBeGreaterThanOrEqual(HEARTBEAT_ATTEMPT_DEADLINE_MS);
    expect(LOOKUP_ABANDON_MS).toBeLessThanOrEqual(5 * HEARTBEAT_ATTEMPT_DEADLINE_MS);
  });

  it('a lookup that never settles is given up also when the clock went back by LOOKUP_ABANDON_MS (B-R5-6, L02)', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    let hang = true;
    h.state.lookUp = async () => (hang ? new Promise<DockerTarget | undefined>(() => {}) : LOCAL);
    const first = h.heartbeats.tick();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
    await first;
    expect(h.engineCalls).toHaveLength(1);
    hang = false;
    h.now.value = T0 - LOOKUP_ABANDON_MS;
    const second = h.heartbeats.tick();
    await vi.advanceTimersByTimeAsync(0);
    await second;
    expect(h.engineCalls).toHaveLength(2);
  });
});

// Review round 6 of PR #85 (B-R6-7, B-R6-8): a build whose work ignores its long signal blocks its engine only until that
// signal aborts.
describe('HeartbeatPreparation joins a build only while its long signal lasts (review round 6 of PR #85)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A work that never ends by itself (it ignores its signal), with its signals and the means to finish each one. */
  function stuckWork() {
    const signals: AbortSignal[] = [];
    const finishes: ((value: string) => void)[] = [];
    const work = (signal: AbortSignal, onBuild: () => void): Promise<string> => {
      signals.push(signal);
      onBuild();
      return new Promise<string>((resolve) => finishes.push(resolve));
    };
    return { signals, finishes, work };
  }

  it('after the long timeout the next run on the engine starts new work; the old work settling late leaves it joined (B-R6-7, B-R6-8)', async () => {
    vi.useFakeTimers();
    const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => T0 });
    const { signals, finishes, work } = stuckWork();
    const first = preparation.run(work, undefined, LOCAL);
    await vi.advanceTimersByTimeAsync(0);
    const joined = preparation.run(work, undefined, LOCAL);
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HELPER_PREBUILD_TIMEOUT_MS);
    expect(signals[0].aborted).toBe(true);
    // The work ignored the abort: the next run starts new work instead of joining it.
    const fresh = preparation.run(work, undefined, LOCAL);
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(false);
    // B-R6-8: the old work settles late; the new one is still the one that runs on the engine and is joined.
    finishes[0]('late');
    await expect(first).resolves.toBe('late');
    await expect(joined).resolves.toBe('late');
    const third = preparation.run(work, undefined, LOCAL);
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(2);
    finishes[1]('fresh');
    await expect(fresh).resolves.toBe('fresh');
    await expect(third).resolves.toBe('fresh');
    preparation.dispose();
  });

  it('after dispose, a work that ignored the abort is no longer joined (B-R6-7)', async () => {
    const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => T0 });
    const { signals, finishes, work } = stuckWork();
    const first = preparation.run(work, undefined, LOCAL);
    await Promise.resolve();
    await Promise.resolve();
    expect(signals).toHaveLength(1);
    preparation.dispose();
    expect(signals[0].aborted).toBe(true);
    const next = preparation.run(work, undefined, LOCAL);
    await Promise.resolve();
    await Promise.resolve();
    expect(signals).toHaveLength(2);
    // A preparation that starts after dispose (its long signal aborted from the start) is not joined either.
    expect(signals[1].aborted).toBe(true);
    const last = preparation.run(work, undefined, LOCAL);
    await Promise.resolve();
    await Promise.resolve();
    expect(signals).toHaveLength(3);
    finishes[0]('old');
    finishes[1]('new');
    finishes[2]('last');
    await expect(first).resolves.toBe('old');
    await expect(next).resolves.toBe('new');
    await expect(last).resolves.toBe('last');
  });
});

// Plan step 8, PR C (user decision Q1 of 2026-10-02): the short release of an environment the window leaves.
describe('WindowHeartbeats.release (plan step 8, PR C, Q1)', () => {
  it('sends one heartbeat with the short limit and the flag of the entry to the engine of the connected environment', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api', { dockerHost: 'build-box' }));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    h.now.value = T0 + 5_000;
    expect(await h.heartbeats.release(ID_A, 60, new AbortController().signal)).toEqual({ ok: true });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].target).toEqual(REMOTE);
    // Changed expectation, review round 1 of PR #87, A-R1-2: the release is marked as such.
    expect(h.sent[1].input).toEqual({ source: SOURCE, limitSeconds: 60, environments: [{ id: ID_A, keepRunning: false, seq: T0 + 5_000 }], release: true });
    // The engine is asked as the connected environment, and only once (it was remembered).
    expect(h.engineRoles).toEqual([true]);
  });

  it('also after the window left the environment (switch): the engine of its connected role, not the busy one', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = null;
    expect(await h.heartbeats.release(ID_A, 90, new AbortController().signal)).toEqual({ ok: true });
    expect(h.engineRoles).toEqual([true]);
    expect(h.sent[0].input.limitSeconds).toBe(90);
  });

  it('a tick that still uses the environment sends the long limit again at once after the release', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    h.now.value = T0 + 1_000;
    await h.heartbeats.release(ID_A, 60, new AbortController().signal);
    h.now.value = T0 + 2_000;
    await h.heartbeats.tick();
    expect(h.sent.map((item) => item.input.limitSeconds)).toEqual([600, 60, 600]);
  });

  it('sends nothing to an engine without the container of the environment, and nothing for an environment that is gone', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.containerExists = () => false;
    expect(await h.heartbeats.release(ID_A, 60, new AbortController().signal)).toMatchObject({ ok: false });
    expect(await h.heartbeats.release(ID_B, 60, new AbortController().signal)).toEqual({ ok: false, detail: 'The environment is not in the registry.' });
    expect(h.sent).toEqual([]);
  });

  it('ends with a failure when its signal aborts during a send that hangs, and aborts the signal of the send', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.answer = (_target, signal) =>
      new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ ok: false, missing: false, detail: 'aborted' })));
    const controller = new AbortController();
    const result = h.heartbeats.release(ID_A, 60, controller.signal);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    controller.abort();
    expect(await result).toMatchObject({ ok: false });
    expect(h.signals[0].aborted).toBe(true);
  });

  it('never throws (a registry that rejects)', async () => {
    const h = harness();
    h.deps.registry.list = async () => {
      throw new Error('registry unreadable');
    };
    expect(await h.heartbeats.release(ID_A, 60, new AbortController().signal)).toEqual({ ok: false, detail: 'registry unreadable' });
  });
});

// Plan step 8, PR C: stale keep records (review note of PR A): the replacement of the full sync of the removed monitor.
describe('WindowHeartbeats: clear-only entries for environments that are no longer kept (plan step 8, PR C)', () => {
  const ID_C = '8d2e3f40-0000-4000-8000-000000000003';
  const ID_D = '9e3f4051-0000-4000-8000-000000000004';

  it('the first heartbeat of a series carries clear-only entries for the environments on that engine that are not kept', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    // Not kept, on the same engine: cleared.
    h.environments.push(environment(ID_B, 'acme/web'));
    // Kept: never cleared.
    h.environments.push(environment(ID_C, 'acme/lib', { keepRunning: true }));
    // On another engine: not in this heartbeat.
    h.environments.push(environment(ID_D, 'acme/ops', { dockerHost: 'build-box' }));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    expect(entriesOf(h.sent[0])).toEqual([{ id: ID_A, keepRunning: false }]);
    expect(clearsOf(h.sent[0])).toEqual([ID_B]);
    expect(h.sent[0].input.environments.find((entry) => entry.id === ID_B)).toEqual({ id: ID_B, keepRunning: false, seq: T0, clearOnly: true });
    // Later heartbeats of the series carry none.
    h.now.value = T0 + WINDOW_HEARTBEAT_INTERVAL_MS;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(2);
    expect(clearsOf(h.sent[1])).toEqual([]);
  });

  it('sends them again after the keep settings changed, and only once', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.environments.push(environment(ID_B, 'acme/web', { shutdownActionNone: true }));
    h.settings.respectShutdownActionNone = true;
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    expect(clearsOf(h.sent[0])).toEqual([]);
    // The setting is turned off: ID_B is no longer kept, and its keep record is withdrawn at once.
    h.settings.respectShutdownActionNone = false;
    h.now.value = T0 + 5_000;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(2);
    expect(clearsOf(h.sent[1])).toEqual([ID_B]);
    h.now.value = T0 + 10_000;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(2);
  });

  it('keeps them for the next attempt after a failed heartbeat', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.environments.push(environment(ID_B, 'acme/web'));
    h.state.connected = ID_A;
    h.state.answer = () => ({ ok: false, missing: false, detail: 'timed out' });
    await h.heartbeats.tick();
    h.state.answer = () => ({ ok: true });
    h.now.value = T0 + 15_000;
    await h.heartbeats.tick();
    expect(h.sent.map(clearsOf)).toEqual([[ID_B], [ID_B]]);
  });

  it('never more entries than the protocol allows', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    for (let index = 0; index < MAX_HEARTBEAT_ENVIRONMENTS + 5; index += 1) {
      h.environments.push(environment(`5a5a5a5a-0000-4000-8000-${String(index).padStart(12, '0')}`, `acme/r${index}`));
    }
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    expect(h.sent[0].input.environments).toHaveLength(MAX_HEARTBEAT_ENVIRONMENTS);
    expect(entriesOf(h.sent[0])).toEqual([{ id: ID_A, keepRunning: false }]);
  });
});

// Review round 1 of PR #87: the release paths and the rules that mutants showed untested.
describe('WindowHeartbeats: release paths (review round 1 of PR #87)', () => {
  const ID_C = '8d2e3f40-0000-4000-8000-000000000003';

  // A-R1-3: a release whose bound ended the race while its call still hangs leaves that call expired, so the window's
  // heartbeats count it as a failure (the Q4 warning) and sendFor ends at once, instead of waiting without end.
  it('A-R1-3: after a release that its signal ended, a hanging call counts as no answer for the ticks and for sendFor', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(1);
    // The next call never ends and ignores its signal.
    h.state.answer = () => new Promise<HeartbeatSendResult>(() => {});
    const controller = new AbortController();
    const released = h.heartbeats.release(ID_A, 210, controller.signal);
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    controller.abort();
    expect(await released).toMatchObject({ ok: false });
    h.now.value = T0 + WINDOW_HEARTBEAT_INTERVAL_MS;
    await h.heartbeats.tick();
    h.now.value = T0 + WINDOW_HEARTBEAT_INTERVAL_MS + 15_000;
    await h.heartbeats.tick();
    // No new call piles up on the engine, and the failures count: the Q4 warning comes.
    expect(h.sent).toHaveLength(2);
    expect(h.warnings).toHaveLength(1);
    expect(h.logs.some((line) => line.includes(HEARTBEAT_NO_ANSWER))).toBe(true);
    // Close and Keep Running does not hang behind it.
    await expect(h.heartbeats.sendFor(ID_A)).resolves.toEqual({ ok: false, detail: HEARTBEAT_NO_ANSWER });
  });

  // B-R1-1 (mutant H14): stopOnClose is part of the keep settings.
  it('B-R1-1: turning stopOnClose on sends the clear-only entries again at once, and only once', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.environments.push(environment(ID_B, 'acme/web'));
    h.settings.stopOnClose = false;
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    // With stopOnClose off every environment is kept: nothing to clear.
    expect(clearsOf(h.sent[0])).toEqual([]);
    h.settings.stopOnClose = true;
    h.now.value = T0 + 5_000;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(2);
    expect(clearsOf(h.sent[1])).toEqual([ID_B]);
    h.now.value = T0 + 10_000;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(2);
  });

  // B-R1-2 (mutant H12): an id that the monitor cannot record never goes into a heartbeat, not even as a clear-only entry.
  it('B-R1-2: an environment with an id that is no UUID gets no clear-only entry, and the heartbeat stays valid', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.environments.push(environment('legacy-environment', 'acme/old'));
    h.environments.push(environment(ID_C, 'acme/lib'));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    expect(clearsOf(h.sent[0])).toEqual([ID_C]);
    expect(parseHeartbeatInput(JSON.stringify(h.sent[0].input))).toBeDefined();
  });

  // B-R1-4 (mutant H02): the release carries the keep-running flag of the entry.
  it('B-R1-4: the release of a kept environment says keepRunning', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api', { keepRunning: true }));
    expect(await h.heartbeats.release(ID_A, 210, new AbortController().signal)).toEqual({ ok: true });
    expect(h.sent[0].input.environments).toEqual([{ id: ID_A, keepRunning: true, seq: T0 }]);
    expect(h.sent[0].input.release).toBe(true);
  });

  // B-R1-6 (mutant H24): connectedEngine asks for the engine of the connected role, also when the window knows the
  // environment in another role (busy with it).
  it('B-R1-6: connectedEngine gives the engine of the connected role when the roles have different engines', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api', { busy: { operation: 'rebuild', since: new Date(T0).toISOString(), pid: PID, windowId: WINDOW } }));
    h.state.lookUp = async (_environment, use) => (use.connected ? REMOTE : LOCAL);
    await h.heartbeats.tick();
    expect(h.sent[0].target).toEqual(LOCAL);
    expect(await h.heartbeats.connectedEngine(h.environments[0])).toEqual(REMOTE);
  });
});

// Review round 2 of PR #87: survivors of the mutation run of round 2 (B-R2-3: mutants H03 and H04; B-R2-4: mutant H05).
describe('WindowHeartbeats: release paths (review round 2 of PR #87)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const settledWithin = <T,>(promise: Promise<T>, ms: number): Promise<T | 'hung'> =>
    Promise.race([promise, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), ms))]);

  // B-R2-3 (H03, H04): the signal of the release ended before its attempt started (it aborted in a synchronous step of
  // the release); the attempt is expired at once and the signal of its send aborted, so a following tick counts a failure
  // and sendFor ends at once, although the send never settles.
  it('B-R2-3: an attempt whose outer signal is already aborted is expired at once; a tick counts a failure and sendFor ends at once', async () => {
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(1);
    h.state.answer = () => new Promise<HeartbeatSendResult>(() => {});
    const controller = new AbortController();
    let armed = true;
    h.deps.sourceId = () => {
      // The last synchronous step before the attempt: the signal of the release aborts here.
      if (armed) controller.abort();
      return SOURCE;
    };
    expect(await settledWithin(h.heartbeats.release(ID_A, 210, controller.signal), 1_000)).toMatchObject({ ok: false });
    armed = false;
    expect(h.sent).toHaveLength(2);
    // H04: the signal of the send aborted at once.
    expect(h.signals[1].aborted).toBe(true);
    // H03: the hanging call counts as no answer: the tick counts a failure, no new call piles up.
    h.now.value = T0 + WINDOW_HEARTBEAT_INTERVAL_MS;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.logs.some((line) => line.includes('failed; it is tried again') && line.includes(HEARTBEAT_NO_ANSWER))).toBe(true);
    // And sendFor ends at once.
    expect(await settledWithin(h.heartbeats.sendFor(ID_A), 1_000)).toEqual({ ok: false, detail: HEARTBEAT_NO_ANSWER });
  });

  // B-R2-4 (H05): when an expired call that still hangs ends after a newer call of the engine was registered, the newer one
  // stays registered (only a call removes its own registration), so a release waits for it.
  it('B-R2-4: an expired call that settles late does not remove the registration of a newer call; a release waits for the newer one', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.environments.push(environment(ID_A, 'acme/api'));
    h.state.connected = ID_A;
    await h.heartbeats.tick();
    expect(h.sent).toHaveLength(1);
    const settle: Array<(result: HeartbeatSendResult) => void> = [];
    h.state.answer = () => new Promise<HeartbeatSendResult>((resolve) => settle.push(resolve));
    // The internals: the two attempts on one engine are registered directly (no public path starts a second call while an
    // expired one is registered).
    type Internals = {
      inFlight: Map<string, { done: Promise<unknown>; expired: boolean }>;
      seriesOf(target: DockerTarget, now: number): unknown;
      attempt(key: string, series: unknown, input: HeartbeatInput, environments: Environment[], verified: boolean, outer?: AbortSignal): Promise<HeartbeatSendResult>;
    };
    const internals = h.heartbeats as unknown as Internals;
    const key = engineKey(LOCAL);
    const series = internals.seriesOf(LOCAL, T0);
    const input: HeartbeatInput = { source: SOURCE, limitSeconds: 600, environments: [{ id: ID_A, keepRunning: false, seq: T0 }] };
    const first = internals.attempt(key, series, input, [h.environments[0]], true);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_ATTEMPT_DEADLINE_MS);
    expect(await first).toEqual({ ok: false, missing: false, detail: HEARTBEAT_NO_ANSWER });
    expect(internals.inFlight.get(key)?.expired).toBe(true);
    // The second attempt is registered while the first still hangs.
    const second = internals.attempt(key, series, input, [h.environments[0]], true);
    const secondEntry = internals.inFlight.get(key);
    expect(secondEntry?.expired).toBe(false);
    expect(settle).toHaveLength(2);
    // The first settles late: the registration of the second stays.
    settle[0]({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(internals.inFlight.get(key)).toBe(secondEntry);
    // A release waits for the second call: it sends nothing until that one ended.
    const sentBefore = h.sent.length;
    let released: unknown;
    void h.heartbeats.release(ID_A, 210, new AbortController().signal).then((value) => (released = value));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.sent).toHaveLength(sentBefore);
    expect(released).toBeUndefined();
    h.state.answer = () => ({ ok: true });
    settle[1]({ ok: true });
    expect(await second).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(released).toEqual({ ok: true });
    expect(h.sent).toHaveLength(sentBefore + 1);
    expect(h.sent.at(-1)?.input.release).toBe(true);
  });
});
