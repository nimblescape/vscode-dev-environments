// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The work of the Session Monitor process (concept 7.9, implementation notes 12): every TICK_MS it reads the coordination
// files, applies the rules of rules.ts, stops the containers that no window uses anymore, and ends itself when it has no
// work. All I/O goes through the dependencies, so that tests can drive single ticks with fakes.
//
// It never starts Docker: the only Docker calls are the container list, `docker exec` for the Git summary, and
// `docker stop` (concept 7.6: "The Session Monitor never starts Docker. When Docker does not run, no container runs.").
// It only acts on containers whose label devenv.environment-id names an environment of the registry.
import { isBusyMarkLive } from '../core/busy';
import type { ContainerInfo } from '../core/docker/containerAdapter';
import { errorMessage } from '../core/errors';
import { gitSummaryCommand, parseGitSummaryOutput } from '../core/git/gitSummary';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID, repositoryFolder, shortId } from '../core/names';
import { isoTime, sleep, systemClock, type Clock, type Logger, type RunResult } from '../core/ports';
import type { EnvironmentRegistry } from '../core/storage/registry';
import type { SessionFiles } from '../core/storage/sessionFiles';
import type { Environment, GitSummary, MonitorSettings, PendingConnection, WindowStatus } from '../core/types';
import { isProcessAlive } from './lock';
import {
  computeInUse,
  containerStatesNeeded,
  decide,
  DEFAULT_WAITING_TIME_SECONDS,
  initialMonitorState,
  sleepGraceAt,
  TICK_MS,
  waitingTimeMs,
  type MonitorDecision,
  type MonitorEnvironment,
  type MonitorState,
  type MonitorWindow,
} from './rules';

/** Time limit of the Git summary in a container before a stop. On a timeout, the last recorded values stay. */
export const GIT_SUMMARY_TIMEOUT_MS = 20_000;
/** A busy mark older than this does not protect its environment (the rule lives in src/core/busy.ts). */
export { BUSY_MARK_MAX_AGE_MS } from '../core/busy';
/** After a failed stop, the next attempt waits TICK_MS × 2^failures, at most this long. */
export const STOP_RETRY_MAX_MS = 5 * 60_000;
/** The monitor ends after this many ticks in a row that failed (for example an unreadable registry). */
export const MAX_FAILED_TICKS = 60;

/**
 * The name of an environment in the log: its repository, and the short ID of the environment when another environment of
 * `environments` has the same repository (one environment per repository and GitHub account, concept D-3).
 */
export function environmentLabel(
  environment: Pick<Environment, 'id' | 'repository'>,
  environments: readonly Pick<Environment, 'id' | 'repository'>[],
): string {
  const repository = environment.repository.toLowerCase();
  const shared = environments.some((other) => other.id !== environment.id && other.repository.toLowerCase() === repository);
  return shared ? `${environment.repository} (${shortId(environment.id)})` : environment.repository;
}

/**
 * The containers of one environment in the order of the stop (D-20): the dev container (the name of the environment, or
 * without the label devenv.compose-service) first, then the other services of a Docker Compose environment.
 */
export function devContainerFirst(containers: readonly ContainerInfo[], containerName: string): ContainerInfo[] {
  const rank = (container: ContainerInfo): number =>
    container.name === containerName ? 0 : container.labels[LABEL_COMPOSE_SERVICE] === undefined ? 1 : 2;
  return [...containers].sort((a, b) => rank(a) - rank(b));
}

/** Settings when monitor.json is missing or invalid: the defaults of concept section 8. */
export function defaultMonitorSettings(): MonitorSettings {
  return {
    waitingTimeSeconds: DEFAULT_WAITING_TIME_SECONDS,
    stopOnClose: true,
    respectShutdownActionNone: false,
    updatedAt: new Date(0).toISOString(),
  };
}

