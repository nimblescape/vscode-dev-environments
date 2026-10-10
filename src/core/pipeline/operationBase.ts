// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F1 (decision 1 of 2026-10-03: no bypass of the worker, by construction): what the window's operations
// (EnvironmentOperations: they send the flows to the worker) and the worker's pipeline (EnvironmentService) share: the
// texts, the time limits of the flows, the targets and options of an operation, and the rules of an operation in a window
// (one operation per repository at a time, the sign-in, the Docker host of the operation, the busy marks of the other
// windows, the cleanup of the session files). It imports nothing of the pipeline, so the extension's bundle holds none
// of it. No `vscode`.
import type { VscodeServerLink } from '../helperChannel/protocol';
import { type BusyMarkView, type EnvironmentBusyMarks } from './busyMarks';
import { dockerHostOf, isOnDockerHost, type DockerTarget } from '../docker/dockerHost';
import { dockerEndpointUnsupported } from '../docker/remoteDocker';
import { BatchHelperUnavailableError, UserFacingError, errorMessage, isUserFacingError } from '../errors';
import { type FlowRefusal } from '../helperChannel/protocol';
import { Messages, Steps, type ProgressStep } from '../messages';
import { isAvailableTo } from '../ownership';
import {
  abortError,
  isAbortError,
  isoTime,
  sleep as defaultSleep,
  type Clock,
  type GitHubAuth,
  type Logger,
  type PipelineUi,
  type ProgressReporter,
} from '../ports';
import { isProcessAlive } from '../session/sessionRules';
import { type EnvironmentRegistry } from '../storage/registry';
import type { SessionFiles } from '../storage/sessionFiles';
import type { BusyMark, BusyOperation, Environment, ExtensionSettings, GitHubAccount, WindowStatus } from '../types';
import {
  otherWindowMarkIsLive,
  readLiveness,
  type MarkLiveness,
  type OpenRecords,
} from './openRecords';
import { windowLifecycleMemory, type LifecycleMemory } from './lifecycleMemory';

// User-visible texts that messages.ts lacks (plain language, NFR-02); to be moved there.
export const PipelineTexts = {
  cancelled: 'The operation was cancelled.',
  startFailed: 'The environment could not be started.',
  environmentMissing: 'This environment does not exist anymore.',
  environmentBusy: (repository: string) =>
    `${repository} is being changed in another window. Try again when this is finished.`,
  preparingHelper: 'The workspace helper is being prepared. This happens once and can take a few minutes.',
  updatingHelper: 'The workspace helper is being updated. This can take a few minutes.',
  /**
   * Plan step 11H1 (decision of 2026-10-09): the detail of the open while it waits for the download of the VS Code server
   * of the window into the shared store (the very first open of a VS Code version on the engine, or a download that runs
   * in another window).
   */
  downloadingVscodeServer: 'Downloading the VS Code server.',
  lifecycleCommandFailed: (command: string | undefined) =>
    `The ${command ?? 'lifecycle command'} of the environment failed. The environment is opened anyway.`,
  /** Plan step 5, PR B, user decision D3: the lock of the environment stayed held elsewhere for ENVIRONMENT_LOCK_WAIT_SECONDS. */
  environmentLockBusy: (repository: string) =>
    `${repository} is busy with an operation from another window or computer; try again in a moment.`,
  /**
   * Plan step 5, PR B, user decision D1: the worker that holds the lock of the environment could not be made ready (the
   * helper image could not be built, the worker could not be opened or reaches another Docker engine, or the lock failed
   * in it). Nothing was changed.
   */
  environmentLockUnavailable: (repository: string, cause: string) =>
    `${repository} was not changed: the Dev Environments worker on the Docker host could not be prepared (${cause}). Check that Docker runs and that the workspace helper image can be built (see the Dev Environments output), then try again.`,
  /** Plan step 11B2 (review round 1, A-R1-5): the record of the environment holds a name or user that Stop cannot use. */
  stopRefused: (repository: string) =>
    `${repository} cannot be stopped from here: its record holds a value (the container name, the remote user, or the repository folder) that Dev Environments cannot pass on. Stop it with Docker.`,
} as const;

