// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Decision logic of the Session Monitor on a remote Docker host (unit 7, PR 2; implementation notes 16): the dead-man
// switch for a computer that is offline, asleep, or switched to another Docker host. Pure functions without I/O and
// without a clock of their own; main.ts reads the containers and the heartbeat records and runs the stops.
//
// One tick:
//   1. `docker ps -a --filter label=nimblescape.devenv.environment-id` (parseContainerLines) and the records of the
//      volume.
//   2. `decision = decide({ now, containers, records, state })`. Keep `decision.state` for the next tick.
//   3. `docker stop` of each container of `decision.stop` (the dev container first), and removal of the files of
//      `decision.forget` (old records of removed environments).
/** Interval between two ticks. */
export const REMOTE_TICK_MS = 15_000;
/** A time since the previous tick larger than this means that the host or the container was paused, or the clock changed. */
export const REMOTE_GAP_MS = 60_000;
/** After such a gap (and after the start), nothing is stopped for this time: the computers send heartbeats again first. */
export const REMOTE_GRACE_MS = 120_000;
/** A record of an environment that has no container at all any more is removed after this time. */
export const RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A record whose `at` is later than now plus this counts as written when the monitor first saw it (review round 1 of
 * PR #39, R1): a forged or skewed time in the future must not keep an environment for ever. It is not dropped: without a
 * record the monitor would not act on the environment at all. A restart of the monitor sees it anew (the gap rule holds
 * the stops after the start anyway).
 */
export const FUTURE_RECORD_TOLERANCE_MS = 5 * 60_000;

/** A container with the label nimblescape.devenv.environment-id, as `docker ps -a` lists it. */
export interface RemoteContainer {
  id: string;
  /** `.State` of `docker ps`, for example `running` or `exited`. */
  state: string;
  name: string;
  environmentId: string;
  /** The label nimblescape.devenv.compose-service; empty for the dev container. */
  composeService: string;
}

/** A heartbeat record of the volume, with the parts of its file name. */
export interface RemoteRecord {
  source: string;
  environmentId: string;
  at: number;
  keepRunning: boolean;
  limitSeconds: number;
}

/** State that the monitor keeps from one tick to the next. Only `decide` creates new states. */
export interface RemoteMonitorState {
  /** Time of the previous tick. */
  lastTickAt?: number;
  /** Until this time nothing is stopped (the gap rule). */
  graceUntil?: number;
  /**
   * `<source>.<environment id>.<at>` of a record whose time is in the future (FUTURE_RECORD_TOLERANCE_MS) → the time the
   * monitor first saw it: the record counts as written then, and ages from then on.
   */
  futureSeen?: Record<string, number>;
}

export function initialRemoteState(): RemoteMonitorState {
  return {};
}

/** The times of the rules; tests of the container give shorter ones (main.ts, DEVENV_MONITOR_TICK_MS). */
export interface RemoteTiming {
  gapMs: number;
  graceMs: number;
}

export const DEFAULT_REMOTE_TIMING: RemoteTiming = { gapMs: REMOTE_GAP_MS, graceMs: REMOTE_GRACE_MS };

export interface RemoteDecideInput {
  /** The clock of the remote host (the records use it too). */
  now: number;
  containers: readonly RemoteContainer[];
  records: readonly RemoteRecord[];
  /** State of the previous tick, `initialRemoteState()` for the first one. It is not changed. */
  state: RemoteMonitorState;
  timing?: RemoteTiming;
}

/** An environment to stop: its running containers, the dev container first, and the reason for the log. */
export interface RemoteStop {
  environmentId: string;
  containers: RemoteContainer[];
  reason: string;
}

export interface RemoteDecision {
  state: RemoteMonitorState;
  stop: RemoteStop[];
  /** Env ids with a running container that a record keeps running (Keep Running When Closed, Close and Keep Running). */
  kept: string[];
  /** Records to remove: their environment has no container at all, and they are older than RECORD_MAX_AGE_MS. */
  forget: RemoteRecord[];
  /** The gap rule holds every stop in this tick. */
  grace: boolean;
}

/** True for a state of `docker ps` in which the container runs (as mapContainerState of the extension). */
export function isRunningState(state: string): boolean {
  return state === 'running' || state === 'restarting' || state === 'paused';
}

/**
 * The rules, per environment with at least one running container:
 * - no record at all → never acted on: no computer sent a heartbeat for it (for example an environment of the host's own
 *   local Docker, or of a build without heartbeats), so the monitor cannot know whether it is in use (coordinator
 *   decision of PR 2; the open pipeline writes the first heartbeat of every remote environment);
 * - the newest record decides (review round 2 of PR #39, M1): the record with the latest `at` of all sources (the time
 *   the host received it; for equal times, one that says keepRunning). It says keepRunning → it keeps running;
 *   otherwise it stops when more than its `limitSeconds` has passed since its `at`. So a later choice of any computer
 *   overrules an older keep of another one (for example of a computer that no longer sends), and the keep of a computer
 *   that still sends holds until someone makes a newer choice.
 * The gap rule: when the time since the previous tick is larger than `gapMs` (the host or the container was paused, the
 * clock was changed), and at the first tick, nothing is stopped for `graceMs`: the computers that still use their
 * environments send heartbeats again first (they retry every tick of their Session Monitor). Records whose environment
 * has no container at all (running or not) and whose `at` is older than RECORD_MAX_AGE_MS are removed. The monitor
 * never acts on containers without the label nimblescape.devenv.environment-id (the caller lists only those).
 */
export function decide(input: RemoteDecideInput): RemoteDecision {
  const { now } = input;
  const timing = input.timing ?? DEFAULT_REMOTE_TIMING;
  const previous = input.state;
  const gap = previous.lastTickAt === undefined ? Number.POSITIVE_INFINITY : now - previous.lastTickAt;
  let graceUntil = previous.graceUntil;
  if (!(Math.abs(gap) <= timing.gapMs)) graceUntil = now + timing.graceMs;
  else if (graceUntil !== undefined) graceUntil = Math.min(graceUntil, now + timing.graceMs);
  const grace = graceUntil !== undefined && now < graceUntil;

  const running = new Map<string, RemoteContainer[]>();
  const present = new Set<string>();
  for (const container of input.containers) {
    present.add(container.environmentId);
    if (!isRunningState(container.state)) continue;
    running.set(container.environmentId, [...(running.get(container.environmentId) ?? []), container]);
  }
  const recordsOf = new Map<string, RemoteRecord[]>();
  const futureSeen: Record<string, number> = {};
  const clamped = input.records.map((record) => {
    if (record.at <= now + FUTURE_RECORD_TOLERANCE_MS) return record;
    const key = `${record.source}.${record.environmentId}.${record.at}`;
    const seen = Math.min(previous.futureSeen?.[key] ?? now, now);
    futureSeen[key] = seen;
    return { ...record, at: seen };
  });
  for (const record of clamped) {
    recordsOf.set(record.environmentId, [...(recordsOf.get(record.environmentId) ?? []), record]);
  }

  const stop: RemoteStop[] = [];
  const kept: string[] = [];
  for (const [environmentId, containers] of running) {
    const records = recordsOf.get(environmentId) ?? [];
    // Without any record the monitor never acts on it.
    if (records.length === 0) continue;
    const newest = records.reduce((best, record) =>
      record.at > best.at || (record.at === best.at && record.keepRunning && !best.keepRunning) ? record : best,
    );
    if (newest.keepRunning) {
      kept.push(environmentId);
      continue;
    }
    if (grace || now - newest.at <= newest.limitSeconds * 1000) continue;
    const minutes = Math.round((now - newest.at) / 60_000);
    const reason = `no computer sent a heartbeat for ${minutes} minutes (limit ${newest.limitSeconds / 60} minutes)`;
    stop.push({ environmentId, containers: devContainerFirst(containers), reason });
  }

  const forget = input.records.filter((record) => !present.has(record.environmentId) && now - record.at > RECORD_MAX_AGE_MS);
  // (A record with a time in the future is kept by this rule until its time has passed by 7 days.)
  const state: RemoteMonitorState = { lastTickAt: now };
  if (Object.keys(futureSeen).length > 0) state.futureSeen = futureSeen;
  if (graceUntil !== undefined && now < graceUntil) state.graceUntil = graceUntil;
  return { state, stop, kept, forget, grace };
}

/**
 * The containers of one environment in the order of the stop: the dev container (no nimblescape.devenv.compose-service)
 * first.
 */
export function devContainerFirst(containers: readonly RemoteContainer[]): RemoteContainer[] {
  return [...containers].sort((a, b) => (a.composeService === '' ? 0 : 1) - (b.composeService === '' ? 0 : 1));
}
