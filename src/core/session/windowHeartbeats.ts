// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 8, PR A: the heartbeats of a window to the Session Monitor container (`devenv-session-monitor`) of the Docker
// engine of each environment that the window uses, on every engine, local and remote (user decisions of 2026-10-02, Q1
// and Q4). Driven by the window's tick of 15 s (SessionCoordinator); before, the local Node.js Session Monitor sent them,
// only to an SSH host (MonitorLoop.sendHeartbeat, removed).
//
// The environments of a window: the one it is connected to (its status file), and those that this window holds a live
// busy mark for (an open, a rebuild that runs here), so the monitor does not stop a container while this window works on
// it. Each heartbeat carries the long limit (the setting stopAfterMinutes, default 10 minutes) and the keep-running flag
// (keptWhenClosed). It goes to the engine the window uses the environment on (`engineFor`, remembered per environment),
// through this window's worker (`send`: a routed `docker exec` on the monitor container, without `-i`; only IDs and flags
// in its arguments, never a token). A heartbeat of an engine is sent at once when an environment or its flag is new to the
// series, or the limit changed; otherwise every WINDOW_HEARTBEAT_INTERVAL_MS. `seq` is the time before the registry was
// read (review round 2 of PR #39, L1).
//
// Q4: the full repair path of D1. The worker that `send` uses is made ready by it (the helper image, the open); a monitor
// container that is missing is started again (`repair`, the ensure of the open) and the heartbeat is sent once more.
// After HEARTBEAT_WARN_AFTER_FAILURES failures in a row on the engine of the connected environment, `warn` gets a
// message with the time left before the monitor may stop it, once per failure streak; a success ends the streak.
//
// Review round 1 of PR #85: each engine has its own series of calls with its own in-flight guard (A-R1-2), so a slow
// engine neither delays the heartbeats of another nor piles up calls; each attempt (send, repair, send) is bounded by
// HEARTBEAT_ATTEMPT_DEADLINE_MS (an AbortSignal for `send` and `repair`, and a race): an attempt past it counts as a
// failure towards the Q4 warning, and while it still hangs, each due heartbeat of that engine counts as one more failure
// without a new call. The engine of the connected environment is the one of this window's own Docker context
// (`engineFor` with `connected`); when it cannot be found, each tick counts as a failed heartbeat and the Q4 warning
// fires as for any other failure (A-R1-3). After a failed repair, further repairs of that engine wait REPAIR_BACKOFF_MS
// (1, 2, then 5 minutes) while the plain heartbeat is still sent; a success resets it (A-R1-4).
//
// Review round 2 of PR #85 (A-R2-1): the engine found for the connected environment is trusted only when the
// environment's container exists on it (`containerExists`, a routed `docker container inspect` of its container name,
// within HEARTBEAT_ATTEMPT_DEADLINE_MS): else, or when the check fails, the engine counts as not found for that tick (a
// failed heartbeat towards the Q4 warning) and nothing is sent or repaired for that environment there. A verified engine
// is kept; after a failed heartbeat it is checked again. A repair (the start of a missing monitor container) happens only
// on an engine where an environment of the heartbeat has its container (for the busy marks, checked at the repair).
// No `vscode`; never throws (except from a `deps` call that throws, which a tick logs).
import { BUSY_MARK_MAX_AGE_MS } from '../busy';
import { DEFAULT_CONTEXT_NAME, describeDockerHost, dockerHostOf, isOnDockerHost, remoteContextName, sshEndpoint, type DockerTarget } from '../docker/dockerHost';
import { errorMessage } from '../errors';
import { Messages } from '../messages';
import { systemClock, type Clock, type Logger } from '../ports';
import { MAX_HEARTBEAT_ENVIRONMENTS, isRemoteEnvironmentId, type HeartbeatInput } from '../remoteMonitor/protocol';
import type { Environment, ExtensionSettings } from '../types';
import { keepFlagsOf, keptWhenClosed, stopAfterSeconds } from './sessionRules';

/** While a window uses an environment, a heartbeat goes to its engine at least this often (as before, unit 7 PR 2). */
export const WINDOW_HEARTBEAT_INTERVAL_MS = 30_000;
/** User decision Q4 of 2026-10-02: the window warns after this many failed heartbeats in a row. */
export const HEARTBEAT_WARN_AFTER_FAILURES = 2;
/**
 * Review round 1 of PR #85 (A-R1-2): one attempt on an engine (the send, a repair with the helper image and the start of
 * the monitor container, the send again) ends after this time and counts as a failure. Well below the smallest limit of
 * the setting stopAfterMinutes (5 minutes), so the Q4 warning comes in time.
 */
