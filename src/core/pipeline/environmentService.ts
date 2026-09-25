// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Environment service (concept 7.5, 7.6, 7.7, 7.12, 7.14): the open pipeline and the operations on environments.
// It works without VS Code and never connects a window; the VS Code layer connects the window with the result of
// `open`. Each step checks the current state first and does nothing when its result exists (principle 7.1.7), so the
// pipeline can run again at any time.
import { isBusyMarkLive } from '../busy';
import { ContainerAdapter, type ContainerInfo } from '../docker/containerAdapter';
import { ensureDockerRunning } from '../docker/dockerStart';
import { UserFacingError, errorMessage, isUserFacingError } from '../errors';
import { gitSummaryCommand, ownershipFixCommand, parseGitSummaryOutput } from '../git/gitSummary';
import { checkConfiguration } from '../helper/configChecks';
import { containerGitSupport, gitIdentity, homeGitConfigCommand, type GitHubViewer, type GitIdentity } from '../helper/containerGit';
import { DevcontainerCommandError, buildOverrideConfig } from '../helper/devcontainerCli';
import {
  foreignVolumeName,
  hostAccessReport,
  mountedVolumeNames,
  removedRunArgs,
  volumeLabelOwner,
  type HostAccessInput,
  type HostAccessReport,
} from '../helper/hostAccess';
import { findLocalEnvNames, helperEnvNames } from '../helper/localEnv';
import type { WorkspaceHelper } from '../helper/workspaceHelper';
import {
  collectReferences,
  compareWithBuildRecord,
  type CheckedOutcome,
  type CheckOutcome,
  type ConfigReferences,
  type ImageChecker,
} from '../imageCheck/imageCheck';
import { registryDisplayName } from '../imageCheck/reference';
import { Messages, Steps, type ProgressStep } from '../messages';
import {
  CONFIG_FOLDER,
  CONTAINER_CONFIG_UNKNOWN_LABEL,
  LABEL_ENVIRONMENT_ID,
  LABEL_HELPER_RUN,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  WORKSPACES_ROOT,
  configurationName,
  environmentImageName,
  environmentImageRepository,
  newEnvironmentId,
  repositoryFolder,
  resourceName,
  shortId,
  splitRepository,
} from '../names';
import { isAvailableTo, ownerOf, type EnvironmentClaims } from '../ownership';
import {
  abortError,
  isAbortError,
  isoTime,
  sleep as defaultSleep,
  type Clock,
  type GitHubAuth,
  type Logger,
  type PipelineUi,
  type ProcessRunner,
  type ProgressReporter,
} from '../ports';
import { isStorageId } from '../storage/paths';
import { isEnvironmentOf, type EnvironmentRegistry } from '../storage/registry';
import type { SessionFiles } from '../storage/sessionFiles';
import type {
  BuildRecord,
  BusyMark,
  BusyOperation,
  ContainerState,
  DevcontainerConfig,
  DevcontainerResult,
  Environment,
  ExtensionSettings,
  GitHubAccount,
  GitSummary,
  RefusedUpdate,
  WindowStatus,
} from '../types';
import {
  DEFAULT_CONFIG_PATH,
  baseImageKey,
  configHash,
  containerIsCurrent,
  digestReference,
  errorDetail,
  imageRemoteUser,
  imagesToPull,
  isGitHubTokenRejected,
  isNetworkFailure,
  isRefusedUpdate,
  isRepositoryName,
  isRootUser,
  lifecycleHookFailure,
  lifecycleHookName,
  needsBuild,
  nextBuildNumber,
  nonEmptyString,
  recordDigests,
  refusedUpdateOf,
  shouldCheckImages,
  stringList,
  type ImageCheckState,
} from './pipelineRules';
import type { PullCredentials, PullCredentialsProvider } from './pullCredentials';

// User-visible texts that messages.ts lacks (plain language, NFR-02); to be moved there.
export const PipelineTexts = {
  cancelled: 'The operation was cancelled.',
  startFailed: 'The environment could not be started.',
  environmentMissing: 'This environment does not exist anymore.',
  environmentBusy: (repository: string) =>
    `${repository} is being changed in another window. Try again when this is finished.`,
  preparingHelper: 'The workspace helper is being prepared. This happens once and can take a few minutes.',
  updatingHelper: 'The workspace helper is being updated. This can take a few minutes.',
  lifecycleCommandFailed: (command: string | undefined) =>
    `The ${command ?? 'lifecycle command'} of the environment failed. The environment is opened anyway.`,
} as const;

/** The part of ContainerAdapter that the service uses. A ContainerAdapter fits. */
export type EnvironmentDocker = Pick<
  ContainerAdapter,
  | 'isRunning'
  | 'runChecked'
  | 'findContainer'
  | 'listEnvironmentContainers'
  | 'removeContainer'
  | 'stopContainer'
  | 'exec'
  | 'volumeExists'
  | 'createVolume'
  | 'removeVolume'
  | 'listEnvironmentVolumes'
  | 'inspectVolumes'
  | 'imageExists'
  | 'imageId'
  | 'removeImage'
  | 'listImageTags'
> & {
  /**
   * `docker pull`. With `credentials`, the pull uses them instead of the credentials that Docker has stored, only for
   * this pull (ContainerAdapter.pullImage).
   */
  pullImage(
    reference: string,
    options?: { onOutput?: (text: string) => void; signal?: AbortSignal; credentials?: PullCredentials },
  ): Promise<void>;
};

/** The part of WorkspaceHelper that the service uses. */
export type EnvironmentHelper = Pick<
  WorkspaceHelper,
  | 'ensureImage'
  | 'clone'
  | 'readConfigFiles'
  | 'listConfigurations'
  | 'readConfiguration'
  | 'build'
  | 'up'
  | 'gitSummary'
  | 'switchBranch'
  | 'prepareGit'
>;

/** The part of EnvironmentRegistry that the service uses. */
export type EnvironmentStore = Pick<
  EnvironmentRegistry,
  'get' | 'list' | 'findForAccount' | 'findUnowned' | 'add' | 'update' | 'updateEnvironment' | 'remove'
>;

/** The part of SessionFiles that the service uses. */
export type EnvironmentSessionFiles = Pick<
  SessionFiles,
  'writePending' | 'removePending' | 'removeOperation' | 'readReopen' | 'removeReopen'
>;

/** Starts Docker when it does not run and waits until it is ready (concept 7.6 "Docker start"). */
export type DockerStarter = (options: { onStarting: () => void; signal?: AbortSignal }) => Promise<void>;

export interface EnvironmentServiceDeps {
  docker: EnvironmentDocker;
  /** For ensureDockerRunning. */
  runner: ProcessRunner;
  helper: EnvironmentHelper;
  registry: EnvironmentStore;
  sessionFiles: EnvironmentSessionFiles;
  imageChecker: Pick<ImageChecker, 'check'>;
  auth: Pick<GitHubAuth, 'getToken' | 'getAccount' | 'reportRejectedToken'>;
  /**
   * The GitHub account of a token (DiscoveryService.viewer), for the Git identity of a new environment (concept section 9).
   * Without it, or when GitHub does not answer in time, the identity comes from the account of the session.
   */
  viewer?: (token: string, signal?: AbortSignal) => Promise<GitHubViewer>;
  /** Time limit of `viewer`. Default 5 s. */
  viewerTimeoutMs?: number;
  /**
   * Claims of entries without owner (concept 7.5). An open of an entry of an older version, for example one restored from
   * its volume during a first open, claims it for the signed-in account first. Without it, or when the claim does not
   * succeed, `openEnvironment` refuses such an entry, and `open` leaves it hidden and creates an environment of the
   * account; only when GitHub could not be asked, `open` refuses it too (environmentFor). An open is a command of the user
   * (a restored window runs the pipeline only for an entry that the controller checked before), so its claim is
   * `interactive`.
   */
  claims?: Pick<EnvironmentClaims, 'claim'>;
  ui: PipelineUi;
  logger: Logger;
  clock: Clock;
  platform: NodeJS.Platform;
  /** Local values for `${localEnv:…}`, and the Program Files folder for the Docker start on Windows. */
  env: NodeJS.ProcessEnv;
  /** For busy marks and pending connection files. */
  owner: { windowId: string; pid: number };
  settings: () => ExtensionSettings;
  /**
   * Credentials for a pull that Docker cannot do with its own credentials: the GitHub session for a private image on
   * ghcr.io (githubPackagesPullCredentials). Default: none, Docker pulls with its own credentials.
   */
  pullCredentials?: PullCredentialsProvider;
  /** Default: `ensureDockerRunning` with `docker` (then it must be a ContainerAdapter) and `runner`. */
  startDocker?: DockerStarter;
  /** Default: `process.kill(pid, 0)` does not fail with ESRCH. */
  isProcessAlive?: (pid: number) => boolean;
  /**
   * All window status files (SessionFiles.readWindowStatuses). When given, a busy mark of another window counts only
   * while that window also has a recent status file of the same process (see `isBusyMarkLive`), so a process ID that
   * was reused after a restart does not block the environment.
   */
  windowStatuses?: () => Promise<readonly WindowStatus[]>;
  /** How long an operation waits for the busy mark of another live window. Default 10 s. */
  busyWaitMs?: number;
  /** Interval at which an open pipeline writes its pending connection file again. Default 15 s. */
  pendingRefreshMs?: number;
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** For tests. Default: newEnvironmentId of names.ts. */
  newEnvironmentId?: () => string;
}

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
  /** Only for the first creation ("Switch branch…" on a repository without environment). */
  branch?: string;
  /** Manual rebuild: build the environment image also when no digest changed (concept 7.14). */
  forceRebuild?: boolean;
  /** "Select configuration…": change the configuration first. Implies a rebuild when an environment exists. */
  configPath?: string;
  /**
   * The command asked the user already whether an entry of an older version of the repository is assigned (Switch
   * branch…, Select configuration…): the open does not ask about a declined entry again (concept 7.5).
   */
  olderEnvironmentAsked?: boolean;
}

export interface OpenResult {
  /** Registry entry after the pipeline. */
  environment: Environment;
  containerName: string;
  /** From `devcontainer up`, fallback `/workspaces/<name>`. */
  remoteWorkspaceFolder: string;
}

export interface EnvironmentRuntimeState {
  container: ContainerState;
  volume: boolean;
}

const BUSY_POLL_MS = 500;
const DEFAULT_BUSY_WAIT_MS = 10_000;
// A pending connection file counts for 2 minutes (concept 7.9 rule 1). A helper image build, `up` with long lifecycle
// commands, or an open prompt can take longer; a refresh well within the waiting time keeps the container in use.
const DEFAULT_PENDING_REFRESH_MS = 15_000;
const IMAGE_INSPECT_TIMEOUT_MS = 60_000;
const GIT_EXEC_TIMEOUT_MS = 30_000;
const BRANCH_EXEC_TIMEOUT_MS = 15_000;
const OWNERSHIP_TIMEOUT_MS = 10 * 60_000;
const DOCKER_START_TIMEOUT_MS = 60_000;
// A helper container that a cancel removes can hold the volume for a moment.
const VOLUME_REMOVE_ATTEMPTS = 3;
const VOLUME_REMOVE_DELAY_MS = 1_000;
// Random IDs whose short ID is in use are very rare; a few attempts are enough.
const ENVIRONMENT_ID_ATTEMPTS = 5;

/** devcontainer.json and its Dockerfile, read from the volume. */
type ConfigFiles = NonNullable<Awaited<ReturnType<EnvironmentHelper['readConfigFiles']>>>;

/** Configuration of one pipeline run, read from the volume (step 5). */
interface LoadedConfiguration {
  configPath: string;
  /**
   * The configuration of the environment does not exist on this branch; `configPath` is the first one in the volume.
   * The selection of the user (the registry entry) stays, except on a first open (FR-03, concept 7.5).
   */
  fallback: boolean;
  configHash: string;
  config: DevcontainerConfig;
  dockerfileText?: string;
  references: ConfigReferences;
  /**
   * The named volumes that the configuration and its merged configuration mount, other than the workspace volume, read
   * with the parser of the host access policy (mountedVolumeNames): the additional volumes of the registry entry.
   */
  mountedVolumes: string[];
}

/** State of one pipeline run. */
interface PipelineContext {
  env: Environment;
  /** Configuration to read. Kept apart from `env`, which is replaced by the registry entry after each change. */
  configPath: string;
  firstOpen: boolean;
  forced: boolean;
  steps: StepReporter;
  signal?: AbortSignal;
  /** Show Messages.configurationNotFound when the configuration is missing on this branch. */
  announceConfigFallback: boolean;
  /** The repository was cloned in this run: fix the ownership, and read the full Git summary. */
  cloned: boolean;
  /** The ownership fix before the first `up` of this run was tried. */
  ownershipPrepared: boolean;
  /** This run holds a busy mark. */
  busy: boolean;
  /** The workspace helper image could not be prepared (for example offline after an extension update). */
  helperUnavailable: boolean;
  /** The GitHub session of the owner account, for the token file of the container (concept section 9). */
  session: GitHubSession;
  /** The token and the Git configuration were written into the volume in this run. */
  gitPrepared: boolean;
  /**
   * The Git identity of the account (identityOf), asked for as soon as the session is known, so the question to GitHub
   * runs while Docker starts and the image check runs. Never rejects.
   */
  identity: Promise<GitIdentity>;
}

/** A token together with the account of its session. */
interface GitHubSession {
  token: string;
  account: GitHubAccount;
}

/** What steps 8 and 9 did with the container. */
interface ContainerOutcome {
  /** Result of `devcontainer up`, if it ran. */
  result?: DevcontainerResult;
  /** A new container was created (first creation, replacement, or creation from the environment image). */
  created: boolean;
  /** The container that existed before, when no `up` created a new one. */
  container?: ContainerInfo;
}

interface UpdatePlan {
  check: ImageCheckState;
  build: boolean;
  forced: boolean;
  updateAvailable: boolean;
}

