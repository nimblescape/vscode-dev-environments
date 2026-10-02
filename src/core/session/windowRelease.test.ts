// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 8, PR C: the release of an environment that a window leaves (user decisions Q1 and Q2 of 2026-10-02).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_LIMIT_SECONDS, MIN_LIMIT_SECONDS } from '../remoteMonitor/protocol';
import type { Environment, ExtensionSettings, PendingConnection, WindowStatus } from '../types';
import { HEARTBEAT_ATTEMPT_DEADLINE_MS, WINDOW_HEARTBEAT_INTERVAL_MS } from './windowHeartbeats';
import {
  CLOSE_RELEASE_BOUNDS,
  RELEASE_MARGIN_SECONDS,
  SWITCH_RELEASE_BOUNDS,
  otherWindowHoldsEnvironment,
  releaseEnvironment,
  releaseLimitSeconds,
  type ReleaseBounds,
  type WindowReleaseDeps,
} from './windowRelease';

const ID_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

function environment(extra: Partial<Environment> = {}): Environment {
  return {
    id: ID_A,
    repository: 'acme/api',
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devenv-${ID_A}`,
    containerName: `devenv-${ID_A}`,
    owner: { id: '1', login: 'octo' },
    createdAt: '2026-10-01T10:00:00.000Z',
    ...extra,
  } as Environment;
}

function harness(env: Environment | null = environment()) {
  const events: string[] = [];
  const logs: string[] = [];
  const settings: Pick<ExtensionSettings, 'stopOnClose' | 'respectShutdownActionNone' | 'waitingTimeSeconds'> = {
    stopOnClose: true,
    respectShutdownActionNone: false,
    waitingTimeSeconds: 30,
  };
  const state = {
    otherWindow: false,
    git: async (_signal: AbortSignal): Promise<unknown> => undefined,
    send: async (_signal: AbortSignal): Promise<{ ok: true } | { ok: false; detail: string }> => ({ ok: true }),
  };
  const sends: Array<{ id: string; limitSeconds: number; signal: AbortSignal }> = [];
  const gitSignals: AbortSignal[] = [];
  const deps: WindowReleaseDeps = {
    registry: { list: async () => (env === null ? [] : [structuredClone(env)]) },
    settings: () => settings,
    otherWindowUses: async () => state.otherWindow,
    recordGitState: async (environment, signal) => {
      events.push(`git ${environment.id}`);
      gitSignals.push(signal);
      return state.git(signal);
    },
    send: async (id, limitSeconds, signal) => {
      events.push(`release ${id}`);
      sends.push({ id, limitSeconds, signal });
      return state.send(signal);
    },
    logger: {
      info: (message) => logs.push(`info ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
      error: (message) => logs.push(`error ${message}`),
      output: () => {},
    },
  };
  return { deps, events, logs, settings, state, sends, gitSignals };
}

const BOUNDS: ReleaseBounds = { totalMs: 2_000, gitMs: 1_000 };

afterEach(() => {
  vi.useRealTimers();
});