/** Plan step 5, PR B, user decision D3: how long an operation waits for the lock of an environment that is held elsewhere. */
export const ENVIRONMENT_LOCK_WAIT_SECONDS = 10;

/**
 * Plan step 11B2: the longest Stop in the worker (the wait for the lock, the Git state, the stop of each container). A
 * Stop with more than about eight services that all hit their own time limit ends here (review round 1, A-R1-6).
 */
export const STOP_FLOW_TIMEOUT_MS = 10 * 60_000;

/** Plan step 11C1: the longest read of an attached window in the worker (the branch read has 15 s of its own). */
export const WINDOW_STATE_FLOW_TIMEOUT_MS = 30_000;

/**
 * Plan step 11B3b: the longest listing of Select configuration in the worker: the wait for the lock (D3), the start of the
 * batch helper, and its step.
 */
export const LIST_CONFIGURATIONS_FLOW_TIMEOUT_MS = 5 * 60_000;

/**
 * Plan step 11C2a: the longest Delete in the worker: the wait for the operation of another window and for the lock, the
 * stop and removal of the containers, the images, the volumes with their retries. Delete is not cancellable.
 */
export const DELETE_FLOW_TIMEOUT_MS = 30 * 60_000;

/**
 * Plan step 11C2b: the longest check of Delete in the worker: the Git state (GIT_SUMMARY_TIMEOUT_MS) and the questions,
 * which wait for the user.
 */
export const DELETE_CHECK_FLOW_TIMEOUT_MS = 60 * 60_000;

/** Plan step 11C3: the longest rebuild of the registry in the worker (it lists and inspects the volumes and containers). */
export const RECONCILE_FLOW_TIMEOUT_MS = 2 * 60_000;

/**
 * Plan step 11E6: the longest open in the worker: the clone, the image check and pulls, the build of the image (a large
 * one may take an hour or more), `up` with the lifecycle commands, and the questions to the user, which wait for an answer.
 */
export const OPEN_FLOW_TIMEOUT_MS = 4 * 60 * 60_000;

/**
 * Plan step 11B1 (review round 1, A-R1-5): the whole token removal in the worker: the two tries of the flow
 * (TOKEN_REMOVE_TIMEOUT_MS of src/core/worker/tokenRemoveFlow.ts each; its test ties them to this limit) and the requests
 * around them. Cleanup after plan step 11 (PR #142, C3/D5): here with the limits of the other flows (before:
 * TOKEN_REMOVAL_TIMEOUT_MS of src/vscode/controller.ts).
 */
export const TOKEN_REMOVE_FLOW_TIMEOUT_MS = 60_000;

/**
 * Plan step 11D2: the longest ensure of the Session Monitor in the worker: its looks and waits (a name conflict, a
 * container that another window creates: 25.5 s at most), the create and the wait for its ready line (60 s), each call of
 * the engine bounded by 60 s. Cleanup after plan step 11 (PR #142, C3/D5): here with the limits of the other flows (before:
 * in src/vscode/workerMonitor.ts).
 */
export const MONITOR_ENSURE_FLOW_TIMEOUT_MS = 5 * 60_000;

/**
 * The longest heartbeat or monitor command in the worker: its `docker exec` (20 s) and the way there. Cleanup after plan
 * step 11 (PR #142, C3/D5): here with the limits of the other flows (before: in src/vscode/workerMonitor.ts).
 */
export const MONITOR_FLOW_TIMEOUT_MS = 30_000;

/**
 * The part of EnvironmentRegistry that the service uses. Plan step 11I (PR D): no change of an entry by a function and
 * no added entry: the worker's pipeline sends each of its writes to the extension as a specific request (busy marks,
 * open records, the Git state).
 */
