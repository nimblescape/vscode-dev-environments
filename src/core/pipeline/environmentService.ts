// Environment service (concept 7.5, 7.6, 7.7, 7.12, 7.14): the open pipeline and the operations on environments.
// It works without VS Code and never connects a window; the VS Code layer connects the window with the result of
// `open`. Each step checks the current state first and does nothing when its result exists (principle 7.1.7), so the
// pipeline can run again at any time.
import { isBusyMarkLive } from '../busy';
import { ContainerAdapter, type ContainerInfo } from '../docker/containerAdapter';
import { ensureDockerRunning } from '../docker/dockerStart';
import { UserFacingError, errorMessage, isUserFacingError } from '../errors';
import { gitSummaryCommand, ownershipFixCommand, parseGitSummaryOutput } from '../git/gitSummary';
import { additionalNamedVolumes, checkConfiguration } from '../helper/configChecks';
import { DevcontainerCommandError, buildOverrideConfig } from '../helper/devcontainerCli';
import { findLocalEnvNames, localEnvValues } from '../helper/localEnv';
import type { WorkspaceHelper } from '../helper/workspaceHelper';
import {
  collectReferences,
  compareWithBuildRecord,
  type CheckOutcome,
  type ConfigReferences,
  type ImageChecker,
} from '../imageCheck/imageCheck';
import { registryDisplayName } from '../imageCheck/reference';
import { Messages, Steps, type ProgressStep } from '../messages';
import {
  LABEL_ENVIRONMENT_ID,
  LABEL_HELPER_RUN,
  LABEL_REPOSITORY,
  WORKSPACES_ROOT,
  configurationName,
  environmentImageName,
  environmentImageRepository,
  newEnvironmentId,
  repositoryFolder,
  resourceName,
  splitRepository,
} from '../names';
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
import type { EnvironmentRegistry } from '../storage/registry';
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
  GitSummary,
  WindowStatus,
} from '../types';
import {
  DEFAULT_CONFIG_PATH,
  baseImageKey,
  configHash,
  digestReference,
  errorDetail,
  imageRemoteUser,
  imagesToPull,
  isNetworkFailure,
  isRepositoryName,
  isRootUser,
  lifecycleHookFailure,
  lifecycleHookName,
  needsBuild,
  nextBuildNumber,
  nonEmptyString,
  recordDigests,
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
  | 'imageExists'
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
>;

/** The part of EnvironmentRegistry that the service uses. */
export type EnvironmentStore = Pick<
  EnvironmentRegistry,
  'get' | 'list' | 'findByRepository' | 'add' | 'update' | 'updateEnvironment' | 'remove'
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
  auth: Pick<GitHubAuth, 'getToken'>;
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
  localEnv: Record<string, string>;
  references: ConfigReferences;
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

  constructor(
    private readonly progress: ProgressReporter,
    private readonly logger: Logger,
  ) {}

  step(step: ProgressStep): void {
    if (step === this.current) return;
    this.current = step;
    this.logger.info(`Step: ${Steps[step]}`);
    this.progress.step(step);
  }

  detail(message: string): void {
    this.progress.detail(message);
  }

  /** Removes the detail of the current step (an empty detail is not shown). */
  clearDetail(): void {
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
  return { [LABEL_ENVIRONMENT_ID]: environment.id, [LABEL_REPOSITORY]: environment.repository };
}

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
function waitUnlessAborted(promise: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return promise.then(() => undefined);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
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

  /** Open pipeline for a repository. Creates the environment on the first open. */
  async open(target: RepositoryTarget, options: OpenOptions): Promise<OpenResult> {
    splitRepository(target.repository);
    return this.exclusive(repositoryKey(target.repository), options.signal, async () => {
      try {
        const existing = await this.deps.registry.findByRepository(target.repository);
        if (existing) {
          if (options.branch !== undefined) {
            this.logger.info(`The branch ${options.branch} applies only to a first open; use Switch branch for an environment.`);
          }
          return await this.openExisting(existing, options, target.defaultBranch ?? undefined);
        }
        return await this.openFirst(target, options);
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

  /** Concept 7.6 "First open": security confirmation, registry entry, workspace volume, clone, then the pipeline. */
  private async openFirst(target: RepositoryTarget, options: OpenOptions): Promise<OpenResult> {
    const { signal } = options;
    const steps = new StepReporter(options.progress, this.logger);
    this.throwIfCancelled(signal);
    if (!target.trusted && !(await this.deps.ui.confirmUntrustedRepository(target.repository))) {
      this.logger.info(`The first open of ${target.repository} was not confirmed.`);
      throw cancelledError();
    }
    const token = await this.requireToken();
    await this.startDocker(steps, signal);
    // Concept 7.5 "registry lost", D-3: a labeled volume of this repository that the registry lacks holds the work of the
    // user. It becomes the environment again; a second environment would hide it. Docker runs now, so the volumes are
    // read also when the registry was lost while Docker was stopped, or when registry.json is invalid.
    if ((await this.reconcileFromVolumes()) > 0) {
      const restored = await this.deps.registry.findByRepository(target.repository);
      if (restored) {
        this.logger.info(`An environment of ${target.repository} was restored from its volume ${restored.volumeName}. It is used.`);
        if (options.branch !== undefined) {
          this.logger.info(`The branch ${options.branch} applies only to a first open; use Switch branch for an environment.`);
        }
        return this.openExisting(restored, options, target.defaultBranch ?? undefined);
      }
    }

    const id = newEnvironmentId();
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
    };
    try {
      await this.deps.registry.add(environment);
    } catch (error) {
      // One environment per repository (concept D-3): another window may have created it right now.
      const other = await this.deps.registry.findByRepository(target.repository);
      if (!other) throw error;
      this.logger.info(`An environment of ${target.repository} was created in the meantime. It is used.`);
      return this.openExisting(other, options, target.defaultBranch ?? undefined);
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
    };
    try {
      steps.step('downloadingRepository');
      await this.deps.docker.createVolume(name, volumeLabels(environment));
      await this.prepareHelper(ctx);
      await this.clone(ctx, token, options.branch ?? target.defaultBranch ?? undefined);
      return await this.runPipeline(ctx);
    } catch (error) {
      await this.removeFailedFirstOpen(ctx.env);
      throw error;
    } finally {
      await this.releaseBusy(ctx);
    }
  }

  /** Steps 2 and 4 for an existing environment, then the pipeline. */
  private async openExisting(environment: Environment, options: OpenOptions, defaultBranch: string | undefined): Promise<OpenResult> {
    const { signal } = options;
    const steps = new StepReporter(options.progress, this.logger);
    // The Session Monitor must not stop a running container while the pipeline runs (concept 7.9). The file is written
    // again while the pipeline runs, because it counts only for 2 minutes and not every step holds a busy mark.
    await this.deps.sessionFiles.writePending(environment.id, this.deps.owner.windowId);
    const stopRefresh = this.keepPendingFresh(environment.id);
    let ctx: PipelineContext | undefined;
    let succeeded = false;
    try {
      await this.startDocker(steps, signal);
      const env = await this.waitForOtherOperation(environment, signal);
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
        await this.quietly('remove the pending connection file', () => this.deps.sessionFiles.removePending(environment.id));
      }
    }
  }

  /** Concept 7.12: the workspace volume is missing. Never creates an empty volume without asking (concept 7.5). */
  private async recoverMissingFiles(ctx: PipelineContext, defaultBranch: string | undefined, progress: ProgressReporter): Promise<void> {
    const env = ctx.env;
    this.logger.warn(`The workspace volume ${env.volumeName} of ${env.repository} is missing.`);
    const choice = await this.deps.ui.filesMissing(env.repository);
    this.throwIfCancelled(ctx.signal);
    if (choice === 'deleteEnvironment') {
      await this.deleteLocked(env, { progress, signal: ctx.signal, removeAdditionalVolumes: false });
      throw cancelledError();
    }
    if (choice !== 'cloneAgain') throw cancelledError();

    const token = await this.requireToken();
    await this.markBusy(ctx, 'create');
    ctx.steps.step('downloadingRepository');
    await this.deps.docker.createVolume(env.volumeName, volumeLabels(env));
    try {
      await this.prepareHelper(ctx);
      await this.clone(ctx, token, defaultBranch);
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
    const token = await this.requireToken();
    const interrupted = ctx.env.busy;
    await this.markBusy(ctx, 'create');
    ctx.steps.step('downloadingRepository');
    try {
      await this.prepareHelper(ctx);
      await this.clone(ctx, token, defaultBranch);
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

    // Step 5. With a broken configuration, the existing environment still starts, so the user can fix it inside.
    let loaded: LoadedConfiguration | undefined;
    try {
      loaded = await this.loadConfiguration(ctx, imagePresent);
    } catch (error) {
      const usable = container !== undefined || imagePresent;
      if (!usable || this.isCancellation(error, ctx.signal) || isFilesMissing(error)) throw configurationError(error);
      this.logger.error(`The configuration of ${ctx.env.repository} could not be used. The existing environment is started.`, error);
      this.deps.ui.warn(isUserFacingError(error) ? error.message : Messages.buildFailed);
    }

    let outcome: ContainerOutcome | undefined;
    if (loaded) {
      await this.saveConfiguration(ctx, loaded, record);
      const plan = await this.planUpdate(ctx, loaded, record, imagePresent, container !== undefined);
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
    if (problems.computerDependent.length > 0) {
      const items = problems.computerDependent.join(', ');
      this.logger.warn(`The configuration ${configPath} depends on the computer: ${items}`);
      this.deps.ui.warn(Messages.computerDependent(items));
    }

    const localEnv = localEnvValues(findLocalEnvNames(files.configText), this.deps.env, this.deps.platform);
    await this.requireVolume(env);
    const config = await helper.readConfiguration({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath,
      environmentId: env.id,
      localEnv,
      onOutput: this.output,
      signal: ctx.signal,
    });
    return {
      configPath,
      fallback,
      configHash: configHash(files.configText, files.dockerfileText),
      config,
      dockerfileText: files.dockerfileText,
      localEnv,
      references: collectReferences(config, files.dockerfileText),
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
    const additionalVolumes = additionalNamedVolumes(loaded.config).filter((name) => name !== ctx.env.volumeName);
    const configPath = loaded.fallback && record !== undefined ? ctx.configPath : loaded.configPath;
    await this.updateEntry(ctx, (entry) => {
      entry.configPath = configPath;
      entry.shutdownActionNone = loaded.config.shutdownAction === 'none';
      entry.additionalVolumes = additionalVolumes;
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
    const canFallBack = container !== undefined || oldImageUsable;
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
        localEnv: loaded.localEnv,
        onOutput: this.output,
        signal: ctx.signal,
      });
    } catch (error) {
      return this.updateFailed(ctx, error, canFallBack, plan.check);
    }

    // Concept 7.7 step 3: replace the container, with the same workspace volume.
    ctx.steps.step('starting');
    let result: DevcontainerResult;
    try {
      result = await this.runUp(ctx, imageName, loaded.config, loaded.localEnv, container !== undefined);
    } catch (error) {
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
      const keep = survivor !== undefined && survivor.image === previousImage;
      this.logger.info(
        keep
          ? `The previous container ${survivor.name} is started again.`
          : `The container is created again from the previous environment image ${previousImage}.`,
      );
      await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
      try {
        result = await this.runUp(ctx, previousImage, loaded.config, loaded.localEnv, !keep);
      } catch (restoreError) {
        if (this.isCancellation(restoreError, ctx.signal) || isFilesMissing(restoreError)) throw restoreError;
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
    });
    this.logger.info(`New environment image of ${env.repository}: ${imageName}.`);
    await this.removeEnvironmentImages(ctx.env, imageName, record);
    return { result, created: true };
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
    if (container?.state === 'running') {
      this.logger.info(`The container ${container.name} runs already.`);
      return { created: false, container };
    }
    ctx.steps.step('starting');
    if (ctx.helperUnavailable) {
      if (container) return this.startWithDocker(ctx, container);
      throw new UserFacingError('helperFailed', Messages.helperFailed);
    }
    // Assumption (V-10): `up` finds an existing container by --id-label and starts it without using the image of the
    // override configuration; a missing container is created from the environment image, without network access.
    const image = record && imagePresent ? record.environmentImage : container?.image;
    if (!image) throw new UserFacingError('buildFailed', Messages.buildFailed, 'There is no environment image.');
    try {
      const result = await this.runUp(ctx, image, loaded?.config, loaded?.localEnv ?? {}, false);
      return { result, created: container === undefined, container };
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || isFilesMissing(error)) throw error;
      if (container && isUserFacingError(error) && error.code === 'helperFailed') return this.startWithDocker(ctx, container);
      this.logger.error(`The container of ${ctx.env.repository} could not be started.`, error);
      throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(error));
    }
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

  /** `devcontainer up` with the override configuration (concept 7.6). */
  private async runUp(
    ctx: PipelineContext,
    image: string,
    config: DevcontainerConfig | undefined,
    localEnv: Record<string, string>,
    removeExistingContainer: boolean,
  ): Promise<DevcontainerResult> {
    const env = ctx.env;
    // The container is in use from its start on (concept 7.9).
    await this.deps.sessionFiles.writePending(env.id, this.deps.owner.windowId);
    await this.requireVolume(env);
    if (ctx.cloned && !ctx.ownershipPrepared) await this.prepareOwnership(ctx, image);
    const override = buildOverrideConfig({
      environmentImage: image,
      volumeName: env.volumeName,
      repositoryName: splitRepository(env.repository).name,
      containerName: env.containerName,
      runArgs: stringList(config?.runArgs),
      appPort: config?.appPort,
      initializeCommand: config?.initializeCommand,
    });
    let result: DevcontainerResult & { lifecycleCommandFailure?: unknown };
    try {
      result = await this.deps.helper.up({
        volumeName: env.volumeName,
        repository: env.repository,
        override,
        environmentId: env.id,
        removeExistingContainer,
        localEnv,
        onOutput: this.output,
        signal: ctx.signal,
      });
    } catch (error) {
      const kept = await this.keptAfterLifecycleFailure(ctx, error);
      if (!kept) throw error;
      result = kept;
    }
    const failure = nonEmptyString(result.lifecycleCommandFailure);
    return failure === undefined ? result : this.openAfterLifecycleFailure(ctx, result, failure, image);
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
    const inspect = await this.deps.docker.runChecked(['image', 'inspect', '--format', '{{json .Config}}', image], {
      timeoutMs: IMAGE_INSPECT_TIMEOUT_MS,
      signal,
    });
    return imageRemoteUser(JSON.parse(inspect.trim()) as unknown);
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
    }
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
  async delete(environmentId: string, options: OperationOptions & { removeAdditionalVolumes: boolean }): Promise<void> {
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
        await this.deleteLocked(current, options);
      } catch (error) {
        throw this.toUserError(error, options.signal);
      }
    });
  }

  private async deleteLocked(
    environment: Environment,
    options: OperationOptions & { removeAdditionalVolumes: boolean },
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
      if (options.removeAdditionalVolumes) await this.removeAdditionalVolumes(env);
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
        await this.startDocker(steps, options.signal);
        const current = await this.deps.registry.get(environmentId);
        if (!current) throw environmentMissing(environment.repository);
        let env = await this.waitForOtherOperation(current, options.signal);
        await this.requireVolume(env);
        const token = await this.requireToken();
        env = await this.setBusyMark(env, 'switchBranch');
        busy = true;
        steps.step('downloadingRepository');
        await this.deps.helper.switchBranch({
          volumeName: env.volumeName,
          repository: env.repository,
          branch,
          token,
          onOutput: this.output,
          signal: options.signal,
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
   * lacks. The entries have no build record, so the next connection with internet access rebuilds the container.
   * Returns the number of added entries. Does not start Docker.
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
      candidates.push({
        id,
        repository,
        configPath: DEFAULT_CONFIG_PATH,
        volumeName: volume.name,
        containerName: volume.name,
        createdAt: now,
        lastUsedAt: now,
      });
    }
    if (candidates.length === 0) return 0;
    const skipped: string[] = [];
    const added = await this.deps.registry.update((file) => {
      let count = 0;
      for (const candidate of candidates) {
        if (file.environments.some((e) => e.id === candidate.id || e.volumeName === candidate.volumeName)) continue;
        const repository = candidate.repository.toLowerCase();
        if (file.environments.some((e) => e.repository.toLowerCase() === repository)) {
          skipped.push(candidate.volumeName);
          continue;
        }
        file.environments.push(candidate);
        count++;
      }
      return count;
    });
    for (const name of skipped) {
      this.logger.warn(`The volume ${name} belongs to a repository that has another environment. It is not added.`);
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

  private async requireToken(): Promise<string> {
    const token = await this.deps.auth.getToken({ interactive: true });
    if (!token) throw new UserFacingError('signInRequired', Messages.signInRequired);
    return token;
  }

  /**
   * Builds the helper image if needed. The build is shown as a detail of the current step: the steps of concept 6.5
   * keep their order ("Preparing environment" is the build of the environment image).
   */
  private async prepareHelper(ctx: PipelineContext): Promise<void> {
    let announced = false;
    try {
      await this.deps.helper.ensureImage({
        onOutput: (text) => {
          if (!announced) {
            announced = true;
            ctx.steps.detail(PipelineTexts.preparingHelper);
          }
          this.logger.output(text);
        },
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
      if (this.isCancellation(error, ctx.signal) || isUserFacingError(error)) throw error;
      const detail = errorDetail(error);
      this.logger.error(`${env.repository} could not be cloned.`, error);
      if (isNetworkFailure(detail)) throw new UserFacingError('firstOpenOffline', Messages.firstOpenOffline, detail);
      throw new UserFacingError('cloneFailed', Messages.cloneFailed, detail);
    }
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
      // Assumption (V-9): a pulled base image keeps the registry digest of the check as its repository digest, so
      // `docker image rm <name>@<digest>` finds it, also with the containerd image store. Docker refuses to remove an
      // image that a container or another image uses (removeImage then returns false).
      await this.quietly(`remove the base image ${image}`, () => this.deps.docker.removeImage(image));
    }
  }

  private async removeAdditionalVolumes(env: Environment): Promise<void> {
    const volumes = env.additionalVolumes ?? [];
    if (volumes.length === 0) return;
    const others = (await this.deps.registry.list()).filter((other) => other.id !== env.id);
    for (const name of volumes) {
      if (others.some((other) => other.volumeName === name || (other.additionalVolumes ?? []).includes(name))) {
        this.logger.info(`The volume ${name} is kept, because another environment uses it too.`);
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