/** The Docker calls of the monitor. `ContainerAdapter` has this shape. Implementations must put time limits on each call. */
export interface MonitorDocker {
  /** All containers with the label devenv.environment-id. Throws when Docker does not answer. */
  listEnvironmentContainers(): Promise<ContainerInfo[]>;
  /** `docker exec` in a running container. Resolves also for a non-zero exit code. */
  exec(container: string, command: readonly string[], options: { user?: string; timeoutMs?: number }): Promise<RunResult>;
  /** `docker stop`. A missing container is not an error. */
  stopContainer(nameOrId: string): Promise<void>;
}

export interface MonitorLoopDeps {
  registry: Pick<EnvironmentRegistry, 'list' | 'updateEnvironment'>;
  sessionFiles: Pick<SessionFiles, 'readMonitorSettings' | 'readWindowStatuses' | 'readPendings' | 'removeWindowStatus'>;
  docker: MonitorDocker;
  logger: Logger;
  /**
   * Refreshes the single-instance lock (monitor.lock, `refreshMonitorLock`). False: another monitor took over, and this
   * one must end at once.
   */
  refreshLock: () => boolean;
  /** Wall clock. Default: the system clock. */
  clock?: Clock;
  /** Default: `isProcessAlive` (process.kill(pid, 0)). */
  isAlive?: (pid: number) => boolean;
  /** Pause between two ticks. Default: TICK_MS. */
  tickMs?: number;
  /** Waits between two ticks; rejects when the signal aborts. Default: `sleep` of ports.ts. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Why the monitor ends. */
export type MonitorEndReason = 'idle' | 'lockLost' | 'stopRequested' | 'failing';

export interface TickResult {
  /** Set when the monitor must end after this tick. */
  end?: MonitorEndReason;
  /** The decision of the rules. Missing when the tick ended before (lock lost). */
  decision?: MonitorDecision;
  /** Environments whose containers this tick stopped. */
  stopped: string[];
}

type StopOutcome = 'stopped' | 'skipped' | 'failed' | 'lockLost';

interface Snapshot {
  environments: Environment[];
  monitorEnvironments: MonitorEnvironment[];
  windows: MonitorWindow[];
  pendings: PendingConnection[];
}

interface StopRetry {
  failures: number;
  retryAt: number;
}

export class MonitorLoop {
  private readonly clock: Clock;
  private readonly isAlive: (pid: number) => boolean;
  private readonly tickMs: number;
  private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly abort = new AbortController();
  private monitorState: MonitorState = initialMonitorState();
  private readonly stopRetries = new Map<string, StopRetry>();
  private dockerFailing = false;
  private stopRequested = false;

  constructor(private readonly deps: MonitorLoopDeps) {
    this.clock = deps.clock ?? systemClock;
    this.isAlive = deps.isAlive ?? isProcessAlive;
    this.tickMs = deps.tickMs ?? TICK_MS;
    this.delay = deps.delay ?? sleep;
  }

  /** State of the rules after the last tick. */
  get state(): MonitorState {
    return this.monitorState;
  }

  /** Ends `run()` after the current step. For SIGTERM and SIGINT. */
  stop(): void {
    this.stopRequested = true;
    this.abort.abort();
  }

  /**
   * Runs ticks until the monitor has no work (`decision.exit`), loses its lock, or `stop()` is called. A failed tick is
   * logged and does not end the loop, unless MAX_FAILED_TICKS ticks in a row fail.
   */
  async run(): Promise<MonitorEndReason> {
    let failures = 0;
    for (;;) {
      if (this.stopRequested) return 'stopRequested';
      let result: TickResult | undefined;
      try {
        result = await this.tick();
        failures = 0;
      } catch (error) {
        failures++;
        // Once a minute is enough for an error that repeats every tick.
        if (failures === 1 || failures % 12 === 0) {
          this.deps.logger.error(`A check failed (${failures} in a row).`, error);
        }
        if (failures >= MAX_FAILED_TICKS) return 'failing';
      }
      if (result?.end) return result.end;
      if (this.stopRequested) return 'stopRequested';
      try {
        await this.delay(this.tickMs, this.abort.signal);
      } catch {
        // stop() aborted the pause.
      }
    }
  }