/** Reports each progress step once, and logs it. */
class StepReporter {
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

function cancelledError(): UserFacingError {
  return new UserFacingError('cancelled', PipelineTexts.cancelled);
}

function environmentMissing(repository?: string): UserFacingError {
  return new UserFacingError('startFailed', repository ? Messages.noEnvironment(repository) : PipelineTexts.environmentMissing);
}

function environmentBusy(repository: string, mark: BusyMark): UserFacingError {
  return new UserFacingError(
    'startFailed',
    PipelineTexts.environmentBusy(repository),
    `Busy mark: ${mark.operation} since ${mark.since}, process ${mark.pid}, window ${mark.windowId}.`,
  );
}

/** Docker and the Dev Container CLI name a container by its full ID or by a prefix of it. */
function sameContainerId(a: string, b: string): boolean {
  return a !== '' && b !== '' && (a.startsWith(b) || b.startsWith(a));
}

function isFilesMissing(error: unknown): boolean {
  return isUserFacingError(error) && error.code === 'filesMissing';
}

/** Errors of reading the configuration: helper and CLI failures become "could not be prepared". */
function configurationError(error: unknown): unknown {
  if (isUserFacingError(error) || isAbortError(error)) return error;
  return new UserFacingError('buildFailed', Messages.buildFailed, errorDetail(error));
}

function repositoryKey(repository: string): string {
  return repository.toLowerCase();
}

function volumeLabels(environment: Environment): Record<string, string> {
  const labels: Record<string, string> = { [LABEL_ENVIRONMENT_ID]: environment.id, [LABEL_REPOSITORY]: environment.repository };
  // The owner comes back with the entry when the registry is lost (concept 7.5).
  if (environment.owner) labels[LABEL_OWNER_ID] = environment.owner.id;
  return labels;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHostAccess(error: unknown): boolean {
  return isUserFacingError(error) && error.code === 'hostAccess';
}

function otherAccount(repository: string): UserFacingError {
  return new UserFacingError('otherAccount', Messages.otherAccount(repository));
}

/**
 * An entry of an older version without owner that could not be claimed (GitHub did not confirm the access of the
 * account, for example without a connection). It belongs to no account yet, so the text of otherAccount would be wrong.
 */
function environmentUnassigned(repository: string): UserFacingError {
  return new UserFacingError(
    'environmentUnassigned',
    Messages.olderEnvironmentNotAssigned(repository),
    'The environment has no owner, and the claim for the signed-in account did not succeed.',
  );
}

/** True if the host access policy refuses something of `report`. */
function isRefused(report: HostAccessReport): boolean {
  return report.hostAccess.length > 0 || report.unsupported.length > 0;
}

/** Both lists of a report, for the log. */
function describeRefusal(report: HostAccessReport): string {
  return [
    report.hostAccess.length > 0 ? `access to the computer: ${report.hostAccess.join('; ')}` : undefined,
    report.unsupported.length > 0 ? `not supported: ${report.unsupported.join('; ')}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' / ');
}

/**
 * The message of a refusal (concept section 9 "Host access"): the settings that need access to the computer
 * (Messages.hostAccess), the settings that the policy does not know (Messages.unsupportedOptions), or both.
 */
function refusalMessage(report: HostAccessReport): string {
  const access = report.hostAccess.join(', ');
  const unsupported = report.unsupported.join(', ');
  if (access === '') return Messages.unsupportedOptions(unsupported);
  if (unsupported === '') return Messages.hostAccess(access);
  return Messages.hostAccessAndUnsupported(access, unsupported);
}

/** UserFacingError('hostAccess') with what the configuration or the image needs, and what the policy does not know. */
class HostAccessError extends UserFacingError {
  /** All refused settings, for the message of a refused update (Messages.updateRefused). */
  readonly items: readonly string[];

  constructor(readonly report: HostAccessReport) {
    super('hostAccess', refusalMessage(report), `Refused by the host access policy: ${describeRefusal(report)}`);
    this.items = [...report.hostAccess, ...report.unsupported];
  }
}

/** Time limit of the question for the profile name of the account (the Git identity has a fallback). */
const VIEWER_TIMEOUT_MS = 5_000;
/** After a failed question for the profile, the fallback identity is used this long before GitHub is asked again. */
const IDENTITY_RETRY_MS = 10 * 60_000;

/** `process.kill(pid, 0)`: EPERM (a process of another user) counts as alive. */
function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function defaultDockerStarter(deps: EnvironmentServiceDeps): DockerStarter {
  return async ({ onStarting, signal }) => {
    const docker = deps.docker;
    if (!(docker instanceof ContainerAdapter)) {
      throw new Error('EnvironmentServiceDeps.startDocker is required when docker is not a ContainerAdapter.');
    }
    await ensureDockerRunning(docker, deps.runner, deps.logger, { platform: deps.platform, env: deps.env, onStarting, signal });
  };
}

/** Waits for `promise`; rejects with an AbortError when `signal` aborts first. */
function waitUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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

/**
 * The open pipeline and the environment operations (concept 7.5, 7.6, 7.7, 7.12, 7.14).
 * Operations on the same repository run one after the other in this window; busy marks in the registry keep other
 * windows and the Session Monitor away while an environment changes.
 */
export class EnvironmentService {
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * Git identity per account ID (identityOf): the question to GitHub, shared by the opens of this window. After a failed
   * question, `retryAfter` is the time from which GitHub is asked again.
   */
  private readonly identities = new Map<string, { identity: Promise<GitIdentity>; retryAfter?: number }>();
  private readonly startDockerFn: DockerStarter;
  private readonly isAlive: (pid: number) => boolean;
  private readonly busyWaitMs: number;
  private readonly pendingRefreshMs: number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly output = (text: string): void => this.deps.logger.output(text);

  constructor(private readonly deps: EnvironmentServiceDeps) {
    this.startDockerFn = deps.startDocker ?? defaultDockerStarter(deps);
    this.isAlive = deps.isProcessAlive ?? processExists;
    this.busyWaitMs = Math.max(0, deps.busyWaitMs ?? DEFAULT_BUSY_WAIT_MS);
    this.pendingRefreshMs = Math.max(1, deps.pendingRefreshMs ?? DEFAULT_PENDING_REFRESH_MS);
    this.sleepFn = deps.sleep ?? defaultSleep;
  }

  private get logger(): Logger {
    return this.deps.logger;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Open pipeline

  /**
   * Open pipeline for a repository: the environment of the repository of the signed-in account (concept 7.5, D-3). The
   * first open of an account creates its environment; an environment of another account is neither used nor named.
   */
  async open(target: RepositoryTarget, options: OpenOptions): Promise<OpenResult> {
    splitRepository(target.repository);
    return this.exclusive(repositoryKey(target.repository), options.signal, async () => {
      try {
        // The account decides which environment is used, and the token of the same session goes into it.
        const session = await this.requireSession();
        const existing = await this.environmentFor(target.repository, session, options.signal, options.olderEnvironmentAsked !== true);
        if (existing) {
          if (options.branch !== undefined) {
            this.logger.info(`The branch ${options.branch} applies only to a first open; use Switch branch for an environment.`);
          }
          return await this.openExisting(existing, options, target.defaultBranch ?? undefined, session);
        }
        return await this.openFirst(target, options, session);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  /** Open pipeline for an existing environment (reconnect, reopen, restored window, switch, rebuild). */
  async openEnvironment(environmentId: string, options: OpenOptions): Promise<OpenResult> {
    const environment = await this.deps.registry.get(environmentId);
    if (!environment) throw environmentMissing();
    return this.exclusive(repositoryKey(environment.repository), options.signal, async () => {
      try {
        const current = await this.deps.registry.get(environmentId);
        if (!current) throw environmentMissing(environment.repository);
        return await this.openExisting(current, options, undefined);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  /**
   * Concept 7.5, D-3: the environment of `repository` of the account of `session`, or `undefined` when the account has
   * none. An entry of an older version of the repository (without owner) is claimed for the account first; an open is a
   * command of the user, so the claim may ask. When the claim is refused (no access, or no confirmation), the entry stays
   * hidden, and the account gets an environment of its own. When GitHub could not be asked, the entry may hold work of the
   * account: the open is refused as not assigned (environmentUnassigned), so that no second environment hides it.
   */
  private async environmentFor(
    repository: string,
    session: GitHubSession,
    signal: AbortSignal | undefined,
    askAgain: boolean,
  ): Promise<Environment | undefined> {
    const own = await this.deps.registry.findForAccount(repository, session.account.id);
    if (own) return own;
    const older = await this.deps.registry.findUnowned(repository);
    if (!older) return undefined;
    if (this.deps.claims) {
      let unanswered = false;
      await this.deps.claims.claim(session.account, session.token, {
        mode: 'interactive',
        environmentIds: [older.id],
        askAgain,
        signal,
        onUnanswered: () => {
          unanswered = true;
        },
      });
      const claimed = await this.deps.registry.findForAccount(repository, session.account.id);
      if (claimed) return claimed;
      if (unanswered) {
        this.logger.info(`The environment ${older.id} of an older version could not be given to the signed-in account. No second environment is created.`);
        throw environmentUnassigned(repository);
      }
    }
    if ((older.additionalVolumes ?? []).length > 0) {
      // A new environment of the repository would mount the named volumes of the entry (the policy refuses them after the
      // clone): nothing is created, and the next Start asks again.
      this.logger.info(`The environment ${older.id} of an older version uses named volumes of the repository. No second environment is created.`);
      throw new UserFacingError('environmentUnassigned', Messages.olderEnvironmentUsesVolumes(repository));
    }
    this.logger.info(`The environment ${older.id} of an older version stays hidden. The signed-in account gets an environment of its own.`);
    return undefined;
  }

  /**
   * Concept 7.6 "First open" of the repository for the account of `session`: security confirmation, registry entry,
   * workspace volume, clone, then the pipeline.
   */
  private async openFirst(target: RepositoryTarget, options: OpenOptions, session: GitHubSession): Promise<OpenResult> {
    const { signal } = options;
    const steps = new StepReporter(options.progress, this.logger);
    this.throwIfCancelled(signal);
    if (!target.trusted && !(await this.deps.ui.confirmUntrustedRepository(target.repository))) {
      this.logger.info(`The first open of ${target.repository} was not confirmed.`);
      throw cancelledError();
    }
    // Asked now, so the question to GitHub runs while Docker starts and the repository is cloned.
    const identity = this.identityOf(session);
    await this.startDocker(steps, signal);
    // Concept 7.5 "registry lost", D-3: a labeled volume of this repository and account that the registry lacks holds the
    // work of the user. It becomes the environment again; a second environment would hide it. Docker runs now, so the
    // volumes are read also when the registry was lost while Docker was stopped, or when registry.json is invalid.
    if ((await this.reconcileFromVolumes()) > 0) {
      // The question about an entry of an older version was asked a moment ago: a declined one is not asked about again.
      const restored = await this.environmentFor(target.repository, session, signal, false);
      if (restored) {
        this.logger.info(`An environment of ${target.repository} was restored from its volume ${restored.volumeName}. It is used.`);
        if (options.branch !== undefined) {
          this.logger.info(`The branch ${options.branch} applies only to a first open; use Switch branch for an environment.`);
        }
        return this.openExisting(restored, options, target.defaultBranch ?? undefined, session);
      }
    }

    const id = await this.unusedEnvironmentId(target.repository);
    const name = resourceName(target.repository, id);
    const now = isoTime(this.deps.clock);
    const environment: Environment = {
      id,
      repository: target.repository,
      configPath: options.configPath ?? target.configPaths[0] ?? DEFAULT_CONFIG_PATH,
      volumeName: name,
      containerName: name,
      createdAt: now,
      lastUsedAt: now,
      busy: this.busyMark('create'),
      // The environment belongs to the account that creates it (concept 7.5, section 9 "Accounts").
      owner: ownerOf(session.account),
    };
    try {
      await this.deps.registry.add(environment);
    } catch (error) {
      // One environment per repository and account (concept D-3): another window of the account may have created it
      // right now.
      const other = await this.deps.registry.findForAccount(target.repository, session.account.id);
      if (!other) throw error;
      this.logger.info(`An environment of ${target.repository} was created in the meantime. It is used.`);
      return this.openExisting(other, options, target.defaultBranch ?? undefined, session);
    }
    this.logger.info(`First open of ${target.repository}: environment ${id}, volume ${name}.`);

    const ctx: PipelineContext = {
      env: environment,
      configPath: environment.configPath,
      firstOpen: true,
      forced: false,
      steps,
      signal,
      announceConfigFallback: options.configPath !== undefined || target.configPaths.length > 0,
      cloned: true,
      ownershipPrepared: false,
      busy: true,
      helperUnavailable: false,
      session,
      gitPrepared: false,
      identity,
    };
    try {
      steps.step('downloadingRepository');
      await this.deps.docker.createVolume(name, volumeLabels(environment));
      await this.prepareHelper(ctx);
      await this.clone(ctx, session.token, options.branch ?? target.defaultBranch ?? undefined);
      return await this.runPipeline(ctx);
    } catch (error) {
      await this.removeFailedFirstOpen(ctx.env);
      throw error;
    } finally {
      await this.releaseBusy(ctx);
    }
  }

  /**
   * Steps 2 and 4 for an existing environment, then the pipeline. `known`: the session with which `open` found the
   * environment of the repository.
   */
  private async openExisting(
    environment: Environment,
    options: OpenOptions,
    defaultBranch: string | undefined,
    known?: GitHubSession,
  ): Promise<OpenResult> {
    const { signal } = options;
    const steps = new StepReporter(options.progress, this.logger);
    // Concept 7.5: only the owner account opens an environment; each open writes its token into the environment.
    const session = known ?? (await this.requireSession());
    const owned = await this.requireOwner(environment, session, signal);
    // Asked now, so the question to GitHub runs while Docker starts and the image check runs (NFR-08).
    const identity = this.identityOf(session);
    // The Session Monitor must not stop a running container while the pipeline runs (concept 7.9). The file is written
    // again while the pipeline runs, because it counts only for 2 minutes and not every step holds a busy mark.
    await this.deps.sessionFiles.writePending(owned.id, this.deps.owner.windowId);
    const stopRefresh = this.keepPendingFresh(owned.id);
    let ctx: PipelineContext | undefined;
    let succeeded = false;
    try {
      await this.startDocker(steps, signal);
      const env = await this.waitForOtherOperation(owned, signal);
      let forced = options.forceRebuild === true;
      let configPath = env.configPath;
      if (options.configPath !== undefined) {
        forced = true;
        if (options.configPath !== env.configPath) {
          this.logger.info(`Configuration of ${env.repository}: ${env.configPath} → ${options.configPath}.`);
          configPath = options.configPath;
        }
      }
      ctx = {
        env,
        configPath,
        firstOpen: false,
        forced,
        steps,
        signal,
        announceConfigFallback: options.configPath !== undefined || env.buildRecord !== undefined,
        cloned: false,
        ownershipPrepared: false,
        busy: false,
        helperUnavailable: false,
        session,
        gitPrepared: false,
        identity,
      };
      if (!(await this.deps.docker.volumeExists(env.volumeName))) {
        await this.recoverMissingFiles(ctx, defaultBranch, options.progress);
      } else if (env.busy?.operation === 'create') {
        await this.resumeInterruptedClone(ctx, defaultBranch);
      }
      const result = await this.runPipeline(ctx);
      succeeded = true;
      return result;
    } finally {
      await stopRefresh();
      if (ctx) await this.releaseBusy(ctx);
      if (!succeeded) {
        await this.quietly('remove the pending connection file', () => this.deps.sessionFiles.removePending(owned.id));
      }
    }
  }

  /**
   * Refuses an environment of another account (concept 7.5): UserFacingError('otherAccount'). Only an explicit
   * environment (openEnvironment: a reconnect, a reopen, a restored window) can be one; `open` of a repository uses the
   * environment of the account. An entry of an older version without owner is claimed for the account of `session` first
   * (for example at a retry or a reopen that no claim reached before); when the claim does not succeed, it is refused as
   * not assigned. Returns the registry entry; the login of the owner is updated when the account has another one now (a
   * rename on GitHub, or an owner restored from a volume label).
   */
  private async requireOwner(environment: Environment, session: GitHubSession, signal: AbortSignal | undefined): Promise<Environment> {
    const { account } = session;
    const current = await this.availableEntry(environment, account, { token: session.token, interactive: true, signal });
    if (current.owner?.login === account.login) return current;
    const updated = await this.deps.registry.updateEnvironment(current.id, (entry) => {
      if (entry.owner?.id === account.id) entry.owner = ownerOf(account);
    });
    return updated ?? current;
  }

  /**
   * The signed-in account (`interactive`: a sign-in may be asked for); refuses an environment of another account (concept
   * 7.5). The claim of an entry without owner needs a working token, which a command of the user may ask for.
   */
  private async requireOwnAccount(environment: Environment, interactive: boolean): Promise<void> {
    const account = await this.deps.auth.getAccount({ interactive });
    if (!account) throw new UserFacingError('signInRequired', Messages.signInRequired);
    if (isAvailableTo(environment, account)) return;
    // The token for a claim must be one of the session of `account` (see requireSession): after a change, no claim.
    // The claim asks GitHub: a command of the user gets a working token (a new sign-in while GitHub rejects the token).
    let token = environment.owner === undefined ? await this.deps.auth.getToken({ interactive }) : undefined;
    if (token !== undefined && (await this.deps.auth.getAccount({ interactive: false }))?.id !== account.id) token = undefined;
    await this.availableEntry(environment, account, { token, interactive });
  }

  /**
   * The registry entry, when it belongs to `account` (concept 7.5). An entry without owner is claimed first when a claim
   * is possible (`claims` and the token of the session of `account`); `interactive`: a command of the user, whose claim
   * may ask. Throws otherAccount for an entry of another account, and environmentUnassigned for an entry that still has
   * no owner.
   */
  private async availableEntry(
    environment: Environment,
    account: GitHubAccount,
    claim: { token: string | undefined; interactive: boolean; signal?: AbortSignal },
  ): Promise<Environment> {
    let current = environment;
    if (current.owner === undefined && this.deps.claims && claim.token) {
      await this.deps.claims.claim(account, claim.token, {
        mode: claim.interactive ? 'interactive' : 'auto',
        environmentIds: [current.id],
        signal: claim.signal,
      });
      current = (await this.deps.registry.get(current.id)) ?? current;
    }
    if (isAvailableTo(current, account)) return current;
    if (current.owner === undefined) {
      this.logger.info(`The environment ${current.id} of an older version could not be given to the signed-in account. It is not used.`);
      throw environmentUnassigned(current.repository);
    }
    this.logger.info(`The environment ${current.id} does not belong to the signed-in account. It is not used.`);
    throw otherAccount(current.repository);
  }

  /** Concept 7.12: the workspace volume is missing. Never creates an empty volume without asking (concept 7.5). */
  private async recoverMissingFiles(ctx: PipelineContext, defaultBranch: string | undefined, progress: ProgressReporter): Promise<void> {
    const env = ctx.env;
    this.logger.warn(`The workspace volume ${env.volumeName} of ${env.repository} is missing.`);
    const choice = await this.deps.ui.filesMissing(env.repository);
    this.throwIfCancelled(ctx.signal);
    if (choice === 'deleteEnvironment') {
      await this.deleteLocked(env, { progress, signal: ctx.signal, additionalVolumesToRemove: [] });
      throw cancelledError();
    }
    if (choice !== 'cloneAgain') throw cancelledError();

    await this.markBusy(ctx, 'create');
    ctx.steps.step('downloadingRepository');
    await this.deps.docker.createVolume(env.volumeName, volumeLabels(env));
    try {
      await this.prepareHelper(ctx);
      await this.clone(ctx, ctx.session.token, defaultBranch);
    } catch (error) {
      // The new volume is empty: remove it, so the files count as missing again.
      await this.quietly(`remove the volume ${env.volumeName}`, () => this.removeVolumeWithRetry(env.volumeName));
      throw error;
    }
    ctx.cloned = true;
    await this.updateEntry(ctx, (entry) => {
      delete entry.gitSummary;
    });
  }

  /**
   * A first open or "Clone again" whose window ended during the preparation left its `create` mark (the owner process
   * is gone). The clone is completed first; it does nothing when the
   * repository is complete (the clone script is idempotent). Without this, a clone that was cut off would look like a
   * repository without configuration.
   */
  private async resumeInterruptedClone(ctx: PipelineContext, defaultBranch: string | undefined): Promise<void> {
    this.logger.info(`The preparation of ${ctx.env.repository} was interrupted. The clone is completed first.`);
    const interrupted = ctx.env.busy;
    await this.markBusy(ctx, 'create');
    ctx.steps.step('downloadingRepository');
    try {
      await this.prepareHelper(ctx);
      await this.clone(ctx, ctx.session.token, defaultBranch);
    } catch (error) {
      // The mark of the ended window comes back, so the next open completes the clone again. A mark of this window
      // would count as live: the environment would show as busy without Start and Delete, and other windows could
      // not use it, as long as this window lives.
      ctx.busy = false;
      await this.quietly('restore the busy mark', () =>
        this.deps.registry.updateEnvironment(ctx.env.id, (entry) => {
          if (!entry.busy || !this.isOwnMark(entry.busy)) return;
          if (interrupted && !this.isOwnMark(interrupted)) entry.busy = interrupted;
          else delete entry.busy;
        }),
      );
      throw error;
    }
    ctx.cloned = true;
  }

  /** Steps 5 to 11 of the pipeline. */
  private async runPipeline(ctx: PipelineContext): Promise<OpenResult> {
    const { docker } = this.deps;
    this.throwIfCancelled(ctx.signal);
    const container = await docker.findContainer(ctx.env.id);
    const record = ctx.env.buildRecord;
    const imagePresent = record !== undefined && (await docker.imageExists(record.environmentImage));
    this.logger.info(
      `State of ${ctx.env.repository}: container ${container ? container.state : 'missing'}, environment image ` +
        (record ? `${record.environmentImage} ${imagePresent ? 'present' : 'missing'}` : 'not built yet') +
        '.',
    );

    // Step 5. With a broken configuration, the existing environment still starts, so the user can fix it inside. A
    // configuration that the host access policy refuses starts nothing (the volume stays, NFR-07).
    let loaded: LoadedConfiguration | undefined;
    try {
      loaded = await this.loadConfiguration(ctx, imagePresent);
    } catch (error) {
      const usable = container !== undefined || imagePresent;
      if (!usable || this.isCancellation(error, ctx.signal) || isFilesMissing(error) || isHostAccess(error)) {
        throw configurationError(error);
      }
      this.logger.error(`The configuration of ${ctx.env.repository} could not be used. The existing environment is started.`, error);
      this.deps.ui.warn(isUserFacingError(error) ? error.message : Messages.buildFailed);
    }

    let outcome: ContainerOutcome | undefined;
    if (loaded) {
      await this.saveConfiguration(ctx, loaded, record);
      // A container of an older setup is created again (concept section 9); it does not count as a working container.
      const currentContainer = container !== undefined && containerIsCurrent(container.labels);
      const plan = await this.planUpdate(ctx, loaded, record, imagePresent, currentContainer);
      if (plan.build) outcome = await this.buildAndReplace(ctx, loaded, plan, record, imagePresent, container);
    }
    outcome ??= await this.startContainer(ctx, container, record, imagePresent, loaded);
    return this.finish(ctx, outcome, loaded);
  }

  /** Step 5: reads the configuration from the volume. */
  private async loadConfiguration(ctx: PipelineContext, imagePresent: boolean): Promise<LoadedConfiguration> {
    const { helper } = this.deps;
    const env = ctx.env;
    // Reading the configuration is the first part of the image check (concept 6.5 step 3). Without a likely check, no
    // step is reported here: the next step comes from the check, the build, or the start, so the steps keep their order.
    const updateImagesOnConnect = this.deps.settings().updateImagesOnConnect;
    const hasRecord = env.buildRecord !== undefined;
    if (shouldCheckImages({ hasRecord, imagePresent, forced: ctx.forced, skipUpdate: false, updateImagesOnConnect })) {
      ctx.steps.step('checkingImage');
    }
    await this.prepareHelper(ctx);

    const resolved = await this.resolveConfigFiles(env, ctx.configPath, ctx.signal);
    if (!resolved) throw new UserFacingError('noConfiguration', Messages.noConfiguration(env.repository));
    const { configPath, files, fallback } = resolved;
    if (fallback) {
      this.logger.info(`The configuration ${ctx.configPath} does not exist on this branch. ${configPath} is used.`);
      if (ctx.announceConfigFallback) this.deps.ui.info(Messages.configurationNotFound(ctx.configPath, configurationName(configPath)));
    }

    const problems = checkConfiguration(files.configText);
    if (problems.compose) throw new UserFacingError('composeNotSupported', Messages.composeNotSupported);

    await this.requireVolume(env);
    const { config, merged } = await helper.readConfiguration({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath,
      environmentId: env.id,
      onOutput: this.output,
      signal: ctx.signal,
    });
    // Concept section 9 "Host access": checked before any build or container start.
    const checked = await this.hostAccessInput(env, { config, merged });
    const report = hostAccessReport(checked);
    if (isRefused(report)) {
      this.logger.warn(`The configuration ${configPath} of ${env.repository} is refused by the host access policy: ${describeRefusal(report)}`);
      throw new HostAccessError(report);
    }
    if (merged === undefined) {
      this.logger.info('The merged configuration is not known: the image metadata is checked before the container starts.');
    }
    if (problems.computerDependent.length > 0) {
      const items = problems.computerDependent.join(', ');
      this.logger.warn(`The configuration ${configPath} depends on the computer: ${items}`);
      this.deps.ui.warn(Messages.computerDependent(items));
    }
    // The values of the computer are not passed to the workspace helper: the CLI resolves the variables there, so a
    // variable that the helper sets (for example HOME) gets its value, any other one is empty or has its default.
    const localEnvNames = findLocalEnvNames(files.configText);
    if (localEnvNames.length > 0) {
      const fromHelper = helperEnvNames(localEnvNames);
      this.logger.info(`Variables of the computer that the configuration uses and that are not passed: ${localEnvNames.join(', ')}`);
      this.deps.ui.warn(Messages.localEnvNotPassed(localEnvNames.join(', '), fromHelper.length > 0 ? fromHelper.join(', ') : undefined));
    }
    return {
      configPath,
      fallback,
      configHash: configHash(files.configText, files.dockerfileText),
      config,
      dockerfileText: files.dockerfileText,
      references: collectReferences(config, files.dockerfileText),
      mountedVolumes: mountedVolumeNames(checked),
    };
  }

  /**
   * The files of the configuration `configPath`; when it does not exist on the current branch, the files of the first
   * configuration in the volume (`fallback`). `undefined` when the volume has no configuration.
   */
  private async resolveConfigFiles(
    env: Environment,
    configPath: string,
    signal: AbortSignal | undefined,
  ): Promise<{ configPath: string; files: ConfigFiles; fallback: boolean } | undefined> {
    const { helper } = this.deps;
    await this.requireVolume(env);
    const files = await helper.readConfigFiles({ volumeName: env.volumeName, repository: env.repository, configPath, signal });
    if (files) return { configPath, files, fallback: false };
    await this.requireVolume(env);
    const available = await helper.listConfigurations({ volumeName: env.volumeName, repository: env.repository, signal });
    if (available.length === 0) return undefined;
    const fallback = available[0];
    await this.requireVolume(env);
    const fallbackFiles = await helper.readConfigFiles({ volumeName: env.volumeName, repository: env.repository, configPath: fallback, signal });
    return fallbackFiles ? { configPath: fallback, files: fallbackFiles, fallback: true } : undefined;
  }

  /**
   * Stores what the registry needs from the configuration: path, shutdownAction, additional volumes.
   * The path is the selection of the user (FR-03, concept 7.5): a fallback on a branch without the selected configuration
   * does not replace it, so the selection applies again on a branch that has it. The build record keeps what was built.
   * Without a build record (first open, entry restored from a volume), nothing was selected and built yet: the fallback
   * is stored.
   */
  private async saveConfiguration(ctx: PipelineContext, loaded: LoadedConfiguration, record: BuildRecord | undefined): Promise<void> {
    const additionalVolumes = loaded.mountedVolumes.filter((name) => name !== ctx.env.volumeName);
    const configPath = loaded.fallback && record !== undefined ? ctx.configPath : loaded.configPath;
    await this.updateEntry(ctx, (entry) => {
      entry.configPath = configPath;
      entry.shutdownActionNone = loaded.config.shutdownAction === 'none';
      // Volumes recorded before stay: the image metadata adds its own (recordMetadataVolumes), and a volume that the
      // environment used may still hold its data.
      const recorded = entry.additionalVolumes ?? [];
      entry.additionalVolumes = [...recorded, ...additionalVolumes.filter((name) => !recorded.includes(name))];
      // A refused update of another configuration is not tried again anyway.
      const refused = refusedUpdateOf(entry);
      if ('refusedUpdate' in entry && (refused?.configPath !== loaded.configPath || refused.configHash !== loaded.configHash)) {
        delete entry.refusedUpdate;
      }
    });
  }

  /** Steps 6 and 7: configuration change, image check, and the decision to build. */
  private async planUpdate(
    ctx: PipelineContext,
    loaded: LoadedConfiguration,
    record: BuildRecord | undefined,
    imagePresent: boolean,
    containerExists: boolean,
  ): Promise<UpdatePlan> {
    let forced = ctx.forced;
    let skipUpdate = false;
    const changed = record !== undefined && (record.configHash !== loaded.configHash || record.configPath !== loaded.configPath);
    if (changed && !forced) {
      this.logger.info(`The configuration of ${ctx.env.repository} changed since the last build.`);
      const answer = await this.deps.ui.configurationChanged(ctx.env.repository);
      this.throwIfCancelled(ctx.signal);
      if (answer === 'rebuildNow') forced = true;
      else skipUpdate = true;
      this.logger.info(answer === 'rebuildNow' ? 'Rebuild now.' : 'Rebuild later: no update this time.');
    }

    const input = { hasRecord: record !== undefined, imagePresent, forced, skipUpdate };
    let check: ImageCheckState = { kind: 'skipped' };
    if (shouldCheckImages({ ...input, updateImagesOnConnect: this.deps.settings().updateImagesOnConnect })) {
      check = await this.checkImages(ctx, loaded, record, imagePresent || containerExists);
    }
    // Concept 7.7: an update whose new image the host access policy refused is not built again for the same digests and
    // configuration; the existing environment starts. A changed digest or configuration, or a rebuild, tries again.
    const refused = refusedUpdateOf(ctx.env);
    const refusedAgain =
      !forced &&
      record !== undefined &&
      imagePresent &&
      check.kind === 'checked' &&
      !check.upToDate &&
      isRefusedUpdate(refused, this.updateKey(loaded, record, check.outcome));
    if (refusedAgain && refused && check.kind === 'checked') {
      this.logger.info(`The update of ${ctx.env.repository} was refused by the host access policy (${refused.items}). The existing environment is used.`);
      this.deps.ui.warn(Messages.updateRefused(refused.items));
      check = { ...check, upToDate: true, changedImages: [], changedFeatures: [] };
    }
    const build = needsBuild({ ...input, check, containerExists });
    const updateAvailable = check.kind === 'checked' && !check.upToDate && !skipUpdate;
    const reason = forced
      ? 'rebuild requested'
      : check.kind === 'unreachable' && !build
        ? 'no connection to the registry, the existing container is started'
        : !record
        ? 'no environment image yet'
        : !imagePresent
          ? 'the environment image is missing'
          : updateAvailable
            ? 'a newer image is available'
            : refusedAgain
              ? 'the newer image needs access to the computer'
              : 'up to date';
    this.logger.info(`Decision for ${ctx.env.repository}: ${build ? 'build a new environment image' : 'no build'} (${reason}).`);
    return { check, build, forced, updateAvailable };
  }

  /**
   * Step 7: digests of the registries, compared with the build record (concept 7.7). `localEnvironment`: an environment
   * image or a container exists, which starts without a registry.
   */
  private async checkImages(
    ctx: PipelineContext,
    loaded: LoadedConfiguration,
    record: BuildRecord | undefined,
    localEnvironment: boolean,
  ): Promise<ImageCheckState> {
    ctx.steps.step('checkingImage');
    let outcome: CheckOutcome;
    try {
      outcome = await this.deps.imageChecker.check(loaded.references, { signal: ctx.signal });
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.error('The image check failed. The update step is skipped.', error);
      return { kind: 'unreachable' };
    }
    if (outcome.status === 'unreachable') {
      const registries = outcome.registries.map(registryDisplayName).join(', ');
      this.logger.info(`No connection to ${registries}. The update step is skipped.`);
      if (localEnvironment) this.deps.ui.info(Messages.registryUnreachable);
      return { kind: 'unreachable' };
    }
    for (const registry of outcome.authRequired) this.deps.ui.registrySignIn(registryDisplayName(registry));
    const comparison = compareWithBuildRecord(record, outcome);
    if (!comparison.upToDate) {
      const changed = [...comparison.changedImages, ...comparison.changedFeatures];
      this.logger.info(`Changed since the last build: ${changed.length > 0 ? changed.join(', ') : '(no build record)'}`);
    }
    return { kind: 'checked', outcome, ...comparison };
  }

  /** What identifies an update (RefusedUpdate): the configuration and the digests that the new build record would get. */
  private updateKey(loaded: LoadedConfiguration, record: BuildRecord | undefined, outcome: CheckedOutcome): Omit<RefusedUpdate, 'items'> {
    return {
      configPath: loaded.configPath,
      configHash: loaded.configHash,
      images: recordDigests(loaded.references.images, outcome.images, record?.images),
      features: recordDigests(loaded.references.features, outcome.features, record?.features),
    };
  }

  /**
   * Step 8, the update order of concept 7.7: pull, build, replace the container, write the build record, remove the
   * old images. A working container is never removed before the new environment image is ready (NFR-07).
   * Returns `undefined` when the pull or the build failed and the old container or image is used instead.
   */
  private async buildAndReplace(
    ctx: PipelineContext,
    loaded: LoadedConfiguration,
    plan: UpdatePlan,
    record: BuildRecord | undefined,
    imagePresent: boolean,
    container: ContainerInfo | undefined,
  ): Promise<ContainerOutcome | undefined> {
    const env = ctx.env;
    const oldImageUsable = record !== undefined && imagePresent;
    // A container of an older setup is no fallback by itself: it must be created again, from an image that exists.
    const containerUsable =
      container !== undefined &&
      (containerIsCurrent(container.labels) || (await this.deps.docker.imageExists(container.image).catch(() => false)));
    const canFallBack = containerUsable || oldImageUsable;
    // An update that only follows newer digests keeps the old environment when a download fails. Otherwise a build is
    // needed anyway, and an image that exists locally is good enough when its download fails.
    const toleratePullFailure = !(oldImageUsable && !plan.forced);
    await this.markBusy(ctx, ctx.firstOpen ? 'create' : plan.forced ? 'rebuild' : 'update');

    const stale = new Set<string>();
    const pulls = imagesToPull({
      images: loaded.references.images,
      check: plan.check,
      hasRecord: record !== undefined,
      imagePresent,
      forced: plan.forced,
    });
    if (pulls.length > 0) {
      ctx.steps.step('downloadingImage');
      // Concept 6.5: the reason, when the comparison with the build record found a newer image.
      if (record !== undefined && plan.updateAvailable) ctx.steps.detail(Messages.newerImage);
      try {
        for (const reference of pulls) await this.pull(ctx, reference, toleratePullFailure, stale);
      } catch (error) {
        return this.updateFailed(ctx, error, canFallBack, plan.check);
      }
    }

    ctx.steps.step('preparing');
    const buildNumber = await this.nextBuildNumber(env);
    const imageName = environmentImageName(env.id, buildNumber);
    await this.updateEntry(ctx, (entry) => {
      entry.lastBuildNumber = Math.max(entry.lastBuildNumber ?? 0, buildNumber);
    });
    try {
      await this.requireVolume(env);
      await this.deps.helper.build({
        volumeName: env.volumeName,
        repository: env.repository,
        configPath: loaded.configPath,
        imageName,
        onOutput: this.output,
        signal: ctx.signal,
      });
    } catch (error) {
      return this.updateFailed(ctx, error, canFallBack, plan.check);
    }

    // Concept 7.7 step 3: replace the container, with the same workspace volume.
    ctx.steps.step('starting');
    // A newer image names the replacement already (Messages.newerImage); otherwise the user learns it here.
    if (container !== undefined && !containerIsCurrent(container.labels) && !plan.updateAvailable) this.announceRecreation(ctx, container);
    let result: DevcontainerResult;
    try {
      result = await this.runUp(ctx, imageName, loaded.config, container !== undefined, true);
    } catch (error) {
      if (isHostAccess(error)) {
        // The new image needs access to the computer (for example a Feature of a newer version): it is not used. The check
        // runs before `up`, so the old container is unchanged. Like a failed update (concept 7.7), the environment starts
        // with the old container or image; without them, the open ends here.
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        if (!canFallBack) throw error;
        await this.rememberRefusedUpdate(ctx, loaded, record, plan.check, error);
        return undefined;
      }
      if (this.isCancellation(error, ctx.signal) || isFilesMissing(error)) throw error;
      this.logger.error(`The container of ${env.repository} could not be created from ${imageName}.`, error);
      // Assumption (V-10, V-12): `up --remove-existing-container` removes the old container before it creates the new one,
      // so after a failure the old container may be gone. It is created again from the old environment image.
      const previousImage =
        oldImageUsable && record
          ? record.environmentImage
          : container && (await this.deps.docker.imageExists(container.image).catch(() => false))
            ? container.image
            : undefined;
      if (!previousImage) throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(error));
      this.deps.ui.warn(Messages.buildFailed);
      // The old container is started when it still exists; a missing or half-created one is replaced.
      const survivor = await this.deps.docker.findContainer(env.id).catch(() => undefined);
      const keep = survivor !== undefined && survivor.image === previousImage && containerIsCurrent(survivor.labels);
      this.logger.info(
        keep
          ? `The previous container ${survivor.name} is started again.`
          : `The container is created again from the previous environment image ${previousImage}.`,
      );
      await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
      try {
        result = await this.runUp(ctx, previousImage, loaded.config, !keep, !keep);
      } catch (restoreError) {
        if (this.isCancellation(restoreError, ctx.signal) || isFilesMissing(restoreError) || isHostAccess(restoreError)) throw restoreError;
        throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(restoreError));
      }
      return keep ? { result, created: false, container: survivor } : { result, created: true };
    }

    // Concept 7.7 step 4: the new build record, then the old images go.
    const current = plan.check.kind === 'checked' ? plan.check.outcome : undefined;
    const newRecord: BuildRecord = {
      builtAt: isoTime(this.deps.clock),
      environmentImage: imageName,
      buildNumber,
      configPath: loaded.configPath,
      configHash: loaded.configHash,
      images: recordDigests(loaded.references.images, current?.images, record?.images, stale),
      features: recordDigests(loaded.references.features, current?.features, record?.features),
    };
    await this.updateEntry(ctx, (entry) => {
      entry.buildRecord = newRecord;
      entry.lastBuildNumber = Math.max(entry.lastBuildNumber ?? 0, buildNumber);
      delete entry.refusedUpdate;
    });
    this.logger.info(`New environment image of ${env.repository}: ${imageName}.`);
    await this.removeEnvironmentImages(ctx.env, imageName, record);
    return { result, created: true };
  }

  /**
   * The new environment image of an update needs access to the computer (concept 7.7, section 9 "Host access"): the user
   * learns what it needs, the existing environment starts, and the same update is not built again (planUpdate) until a
   * digest or the configuration changes. Only an update after an image check can be recognized again.
   */
  private async rememberRefusedUpdate(
    ctx: PipelineContext,
    loaded: LoadedConfiguration,
    record: BuildRecord | undefined,
    check: ImageCheckState,
    error: unknown,
  ): Promise<void> {
    const items = error instanceof HostAccessError ? error.items.join(', ') : errorMessage(error);
    this.logger.info(`The existing environment of ${ctx.env.repository} is started without the update. A changed digest or configuration tries it again.`);
    this.deps.ui.warn(Messages.updateRefused(items));
    if (check.kind !== 'checked') return;
    const refusedUpdate: RefusedUpdate = { ...this.updateKey(loaded, record, check.outcome), items };
    await this.updateEntry(ctx, (entry) => {
      entry.refusedUpdate = refusedUpdate;
    });
  }

  /**
   * A failed pull or build (concept 7.7): with an old container or environment image, the environment starts with them
   * and the next connection tries again (returns `undefined`). Without, the error ends the pipeline.
   */
  private updateFailed(ctx: PipelineContext, error: unknown, canFallBack: boolean, check: ImageCheckState): undefined {
    if (this.isCancellation(error, ctx.signal) || isFilesMissing(error)) throw error;
    const detail = errorDetail(error);
    this.logger.error(`The environment image of ${ctx.env.repository} could not be built.`, error);
    if (canFallBack) {
      this.logger.info('The existing environment is started instead. The next connection tries the update again.');
      this.deps.ui.warn(Messages.buildFailed);
      return undefined;
    }
    if (ctx.firstOpen && (check.kind === 'unreachable' || isNetworkFailure(detail))) {
      throw new UserFacingError('firstOpenOffline', Messages.firstOpenOffline, detail);
    }
    if (isUserFacingError(error)) throw error;
    throw new UserFacingError('buildFailed', Messages.buildFailed, detail);
  }

  private async pull(ctx: PipelineContext, reference: string, tolerateFailure: boolean, stale: Set<string>): Promise<void> {
    try {
      const credentials = await this.pullCredentials(reference, ctx.signal);
      await this.deps.docker.pullImage(reference, { onOutput: this.output, signal: ctx.signal, ...(credentials ? { credentials } : {}) });
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || !tolerateFailure) throw error;
      const local = await this.deps.docker.imageExists(reference).catch(() => false);
      if (!local) throw error;
      this.logger.warn(`${reference} could not be downloaded. The local image is used: ${errorMessage(error)}`);
      stale.add(reference);
    }
  }

  /**
   * Credentials for the pull of `reference` that Docker lacks: the GitHub session for a private image on ghcr.io
   * (concept 7.7 "Registry requires a sign-in"). The image check uses the same session, so an image that it can check can
   * also be downloaded. `undefined`: Docker pulls with its own credentials.
   */
  private async pullCredentials(reference: string, signal: AbortSignal | undefined): Promise<PullCredentials | undefined> {
    if (!this.deps.pullCredentials) return undefined;
    let credentials: PullCredentials | undefined;
    try {
      credentials = await this.deps.pullCredentials(reference, signal);
    } catch (error) {
      this.logger.warn(`The credentials for ${reference} could not be read: ${errorMessage(error)}`);
      return undefined;
    }
    // The secret is never logged.
    if (credentials) this.logger.info(`${reference} is downloaded with the GitHub sign-in for ${credentials.registry}.`);
    return credentials;
  }

  /** Step 9: start or create the container from the existing environment image. Also the fallback after a failed update. */
  private async startContainer(
    ctx: PipelineContext,
    container: ContainerInfo | undefined,
    record: BuildRecord | undefined,
    imagePresent: boolean,
    loaded: LoadedConfiguration | undefined,
  ): Promise<ContainerOutcome> {
    // Concept section 9: a container of an older setup, without the variables of container-only Git, is created again
    // from its environment image, like a missing one. The volume stays. So is a container that was created without the
    // configuration (it could not be read then), once the configuration can be read: it lacks its runArgs and appPort.
    const configKnown = loaded !== undefined;
    const outdated = container !== undefined && !containerIsCurrent(container.labels, configKnown);
    if (container?.state === 'running' && !outdated) {
      this.logger.info(`The container ${container.name} runs already.`);
      await this.prepareGit(ctx);
      return { created: false, container };
    }
    ctx.steps.step('starting');
    if (ctx.helperUnavailable) {
      if (container && !outdated) return this.startWithDocker(ctx, container);
      throw new UserFacingError('helperFailed', Messages.helperFailed);
    }
    // Assumption (V-10): `up` finds an existing container by --id-label and starts it without using the image of the
    // override configuration; a missing container is created from the environment image, without network access.
    let image = record && imagePresent ? record.environmentImage : container?.image;
    if (outdated && image === container?.image && image !== undefined && !(await this.deps.docker.imageExists(image).catch(() => false))) {
      image = undefined;
    }
    if (!image) throw new UserFacingError('buildFailed', Messages.buildFailed, 'There is no environment image.');
    if (outdated && container) {
      this.logger.info(
        containerIsCurrent(container.labels, false)
          ? `The container ${container.name} was created without the configuration, which can be read now. It is created again from ${image}; the files in the volume are kept.`
          : `The container ${container.name} was created by an older version of Dev Environments. It is created again from ${image}; the files in the volume are kept.`,
      );
      this.announceRecreation(ctx, container);
    }
    if (!configKnown && (container === undefined || outdated)) {
      this.logger.warn(
        `The container of ${ctx.env.repository} is created without the configuration, which cannot be read. Its runArgs and published ports apply once it can be read; the container is then created again.`,
      );
    }
    try {
      const result = await this.runUp(ctx, image, loaded?.config, outdated, container === undefined || outdated);
      return { result, created: container === undefined || outdated, container: outdated ? undefined : container };
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || isFilesMissing(error) || isHostAccess(error)) throw error;
      if (container && !outdated && isUserFacingError(error) && error.code === 'helperFailed') return this.startWithDocker(ctx, container);
      this.logger.error(`The container of ${ctx.env.repository} could not be started.`, error);
      throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(error));
    }
  }

  /**
   * An existing container is created again without an update of its image (concept section 9): the files outside the
   * workspace volume, for example the home folder, are lost. The progress says so, as it names a newer image (concept 6.5).
   */
  private announceRecreation(ctx: PipelineContext, container: ContainerInfo): void {
    // Current apart from the configuration: it was created while the configuration could not be read.
    const withoutConfiguration = containerIsCurrent(container.labels, false);
    ctx.steps.detail(withoutConfiguration ? Messages.containerConfigApplied : Messages.containerRecreated);
  }

  /** Without the workspace helper, a stopped container still starts with `docker start` (offline after an extension update). */
  private async startWithDocker(ctx: PipelineContext, container: ContainerInfo): Promise<ContainerOutcome> {
    this.logger.warn(`The workspace helper is not available. ${container.name} is started with docker start; postStartCommand does not run.`);
    await this.deps.sessionFiles.writePending(ctx.env.id, this.deps.owner.windowId);
    try {
      await this.deps.docker.runChecked(['start', container.id], { timeoutMs: DOCKER_START_TIMEOUT_MS, signal: ctx.signal });
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(error));
    }
    return { created: false, container };
  }

  /**
   * `devcontainer up` with the override configuration (concept 7.6). `createsContainer`: `up` creates a container from
   * `image` (no container, or `removeExistingContainer`); only then the image metadata is checked, because `up` starts
   * an existing container without the image, and that container passed the check when it was created.
   */
  private async runUp(
    ctx: PipelineContext,
    image: string,
    config: DevcontainerConfig | undefined,
    removeExistingContainer: boolean,
    createsContainer: boolean,
  ): Promise<DevcontainerResult> {
    const env = ctx.env;
    // Without the configuration, the container gets no runArgs and appPort of the repository. Its label makes the next
    // open with a readable configuration create it again (containerIsCurrent).
    const runArgs = config ? (stringList(config.runArgs) ?? []) : ['--label', CONTAINER_CONFIG_UNKNOWN_LABEL];
    // Concept section 9 "Host access": the flags that the override configuration does not pass to Docker, read with the
    // parser of the policy.
    const removed = removedRunArgs(runArgs);
    if (removed.length > 0) {
      const list = removed.map((entry) => `${entry.arg} (${entry.reason})`).join(', ');
      this.logger.info(`Removed from the runArgs of ${env.repository}: ${list}.`);
    }
    const override = buildOverrideConfig({
      environmentImage: image,
      volumeName: env.volumeName,
      repositoryName: splitRepository(env.repository).name,
      containerName: env.containerName,
      runArgs,
      appPort: config?.appPort,
    });
    // Concept section 9 "Host access": the arguments that Docker gets, after the changes of the override configuration,
    // pass the policy too (the check of the configuration covers them as the repository wrote them).
    const finalRunArgs = hostAccessReport(await this.hostAccessInput(env, { config: { runArgs: override.runArgs } }));
    if (isRefused(finalRunArgs)) {
      this.logger.warn(`The runArgs of the container of ${env.repository} are refused by the host access policy: ${describeRefusal(finalRunArgs)}`);
      throw new HostAccessError(finalRunArgs);
    }
    // The container is in use from its start on (concept 7.9).
    await this.deps.sessionFiles.writePending(env.id, this.deps.owner.windowId);
    await this.requireVolume(env);
    if (createsContainer) await this.checkImageHostAccess(ctx, image);
    if (ctx.cloned && !ctx.ownershipPrepared) await this.prepareOwnership(ctx, image);
    // After the ownership fix (the files get the owner of the repository folder), and before `up`, so that the lifecycle
    // commands have the token and the Git configuration.
    await this.prepareGit(ctx);
    let result: DevcontainerResult & { lifecycleCommandFailure?: unknown };
    try {
      result = await this.deps.helper.up({
        volumeName: env.volumeName,
        repository: env.repository,
        override,
        environmentId: env.id,
        removeExistingContainer,
        onOutput: this.output,
        signal: ctx.signal,
      });
    } catch (error) {
      const kept = await this.keptAfterLifecycleFailure(ctx, error);
      if (!kept) throw error;
      result = kept;
    }
    // A volume named with ${devcontainerId} gets its name only at `up`, so neither the configuration nor the image
    // metadata named it: the new container does.
    if (createsContainer) await this.quietly('record the volumes of the container', () => this.recordContainerVolumes(ctx));
    const failure = nonEmptyString(result.lifecycleCommandFailure);
    return failure === undefined ? result : this.openAfterLifecycleFailure(ctx, result, failure, image);
  }

  /** The named volumes that the container of the environment mounts join its additional volumes (ownVolumes). */
  private async recordContainerVolumes(ctx: PipelineContext): Promise<void> {
    const container = await this.deps.docker.findContainer(ctx.env.id);
    const volumes = await this.ownVolumes(container?.volumes ?? [], ctx.env.volumeName);
    await this.recordMetadataVolumes(ctx, volumes);
  }

  /**
   * The volumes of `names` that the pipeline records as additional volumes: not the workspace volume, and not a volume
   * that the policy gives to something else by its name (foreignVolumeName: an anonymous volume, the helper cache, another
   * environment, the Dev Containers extension) or by its labels (volumeLabelOwner).
   */
  private async ownVolumes(names: readonly string[], workspaceVolume: string): Promise<string[]> {
    const candidates = [...new Set(names)].filter((name) => name !== workspaceVolume && foreignVolumeName(name) === undefined);
    if (candidates.length === 0) return [];
    const labels = new Map((await this.deps.docker.inspectVolumes(candidates)).map((volume) => [volume.name, volume.labels]));
    return candidates.filter((name) => volumeLabelOwner(labels.get(name) ?? {}) === undefined);
  }

  /**
   * `up` failed because a lifecycle command failed (lifecycleHookFailure), and the container that it created or started
   * runs: the result for that container, with the description of the CLI in `lifecycleCommandFailure`. Otherwise
   * `undefined`. (WorkspaceHelper.up returns such a result itself; this covers an `up` that reports it as an error.)
   */
  private async keptAfterLifecycleFailure(
    ctx: PipelineContext,
    error: unknown,
  ): Promise<(DevcontainerResult & { lifecycleCommandFailure: string }) | undefined> {
    if (this.isCancellation(error, ctx.signal) || !(error instanceof DevcontainerCommandError) || !error.result) return undefined;
    const containerId = nonEmptyString(error.result.containerId);
    if (containerId === undefined || lifecycleHookFailure(error.result) === undefined) return undefined;
    const container = await this.deps.docker.findContainer(ctx.env.id).catch(() => undefined);
    if (container?.state !== 'running' || !sameContainerId(container.id, containerId)) return undefined;
    this.logger.error(`A lifecycle command failed in the container ${container.name} of ${ctx.env.repository}. It runs and is kept.`, error);
    return { outcome: 'success', containerId, lifecycleCommandFailure: String(error.result.description) };
  }

  /**
   * A lifecycle command of the configuration (for example postStartCommand) failed, but its container runs. As with the
   * Dev Containers extension, the environment opens anyway, so the user can fix the command inside (FR-02, FR-08,
   * concept 7.6); the failure is a warning. Otherwise a stopped container would never start again, and a first open
   * would remove the new environment. The result of a failed `up` names no remote user: it comes from the metadata of
   * the image, as `up` resolves it.
   */
  private async openAfterLifecycleFailure(
    ctx: PipelineContext,
    result: DevcontainerResult,
    description: string,
    image: string,
  ): Promise<DevcontainerResult> {
    this.logger.warn(`${description} The environment of ${ctx.env.repository} is opened anyway.`);
    this.deps.ui.warn(PipelineTexts.lifecycleCommandFailed(lifecycleHookName(description)));
    if (nonEmptyString(result.remoteUser) !== undefined) return result;
    try {
      return { ...result, remoteUser: await this.imageUser(image, ctx.signal) };
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The remote user of ${image} could not be read: ${errorMessage(error)}`);
      return result;
    }
  }