describe('releaseLimitSeconds (plan step 8, PR C, Q1)', () => {
  // Changed expectations, review round 1 of PR #87, A-R1-1: plus RELEASE_MARGIN_SECONDS (one heartbeat interval and one
  // attempt of a heartbeat), so a window that comes back has the time to send its first long heartbeat.
  it('is the waiting time, at least 60 s, plus the margin, and at most a day; an invalid value gives the default waiting time (30 s → 60 s)', () => {
    const M = RELEASE_MARGIN_SECONDS;
    expect(M).toBe((WINDOW_HEARTBEAT_INTERVAL_MS + HEARTBEAT_ATTEMPT_DEADLINE_MS) / 1000);
    expect(releaseLimitSeconds(30)).toBe(MIN_LIMIT_SECONDS + M);
    expect(releaseLimitSeconds(0)).toBe(60 + M);
    expect(releaseLimitSeconds(60)).toBe(60 + M);
    expect(releaseLimitSeconds(61)).toBe(61 + M);
    expect(releaseLimitSeconds(90.2)).toBe(91 + M);
    expect(releaseLimitSeconds(600)).toBe(600 + M);
    expect(releaseLimitSeconds(MAX_LIMIT_SECONDS - M - 1)).toBe(MAX_LIMIT_SECONDS - 1);
    expect(releaseLimitSeconds(1e9)).toBe(MAX_LIMIT_SECONDS);
    expect(releaseLimitSeconds(undefined)).toBe(60 + M);
    expect(releaseLimitSeconds(Number.NaN)).toBe(60 + M);
    expect(releaseLimitSeconds(-5)).toBe(60 + M);
  });

  it('review round 1 of PR #87, A-R1-1: the release outlasts a reload whose first heartbeat takes a whole attempt and one retry', () => {
    expect(releaseLimitSeconds(30) * 1000).toBeGreaterThanOrEqual(60_000 + HEARTBEAT_ATTEMPT_DEADLINE_MS + WINDOW_HEARTBEAT_INTERVAL_MS);
  });

  it('the bounds of a close are about 2 s, the Git state within them', () => {
    expect(CLOSE_RELEASE_BOUNDS.totalMs).toBeLessThanOrEqual(2_000);
    expect(CLOSE_RELEASE_BOUNDS.gitMs).toBeLessThan(CLOSE_RELEASE_BOUNDS.totalMs);
    expect(SWITCH_RELEASE_BOUNDS.gitMs).toBeLessThan(SWITCH_RELEASE_BOUNDS.totalMs);
  });
});