  /** One check of concept 7.9. Throws only when the coordination files cannot be read. */
  async tick(): Promise<TickResult> {
    if (!this.deps.refreshLock()) {
      this.deps.logger.info('Another Session Monitor took over.');
      return { end: 'lockLost', stopped: [] };
    }
    const now = this.clock.now();
    const settings = (await this.deps.sessionFiles.readMonitorSettings()) ?? defaultMonitorSettings();
    const snapshot = await this.readSnapshot(now);
    const input = {
      now,
      settings,
      environments: snapshot.monitorEnvironments,
      windows: snapshot.windows,
      pendings: snapshot.pendings,
      state: this.monitorState,
    };

    // Docker only when a container state is needed (Resource Saver of Docker Desktop, see containerStatesNeeded).
    const needed = containerStatesNeeded(input);
    const runningContainers = new Map<string, ContainerInfo[]>();
    let running: Set<string> | undefined = new Set();
    if (needed.length > 0) {
      const containers = await this.listContainers();
      if (containers === undefined) {
        running = undefined;
      } else {
        const known = new Set(snapshot.environments.map((environment) => environment.id));
        for (const container of containers) {
          const id = container.labels[LABEL_ENVIRONMENT_ID];
          // Only containers of environments in the registry (concept 7.9 "Further rules").
          if (!id || !known.has(id) || container.state !== 'running') continue;
          running.add(id);
          runningContainers.set(id, [...(runningContainers.get(id) ?? []), container]);
        }
      }
    }

    const previous = this.monitorState;
    const decision = decide({ ...input, running });
    this.monitorState = decision.state;
    this.logWaitingTimes(previous, decision, snapshot, settings);
    for (const id of [...this.stopRetries.keys()]) {
      if (!(id in decision.state.idleSince)) this.stopRetries.delete(id);
    }

    const stopped: string[] = [];
    for (const id of decision.stop) {
      if (this.stopRequested) break;
      const outcome = await this.stopEnvironment(id, runningContainers.get(id) ?? []);
      if (outcome === 'lockLost') {
        this.deps.logger.info('Another Session Monitor took over.');
        return { end: 'lockLost', decision, stopped };
      }
      if (outcome === 'stopped') stopped.push(id);
    }
    await this.removeWindowFiles(decision.removeWindowFiles, snapshot.windows);
    return { end: decision.exit ? 'idle' : undefined, decision, stopped };
  }

  private async readSnapshot(now: number): Promise<Snapshot> {
    const [environments, statuses, pendings] = await Promise.all([
      this.deps.registry.list(),
      this.deps.sessionFiles.readWindowStatuses(),
      this.deps.sessionFiles.readPendings(),
    ]);
    const grace = sleepGraceAt(this.monitorState, now);
    return {
      environments,
      monitorEnvironments: environments.map((environment) => ({
        id: environment.id,
        busy: this.isBusy(environment, now, statuses, grace),
        shutdownActionNone: environment.shutdownActionNone === true,
      })),
      windows: statuses.map((status) => ({ status, alive: this.isAlive(status.pid) })),
      pendings,
    };
  }

  /**
   * Rule 1: a busy mark counts only while its owner process exists, not longer than BUSY_MARK_MAX_AGE_MS, and while the
   * owner window has a recent status file of the same process: the rule of the windows (`isBusyMarkLive` with the
   * status files). So a mark that an ended window left behind does not count when another program got its process ID.
   * During the sleep grace (`grace`, see rules.ts), the age of the owner's status file does not matter, as for the
   * window status files of rule 1: the owner may not have written its file since the computer woke up.
   */
  private isBusy(environment: Environment, now: number, statuses: readonly WindowStatus[], grace: boolean): boolean {
    const busy = environment.busy;
    if (busy === undefined) return false;
    return isBusyMarkLive(busy, { now, isAlive: this.isAlive, windowStatuses: statuses, ignoreOwnerStatusAge: grace });
  }