export type EnvironmentStore = Pick<EnvironmentRegistry, 'get' | 'list' | 'read' | 'forgetKeptVolumes' | 'findForAccount' | 'restore' | 'remove'>;

/**
 * Plan step 11I (PR D): the part of EnvironmentRegistry that the window's operations use (EnvironmentOperations): also
 * the changes of an entry, and the busy marks and the registry writes of the open over it (registryBusyMarks,
 * registryOpenRecords).
 */
export type WindowEnvironmentStore = EnvironmentStore & Pick<EnvironmentRegistry, 'add' | 'updateEnvironment'>;

/** The part of SessionFiles that the service uses. */
export type EnvironmentSessionFiles = Pick<
  SessionFiles,
  'writePending' | 'removePending' | 'removeOperation' | 'removeDisconnectRequest' | 'removeReopenOf' | 'readPendings'
>;

/** Starts Docker when it does not run and waits until it is ready (concept 7.6 "Docker start"). */
export type DockerStarter = (options: { onStarting: () => void; signal?: AbortSignal }) => Promise<void>;

export interface RepositoryTarget {
  /** `owner/name`. */
  repository: string;
  defaultBranch?: string | null;
  /** From the discovery, in the order of precedence. Empty for an unknown repository: the pipeline then uses the first configuration in the volume. */
  configPaths: string[];
  /** isTrustedOwner() (concept section 9). */
  trusted: boolean;
}

export interface OperationOptions {
  progress: ProgressReporter;
  signal?: AbortSignal;
}

export interface OpenOptions extends OperationOptions {
  /** Manual rebuild: build the environment image also when no digest changed (concept 7.14). */
  forceRebuild?: boolean;
  /** "Select configuration…": change the configuration first. Implies a rebuild when an environment exists. */
  configPath?: string;
}

export interface OpenResult {
  /** Registry entry after the pipeline. */
  environment: Environment;
  containerName: string;
  /** From `devcontainer up`, fallback `/workspaces/<name>`. */
  remoteWorkspaceFolder: string;
  /** Plan step 11H1: what the link of the shared VS Code server did (an open with a server only; the worker's pipeline). */
  vscodeServer?: VscodeServerLink;
}

export const BUSY_POLL_MS = 500;
const DEFAULT_BUSY_WAIT_MS = 10_000;
/** Review round 1 of PR #107 (A-M1): the questions whether a process runs that the pipeline asks at the same time. */
const PROCESS_QUESTIONS_AT_ONCE = 4;

/** Reports each progress step once, and logs it. */
export class StepReporter {
  private current: ProgressStep | undefined;
  /** The detail shown with the current step (a new step removes it). */
  private shownDetail: string | undefined;

  constructor(
    private readonly progress: ProgressReporter,
    private readonly logger: Logger,
  ) {}

  step(step: ProgressStep): void {
    if (step === this.current) return;
    this.current = step;
    this.shownDetail = undefined;
    this.logger.info(`Step: ${Steps[step]}`);
    this.progress.step(step);
  }

  /** Shows `message` with the current step, once while it is shown. */
  detail(message: string): void {
    if (message === this.shownDetail) return;
    this.shownDetail = message;
    this.progress.detail(message);
  }

  /** Removes the detail of the current step (an empty detail is not shown). */
  clearDetail(): void {
    this.shownDetail = undefined;
    this.progress.detail('');
  }
}

export function cancelledError(): UserFacingError {
  return new UserFacingError('cancelled', PipelineTexts.cancelled);
}

export function environmentMissing(repository?: string): UserFacingError {
  return new UserFacingError('startFailed', repository ? Messages.noEnvironment(repository) : PipelineTexts.environmentMissing);
}

export function environmentBusy(repository: string, mark: BusyMark): UserFacingError {
  return new UserFacingError(
    'startFailed',
    PipelineTexts.environmentBusy(repository),
    `Busy mark: ${mark.operation} since ${mark.since}, process ${mark.pid}, window ${mark.windowId}.`,
  );
}

export function otherAccount(repository: string): UserFacingError {
  return new UserFacingError('otherAccount', Messages.otherAccount(repository));
}

