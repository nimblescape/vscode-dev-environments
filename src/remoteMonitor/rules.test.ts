// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  RECORD_MAX_AGE_MS,
  REMOTE_GAP_MS,
  REMOTE_GRACE_MS,
  REMOTE_TICK_MS,
  decide,
  devContainerFirst,
  initialRemoteState,
  isRunningState,
  type RemoteContainer,
  type RemoteMonitorState,
  type RemoteRecord,
} from './rules';

const A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const B = '7c1d2e3f-0000-4000-8000-000000000002';
const SOURCE = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const MINUTE = 60_000;

function container(environmentId: string, state = 'running', extra: Partial<RemoteContainer> = {}): RemoteContainer {
  return { id: `${environmentId.slice(0, 8)}${extra.composeService ?? ''}`, state, name: `devenv-${environmentId.slice(0, 8)}`, environmentId, composeService: '', ...extra };
}

function record(environmentId: string, at: number, extra: Partial<RemoteRecord> = {}): RemoteRecord {
  return { source: SOURCE, environmentId, at, keepRunning: false, limitSeconds: 600, ...extra };
}

/** A state after a tick one interval ago and no grace, as in a monitor that runs for a while. */
function running(extra: Partial<RemoteMonitorState> = {}, now = T0): RemoteMonitorState {
  return { lastTickAt: now - REMOTE_TICK_MS, ...extra };
}