export const HEARTBEAT_ATTEMPT_DEADLINE_MS = 120_000;
/** The detail of an attempt that passed HEARTBEAT_ATTEMPT_DEADLINE_MS. */
export const HEARTBEAT_NO_ANSWER = 'no answer in time';
/**
 * Review round 1 of PR #85 (A-R1-4): after the 1st, the 2nd, and each later failed repair of an engine in a row, the next
 * repair waits this long (the plain heartbeat is still sent at each due tick). A success resets it.
 */
export const REPAIR_BACKOFF_MS: readonly number[] = [60_000, 120_000, 300_000];

/** The result of one heartbeat. `missing`: the monitor container does not exist or does not run. */
export type HeartbeatSendResult = { ok: true } | { ok: false; missing: boolean; detail: string };

export interface WindowHeartbeatsDeps {
  /** The ID and process of this window, for its own busy marks. */
  owner: () => { windowId: string; pid: number };
  /** The environment this window is connected to (SessionCoordinator.environmentId), or null. */
  connected: () => string | null;
  registry: { list(): Promise<Environment[]> };
  settings: () => Pick<ExtensionSettings, 'stopOnClose' | 'respectShutdownActionNone' | 'stopAfterMinutes'>;
  /** The id of this computer (`computer.id`), the source of the heartbeats. */
  sourceId: () => string;
  /**
   * The Docker engine of an environment as this window uses it; undefined when it cannot be found from here. For the
   * environment this window is connected to (`use.connected`), the engine of this window's own Docker context, never the
   * global current one (review round 1 of PR #85, A-R1-3); for one it is busy with, the engine of the operation. Asked
   * once per environment and role; the answer is kept while the window uses it.
   */
  engineFor: (environment: Environment, use: { connected: boolean }) => Promise<DockerTarget | undefined>;
  /**
   * One heartbeat on the engine `target`, through this window's worker (RemoteSessionMonitor.heartbeat). Never throws.
   * `signal` aborts when the attempt passed HEARTBEAT_ATTEMPT_DEADLINE_MS.
   */
  send: (target: DockerTarget, input: HeartbeatInput, signal: AbortSignal) => Promise<HeartbeatSendResult>;
  /**
   * Starts the monitor container of `target` again (the ensure of the open). Rejects with the cause when it cannot.
   * `signal` aborts when the attempt passed HEARTBEAT_ATTEMPT_DEADLINE_MS.
   */
  repair: (target: DockerTarget, signal: AbortSignal) => Promise<void>;
  /**
   * Review round 2 of PR #85 (A-R2-1): whether the container of `environment` (its containerName in the registry) exists
   * on the engine `target`; false when it does not or cannot be checked. `signal` aborts at
   * HEARTBEAT_ATTEMPT_DEADLINE_MS.
   */
  containerExists: (target: DockerTarget, environment: Environment, signal: AbortSignal) => Promise<boolean>;
  /** Q4: shows a warning to the user (the vscode layer). */
  warn: (message: string) => void;
  logger: Logger;
  clock?: Clock;
}

/** The heartbeats to the monitor of one engine. */
interface Series {
  target: DockerTarget;
  /** Env id → the keep-running flag of the last successful heartbeat. */
  sent: Map<string, boolean>;
  /** The limit of the last successful heartbeat. */
  limitSeconds?: number;
  /** Time of the last successful heartbeat (the seq it carried). */
  sentAt?: number;
  /** When the series started: the base of the time left when no heartbeat of it succeeded yet. */
  startedAt: number;
  /** Failed heartbeats in a row. */
  failures: number;
  /** Q4: the warning of this failure streak was shown. */
  warned: boolean;
  /** A-R1-4: failed repairs in a row. */
  repairFailures: number;
  /** A-R1-4: no repair before this time. */
  repairNotBefore?: number;
}

/** A-R1-3: the failure streak of a connected environment whose engine cannot be found. */
interface Unresolved {
  startedAt: number;
  failures: number;
  warned: boolean;
}