  /** The user that `devcontainer up` gives a container of `image` (label devcontainer.metadata, see imageRemoteUser). */
  private async imageUser(image: string, signal: AbortSignal | undefined): Promise<string> {
    return imageRemoteUser(await this.imageConfig(image, signal));
  }

  /** `Config` of `docker image inspect`. */
  private async imageConfig(image: string, signal: AbortSignal | undefined): Promise<unknown> {
    const inspect = await this.deps.docker.runChecked(['image', 'inspect', '--format', '{{json .Config}}', image], {
      timeoutMs: IMAGE_INSPECT_TIMEOUT_MS,
      signal,
    });
    return JSON.parse(inspect.trim()) as unknown;
  }

  /**
   * Concept section 9 "Host access": what the policy checks for `env`, with what it needs to know about the named volumes
   * that the configuration mounts: the volumes of the environments of other accounts (their additional volumes), and of
   * the entries of an older version without owner, which may hold the work of another person until an account takes them
   * over, except the volumes that `env` recorded itself; and the labels of the volumes that exist.
   */
  private async hostAccessInput(env: Environment, input: Omit<HostAccessInput, 'ownVolume'>): Promise<HostAccessInput> {
    const checked: HostAccessInput = { ...input, ownVolume: env.volumeName };
    const others = (await this.deps.registry.list()).filter(
      (other) => other.id !== env.id && (other.owner === undefined || other.owner.id !== env.owner?.id),
    );
    // A volume that the environment recorded itself stays its own: older entries of one person shared volumes before
    // the environments were separated by account.
    const own = new Set(env.additionalVolumes ?? []);
    const foreignVolumes = others.flatMap((other) => other.additionalVolumes ?? []).filter((name) => !own.has(name));
    const names = mountedVolumeNames(checked);
    const volumeLabels: Record<string, Record<string, string>> = {};
    if (names.length > 0) for (const volume of await this.deps.docker.inspectVolumes(names)) volumeLabels[volume.name] = volume.labels;
    return { ...checked, foreignVolumes, volumeLabels };
  }