export function repositoryKey(repository: string): string {
  return repository.toLowerCase();
}

/** Waits for `promise`; rejects with an AbortError when `signal` aborts first. */
export function waitUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Plan step 11B3b: the UserFacingError of a refusal that the worker's own pipeline answered (FlowRefusal). */
export function refusalError(refused: FlowRefusal): UserFacingError {
  return refused.batchHelperUnavailable === true ? new BatchHelperUnavailableError(refused.message, refused.detail) : new UserFacingError(refused.code, refused.message, refused.detail);
}

/** A token together with the account of its session. */
export interface GitHubSession {
  token: string;
  account: GitHubAccount;
}

/** The deps of an operation of a window, which EnvironmentOperations and EnvironmentService share. */
export interface OperationBaseDeps {
  registry: EnvironmentStore;
  sessionFiles: EnvironmentSessionFiles;
  auth: Pick<GitHubAuth, 'getToken' | 'getAccount'>;
  ui: Pick<PipelineUi, 'warn'>;
  logger: Logger;
  clock: Clock;
  /** For busy marks and pending connection files. */
  owner: { windowId: string; pid: number };
  settings: () => ExtensionSettings;
  /**
   * Unit 7: the Docker host of the operation ('' = the local Docker; DockerTargets.host). New environments record it;
   * only environments of this host are opened, restored, or changed. Default: the local Docker.
   */
  dockerHost?: () => Promise<string>;
  /**
   * Unit 7, review D2: the Docker target of the operation (DockerTargets.current), with its kind. When given, it decides
   * instead of `dockerHost`: an endpoint that is neither local nor SSH ('unsupported') is refused by every operation
   * (dockerEndpointUnsupported) and never read or recorded.
   */
  dockerTarget?: () => Promise<Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>>;
  /** Default: `isProcessAlive` of sessionRules.ts (`process.kill(pid, 0)` does not fail with ESRCH). */
  isProcessAlive?: (pid: number) => boolean;
  /**
   * Plan step 11E4d: whether the process `pid` of this computer runs, asked before a decision about the other windows
   * (processesAlive). Default: `isProcessAlive`; the worker's pipeline asks the extension (`local processAlive`).
   */
  processAlive?: (pid: number) => Promise<boolean>;
  /**
   * Plan step 11E4d (decision of 2026-09-29): the containers that the window remembers because their lifecycle mark could
   * not be recorded. Default: a memory of its own; the worker's pipeline uses the window's through requests.
   */
  lifecycleMemory?: LifecycleMemory;
  /**
   * All window status files (SessionFiles.readWindowStatuses). When given, a busy mark of another window counts only
   * while that window also has a recent status file of the same process (see `isBusyMarkLive`), so a process ID that
   * was reused after a restart does not block the environment.
   */
  windowStatuses?: () => Promise<readonly WindowStatus[]>;
  /** How long an operation waits for the busy mark of another live window. Default 10 s. */
  busyWaitMs?: number;
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Plan step 11I (PR D): the busy marks and the registry writes of the open of an operation. The window's operations write
 * them to the registry of this computer (registryBusyMarks, registryOpenRecords); the worker's pipeline sends them to the
 * extension (hostBusyMarks, hostOpenRecords).
 */
export interface OperationRecords {
  busyMarks: EnvironmentBusyMarks;
  openRecords: OpenRecords;
}

/** Plan step 11E4a: the owner, clock, and view of the windows with which the window of `deps` decides busy marks. */
export function markViewOf(deps: Pick<OperationBaseDeps, 'owner' | 'clock' | 'isProcessAlive' | 'windowStatuses' | 'logger'>): BusyMarkView {
  return { owner: deps.owner, clock: deps.clock, isAlive: deps.isProcessAlive ?? isProcessAlive, windowStatuses: deps.windowStatuses, logger: deps.logger };
}

/** Plan step 11F1: the rules of an operation of a window (see the module comment). */
export abstract class OperationBase {
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * Review round 4 of PR #68 (B-R4-2), plan step 11E4d: the window's memory of the containers that run without their
   * lifecycle commands while the registry could not record it (LifecycleMemory).
   */
  protected readonly lifecycleMemory: LifecycleMemory;
  /** Plan step 11E4d: whether a process of this computer runs (OperationBaseDeps.processAlive). */
  protected readonly processAlive: (pid: number) => Promise<boolean>;
  /** Review D2: the endpoints (neither local nor SSH) whose refusal the reads showed already: once each. */
  private readonly refusedEndpoints = new Set<string>();
  protected readonly isAlive: (pid: number) => boolean;
  protected readonly busyMarks: EnvironmentBusyMarks;
  /** Plan step 11E4a: the owner, clock, and view of the windows with which this window decides busy marks. */
  protected readonly markView: BusyMarkView;
  protected readonly openRecords: OpenRecords;
  protected readonly busyWaitMs: number;
  protected readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    protected readonly deps: OperationBaseDeps,
    private readonly startDockerFn: DockerStarter,
    /** Plan step 11I (PR D): the busy marks and the registry writes of the open, over the view of the marks of this window. */
    records: (view: BusyMarkView) => OperationRecords,
  ) {
    this.isAlive = deps.isProcessAlive ?? isProcessAlive;
    this.processAlive = deps.processAlive ?? (async (pid) => this.isAlive(pid));
    this.lifecycleMemory = deps.lifecycleMemory ?? windowLifecycleMemory();
    this.markView = markViewOf(deps);
    const given = records(this.markView);
    this.busyMarks = given.busyMarks;
    this.openRecords = given.openRecords;
    this.busyWaitMs = Math.max(0, deps.busyWaitMs ?? DEFAULT_BUSY_WAIT_MS);
    this.sleepFn = deps.sleep ?? defaultSleep;
  }

