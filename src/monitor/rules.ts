// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Decision logic of the Session Monitor (concept 7.9, implementation notes 12): rule 1 (in use), rule 2 (stop after the
// waiting time), and the sleep rule. Pure functions without I/O and without a clock of their own, so that every
// situation can be tested with plain values.
//
// One tick of the Session Monitor process:
//   1. Read the registry, the window status files, the pending connection files, and monitor.json.
//   2. `needed = containerStatesNeeded(input)`. Ask Docker only if `needed` is not empty, and only for these environments.
//      Otherwise pass an empty set and do not touch Docker at all (Docker Desktop Resource Saver, see there).
//   3. `decision = decide({ ...input, running })`. Keep `decision.state` for the next tick.
//   4. For each id in `decision.stop`: check again with freshly read files that the environment is still not in use
//      (recording the Git summary takes time), record the Git summary, then `docker stop`.
//      Remove the window status files of `decision.removeWindowFiles`.
//   5. End the process when `decision.exit` is true.
import type { MonitorSettings, PendingConnection, WindowStatus } from '../core/types';

/** Interval between two ticks of the Session Monitor (concept 7.9). */
export const TICK_MS = 5000;
/** A window status file whose `updatedAt` is older than this does not make its environment in use (rule 1). */
export const HEARTBEAT_MAX_AGE_MS = 60_000;
/** A pending connection file older than this does not make its environment in use (rule 1). */
export const PENDING_MAX_AGE_MS = 120_000;
/** A gap between two ticks larger than this means that the computer slept, or that the clock was changed. */
export const SLEEP_GAP_MS = 30_000;
/** After such a gap, the age of `updatedAt` is ignored for this time (sleep rule). */
export const SLEEP_GRACE_MS = 60_000;
/**
 * A failed Docker query (`running` is `undefined`) keeps the running waiting times for at most this time, so that one
 * slow or failed `docker` call neither restarts a waiting time nor lets the monitor end while a container may run.
 * After this time without an answer, Docker counts as not running: no container runs.
 */
export const DOCKER_UNKNOWN_MAX_MS = 30_000;
/**
 * The container of an environment that Docker reported as not running, and that nobody used since, is asked for again
 * only after this time. This covers containers that were started without the extension noticing it, for example with
 * `docker start`.
 */
export const STOPPED_RECHECK_MS = 10 * 60_000;
/** Default of the setting `devEnvLauncher.waitingTimeSeconds` (concept section 8). */
export const DEFAULT_WAITING_TIME_SECONDS = 30;

/** A window status file, and whether its process exists. */
export interface MonitorWindow {
  status: WindowStatus;
  /** The process `status.pid` exists (`isProcessAlive` of lock.ts). */
  alive: boolean;
}

/** An environment of the registry, reduced to what the rules need. */
export interface MonitorEnvironment {
  id: string;
  /**
   * The registry has a busy mark that still protects the environment (`isBusyMarkLive` of src/core/busy.ts, with the
   * window status files). Pass `false` for a mark of an ended process or of an ended window.
   */
  busy: boolean;
  /** The repository configuration sets `"shutdownAction": "none"`. */
  shutdownActionNone: boolean;
}

/** State that the Session Monitor keeps from one tick to the next. Only `decide` creates new states. */
export interface MonitorState {
  /** Time of the previous tick. */
  lastTickAt?: number;
  /** Until this time, active windows with a live process count as in use, whatever the age of `updatedAt`. */
  sleepGraceUntil?: number;
  /** Env id → time when the environment was first seen running and not in use: its waiting time runs. */
  idleSince: Record<string, number>;
  /** Window id → time when its process was first seen dead. */
  deadWindowSince: Record<string, number>;
  /** Env id → time when Docker reported the container as not running while the environment was not in use. */
  stoppedConfirmedAt: Record<string, number>;
  /** Time of the first failed Docker query of a series without an answer. */
  dockerUnknownSince?: number;
}