  /**
   * Concept section 9 "Host access", before every `up`: the label devcontainer.metadata of the environment image holds
   * what `up` applies from the base image, the Features, and the configuration of the build (mounts, privileged mode,
   * capabilities). It also covers a configuration that could not be read, and Features that a build added after the
   * merged configuration was read. Throws UserFacingError('hostAccess').
   */
  private async checkImageHostAccess(ctx: PipelineContext, image: string): Promise<void> {
    const config = await this.imageConfig(image, ctx.signal);
    const labels = isRecord(config) && isRecord(config.Labels) ? config.Labels : {};
    const text = labels['devcontainer.metadata'];
    let metadata: unknown[] = [];
    if (typeof text === 'string') {
      try {
        const parsed: unknown = JSON.parse(text);
        metadata = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        this.logger.warn(`The label devcontainer.metadata of ${image} is not valid JSON.`);
      }
    }
    const checked = await this.hostAccessInput(ctx.env, { metadata });
    const report = hostAccessReport(checked);
    if (!isRefused(report)) {
      await this.recordMetadataVolumes(ctx, mountedVolumeNames(checked));
      return;
    }
    this.logger.warn(`The environment image ${image} of ${ctx.env.repository} is refused by the host access policy: ${describeRefusal(report)}`);
    throw new HostAccessError(report);
  }