  protected get logger(): Logger {
    return this.deps.logger;
  }

  /**
   * The signed-in account (`interactive`: a sign-in may be asked for); refuses an environment of another account (concept
   * 7.5).
   */
  protected async requireOwnAccount(environment: Environment, interactive: boolean): Promise<void> {
    const account = await this.deps.auth.getAccount({ interactive });
    if (!account) throw new UserFacingError('signInRequired', Messages.signInRequired);
    this.availableEntry(environment, account);
  }

  /** The registry entry, when it belongs to `account` (concept 7.5). Throws otherAccount for an entry of another account. */
  protected availableEntry(environment: Environment, account: GitHubAccount): Environment {
    if (isAvailableTo(environment, account)) return environment;
    this.logger.info(`The environment ${environment.id} does not belong to the signed-in account. It is not used.`);
    throw otherAccount(environment.repository);
  }

  /**
   * The token and the account of the GitHub session; asks for a sign-in when needed. Both must come from one session: a
   * sign-in with another account between the two questions would give an environment of this account the token of the
   * other one.
   */
  protected async requireSession(): Promise<GitHubSession> {
    const token = await this.deps.auth.getToken({ interactive: true });
    if (!token) throw new UserFacingError('signInRequired', Messages.signInRequired);
    const account = await this.deps.auth.getAccount({ interactive: false });
    if (!account || (await this.deps.auth.getToken({ interactive: false })) !== token) {
      throw new UserFacingError('signInRequired', Messages.signInRequired, 'The GitHub session changed during the open.');
    }
    return { token, account };
  }

  /**
   * Unit 7, review D2: the one check of the Docker target of the service. The target of the operation (dockerTarget),
   * else the host of `dockerHost` (local or SSH).
   */
  protected async dockerTarget(): Promise<Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>> {
    if (this.deps.dockerTarget) return this.deps.dockerTarget();
    const host = (await this.deps.dockerHost?.()) ?? '';
    return { kind: host === '' ? 'local' : 'remote', host, endpoint: '' };
  }