export function initialMonitorState(): MonitorState {
  return { idleSince: {}, deadWindowSince: {}, stoppedConfirmedAt: {} };
}

export interface InUseInput {
  /** Milliseconds since the epoch (wall clock: the window status files use it too). */
  now: number;
  /** All environments of the registry. The monitor never acts on other containers. */
  environments: MonitorEnvironment[];
  /** All window status files. */
  windows: MonitorWindow[];
  /** All pending connection files. */
  pendings: PendingConnection[];
  /** State of the previous tick, `initialMonitorState()` for the first one. It is not changed. */
  state: MonitorState;
}

export interface InUseResult {
  /** Ids of the environments that are in use. */
  inUse: Set<string>;
  /** `state` with `lastTickAt = now` and the updated sleep grace. */
  state: MonitorState;
}

/**
 * Rule 1 and the sleep rule. An environment is in use if
 * - a window status file references it, its state is `active`, its process exists, and its `updatedAt` is not older
 *   than HEARTBEAT_MAX_AGE_MS (during the sleep grace, the age does not matter), or
 * - a pending connection file for it is not older than PENDING_MAX_AGE_MS, or
 * - it is busy.
 * A window in the state `closing` never makes an environment in use.
 *
 * The sleep grace starts when the time since the previous tick is larger than SLEEP_GAP_MS (the computer slept, or the
 * clock was changed), and at the first tick, because a monitor that just started cannot know whether the computer
 * just woke up. The result depends only on the input, so `containerStatesNeeded` and `decide` see the same result.
 */
export function computeInUse(input: InUseInput): InUseResult {
  const { now } = input;
  const state = advanceClock(input.state, now);
  const grace = inSleepGrace(state, now);
  const known = new Set(input.environments.map((environment) => environment.id));
  const inUse = new Set<string>();
  for (const environment of input.environments) {
    if (environment.busy) inUse.add(environment.id);
  }
  for (const window of input.windows) {
    const id = window.status.environmentId;
    if (id && known.has(id) && windowReports(window, now, grace)) inUse.add(id);
  }
  for (const pending of input.pendings) {
    if (known.has(pending.environmentId) && isFresh(pending.createdAt, now, PENDING_MAX_AGE_MS)) {
      inUse.add(pending.environmentId);
    }
  }
  return { inUse, state };
}

export interface DecideInput extends InUseInput {
  /** Content of monitor.json (the caller uses defaults when the file is missing). */
  settings: MonitorSettings;
  /**
   * Ids of the environments whose container runs, as Docker reports it now. Only the environments of
   * `containerStatesNeeded()` need to be included: environments that are in use, that are never stopped, or whose
   * container is known to be stopped are not needed. When that list is empty, do not call Docker and pass an empty set.
   *
   * `undefined`: Docker did not answer (not running, or the call failed). A container that was seen running keeps its
   * waiting time, and nothing is stopped. After DOCKER_UNKNOWN_MAX_MS without an answer, Docker counts as not running,
   * and nothing runs. Never start Docker to answer this (concept 7.6: the Session Monitor never starts Docker).
   */
  running: ReadonlySet<string> | undefined;
}

/**
 * Ids of the environments whose container state `decide` needs in this tick: environments that are not in use, that
 * rule 2 may stop, and whose container is not known to be stopped (or whose last check is older than
 * STOPPED_RECHECK_MS).
 *
 * This keeps the monitor away from Docker when nothing can need a stop: while a window is open and every environment
 * is in use, or stopped and unused, the list is empty and the monitor makes no Docker call. So the Resource Saver mode
 * of Docker Desktop can stop the Docker engine when no container runs (concept 7.9 "Why docker stop"), also while VS
 * Code windows stay open for hours. A Docker call every 5 seconds could keep the engine awake or wake it again (Docker
 * documents only that listing commands do not necessarily wake it), so the caller asks Docker only for this list, with
 * one call.
 *
 * While no window is open, every environment that may be stopped and is not in use is in the list, also a known stopped
 * one: the monitor ends only after Docker confirmed that none of these containers runs.
 *
 * Requirement for the open pipeline: an environment must be in use (busy mark or pending connection file) at the latest
 * right after its container starts. Then it leaves the "known stopped" set before it can run without a window.
 * A container that is started in another way (for example `docker start`) is found by the check after
 * STOPPED_RECHECK_MS, when the last window closes, or at the next start of the monitor.
 *
 * Pass exactly the input of the following `decide` call (the same `now`, files, and state): `decide` takes a missing id
 * of this list in `running` as "Docker reported it stopped".
 */