  private async listContainers(): Promise<ContainerInfo[] | undefined> {
    try {
      const containers = await this.deps.docker.listEnvironmentContainers();
      if (this.dockerFailing) {
        this.dockerFailing = false;
        this.deps.logger.info('Docker answers again.');
      }
      return containers;
    } catch (error) {
      if (!this.dockerFailing) {
        this.dockerFailing = true;
        this.deps.logger.info(`Docker does not answer. Nothing is stopped while it does not answer. ${errorMessage(error)}`);
      }
      return undefined;
    }
  }

  /**
   * Stops the running containers of one environment: check again that it is not in use, record the Git summary
   * (docker exec in the dev container, then a registry update under the lock), check again, then `docker stop` of each
   * container. A Docker Compose environment has several (the other services carry the label devenv.compose-service,
   * D-20): the dev container goes first, and the lock is refreshed before each further one, because each stop can take
   * up to the time limit of a Docker call.
   */
  private async stopEnvironment(id: string, running: ContainerInfo[]): Promise<StopOutcome> {
    const { logger } = this.deps;
    if (running.length === 0) return 'skipped';
    const retry = this.stopRetries.get(id);
    if (retry && this.clock.now() < retry.retryAt) return 'skipped';
    if (!this.deps.refreshLock()) return 'lockLost';

    // Recording the Git summary and stopping take time, and the files were read at the start of the tick.
    const idle = await this.idleEnvironment(id);
    if (!idle) return 'skipped';
    const { environment, label } = idle;
    const containers = devContainerFirst(running, environment.containerName);
    // The Git summary comes from the dev container; the other services of a Docker Compose environment have no repository.
    const target = containers.find((container) => container.labels[LABEL_COMPOSE_SERVICE] === undefined);

    const summary = target ? await this.readGitSummary(environment, label, target) : undefined;
    if (this.stopRequested) return 'skipped';
    if (summary) {
      // Read before the registry update: its mutator runs under the registry lock and does no I/O.
      const statuses = await this.deps.sessionFiles.readWindowStatuses();
      try {
        let busy = false;
        // The Docker call ran before: the registry lock is held only for the short write (registry.ts).
        const updated = await this.deps.registry.updateEnvironment(id, (current) => {
          const now = this.clock.now();
          if (this.isBusy(current, now, statuses, sleepGraceAt(this.monitorState, now))) {
            busy = true;
            return;
          }
          current.gitSummary = summary;
        });
        if (!updated) {
          logger.info(`${label} was removed from the registry. Its container is not stopped.`);
          return 'skipped';
        }
        if (busy) {
          logger.info(`${label} is busy again. Its container is not stopped.`);
          return 'skipped';
        }
      } catch (error) {
        logger.warn(`The Git state of ${label} could not be recorded. ${errorMessage(error)}`);
      }
    }

    if (!this.deps.refreshLock()) return 'lockLost';
    if (this.stopRequested || !(await this.idleEnvironment(id))) return 'skipped';

    let failed = false;
    for (const [index, container] of containers.entries()) {
      if (index > 0 && !this.deps.refreshLock()) return 'lockLost';
      try {
        logger.info(`Stopping the container ${container.name} of ${label}: no window uses it.`);
        await this.deps.docker.stopContainer(container.id);
      } catch (error) {
        failed = true;
        logger.warn(`The container ${container.name} could not be stopped. ${errorMessage(error)}`);
      }
    }
    if (failed) {
      const failures = (retry?.failures ?? 0) + 1;
      const waitMs = Math.min(this.tickMs * 2 ** failures, STOP_RETRY_MAX_MS);
      this.stopRetries.set(id, { failures, retryAt: this.clock.now() + waitMs });
      return 'failed';
    }
    this.stopRetries.delete(id);
    return 'stopped';
  }