  /**
   * Unit 7: the Docker host of the operation ('' = the local Docker). Review D2: an endpoint that is neither local nor
   * SSH is refused (UserFacingError dockerEndpointUnsupported), so no operation reaches it or records it.
   */
  protected async currentDockerHost(): Promise<string> {
    const target = await this.dockerTarget();
    if (target.kind === 'unsupported') {
      this.logger.warn(`The Docker endpoint ${target.endpoint || target.host} is neither local nor SSH. Nothing is done.`);
      throw dockerEndpointUnsupported(target.endpoint || target.host);
    }
    return target.host;
  }

  /**
   * Review D2: the Docker host for the reads of the view and the restore (states, branch, volumes): undefined on an
   * endpoint that is neither local nor SSH, and the reads do nothing then. The message is shown once per endpoint.
   */
  protected async readableDockerHost(): Promise<string | undefined> {
    const target = await this.dockerTarget();
    if (target.kind !== 'unsupported') return target.host;
    const endpoint = target.endpoint || target.host;
    if (!this.refusedEndpoints.has(endpoint)) {
      this.refusedEndpoints.add(endpoint);
      this.logger.warn(`The Docker endpoint ${endpoint} is neither local nor SSH. Its containers and volumes are not read.`);
      this.deps.ui.warn(Messages.dockerEndpointUnsupported(endpoint));
    }
    return undefined;
  }

  protected async isOnCurrentHost(environment: Environment): Promise<boolean> {
    const host = await this.readableDockerHost();
    return host !== undefined && isOnDockerHost(environment, host);
  }

  /**
   * Unit 7: an environment of another Docker host is never acted on (no clone, restore, recreation, deletion, stop, or
   * token write there): UserFacingError('otherDockerHost').
   */
  protected async requireCurrentHost(environment: Environment): Promise<void> {
    const host = await this.currentDockerHost();
    if (isOnDockerHost(environment, host)) return;
    const environmentHost = dockerHostOf(environment);
    this.logger.warn(`${environment.repository}: the environment is on the Docker host ${environmentHost || '(local)'}, and Docker is set to ${host || '(local)'}. Nothing is done.`);
    throw new UserFacingError('otherDockerHost', Messages.otherDockerHost(environment.repository, environmentHost, host));
  }

  protected async startDocker(steps: StepReporter, signal: AbortSignal | undefined): Promise<void> {
    this.throwIfCancelled(signal);
    await this.startDockerFn({ onStarting: () => steps.step('startingDocker'), signal });
  }

  /**
   * Plan step 11E4d: whether the processes `pids` of this computer run, asked once each (EnvironmentServiceDeps.processAlive;
   * in the worker, the extension answers). A process whose answer fails counts as running, and so does one not asked:
   * when in doubt, another window uses the environment, and nothing is stopped or taken over.
   */
  protected async processesAlive(pids: Iterable<number>): Promise<(pid: number) => boolean> {
    const alive = new Map<number, boolean>();
    const unique = [...new Set(pids)];
    // Review round 1 of PR #107 (A-M1): a few at a time, far below the open requests that an operation may have
    // (MAX_OPEN_ASKS), so that the other requests of the open (its pending file, its questions) still get through.
    for (let start = 0; start < unique.length; start += PROCESS_QUESTIONS_AT_ONCE) {
      await Promise.all(
        unique.slice(start, start + PROCESS_QUESTIONS_AT_ONCE).map(async (pid) => {
          try {
            alive.set(pid, await this.processAlive(pid));
          } catch (error) {
            this.logger.warn(`Whether the process ${pid} runs could not be read: ${errorMessage(error)}`);
            alive.set(pid, true);
          }
        }),
      );
    }
    return (pid) => alive.get(pid) ?? true;
  }

  /** Plan step 11E4a: what markBlocks decides with (the window status files, read once, and the time), as plain data. */
  protected markLiveness(): Promise<MarkLiveness> {
    return readLiveness(this.markView);
  }