export function containerStatesNeeded(input: Omit<DecideInput, 'running'>): string[] {
  const { inUse, state } = computeInUse(input);
  return statesNeeded(input, inUse, state);
}

export interface MonitorDecision {
  /** State for the next tick, with `lastTickAt = now`. */
  state: MonitorState;
  inUse: Set<string>;
  /**
   * Env ids to stop now: record the Git summary first, then `docker stop`. The waiting time of such an environment
   * stays in the state until Docker reports the container as not running, so a failed stop is repeated in the next tick.
   */
  stop: string[];
  /**
   * Window ids whose status file can be removed: the process ended at least the waiting time ago, or the process
   * exists but the file was not updated for HEARTBEAT_MAX_AGE_MS plus the waiting time (a reused process ID, or an
   * extension host that hangs; a live window writes its file again at its next update). Not during the sleep grace.
   */
  removeWindowFiles: string[];
  /**
   * End the Session Monitor: no window is alive (process exists, state `active`, file not removed in this tick), no
   * waiting time runs, no pending connection file is fresh, no environment is in use, and Docker answered (or counts as
   * not running, or no container state is needed).
   */
  exit: boolean;
}

/**
 * Rule 2. The container of an environment that runs and is not in use gets a waiting time (`idleSince`). When the
 * environment is still not in use after the waiting time (`settings.waitingTimeSeconds`), it is stopped. An environment
 * that is in use again loses its waiting time, so the next waiting time starts from zero.
 * `settings.stopOnClose === false` → nothing is stopped. `settings.respectShutdownActionNone` and
 * `environment.shutdownActionNone` → this environment is never stopped.
 */