  /**
   * The named volumes that the base image and the Features mount (image metadata) join the additional volumes of the
   * entry, so that the policy refuses them to the environments of other accounts too.
   */
  private async recordMetadataVolumes(ctx: PipelineContext, names: readonly string[]): Promise<void> {
    const added = names.filter((name) => name !== ctx.env.volumeName && !(ctx.env.additionalVolumes ?? []).includes(name));
    if (added.length === 0) return;
    await this.updateEntry(ctx, (entry) => {
      const current = entry.additionalVolumes ?? [];
      entry.additionalVolumes = [...current, ...added.filter((name) => !current.includes(name))];
    });
  }

  /**
   * Concept section 9 "Git inside the container": the token of the owner account and the Git configuration of the
   * container, written into the volume once per run (at every open: a new sign-in gives a new token), before `up`. A
   * failure is a warning: the environment opens, but Git may not reach GitHub.
   */
  private async prepareGit(ctx: PipelineContext): Promise<void> {
    if (ctx.gitPrepared || ctx.helperUnavailable) return;
    ctx.gitPrepared = true;
    const env = ctx.env;
    try {
      await this.requireVolume(env);
      // Asked for when the session became known; a Cancel does not wait for GitHub.
      const identity = await waitUnlessAborted(ctx.identity, ctx.signal);
      await this.deps.helper.prepareGit({
        volumeName: env.volumeName,
        repository: env.repository,
        token: ctx.session.token,
        identity,
        onOutput: this.output,
        signal: ctx.signal,
      });
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || isFilesMissing(error)) throw error;
      this.logger.error(`The Git configuration of ${env.repository} could not be written.`, error);
      this.deps.ui.warn(Messages.gitSetupFailed);
    }
  }

  /**
   * user.name and user.email of a new Git configuration: the profile of the account on GitHub, or, when GitHub does not
   * answer within 5 seconds, the login and the ID of the session. The opens of this window share one question per
   * account: its answer counts for the window; after a failed question, the fallback counts for 10 minutes, so an open
   * without a connection does not wait again. The question does not end with the open that started it (another open may
   * wait for it too); its time limit ends it. Never rejects.
   */
  private identityOf(session: GitHubSession): Promise<GitIdentity> {
    const { account } = session;
    const cached = this.identities.get(account.id);
    if (cached && (cached.retryAfter === undefined || this.deps.clock.now() < cached.retryAfter)) return cached.identity;
    const fallback = gitIdentity({ databaseId: account.id, login: account.login, name: null });
    const viewer = this.deps.viewer;
    if (!viewer) return Promise.resolve(fallback);
    const timeoutMs = this.deps.viewerTimeoutMs ?? VIEWER_TIMEOUT_MS;
    const entry: { identity: Promise<GitIdentity>; retryAfter?: number } = { identity: Promise.resolve(fallback) };
    entry.identity = (async () => {
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const profile = await waitUnlessAborted(viewer(session.token, timeout), timeout);
        if (String(profile.databaseId) === account.id) return gitIdentity(profile);
        this.logger.info(`GitHub returned the profile of another account than ${account.login}.`);
      } catch (error) {
        this.logger.info(`The profile of ${account.login} could not be read from GitHub: ${errorMessage(error)}`);
      }
      entry.retryAfter = this.deps.clock.now() + IDENTITY_RETRY_MS;
      return fallback;
    })();
    this.identities.set(account.id, entry);
    return entry.identity;
  }

  /**
   * Concept section 9, in a new container before the first attach: the ~/.gitconfig of the remote user
   * (HOME_GIT_CONFIG_CONTENT: an include of the configuration of the volume, for Git older than 2.32 and for processes
   * without the variables of the container). Then the Git version of the container (checkGitVersion). A failure is
   * logged. Root may not write into the home folder of the user when the configuration takes rights away from the
   * container (for example `--cap-drop ALL`, concept section 9 "Host access"): then the user writes the file itself.
   */
  private async prepareHomeGitConfig(ctx: PipelineContext, container: string, user: string): Promise<void> {
    let failure = await this.runHomeGitConfig(ctx, container, user, 'root');
    if (failure !== undefined && !isRootUser(user)) {
      this.logger.info(`The Git configuration of ${user} in the container could not be prepared as root: ${failure}. ${user} prepares it.`);
      failure = await this.runHomeGitConfig(ctx, container, user, user);
    }
    if (failure !== undefined) this.logger.warn(`The Git configuration of ${user} in the container could not be prepared: ${failure}`);
    await this.checkGitVersion(ctx, container, user);
  }

  /** HOME_GIT_CONFIG_SCRIPT for `user`, run as `runAs`. The reason of a failure, or `undefined`. */
  private async runHomeGitConfig(ctx: PipelineContext, container: string, user: string, runAs: string): Promise<string | undefined> {
    try {
      const result = await this.deps.docker.exec(container, homeGitConfigCommand(user), {
        user: runAs,
        signal: ctx.signal,
        timeoutMs: GIT_EXEC_TIMEOUT_MS,
      });
      return result.exitCode === 0 ? undefined : (result.stderr || result.stdout).trim();
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      return errorMessage(error);
    }
  }

  /**
   * Concept section 9: what Git of a new container supports of container-only Git (containerGitSupport). Git before 2.9
   * may use the forwarding credential helper of the Dev Containers extension, so the user gets a warning; Git 2.9 to 2.31
   * ignores GIT_CONFIG_GLOBAL and gets the configuration of the volume only through ~/.gitconfig, which is logged. A
   * container without Git needs nothing. Never fails the open.
   */
  private async checkGitVersion(ctx: PipelineContext, container: string, user: string): Promise<void> {
    let output: string;
    try {
      const result = await this.deps.docker.exec(container, ['git', '--version'], {
        user,
        signal: ctx.signal,
        timeoutMs: BRANCH_EXEC_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return;
      output = result.stdout;
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The Git version in the container could not be read: ${errorMessage(error)}`);
      return;
    }
    const support = containerGitSupport(output);
    const version = output.trim();
    if (support === 'unsafe') {
      this.logger.warn(`${version} in the container of ${ctx.env.repository} is older than 2.9: its credential requests may reach the computer.`);
      this.deps.ui.warn(Messages.oldGit(version.replace(/^git version\s+/, '')));
    } else if (support === 'noGlobalVariable') {
      this.logger.info(
        `${version} in the container of ${ctx.env.repository} ignores GIT_CONFIG_GLOBAL: Git reads the configuration of the volume through ~/.gitconfig.`,
      );
    }
  }

  /** Steps 10 and 11: ownership, Git state, registry entry, pending connection file. */
  private async finish(ctx: PipelineContext, outcome: ContainerOutcome, loaded: LoadedConfiguration | undefined): Promise<OpenResult> {
    const env = ctx.env;
    // A container that was only started keeps its name; a new one got the name of the entry (override runArgs).
    const containerName = outcome.created ? env.containerName : outcome.container?.name ?? env.containerName;
    const containerRef = nonEmptyString(outcome.result?.containerId) ?? outcome.container?.id ?? containerName;
    const remoteUser =
      nonEmptyString(outcome.result?.remoteUser) ??
      env.remoteUser ??
      nonEmptyString(loaded?.config.remoteUser) ??
      nonEmptyString(loaded?.config.containerUser);
    const folder = repositoryFolder(env.repository);

    if ((outcome.created || ctx.cloned) && remoteUser && !isRootUser(remoteUser)) {
      await this.fixOwnership(ctx, containerRef, folder, remoteUser);
      // The token file and the Git configuration were written before `up` with the owner of the repository folder, which
      // is still root when the ownership fix before `up` did not run or failed.
      await this.fixOwnership(ctx, containerRef, CONFIG_FOLDER, remoteUser);
    }
    if (outcome.created) await this.prepareHomeGitConfig(ctx, containerRef, remoteUser ?? 'root');
    const gitSummary = await this.gitSummaryAfterOpen(ctx, containerRef, remoteUser, folder);
    // A Cancel during the Git read ends the open here, before the window would connect.
    this.throwIfCancelled(ctx.signal);
    const remoteWorkspaceFolder = nonEmptyString(outcome.result?.remoteWorkspaceFolder) ?? env.remoteWorkspaceFolder ?? folder;
    const now = isoTime(this.deps.clock);
    // Read before the lock: the mutator does no I/O.
    const blocks = await this.markBlocker();
    // First the pending file, then the busy mark goes: the container stays in use without a gap (concept 7.9).
    await this.deps.sessionFiles.writePending(env.id, this.deps.owner.windowId);
    await this.updateEntry(ctx, (entry) => {
      entry.lastUsedAt = now;
      if (remoteUser) entry.remoteUser = remoteUser;
      entry.remoteWorkspaceFolder = remoteWorkspaceFolder;
      if (gitSummary) entry.gitSummary = gitSummary;
      // The own mark, and a mark that an ended window left behind (it protects nothing, see markBlocker). A live mark of
      // another window stays.
      if (entry.busy && (this.isOwnMark(entry.busy) || !blocks(entry.busy))) delete entry.busy;
    });
    ctx.busy = false;
    this.logger.info(`${env.repository} is ready in the container ${containerName}.`);
    return { environment: ctx.env, containerName, remoteWorkspaceFolder };
  }

  /**
   * Implementation notes 7 "Ownership", before the container exists: the helper clones as root, and `devcontainer up`
   * runs onCreateCommand and postCreateCommand as the remote user when it creates the container. A command that writes
   * to the repository (for example `npm install`) would fail, and with it the open. So the files get their owner first,
   * in a short-lived container of the environment image, which knows the user. The fix after `up` (fixOwnership) stays
   * for files that `up` itself creates as root. A failure is logged, it does not fail the pipeline.
   * Assumption (V-10): the environment image has sh, id, find, and chown, and its label devcontainer.metadata names the
   * remote user as the Dev Container CLI resolves it.
   */
  private async prepareOwnership(ctx: PipelineContext, image: string): Promise<void> {
    ctx.ownershipPrepared = true;
    const { docker } = this.deps;
    const env = ctx.env;
    const folder = repositoryFolder(env.repository);
    try {
      const user = await this.imageUser(image, ctx.signal);
      if (isRootUser(user)) return;
      this.logger.info(`Giving the files in ${folder} to ${user} before the container is created.`);
      const [shell, ...args] = ownershipFixCommand(folder, user);
      await docker.runChecked(
        [
          'run',
          '--rm',
          '--pull',
          'never',
          '--network',
          'none',
          '--label',
          `${LABEL_HELPER_RUN}=true`,
          '--user',
          'root',
          '--entrypoint',
          shell,
          '--mount',
          `type=volume,source=${env.volumeName},target=${WORKSPACES_ROOT}`,
          image,
          ...args,
        ],
        { timeoutMs: OWNERSHIP_TIMEOUT_MS, signal: ctx.signal },
      );
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The owner of the files in ${folder} could not be changed before the container was created: ${errorDetail(error)}`);
    }
  }

  /** Implementation notes 7 "Ownership": the helper clones as root. A failure is logged, it does not fail the pipeline. */
  private async fixOwnership(ctx: PipelineContext, container: string, folder: string, user: string): Promise<void> {
    this.logger.info(`Giving the files in ${folder} to ${user}.`);
    try {
      const result = await this.deps.docker.exec(container, ownershipFixCommand(folder, user), {
        user: 'root',
        signal: ctx.signal,
        timeoutMs: OWNERSHIP_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        this.logger.warn(`The owner of the files in ${folder} could not be changed: ${(result.stderr || result.stdout).trim()}`);
      }
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The owner of the files in ${folder} could not be changed: ${errorMessage(error)}`);
    }
  }

  /** Concept 7.5: the branch from the running container; the change counts stay. After a clone, the full summary. */
  private async gitSummaryAfterOpen(
    ctx: PipelineContext,
    container: string,
    user: string | undefined,
    folder: string,
  ): Promise<GitSummary | undefined> {
    const previous = ctx.env.gitSummary;
    if (!previous || ctx.cloned) return (await this.gitSummaryInContainer(container, user, folder, ctx.signal)) ?? previous;
    const branch = await this.branchInContainer(container, user, folder, ctx.signal);
    return branch === undefined ? previous : { ...previous, branch };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Other operations

  /** Stop: records the Git summary from the running container, then `docker stop`. Does not start Docker. */
  async stop(environmentId: string): Promise<void> {
    const environment = await this.deps.registry.get(environmentId);
    if (!environment) {
      this.logger.info(`Stop: the environment ${environmentId} does not exist.`);
      return;
    }
    await this.requireOwnAccount(environment, false);
    await this.exclusive(repositoryKey(environment.repository), undefined, async () => {
      if (!(await this.deps.docker.isRunning())) {
        this.logger.info('Docker is not running, so no container runs.');
        return;
      }
      // An update, rebuild, or delete in another window replaces or removes the container: no stop in between (concept
      // 7.9 rule 1 applies to the Session Monitor; a Stop from a sidebar that is not up to date must respect it too).
      const env = await this.waitForOtherOperation((await this.deps.registry.get(environmentId)) ?? environment, undefined);
      const container = await this.deps.docker.findContainer(env.id);
      if (!container || container.state !== 'running') {
        this.logger.info(`The container of ${env.repository} does not run.`);
        return;
      }
      const summary = await this.gitSummaryInContainer(container.id, env.remoteUser, repositoryFolder(env.repository));
      if (summary) {
        await this.quietly('record the Git state', () =>
          this.deps.registry.updateEnvironment(env.id, (entry) => {
            entry.gitSummary = summary;
          }),
        );
      }
      await this.deps.docker.stopContainer(container.id);
    });
  }

  /**
   * Safety check before Delete (concept 7.14 step 1), through the workspace helper on the volume. Starts Docker if needed.
   * `undefined` when the volume is missing. When Git cannot read the repository, the last recorded state (or
   * `undefined`), so that known changes are still named (FR-09) and a broken clone can still be deleted.
   * A new result is recorded in the registry.
   */
  async safetyCheck(environmentId: string, options: OperationOptions): Promise<GitSummary | undefined> {
    const env = await this.deps.registry.get(environmentId);
    if (!env) return undefined;
    const steps = new StepReporter(options.progress, this.logger);
    try {
      await this.requireOwnAccount(env, true);
      await this.startDocker(steps, options.signal);
      if (!(await this.deps.docker.volumeExists(env.volumeName))) return undefined;
      let summary: GitSummary;
      try {
        summary = await this.deps.helper.gitSummary({ volumeName: env.volumeName, repository: env.repository, signal: options.signal });
      } catch (error) {
        if (this.isCancellation(error, options.signal) || isUserFacingError(error)) throw error;
        this.logger.warn(`The Git state of ${env.repository} could not be read: ${errorDetail(error)}`);
        return env.gitSummary;
      }
      await this.quietly('record the Git state', () =>
        this.deps.registry.updateEnvironment(env.id, (entry) => {
          entry.gitSummary = summary;
        }),
      );
      return summary;
    } catch (error) {
      throw this.toUserError(error, options.signal);
    }
  }

  /** Delete (concept 7.14 steps 3 to 5). The caller made the safety check and closed a connected window. */
  async delete(environmentId: string, options: OperationOptions & { additionalVolumesToRemove: readonly string[] }): Promise<void> {
    const environment = await this.deps.registry.get(environmentId);
    if (!environment) {
      await this.removeEnvironmentFiles(environmentId);
      return;
    }
    await this.exclusive(repositoryKey(environment.repository), options.signal, async () => {
      try {
        const current = await this.deps.registry.get(environmentId);
        if (!current) {
          await this.removeEnvironmentFiles(environmentId);
          return;
        }
        await this.requireOwnAccount(current, true);
        await this.deleteLocked(current, options);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  private async deleteLocked(
    environment: Environment,
    options: OperationOptions & { additionalVolumesToRemove: readonly string[] },
  ): Promise<void> {
    const { docker } = this.deps;
    const steps = new StepReporter(options.progress, this.logger);
    await this.startDocker(steps, options.signal);
    let env = await this.waitForOtherOperation(environment, options.signal);
    this.throwIfCancelled(options.signal);
    this.logger.info(`Deleting the environment of ${env.repository} (${env.id}).`);
    env = await this.setBusyMark(env, 'delete');
    let removed = false;
    try {
      // Step 3: container, environment image, unused base images.
      const containers = (await docker.listEnvironmentContainers()).filter((c) => c.labels[LABEL_ENVIRONMENT_ID] === env.id);
      for (const container of containers) await docker.removeContainer(container.id);
      await docker.removeContainer(env.containerName);
      await this.removeEnvironmentImages(env, undefined, env.buildRecord);
      // Step 4: the workspace volume; additional volumes only when the user confirmed it.
      await this.removeVolumeWithRetry(env.volumeName);
      if (options.additionalVolumesToRemove.length > 0) await this.removeAdditionalVolumes(env, options.additionalVolumesToRemove);
      // Step 5: the registry entry and the files that reference the environment.
      await this.deps.registry.remove(env.id);
      removed = true;
      await this.removeEnvironmentFiles(env.id);
      this.logger.info(`The environment of ${env.repository} was deleted.`);
    } finally {
      if (!removed) await this.clearOwnMark(env.id);
    }
  }

  /** Switch branch… in an existing environment (concept 7.5): fetch and switch in the volume. Throws gitSwitchFailed. */
  async switchBranch(environmentId: string, branch: string, options: OperationOptions): Promise<void> {
    const environment = await this.deps.registry.get(environmentId);
    if (!environment) throw environmentMissing();
    await this.exclusive(repositoryKey(environment.repository), options.signal, async () => {
      const steps = new StepReporter(options.progress, this.logger);
      let busy = false;
      try {
        const session = await this.requireSession();
        await this.startDocker(steps, options.signal);
        const found = await this.deps.registry.get(environmentId);
        if (!found) throw environmentMissing(environment.repository);
        const current = await this.availableEntry(found, session.account, { token: session.token, interactive: true, signal: options.signal });
        let env = await this.waitForOtherOperation(current, options.signal);
        await this.requireVolume(env);
        const token = session.token;
        env = await this.setBusyMark(env, 'switchBranch');
        busy = true;
        steps.step('downloadingRepository');
        await this.deps.helper
          .switchBranch({
            volumeName: env.volumeName,
            repository: env.repository,
            branch,
            token,
            onOutput: this.output,
            signal: options.signal,
          })
          .catch((error: unknown) => {
            this.reportIfTokenRejected(error, token);
            throw error;
          });
        await this.deps.registry.updateEnvironment(env.id, (entry) => {
          if (entry.gitSummary) entry.gitSummary = { ...entry.gitSummary, branch };
          if (entry.busy && this.isOwnMark(entry.busy)) delete entry.busy;
        });
        busy = false;
        this.logger.info(`${env.repository} is on the branch ${branch}.`);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      } finally {
        if (busy) await this.clearOwnMark(environmentId);
      }
    });
  }

  /**
   * True if the configuration in the volume differs from the build record (path or configHash, concept 7.12). An
   * environment without a build record counts as changed; a missing volume or environment as unchanged.
   */
  async configurationChanged(environmentId: string, options: OperationOptions): Promise<boolean> {
    const env = await this.deps.registry.get(environmentId);
    if (!env) return false;
    const record = env.buildRecord;
    if (!record) return true;
    const steps = new StepReporter(options.progress, this.logger);
    try {
      await this.requireOwnAccount(env, true);
      await this.startDocker(steps, options.signal);
      if (!(await this.deps.docker.volumeExists(env.volumeName))) return false;
      // The configuration that the pipeline would use: on a branch without the selected one, the fallback.
      const resolved = await this.resolveConfigFiles(env, env.configPath, options.signal);
      if (!resolved) return true;
      const { files } = resolved;
      return record.configPath !== resolved.configPath || record.configHash !== configHash(files.configText, files.dockerfileText);
    } catch (error) {
      throw this.toUserError(error, options.signal);
    }
  }

  /** Configuration paths in the volume (current branch), in the order of precedence. */
  async listConfigurations(environmentId: string, options: OperationOptions): Promise<string[]> {
    const env = await this.deps.registry.get(environmentId);
    if (!env) return [];
    const steps = new StepReporter(options.progress, this.logger);
    try {
      await this.requireOwnAccount(env, true);
      await this.startDocker(steps, options.signal);
      await this.requireVolume(env);
      return await this.deps.helper.listConfigurations({ volumeName: env.volumeName, repository: env.repository, signal: options.signal });
    } catch (error) {
      throw this.toUserError(error, options.signal);
    }
  }

  /** Container and volume state of each environment. Does not start Docker: `undefined` when Docker does not run. */
  async inspectStates(): Promise<Map<string, EnvironmentRuntimeState> | undefined> {
    const { docker } = this.deps;
    try {
      if (!(await docker.isRunning())) return undefined;
      const [environments, containers, volumes] = await Promise.all([
        this.deps.registry.list(),
        docker.listEnvironmentContainers(),
        docker.listEnvironmentVolumes(),
      ]);
      const containerStates = new Map<string, ContainerState>();
      for (const container of containers) {
        const id = container.labels[LABEL_ENVIRONMENT_ID];
        if (id && containerStates.get(id) !== 'running') containerStates.set(id, container.state);
      }
      const volumeNames = new Set(volumes.map((volume) => volume.name));
      const states = new Map<string, EnvironmentRuntimeState>();
      for (const env of environments) {
        // A volume without the labels (created outside of this extension) is found by its name.
        const volume = volumeNames.has(env.volumeName) || (await docker.volumeExists(env.volumeName));
        states.set(env.id, { container: containerStates.get(env.id) ?? 'missing', volume });
      }
      return states;
    } catch (error) {
      this.logger.warn(`The state of the environments could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** Current branch from the running container (`git branch --show-current` through `docker exec`). */
  async currentBranch(environmentId: string): Promise<string | undefined> {
    const env = await this.deps.registry.get(environmentId);
    if (!env) return undefined;
    const branch = await this.branchInContainer(env.containerName, env.remoteUser, repositoryFolder(env.repository));
    return branch ?? undefined;
  }

  /**
   * Registry lost (concept 7.5): adds an entry for each volume with the label devenv.environment-id that the registry
   * lacks, with the owner of its label devenv.owner-id. A volume of a repository of which the owner account (or, without
   * the label, an entry of an older version) has an environment already is not added: one environment per repository and
   * account (concept D-3). The entries have no build record, so the next connection with internet access rebuilds the
   * container. Returns the number of added entries. Does not start Docker.
   */
  async reconcileFromVolumes(): Promise<number> {
    const { docker } = this.deps;
    if (!(await docker.isRunning())) return 0;
    const volumes = await docker.listEnvironmentVolumes();
    const now = isoTime(this.deps.clock);
    const candidates: Environment[] = [];
    for (const volume of volumes) {
      const id = volume.labels[LABEL_ENVIRONMENT_ID];
      const repository = volume.labels[LABEL_REPOSITORY];
      if (!isStorageId(id) || !isRepositoryName(repository)) {
        this.logger.warn(`The volume ${volume.name} has invalid labels and is skipped.`);
        continue;
      }
      // Only a volume with the name that the extension gives the environment of these labels: a configuration cannot
      // create such a volume (the host access policy refuses these names and the labels of volumes), so labels on any
      // other volume do not make it an environment.
      if (volume.name.toLowerCase() !== resourceName(repository, id).toLowerCase()) {
        this.logger.warn(`The volume ${volume.name} has the labels of an environment but not its name. It is skipped.`);
        continue;
      }
      // The owner label of the volume gives the entry its owner again; its login follows at the next open.
      const ownerId = volume.labels[LABEL_OWNER_ID];
      candidates.push({
        id,
        repository,
        configPath: DEFAULT_CONFIG_PATH,
        volumeName: volume.name,
        containerName: volume.name,
        createdAt: now,
        lastUsedAt: now,
        ...(isStorageId(ownerId) ? { owner: { id: ownerId, login: '' } } : {}),
      });
    }
    if (candidates.length === 0) return 0;
    // The additional volumes are not on the workspace volume: the container of the environment, which a lost registry does
    // not remove, still mounts them. Without them, another account's environment could take them over as its own.
    // Only the volumes that the pipeline records (named volumes of the configuration): not a volume that the policy gives
    // to something else by its name (an anonymous volume of the container, a volume of the Dev Containers extension, of
    // the helper, or of another environment, foreignVolumeName) or by its labels (volumeLabelOwner).
    const containers = await docker.listEnvironmentContainers();
    for (const candidate of candidates) {
      const mounted = containers
        .filter((container) => container.labels[LABEL_ENVIRONMENT_ID] === candidate.id)
        .flatMap((container) => container.volumes ?? []);
      const volumes = await this.ownVolumes(mounted, candidate.volumeName);
      if (volumes.length > 0) candidate.additionalVolumes = volumes;
    }
    const skipped: string[] = [];
    const added = await this.deps.registry.update((file) => {
      let count = 0;
      for (const candidate of candidates) {
        if (file.environments.some((e) => e.id === candidate.id || e.volumeName === candidate.volumeName)) continue;
        if (file.environments.some((e) => isEnvironmentOf(e, candidate.repository, candidate.owner?.id))) {
          skipped.push(candidate.volumeName);
          continue;
        }
        file.environments.push(candidate);
        count++;
      }
      return count;
    });
    for (const name of skipped) {
      this.logger.warn(`The volume ${name} belongs to a repository that has another environment of the same owner. It is not added.`);
    }
    if (added > 0) this.logger.info(`${added} environments were restored from the labels of their volumes.`);
    return added;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Steps and helpers

  private async startDocker(steps: StepReporter, signal: AbortSignal | undefined): Promise<void> {
    this.throwIfCancelled(signal);
    await this.startDockerFn({ onStarting: () => steps.step('startingDocker'), signal });
  }

  /**
   * A new environment ID (implementation notes 5). The names of an environment end in its short ID (the first 8
   * characters), so an ID is not used when an entry of the registry has its short ID, or when its volume exists:
   * `docker volume create` would take the existing volume, and a failed first open would remove it.
   */
  private async unusedEnvironmentId(repository: string): Promise<string> {
    const used = new Set((await this.deps.registry.list()).map((environment) => shortId(environment.id).toLowerCase()));
    const create = this.deps.newEnvironmentId ?? newEnvironmentId;
    for (let attempt = 1; ; attempt++) {
      const id = create();
      if (!used.has(shortId(id).toLowerCase()) && !(await this.deps.docker.volumeExists(resourceName(repository, id)))) return id;
      if (attempt >= ENVIRONMENT_ID_ATTEMPTS) throw new Error(`No unused environment ID was found for ${repository}.`);
    }
  }

  /**
   * The token and the account of the GitHub session; asks for a sign-in when needed. Both must come from one session: a
   * sign-in with another account between the two questions would give an environment of this account the token of the
   * other one.
   */
  private async requireSession(): Promise<GitHubSession> {
    const token = await this.deps.auth.getToken({ interactive: true });
    if (!token) throw new UserFacingError('signInRequired', Messages.signInRequired);
    const account = await this.deps.auth.getAccount({ interactive: false });
    if (!account || (await this.deps.auth.getToken({ interactive: false })) !== token) {
      throw new UserFacingError('signInRequired', Messages.signInRequired, 'The GitHub session changed during the open.');
    }
    return { token, account };
  }

  /**
   * Builds the helper image if needed. The build is shown as a detail of the current step: the steps of concept 6.5
   * keep their order ("Preparing environment" is the build of the environment image). The check of the base image of
   * the helper follows the setting updateImagesOnConnect, like the image check (concept 7.7).
   */
  private async prepareHelper(ctx: PipelineContext): Promise<void> {
    let announced = false;
    const announce = (text: string): void => {
      if (announced) return;
      announced = true;
      ctx.steps.detail(text);
    };
    try {
      await this.deps.helper.ensureImage({
        onOutput: (text) => {
          announce(PipelineTexts.preparingHelper);
          this.logger.output(text);
        },
        // A new helper after an extension update, or the rebuild of an existing one from a new base image.
        onBuild: (kind) => announce(kind === 'refresh' ? PipelineTexts.updatingHelper : PipelineTexts.preparingHelper),
        checkBaseImage: this.deps.settings().updateImagesOnConnect,
        signal: ctx.signal,
      });
    } catch (error) {
      if (isUserFacingError(error) && error.code === 'helperFailed') ctx.helperUnavailable = true;
      throw error;
    } finally {
      if (announced) ctx.steps.clearDetail();
    }
  }

  private async clone(ctx: PipelineContext, token: string, branch: string | undefined): Promise<void> {
    const env = ctx.env;
    try {
      await this.deps.helper.clone({
        volumeName: env.volumeName,
        repository: env.repository,
        branch,
        token,
        onOutput: this.output,
        signal: ctx.signal,
      });
    } catch (error) {
      this.reportIfTokenRejected(error, token);
      if (this.isCancellation(error, ctx.signal) || isUserFacingError(error)) throw error;
      const detail = errorDetail(error);
      this.logger.error(`${env.repository} could not be cloned.`, error);
      if (isNetworkFailure(detail)) throw new UserFacingError('firstOpenOffline', Messages.firstOpenOffline, detail);
      throw new UserFacingError('cloneFailed', Messages.cloneFailed, detail);
    }
  }

  /**
   * A Git run of the helper with `token` failed because github.com rejected the token (HTTP 401): reported to the one
   * place of the sign-in state (GitHubAuth.reportRejectedToken), so that Sign in with GitHub replaces it.
   */
  private reportIfTokenRejected(error: unknown, token: string): void {
    const text = isUserFacingError(error) ? `${error.message}\n${error.detail ?? ''}` : errorDetail(error);
    if (!isGitHubTokenRejected(text)) return;
    this.logger.warn('GitHub rejected the token of the sign-in (HTTP 401).');
    this.deps.auth.reportRejectedToken?.(token);
  }

  /**
   * Writes the pending connection file of the environment every `pendingRefreshMs` until the returned function is
   * called; that function also waits for a write in progress, so that no write comes after a removal.
   */
  private keepPendingFresh(environmentId: string): () => Promise<void> {
    let writing: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      writing = writing.then(() =>
        this.quietly('refresh the pending connection file', () =>
          this.deps.sessionFiles.writePending(environmentId, this.deps.owner.windowId),
        ),
      );
    }, this.pendingRefreshMs);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await writing;
    };
  }

  /** A helper run on a missing volume would create an empty one without labels (concept 7.5 forbids that). */
  private async requireVolume(env: Environment): Promise<void> {
    if (!(await this.deps.docker.volumeExists(env.volumeName))) {
      throw new UserFacingError('filesMissing', Messages.filesMissing, `The volume ${env.volumeName} does not exist.`);
    }
  }

  private async nextBuildNumber(env: Environment): Promise<number> {
    const repository = environmentImageRepository(env.id);
    let tags: string[] = [];
    try {
      tags = await this.deps.docker.listImageTags(repository);
    } catch (error) {
      this.logger.warn(`The tags of ${repository} could not be listed: ${errorMessage(error)}`);
    }
    return nextBuildNumber({ lastBuildNumber: env.lastBuildNumber, recordBuildNumber: env.buildRecord?.buildNumber, tags, repository });
  }

  /**
   * Removes every tag of the environment image repository except `keep`, and the image of `oldRecord`; then the base
   * images of `oldRecord` that no build record of an environment uses anymore (concept 7.7 "Disk space"). Best effort.
   */
  private async removeEnvironmentImages(env: Environment, keep: string | undefined, oldRecord: BuildRecord | undefined): Promise<void> {
    const repository = environmentImageRepository(env.id);
    const images = new Set<string>();
    try {
      for (const tag of await this.deps.docker.listImageTags(repository)) images.add(tag);
    } catch (error) {
      this.logger.warn(`The tags of ${repository} could not be listed: ${errorMessage(error)}`);
    }
    if (oldRecord) images.add(oldRecord.environmentImage);
    if (keep) images.delete(keep);
    for (const image of images) {
      await this.quietly(`remove the image ${image}`, () => this.deps.docker.removeImage(image));
    }
    if (oldRecord) await this.removeUnusedBaseImages(oldRecord, keep ? undefined : env.id);
  }

  private async removeUnusedBaseImages(oldRecord: BuildRecord, excludeEnvironmentId: string | undefined): Promise<void> {
    let environments: Environment[];
    try {
      environments = await this.deps.registry.list();
    } catch (error) {
      this.logger.warn(`Base images are not removed: ${errorMessage(error)}`);
      return;
    }
    const inUse = new Set<string>();
    for (const other of environments) {
      if (other.id === excludeEnvironmentId) continue;
      for (const [reference, digest] of Object.entries(other.buildRecord?.images ?? {})) inUse.add(baseImageKey(reference, digest));
    }
    for (const [reference, digest] of Object.entries(oldRecord.images)) {
      if (inUse.has(baseImageKey(reference, digest))) continue;
      const image = digestReference(reference, digest);
      if (!image) continue;
      await this.quietly(`remove the base image ${image}`, () => this.removeBaseImage(image, reference));
    }
  }

  /**
   * Removes a base image by its digest reference `<name>@<digest>`. Assumption (V-9): a pulled base image keeps the
   * registry digest of the check as its repository digest, so this reference finds it. The containerd image store then
   * removes the image with its tag; the classic image store of Docker Engine removes only the digest reference, and the
   * tag keeps the image. So the tag is removed too when it still names the same image (a tag that a pull moved to a
   * newer image stays). Docker refuses to remove an image that a container or another image uses (removeImage then
   * returns false).
   */
  private async removeBaseImage(image: string, reference: string): Promise<void> {
    const { docker } = this.deps;
    const id = await docker.imageId(image);
    if (!(await docker.removeImage(image)) || id === undefined) return;
    if ((await docker.imageId(reference)) === id) await docker.removeImage(reference);
  }

  /**
   * Concept 7.14 Delete step 4: the additional volumes that the user confirmed (`confirmed`, as the question listed them)
   * and that the environment still records. Kept: a volume that another environment records, and an existing volume whose
   * labels show that another program created it (volumeLabelOwner), for example a volume of Docker Compose that took a
   * name that the environment used before.
   */
  private async removeAdditionalVolumes(env: Environment, confirmed: readonly string[]): Promise<void> {
    const volumes = (env.additionalVolumes ?? []).filter((name) => confirmed.includes(name));
    if (volumes.length === 0) return;
    const others = (await this.deps.registry.list()).filter((other) => other.id !== env.id);
    const labels = new Map((await this.deps.docker.inspectVolumes(volumes)).map((volume) => [volume.name, volume.labels]));
    for (const name of volumes) {
      if (others.some((other) => other.volumeName === name || (other.additionalVolumes ?? []).includes(name))) {
        this.logger.info(`The volume ${name} is kept, because another environment uses it too.`);
        continue;
      }
      const owner = foreignVolumeName(name) ?? volumeLabelOwner(labels.get(name) ?? {});
      if (owner !== undefined) {
        this.logger.info(`The volume ${name} is kept, because ${owner} created it.`);
        continue;
      }
      await this.quietly(`remove the volume ${name}`, () => this.deps.docker.removeVolume(name));
    }
  }

  private async removeVolumeWithRetry(name: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.deps.docker.removeVolume(name);
        return;
      } catch (error) {
        if (attempt >= VOLUME_REMOVE_ATTEMPTS) throw error;
        await this.sleepFn(VOLUME_REMOVE_DELAY_MS);
      }
    }
  }

  /** Removes the pending connection file, the pending operation, and a reopen record of the environment. */
  private async removeEnvironmentFiles(environmentId: string): Promise<void> {
    const files = this.deps.sessionFiles;
    await this.quietly('remove the pending connection file', () => files.removePending(environmentId));
    await this.quietly('remove the pending operation', () => files.removeOperation(environmentId));
    await this.quietly('remove the reopen record', async () => {
      const record = await files.readReopen();
      if (record?.environmentId === environmentId) await files.removeReopen();
    });
  }

  /** A failed first open leaves nothing behind, so the next Start begins cleanly. */
  private async removeFailedFirstOpen(env: Environment): Promise<void> {
    const { docker } = this.deps;
    this.logger.info(`Removing what the failed first open of ${env.repository} created.`);
    await this.quietly('remove the container', async () => {
      const containers = (await docker.listEnvironmentContainers()).filter((c) => c.labels[LABEL_ENVIRONMENT_ID] === env.id);
      for (const container of containers) await docker.removeContainer(container.id);
      await docker.removeContainer(env.containerName);
    });
    await this.quietly('remove the environment images', () => this.removeEnvironmentImages(env, undefined, undefined));
    await this.quietly(`remove the volume ${env.volumeName}`, () => this.removeVolumeWithRetry(env.volumeName));
    await this.quietly('remove the registry entry', () => this.deps.registry.remove(env.id));
    await this.quietly('remove the pending connection file', () => this.deps.sessionFiles.removePending(env.id));
  }

  /** The Git summary from the running container, or `undefined` when Git is missing, fails, or `signal` aborts. */
  private async gitSummaryInContainer(
    container: string,
    user: string | undefined,
    folder: string,
    signal?: AbortSignal,
  ): Promise<GitSummary | undefined> {
    try {
      const result = await this.deps.docker.exec(container, gitSummaryCommand(folder), { user, timeoutMs: GIT_EXEC_TIMEOUT_MS, signal });
      if (result.exitCode !== 0) {
        this.logger.info(`The Git state in ${container} could not be read: ${(result.stderr || result.stdout).trim()}`);
        return undefined;
      }
      return parseGitSummaryOutput(result.stdout, isoTime(this.deps.clock));
    } catch (error) {
      this.logger.info(`The Git state in ${container} could not be read: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** The branch (`null` for a detached HEAD), or `undefined` when Git is missing, fails, or `signal` aborts. */
  private async branchInContainer(
    container: string,
    user: string | undefined,
    folder: string,
    signal?: AbortSignal,
  ): Promise<string | null | undefined> {
    try {
      const result = await this.deps.docker.exec(
        container,
        ['git', '-c', 'safe.directory=*', '-C', folder, 'branch', '--show-current'],
        { user, timeoutMs: BRANCH_EXEC_TIMEOUT_MS, signal },
      );
      if (result.exitCode !== 0) return undefined;
      const branch = result.stdout.trim();
      return branch === '' ? null : branch;
    } catch {
      return undefined;
    }
  }

  // --- Busy marks ----------------------------------------------------------------------------------------------------

  private busyMark(operation: BusyOperation): BusyMark {
    return { operation, since: isoTime(this.deps.clock), pid: this.deps.owner.pid, windowId: this.deps.owner.windowId };
  }

  private isOwnMark(mark: BusyMark): boolean {
    return mark.windowId === this.deps.owner.windowId && mark.pid === this.deps.owner.pid;
  }

  /**
   * Returns the test "a live mark of another window" (concept 7.9 rule 1, `isBusyMarkLive`): a mark of an ended process,
   * a mark older than 6 hours, and (with window status files) a mark whose window has no recent status file of that
   * process are ignored. Reads the window status files once per call.
   */
  private async markBlocker(): Promise<(mark: BusyMark) => boolean> {
    let windowStatuses: readonly WindowStatus[] | undefined;
    if (this.deps.windowStatuses) {
      try {
        windowStatuses = await this.deps.windowStatuses();
      } catch (error) {
        this.logger.warn(`The window status files could not be read: ${errorMessage(error)}`);
      }
    }
    const now = this.deps.clock.now();
    return (mark) =>
      !this.isOwnMark(mark) &&
      mark.pid !== this.deps.owner.pid &&
      isBusyMarkLive(mark, { now, isAlive: this.isAlive, windowStatuses });
  }

  /**
   * Waits while another live window holds a busy mark (for example the window that asked for a rebuild and is closing
   * its remote connection), at most `busyWaitMs`. Returns the current registry entry.
   * Assumption (V-3): after "Close Remote Connection", the extension host of the old window ends within this time, so
   * the reloaded window can take over the operation that the old window marked.
   */
  private async waitForOtherOperation(environment: Environment, signal: AbortSignal | undefined): Promise<Environment> {
    const attempts = Math.ceil(this.busyWaitMs / BUSY_POLL_MS);
    let current = environment;
    for (let attempt = 0; ; attempt++) {
      const mark = current.busy;
      if (!mark || !(await this.markBlocker())(mark)) return current;
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

  /** Sets a busy mark, unless another live window holds one (checked under the registry lock). */
  private async setBusyMark(env: Environment, operation: BusyOperation): Promise<Environment> {
    const mark = this.busyMark(operation);
    const state: { conflict?: BusyMark } = {};
    // Read before the lock: the mutator does no I/O.
    const blocks = await this.markBlocker();
    const updated = await this.deps.registry.updateEnvironment(env.id, (entry) => {
      if (entry.busy && blocks(entry.busy)) {
        state.conflict = entry.busy;
        return;
      }
      entry.busy = mark;
    });
    if (!updated) throw environmentMissing(env.repository);
    if (state.conflict) throw environmentBusy(env.repository, state.conflict);
    this.logger.info(`${env.repository} is marked as busy (${operation}).`);
    return updated;
  }

  private async markBusy(ctx: PipelineContext, operation: BusyOperation): Promise<void> {
    ctx.env = await this.setBusyMark(ctx.env, operation);
    ctx.busy = true;
  }

  /** Clears the busy mark of this run. Never throws: it runs in `finally` blocks. */
  private async releaseBusy(ctx: PipelineContext): Promise<void> {
    if (!ctx.busy) return;
    ctx.busy = false;
    await this.clearOwnMark(ctx.env.id);
  }

  private async clearOwnMark(environmentId: string): Promise<void> {
    await this.quietly('clear the busy mark', () =>
      this.deps.registry.updateEnvironment(environmentId, (entry) => {
        if (entry.busy && this.isOwnMark(entry.busy)) delete entry.busy;
      }),
    );
  }

  // --- General ---------------------------------------------------------------------------------------------------------

  private async updateEntry(ctx: PipelineContext, mutator: (entry: Environment) => void): Promise<void> {
    const updated = await this.deps.registry.updateEnvironment(ctx.env.id, mutator);
    if (!updated) throw environmentMissing(ctx.env.repository);
    ctx.env = updated;
  }

  /** Runs operations on the same key one after the other. Waiting ends with `cancelled` when the signal aborts. */
  private async exclusive<T>(key: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
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

  private throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw cancelledError();
  }

  private isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true || isAbortError(error) || (isUserFacingError(error) && error.code === 'cancelled');
  }

  /** A cancelled operation ends with UserFacingError('cancelled'); other errors pass unchanged. */
  private toUserError(error: unknown, signal: AbortSignal | undefined): unknown {
    if (this.isCancellation(error, signal)) {
      return isUserFacingError(error) && error.code === 'cancelled' ? error : cancelledError();
    }
    return error;
  }

  /** Runs a cleanup step; a failure is logged and ignored. */
  private async quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(`Could not ${what}: ${errorMessage(error)}`);
    }
  }
}