  /**
   * The test "a live mark of another window" (concept 7.9 rule 1, `isBusyMarkLive`) for `mark`: a mark of an ended process,
   * a mark older than 6 hours, and (with window status files) a mark whose window has no recent status file of that
   * process are ignored. Reads the window status files once per call.
   */
  protected async markBlocks(mark: BusyMark): Promise<boolean> {
    const liveness = await this.markLiveness();
    // Plan step 11E4d: whether its process runs is asked first (in the worker, the extension answers); review round 1 of
    // PR #107 (A-L4): never for a mark of this window or its process, which never counts.
    const isAlive = await this.processesAlive(mark.pid === this.markView.owner.pid ? [] : [mark.pid]);
    return otherWindowMarkIsLive(mark, { owner: this.markView.owner, isAlive }, liveness);
  }

  /**
   * Waits while another live window holds a busy mark (for example the window that asked for a rebuild and is closing
   * its remote connection), at most `busyWaitMs`. Returns the current registry entry.
   * Assumption (V-3): after "Close Remote Connection", the extension host of the old window ends within this time, so
   * the reloaded window can take over the operation that the old window marked.
   */
  protected async waitForOtherOperation(environment: Environment, signal: AbortSignal | undefined): Promise<Environment> {
    const attempts = Math.ceil(this.busyWaitMs / BUSY_POLL_MS);
    let current = environment;
    for (let attempt = 0; ; attempt++) {
      const mark = current.busy;
      if (!mark || !(await this.markBlocks(mark))) return current;
      if (attempt >= attempts) throw environmentBusy(current.repository, mark);
      if (attempt === 0) {
        this.logger.info(`${current.repository} is busy (${mark.operation}) in another window (process ${mark.pid}). Waiting.`);
      }
      await this.sleepFn(BUSY_POLL_MS, signal);
      const next = await this.deps.registry.get(current.id);
      if (!next) throw environmentMissing(current.repository);
      current = next;
    }
  }

  protected async clearOwnMark(environmentId: string): Promise<void> {
    await this.quietly('clear the busy mark', () => this.busyMarks.clear(environmentId));
  }

  /** Removes the pending connection file, the pending operation, the disconnect request (R7), and a reopen record of the environment. */
  protected async removeEnvironmentFiles(environmentId: string): Promise<void> {
    const files = this.deps.sessionFiles;
    await this.quietly('remove the pending connection file', () => files.removePending(environmentId));
    await this.quietly('remove the pending operation', () => files.removeOperation(environmentId));
    // Monitor cleanup, user decision 2026-09-29 (R7): a disconnect request of the deleted environment.
    await this.quietly('remove the disconnect request', () => files.removeDisconnectRequest(environmentId));
    // Plan step 11C2a: one request from the worker (the reopen record is read where it is).
    await this.quietly('remove the reopen record', () => files.removeReopenOf(environmentId));
  }

  /** Runs operations on the same key one after the other. Waiting ends with `cancelled` when the signal aborts. */
  protected async exclusive<T>(key: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    this.queues.set(key, tail);
    try {
      try {
        await waitUnlessAborted(previous, signal);
      } catch {
        throw cancelledError();
      }
      return await fn();
    } finally {
      release();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }

  protected throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw cancelledError();
  }

  protected isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true || isAbortError(error) || (isUserFacingError(error) && error.code === 'cancelled');
  }

  /** A cancelled operation ends with UserFacingError('cancelled'); other errors pass unchanged. */
  protected toUserError(error: unknown, signal: AbortSignal | undefined): unknown {
    if (this.isCancellation(error, signal)) {
      return isUserFacingError(error) && error.code === 'cancelled' ? error : cancelledError();
    }
    return error;
  }

  /** Runs a cleanup step; a failure is logged and ignored. */
  protected async quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(`Could not ${what}: ${errorMessage(error)}`);
    }
  }

  protected busyMark(operation: BusyOperation): BusyMark {
    return { operation, since: isoTime(this.deps.clock), pid: this.deps.owner.pid, windowId: this.deps.owner.windowId };
  }
}
