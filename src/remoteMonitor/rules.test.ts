// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { inUseByOtherComputer } from '../core/remoteMonitor/protocol';
import {
  FUTURE_RECORD_TOLERANCE_MS,
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

  it('keeps an environment whose newest record keeps it running, however old', () => {
    const records = [record(A, T0 - 5 * 24 * 60 * MINUTE, { keepRunning: true }), record(A, T0 - 6 * 24 * 60 * MINUTE, { source: OTHER })];
    const decision = decide({ now: T0, containers: [container(A)], records, state: running() });
    expect(decision.stop).toEqual([]);
    expect(decision.kept).toEqual([A]);
  });

  // Review round 2 of PR #39 (M1): the newest record decides, across all sources.
  it('an orphaned keep is overruled by a newer record without the flag of another source', () => {
    // OTHER kept it long ago and never sent again (for example a computer.id that was replaced).
    const records = [record(A, T0 - 30 * 24 * 60 * MINUTE, { source: OTHER, keepRunning: true }), record(A, T0 - 11 * MINUTE)];
    const decision = decide({ now: T0, containers: [container(A)], records, state: running() });
    expect(decision.kept).toEqual([]);
    expect(decision.stop.map((stop) => stop.environmentId)).toEqual([A]);
  });

  it('a newer keep of another source wins over an older record without the flag', () => {
    const records = [record(A, T0 - 60 * MINUTE), record(A, T0 - 30 * MINUTE, { source: OTHER, keepRunning: true })];
    const decision = decide({ now: T0, containers: [container(A)], records, state: running() });
    expect(decision.kept).toEqual([A]);
    expect(decision.stop).toEqual([]);
  });

  it('for records of the same time, a keep wins', () => {
    const records = [record(A, T0 - 60 * MINUTE), record(A, T0 - 60 * MINUTE, { source: OTHER, keepRunning: true })];
    expect(decide({ now: T0, containers: [container(A)], records, state: running() }).kept).toEqual([A]);
    expect(decide({ now: T0, containers: [container(A)], records: [...records].reverse(), state: running() }).kept).toEqual([A]);
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

  // Review round 1 of PR #39 (R1): a time in the future counts as now, and the record still counts.
  it('takes a record with a time more than 5 minutes in the future as written when first seen, and lets it age', () => {
    const future = [record(A, T0 + 365 * 24 * 60 * MINUTE, { limitSeconds: 60 })];
    const first = decide({ now: T0, containers: [container(A)], records: future, state: running() });
    expect(first.stop).toEqual([]);
    // Not dropped (the environment is still acted on), and not fresh for ever: stopped once the limit passed since then.
    const later = decide({ now: T0 + 2 * MINUTE, containers: [container(A)], records: future, state: { ...first.state, lastTickAt: T0 + 2 * MINUTE - REMOTE_TICK_MS } });
    expect(later.stop.map((stop) => stop.environmentId)).toEqual([A]);
    expect(later.stop[0].reason).toContain('2 minutes');
  });

  it('takes a record up to 5 minutes in the future as it is', () => {
    const near = [record(A, T0 + FUTURE_RECORD_TOLERANCE_MS, { limitSeconds: 60 })];
    const decision = decide({ now: T0, containers: [container(A)], records: near, state: running() });
    expect(decision.stop).toEqual([]);
    expect(decision.state.futureSeen).toBeUndefined();
    const later = decide({ now: T0 + 5 * MINUTE, containers: [container(A)], records: near, state: running({}, T0 + 5 * MINUTE) });
    expect(later.stop).toEqual([]);
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

    // Monitor cleanup, user decision 2026-09-29 (R2): the absolute age, so a record far in the future is removed too.
    it('removes a record more than 7 days in the future whose environment has no container, and keeps a nearer one', () => {
      const far = record(B, T0 + RECORD_MAX_AGE_MS + 1);
      const near = record(B, T0 + RECORD_MAX_AGE_MS, { source: OTHER });
      const decision = decide({ now: T0, containers: [], records: [far, near], state: running() });
      expect(decision.forget).toEqual([far]);
      // With a container, it stays.
      expect(decide({ now: T0, containers: [container(B, 'exited')], records: [far], state: running() }).forget).toEqual([]);
    });

    // Review round 6 of PR #63 (R6-1): `forget` is in the order of removal, by the times as the rules see them (a time in
    // the future counts from when it was first seen), of equal `at` a keep last; the loop removes them in this order.
    describe('in the order of removal (review round 6 of PR #63, R6-1)', () => {
      const DAY = 24 * 60 * MINUTE;

      it('puts a keep last of two far-future records seen at the same tick, whatever their written times', () => {
        const keep = record(B, T0 + 8 * DAY, { keepRunning: true });
        const other = record(B, T0 + 9 * DAY, { source: OTHER });
        const past = record(B, T0 - 8 * DAY, { source: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
        // Also after every start of the monitor, when nothing was seen before.
        expect(decide({ now: T0, containers: [], records: [keep, other, past], state: running() }).forget).toEqual([past, other, keep]);
      });

      it('orders by the time first seen, not the written time', () => {
        const keep = record(B, T0 + 8 * DAY, { keepRunning: true });
        const other = record(B, T0 + 9 * DAY, { source: OTHER });
        const state = running({ futureSeen: { [`${OTHER}.${B}.${other.at}`]: T0 - DAY } });
        expect(decide({ now: T0, containers: [], records: [keep, other], state }).forget).toEqual([other, keep]);
      });

      it('never forgets a far-future record seen later than a record of its environment that stays', () => {
        const keep = record(B, T0 + 8 * DAY, { keepRunning: true });
        const young = record(B, T0 - DAY, { source: OTHER });
        const past = record(B, T0 - 9 * DAY, { source: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
        expect(decide({ now: T0, containers: [], records: [keep, young, past], state: running() }).forget).toEqual([past]);
        // A keep seen at the same time as the one that stays stays too; one seen before it is forgotten.
        const same = running({ futureSeen: { [`${SOURCE}.${B}.${keep.at}`]: T0 - DAY } });
        expect(decide({ now: T0, containers: [], records: [keep, young], state: same }).forget).toEqual([]);
        const before = running({ futureSeen: { [`${SOURCE}.${B}.${keep.at}`]: T0 - 2 * DAY } });
        expect(decide({ now: T0, containers: [], records: [keep, young], state: before }).forget).toEqual([keep]);
      });
    });

    describe('superseded records (monitor cleanup, user decision 2026-09-29, R1)', () => {
      const THIRD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      it('removes an old record without keepRunning when a newer record of the same environment exists', () => {
        const old = record(A, T0 - RECORD_MAX_AGE_MS - 1);
        const newer = record(A, T0 - MINUTE, { source: OTHER });
        const decision = decide({ now: T0, containers: [container(A)], records: [old, newer], state: running() });
        expect(decision.superseded).toEqual([old]);
        expect(decision.forget).toEqual([]);
        // Without a container too; it is then in `forget` only.
        const gone = decide({ now: T0, containers: [], records: [old, newer], state: running() });
        expect(gone.forget).toEqual([old]);
        expect(gone.superseded).toEqual([]);
      });

      it('keeps a superseded record that is not older than 7 days', () => {
        const young = record(A, T0 - RECORD_MAX_AGE_MS);
        const newer = record(A, T0 - MINUTE, { source: OTHER });
        expect(decide({ now: T0, containers: [container(A)], records: [young, newer], state: running() }).superseded).toEqual([]);
      });

      it('keeps an old record that says keepRunning while a container exists, even with a newer record', () => {
        const keep = record(A, T0 - RECORD_MAX_AGE_MS - 1, { keepRunning: true });
        const newer = record(A, T0 - MINUTE, { source: OTHER });
        const decision = decide({ now: T0, containers: [container(A)], records: [keep, newer], state: running() });
        expect(decision.superseded).toEqual([]);
        expect(decision.forget).toEqual([]);
      });

      it('keeps the newest record of an environment, however old', () => {
        const newest = record(A, T0 - RECORD_MAX_AGE_MS - MINUTE);
        const older = record(A, T0 - RECORD_MAX_AGE_MS - 2 * MINUTE, { source: OTHER });
        const decision = decide({ now: T0, containers: [container(A, 'exited')], records: [newest, older], state: running() });
        expect(decision.superseded).toEqual([older]);
      });

      it('keeps old records on a tie of their times, and removes only those with a strictly newer one', () => {
        const at = T0 - RECORD_MAX_AGE_MS - MINUTE;
        const one = record(A, at);
        const two = record(A, at, { source: OTHER });
        expect(decide({ now: T0, containers: [container(A)], records: [one, two], state: running() }).superseded).toEqual([]);
        const newer = record(A, T0 - MINUTE, { source: THIRD });
        expect(decide({ now: T0, containers: [container(A)], records: [one, two, newer], state: running() }).superseded).toEqual([one, two]);
      });

      it('compares the times as the rules see them: a record in the future counts from when it was first seen', () => {
        const old = record(A, T0 - RECORD_MAX_AGE_MS - 1);
        // Far in the future, first seen now: it is newer than the old record, so the old one goes.
        const future = record(A, T0 + 30 * 24 * 60 * MINUTE, { source: OTHER });
        const first = decide({ now: T0, containers: [container(A)], records: [old, future], state: running() });
        expect(first.superseded).toEqual([old]);
        // The future record itself is not removed by this rule: it is the newest.
        expect(first.superseded).not.toContain(future);
        // An old record whose clamped time is not older than 7 days stays, however far its written time is.
        const later = decide({ now: T0 + MINUTE, containers: [container(A)], records: [future, record(A, T0 + MINUTE, { source: THIRD })], state: first.state });
        expect(later.superseded).toEqual([]);
      });

      // Review round 1 of PR #63 (B2): the times of the rules for the record itself and for the others, with a record in the
      // future that was first seen days ago (futureSeen, `<source>.<environment id>.<at>`).
      describe('with a record in the future first seen days ago (review round 1 of PR #63, B2)', () => {
        const DAY = 24 * 60 * MINUTE;
        const future = record(A, T0 + 30 * DAY, { source: OTHER });
        const seenAt = (time: number) => running({ futureSeen: { [`${OTHER}.${A}.${future.at}`]: time } });

        it('removes an old record older than the first sight of the future one', () => {
          const old = record(A, T0 - 11 * DAY);
          expect(decide({ now: T0, containers: [container(A)], records: [future, old], state: seenAt(T0 - 10 * DAY) }).superseded).toEqual([old]);
        });

        it('removes the future record itself when it was first seen more than 7 days ago and a newer record exists', () => {
          const newer = record(A, T0 - 1000);
          expect(decide({ now: T0, containers: [container(A)], records: [future, newer], state: seenAt(T0 - 8 * DAY) }).superseded).toEqual([future]);
        });

        it('compares the others by the time of the rules too: its written time does not make it newer', () => {
          const old = record(A, T0 - 9 * DAY);
          expect(decide({ now: T0, containers: [container(A)], records: [future, old], state: seenAt(T0 - 10 * DAY) }).superseded).toEqual([future]);
        });
      });

      // Review round 1 of PR #63 (F1): the local check of the computer of a removed record (inUseByOtherComputer) would count
      // an old keep of another computer that is not newer than the removed record.
      it('keeps an old record while a keepRunning record of another computer is not newer than it', () => {
        const DAY = 24 * 60 * MINUTE;
        const keep = record(A, T0 - 10 * DAY, { source: OTHER, keepRunning: true });
        const own = record(A, T0 - 9 * DAY);
        const newest = record(A, T0 - 5 * MINUTE, { source: THIRD });
        const decision = decide({ now: T0, containers: [container(A)], records: [keep, own, newest], state: running() });
        expect(decision.superseded).not.toContain(own);
        const remaining = [keep, own, newest].filter((one) => !decision.superseded.includes(one));
        const output = (records: RemoteRecord[]) => ({ now: T0, records: records.map(({ source, at, keepRunning }) => ({ source, at, keepRunning })) });
        expect(inUseByOtherComputer(output(remaining), SOURCE)).toBe(false);
        // Without its own record, the old keep would count for that computer.
        expect(inUseByOtherComputer(output([keep, newest]), SOURCE)).toBe(true);
        // A keep of another computer that is newer than the record does not hold it back.
        const newerKeep = record(A, T0 - 8 * DAY, { source: OTHER, keepRunning: true });
        expect(decide({ now: T0, containers: [container(A)], records: [newerKeep, own, newest], state: running() }).superseded).toEqual([own]);
      });

      // Review round 2 of PR #63 (R2-6): a keep of another computer with the same time as the record holds it back too.
      // Review round 3 (R3-4): only as a precaution; on a tie the local check counts that keep whether the record stays or
      // not.
      it('keeps an old record while a keepRunning record of another computer has the same time', () => {
        const DAY = 24 * 60 * MINUTE;
        const keep = record(A, T0 - 9 * DAY, { source: OTHER, keepRunning: true });
        const own = record(A, T0 - 9 * DAY);
        const newest = record(A, T0 - 5 * MINUTE, { source: THIRD });
        expect(decide({ now: T0, containers: [container(A)], records: [keep, own, newest], state: running() }).superseded).toEqual([]);
      });

      // Review round 3 of PR #63 (R3-3): only a keep of the same environment holds a record back, not one of another.
      it('removes an old record although an old keepRunning record of another environment is not newer than it', () => {
        const DAY = 24 * 60 * MINUTE;
        const own = record(A, T0 - 9 * DAY);
        const newest = record(A, T0 - 5 * MINUTE, { source: THIRD });
        const otherKeep = record(B, T0 - 10 * DAY, { source: OTHER, keepRunning: true });
        const sameTime = record(B, own.at, { source: OTHER, keepRunning: true });
        for (const keep of [otherKeep, sameTime]) {
          expect(decide({ now: T0, containers: [container(A), container(B)], records: [keep, own, newest], state: running() }).superseded).toEqual([own]);
        }
      });

      // Review round 2 of PR #63 (R2-6): the local check compares the written times (`records` prints them), so the keep
      // check does too: a record in the future first seen 10 days ago stays while an older keep of another computer
      // exists, although its clamped time is older than that keep.
      it('compares the keep of another computer by the written times', () => {
        const DAY = 24 * 60 * MINUTE;
        const own = record(A, T0 + 30 * DAY);
        const keep = record(A, T0 - 9 * DAY, { source: OTHER, keepRunning: true });
        const newest = record(A, T0 - 5 * MINUTE, { source: THIRD });
        const state = running({ futureSeen: { [`${SOURCE}.${A}.${own.at}`]: T0 - 10 * DAY } });
        const decision = decide({ now: T0, containers: [container(A)], records: [own, keep, newest], state });
        expect(decision.superseded).not.toContain(own);
        const remaining = [own, keep, newest].filter((one) => !decision.superseded.includes(one));
        const output = (records: RemoteRecord[]) => ({ now: T0, records: records.map(({ source, at, keepRunning }) => ({ source, at, keepRunning })) });
        expect(inUseByOtherComputer(output(remaining), SOURCE)).toBe(false);
      });
    });
  });

  it('does not change the state it was given', () => {
    const state = running({ graceUntil: T0 + MINUTE });
    const copy = JSON.parse(JSON.stringify(state)) as RemoteMonitorState;
    decide({ now: T0, containers: [container(A)], records: [], state });
    expect(state).toEqual(copy);
  });
});
