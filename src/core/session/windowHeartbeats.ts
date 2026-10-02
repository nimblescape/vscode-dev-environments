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
// (keptWhenClosed). It goes to the engine the window opened the environment on (`engineFor`, remembered per environment),
// through this window's worker (`send`: a routed `docker exec` on the monitor container, without `-i`; only IDs and flags
// in its arguments, never a token). A heartbeat of an engine is sent at once when an environment or its flag is new to the
// series, or the limit changed; otherwise every WINDOW_HEARTBEAT_INTERVAL_MS. `seq` is the time before the registry was
// read (review round 2 of PR #39, L1).
//
// Q4: the full repair path of D1. The worker that `send` uses is made ready by it (the helper image, the open); a monitor
// container that is missing is started again (`repair`, the ensure of the open) and the heartbeat is sent once more.
// After HEARTBEAT_WARN_AFTER_FAILURES failures in a row on the engine of the connected environment, `warn` gets a
// message with the time left before the monitor may stop it, once per failure streak; a success ends the streak.
// No `vscode`; never throws (except from a `deps` call that throws, which a tick logs).
import { BUSY_MARK_MAX_AGE_MS } from '../busy';
import type { DockerTarget } from '../docker/dockerHost';
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
   * The Docker engine of an environment as this window opened it (its host and Docker context); undefined when it cannot
   * be reached from here (logged). Asked once per environment; the answer is kept while the window uses it.
   */
  engineFor: (environment: Environment) => Promise<DockerTarget | undefined>;
  /** One heartbeat on the engine `target`, through this window's worker (RemoteSessionMonitor.heartbeat). Never throws. */
  send: (target: DockerTarget, input: HeartbeatInput) => Promise<HeartbeatSendResult>;
  /** Starts the monitor container of `target` again (the ensure of the open). Rejects with the cause when it cannot. */
  repair: (target: DockerTarget) => Promise<void>;
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
}

function engineKey(target: DockerTarget): string {
  return JSON.stringify([target.kind, target.host, target.context ?? null, target.endpoint]);
}

function engineName(target: DockerTarget): string {
  return target.kind === 'local' ? 'the local Docker' : target.host;
}

export class WindowHeartbeats {
  private readonly clock: Clock;
  private readonly series = new Map<string, Series>();
  /** Env id → the engine the window opened it on (engineFor). */
  private readonly engines = new Map<string, DockerTarget>();
  /** Env ids whose engine could not be found (logged once). */
  private readonly unreachable = new Set<string>();
  private running = false;
  private disposed = false;