export function decide(input: DecideInput): MonitorDecision {
  const { now, settings, running } = input;
  const waitingMs = waitingTimeMs(settings);
  const { inUse, state } = computeInUse(input);
  const grace = inSleepGrace(state, now);
  const needed = new Set(statesNeeded(input, inUse, state));

  const environmentIds = new Set(input.environments.map((environment) => environment.id));
  state.idleSince = keepKeys(state.idleSince, environmentIds);
  state.stoppedConfirmedAt = keepKeys(state.stoppedConfirmedAt, environmentIds);

  let dockerDown = false;
  if (running === undefined) {
    state.dockerUnknownSince ??= now;
    dockerDown = now - state.dockerUnknownSince >= DOCKER_UNKNOWN_MAX_MS;
  } else {
    delete state.dockerUnknownSince;
  }

  const stop: string[] = [];
  const handled = new Set<string>();
  for (const environment of input.environments) {
    const id = environment.id;
    if (handled.has(id)) continue;
    handled.add(id);
    if (inUse.has(id) || !mayStop(environment, settings)) {
      // In use again: the next waiting time starts from zero. A window may start the container, so ask Docker again.
      delete state.idleSince[id];
      delete state.stoppedConfirmedAt[id];
      continue;
    }
    if (running === undefined) {
      if (dockerDown) {
        // Docker does not run, so no container runs (implementation notes 12).
        delete state.idleSince[id];
        if (needed.has(id)) state.stoppedConfirmedAt[id] = now;
      }
      // Otherwise keep the waiting time as it is: one failed query must not restart it.
      continue;
    }
    if (running.has(id)) {
      delete state.stoppedConfirmedAt[id];
      const since = state.idleSince[id] ?? now;
      state.idleSince[id] = since;
      if (now - since >= waitingMs) stop.push(id);
    } else {
      delete state.idleSince[id];
      // Only an environment that Docker was asked for is confirmed. A missing entry of an environment that was not
      // needed says nothing, and must not postpone its next check.
      if (needed.has(id)) state.stoppedConfirmedAt[id] = now;
    }
  }

  const removeWindowFiles: string[] = [];
  const windowIds = new Set<string>();
  for (const window of input.windows) {
    const id = window.status.windowId;
    if (windowIds.has(id)) continue;
    windowIds.add(id);
    if (!window.alive) {
      const since = state.deadWindowSince[id] ?? now;
      state.deadWindowSince[id] = since;
      if (now - since >= waitingMs) removeWindowFiles.push(id);
      continue;
    }
    delete state.deadWindowSince[id];
    // A process ID can be reused by another program, for example after a restart of the computer. Without this rule,
    // such a file would count as a live window for as long as that program runs, and the monitor would never end.
    if (isStaleLiveWindow(window, now, grace, waitingMs)) removeWindowFiles.push(id);
  }
  state.deadWindowSince = keepKeys(state.deadWindowSince, windowIds);

  const windowAlive = hasOpenWindow(input.windows, now, grace, waitingMs);
  const pendingFresh = input.pendings.some((pending) => isFresh(pending.createdAt, now, PENDING_MAX_AGE_MS));
  const dockerAnswered = running !== undefined || dockerDown || needed.size === 0;
  const exit =
    !windowAlive &&
    !pendingFresh &&
    inUse.size === 0 &&
    Object.keys(state.idleSince).length === 0 &&
    dockerAnswered;

  return { state, inUse, stop, removeWindowFiles, exit };
}

/** The waiting time of the settings in milliseconds. A missing, negative, or invalid value gives the default. */
export function waitingTimeMs(settings: Pick<MonitorSettings, 'waitingTimeSeconds'>): number {
  const seconds: unknown = settings.waitingTimeSeconds;
  // Assumption (V-4): a window reload takes less than the waiting time, so the default of 30 s prevents a stop
  // during a reload.
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return DEFAULT_WAITING_TIME_SECONDS * 1000;
  }
  return Math.round(seconds * 1000);
}

function mayStop(environment: MonitorEnvironment, settings: MonitorSettings): boolean {
  // monitor.json is written by windows; anything but an explicit false keeps the default (stop).
  if (settings.stopOnClose === false) return false;
  return !(settings.respectShutdownActionNone === true && environment.shutdownActionNone);
}

function statesNeeded(
  input: Omit<DecideInput, 'running' | 'state'>,
  inUse: ReadonlySet<string>,
  state: MonitorState,
): string[] {
  const { now, settings } = input;
  // Without an open window the monitor may end in this tick. A container started after its last check without its
  // environment becoming in use (for example the open pipeline failed after `devcontainer up`) would then keep running
  // with no monitor at all, so every known stopped container is checked again.
  const recheckAll = !hasOpenWindow(input.windows, now, inSleepGrace(state, now), waitingTimeMs(settings));
  const needed: string[] = [];
  const seen = new Set<string>();
  for (const environment of input.environments) {
    const id = environment.id;
    if (seen.has(id)) continue;
    seen.add(id);
    if (inUse.has(id) || !mayStop(environment, settings)) continue;
    const confirmedAt = state.stoppedConfirmedAt[id];
    if (!recheckAll && confirmedAt !== undefined && now - confirmedAt < STOPPED_RECHECK_MS) continue;
    needed.push(id);
  }
  return needed;
}

/**
 * The process exists, but the file was not updated for HEARTBEAT_MAX_AGE_MS plus the waiting time (a reused process ID,
 * or a hanging extension host). Never during the sleep grace.
 */