/** A-R1-2: the call that runs on an engine; `expired` once it passed its deadline (it may still hang). */
interface InFlight {
  done: Promise<unknown>;
  expired: boolean;
}

interface Group {
  target: DockerTarget;
  entries: Map<string, boolean>;
  /** A-R2-1: the environments of `entries`. */
  environments: Environment[];
  connected?: Environment;
}

function engineKey(target: DockerTarget): string {
  return JSON.stringify([target.kind, target.host, target.context ?? null, target.endpoint]);
}

function engineName(target: DockerTarget): string {
  return target.kind === 'local' ? 'the local Docker' : target.host;
}

/** A-R1-4: the wait after `failures` failed repairs in a row. */
export function repairBackoffMs(failures: number): number {
  return REPAIR_BACKOFF_MS[Math.min(Math.max(failures, 1), REPAIR_BACKOFF_MS.length) - 1];
}

/** What resolveHeartbeatEngine reads. */
export interface HeartbeatEngineSources {
  /** The Docker context of this window (its authority, as in its status file), when this window shows `environment`. */
  windowContext: (environment: Environment) => string | undefined;
  /** The current Docker target (the global current context, or DOCKER_HOST). */
  current: () => Promise<DockerTarget>;
  /** The target of a named Docker context (DockerTargets.ofContext); undefined when it cannot be read. */
  ofContext: (name: string) => Promise<DockerTarget | undefined>;
}

/**
 * The engine of `environment` for its heartbeats (WindowHeartbeatsDeps.engineFor). Review round 1 of PR #85 (A-R1-3):
 * for the connected environment, the engine of this window's own Docker context, also for a local environment, never
 * the global current context when the window has its own (another window may have switched that to another host);
 * undefined when that context is not on the host of the environment. A window without its own context takes the
 * current target when it is on the host of the environment, else for an SSH host the context of "Use a Remote Docker
 * Host…" and for the local Docker the context `default`. An environment this window is only busy with (an operation
 * runs on it) takes the current target when it is on its host, else for an SSH host that context; else undefined.
 */
export async function resolveHeartbeatEngine(environment: Environment, use: { connected: boolean }, sources: HeartbeatEngineSources): Promise<DockerTarget | undefined> {
  const host = dockerHostOf(environment);
  const own = use.connected ? sources.windowContext(environment) : undefined;
  if (own !== undefined) {
    const target = await sources.ofContext(own);
    return target !== undefined && target.kind !== 'unsupported' && isOnDockerHost(environment, target.host) ? target : undefined;
  }
  const current = await sources.current();
  if (current.kind !== 'unsupported' && isOnDockerHost(environment, current.host)) return current;
  if (host !== '') return { kind: 'remote', host, endpoint: sshEndpoint(host), context: remoteContextName(host) };
  if (!use.connected) return undefined;
  const local = await sources.ofContext(DEFAULT_CONTEXT_NAME);
  return local?.kind === 'local' ? local : undefined;
}

export class WindowHeartbeats {
  private readonly clock: Clock;
  private readonly series = new Map<string, Series>();
  /** Env id → the engine the window uses it on (engineFor), and whether it was asked as the connected environment. */
  private readonly engines = new Map<string, { target: DockerTarget; connected: boolean; verified?: boolean }>();
  /** A-R2-1: env id and engine key → the check of its container that runs (joined by a later tick). */
  private readonly verifying = new Map<string, Promise<boolean>>();
  /** Env ids whose engine could not be found (logged once). */
  private readonly unreachable = new Set<string>();
  /** A-R1-3: env id → the failure streak of the connected environment whose engine cannot be found. */
  private readonly unresolved = new Map<string, Unresolved>();
  /** Env id → the time of its last successful heartbeat. */
  private readonly envSentAt = new Map<string, number>();
  /** A-R1-2: engine key → the call that runs on it. */
  private readonly inFlight = new Map<string, InFlight>();
  /** The environments and engines of a tick are being read (the sends of a tick then run per engine). */
  private collecting = false;
  private disposed = false;

