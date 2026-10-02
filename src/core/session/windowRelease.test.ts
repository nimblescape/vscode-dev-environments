// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 8, PR C: the release of an environment that a window leaves (user decisions Q1 and Q2 of 2026-10-02).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_LIMIT_SECONDS, MIN_LIMIT_SECONDS } from '../remoteMonitor/protocol';
import type { Environment, ExtensionSettings } from '../types';
import {
  CLOSE_RELEASE_BOUNDS,
  SWITCH_RELEASE_BOUNDS,
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
  it('is the waiting time, at least 60 s and at most a day; an invalid value gives the default waiting time (30 s → 60 s)', () => {
    expect(releaseLimitSeconds(30)).toBe(MIN_LIMIT_SECONDS);
    expect(releaseLimitSeconds(0)).toBe(60);
    expect(releaseLimitSeconds(60)).toBe(60);
    expect(releaseLimitSeconds(61)).toBe(61);
    expect(releaseLimitSeconds(90.2)).toBe(91);
    expect(releaseLimitSeconds(600)).toBe(600);
    expect(releaseLimitSeconds(1e9)).toBe(MAX_LIMIT_SECONDS);
    expect(releaseLimitSeconds(undefined)).toBe(60);
    expect(releaseLimitSeconds(Number.NaN)).toBe(60);
    expect(releaseLimitSeconds(-5)).toBe(60);
  });

  it('the bounds of a close are about 2 s, the Git state within them', () => {
    expect(CLOSE_RELEASE_BOUNDS.totalMs).toBeLessThanOrEqual(2_000);
    expect(CLOSE_RELEASE_BOUNDS.gitMs).toBeLessThan(CLOSE_RELEASE_BOUNDS.totalMs);
    expect(SWITCH_RELEASE_BOUNDS.gitMs).toBeLessThan(SWITCH_RELEASE_BOUNDS.totalMs);
  });
});

describe('releaseEnvironment (plan step 8, PR C, Q1 and Q2)', () => {
  it('records the Git state first (Q2 (c)), then sends the release with max(waiting time, 60 s)', async () => {
    const h = harness();
    h.settings.waitingTimeSeconds = 120;
    expect(await releaseEnvironment(h.deps, ID_A, BOUNDS)).toBe('released');
    expect(h.events).toEqual([`git ${ID_A}`, `release ${ID_A}`]);
    expect(h.sends[0].limitSeconds).toBe(120);
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