function isStaleLiveWindow(window: MonitorWindow, now: number, grace: boolean, waitingMs: number): boolean {
  return window.alive && !grace && !isFresh(window.status.updatedAt, now, HEARTBEAT_MAX_AGE_MS + waitingMs);
}

/** A window keeps the monitor running: its process exists, its state is `active`, and its file is not stale. */
function hasOpenWindow(windows: MonitorWindow[], now: number, grace: boolean, waitingMs: number): boolean {
  return windows.some(
    (window) => window.alive && window.status.state === 'active' && !isStaleLiveWindow(window, now, grace, waitingMs),
  );
}

/** Copy of the previous state for this tick: times clamped to `now`, sleep grace updated, `lastTickAt = now`. */
function advanceClock(previous: MonitorState, now: number): MonitorState {
  // Clamping handles a clock that was set back: a waiting time that started "in the future" would otherwise never end.
  // A record may be missing in a state that was built with the fields of the contract only.
  const state: MonitorState = {
    idleSince: clampTimes(previous.idleSince ?? {}, now),
    deadWindowSince: clampTimes(previous.deadWindowSince ?? {}, now),
    stoppedConfirmedAt: clampTimes(previous.stoppedConfirmedAt ?? {}, now),
  };
  if (previous.dockerUnknownSince !== undefined && Number.isFinite(previous.dockerUnknownSince)) {
    state.dockerUnknownSince = Math.min(previous.dockerUnknownSince, now);
  }
  const gap = previous.lastTickAt === undefined ? Number.POSITIVE_INFINITY : now - previous.lastTickAt;
  // Assumption (V-3): after computer sleep, every window writes its status file again within SLEEP_GRACE_MS (windows
  // write every 15 seconds), and the process of a window that was closed during the sleep has ended.
  if (!(Math.abs(gap) <= SLEEP_GAP_MS)) {
    state.sleepGraceUntil = now + SLEEP_GRACE_MS;
  } else if (previous.sleepGraceUntil !== undefined && now < previous.sleepGraceUntil) {
    state.sleepGraceUntil = Math.min(previous.sleepGraceUntil, now + SLEEP_GRACE_MS);
  }
  state.lastTickAt = now;
  return state;
}

/**
 * True if the sleep grace runs in a tick at `now` after the state `previous`: exactly what `computeInUse` and `decide`
 * use for the same `now` and state. For the checks of rule 1 that the caller makes itself (the busy marks, see
 * monitorLoop.ts), so that they ignore the age of `updatedAt` in the same ticks as the rules.
 */
export function sleepGraceAt(previous: MonitorState, now: number): boolean {
  return inSleepGrace(advanceClock(previous, now), now);
}

function inSleepGrace(state: MonitorState, now: number): boolean {
  return state.sleepGraceUntil !== undefined && now < state.sleepGraceUntil;
}

/** The window is active, its process exists, and its file is fresh (or the sleep grace runs). */
function windowReports(window: MonitorWindow, now: number, grace: boolean): boolean {
  if (window.status.state !== 'active' || !window.alive) return false;
  return grace || isFresh(window.status.updatedAt, now, HEARTBEAT_MAX_AGE_MS);
}

/** The ISO time is valid and at most `maxAgeMs` away from `now`. */
function isFresh(time: string, now: number, maxAgeMs: number): boolean {
  const at = Date.parse(time);
  // Also a time far in the future is not fresh: after the clock was set back, such a file would otherwise count as
  // fresh until the clock reaches it again. A live window rewrites its file within seconds.
  return Number.isFinite(at) && Math.abs(now - at) <= maxAgeMs;
}

function clampTimes(times: Record<string, number>, now: number): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(times)) {
    if (Number.isFinite(value)) result[key] = Math.min(value, now);
  }
  return result;
}

function keepKeys(times: Record<string, number>, keys: ReadonlySet<string>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(times)) {
    if (keys.has(key)) result[key] = value;
  }
  return result;
}