  constructor(private readonly deps: WindowHeartbeatsDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** The window's tick: sends the heartbeats that are due. Skipped while the previous one runs. Never throws. */
  async tick(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      await this.run();
    } catch (error) {
      this.deps.logger.warn(`The heartbeats to the Session Monitor could not be sent: ${errorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One heartbeat for `environmentId` now, with its current keep-running flag (Close and Keep Running, Keep Running When
   * Closed, Stop When Closed), to the engine this window opened it on, with the repair of `send` and `repair`. Never
   * throws.
   */
  async sendFor(environmentId: string): Promise<{ ok: true } | { ok: false; detail: string }> {
    try {
      // Review round 2 of PR #39 (L1): `seq` is the time before the flags are read.
      const seq = this.clock.now();
      const environment = (await this.deps.registry.list()).find((candidate) => candidate.id === environmentId);
      if (environment === undefined) return { ok: false, detail: 'The environment is not in the registry.' };
      if (!isRemoteEnvironmentId(environment.id)) return { ok: false, detail: 'The environment has an ID that the Session Monitor cannot record.' };
      const target = await this.engineOf(environment);
      if (target === undefined) return { ok: false, detail: 'The Docker engine of the environment cannot be reached from this window.' };
      const settings = this.deps.settings();
      const kept = keptWhenClosed(keepFlagsOf(environment), settings);
      const limitSeconds = stopAfterSeconds(settings.stopAfterMinutes);
      const input: HeartbeatInput = { source: this.deps.sourceId(), limitSeconds, environments: [{ id: environment.id, keepRunning: kept, seq }] };
      const result = await this.sendWithRepair(target, input);
      if (!result.ok) return { ok: false, detail: result.detail };
      const series = this.seriesOf(target, seq);
      series.sent.set(environment.id, kept);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
  }

  /** No more heartbeats (the window closes). */
  dispose(): void {
    this.disposed = true;
  }

  private async run(): Promise<void> {
    const now = this.clock.now();
    const environments = await this.deps.registry.list();
    const connected = this.deps.connected();
    const used = environments.filter((environment) => environment.id === connected || this.ownBusyMark(environment, now));
    // An environment that this window no longer uses keeps no remembered engine.
    for (const id of [...this.engines.keys()]) if (!used.some((environment) => environment.id === id)) this.engines.delete(id);
    for (const id of [...this.unreachable]) if (!used.some((environment) => environment.id === id)) this.unreachable.delete(id);
    const settings = this.deps.settings();
    const limitSeconds = stopAfterSeconds(settings.stopAfterMinutes);
    const byEngine = new Map<string, { target: DockerTarget; entries: Map<string, boolean>; connected?: Environment }>();
    for (const environment of used) {
      // An id that the monitor cannot record (not of newEnvironmentId) is left out.
      if (!isRemoteEnvironmentId(environment.id)) continue;
      const target = await this.engineOf(environment);
      if (target === undefined) continue;
      const key = engineKey(target);
      let group = byEngine.get(key);
      if (group === undefined) {
        group = { target, entries: new Map() };
        byEngine.set(key, group);
      }
      if (group.entries.size >= MAX_HEARTBEAT_ENVIRONMENTS) continue;
      group.entries.set(environment.id, keptWhenClosed(keepFlagsOf(environment), settings));
      if (environment.id === connected) group.connected = environment;
    }
    for (const group of byEngine.values()) {
      if (this.disposed) return;
      const series = this.seriesOf(group.target, now);
      const changed = series.limitSeconds !== limitSeconds || [...group.entries].some(([id, kept]) => series.sent.get(id) !== kept);
      const due = series.failures > 0 || series.sentAt === undefined || !(Math.abs(now - series.sentAt) < WINDOW_HEARTBEAT_INTERVAL_MS);
      if (!changed && !due) continue;
      const input: HeartbeatInput = {
        source: this.deps.sourceId(),
        limitSeconds,
        environments: [...group.entries].map(([id, keepRunning]) => ({ id, keepRunning, seq: now })),
      };
      const result = await this.sendWithRepair(group.target, input);
      if (result.ok) {
        if (series.failures > 0) this.deps.logger.info(`The Session Monitor on ${engineName(group.target)} answers again.`);
        series.failures = 0;
        series.warned = false;
        series.sent = new Map(group.entries);
        series.limitSeconds = limitSeconds;
        series.sentAt = now;
        continue;
      }
      series.failures += 1;
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
  }

  /**
   * One heartbeat; when the monitor container is missing, it is started again (repair) and the heartbeat is sent once
   * more (user decision Q4 of 2026-10-02, D1).
   */
  private async sendWithRepair(target: DockerTarget, input: HeartbeatInput): Promise<HeartbeatSendResult> {
    const first = await this.deps.send(target, input);
    if (first.ok || !first.missing) return first;
    this.deps.logger.info(`The Session Monitor on ${engineName(target)} is missing; it is started again.`);
    try {
      await this.deps.repair(target);
    } catch (error) {
      return { ok: false, missing: true, detail: `${first.detail} The Session Monitor could not be started again: ${errorMessage(error)}` };
    }
    return this.deps.send(target, input);
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

  private async engineOf(environment: Environment): Promise<DockerTarget | undefined> {
    const known = this.engines.get(environment.id);
    if (known !== undefined) return known;
    const target = await this.deps.engineFor(environment);
    if (target === undefined || (target.kind !== 'local' && target.kind !== 'remote')) {
      if (!this.unreachable.has(environment.id)) {
        this.unreachable.add(environment.id);
        this.deps.logger.warn(`The Docker engine of ${environment.repository} cannot be reached from this window; no heartbeat is sent for it.`);
      }
      return undefined;
    }
    this.unreachable.delete(environment.id);
    this.engines.set(environment.id, target);
    return target;
  }

  private seriesOf(target: DockerTarget, now: number): Series {
    const key = engineKey(target);
    let series = this.series.get(key);
    if (series === undefined) {
      series = { target, sent: new Map(), startedAt: now, failures: 0, warned: false };
      this.series.set(key, series);
    }
    return series;
  }
}