describe('decide of the remote Session Monitor', () => {
  it('keeps an environment whose last heartbeat is younger than its limit', () => {
    const decision = decide({ now: T0, containers: [container(A)], records: [record(A, T0 - 9 * MINUTE)], state: running() });
    expect(decision.stop).toEqual([]);
  });

  it('stops an environment without a heartbeat for longer than the limit of its newest record', () => {
    const decision = decide({
      now: T0,
      containers: [container(A)],
      records: [record(A, T0 - 11 * MINUTE), record(A, T0 - 20 * MINUTE, { source: OTHER, limitSeconds: 60 })],
      state: running(),
    });
    expect(decision.stop.map((stop) => stop.environmentId)).toEqual([A]);
    expect(decision.stop[0].reason).toContain('11 minutes');
  });

  it('takes the limit of the newest record', () => {
    // The newest record says 2 minutes: 3 minutes without contact is too long.
    const records = [record(A, T0 - 3 * MINUTE, { limitSeconds: 120 }), record(A, T0 - 4 * MINUTE, { source: OTHER, limitSeconds: 3600 })];
    expect(decide({ now: T0, containers: [container(A)], records, state: running() }).stop).toHaveLength(1);
    // The newest record says an hour.
    const later = [record(A, T0 - 3 * MINUTE, { limitSeconds: 3600 }), record(A, T0 - 4 * MINUTE, { source: OTHER, limitSeconds: 120 })];
    expect(decide({ now: T0, containers: [container(A)], records: later, state: running() }).stop).toEqual([]);
  });

  it('keeps an environment that any record keeps running, however old', () => {
    const records = [record(A, T0 - 5 * 24 * 60 * MINUTE, { keepRunning: true }), record(A, T0 - 60 * MINUTE, { source: OTHER })];
    const decision = decide({ now: T0, containers: [container(A)], records, state: running() });
    expect(decision.stop).toEqual([]);
    expect(decision.kept).toEqual([A]);
  });

  it('a new heartbeat without the flag ends the keeping', () => {
    const records = [record(A, T0 - 20 * MINUTE, { keepRunning: false })];
    expect(decide({ now: T0, containers: [container(A)], records, state: running() }).kept).toEqual([]);
  });

  it('never stops an environment without any record, however long it runs (for example of the host\'s own local Docker)', () => {
    let state = running();
    for (let time = T0; time <= T0 + 24 * 60 * MINUTE; time += 60 * MINUTE) {
      const decision = decide({ now: time, containers: [container(A)], records: [record(B, time - 60 * MINUTE)], state: { ...state, lastTickAt: time - REMOTE_TICK_MS } });
      expect(decision.stop).toEqual([]);
      expect(decision.kept).toEqual([]);
      state = decision.state;
    }
  });

  it('acts on an environment once any computer sent a heartbeat for it', () => {
    const decision = decide({ now: T0, containers: [container(A), container(B)], records: [record(B, T0 - 60 * MINUTE, { source: OTHER })], state: running() });
    expect(decision.stop.map((stop) => stop.environmentId)).toEqual([B]);
  });

  it('never stops a container that does not run, and counts restarting and paused as running', () => {
    expect(isRunningState('running')).toBe(true);
    expect(isRunningState('restarting')).toBe(true);
    expect(isRunningState('paused')).toBe(true);
    expect(isRunningState('exited')).toBe(false);
    expect(isRunningState('created')).toBe(false);
    const decision = decide({ now: T0, containers: [container(A, 'exited')], records: [record(A, T0 - 60 * MINUTE)], state: running() });
    expect(decision.stop).toEqual([]);
  });

  it('stops the dev container first, then the other services, and only the running ones', () => {
    const containers = [
      container(A, 'running', { id: 'db', composeService: 'db' }),
      container(A, 'exited', { id: 'cache', composeService: 'cache' }),
      container(A, 'running', { id: 'dev' }),
    ];
    const decision = decide({ now: T0, containers, records: [record(A, T0 - 60 * MINUTE)], state: running() });
    expect(decision.stop[0].containers.map((item) => item.id)).toEqual(['dev', 'db']);
    expect(devContainerFirst([containers[0], containers[2]]).map((item) => item.id)).toEqual(['dev', 'db']);
  });

  it('decides each environment on its own', () => {
    const decision = decide({
      now: T0,
      containers: [container(A), container(B)],
      records: [record(A, T0 - 60 * MINUTE), record(B, T0 - MINUTE)],
      state: running(),
    });
    expect(decision.stop.map((stop) => stop.environmentId)).toEqual([A]);
  });

  describe('the gap rule', () => {
    it('stops nothing at the first tick and for the grace after it', () => {
      const records = [record(A, T0 - 60 * MINUTE)];
      let decision = decide({ now: T0, containers: [container(A)], records, state: initialRemoteState() });
      expect(decision.grace).toBe(true);
      expect(decision.stop).toEqual([]);
      decision = decide({ now: T0 + REMOTE_GRACE_MS - 1, containers: [container(A)], records, state: { ...decision.state, lastTickAt: T0 + REMOTE_GRACE_MS - 1 - REMOTE_TICK_MS } });
      expect(decision.stop).toEqual([]);
      decision = decide({ now: T0 + REMOTE_GRACE_MS, containers: [container(A)], records, state: { ...decision.state, lastTickAt: T0 + REMOTE_GRACE_MS - REMOTE_TICK_MS } });
      expect(decision.grace).toBe(false);
      expect(decision.stop).toHaveLength(1);
    });

    it('starts the grace after a pause of more than a minute, also when the clock went back', () => {
      const records = [record(A, T0 - 60 * MINUTE)];
      const paused = decide({ now: T0, containers: [container(A)], records, state: running({ lastTickAt: T0 - REMOTE_GAP_MS - 1 }) });
      expect(paused.grace).toBe(true);
      expect(paused.stop).toEqual([]);
      const back = decide({ now: T0, containers: [container(A)], records, state: running({ lastTickAt: T0 + 10 * MINUTE }) });
      expect(back.grace).toBe(true);
      // A gap within the limit is no pause.
      const normal = decide({ now: T0, containers: [container(A)], records, state: running({ lastTickAt: T0 - REMOTE_GAP_MS }) });
      expect(normal.grace).toBe(false);
      expect(normal.stop).toHaveLength(1);
    });

    it('honours shorter times (the tests of the container)', () => {
      const timing = { gapMs: 2000, graceMs: 4000 };
      const records = [record(A, T0 - 60 * MINUTE)];
      const first = decide({ now: T0, containers: [container(A)], records, state: initialRemoteState(), timing });
      expect(first.stop).toEqual([]);
      const later = decide({ now: T0 + 4000, containers: [container(A)], records, state: { ...first.state, lastTickAt: T0 + 3500 }, timing });
      expect(later.stop).toHaveLength(1);
    });
  });

  describe('old records', () => {
    it('removes a record older than 7 days whose environment has no container at all', () => {
      const old = record(B, T0 - RECORD_MAX_AGE_MS - 1);
      const young = record(B, T0 - RECORD_MAX_AGE_MS + 1000, { source: OTHER });
      const decision = decide({ now: T0, containers: [], records: [old, young], state: running() });
      expect(decision.forget).toEqual([old]);
    });

    it('keeps an old record while a container of its environment exists, also a stopped one', () => {
      const old = record(A, T0 - RECORD_MAX_AGE_MS - 1);
      expect(decide({ now: T0, containers: [container(A, 'exited')], records: [old], state: running() }).forget).toEqual([]);
    });
  });

  it('does not change the state it was given', () => {
    const state = running({ graceUntil: T0 + MINUTE });
    const copy = JSON.parse(JSON.stringify(state)) as RemoteMonitorState;
    decide({ now: T0, containers: [container(A)], records: [], state });
    expect(state).toEqual(copy);
  });
});