describe('releaseEnvironment (plan step 8, PR C, Q1 and Q2)', () => {
  it('records the Git state first (Q2 (c)), then sends the release with max(waiting time, 60 s) plus the margin', async () => {
    const h = harness();
    h.settings.waitingTimeSeconds = 120;
    expect(await releaseEnvironment(h.deps, ID_A, BOUNDS)).toBe('released');
    expect(h.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    // Changed expectation, review round 1 of PR #87, A-R1-1: plus RELEASE_MARGIN_SECONDS.
    expect(h.sends[0].limitSeconds).toBe(120 + RELEASE_MARGIN_SECONDS);
    expect(h.logs.some((line) => line.includes('Released acme/api'))).toBe(true);
  });

  it.each([
    ['Keep Running When Closed', { keepRunning: true }, {}],
    ['Close and Keep Running', { keepRunningOnce: true }, {}],
    ['stopOnClose off', {}, { stopOnClose: false }],
    ['a respected "shutdownAction": "none"', { shutdownActionNone: true }, { respectShutdownActionNone: true }],
  ] as const)('sends nothing and records nothing for a kept environment: %s', async (_name, flags, settings) => {
    const h = harness(environment(flags));
    Object.assign(h.settings, settings);
    expect(await releaseEnvironment(h.deps, ID_A, BOUNDS)).toBe('kept');
    expect(h.events).toEqual([]);
  });

  it('a "shutdownAction": "none" that is not respected is released', async () => {
    const h = harness(environment({ shutdownActionNone: true }));
    expect(await releaseEnvironment(h.deps, ID_A, BOUNDS)).toBe('released');
  });

  it('sends nothing while another live window of this computer shows the environment, nor for one that is gone', async () => {
    const h = harness();
    h.state.otherWindow = true;
    expect(await releaseEnvironment(h.deps, ID_A, BOUNDS)).toBe('inUse');
    const gone = harness(null);
    expect(await releaseEnvironment(gone.deps, ID_A, BOUNDS)).toBe('unknown');
    expect([...h.events, ...gone.events]).toEqual([]);
  });

  it('goes on with the release when the Git record fails, and logs it', async () => {
    const h = harness();
    h.state.git = async () => {
      throw new Error('git is missing');
    };
    expect(await releaseEnvironment(h.deps, ID_A, BOUNDS)).toBe('released');
    expect(h.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    expect(h.logs.some((line) => line.includes('git is missing'))).toBe(true);
  });

  it('stops waiting for the Git record at its bound (its signal aborts) and still sends the release', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.state.git = () => new Promise(() => {});
    const result = releaseEnvironment(h.deps, ID_A, BOUNDS);
    await vi.advanceTimersByTimeAsync(BOUNDS.gitMs);
    expect(await result).toBe('released');
    expect(h.gitSignals[0].aborted).toBe(true);
    expect(h.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
  });

  it('ends at the total bound when the release hangs: a failure, and the signal of the send aborts (the long limit applies)', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.state.send = () => new Promise(() => {});
    let outcome: string | undefined;
    const result = releaseEnvironment(h.deps, ID_A, BOUNDS).then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(BOUNDS.totalMs - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(outcome).toBe('failed');
    expect(h.sends[0].signal.aborted).toBe(true);
  });

  it('a failed release is logged as such and never throws, also when the registry cannot be read', async () => {
    const h = harness();
    h.state.send = async () => ({ ok: false, detail: 'no answer in time' });
    expect(await releaseEnvironment(h.deps, ID_A, BOUNDS)).toBe('failed');
    expect(h.logs.some((line) => line.includes('the long limit applies') && line.includes('no answer in time'))).toBe(true);
    h.deps.registry.list = async () => {
      throw new Error('unreadable');
    };
    expect(await releaseEnvironment(h.deps, ID_A, BOUNDS)).toBe('failed');
  });
});

// Review round 2 of PR #87 (A-R2-2): every release records first that the window was seen using the environment (for
// Delete's note), before the Git step, so a state that the release records is never older than it.
describe('releaseEnvironment: the last use (review round 2 of PR #87, A-R2-2)', () => {
  function withSeen(env: Environment | null = environment()) {
    const h = harness(env);
    const seen: string[] = [];
    let gitAt = Number.NaN;
    const git = h.deps.recordGitState;
    h.deps.recordGitState = async (environment, signal) => {
      gitAt = Date.now();
      return git(environment, signal);
    };
    h.deps.markSeenInUse = async (environment, at) => {
      h.events.push(`seen ${environment.id}`);
      seen.push(at);
    };
    return { ...h, seen, gitAt: () => gitAt };
  }

  it('records the last use at the start, before the Git step, with a time not after it', async () => {
    const h = withSeen();
    const before = Date.now();
    expect(await releaseEnvironment(h.deps, ID_A, BOUNDS)).toBe('released');
    expect(h.events).toEqual([`seen ${ID_A}`, `git ${ID_A}`, `release ${ID_A}`]);
    expect(h.seen).toHaveLength(1);
    const at = Date.parse(h.seen[0]);
    expect(new Date(at).toISOString()).toBe(h.seen[0]);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(h.gitAt());
  });

  it('also for a kept environment and one that another window uses (nothing else is sent), not for one that is gone', async () => {
    const kept = withSeen(environment({ keepRunning: true }));
    expect(await releaseEnvironment(kept.deps, ID_A, BOUNDS)).toBe('kept');
    expect(kept.events).toEqual([`seen ${ID_A}`]);
    const inUse = withSeen();
    inUse.state.otherWindow = true;
    expect(await releaseEnvironment(inUse.deps, ID_A, BOUNDS)).toBe('inUse');
    expect(inUse.events).toEqual([`seen ${ID_A}`]);
    const gone = withSeen(null);
    expect(await releaseEnvironment(gone.deps, ID_A, BOUNDS)).toBe('unknown');
    expect(gone.events).toEqual([]);
  });

  it('goes on when the last use cannot be recorded, and logs it', async () => {
    const h = withSeen();
    h.deps.markSeenInUse = async () => {
      throw new Error('registry locked');
    };
    expect(await releaseEnvironment(h.deps, ID_A, BOUNDS)).toBe('released');
    expect(h.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    expect(h.logs.some((line) => line.includes('last use of acme/api') && line.includes('registry locked'))).toBe(true);
    // Also when it throws at once (not as a rejected promise).
    const sync = withSeen();
    sync.deps.markSeenInUse = () => {
      throw new Error('registry gone');
    };
    expect(await releaseEnvironment(sync.deps, ID_A, BOUNDS)).toBe('released');
    expect(sync.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    expect(sync.logs.some((line) => line.includes('last use of acme/api') && line.includes('registry gone'))).toBe(true);
  });

  it('a hanging record of the last use neither holds the Git step and the release back nor turns the outcome into a failure', async () => {
    vi.useFakeTimers();
    const h = withSeen();
    h.deps.markSeenInUse = () => new Promise(() => {});
    let outcome: string | undefined;
    const result = releaseEnvironment(h.deps, ID_A, BOUNDS).then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    await vi.advanceTimersByTimeAsync(BOUNDS.totalMs - 1);
    await result;
    expect(outcome).toBe('released');
  });
});

// Review round 1 of PR #87 (A-R1-2): the windows of one computer share its record of the environment; a release must not
// shorten it while another window uses the environment.
describe('otherWindowHoldsEnvironment (review round 1 of PR #87, A-R1-2)', () => {
  const NOW = Date.parse('2026-10-02T12:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const alive = (pid: number) => pid === 11 || pid === 22;
  const status = (windowId: string, pid: number, extra: Partial<WindowStatus> = {}): WindowStatus => ({
    windowId,
    pid,
    environmentId: null,
    state: 'active',
    updatedAt: iso(NOW - 5_000),
    ...extra,
  });

  it('a status file of another live window that shows the environment', () => {
    const input = { now: NOW, isAlive: alive, windowStatuses: [status('own', 11), status('other', 22, { environmentId: ID_A })] };
    expect(otherWindowHoldsEnvironment(environment(), 'own', input)).toBe(true);
    // Not the own one, not a closing one, not one of an ended process.
    expect(otherWindowHoldsEnvironment(environment(), 'other', input)).toBe(false);
    expect(otherWindowHoldsEnvironment(environment(), 'own', { ...input, windowStatuses: [status('other', 22, { environmentId: ID_A, state: 'closing' })] })).toBe(false);
    expect(otherWindowHoldsEnvironment(environment(), 'own', { ...input, windowStatuses: [status('other', 33, { environmentId: ID_A })] })).toBe(false);
  });

  it('a fresh pending connection file of another window (it opens the environment)', () => {
    const pending = (windowId: string, at: number): PendingConnection => ({ environmentId: ID_A, windowId, createdAt: iso(at) });
    const input = { now: NOW, isAlive: alive, windowStatuses: [], pendings: [pending('other', NOW - 10_000)] };
    expect(otherWindowHoldsEnvironment(environment(), 'own', input)).toBe(true);
    expect(otherWindowHoldsEnvironment(environment(), 'own', { ...input, pendings: [pending('own', NOW - 10_000)] })).toBe(false);
    expect(otherWindowHoldsEnvironment(environment(), 'own', { ...input, pendings: [pending('other', NOW - 10 * 60_000)] })).toBe(false);
  });

  it('a live busy mark of another window (an open or a rebuild runs there), not the own one nor one that ended', () => {
    const busy = (windowId: string, pid: number, since = NOW - 60_000) => environment({ busy: { operation: 'rebuild', since: iso(since), pid, windowId } });
    const windowStatuses = [status('own', 11), status('other', 22)];
    const input = { now: NOW, isAlive: alive, windowStatuses };
    expect(otherWindowHoldsEnvironment(busy('other', 22), 'own', input)).toBe(true);
    expect(otherWindowHoldsEnvironment(busy('own', 11), 'own', input)).toBe(false);
    // Its process ended, it ended (since = the epoch), or its window has no recent status file.
    expect(otherWindowHoldsEnvironment(busy('other', 33), 'own', input)).toBe(false);
    expect(otherWindowHoldsEnvironment(busy('other', 22, 0), 'own', input)).toBe(false);
    expect(otherWindowHoldsEnvironment(busy('other', 22), 'own', { ...input, windowStatuses: [status('own', 11)] })).toBe(false);
  });

  it('nothing else', () => {
    expect(otherWindowHoldsEnvironment(environment(), 'own', { now: NOW, isAlive: alive })).toBe(false);
  });

  it('releaseEnvironment asks with the environment from the registry, and sends nothing while another window holds it', async () => {
    const h = harness(environment({ busy: { operation: 'rebuild', since: iso(NOW), pid: 22, windowId: 'other' } }));
    const asked: Environment[] = [];
    h.deps.otherWindowUses = async (env) => {
      asked.push(env);
      return env.busy?.windowId === 'other';
    };
    expect(await releaseEnvironment(h.deps, ID_A, BOUNDS)).toBe('inUse');
    expect(asked.map((env) => env.id)).toEqual([ID_A]);
    expect(h.events).toEqual([]);
  });
});