  /**
   * Reads the files again. The environment, with its name for the log (environmentLabel), if it is still in the registry
   * and not in use, else `undefined`.
   */
  private async idleEnvironment(id: string): Promise<{ environment: Environment; label: string } | undefined> {
    const now = this.clock.now();
    const snapshot = await this.readSnapshot(now);
    const environment = snapshot.environments.find((candidate) => candidate.id === id);
    if (!environment) return undefined;
    const label = environmentLabel(environment, snapshot.environments);
    const { inUse } = computeInUse({
      now,
      environments: snapshot.monitorEnvironments,
      windows: snapshot.windows,
      pendings: snapshot.pendings,
      state: this.monitorState,
    });
    if (inUse.has(id)) {
      this.deps.logger.info(`${label} is in use again. Its container is not stopped.`);
      return undefined;
    }
    return { environment, label };
  }

  /**
   * Git summary from the running container (concept 7.9 "Further rules"), as `remoteUser`. `undefined` when Git is
   * missing in the container or fails: the registry then keeps the previous values (concept 7.5).
   */
  private async readGitSummary(environment: Environment, label: string, container: ContainerInfo): Promise<GitSummary | undefined> {
    const { logger } = this.deps;
    try {
      const folder = environment.remoteWorkspaceFolder || repositoryFolder(environment.repository);
      const result = await this.deps.docker.exec(container.id, gitSummaryCommand(folder), {
        user: environment.remoteUser || undefined,
        timeoutMs: GIT_SUMMARY_TIMEOUT_MS,
      });
      if (result.exitCode === 0) return parseGitSummaryOutput(result.stdout, isoTime(this.clock));
      if (result.exitCode === 127) {
        logger.info(`Git is not available in ${container.name}. The last recorded Git state is kept.`);
      } else {
        const reason = result.timedOut ? 'did not end in time' : `failed with exit code ${result.exitCode}`;
        logger.warn(`The Git state of ${label} ${reason}. ${result.stderr.trim().slice(-500)}`);
      }
    } catch (error) {
      logger.warn(`The Git state of ${label} could not be read. ${errorMessage(error)}`);
    }
    return undefined;
  }

  /** Removes status files of ended windows, unless a file was written again since the tick read it. */
  private async removeWindowFiles(ids: string[], seen: MonitorWindow[]): Promise<void> {
    if (ids.length === 0) return;
    let current: WindowStatus[];
    try {
      current = await this.deps.sessionFiles.readWindowStatuses();
    } catch {
      return;
    }
    const currentById = new Map(current.map((status) => [status.windowId, status]));
    const seenById = new Map(seen.map((window) => [window.status.windowId, window]));
    for (const id of ids) {
      const now = currentById.get(id);
      const then = seenById.get(id);
      if (!now || !then) continue;
      if (now.updatedAt !== then.status.updatedAt || now.pid !== then.status.pid || now.state !== then.status.state) continue;
      try {
        await this.deps.sessionFiles.removeWindowStatus(id);
        const reason = then.alive ? 'was not updated for a long time' : 'belongs to an ended process';
        this.deps.logger.info(`Removed the status file of window ${id}: it ${reason}.`);
      } catch (error) {
        this.deps.logger.warn(`The status file of window ${id} could not be removed. ${errorMessage(error)}`);
      }
    }
  }

  /** Logs when a waiting time starts and when an environment is in use again, so that monitor.log explains each stop. */
  private logWaitingTimes(previous: MonitorState, decision: MonitorDecision, snapshot: Snapshot, settings: MonitorSettings): void {
    const names = new Map(
      snapshot.environments.map((environment) => [environment.id, environmentLabel(environment, snapshot.environments)]),
    );
    const before = previous.idleSince ?? {};
    const after = decision.state.idleSince;
    const seconds = Math.round(waitingTimeMs(settings) / 1000);
    for (const id of Object.keys(after)) {
      if (!(id in before)) {
        this.deps.logger.info(`${names.get(id) ?? id} runs, and no window uses it. It stops in ${seconds} seconds.`);
      }
    }
    for (const id of Object.keys(before)) {
      if (!(id in after) && decision.inUse.has(id)) {
        this.deps.logger.info(`${names.get(id) ?? id} is in use again. The waiting time ends.`);
      }
    }
  }
}