  constructor(private readonly deps: WindowHeartbeatsDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * The window's tick: sends the heartbeats that are due, per engine and at the same time; an engine whose previous call
   * still runs is skipped (review round 1 of PR #85, A-R1-2). Never throws.
   */
  async tick(): Promise<void> {
    if (this.collecting || this.disposed) return;
    const now = this.clock.now();
    let groups: Group[];
    this.collecting = true;
    try {
      groups = await this.collect(now);
    } catch (error) {
      this.deps.logger.warn(`The heartbeats to the Session Monitor could not be sent: ${errorMessage(error)}`);
      return;
    } finally {
      this.collecting = false;
    }
    const limitSeconds = stopAfterSeconds(this.deps.settings().stopAfterMinutes);
    await Promise.all(
      groups.map(async (group) => {
        try {
          await this.runEngine(group, now, limitSeconds);
        } catch (error) {
          this.deps.logger.warn(`The heartbeats to the Session Monitor on ${engineName(group.target)} could not be sent: ${errorMessage(error)}`);
        }
      }),
    );
  }

  /**
   * One heartbeat for `environmentId` now, with its current keep-running flag (Close and Keep Running, Keep Running When
   * Closed, Stop When Closed), to the engine this window uses it on, with the repair of `send` and `repair`, within
   * HEARTBEAT_ATTEMPT_DEADLINE_MS. A call of a tick that runs on that engine is waited for first. Never throws.
   */
  async sendFor(environmentId: string): Promise<{ ok: true } | { ok: false; detail: string }> {
    try {
      // Review round 2 of PR #39 (L1): `seq` is the time before the flags are read.
      const seq = this.clock.now();
      const environment = (await this.deps.registry.list()).find((candidate) => candidate.id === environmentId);
      if (environment === undefined) return { ok: false, detail: 'The environment is not in the registry.' };
      if (!isRemoteEnvironmentId(environment.id)) return { ok: false, detail: 'The environment has an ID that the Session Monitor cannot record.' };
      const isConnected = environment.id === this.deps.connected();
      const target = await this.engineOf(environment, isConnected);
      if (target === undefined) return { ok: false, detail: 'The Docker engine of the environment cannot be reached from this window.' };
      // A-R2-1: the engine of the connected environment is trusted only when its container is there.
      if (isConnected && !this.isVerified(environment.id)) {
        if (!(await this.verify(target, environment))) {
          this.engines.delete(environment.id);
          return { ok: false, detail: `The container of the environment is not on ${engineName(target)}.` };
        }
        this.markVerified(environment.id, target);
      }
      const settings = this.deps.settings();
      const kept = keptWhenClosed(keepFlagsOf(environment), settings);
      const limitSeconds = stopAfterSeconds(settings.stopAfterMinutes);
      const input: HeartbeatInput = { source: this.deps.sourceId(), limitSeconds, environments: [{ id: environment.id, keepRunning: kept, seq }] };
      const key = engineKey(target);
      // A-R1-2: never two calls on one engine at once; a call that passed its deadline and still hangs is a failure.
      for (let running = this.inFlight.get(key); running !== undefined; running = this.inFlight.get(key)) {
        if (running.expired) return { ok: false, detail: HEARTBEAT_NO_ANSWER };
        await running.done.catch(() => undefined);
      }
      const series = this.seriesOf(target, seq);
      const result = await this.attempt(key, series, input, [environment], isConnected && this.isVerified(environment.id));
      if (!result.ok) return { ok: false, detail: result.detail };
      series.sent.set(environment.id, kept);
      this.envSentAt.set(environment.id, seq);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
  }

  /** No more heartbeats (the window closes). */
  dispose(): void {
    this.disposed = true;
  }

  /** The environments this window uses, by engine; a connected one without an engine counts as a failure (A-R1-3). */
  private async collect(now: number): Promise<Group[]> {
    const environments = await this.deps.registry.list();
    const connected = this.deps.connected();
    const used = environments.filter((environment) => environment.id === connected || this.ownBusyMark(environment, now));
    const isUsed = (id: string): boolean => used.some((environment) => environment.id === id);
    // An environment that this window no longer uses keeps no remembered engine.
    for (const id of [...this.engines.keys()]) if (!isUsed(id)) this.engines.delete(id);
    for (const id of [...this.unreachable]) if (!isUsed(id)) this.unreachable.delete(id);
    for (const id of [...this.envSentAt.keys()]) if (!isUsed(id)) this.envSentAt.delete(id);
    for (const id of [...this.unresolved.keys()]) if (id !== connected) this.unresolved.delete(id);
    const settings = this.deps.settings();
    const byEngine = new Map<string, Group>();
    for (const environment of used) {
      // An id that the monitor cannot record (not of newEnvironmentId) is left out.
      if (!isRemoteEnvironmentId(environment.id)) continue;
      const isConnected = environment.id === connected;
      const target = await this.engineOf(environment, isConnected);
      if (target === undefined) {
        if (isConnected) this.countUnresolved(environment, now, stopAfterSeconds(settings.stopAfterMinutes));
        continue;
      }
      // A-R2-1: the streak ends only on an engine where the container of the environment was found.
      if (isConnected && this.isVerified(environment.id)) this.unresolved.delete(environment.id);
      const key = engineKey(target);
      let group = byEngine.get(key);
      if (group === undefined) {
        group = { target, entries: new Map(), environments: [] };
        byEngine.set(key, group);
      }
      if (group.entries.size >= MAX_HEARTBEAT_ENVIRONMENTS) continue;
      group.entries.set(environment.id, keptWhenClosed(keepFlagsOf(environment), settings));
      group.environments.push(environment);
      if (isConnected) group.connected = environment;
    }
    return [...byEngine.values()];
  }

  /** The heartbeat of one engine at one tick, when it is due and no call of an earlier tick runs on that engine. */
  private async runEngine(group: Group, now: number, limitSeconds: number): Promise<void> {
    if (this.disposed) return;
    const key = engineKey(group.target);
    const series = this.seriesOf(group.target, now);
    const changed = series.limitSeconds !== limitSeconds || [...group.entries].some(([id, kept]) => series.sent.get(id) !== kept);
    const due = series.failures > 0 || series.sentAt === undefined || !(Math.abs(now - series.sentAt) < WINDOW_HEARTBEAT_INTERVAL_MS);
    if (!changed && !due) return;
    // A-R2-1: the connected environment counts on this engine only when its container is there; else the engine of the
    // environment counts as not found for this tick, and nothing is sent or repaired for it here.
    const connected = group.connected;
    if (connected !== undefined && !this.isVerified(connected.id)) {
      const present = await this.verify(group.target, connected);
      if (this.disposed) return;
      if (present) {
        this.markVerified(connected.id, group.target);
        this.unresolved.delete(connected.id);
      } else {
        this.engines.delete(connected.id);
        group.entries.delete(connected.id);
        group.environments = group.environments.filter((environment) => environment.id !== connected.id);
        group.connected = undefined;
        this.countUnresolved(connected, now, limitSeconds, `its container ${connected.containerName} is not on ${engineName(group.target)}`);
        if (group.entries.size === 0) return;
      }
    }
    const running = this.inFlight.get(key);
    let result: HeartbeatSendResult;
    if (running === undefined) {
      const input: HeartbeatInput = {
        source: this.deps.sourceId(),
        limitSeconds,
        environments: [...group.entries].map(([id, keepRunning]) => ({ id, keepRunning, seq: now })),
      };
      result = await this.attempt(key, series, input, group.environments, group.connected !== undefined);
    } else if (running.expired) {
      // A-R1-2: the call of an earlier tick passed its deadline and still hangs: no new call, one more failure.
      result = { ok: false, missing: false, detail: HEARTBEAT_NO_ANSWER };
    } else {
      // A-R1-2: the call of an earlier tick still runs within its deadline; it counts for itself.
      return;
    }
    if (result.ok) {
      if (series.failures > 0) this.deps.logger.info(`The Session Monitor on ${engineName(group.target)} answers again.`);
      series.failures = 0;
      series.warned = false;
      series.sent = new Map(group.entries);
      series.limitSeconds = limitSeconds;
      series.sentAt = now;
      for (const id of group.entries.keys()) this.envSentAt.set(id, now);
      return;
    }
    series.failures += 1;
    // A-R2-1: after a failed heartbeat, the engine of the connected environment is checked again.
    if (group.connected !== undefined) {
      const known = this.engines.get(group.connected.id);
      if (known !== undefined) known.verified = false;
    }
    if (series.failures === 1) {
      this.deps.logger.info(`A heartbeat to the Session Monitor on ${engineName(group.target)} failed; it is tried again. ${result.detail}`);
    }
    // Q4: once per failure streak, only for the environment this window is connected to.
    if (series.failures >= HEARTBEAT_WARN_AFTER_FAILURES && !series.warned && group.connected !== undefined) {
      series.warned = true;
      const base = series.sentAt ?? series.startedAt;
      const limitMs = (series.limitSeconds ?? limitSeconds) * 1000;
      const minutesLeft = Math.max(0, Math.floor((base + limitMs - now) / 60_000));
      this.deps.logger.warn(`${series.failures} heartbeats in a row to the Session Monitor on ${engineName(group.target)} failed: ${result.detail}`);
      this.deps.warn(Messages.heartbeatsFailing(group.connected.repository, engineName(group.target), minutesLeft));
    }
  }

  /**
   * A-R1-3: the engine of the connected environment cannot be found from this window's Docker context; this counts as a
   * failed heartbeat, and the Q4 warning fires as for any other failure (time left from its last successful heartbeat).
   */
  private countUnresolved(environment: Environment, now: number, limitSeconds: number, reason?: string): void {
    let streak = this.unresolved.get(environment.id);
    if (streak === undefined) {
      streak = { startedAt: now, failures: 0, warned: false };
      this.unresolved.set(environment.id, streak);
    }
    streak.failures += 1;
    if (streak.failures < HEARTBEAT_WARN_AFTER_FAILURES || streak.warned) return;
    streak.warned = true;
    const base = this.envSentAt.get(environment.id) ?? streak.startedAt;
    const minutesLeft = Math.max(0, Math.floor((base + limitSeconds * 1000 - now) / 60_000));
    const engine = describeDockerHost(dockerHostOf(environment));
    this.deps.logger.warn(
      `${streak.failures} heartbeats in a row for ${environment.repository} failed: ${reason ?? `the Docker engine of this window (${engine}) cannot be found`}.`,
    );
    this.deps.warn(Messages.heartbeatsFailing(environment.repository, engine, minutesLeft));
  }

  /**
   * A-R1-2: one attempt on the engine `key`, registered as its call in flight, within HEARTBEAT_ATTEMPT_DEADLINE_MS;
   * then `signal` aborts and the attempt counts as failed (HEARTBEAT_NO_ANSWER), also when the call does not end. The
   * call stays registered (expired) until it ends, so no second call piles up on that engine.
   */
  private async attempt(key: string, series: Series, input: HeartbeatInput, environments: Environment[], verified: boolean): Promise<HeartbeatSendResult> {
    const controller = new AbortController();
    const call = this.sendWithRepair(series, input, controller.signal, environments, verified);
    const entry: InFlight = { done: call, expired: false };
    this.inFlight.set(key, entry);
    void call
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<HeartbeatSendResult>((resolve) => {
      timer = setTimeout(() => {
        entry.expired = true;
        controller.abort(new Error(`The heartbeat got ${HEARTBEAT_NO_ANSWER}.`));
        resolve({ ok: false, missing: false, detail: HEARTBEAT_NO_ANSWER });
      }, HEARTBEAT_ATTEMPT_DEADLINE_MS);
    });
    try {
      return await Promise.race([call, deadline]);
    } catch (error) {
      return { ok: false, missing: false, detail: errorMessage(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One heartbeat; when the monitor container is missing, it is started again (repair) and the heartbeat is sent once
   * more (user decision Q4 of 2026-10-02, D1). A-R1-4: after a failed repair, the next one waits (REPAIR_BACKOFF_MS).
   */
  private async sendWithRepair(
    series: Series,
    input: HeartbeatInput,
    signal: AbortSignal,
    environments: Environment[],
    verified: boolean,
  ): Promise<HeartbeatSendResult> {
    const { target } = series;
    const first = await this.deps.send(target, input, signal);
    if (first.ok) this.resetRepair(series);
    if (first.ok || !first.missing) return first;
    const now = this.clock.now();
    if (series.repairNotBefore !== undefined && now < series.repairNotBefore) {
      const seconds = Math.ceil((series.repairNotBefore - now) / 1000);
      return { ok: false, missing: true, detail: `${first.detail} The Session Monitor is started again in ${seconds} seconds at the earliest (its last start failed).` };
    }
    // A-R2-1: never a monitor on an engine where no environment of the heartbeat has its container (the connected one was
    // checked this tick; the busy ones are checked now).
    if (!verified && !(await this.anyContainerOn(target, environments, signal))) {
      return {
        ok: false,
        missing: true,
        detail: `${first.detail} The Session Monitor is not started there: no environment of this window has its container on ${engineName(target)}.`,
      };
    }
    this.deps.logger.info(`The Session Monitor on ${engineName(target)} is missing; it is started again.`);
    try {
      await this.deps.repair(target, signal);
    } catch (error) {
      series.repairFailures += 1;
      const waitMs = repairBackoffMs(series.repairFailures);
      series.repairNotBefore = this.clock.now() + waitMs;
      this.deps.logger.info(`The Session Monitor on ${engineName(target)} is started again in ${waitMs / 1000} seconds at the earliest.`);
      return { ok: false, missing: true, detail: `${first.detail} The Session Monitor could not be started again: ${errorMessage(error)}` };
    }
    this.resetRepair(series);
    return this.deps.send(target, input, signal);
  }

  /** A-R2-1: whether one of `environments` has its container on `target` (false when that cannot be checked). */
  private async anyContainerOn(target: DockerTarget, environments: Environment[], signal: AbortSignal): Promise<boolean> {
    for (const environment of environments) {
      if (signal.aborted) return false;
      if (await this.deps.containerExists(target, environment, signal).catch(() => false)) return true;
    }
    return false;
  }

  private isVerified(environmentId: string): boolean {
    return this.engines.get(environmentId)?.verified === true;
  }

  /** A-R2-1: the remembered engine of the environment is `target`, and its container is there. */
  private markVerified(environmentId: string, target: DockerTarget): void {
    const known = this.engines.get(environmentId);
    if (known !== undefined && engineKey(known.target) === engineKey(target)) known.verified = true;
  }

  /**
   * A-R2-1: whether the container of `environment` is on `target`, within HEARTBEAT_ATTEMPT_DEADLINE_MS (then false, and
   * its signal aborts). A check that runs is joined.
   */
  private verify(target: DockerTarget, environment: Environment): Promise<boolean> {
    const id = `${environment.id} ${engineKey(target)}`;
    const running = this.verifying.get(id);
    if (running !== undefined) return running;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`The check of the container got ${HEARTBEAT_NO_ANSWER}.`));
        resolve(false);
      }, HEARTBEAT_ATTEMPT_DEADLINE_MS);
    });
    const check: Promise<boolean> = Promise.race([this.deps.containerExists(target, environment, controller.signal).catch(() => false), deadline]).finally(() => {
      clearTimeout(timer);
      if (this.verifying.get(id) === check) this.verifying.delete(id);
    });
    this.verifying.set(id, check);
    return check;
  }

  private resetRepair(series: Series): void {
    series.repairFailures = 0;
    series.repairNotBefore = undefined;
  }

  /** A live busy mark of this window and process (an operation of this window works on the environment). */
  private ownBusyMark(environment: Environment, now: number): boolean {
    const mark = environment.busy;
    const owner = this.deps.owner();
    if (mark === undefined || mark.windowId !== owner.windowId || mark.pid !== owner.pid) return false;
    const since = Date.parse(mark.since);
    // An ended mark (since = the epoch) or one beyond the life of a busy mark does not count.
    return Number.isFinite(since) && Math.abs(now - since) <= BUSY_MARK_MAX_AGE_MS;
  }

  private async engineOf(environment: Environment, connected: boolean): Promise<DockerTarget | undefined> {
    const known = this.engines.get(environment.id);
    if (known !== undefined && known.connected === connected) return known.target;
    const target = await this.deps.engineFor(environment, { connected });
    if (target === undefined || (target.kind !== 'local' && target.kind !== 'remote')) {
      if (!this.unreachable.has(environment.id)) {
        this.unreachable.add(environment.id);
        this.deps.logger.warn(`The Docker engine of ${environment.repository} cannot be reached from this window; no heartbeat is sent for it.`);
      }
      return undefined;
    }
    this.unreachable.delete(environment.id);
    this.engines.set(environment.id, { target, connected });
    return target;
  }

  private seriesOf(target: DockerTarget, now: number): Series {
    const key = engineKey(target);
    let series = this.series.get(key);
    if (series === undefined) {
      series = { target, sent: new Map(), startedAt: now, failures: 0, warned: false, repairFailures: 0 };
      this.series.set(key, series);
    }
    return series;
  }
}
