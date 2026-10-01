// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Environment service (concept 7.5, 7.6, 7.7, 7.12, 7.14): the open pipeline and the operations on environments.
// It works without VS Code and never connects a window; the VS Code layer connects the window with the result of
// `open`. Each step checks the current state first and does nothing when its result exists (principle 7.1.7), so the
// pipeline can run again at any time.
import * as path from 'path';
import { isBusyMarkLive, otherWindowMayUseEnvironment, otherWindowUsesEnvironment, sleepGraceOfWindow, waitingTimeMs } from '../busy';
import { ContainerAdapter, isDevContainer, type ContainerInfo, type NetworkInfo, type VolumeInfo } from '../docker/containerAdapter';
import { dockerHostField, dockerHostOf, environmentsOfHost, isOnDockerHost, type DockerTarget } from '../docker/dockerHost';
import { dockerEndpointUnsupported } from '../docker/remoteDocker';
import { ensureDockerRunning } from '../docker/dockerStart';
import { EnvironmentLockError, holdsEnvironmentLock, runWithEnvironmentLock, type HeldEnvironmentLock } from '../docker/environmentLock';
import { UserFacingError, errorMessage, isUserFacingError } from '../errors';
import {
  MAX_SERVICE_FOLDERS,
  boundServiceFolders,
  existingPathsCommand,
  gitSummaryCommand,
  ownershipFixCommand,
  parseExistingPaths,
  isNumericId,
  parseGitSummaryOutput,
  serviceFolderPaths,
  type DevMountPaths,
  type ServiceFolders,
} from '../git/gitSummary';
import { MAX_CONFIG_TEXT_LENGTH, MAX_IMAGE_ID_REFERENCES } from '../helper/analysisLimits';
import {
  COMPOSE_DEV_DOCKERFILE,
  COMPOSE_MODEL_PATH,
  builtServiceImages,
  composeBuildModel,
  composeConfigHash,
  composeInputsHash,
  composeModelLimit,
  composeNetworkReferences,
  composeServiceImageReferences,
  composeServiceVolumeNames,
  composeUpModel,
  composeUserArgs,
  composeVolumeNames,
  resolveComposeFiles,
  type ComposeBuildModelRewrite,
  type ComposeModel,
  type ComposeModelOutput,
  type ComposeRewriteParams,
} from '../helper/compose';
import { environmentDevcontainerId, helperCliVariables } from '../helper/cliVariables';
import { checkConfiguration, type ConfigurationProblems } from '../helper/configChecks';
import {
  ANALYSIS_FAILED_ITEM,
  analysisFailureItem,
  type AnalysisFailure,
  type AnalysisJob,
  type AnalysisResult,
  type ConfigurationAnalyzer,
} from '../helper/configurationAnalysis';
import { containerGitSupport, gitIdentity, homeGitConfigCommand, isGitHubLogin, type GitHubViewer, type GitIdentity } from '../helper/containerGit';
import { writeContainerToken } from '../helper/containerToken';
import { currentBatchScope, runWithBatchScope } from '../helper/batchScope';
import { channelStepLabel, newCleanupLabel } from '../helperChannel/protocol';
import { DevcontainerCommandError, buildComposeOverrideConfig, buildOverrideConfig, composeConfigOverride } from '../helper/devcontainerCli';
import { findLocalEnvNames, helperEnvNames } from '../helper/localEnv';
import type { HelperFiles, HelperImageUse, WorkspaceHelper } from '../helper/workspaceHelper';
import {
  compareWithBuildRecord,
  type CheckedOutcome,
  type CheckOutcome,
  type ConfigReferences,
  type ImageChecker,
} from '../imageCheck/imageCheck';
import { registryDisplayName } from '../imageCheck/reference';
import { parseJsonc } from '../jsonc';
import { Messages, Steps, listSome, type ProgressStep } from '../messages';
import {
  CONFIG_FOLDER,
  CONTAINER_CONFIG_UNKNOWN_LABEL,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONFIG_PATH,
  LABEL_ENVIRONMENT_ID,
  LABEL_HELPER_RUN,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  LABEL_SERVICE_DATA,
  LABEL_VOLUME,
  SERVICE_DATA,
  VOLUME_KIND_ADDITIONAL,
  VOLUME_KIND_COMPOSE,
  WORKSPACES_ROOT,
  composeProjectName,
  configurationFolder,
  configurationName,
  environmentImageName,
  environmentImageRepository,
  isConfigPathLabelValue,
  newEnvironmentId,
  repositoryFolder,
  resourceName,
  shortId,
  splitRepository,
} from '../names';
import { isAvailableTo, ownerOf } from '../ownership';
import { BRANCH_EXEC_TIMEOUT_MS, readBranch, readEnvironmentStates, type EnvironmentRuntimeState, type EnvironmentStates, type StateEnvironment } from './refreshStates';
import {
  MAX_ITEM_LENGTH,
  addRefusedItems,
  capped,
  cappedReport,
  composeIgnoredProperties,
  composeMissingBuildPaths,
  describeRefusal,
  foreignVolumeName,
  hostAccessChecks,
  environmentImageIds,
  environmentImageShortId,
  imageNamedBy,
  imageLabelItems,
  imageReferencesToInspect,
  inspectedImageItems,
  otherAccountImageItems,
  unknownEnvironmentShortIds,
  volumeOwners,
  isOwnVolume,
  isRefused,
  isSameOwnerAdditionalVolume,
  mountedVolumeNames,
  removedRunArgs,
  resolveNetworkReference,
  runArgsNetworks,
  truncated,
  volumeLabelOwner,
  withoutComposeIgnored,
  type CheckStage,
  type EnvironmentImageIds,
  type InspectedImage,
  type HostAccessChecks,
  type HostAccessInput,
  type HostAccessReport,
  type NamedImageReference,
  type NetworkState,
} from '../policy';
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
  PendingConnection,
  RefusedUpdate,
  WindowStatus,
} from '../types';
import {
  DEFAULT_CONFIG_PATH,
  baseImageKey,
  composeConfigurationChange,
  composeMountVolumes,
  composeRecordOf,
  hasComposeRecord,
  recordedComposeService,
  serviceFoldersOf,
  devMountFolders,
  verifiedIdentityTargets,
  workspaceIdentityMounts,
  liveServiceFolders,
  repositoryServiceDataFolders,
  configHash,
  containerIsCurrent,
  digestReference,
  errorDetail,
  configRemoteUser,
  imageRemoteUser,
  imagesToPull,
  isComposeContainer,
  isComposeRecreateLeftoverName,
  COMPOSE_CONTAINER_NUMBER_LABEL,
  COMPOSE_SERVICE_LABEL,
  COMPOSE_IMAGE_LABEL,
  COMPOSE_CONFIG_HASH_LABEL,
  COMPOSE_ONEOFF_LABEL,
  isContainerFault,
  containerMetadataUser,
  sharedNamespaceServices,
  builtOtherServices,
  unnamedVolumeFolders,
  isGitHubTokenRejected,
  isNetworkFailure,
  isRefusedUpdate,
  isRepositoryName,
  isRootUser,
  isUnrestrictedContainer,
  lifecycleHookFailure,
  lifecycleHookName,
  needsBuild,
  nextBuildNumber,
  nonEmptyString,
  recordDigests,
  refusedUpdateOf,
  MAX_REFUSED_ITEMS_LENGTH,
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
} as const;

/** Plan step 5, PR B, user decision D3: how long an operation waits for the lock of an environment that is held elsewhere. */
export const ENVIRONMENT_LOCK_WAIT_SECONDS = 10;

/** The part of ContainerAdapter that the service uses. A ContainerAdapter fits. */
export type EnvironmentDocker = Pick<
  ContainerAdapter,
  | 'isRunning'
  | 'runChecked'
  | 'findContainer'
  | 'listEnvironmentContainers'
  | 'removeContainer'
  | 'renameContainer'
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
  | 'listEnvironmentImages'
  | 'engineApiVersion'
  | 'listProjectContainers'
  | 'listProjectNetworks'
  | 'removeNetwork'
  | 'listProjectImages'
  | 'inspectNetworks'
  | 'inspectImageNames'
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
  | 'ensureImageUse'
  | 'ensureImagePresent'
  | 'clone'
  | 'readConfigFiles'
  | 'listConfigurations'
  | 'readConfiguration'
  | 'composeModel'
  | 'composeServiceHashes'
  | 'build'
  | 'up'
  | 'runUserCommands'
  | 'gitSummary'
  | 'prepareGit'
  | 'createRepositoryFolders'
  | 'fixConfigOwnership'
>;

/** The part of EnvironmentRegistry that the service uses. */
export type EnvironmentStore = Pick<
  EnvironmentRegistry,
  'get' | 'list' | 'read' | 'forgetKeptVolumes' | 'findForAccount' | 'add' | 'update' | 'updateEnvironment' | 'remove'
>;

/** The part of SessionFiles that the service uses. */
export type EnvironmentSessionFiles = Pick<
  SessionFiles,
  'writePending' | 'removePending' | 'removeOperation' | 'removeDisconnectRequest' | 'readReopen' | 'removeReopen' | 'readPendings'
>;

/**
 * Unit 7, PR 2: the Session Monitor container on a remote Docker host (RemoteSessionMonitor, with the socket of that
 * host and the id of this computer). Both never throw, except an AbortError.
 */
export interface EnvironmentRemoteMonitor {
  /**
   * Makes sure that the monitor container runs with the helper image `helperTag` on `host` (the current context).
   * `helperImage`: the image reference of its `docker run` when it is not the tag: the checked image ID of the helper
   * image of the open (review round 1 of PR #64, S1; review round 3 of PR #64, P2: for the current tag too); the label
   * and the log lines keep the tag. Review round 2 of PR #64 (B-M9): the
   * parameters are required, so an implementation states what it does with them.
   */
  ensure(host: string, helperTag: string, signal: AbortSignal | undefined, helperImage: string | undefined): Promise<unknown>;
  /**
   * One heartbeat of this computer for the environment (with the time limit of the settings). The remote monitor acts
   * only on environments that a computer sent a heartbeat for. `seq`: the wall clock when the keep flag was read
   * (HeartbeatEntry).
   */
  heartbeat(host: string, environmentId: string, keepRunning: boolean, seq: number): Promise<{ ok: true } | { ok: false; detail: string }>;
  /** Removes the heartbeat record of this computer for a deleted environment (best effort). */
  forget(host: string, environmentId: string): Promise<void>;
  /**
   * User requests 2026-09-28: gives the monitor on `host` the image repositories to update and clean (read from the
   * registry; at most once an hour per host). Best effort: never throws, except an AbortError.
   */
  images?(host: string, signal?: AbortSignal): Promise<void>;
}

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
  /**
   * Default: `ensureDockerRunning` with `docker` (then it must be a ContainerAdapter) and `runner`. Unit 7: the extension
   * gives a starter that follows the current Docker context (startDockerOn): no Docker Desktop start for a remote host.
   */
  startDocker?: DockerStarter;
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
  /**
   * Unit 7, PR 2: the Session Monitor on a remote Docker host. The open pipeline ensures it right after the helper image
   * on a remote host (before the container is created or started); Delete removes the record of this computer there.
   * Without it: nothing on the remote host (the local Session Monitor stops the container while the computer is online).
   */
  remoteMonitor?: EnvironmentRemoteMonitor;
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
  /**
   * Review round 8: runs the host access analysis of a configuration (checkContainer of the container policy, ../policy,
   * and the FROM images of the Dockerfiles for the update check). The extension runs it in a worker thread with limits of time and memory
   * (WorkerConfigurationAnalyzer); a failed analysis refuses the configuration.
   */
  analyzer: ConfigurationAnalyzer;
  /**
   * Plan step 5, PR C: readEnvironmentStates in the worker of the Docker target of the operation (HelperChannels.refresh).
   * Undefined, or a result of undefined: outside of an operation (or in the unit tests); the states are read directly.
   * Plan step 5, PR D (rule D1 of 2026-09-30): within an operation it makes the worker ready first, and rejects when it
   * cannot (the refresh then fails; it is never read directly).
   */
  workerRefresh?: (environments: readonly StateEnvironment[]) => Promise<EnvironmentStates | undefined>;
  /**
   * Plan step 5, PR B: takes the lock of an environment in the worker of the Docker target of the operation
   * (HelperChannels.lock), waiting at most `waitSeconds`. Throws EnvironmentLockError (`busy`, `unavailable`) or an
   * AbortError. Stop and Delete take it (user decision D2). Required (D1: there is no path without the lock).
   */
  environmentLock: (environmentId: string, waitSeconds: number, signal: AbortSignal | undefined) => Promise<HeldEnvironmentLock>;
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

/** Plan step 5, PR C: moved to ./refreshStates (shared with the worker). */
export type { EnvironmentRuntimeState, EnvironmentStates, StateEnvironment };

/** MAX_REFUSED_ITEMS_LENGTH of ./pipelineRules (hotfix review 3, C3-2; review 4, Q3). */
export { MAX_REFUSED_ITEMS_LENGTH };

const BUSY_POLL_MS = 500;
/** Review round 4 of PR #68 (B-R4-2): the pause before the second write of Environment.lifecycleIncomplete. */
const LIFECYCLE_MARK_RETRY_MS = 500;

/**
 * Review round 5 of PR #68 (A-R5-1): the states of `docker inspect` (State.Status) of a container that does not run;
 * every other state (`running`, `restarting`, `paused`, `removing`, `dead`, an unknown one) counts as running.
 */
const NOT_RUNNING_STATES: ReadonlySet<string> = new Set(['exited', 'created']);

/**
 * PR #78 review round 2 (A-R2-1): a mark that isBusyMarkLive counts as ended (older than BUSY_MARK_MAX_AGE_MS; the epoch,
 * so a clock correction cannot make it live again), with its operation kept: the create mark of an unfinished clone of
 * this window then blocks nothing (the sidebar of every window, other windows' Start and Delete), like the mark of an
 * ended window, and the next open of any window still completes the clone.
 */
function endedMark(mark: BusyMark): BusyMark {
  return { ...mark, since: new Date(0).toISOString() };
}

/** Review round 4 of PR #68 (A-R4-6): the busy marks are the same mark (all four fields). */
function sameBusyMark(a: BusyMark, b: BusyMark): boolean {
  return a.operation === b.operation && a.since === b.since && a.pid === b.pid && a.windowId === b.windowId;
}
const DEFAULT_BUSY_WAIT_MS = 10_000;
// A pending connection file counts for 2 minutes (concept 7.9 rule 1). A helper image build, `up` with long lifecycle
// commands, or an open prompt can take longer; a refresh well within the waiting time keeps the container in use.
const DEFAULT_PENDING_REFRESH_MS = 15_000;
const IMAGE_INSPECT_TIMEOUT_MS = 60_000;
const GIT_EXEC_TIMEOUT_MS = 30_000;
const OWNERSHIP_TIMEOUT_MS = 10 * 60_000;
const DOCKER_START_TIMEOUT_MS = 60_000;
/**
 * Recreate offer: the check of a running container as the remote user (runningContainerFault). `docker exec -u` fails
 * when /etc/passwd lacks the user, and the shell (which the Dev Container CLI and the Dev Containers extension need) must
 * start.
 */
const CONTAINER_CHECK_COMMAND: readonly string[] = ['/bin/sh', '-c', 'exit 0'];
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
  /** A Docker Compose configuration. */
  compose?: LoadedCompose;
}

/**
 * A Docker Compose configuration of one pipeline run (implementation notes, section "Docker Compose"): the merged model
 * that the check read and that `build` and `up` run in our rewrite (composeBuildModel, composeUpModel), so nothing can
 * change between the check and `up`.
 */
interface LoadedCompose {
  /** composeProjectName of the environment. */
  project: string;
  /** `service` of devcontainer.json: the dev service. */
  service: string;
  /** `runServices` of devcontainer.json, when it names them. */
  runServices?: string[];
  /** The result of the model run: the checked merged model. */
  output: ComposeModelOutput;
  /** The API version of the Docker Engine at the check (volume.subpath of bind mounts of repository files). */
  engineApiVersion?: string;
  /** devcontainer.json as written, for our copy of it in `read-configuration` and `build` (composeConfigOverride). */
  raw: Record<string, unknown>;
  /** The `mounts` values of the configuration and of the merged configuration (composeMountVolumes). */
  mounts: unknown[];
  /** The switch of the host access checks with which the model was checked (PipelineContext.hostAccessChecks). */
  hostAccessChecks: HostAccessChecks;
  /** composeInputsHash of the files as written (review round 1, P-4). */
  inputsHash: string;
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
  /**
   * Review round 9 (D9-1): the clone completed one that a window which ended had begun (resumeInterruptedClone): the
   * volume may hold files that the services wrote, so the ownership fix before `up` leaves out their paths too.
   */
  resumedClone?: boolean;
  /**
   * Review round 9 (D9-1): the paths of the repository that the other services of the Docker Compose model of this run
   * mount (composeUpModel's `serviceFolders`), set by runComposeUp.
   */
  modelServiceFolders?: string[];
  /**
   * Review round 11 (G3, G4, G5): what the ownership fix after a resumed clone leaves to the services, computed by
   * runComposeUp before `up` (the paths of the model, of the existing containers, and the recorded ones).
   */
  serviceFolders?: ServiceFolders;
  /** This run holds a busy mark. */
  busy: boolean;
  /**
   * Review round 5 of PR #68 (risk 3): the busy mark that requireNoOtherWindow set (takeStepMark) and that this run holds
   * (`busy`), so that offerRecreation can clear exactly this mark before its question. Unset by markBusy and releaseBusy.
   */
  stepMark?: BusyMark;
  /**
   * The workspace helper image could not be prepared (for example offline after an extension update: user decision
   * 2026-09-29, no previous helper image). At Step 5 a running container that is current still opens (review round 1
   * of PR #64, L2); a helperFailed after Step 5 ends the open (user decision 2026-09-29; review round 1 of PR #68,
   * A-R1-5). Nothing is started (no docker start fallback, user decision 2026-09-29).
   */
  helperUnavailable: boolean;
  /**
   * Review round 2 of PR #64 (A-N1): the helper image of this run (the current tag with the ID of its image), resolved
   * once by the first prepareHelper of the run and passed to every helper run of it: the configuration that the Dev
   * Container CLI of this image read and checked is built and started with the same CLI, whatever another open of the
   * window resolves meanwhile. Further prepareHelper calls of the run do not resolve it again.
   */
  helperImage?: HelperImageUse;
  /**
   * Review round 1 of PR #64 (L2): the configuration was read, but its check could not run (AnalysisFailure `internal`,
   * for example Docker did not answer for its images): the reason of a Docker Compose start that fails says so.
   */
  configurationUnchecked?: boolean;
  /** Unit 7, PR 2: the Session Monitor on the remote Docker host was ensured in this run (once per run). */
  remoteMonitorEnsured?: boolean;
  /** The GitHub session of the owner account, for the token file of the container (concept section 9). */
  session: GitHubSession;
  /** The token and the Git configuration were written into the volume in this run. */
  gitPrepared: boolean;
  /**
   * Lifecycle token (user decision 2026-09-27): the container into which runUserCommands wrote the token in this run,
   * before the lifecycle commands; finish does not write it again there.
   */
  tokenWrittenTo?: string;
  /**
   * Review PL-2: the container whose ~/.gitconfig runUserCommands prepared in this run (HOME_GIT_CONFIG_SCRIPT), before
   * the lifecycle commands, for Git older than 2.31; finish does not run the script again there (it still checks the
   * Git version of a new container).
   */
  homeGitConfigWrittenTo?: string;
  /**
   * The Git identity of the account (identityOf), asked for as soon as the session is known, so the question to GitHub
   * runs while Docker starts and the image check runs. Never rejects.
   */
  identity: Promise<GitIdentity>;
  /**
   * The switch of the host access checks for the repository, read from the settings at the start of this open
   * (hostAccessChecks, concept section 9 "Host access"). `off` lifts the refusals of access to the computer.
   */
  hostAccessChecks: HostAccessChecks;
  /** The configuration of this run is a Docker Compose configuration (loadComposeConfiguration read it). */
  compose?: boolean;
  /**
   * The configuration is of the other kind (Docker Compose or a single container) than the environment, and no build
   * applies it: the environment is kept as it is (configurationOfKind); a Docker Compose environment then does not start
   * (no docker start fallback, user decision 2026-09-29).
   */
  kindKept?: boolean;
  /**
   * The container of the environment at the start of this run was created by Docker Compose (the project of the
   * environment), so the environment may still have containers of other services.
   */
  composeContainer?: boolean;
  /**
   * What the switch between Docker Compose and a single container removed in this run before `up` (review round 2,
   * D2-4), for the message when `up` fails: the containers of the other services, or the single container.
   */
  kindSwitchRemoved?: string[];
  /**
   * Review round 12 of PR #64 (R12-2): `devcontainer up` ran in this run (it may have removed or replaced the dev container
   * with --remove-existing-container), so a later helperFailed of a switch gets the detail of the switch. Set once `up`
   * returned (review round 13, R13-2): a helperFailed of `up` itself means that its helper container never started.
   */
  upStarted?: boolean;
  /**
   * Review round 4 (D4-1): runComposeUp removed the single container of the environment in this run (a switch to Docker
   * Compose), and the IDs of the containers of Docker Compose of the project that existed before its `up`. After a failed
   * `up`, removeFailedComposeContainers removes only the others (those that the failed `up` created).
   */
  composeSwitch?: { existing: ReadonlySet<string> };
  /**
   * Review round 11 of PR #64 (R11-1): runComposeUp began to move the previous dev container of another service out of
   * the way in this run (movePreviousDevContainer), so a failed `up` is a failed switch of the dev service.
   */
  devServiceMoved?: boolean;
  /**
   * Review round 2 of PR #68 (A-R2-3): what movePreviousDevContainer did with the previous dev container of another
   * service: its ID, its name now (after the rename), and whether it was removed (its rename failed). Review round 5 of
   * PR #68 (A-R5-3): `service`, the service that it belongs to (its label com.docker.compose.service), for the guard of a
   * failed switch of the dev service (FF-1), which must not depend on the build record.
   */
  previousDevContainer?: { id: string; name: string; removed: boolean; service: string };
  /**
   * Review round 5 of PR #68 (A-R5-3): the service of the previous dev container that movePreviousDevContainer began to
   * move (set with devServiceMoved, before previousDevContainer).
   */
  devServiceMovedFrom?: string;
  /**
   * Review round 2 of PR #68 (A-R2-1 to A-R2-4): `up` of this run returned, and run-user-commands then failed with
   * helperFailed, so the lifecycle commands of its container did not run (withdrawAfterHelperFailed): what happened to that
   * container, for the detail of the error. Reset before each `up`.
   */
  upWithdrawn?: UpWithdrawn;
  /**
   * Review round 4 of PR #68 (A-R4-1): the value of Environment.lifecycleIncomplete that this run decided with (read at the
   * start of the pipeline, and again where Step 9 or opensAsItIs decides whether the container opens as it is). finish
   * clears the mark only when it still has this value, or when it names lifecycleRanFor: a mark that another window set
   * meanwhile (for a container that this run opened as it is) stays.
   */
  lifecycleMarkRead?: string;
  /**
   * Review round 4 of PR #68 (A-R4-1): the container whose `up` and run-user-commands this run completed (its lifecycle
   * commands ran, also when one of them failed on its own: keptAfterLifecycleFailure).
   */
  lifecycleRanFor?: string;
  /**
   * Recreate offer (user request 2026-09-26): the user chose to create the damaged dev container of this Docker Compose
   * environment again (offerRecreation). runComposeUp removes only that container (never a volume, never another
   * service) after the checks, right before `up`.
   */
  recreateDevContainer?: ContainerInfo;
  /**
   * Review round 1 of the recreate offer (D2): this run starts the environment with the configuration and the images
   * of its build record (UpdatePlan.current, no build), so the model of Docker Compose is the one its containers were
   * created with. Unset: not known (for example "Rebuild later", or the fallback after a failed update).
   */
  modelOfContainers?: boolean;
}

/** A token together with the account of its session. */
interface GitHubSession {
  token: string;
  account: GitHubAccount;
}

/**
 * Review round 2 of PR #68: what withdrawAfterHelperFailed did with the container of an `up` whose lifecycle commands could
 * not run (run-user-commands failed with helperFailed). `id`: its container ID (review round 3, A-R3-1: a later cleanup of a
 * failed switch may remove it). `created`: this `up` created it (it was not among the containers of the environment right
 * before `up`); `undefined` when that is not known (review round 3, A-R3-3: the listing before `up` failed). `removed`: it
 * was removed; `stopped`: it existed and did not run before `up` (or it is not known whether `up` created it), and was
 * stopped (again); `stoppedAfterRemovalFailed`: its removal failed, so it was stopped; `kept`: neither worked (review round 3,
 * A-R3-5: the registry entry then names it in Environment.lifecycleIncomplete, `marked`); `unchanged`: it ran already
 * before `up` (it ran before this open); `inUse`: another window is connected to the environment (review round 3, A-R3-4),
 * so nothing was touched; `useUnknown`: the window status files or the pending connection files could not be read, so it
 * is not known whether another window uses it, and nothing was touched either (review round 3, A-R3-4: when in doubt, the
 * containers stay). With `inUse` and `useUnknown`, a container that did not run before `up` is marked too (`marked`).
 */
export interface UpWithdrawn {
  outcome: 'removed' | 'stopped' | 'stoppedAfterRemovalFailed' | 'kept' | 'unchanged' | 'inUse' | 'useUnknown';
  id: string;
  created: boolean | undefined;
  name: string;
  /**
   * Review round 3 of PR #68 (A-R3-5): with `kept` (and with `inUse` or `useUnknown`, A-R3-4), the mark
   * Environment.lifecycleIncomplete was recorded. Review round 4 (A-R4-4): with `unchanged` (and a container that ran
   * before `up`), the mark of an earlier open names it still, so the next open runs its lifecycle commands.
   */
  marked?: boolean;
  /**
   * Review round 4 of PR #68 (A-R4-3): with `inUse`, how another window uses the environment: `connected` (its window
   * status file), `opening` (its pending connection file: it opens the environment, and may still wait or build), or
   * `busy` (its busy mark, A-R4-6: the withdrawal could not take its own). Unset: `connected`.
   */
  use?: 'connected' | 'opening' | 'busy';
  /** Review round 4 of PR #68 (A-R4-4): the container ran before `up` (this `up` neither created nor started it). */
  ranBefore?: boolean;
  /**
   * Review round 4 of PR #68 (B-R4-2): it runs without its lifecycle commands, and the mark Environment.lifecycleIncomplete
   * could not be written (with `kept`, `inUse`, `useUnknown`): nothing may promise that the next open runs them.
   */
  markFailed?: boolean;
}

/** Review round 4 of PR #68 (B-R4-2): the end of the sentence of withdrawnOutcome when the mark could not be written. */
const MARK_FAILED = ', and it could not be recorded that its lifecycle commands did not run: stop or rebuild the environment before working in it.';

/**
 * Review round 3 of PR #68 (A-R3-4): whether another window uses the environment, with a sentence for the log. `known:
 * false`: it is not known (a file or the registry could not be read or written), and the containers stay. Review round 4
 * (A-R4-3, A-R4-6): `use`, how the other window uses it (UpWithdrawn.use).
 */
interface WindowUse {
  known: boolean;
  text: string;
  use?: 'connected' | 'opening' | 'busy';
}

/**
 * Review round 2 of PR #68: the sentence of the detail that says what happened to the container (UpWithdrawn). Review
 * round 3 (A-R3-1): `inSwitch` (a failed switch of the kind or of the dev service keeps the previous configuration, so the
 * next open does not start this container): no sentence about the next open.
 */
export function withdrawnOutcome(withdrawn: UpWithdrawn, inSwitch = false): string {
  switch (withdrawn.outcome) {
    case 'removed':
      return inSwitch ? 'It was removed.' : 'It was removed; the next open creates it again.';
    case 'stopped':
      return inSwitch ? 'It was stopped.' : 'It was stopped; the next open starts it again and runs its lifecycle commands.';
    case 'stoppedAfterRemovalFailed':
      return inSwitch ? 'It could not be removed and was stopped.' : 'It could not be removed and was stopped; the next open starts it and runs its lifecycle commands.';
    case 'kept': {
      const what = withdrawn.created === true ? 'It could be neither removed nor stopped' : 'It could not be stopped';
      // Review round 4 (B-R4-2): the mark could not be written.
      if (withdrawn.markFailed === true) return `${what}${MARK_FAILED}`;
      // Review round 3 (A-R3-5): the mark makes the next open run `up` and the lifecycle commands for it.
      return !inSwitch && withdrawn.marked === true ? `${what}; the next open runs its lifecycle commands.` : `${what}.`;
    }
    case 'unchanged':
      // Review round 4 of PR #68 (A-R4-4): the next open runs its lifecycle commands only when the mark still names it.
      return !inSwitch && withdrawn.marked === true ? 'It runs; its lifecycle commands run at the next open.' : 'It runs as before this open.';
    case 'inUse': {
      // Review round 4 of PR #68 (A-R4-3): a pending connection file means that another window opens the environment (it
      // may still wait or build), not that it is connected; A-R4-6: a busy mark of another window.
      const what =
        withdrawn.use === 'opening'
          ? 'It was left running: another window is opening the environment'
          : withdrawn.use === 'busy'
            ? 'It was left running: another window is working on the environment'
            : 'It was left running: another window is connected to it';
      // Review round 4 (B-R4-2): the mark could not be written.
      return withdrawn.markFailed === true ? `${what}${MARK_FAILED}` : `${what}.`;
    }
    case 'useUnknown': {
      // Review round 3 of PR #68 (A-R3-4): when it is not known whether another window uses it, it stays.
      const what = 'It was left running: it could not be checked whether another window is connected to it';
      // Review round 4 (B-R4-2): the mark could not be written.
      if (withdrawn.markFailed === true) return `${what}${MARK_FAILED}`;
      return !inSwitch && withdrawn.marked === true ? `${what}; the next open runs its lifecycle commands.` : `${what}.`;
    }
  }
}

/** Review round 3 of PR #68 (A-R3-3): what `up` did with the container, "created or started" when that is not known. */
function createdOrStarted(withdrawn: UpWithdrawn): string {
  return withdrawn.created === undefined ? 'created or started' : withdrawn.created ? 'created' : 'started';
}

/**
 * Review round 5 of PR #68 (A-R5-2): the clause about the (dev) container `subject` (for example "Its dev container")
 * whose lifecycle commands could not run after `up`: a container that ran before `up` was neither created nor started by
 * it (A-R4-4), so it "runs already"; otherwise what `up` did with it (createdOrStarted).
 */
export function afterUpClause(subject: string, withdrawn: UpWithdrawn): string {
  return lifecycleClause(subject, withdrawn.ranBefore === true, createdOrStarted(withdrawn));
}

/** afterUpClause, with `what` for a container that did not run before `up` ("created", "started", ...). */
function lifecycleClause(subject: string, ranBefore: boolean, what: string): string {
  return ranBefore ? `${subject} runs already, but its lifecycle commands could not run.` : `${subject} was ${what}, but its lifecycle commands could not run.`;
}

/** The cause at the end of a detail: the detail of a UserFacingError (for example of helperFailed), else errorDetail. */
function causeOf(error: unknown): string {
  return isUserFacingError(error) && error.detail ? error.detail : errorDetail(error);
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
  /**
   * Review round 1 of the recreate offer (D2): the configuration and the digests are those of the build record (no
   * change of the configuration, no newer image, also none that was refused), so the model of this run is the one the
   * containers were created with.
   */
  current: boolean;
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

/**
 * Review round 4 of PR #68 (A-R4-5): a step without a busy mark (Step 9) would have to stop, remove, or rename a container,
 * and another window uses the environment (or that could not be checked): nothing was changed (requireNoOtherWindow).
 */
class OtherWindowUsesError extends UserFacingError {
  constructor(detail: string) {
    super('startFailed', PipelineTexts.startFailed, detail);
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

/**
 * Review round 2 of PR #68: the same container. Two full IDs (64 hexadecimal digits) are compared exactly; only a short
 * one is compared as a prefix (sameContainerId), so that no ID that merely starts with another one matches.
 */
function sameContainer(a: string, b: string): boolean {
  if (a === b) return true;
  const full = /^[0-9a-f]{64}$/;
  return full.test(a) !== full.test(b) && sameContainerId(a, b);
}

/**
 * Review round 4 of PR #68 (A-R4-1): whether finish clears the mark Environment.lifecycleIncomplete (`mark`, as the
 * registry holds it under the lock): only when it is the value this run decided with (`read`), or when it names the
 * container whose `up` and run-user-commands this run completed (`ranFor`). A mark that another window set after this run
 * read the entry (for example for the container that this run opened as it is) stays.
 */
export function lifecycleMarkClears(mark: string | undefined, read: string | undefined, ranFor: string | undefined): boolean {
  if (mark === undefined) return false;
  if (read !== undefined && sameContainer(mark, read)) return true;
  return ranFor !== undefined && sameContainer(mark, ranFor);
}

/** The workspace helper could not be prepared, or the helper image of the open is gone (UserFacingError helperFailed). */
function isHelperFailed(error: unknown): boolean {
  return isUserFacingError(error) && error.code === 'helperFailed';
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
  labels[LABEL_OWNER_ID] = environment.owner.id;
  return labels;
}

/**
 * The detail of a failed `up` after a build that switched the kind of the environment (review round 2, D2-4): the
 * environment is not started with its previous kind, and what the switch removed before (`removed`) is named; the
 * volumes are kept. Review round 3 (P3-3): towards Docker Compose, `created` names the containers that the failed `up`
 * created and that were removed again (removeFailedComposeContainers); review round 4 (D4-1): `kept` the containers of
 * Docker Compose that existed before and stay. Review round 2 of PR #68 (A-R2-4): `afterUp`, the sentence of
 * withdrawnOutcome when `up` returned and the lifecycle commands of its (dev) container could not run (helperFailed).
 * Review round 3 of PR #68 (A-R3-2): `removeExisting`, the `up` of the switch ran with --remove-existing-container (there
 * was a dev container); only then does the detail say that the CLI removed (or may have removed) it. Review round 4 of
 * PR #68 (A-R4-4): `afterUpWhat`, what that `up` did with the (dev) container (createdOrStarted: "created or started"
 * when the listing before `up` failed), in both directions. Review round 5 of PR #68 (A-R5-2): `ranBefore`, the (dev)
 * container ran before that `up`, so it "runs already" (afterUpClause).
 */
export function kindSwitchFailure(
  toCompose: boolean,
  removed: readonly string[],
  cause: string,
  created: readonly string[] = [],
  kept: readonly string[] = [],
  afterUp?: string,
  removeExisting = true,
  afterUpWhat = 'created',
  ranBefore = false,
): string {
  // Review round 5 of PR #68 (A-R5-2): `ranBefore`, the (dev) container ran before that `up` (it "runs already").
  const clause = (subject: string): string => lifecycleClause(subject, ranBefore, afterUpWhat);
  const what =
    afterUp !== undefined
      ? toCompose
        ? `The configuration now uses Docker Compose. ${clause('Its dev container')} ${afterUp}`
        : `The configuration no longer uses Docker Compose. ${clause('Its container')} ${afterUp}`
      : toCompose
        ? 'The configuration now uses Docker Compose, and its containers could not all be created and started.'
        : 'The configuration no longer uses Docker Compose, and its container could not be created.';
  const gone = removed.length > 0 ? `The change removed ${removed.join(', ')}.` : 'The change removed no container of the other kind.';
  const again = created.length > 0 ? ` The containers that Docker Compose had created were removed again: ${created.join(', ')}.` : '';
  // Review round 4 (D4-1): the containers of Docker Compose that existed before this start stay.
  const stayed = kept.length > 0 ? ` The containers of Docker Compose that existed before this start were kept: ${kept.join(', ')}.` : '';
  // `up --remove-existing-container` of a single container removes the dev container that it finds by the ID label.
  // Review round 2 of PR #68 (A-R2-4): after `up` returned, the CLI did remove it (--remove-existing-container).
  // Review round 3 (A-R3-2): only when that `up` ran with --remove-existing-container.
  const cli =
    toCompose || !removeExisting
      ? ''
      : afterUp !== undefined
        ? ' The Dev Container CLI removed the previous dev container.'
        : ' The Dev Container CLI may have removed the previous dev container before it failed.';
  // After `up` returned, `afterUp` names what happened to the new container, so "nothing else" would not be true.
  const rest = afterUp !== undefined ? 'The files in the volumes are kept.' : 'Nothing else was removed, and the files in the volumes are kept.';
  return `${what} The environment is not started with its previous containers, which belong to the previous configuration; rebuild it to try again. ${gone}${again}${stayed}${cli} ${rest} ${cause}`;
}

/**
 * Labels of an additional volume that the pipeline creates before `up`: those of the workspace volume, and
 * nimblescape.devenv.volume=additional. Only these labels make a volume the environment's own (isOwnVolume).
 */
export function additionalVolumeLabels(environment: Environment): Record<string, string> {
  return { ...volumeLabels(environment), [LABEL_VOLUME]: VOLUME_KIND_ADDITIONAL };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The files of a helper run for the build model of a Docker Compose configuration: the model, and the Dockerfile of the
 * dev service.
 */
function composeBuildFiles(build: ComposeBuildModelRewrite): HelperFiles {
  return {
    [COMPOSE_MODEL_PATH]: JSON.stringify(build.model, null, 2),
    ...(build.devDockerfile !== undefined ? { [COMPOSE_DEV_DOCKERFILE]: build.devDockerfile } : {}),
  };
}

/** Review round 16 (Dp): whether the configuration names Features (the CLI then builds them into the image). */
function hasFeatures(config: DevcontainerConfig | undefined): boolean {
  return isRecord(config?.features) && Object.keys(config.features).length > 0;
}

function isHostAccess(error: unknown): boolean {
  return isUserFacingError(error) && error.code === 'hostAccess';
}

function otherAccount(repository: string): UserFacingError {
  return new UserFacingError('otherAccount', Messages.otherAccount(repository));
}

/**
 * The message of a refusal (concept section 9 "Host access"): the settings that need access to the computer
 * (Messages.hostAccess), the settings that the policy does not know (Messages.unsupportedOptions), or both.
 */
function refusalMessage(report: HostAccessReport): string {
  // Review round 8: the analysis failed; no settings to name.
  if (report.hostAccess.length === 0 && report.unsupported.length === 1 && report.unsupported[0] === ANALYSIS_FAILED_ITEM) {
    return Messages.configurationTooComplex(ANALYSIS_FAILED_ITEM);
  }
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

  constructor(
    readonly report: HostAccessReport,
    message: string = refusalMessage(report),
  ) {
    super('hostAccess', message, `Refused by the host access policy: ${describeRefusal(report)}`);
    this.items = [...report.hostAccess, ...report.unsupported];
  }
}

/**
 * User decision 2026-09-28: the reasons of dockerCheckItem when the images of the environments on the Docker host, or
 * the volumes that name the owners of some of them, could not be read.
 */
const ENVIRONMENT_IMAGES_UNREAD = 'the images of the environments on the Docker host could not be read';
const ENVIRONMENT_OWNERS_UNREAD = 'the owners of the images of the environments on the Docker host could not be read';

/**
 * Review round 9 (P9-1, P9-2): the analysis of the host access policy failed (AnalysisFailure): refused like a refusal
 * of the policy (fail closed), but an update is not remembered as refused (it is tried again), and an analysis that
 * could not run (`internal`) has a message of its own, does not block an existing environment whose container is only
 * started, and blames no configuration.
 */
class AnalysisFailedError extends HostAccessError {
  constructor(readonly failure: AnalysisFailure) {
    const item = analysisFailureItem(failure);
    super(
      { hostAccess: [], unsupported: [item] },
      failure.kind !== 'internal'
        ? Messages.configurationTooComplex(item)
        : failure.docker === true
          ? Messages.configurationCheckDocker(item)
          : Messages.configurationCheckInternal(item),
    );
  }

  /** The text for the user: ANALYSIS_FAILED_ITEM, analysisInternalItem, or dockerCheckItem. */
  get item(): string {
    return analysisFailureItem(this.failure);
  }
}

/** Review round 9 (P9-2): an analysis that could not run (AnalysisFailure `internal`). */
function isInternalAnalysisFailure(error: unknown): error is AnalysisFailedError {
  return error instanceof AnalysisFailedError && error.failure.kind === 'internal';
}

/** Review round 9 (S9-1): a configuration beyond the limits of analysisLimits.ts, refused as too large or too complex. */
function tooLargeError(reason: string): AnalysisFailedError {
  // Review round 10 (P10-3): a size limit, which the same configuration always exceeds.
  return new AnalysisFailedError({ kind: 'size', reason });
}

/** Review round 11 (G3): the most characters of the paths of one EXISTING_PATHS_SCRIPT call (existingServiceFolders). */
const EXISTING_PATHS_CHARACTERS = 16 * 1024;

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
   * Review round 4 of PR #68 (B-R4-2): environment ID → the ID of a container that runs without its lifecycle commands
   * while the registry could not record it (Environment.lifecycleIncomplete). Consulted with the mark, so that no later
   * open of this window opens it as it is; cleared where the mark is (clearLifecycleMark, and finish after the lifecycle
   * commands of that container ran).
   */
  private readonly unrecordedLifecycle = new Map<string, string>();
  /** Review D2: the endpoints (neither local nor SSH) whose refusal the reads showed already: once each. */
  private readonly refusedEndpoints = new Set<string>();
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
        const existing = await this.deps.registry.findForAccount(target.repository, session.account.id, await this.currentDockerHost());
        if (existing) {
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
    await this.requireCurrentHost(environment);
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
    const dockerHost = await this.currentDockerHost();
    if ((await this.reconcileFromVolumes()) > 0) {
      const restored = await this.deps.registry.findForAccount(target.repository, session.account.id, dockerHost);
      if (restored) {
        this.logger.info(`An environment of ${target.repository} was restored from its volume ${restored.volumeName}. It is used.`);
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
      // Unit 7: and to the Docker host of the operation.
      ...dockerHostField(dockerHost),
    };
    try {
      await this.deps.registry.add(environment);
    } catch (error) {
      // One environment per repository and account (concept D-3): another window of the account may have created it
      // right now.
      const other = await this.deps.registry.findForAccount(target.repository, session.account.id, dockerHost);
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
      hostAccessChecks: this.hostAccessChecksFor(environment.repository),
    };
    // Plan step 6, PR A (user decision D2): the first open runs under the lock of the environment on the Docker host,
    // from before the volume is created through the pipeline and the removal after a failure. A refused lock (D1, D3)
    // has created nothing on Docker: only the new registry entry is removed again (no busy mark, no partial state). When
    // the lock is lost during the removal, its Docker calls fail and the volume stays; PR #78 review round 1 (A-R1-1):
    // the entry then stays too, with its create mark, so the next open completes the clone or Delete removes it
    // (removeFailedFirstOpen keeps the entry whenever the volume cannot be removed); nothing is removed without the lock.
    let locked = false;
    try {
      // Plan step 6, PR C: with the batch scope of the volume `name` (one batch helper for the steps of the open; it opens
      // at the first volume step, after createVolume, and closes before the lock is released).
      return await this.withEnvironmentLock(environment, signal, async () => {
        locked = true;
        try {
          steps.step('downloadingRepository');
          await this.deps.docker.createVolume(name, volumeLabels(environment));
          await this.prepareHelper(ctx);
          await this.clone(ctx, session.token, target.defaultBranch ?? undefined);
          return await this.runPipeline(ctx);
        } catch (error) {
          // PR #78 review round 1 (A-R1-1): the volume could not be removed (for example the lock was lost): the entry keeps its create mark, so the
          // next open completes the clone (resumeInterruptedClone) or Delete removes it.
          if (!(await this.removeFailedFirstOpen(ctx.env, ctx.compose === true))) {
            ctx.busy = false;
            // PR #78 review round 2 (A-R2-1): kept as ended, so it blocks nothing while this window lives.
            await this.quietly('keep the create mark as ended', () =>
              this.deps.registry.updateEnvironment(ctx.env.id, (entry) => {
                if (entry.busy && this.isOwnMark(entry.busy)) entry.busy = endedMark(entry.busy);
              }),
            );
          }
          throw error;
        }
      }, { batchVolume: name });
    } catch (error) {
      if (!locked) await this.removeRefusedFirstOpen(environment);
      throw error;
    } finally {
      await this.releaseBusy(ctx);
    }
  }

  /**
   * Plan step 6, PR A: the lock of a first open was refused (or its wait cancelled) before anything was created on
   * Docker. Only the registry entry of `env` (with its busy mark) is removed; no Docker call runs, as none may run
   * without the lock.
   */
  private async removeRefusedFirstOpen(env: Environment): Promise<void> {
    await this.quietly('remove the registry entry', () => this.deps.registry.remove(env.id, { kept: [] }));
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
    const owned = await this.requireOwner(environment, session);
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
      // Plan step 6, PR A (user decision D2): Start, Rebuild, Select configuration and Clone again run under the lock of
      // the environment on the Docker host, from here through `finish` (in runPipeline): the check of the volume, Clone
      // again (recoverMissingFiles, with its Delete, which holds the lock already: re-entrant), the resumed clone, and the
      // pipeline. D1: without the helper image or the worker the open is refused before anything is changed; D3: a lock
      // held elsewhere is refused after 10 s. The lock stays held while a question to the user is open (user decision Q3
      // of 2026-10-01). The `finally` below runs after the release and changes no Docker state. Plan step 6, PR C: with the
      // batch scope of the volume (batchScope.ts): every helper step of the open runs in one batch helper of the
      // operation, opened at the first volume step (after Clone again created a missing volume) and closed before the
      // release.
      const result = await this.withEnvironmentLock(env, signal, async () => {
        let forced = options.forceRebuild === true;
        let configPath = env.configPath;
        if (options.configPath !== undefined) {
          forced = true;
          if (options.configPath !== env.configPath) {
            this.logger.info(`Configuration of ${env.repository}: ${env.configPath} → ${options.configPath}.`);
            configPath = options.configPath;
          }
        }
        const opened: PipelineContext = {
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
          hostAccessChecks: this.hostAccessChecksFor(env.repository),
        };
        ctx = opened;
        if (!(await this.deps.docker.volumeExists(env.volumeName))) {
          await this.recoverMissingFiles(opened, defaultBranch, options.progress);
        } else if (env.busy?.operation === 'create') {
          await this.resumeInterruptedClone(opened, defaultBranch);
        }
        return this.runPipeline(opened);
      }, { batchVolume: env.volumeName });
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
   * environment of the account. Returns the registry entry; the login of the owner is updated when the account has
   * another one now (a rename on GitHub, or an owner restored from a volume label).
   */
  private async requireOwner(environment: Environment, session: GitHubSession): Promise<Environment> {
    const { account } = session;
    const current = this.availableEntry(environment, account);
    if (current.owner.login === account.login) return current;
    const updated = await this.deps.registry.updateEnvironment(current.id, (entry) => {
      if (entry.owner.id === account.id) entry.owner = ownerOf(account);
    });
    return updated ?? current;
  }

  /**
   * The signed-in account (`interactive`: a sign-in may be asked for); refuses an environment of another account (concept
   * 7.5).
   */
  private async requireOwnAccount(environment: Environment, interactive: boolean): Promise<void> {
    const account = await this.deps.auth.getAccount({ interactive });
    if (!account) throw new UserFacingError('signInRequired', Messages.signInRequired);
    this.availableEntry(environment, account);
  }

  /** The registry entry, when it belongs to `account` (concept 7.5). Throws otherAccount for an entry of another account. */
  private availableEntry(environment: Environment, account: GitHubAccount): Environment {
    if (isAvailableTo(environment, account)) return environment;
    this.logger.info(`The environment ${environment.id} does not belong to the signed-in account. It is not used.`);
    throw otherAccount(environment.repository);
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
      // not use it, as long as this window lives; so it comes back as ended (PR #78 review round 2, A-R2-1).
      ctx.busy = false;
      await this.quietly('restore the busy mark', () =>
        this.deps.registry.updateEnvironment(ctx.env.id, (entry) => {
          if (!entry.busy || !this.isOwnMark(entry.busy)) return;
          // PR #78 review round 1 (A-R1-1): the create mark of a failed first open of this window (kept because its
          // volume could not be removed) comes back too, so a resume that fails again does not lose the clone.
          if (interrupted) entry.busy = this.isOwnMark(interrupted) ? endedMark(interrupted) : interrupted;
          else delete entry.busy;
        }),
      );
      throw error;
    }
    ctx.cloned = true;
    ctx.resumedClone = true;
  }

  /** Steps 5 to 11 of the pipeline. */
  private async runPipeline(ctx: PipelineContext): Promise<OpenResult> {
    const { docker } = this.deps;
    this.throwIfCancelled(ctx.signal);
    // Review round 4 of PR #68 (A-R4-1): the mark as this run read it (Step 9 and opensAsItIs read it again).
    ctx.lifecycleMarkRead = ctx.env.lifecycleIncomplete;
    const container = await docker.findContainer(ctx.env.id, ctx.env.containerName);
    ctx.composeContainer = container !== undefined && isComposeContainer(container.labels, composeProjectName(ctx.env.id));
    const record = ctx.env.buildRecord;
    const imagePresent = record !== undefined && (await docker.imageExists(record.environmentImage));
    this.logger.info(
      `State of ${ctx.env.repository}: container ${container ? container.state : 'missing'}, environment image ` +
        (record ? `${record.environmentImage} ${imagePresent ? 'present' : 'missing'}` : 'not built yet') +
        '.',
    );

    // Step 5. With a broken configuration, the existing environment still starts, so the user can fix it inside (a Docker
    // Compose environment does not: without its model there is no `up`, and no docker start fallback, user decision
    // 2026-09-29; except a dev container that runs already when no container of the environment must be created again, which opens as it is, D-22). A configuration that the host access policy refuses starts nothing (the volume stays, NFR-07).
    let loaded: LoadedConfiguration | undefined;
    try {
      loaded = await this.loadConfiguration(ctx, imagePresent, container);
    } catch (error) {
      const usable = container !== undefined || imagePresent;
      const cancelled = this.isCancellation(error, ctx.signal);
      const helperFailed = isUserFacingError(error) && error.code === 'helperFailed';
      // Review round 2 of PR #64 (A-N1): also when a helper run of this open failed (its helper image was removed), not
      // only prepareHelper: the rest of the open uses no helper.
      if (helperFailed) ctx.helperUnavailable = true;
      // No docker start fallback (user decision 2026-09-29): without the workspace helper only a running container
      // opens; otherwise the open fails with helperFailed at once, without a warning that the environment is started.
      // Review round 1 of PR #64 (L2): only a running container that is current opens as it is (Step 9); a running one
      // that is outdated would be created again, which needs the helper, too. Review round 2 of PR #64 (A-N4): whether
      // it opens as it is (a Docker listing) is asked only when the answer is needed, and a failure of the listing counts
      // as `false`, so the error of the configuration is never lost.
      if (helperFailed && (cancelled || !(await this.opensAsItIsOrFalse(ctx, container, record, false)))) throw error;
      // Review round 9 (P9-2): an analysis that could not run blames no configuration: the existing environment starts
      // as it is (nothing is built or created from the configuration), as with a configuration that cannot be read.
      if (!usable || cancelled || isFilesMissing(error) || (isHostAccess(error) && !isInternalAnalysisFailure(error))) {
        throw configurationError(error);
      }
      // Review round 1 of PR #64 (L2): the log line says what happens next. A Docker Compose environment that is not
      // opened as it is starts nothing (startContainer: startFailed); a single container starts through `up`.
      if (isInternalAnalysisFailure(error)) ctx.configurationUnchecked = true;
      if (helperFailed) {
        // Review round 2 of PR #64 (B2): the configuration was not the problem.
        this.logger.error(`The workspace helper is not available for ${ctx.env.repository}. The running environment is opened as it is.`, error);
      } else {
        const next = (await this.opensAsItIsOrFalse(ctx, container, record, false))
          ? 'The running environment is opened as it is.'
          : this.isComposeEnvironment(ctx.env, record, container)
            ? 'Its containers are not started.'
            : 'The existing environment is started without it.';
        this.logger.error(`The configuration of ${ctx.env.repository} could not be used. ${next}`, error);
      }
      // Review round 14 of PR #64 (R14-1): a Rebuild or a selected configuration says what was not applied; the selected
      // configuration was never saved, so the previous one stays selected. (A helperFailed in Step 8 ends the open instead,
      // user decision 2026-09-29.)
      const selected = ctx.configPath !== ctx.env.configPath;
      this.deps.ui.warn(
        helperFailed && (ctx.forced || selected)
          ? Messages.helperFailedOpenedAsItIs(selected ? 'configuration' : 'rebuild', selected ? configurationName(ctx.env.configPath) : undefined)
          : isUserFacingError(error)
            ? error.message
            : Messages.buildFailed,
      );
    }

    let outcome: ContainerOutcome | undefined;
    // Review round 3 (D3-2): an entry without a build record (restored from its volumes, with the configuration path of
    // the label nimblescape.devenv.config-path of its containers, or else the default one) whose containers are of the
    // other kind than the configuration: the environment switches only when the user says so (a rebuild), never by the
    // build of a first open. Review round 4 (D4-2): also when the dev container of Docker Compose is gone but
    // containers of its other services exist; (D4-3) with a question of its own that names the switch and what it
    // removes.
    const containersCompose = loaded && record === undefined && !ctx.forced ? await this.containersUseCompose(ctx.env, container) : undefined;
    if (loaded && containersCompose !== undefined && containersCompose !== (loaded.compose !== undefined)) {
      this.logger.info(
        `The containers of ${ctx.env.repository} are of another kind than the configuration ${loaded.configPath} (${loaded.compose ? 'Docker Compose' : 'a single container'}), and the environment has no build record.`,
      );
      // Review round 5 (P5-4): without the dev container, Later starts nothing, and the question says so.
      const question =
        container === undefined ? Messages.configurationKindChangedDevContainerMissing(loaded.configPath) : Messages.configurationKindChanged(containersCompose, loaded.configPath);
      const answer = await this.deps.ui.configurationKindChanged(ctx.env.repository, question);
      this.throwIfCancelled(ctx.signal);
      if (answer === 'rebuildNow') ctx.forced = true;
      else {
        this.logger.info('Rebuild later: the existing containers are kept.');
        await this.saveConfiguration(ctx, loaded, record);
        if (container === undefined) {
          // Without its dev container, the Docker Compose environment cannot start without the switch: nothing is removed.
          throw new UserFacingError('startFailed', PipelineTexts.startFailed, Messages.composeDevContainerMissing(loaded.configPath));
        }
        outcome = await this.startContainer(ctx, container, record, imagePresent, this.configurationOfKind(ctx, loaded, container, record));
        return this.finish(ctx, outcome, loaded);
      }
    }
    if (loaded) {
      const previousConfigPath = ctx.env.configPath;
      await this.saveConfiguration(ctx, loaded, record);
      // A container of an older setup is created again (concept section 9); it does not count as a working container.
      const currentContainer = container !== undefined && containerIsCurrent(container.labels, true, ctx.hostAccessChecks);
      const plan = await this.planUpdate(ctx, loaded, record, imagePresent, currentContainer);
      ctx.modelOfContainers = plan.current && !plan.build;
      try {
        if (plan.build) outcome = await this.buildAndReplace(ctx, loaded, plan, record, imagePresent, container);
      } catch (error) {
        // Review round 22 (D22-1): a selected configuration that could not start does not stay selected, so the next open
        // starts the environment with the configuration that it had (its containers are of that one).
        if (ctx.env.configPath !== previousConfigPath) {
          this.logger.info(`The configuration ${ctx.env.configPath} of ${ctx.env.repository} could not be started; ${previousConfigPath} stays selected.`);
          await this.quietly('restore the configuration path', () =>
            this.updateEntry(ctx, (entry) => {
              entry.configPath = previousConfigPath;
            }),
          );
        }
        throw error;
      }
    }
    outcome ??= await this.startContainer(ctx, container, record, imagePresent, this.configurationOfKind(ctx, loaded, container, record));
    return this.finish(ctx, outcome, loaded);
  }

  /**
   * Review round 1 (P-1): the environment switches between Docker Compose and a single container only with a build (as
   * the configuration changes otherwise apply only with a rebuild). Without a build ("Rebuild later", a failed or refused
   * update), the configuration of the other kind is not used to start the environment: `undefined`, so a Docker Compose
   * environment does not start (no docker start fallback, user decision 2026-09-29: without its Docker Compose
   * configuration there is no `up`; a dev container that runs already opens as it is when no container of the environment must be created again, D-22, review round 19
   * of PR #64, R19-1), and a single container starts as a container whose configuration is not known. The
   * kind of the environment: its build record, or else its dev container (review round 3 of PR #68, A-R3-1: before, the
   * dev container first; existingCompose).
   */
  private configurationOfKind(
    ctx: PipelineContext,
    loaded: LoadedConfiguration | undefined,
    container: ContainerInfo | undefined,
    record: BuildRecord | undefined,
  ): LoadedConfiguration | undefined {
    if (loaded === undefined || this.keepsKind(ctx, loaded, container, record)) return loaded;
    const existingCompose = this.existingCompose(ctx, record);
    this.logger.info(
      existingCompose
        ? `The configuration ${loaded.configPath} of ${ctx.env.repository} no longer uses Docker Compose. It applies with the next rebuild; until then, the containers of Docker Compose start only when the dev container runs already and no container of the environment must be created again (the dev container then opens as it is).`
        : `The configuration ${loaded.configPath} of ${ctx.env.repository} now uses Docker Compose. It applies with the next rebuild; until then, the existing container is started as it is.`,
    );
    ctx.kindKept = true;
    return undefined;
  }

  /** Whether configurationOfKind keeps `loaded` (Step 9 then counts the configuration as known), without its log line. */
  private keepsKind(ctx: PipelineContext, loaded: LoadedConfiguration, container: ContainerInfo | undefined, record: BuildRecord | undefined): boolean {
    if (container === undefined && record === undefined) return true;
    return this.existingCompose(ctx, record) === (loaded.compose !== undefined);
  }

  /**
   * Whether the environment is of the kind Docker Compose for configurationOfKind: its build record says so when there is
   * one, else its dev container. Review round 3 of PR #68 (A-R3-1): the record first (as at a failed switch in
   * buildAndReplace), so that the single container that a failed switch from Docker Compose left over (its removal failed)
   * does not make the new configuration current without a build: "Rebuild later" then ends with startFailed, as after
   * a switch whose removal worked.
   */
  private existingCompose(ctx: PipelineContext, record: BuildRecord | undefined): boolean {
    // Review round 4 of PR #68 (A-R4-2): the key decides the kind (hasComposeRecord), not the validity of its fields.
    return record !== undefined ? hasComposeRecord(record) : ctx.composeContainer === true;
  }

  /**
   * Step 5: reads the configuration from the volume. `container`: the container of the environment, if it exists (the
   * CLI merges its metadata into the merged configuration).
   */
  private async loadConfiguration(
    ctx: PipelineContext,
    imagePresent: boolean,
    container: ContainerInfo | undefined,
  ): Promise<LoadedConfiguration> {
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

    const resolved = await this.resolveConfigFiles(env, ctx.configPath, ctx.signal, ctx.helperImage);
    if (!resolved) throw new UserFacingError('noConfiguration', Messages.noConfiguration(env.repository));
    const { configPath, files, fallback } = resolved;
    if (fallback) {
      this.logger.info(`The configuration ${ctx.configPath} does not exist on this branch. ${configPath} is used.`);
      if (ctx.announceConfigFallback) this.deps.ui.info(Messages.configurationNotFound(ctx.configPath, configurationName(configPath)));
    }

    const problems = checkConfiguration(files.configText);
    if (problems.compose) return this.loadComposeConfiguration(ctx, { configPath, fallback, files, problems });

    // Review round 19 (S19-4): devcontainer.json first without the merged configuration (for which the CLI inspects,
    // and pulls when it is missing, the image or the base image of the Dockerfile, and merges its metadata), as for
    // Docker Compose: the checks of the configuration and of the image references (imageIdItems) come before the read of
    // the merged configuration.
    await this.requireVolume(env);
    const { config } = await helper.readConfiguration({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath,
      environmentId: env.id,
      merged: false,
      onOutput: this.output,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    // Concept section 9 "Host access": checked before any build or container start. With the folders against which the
    // CLI resolves the build context and the Dockerfile (review round 1, S1 and S4). The content of the Dockerfile at the
    // path that the resolved configuration names (review round 2, S2-01) is not checked (Dockerfile refusals removed,
    // user decision 2026-09-27): its FROM images are the references of the update check, and its text is part of the
    // configuration hash. The Dockerfile itself is: one that is a link out of the repository or could not be read is
    // refused whatever the switch says (U2), and one too large for the hash is not supported (U1).
    const repository = repositoryFolder(env.repository);
    const dockerfile = await this.resolvedDockerfile(env, configPath, config, files, ctx.signal, ctx.helperImage);
    const input: Omit<HostAccessInput, 'ownVolume'> = {
      config,
      configFolder: path.posix.resolve(repository, configurationFolder(configPath)),
      repositoryFolder: repository,
      ...(dockerfile.text !== undefined ? { dockerfileLength: dockerfile.text.length } : {}),
      ...(dockerfile.unreadable !== undefined ? { dockerfileUnreadable: dockerfile.unreadable } : {}),
    };
    // Review round 8: in the worker (ConfigurationAnalyzer), with the image references of the configuration and the
    // references of the update check.
    const singleAnalysis = async (checked: HostAccessInput) =>
      this.analyze(ctx, {
        kind: 'single',
        input: checked,
        checksOn: ctx.hostAccessChecks === 'on',
        config,
        ...(dockerfile.text !== undefined ? { dockerfileText: dockerfile.text } : {}),
      });
    // Review round 2 (S2-05): a reference that Docker takes for the ID of a local image. Review round 9 (S9-3): only when
    // the configuration is not refused already. `known`: the references that were asked already.
    const refuseUnlessAllowed = async (report: HostAccessReport, references: readonly NamedImageReference[]) => {
      if (!isRefused(report)) {
        const items = await this.imageIdItems(env, references, ctx.signal);
        addRefusedItems(report, 'hostAccess', items.hostAccess);
        addRefusedItems(report, 'unsupported', items.unsupported);
      }
      if (isRefused(report)) {
        this.logger.warn(`The configuration ${configPath} of ${env.repository} is refused by the host access policy: ${describeRefusal(report)}`);
        throw new HostAccessError(report);
      }
    };
    let checked = await this.hostAccessInput(env, input);
    let analysis = await singleAnalysis(checked);
    await refuseUnlessAllowed(analysis.report, analysis.imageReferences);
    const imageReferences = analysis.imageReferences;
    // The merged configuration (review round 19, S19-4: only now).
    await this.requireVolume(env);
    const read = await helper.readConfiguration({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath,
      environmentId: env.id,
      onOutput: this.output,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    let merged = read.merged;
    // The CLI merges the metadata of an existing container. A container created while the host access checks were off
    // holds what they allowed then (for example `privileged` of a configuration that has changed since); with the checks
    // on, it is not current and is created again (containerIsCurrent), and the image metadata of the new container is
    // checked before `up` (checkImageHostAccess). So its merged configuration does not block the open.
    if (merged !== undefined && ctx.hostAccessChecks === 'on' && container !== undefined && isUnrestrictedContainer(container.labels)) {
      this.logger.info(
        `The container ${container.name} was created while the host access checks were off. Its merged configuration is not checked; the image metadata is checked before the container is created again.`,
      );
      merged = undefined;
    }
    // A container that Docker Compose created (the configuration was a Docker Compose configuration): the CLI finds the
    // container by the ID label, which every container of the project has, so it may merge the metadata of another
    // service. It is created again (startContainer), and the image metadata is checked before `up`.
    if (merged !== undefined && ctx.composeContainer === true) {
      this.logger.info(
        `The container of ${env.repository} was created for a Docker Compose configuration. Its merged configuration is not checked; the image metadata is checked before the container is created again.`,
      );
      merged = undefined;
    }
    if (merged !== undefined) {
      // The whole check again with the merged configuration; only the image references that were not asked yet go to
      // Docker.
      checked = await this.hostAccessInput(env, { ...input, merged });
      analysis = await singleAnalysis(checked);
      const asked = new Set(imageReferences.map((entry) => `${entry.what} ${entry.reference}`));
      await refuseUnlessAllowed(
        analysis.report,
        analysis.imageReferences.filter((entry) => !asked.has(`${entry.what} ${entry.reference}`)),
      );
    }
    // Review round 3 (P3-1): a Dockerfile that does not exist in the repository is an error of the configuration, not a
    // refusal (also of the merged configuration): the existing environment still starts (runPipeline), and nothing is built from a file that is not checked.
    if (dockerfile.missing !== undefined) {
      this.logger.warn(`The Dockerfile ${dockerfile.missing} of the configuration ${configPath} of ${env.repository} does not exist.`);
      throw new UserFacingError('buildFailed', Messages.buildFileMissing(`the Dockerfile ${dockerfile.missing}`));
    }
    if (merged === undefined) {
      this.logger.info('The merged configuration is not known: the image metadata is checked before the container starts.');
    }
    this.warnAboutConfiguration(configPath, files, problems);
    return {
      configPath,
      fallback,
      // Review round 3 (P3-2): the Dockerfile at the resolved path.
      configHash: configHash(files.configText, dockerfile.text),
      config,
      dockerfileText: dockerfile.text,
      references: analysis.references,
      mountedVolumes: mountedVolumeNames(checked),
    };
  }

  /**
   * The Dockerfile of a single container at the path that the configuration names after the Dev Container CLI resolved
   * its variables (review round 2, S2-01: the text of the configuration may name it with a variable, for example
   * `${localEnv:NAME:Dockerfile}`, which READ_FILES_SCRIPT does not read): the text that readConfigFiles read when it is
   * that file, or else the file at the resolved path. `unreadable` (U2): the configuration names a Dockerfile that could
   * not be read (outside of the repository, a link out of it, or a path with a variable that is not resolved): the check
   * refuses it whatever the switch says, because the CLI and BuildKit in the workspace helper would read the file that
   * it points to (for example the token or a file of the shared cache volume) as the Dockerfile. Its content is not
   * checked otherwise (Dockerfile refusals removed, user decision 2026-09-27). `missing` (review round 3, P3-1): the
   * Dockerfile does not exist in the repository (an error of the configuration, not a refusal).
   */
  private async resolvedDockerfile(
    env: Environment,
    configPath: string,
    config: DevcontainerConfig,
    files: ConfigFiles,
    signal: AbortSignal | undefined,
    image?: HelperImageUse,
  ): Promise<{ text?: string; unreadable?: string; missing?: string }> {
    const build: Record<string, unknown> = isRecord(config.build) ? config.build : {};
    const raw: Record<string, unknown> = config as Record<string, unknown>;
    const named = typeof build.dockerfile === 'string' ? build.dockerfile : typeof raw.dockerFile === 'string' ? raw.dockerFile : undefined;
    if (named === undefined || named.trim() === '') return files.dockerfileText !== undefined ? { text: files.dockerfileText } : {};
    const repository = repositoryFolder(env.repository);
    const relative = path.posix.relative(repository, path.posix.resolve(repository, configurationFolder(configPath), named));
    if (files.dockerfilePath === relative) {
      if (files.dockerfileText !== undefined) return { text: files.dockerfileText };
      if (files.dockerfileMissing === true) return { missing: named };
    }
    await this.requireVolume(env);
    const read = await this.deps.helper.readConfigFiles({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath,
      dockerfile: named,
      image,
      signal,
    });
    if (read?.dockerfileText !== undefined) return { text: read.dockerfileText };
    return read?.dockerfileMissing === true ? { missing: named } : { unreadable: named };
  }

  /** The warnings of a configuration that the pipeline uses: `${localWorkspaceFolder}`, and variables of the computer. */
  private warnAboutConfiguration(configPath: string, files: ConfigFiles, problems: ConfigurationProblems): void {
    // Review round 9 (S9-1): each message names at most MAX_LISTED_NAMES (listSome), the log at most 200.
    if (problems.computerDependent.length > 0) {
      this.logger.warn(`The configuration ${configPath} depends on the computer: ${listSome(problems.computerDependent, 200)}`);
      this.deps.ui.warn(Messages.computerDependent(listSome(problems.computerDependent)));
    }
    // The values of the computer are not passed to the workspace helper: the CLI resolves the variables there, so a
    // variable that the helper sets (for example HOME) gets its value, any other one is empty or has its default.
    const localEnvNames = findLocalEnvNames(files.configText);
    if (localEnvNames.length > 0) {
      const fromHelper = helperEnvNames(localEnvNames);
      this.logger.info(`Variables of the computer that the configuration uses and that are not passed: ${listSome(localEnvNames, 200)}`);
      this.deps.ui.warn(Messages.localEnvNotPassed(listSome(localEnvNames), fromHelper.length > 0 ? fromHelper.join(', ') : undefined));
    }
  }

  /**
   * Step 5 for a Docker Compose configuration (implementation notes, section "Docker Compose"): devcontainer.json as the
   * CLI resolves it (`service`, `dockerComposeFile`, `runServices`), then the merged model of its compose files, read in
   * the workspace helper without the Docker socket, network, and the configuration folder of the container
   * (WorkspaceHelper.composeModel). Concept section 9 "Host access", before any build: every service of the model and
   * the settings of devcontainer.json that Compose does not support (checkContainer `composeModel`), then devcontainer.json
   * and its merged configuration with the rules of a single container (checkContainer `configuration`, without the
   * properties that the CLI ignores for Compose, withoutComposeIgnored). The merged configuration is read with our
   * copy of devcontainer.json, whose only compose file is our build model. The switch of the host access checks applies
   * as for a single container: with the checks off, only the items of the class `computer` are lifted.
   */
  private async loadComposeConfiguration(
    ctx: PipelineContext,
    p: { configPath: string; fallback: boolean; files: ConfigFiles; problems: ConfigurationProblems },
  ): Promise<LoadedConfiguration> {
    const { helper } = this.deps;
    const env = ctx.env;
    const { configPath, files } = p;
    const project = composeProjectName(env.id);
    await this.requireVolume(env);
    // Review round 19 (D19-1): with the project name in the environment of the CLI, as for the merged read below: the
    // CLI resolves `${localEnv:COMPOSE_PROJECT_NAME}` of devcontainer.json (for example in `mounts`) with it, and the
    // mounts, their volumes, and the checks use this configuration.
    const { config } = await helper.readConfiguration({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath,
      environmentId: env.id,
      merged: false,
      env: { COMPOSE_PROJECT_NAME: project },
      onOutput: this.output,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    const service = nonEmptyString(config.service);
    const composeFiles = resolveComposeFiles(configPath, splitRepository(env.repository).name, config.dockerComposeFile);
    if (service === undefined || 'problem' in composeFiles) {
      const unsupported = [
        ...(service === undefined ? ['service (the dev service of the Docker Compose configuration is missing)'] : []),
        ...('problem' in composeFiles ? [composeFiles.problem] : []),
      ];
      this.logger.warn(`The Docker Compose configuration ${configPath} of ${env.repository} is refused: ${unsupported.join('; ')}`);
      throw new HostAccessError({ hostAccess: [], unsupported });
    }
    ctx.compose = true;
    await this.requireVolume(env);
    const output = await helper.composeModel({
      volumeName: env.volumeName,
      repository: env.repository,
      files: composeFiles.files,
      project,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    if ('error' in output) {
      this.logger.warn(`Docker Compose could not read the configuration ${configPath} of ${env.repository}: ${output.error}`);
      throw new UserFacingError('buildFailed', Messages.composeConfigurationFailed, output.error);
    }
    // Review round 9 (S9-1): before anything in this thread works on the model. Review round 10 (S10-2): also the
    // Dockerfiles, before the hashes read them.
    const tooLarge = composeModelLimit(output.model, output.dockerfiles);
    if (tooLarge !== undefined) {
      this.logger.warn(`The Docker Compose configuration ${configPath} of ${env.repository} is too large to check: ${tooLarge}.`);
      throw tooLargeError(tooLarge);
    }
    const engineApiVersion = await this.deps.docker.engineApiVersion(ctx.signal);
    this.logger.info(
      `Docker Compose configuration ${configPath} of ${env.repository}: project ${project}, dev service ${service}, services ${Object.keys(output.model.services).join(', ')}; Docker Compose ${output.version}, Docker Engine API ${engineApiVersion ?? 'unknown'}.`,
    );
    const runServices = config.runServices === undefined ? undefined : (stringList(config.runServices) ?? []);
    const compose: LoadedCompose = {
      project,
      service,
      ...(runServices !== undefined ? { runServices } : {}),
      output,
      ...(engineApiVersion !== undefined ? { engineApiVersion } : {}),
      raw: parseJsonc<Record<string, unknown>>(files.configText),
      mounts: [config.mounts],
      hostAccessChecks: ctx.hostAccessChecks,
      inputsHash: composeInputsHash(files.configText, output.inputsHash, output.dockerfiles),
    };
    const { report: composeReport, references } = await this.composeReport(ctx, compose, config);
    if (isRefused(composeReport)) {
      this.logger.warn(`The Docker Compose configuration ${configPath} of ${env.repository} is refused by the host access policy: ${describeRefusal(composeReport)}`);
      throw new HostAccessError(composeReport);
    }
    // Review round 4 (P4-2): devcontainer.json itself before the paths that do not exist, so that a configuration that
    // the policy refuses (for example privileged mode) never counts as a plain error of the configuration, after which the
    // existing environment would start. The merged configuration follows below (it needs the read with our build model).
    // Review round 15 (K1, K2): `mounts` also as the Dev Container CLI writes them into its compose file (composeMounts).
    const ownReport = await this.check(ctx, 'configuration', await this.hostAccessInput(env, { config: withoutComposeIgnored(config), composeMounts: true }), ctx.hostAccessChecks);
    if (isRefused(ownReport)) {
      this.logger.warn(`The configuration ${configPath} of ${env.repository} is refused by the host access policy: ${describeRefusal(ownReport)}`);
      throw new HostAccessError(ownReport);
    }
    // Review round 3 (P3-1): a build context or Dockerfile that does not exist in the repository is an error of the
    // configuration, not a refusal: the existing environment still starts (runPipeline), and nothing is built.
    const missing = composeMissingBuildPaths({ model: output.model, missing: output.missing, repositoryFolder: repositoryFolder(env.repository) });
    if (missing.length > 0) {
      this.logger.warn(`The Docker Compose configuration ${configPath} of ${env.repository} names paths that do not exist: ${listSome(missing, 200, '; ')}`);
      throw new UserFacingError('buildFailed', Messages.buildFileMissing(listSome(missing, undefined, '; ')));
    }
    const ignored = composeIgnoredProperties(config);
    if (ignored.length > 0) {
      this.logger.info(`The Dev Container CLI ignores ${ignored.join(', ')} of ${configPath} for Docker Compose. They are not used and not checked.`);
    }
    await this.requireVolume(env);
    const read = await helper.readConfiguration({
      volumeName: env.volumeName,
      repository: env.repository,
      configPath,
      environmentId: env.id,
      override: composeConfigOverride(compose.raw, COMPOSE_MODEL_PATH),
      files: composeBuildFiles(composeBuildModel(output.model, this.composeParams(env, compose, []))),
      env: { COMPOSE_PROJECT_NAME: project },
      onOutput: this.output,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    const merged = read.merged;
    const checked = await this.hostAccessInput(env, {
      config: withoutComposeIgnored(config),
      ...(merged !== undefined ? { merged: withoutComposeIgnored(merged) } : {}),
      composeMounts: true,
    });
    const report = await this.check(ctx, 'configuration', checked, ctx.hostAccessChecks);
    if (isRefused(report)) {
      this.logger.warn(`The configuration ${configPath} of ${env.repository} is refused by the host access policy: ${describeRefusal(report)}`);
      throw new HostAccessError(report);
    }
    if (merged === undefined) {
      this.logger.info('The merged configuration is not known: the image metadata is checked before the container starts.');
    }
    compose.mounts = [config.mounts, merged?.mounts];
    this.warnAboutConfiguration(configPath, files, p.problems);
    const volumes = composeVolumeNames(output.model, project).map((volume) => volume.name);
    return {
      configPath,
      fallback: p.fallback,
      configHash: composeConfigHash(files.configText, output.model, output.dockerfiles),
      config,
      references,
      mountedVolumes: [...new Set([...volumes, ...this.composeMountVolumes(env, compose, compose.mounts).names])],
      compose,
    };
  }

  /**
   * The container policy for the merged model of a Docker Compose configuration and the settings of devcontainer.json
   * that Compose does not support (checkContainer `composeModel`), with the labels of its named volumes now and the
   * volumes of the environments of other accounts (hostAccessInput), and the image references that Docker resolves by
   * the ID of an image (imageIdItems, cappedReport). With the switch of the check (LoadedCompose.hostAccessChecks).
   */
  private async composeReport(
    ctx: PipelineContext,
    compose: LoadedCompose,
    config: DevcontainerConfig,
  ): Promise<{ report: HostAccessReport; references: ConfigReferences }> {
    const env = ctx.env;
    const names = composeVolumeNames(compose.output.model, compose.project).map((volume) => volume.name);
    const volumes = await this.hostAccessInput(env, {}, names, composeNetworkReferences(compose.output.model, compose.project));
    // Review round 8: in the worker (ConfigurationAnalyzer), with the image references of the model.
    const analysis = await this.analyze(ctx, {
      kind: 'compose',
      checksOn: compose.hostAccessChecks === 'on',
      features: config.features,
      input: {
      ownVolume: volumes.ownVolume,
      foreignVolumes: volumes.foreignVolumes,
      volumeLabels: volumes.volumeLabels,
      environment: volumes.environment,
      ...(volumes.networks !== undefined ? { networks: volumes.networks } : {}),
      dockerfiles: compose.output.dockerfiles,
      model: compose.output.model,
      devService: compose.service,
      runServices: config.runServices,
      project: compose.project,
      repositoryFolder: repositoryFolder(env.repository),
      engineApiVersion: compose.engineApiVersion,
      realPaths: compose.output.realPaths,
      ...(compose.output.mountAncestors !== undefined ? { mountAncestors: compose.output.mountAncestors } : {}),
      ...(compose.output.missing !== undefined ? { missing: compose.output.missing } : {}),
      },
    });
    // Review round 2 (S2-05): a reference that Docker takes for the ID of a local image.
    // Review round 9 (S9-3): only when the configuration is not refused already.
    const items = isRefused(analysis.report) ? { hostAccess: [], unsupported: [] } : await this.imageIdItems(env, analysis.imageReferences, ctx.signal);
    return { report: cappedReport(analysis.report, items.unsupported, items.hostAccess), references: analysis.references };
  }

  /**
   * Review round 8: a job of the host access analysis (AnalysisJob) with the analyzer of the deps, which runs it in a
   * worker thread with limits of time and memory; a failed job resolves a refusal (ANALYSIS_FAILED_ITEM).
   */
  private async analyze<J extends AnalysisJob>(ctx: PipelineContext, job: J): Promise<AnalysisResult<J>> {
    this.throwIfCancelled(ctx.signal);
    const result = await waitUnlessAborted(this.deps.analyzer.analyze(job), ctx.signal);
    this.throwIfCancelled(ctx.signal);
    // Review round 9 (P9-1, P9-2): a failed analysis is an error of its own (still a refusal: never allowed).
    const failure = (result as { failure?: AnalysisFailure }).failure;
    if (failure !== undefined) {
      this.logger.warn(`The host access analysis of the configuration of ${ctx.env.repository} failed (${failure.kind}: ${failure.reason}).`);
      throw new AnalysisFailedError(failure);
    }
    return result;
  }

  /** checkContainer of the container policy at `stage`, with the switch `checks`, in the analyzer (analyze). */
  private async check(ctx: PipelineContext, stage: Exclude<CheckStage, 'composeModel'>, input: HostAccessInput, checks: HostAccessChecks): Promise<HostAccessReport> {
    return (await this.analyze(ctx, { kind: 'hostAccess', stage, input, checksOn: checks === 'on' })).report;
  }

  /**
   * Review round 2 (S2-05): the items (imageIdItem, not supported) of the references that name a local image by its ID
   * or a prefix of it, not by its name: Docker resolves such a reference (for example `a1b2c3d4`) to any local image,
   * also one of another environment. A reference whose image does not exist locally is left (the pull or the build
   * fails, or it is pulled by its name). Review round 10 (P10-1): a reference that Docker cannot inspect for another
   * reason is refused too (imageUncheckedItem).
   * Review round 11 (G1, G2): a reference that is not valid in Docker's grammar is refused before any inspect
   * (imageInvalidReferenceItem). Only a definitive answer of Docker about a reference (`invalid`) is an item of the
   * configuration (remembered when it refuses an update); when Docker could not answer (`transient`: a timeout, a daemon
   * that cannot be reached, an unknown error), the check failed: AnalysisFailedError of kind `internal` (P9-1: still no
   * new or changed configuration is used, an existing environment starts, and a refused update is not remembered).
   * Review round 13 (P13-1): a failure of Docker never hides a definitive refusal: grammar-invalid references are returned
   * before any inspect, and the items of `invalid` answers (and image IDs) are returned also when other references are
   * transient (which are logged, never turned into items); AnalysisFailedError only when there is no definitive item.
   * User decision 2026-09-28: `hostAccess` (protected), the references whose image is an image of the environments of
   * another account on the Docker host of `env` and of none of its own account (otherAccountImageItems, by the image ID;
   * hostEnvironmentImageIds); no longer a rule on the name `devenv-…`.
   */
  private async imageIdItems(
    env: Environment,
    references: readonly NamedImageReference[],
    signal?: AbortSignal,
  ): Promise<{ unsupported: string[]; hostAccess: string[] }> {
    const { named, invalid } = imageReferencesToInspect(references);
    // Review round 13 (P13-1): the configuration is refused for them anyway (like the isRefused short-circuit of the
    // callers): no inspect, so that no failure of Docker for another reference hides the refusal.
    // Review round 17 (P17-3): at most MAX_LISTED_ITEMS items, each at most MAX_ITEM_LENGTH characters (capped).
    if (invalid.length > 0) {
      this.logger.warn(`Image references that are not valid: ${capped(invalid).join(', ')}.`);
      return { unsupported: capped(invalid), hostAccess: [] };
    }
    const distinct = [...new Set(named.map((entry) => entry.reference))];
    if (distinct.length === 0) return { unsupported: [], hostAccess: [] };
    // Review round 9 (S9-3): one `docker image inspect` for (up to IMAGE_INSPECT_BATCH of) them, not one per reference.
    if (distinct.length > MAX_IMAGE_ID_REFERENCES) throw tooLargeError(`${distinct.length} image references (at most ${MAX_IMAGE_ID_REFERENCES})`);
    this.throwIfCancelled(signal);
    // Review round 10 (P10-1): a reference that Docker cannot inspect (for another reason than a missing image) is
    // refused as not checked, never left: one invalid reference no longer leaves the others of its batch unchecked
    // (inspectImageNames inspects them one by one). Review round 11 (G1, G2): inspectImageNames throws only when
    // cancelled; the catch is for a Docker port that throws anyway.
    const { images, unchecked } = await this.deps.docker.inspectImageNames(distinct, signal).catch((error: unknown) => {
      if (this.isCancellation(error, signal)) {
        this.throwIfCancelled(signal);
        throw error;
      }
      this.logger.warn(`The local images of the image references could not be read: ${errorMessage(error)}`);
      return { images: [], unchecked: distinct.map((reference) => ({ reference, reason: 'transient' as const })) };
    });
    this.throwIfCancelled(signal);
    const { items, transient, notChecked } = inspectedImageItems(named, images, unchecked);
    if (notChecked.length > 0) this.logger.warn(`Docker could not inspect the image references ${capped(notChecked).join(', ')}.`);
    // User decision 2026-09-28: the images of the environments of other accounts, by their IDs; only when a reference
    // found a local image (another one is pulled by its name, or the build fails), or (review round 3, S1) names no
    // local image under the name of an environment image. `undefined`: Docker could not say. Review round 4 (T1, T2):
    // missing only by a definitive answer of Docker; a reference that it could not inspect is not decided by its name.
    const unanswered = new Set(unchecked.map((entry) => entry.reference));
    const missing = new Set(
      named.filter((entry) => !unanswered.has(entry.reference) && imageNamedBy(entry.reference, images) === undefined).map((entry) => entry.reference),
    );
    const missingShortIds = [...missing].map(environmentImageShortId).filter((short): short is string => short !== undefined);
    const read =
      images.length > 0 || missingShortIds.length > 0
        ? await this.hostEnvironmentImageIds(env, images, missingShortIds, signal)
        : { ids: { own: new Set<string>(), others: new Set<string>() } };
    const ids = read.ids;
    const foreign = ids === undefined ? [] : otherAccountImageItems(named, images, ids, missing);
    if (foreign.length > 0) this.logger.warn(`Image references of ${env.repository} name images of environments of another GitHub account: ${capped(foreign).join(', ')}.`);
    if (transient.length > 0 || ids === undefined) {
      const shown =
        transient.length > 0
          ? transient.slice(0, 5).map((reference) => truncated(reference, MAX_ITEM_LENGTH)).join(', ') + (transient.length > 5 ? ` and ${transient.length - 5} more` : '')
          : (read.unread ?? ENVIRONMENT_IMAGES_UNREAD);
      // Review round 13 (P13-1): a definitive refusal is not hidden by a failure of Docker for another reference: the
      // configuration is refused for it anyway (and an update refused for it is remembered); the failure is logged. A
      // refusal as an image of another account is definitive only with the images of the environments read (`ids`).
      if (items.length > 0 || foreign.length > 0) {
        this.logger.warn(`Docker could not check the image references ${shown}; the configuration is refused for the others.`);
        return { unsupported: capped(items), hostAccess: capped(foreign) };
      }
      // Review round 12 (P12-1): a text of its own (dockerCheckItem), not the one of an analysis that could not run.
      throw new AnalysisFailedError({ kind: 'internal', docker: true, reason: shown });
    }
    return { unsupported: capped(items), hostAccess: capped(foreign) };
  }

  /**
   * User decision 2026-09-28: the IDs of the images of the environments on the Docker host of `env`
   * (EnvironmentImageIds, environmentImageIds): the images that Docker lists as `devenv-<short id>:<build>` and
   * `devenv-<short id>-<service>`, whichever computer built them (so also an older build that is still there, a new one
   * before its build record, and one that a Delete could not remove), split by the owner account of the short ID: the
   * registry entries on the host (and `env` itself), else the owner label of the volumes of that environment on the
   * host (one `docker volume ls`, only when an image that a reference found, `found`, or a reference without a local
   * image, `missingShortIds`, has a short ID that the registry does not know: an environment that another computer
   * created on a shared host, or an image left behind). An image of no known owner, or of volumes with different owner
   * labels, counts as another account's. One `docker image ls` on each check whose references found a local image or
   * name an environment image that Docker found missing. `unread`: Docker could not answer (the reason of dockerCheckItem;
   * the caller fails the check, as for a reference: AnalysisFailedError); a cancellation is thrown.
   */
  private async hostEnvironmentImageIds(
    env: Environment,
    found: readonly InspectedImage[],
    missingShortIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ ids?: EnvironmentImageIds; unread?: string }> {
    const unread = (what: string, reason: string, error: unknown): { unread: string } => {
      if (this.isCancellation(error, signal)) {
        this.throwIfCancelled(signal);
        throw error;
      }
      this.logger.warn(`The ${what} on the Docker host could not be read: ${errorMessage(error)}`);
      return { unread: reason };
    };
    this.throwIfCancelled(signal);
    let images: Awaited<ReturnType<ContainerAdapter['listEnvironmentImages']>>;
    try {
      images = await this.deps.docker.listEnvironmentImages(signal);
    } catch (error) {
      return unread('images of the environments', ENVIRONMENT_IMAGES_UNREAD, error);
    }
    this.throwIfCancelled(signal);
    const owners = new Map<string, string>();
    for (const entry of environmentsOfHost(await this.deps.registry.list(), dockerHostOf(env))) owners.set(shortId(entry.id).toLowerCase(), entry.owner.id);
    owners.set(shortId(env.id).toLowerCase(), env.owner.id);
    const foundIds = new Set(found.map((image) => image.id.toLowerCase()));
    if (unknownEnvironmentShortIds(images, owners, foundIds).length > 0 || missingShortIds.some((short) => !owners.has(short))) {
      let volumes: VolumeInfo[];
      try {
        volumes = await this.deps.docker.listEnvironmentVolumes(signal);
      } catch (error) {
        return unread('volumes of the environments', ENVIRONMENT_OWNERS_UNREAD, error);
      }
      this.throwIfCancelled(signal);
      for (const [short, owner] of volumeOwners(volumes)) if (!owners.has(short)) owners.set(short, owner);
    }
    return { ids: environmentImageIds(images, owners, env.owner.id) };
  }

  /**
   * Review round 17 (D17-1): the named volumes of the `mounts` values `mounts` of a Docker Compose configuration
   * (composeMountVolumes), substituted as the Dev Container CLI substitutes them at `up`: the variables of the workspace
   * helper (helperCliVariables, as the host access policy resolves them) and the real `${devcontainerId}` of the
   * environment (environmentDevcontainerId), so that our model declares, and the pipeline creates with the labels of
   * the environment, the volumes that the CLI writes. A source that is still no key of a Compose volume is logged and
   * left to the CLI.
   */
  private composeMountVolumes(env: Environment, compose: LoadedCompose, mounts: readonly unknown[]): { names: string[]; sources: string[] } {
    // Review round 18 (D18-1): with COMPOSE_PROJECT_NAME, which the pipeline passes to the CLI runs of Docker Compose.
    const variables = { ...helperCliVariables(env.repository, { COMPOSE_PROJECT_NAME: compose.project }), devcontainerId: environmentDevcontainerId(env.id) };
    const { names, sources, skipped } = composeMountVolumes(compose.project, mounts, variables);
    if (skipped.length > 0) {
      this.logger.info(
        `Volumes of mounts of ${env.repository} whose names are not known before the start (${listSome(skipped.map((source) => JSON.stringify(truncated(source, MAX_ITEM_LENGTH))), 20, ', ')}) are left to the Dev Container CLI: they are not declared in the Docker Compose model and not created with the labels of the environment.`,
      );
    }
    return { names, sources };
  }

  /** What composeBuildModel and composeUpModel need to know about the environment. */
  private composeParams(env: Environment, compose: LoadedCompose, mountVolumeSources: readonly string[]): ComposeRewriteParams {
    return {
      project: compose.project,
      devService: compose.service,
      environmentId: env.id,
      containerName: env.containerName,
      volumeName: env.volumeName,
      repositoryFolder: repositoryFolder(env.repository),
      // Review round 20 (P20-1): the checked Dockerfile of the dev service, which the build writes.
      dockerfiles: compose.output.dockerfiles,
      ...(compose.engineApiVersion !== undefined ? { engineApiVersion: compose.engineApiVersion } : {}),
      realPaths: compose.output.realPaths,
      ...(compose.output.mountAncestors !== undefined ? { mountAncestors: compose.output.mountAncestors } : {}),
      // Review round 10 (D10-2).
      ...(compose.output.mountCreateTargets !== undefined ? { mountCreateTargets: compose.output.mountCreateTargets } : {}),
      mountVolumeSources,
      hostAccessChecks: compose.hostAccessChecks,
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
    image?: HelperImageUse,
  ): Promise<{ configPath: string; files: ConfigFiles; fallback: boolean } | undefined> {
    const { helper } = this.deps;
    await this.requireVolume(env);
    const files = await helper.readConfigFiles({ volumeName: env.volumeName, repository: env.repository, configPath, image, signal });
    if (files) return { configPath, files: this.limitedConfigFiles(env, configPath, files), fallback: false };
    await this.requireVolume(env);
    const available = await helper.listConfigurations({ volumeName: env.volumeName, repository: env.repository, image, signal });
    if (available.length === 0) return undefined;
    const fallback = available[0];
    await this.requireVolume(env);
    const fallbackFiles = await helper.readConfigFiles({ volumeName: env.volumeName, repository: env.repository, configPath: fallback, image, signal });
    return fallbackFiles ? { configPath: fallback, files: this.limitedConfigFiles(env, fallback, fallbackFiles), fallback: true } : undefined;
  }

  /**
   * Review round 9 (S9-1): a devcontainer.json longer than MAX_CONFIG_TEXT_LENGTH (READ_FILES_SCRIPT reads at most one
   * character more) is refused as too large, before this thread parses or searches it.
   */
  private limitedConfigFiles(env: Environment, configPath: string, files: ConfigFiles): ConfigFiles {
    if (files.configText.length <= MAX_CONFIG_TEXT_LENGTH) return files;
    const reason = `the configuration ${configPath} is longer than ${MAX_CONFIG_TEXT_LENGTH} characters`;
    this.logger.warn(`The configuration ${configPath} of ${env.repository} is too large to check: ${reason}.`);
    throw tooLargeError(reason);
  }

  /**
   * Stores what the registry needs from the configuration: path, shutdownAction, additional volumes.
   * The path is the selection of the user (FR-03, concept 7.5): a fallback on a branch without the selected configuration
   * does not replace it, so the selection applies again on a branch that has it. The build record keeps what was built.
   * Without a build record (first open, entry restored from a volume), nothing was selected and built yet: the fallback
   * is stored.
   */
  private async saveConfiguration(ctx: PipelineContext, loaded: LoadedConfiguration, record: BuildRecord | undefined): Promise<void> {
    // Only the volumes whose labels make them the environment's own or an additional volume of the same owner
    // (recordedVolumes); the others are never recorded.
    const additionalVolumes = await this.recordedVolumes(loaded.mountedVolumes, ctx.env);
    const configPath = loaded.fallback && record !== undefined ? ctx.configPath : loaded.configPath;
    await this.updateEntry(ctx, (entry) => {
      entry.configPath = configPath;
      entry.shutdownActionNone = loaded.config.shutdownAction === 'none';
      // Volumes recorded before stay: the pipeline adds those that it creates before `up` (createAdditionalVolumes), and
      // a volume that the environment used may still hold its data.
      const recorded = entry.additionalVolumes ?? [];
      const added = additionalVolumes.filter((name) => !recorded.includes(name));
      if (added.length > 0) entry.additionalVolumes = [...recorded, ...added];
      // Review round 1 (D1): the volumes of the other services of Docker Compose, for the question of Delete (kept once
      // recorded: a volume that a service used holds its data).
      if (loaded.compose) {
        const services = entry.serviceVolumes ?? [];
        const used = composeServiceVolumeNames(loaded.compose.output.model, loaded.compose.project, loaded.compose.service).filter((name) => !services.includes(name));
        if (used.length > 0) entry.serviceVolumes = [...services, ...used];
      }
      // A refused update of another configuration is not tried again anyway.
      const refused = refusedUpdateOf(entry);
      if ('refusedUpdate' in entry && (refused?.configPath !== loaded.configPath || refused.configHash !== loaded.configHash)) {
        delete entry.refusedUpdate;
      }
    });
  }

  /**
   * Whether the configuration hash differs from the build record. Docker Compose (review round 1, P-4): with
   * composeConfigurationChange; when only the version of the Compose plugin (and with it the printed model) changed,
   * the record takes the new model hash and version without a question.
   */
  private async configHashChanged(ctx: PipelineContext, record: BuildRecord, loaded: LoadedConfiguration): Promise<boolean> {
    if (!loaded.compose) return record.configHash !== loaded.configHash;
    const current = { configHash: loaded.configHash, inputsHash: loaded.compose.inputsHash, version: loaded.compose.output.version };
    const change = composeConfigurationChange(record, current);
    if (change !== 'rebaseline') return change === 'changed';
    this.logger.info(
      `The Docker Compose plugin of the workspace helper is now ${current.version} and prints the unchanged files of ${ctx.env.repository} as another model. That is no change of the configuration.`,
    );
    await this.updateEntry(ctx, (entry) => {
      const compose = composeRecordOf(entry.buildRecord);
      if (!entry.buildRecord || !compose || entry.buildRecord.environmentImage !== record.environmentImage) return;
      entry.buildRecord.configHash = current.configHash;
      entry.buildRecord.compose = { ...compose, version: current.version };
    });
    return false;
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
    const changed = record !== undefined && (record.configPath !== loaded.configPath || (await this.configHashChanged(ctx, record, loaded)));
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
    // Before a refused update counts as up to date below. The user saw the warning at the refusal
    // (rememberRefusedUpdate); the later opens of the same refused update only log it (user report 2026-09-27: the
    // warning at every open).
    const newerImages = check.kind === 'checked' && !check.upToDate;
    const refused = refusedUpdateOf(ctx.env);
    const refusedAgain =
      !forced &&
      record !== undefined &&
      imagePresent &&
      check.kind === 'checked' &&
      !check.upToDate &&
      isRefusedUpdate(refused, this.updateKey(ctx, loaded, record, check.outcome));
    if (refusedAgain && refused && check.kind === 'checked') {
      this.logger.info(
        refused.reason === 'size'
          ? `The update of ${ctx.env.repository} is too large or too complex to check (${refused.items}). The existing environment is used.`
          : `The update of ${ctx.env.repository} was refused by the host access policy (${refused.items}). The existing environment is used.`,
      );
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
              ? refused?.reason === 'size'
                ? 'the newer image is too large or too complex to check'
                : 'the newer image needs access to the computer'
              : 'up to date';
    this.logger.info(`Decision for ${ctx.env.repository}: ${build ? 'build a new environment image' : 'no build'} (${reason}).`);
    return { check, build, forced, updateAvailable, current: !changed && !newerImages && !forced };
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
  private updateKey(
    ctx: PipelineContext,
    loaded: LoadedConfiguration,
    record: BuildRecord | undefined,
    outcome: CheckedOutcome,
  ): Omit<RefusedUpdate, 'items'> {
    return {
      configPath: loaded.configPath,
      configHash: loaded.configHash,
      images: recordDigests(loaded.references.images, outcome.images, record?.images),
      features: recordDigests(loaded.references.features, outcome.features, record?.features),
      // The switch of the host access checks is part of the update: a refusal with one state does not block the other.
      ...(ctx.hostAccessChecks === 'off' ? { hostAccessChecks: 'off' as const } : {}),
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
      (containerIsCurrent(container.labels, true, ctx.hostAccessChecks) ||
        (await this.deps.docker.imageExists(container.image).catch(() => false)));
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
        ...(loaded.compose ? this.composeBuildOptions(env, loaded.compose) : {}),
        onOutput: this.output,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
      // User decision 2026-09-28: the container is made only from an image that the engine has (a build that ended
      // without its image, for example on a remote host whose connection broke at the end, is a failed build).
      // Review round 1 (F6): when the check itself fails, the built image is removed like after any later failure.
      const present = await this.deps.docker.imageExists(imageName).catch(async (error: unknown) => {
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        throw error;
      });
      if (!present) throw new Error(`The environment image ${imageName} is missing after the build.`);
    } catch (error) {
      // Review round 3 of PR #64 (P6a): the helper image of the open is gone; no "started instead" and no buildFailed.
      if (isHelperFailed(error)) return this.helperFailedInUpdate(ctx, error);
      return this.updateFailed(ctx, error, canFallBack, plan.check);
    }

    // Concept 7.7 step 3: replace the container, with the same workspace volume.
    ctx.steps.step('starting');
    // A newer image names the replacement already (Messages.newerImage); otherwise the user learns it here.
    if (container !== undefined && !containerIsCurrent(container.labels, true, ctx.hostAccessChecks) && !plan.updateAvailable) {
      this.announceRecreation(ctx, container);
    }
    let result: DevcontainerResult;
    try {
      result = await this.runUp(ctx, imageName, loaded.config, container !== undefined, true, loaded.compose);
    } catch (error) {
      if (error instanceof AnalysisFailedError) {
        // Review round 9 (P9-1): the check of the new image failed (for example a worker that ran out of time on a busy
        // computer): no refusal of the policy, so the update is not remembered as refused; the next open tries again.
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        if (!canFallBack) throw error;
        // Review round 10 (P10-3): a size limit fails the same update the same way at every open: remembered, with its
        // own text, like a refused update (a changed digest or configuration, or a rebuild, tries again). A time or
        // memory limit and an internal failure stay not remembered (P9-1).
        if (error.failure.kind === 'size') {
          await this.rememberRefusedUpdate(ctx, loaded, record, plan.check, error, 'size');
          return undefined;
        }
        this.logger.warn(`The new environment image of ${env.repository} could not be checked. The existing environment is started; the next open tries the update again.`);
        this.deps.ui.warn(Messages.updateCheckFailed(error.item));
        return undefined;
      }
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
      // Review round 4 of PR #64 (R4-5): the helper image of the open is gone; the new image is not the cause.
      const helperFailed = isHelperFailed(error);
      if (helperFailed) ctx.helperUnavailable = true;
      else this.logger.error(`The container of ${env.repository} could not be created from ${imageName}.`, error);
      // Review round 2 (D2-4): the build switched the kind of the environment (Docker Compose or a single container). The
      // previous kind is not started from here: its image is not an image of the new kind, and the configuration is of
      // the new kind. The next build tries again.
      // Review round 4 of PR #68 (A-R4-2): as existingCompose.
      const previousCompose = this.existingCompose(ctx, record);
      // Review round 11 of PR #64 (R11-1): a helperFailed before the switch removed or moved a container (and before `up`
      // ran, R12-2) ends the open without the detail of a switch (helperFailedInUpdate; user decision 2026-09-29: never
      // opened as it is).
      if (helperFailed && (ctx.kindSwitchRemoved ?? []).length === 0 && ctx.devServiceMoved !== true && ctx.upStarted !== true) {
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        return this.helperFailedInUpdate(ctx, error);
      }
      if ((record !== undefined || container !== undefined) && previousCompose !== (loaded.compose !== undefined)) {
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        // Review round 3 (D3-1, P3-3): the containers that the failed `up` of Docker Compose created (for example of a
        // database) go, so that no later `up` of a single container takes one of them for its dev container (they carry
        // the ID label). Their volumes stay. Review round 4 (D4-1): only when the single container was removed in this
        // run, and only those that did not exist before `up` (an earlier switch that was cancelled may have created
        // containers that the user worked with since).
        const failed = loaded.compose !== undefined ? await this.removeFailedComposeContainers(ctx) : { removed: [], kept: [], removedIds: [] };
        // Review round 2 of PR #68 (A-R2-4): `up` returned, and the lifecycle commands of its container could not run: runUp
        // or runComposeUp removed (or stopped) that container already (withdrawAfterHelperFailed), and the detail says so.
        let withdrawn = helperFailed ? ctx.upWithdrawn : undefined;
        let removedAgain = failed.removed;
        // Review round 3 of PR #68 (A-R3-1): removeFailedComposeContainers removed the dev container that
        // withdrawAfterHelperFailed only stopped (or kept): it was removed, and it is not named again among the others.
        const index = withdrawn !== undefined ? failed.removedIds.findIndex((id) => sameContainer(id, withdrawn!.id)) : -1;
        if (withdrawn !== undefined && index >= 0) {
          await this.clearLifecycleMark(ctx, withdrawn.id);
          withdrawn = { outcome: 'removed', id: withdrawn.id, created: withdrawn.created, name: withdrawn.name };
          removedAgain = failed.removed.filter((_, other) => other !== index);
        }
        const detail = kindSwitchFailure(
          loaded.compose !== undefined,
          ctx.kindSwitchRemoved ?? [],
          helperFailed ? causeOf(error) : errorDetail(error),
          removedAgain,
          failed.kept,
          withdrawn !== undefined ? withdrawnOutcome(withdrawn, true) : undefined,
          // Review round 3 of PR #68 (A-R3-2): runUp ran with --remove-existing-container only when there was a container.
          container !== undefined,
          // Review round 4 of PR #68 (A-R4-4): "created or started" when the listing before `up` failed.
          withdrawn !== undefined ? createdOrStarted(withdrawn) : undefined,
          // Review round 5 of PR #68 (A-R5-2): a (dev) container that ran before `up` "runs already".
          withdrawn?.ranBefore === true,
        );
        // Review round 4 of PR #64 (R4-5): the cleanup of the switch above stays (the containers of the other kind are
        // gone, so nothing opens as it is), but the open ends with helperFailed, with the detail of the switch.
        if (helperFailed) {
          this.logger.error(`The workspace helper is not available for ${env.repository}. The switch of its configuration could not be completed.`, error);
          throw new UserFacingError('helperFailed', Messages.helperFailed, detail);
        }
        throw new UserFacingError('startFailed', PipelineTexts.startFailed, detail);
      }
      // Final review (FF-1): the build switched the dev service of the Docker Compose project (Select configuration…
      // between two configurations of one compose file, D22-1). The previous dev container was renamed out of the way
      // and stopped (movePreviousDevContainer); an `up` with the new configuration would take it for another service
      // (and Compose would create it again, losing its files outside the volumes). It stays as it is, stopped: the
      // previous configuration stays selected (open), so the next open starts it again. The next build tries again.
      // Review round 5 of PR #68 (A-R5-3): the guard follows what happened in this run (movePreviousDevContainer moved the
      // previous dev container), with the service from its label; the build record only adds to it, read by its key (an
      // older record that composeRecordOf rejects, or none, must not skip the guard: the restore would run `up` with the
      // new configuration next to the renamed previous dev container, whose files outside the volumes would be lost).
      const moved = ctx.devServiceMoved === true || ctx.previousDevContainer !== undefined;
      const previousService = ctx.previousDevContainer?.service ?? ctx.devServiceMovedFrom ?? recordedComposeService(record);
      if (
        loaded.compose !== undefined &&
        previousService !== undefined &&
        (moved || previousService !== loaded.compose.service)
      ) {
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        if (ctx.previousDevContainer?.removed !== true) {
          this.logger.info(`The previous dev container of the service ${previousService} of ${env.repository} is kept, stopped; it is not started with the configuration of the service ${loaded.compose.service}.`);
        }
        // Review round 4 of PR #64 (R4-5): the helper image of the open is gone: helperFailed, with the detail of the switch.
        if (helperFailed) {
          this.logger.error(`The workspace helper is not available for ${env.repository}. The switch of its dev service could not be completed.`, error);
          // Review round 2 of PR #68 (A-R2-3): after `up` returned, the dev container of the new service (its lifecycle
          // commands did not run) was removed already (withdrawAfterHelperFailed); the detail says what happened to it and
          // to the previous dev container.
          const change = `The dev service changed from ${previousService} to ${loaded.compose.service}.`;
          const previous = await this.previousDevContainerAfterFailedSwitch(ctx, previousService);
          const withdrawn = ctx.upWithdrawn;
          throw new UserFacingError(
            'helperFailed',
            Messages.helperFailed,
            withdrawn !== undefined
              ? // Review round 5 of PR #68 (A-R5-2): afterUpClause, "runs already" for a container that ran before `up`.
                `${change} ${afterUpClause(`The dev container of the service ${loaded.compose.service}`, withdrawn)} ${withdrawnOutcome(withdrawn, true)} ${previous} The previous configuration stays selected. ${causeOf(error)}`
              : `${change} ${previous} ${causeOf(error)}`,
          );
        }
        throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(error));
      }
      // Review round 3 of PR #64 (P6b): the helper image of the open is gone, so the old environment image cannot be
      // started either (that needs the helper too): no buildFailed warning and no restore; the open ends with helperFailed
      // (not startFailed; user decision 2026-09-29: a running container is not opened as it is).
      if (helperFailed) {
        // Review round 1 of PR #68 (A-R1-1), round 2 (A-R2-2): `up` returned (the R11-1 branch above takes the rest), and the
        // lifecycle commands of its container did not run. runUp or runComposeUp removed that container already
        // (withdrawAfterHelperFailed; stopped when the removal failed), so that the next open creates (or starts) it again
        // with all lifecycle commands, instead of opening it as it is. Then the new image can be removed, too.
        const withdrawn = ctx.upWithdrawn;
        await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
        return this.helperFailedInUpdate(ctx, error, withdrawn !== undefined ? this.updateWithdrawnDetail(ctx, withdrawn, container, error) : undefined);
      }
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
      const survivor = await this.deps.docker.findContainer(env.id, env.containerName).catch(() => undefined);
      const keep =
        survivor !== undefined && survivor.image === previousImage && containerIsCurrent(survivor.labels, true, ctx.hostAccessChecks);
      this.logger.info(
        keep
          ? `The previous container ${survivor.name} is started again.`
          : `The container is created again from the previous environment image ${previousImage}.`,
      );
      await this.quietly(`remove the image ${imageName}`, () => this.deps.docker.removeImage(imageName));
      try {
        result = await this.runUp(ctx, previousImage, loaded.config, !keep, !keep, loaded.compose);
      } catch (restoreError) {
        if (this.isCancellation(restoreError, ctx.signal) || isFilesMissing(restoreError) || isHostAccess(restoreError)) throw restoreError;
        // Review round 3 of PR #64 (P6b): the helper image of the open is gone: helperFailed, not startFailed. Review round 2
        // of PR #68 (A-R2-1): when the restore's `up` returned, its container (whose lifecycle commands did not run) was
        // removed or stopped (withdrawAfterHelperFailed), and the detail says so.
        if (isHelperFailed(restoreError)) {
          const withdrawn = ctx.upWithdrawn;
          const detail =
            withdrawn === undefined
              ? undefined
              : withdrawn.ranBefore === true
                ? // Review round 5 of PR #68 (A-R5-2): it ran before this open, so this `up` did not start it (as in Step 9,
                  // A-R4-4); the next open runs its lifecycle commands only while the mark names it.
                  withdrawn.outcome !== 'unchanged'
                  ? `The update failed. The previous container runs; its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(restoreError)}`
                  : withdrawn.marked === true
                    ? `The update failed. The previous container runs; its lifecycle commands could not run and run at the next open. ${causeOf(restoreError)}`
                    : `The update failed. The previous container runs as before this open. ${causeOf(restoreError)}`
                : keep
                  ? `The update failed, and the previous container was started again, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(restoreError)}`
                  : `The update failed, and the container was created again from the previous environment image, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(restoreError)}`;
          return this.helperFailedInUpdate(ctx, restoreError, detail);
        }
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
      ...(loaded.compose
        ? {
            compose: {
              service: loaded.compose.service,
              images: builtServiceImages(loaded.compose.output.model, loaded.compose.project, loaded.compose.service),
              serviceImages: composeServiceImageReferences(loaded.compose.output.model, loaded.compose.service),
              version: loaded.compose.output.version,
              inputsHash: loaded.compose.inputsHash,
              // Review round 10 (D10-1): the paths that other services mount are in Environment.serviceFolders.
            },
          }
        : {}),
    };
    await this.updateEntry(ctx, (entry) => {
      entry.buildRecord = newRecord;
      entry.lastBuildNumber = Math.max(entry.lastBuildNumber ?? 0, buildNumber);
      delete entry.refusedUpdate;
    });
    this.logger.info(`New environment image of ${env.repository}: ${imageName}.`);
    await this.removeEnvironmentImages(ctx.env, imageName, record, newRecord.compose?.images ?? []);
    return { result, created: true };
  }

  /**
   * `devcontainer build` of a Docker Compose configuration: our copy of devcontainer.json (`build` has no
   * `--override-config`, buildArgs), whose only compose file is the build model (composeBuildModel: the dev service
   * builds `<project>-<service>`, which the CLI tags as the environment image), and the project name of the environment.
   */
  private composeBuildOptions(env: Environment, compose: LoadedCompose): { override: Record<string, unknown>; files: HelperFiles; env: Record<string, string> } {
    const mounts = this.composeMountVolumes(env, compose, compose.mounts);
    const build = composeBuildModel(compose.output.model, this.composeParams(env, compose, mounts.sources));
    return {
      override: composeConfigOverride(compose.raw, COMPOSE_MODEL_PATH),
      files: composeBuildFiles(build),
      env: { COMPOSE_PROJECT_NAME: compose.project },
    };
  }

  /**
   * The new environment image of an update needs access to the computer (concept 7.7, section 9 "Host access"): the
   * user learns what it needs (only here: the later opens of the same update log it, planUpdate), the existing
   * environment starts, and the same update is not built again (planUpdate) until a digest or the configuration
   * changes. Only an update after an image check can be recognized again.
   */
  private async rememberRefusedUpdate(
    ctx: PipelineContext,
    loaded: LoadedConfiguration,
    record: BuildRecord | undefined,
    check: ImageCheckState,
    error: unknown,
    reason?: 'size',
  ): Promise<void> {
    // At most MAX_REFUSED_ITEMS_LENGTH characters (hotfix review 3, C3-2): the text is kept in the registry.
    const items = truncated(error instanceof HostAccessError ? error.items.join(', ') : errorMessage(error), MAX_REFUSED_ITEMS_LENGTH);
    this.logger.info(`The existing environment of ${ctx.env.repository} is started without the update. A changed digest or configuration tries it again.`);
    this.deps.ui.warn(reason === 'size' ? Messages.updateTooLarge(items) : Messages.updateRefused(items));
    if (check.kind !== 'checked') return;
    const refusedUpdate: RefusedUpdate = { ...this.updateKey(ctx, loaded, record, check.outcome), items, ...(reason !== undefined ? { reason } : {}) };
    await this.updateEntry(ctx, (entry) => {
      entry.refusedUpdate = refusedUpdate;
    });
  }

  /**
   * Review round 3 of PR #64 (P6): a helper run of Step 8 (the build, `up`, or the restore with the previous environment
   * image) failed with helperFailed: the helper image of the open is gone. User decision 2026-09-29 (a helperFailed during
   * an update fails the open): `error` ends the open, also when the container still runs; the environment is never
   * opened as it is after Step 5, and the rest of the open uses no helper. A cancellation passes through.
   */
  private helperFailedInUpdate(ctx: PipelineContext, error: unknown, detail?: string): never {
    ctx.helperUnavailable = true;
    this.throwIfCancelled(ctx.signal);
    this.logger.error(`The workspace helper is not available for ${ctx.env.repository}. The build or start of its environment could not be completed; the open ends.`, error);
    // Review round 1 of PR #68 (A-R1-1): with `detail`, the error says what happened to the container.
    if (detail !== undefined) throw new UserFacingError('helperFailed', Messages.helperFailed, detail);
    throw error;
  }

  /**
   * Review round 2 of PR #68: the detail of a helperFailed of run-user-commands after the `up` of an update or a rebuild
   * returned (P6b). On a first open, the whole new environment is removed afterwards (removeFailedFirstOpen).
   */
  private updateWithdrawnDetail(ctx: PipelineContext, withdrawn: UpWithdrawn, container: ContainerInfo | undefined, error: unknown): string {
    if (ctx.firstOpen) {
      return `The container was created, but its lifecycle commands could not run. The new environment is removed again; open the repository again to create it. ${causeOf(error)}`;
    }
    const what = container === undefined ? 'The container was created from the environment image' : 'The container was created again from the new environment image';
    return `${what}, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(error)}`;
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
      await this.pullWith(ctx, reference, credentials);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || !tolerateFailure) throw error;
      const local = await this.deps.docker.imageExists(reference).catch(() => false);
      if (!local) throw error;
      this.logger.warn(`${reference} could not be downloaded. The local image is used: ${errorMessage(error)}`);
      stale.add(reference);
    }
  }

  /**
   * `docker pull` of `reference`, with `credentials` when there are any. The adapter sends them only over a local or
   * encrypted connection to Docker (UserFacingError('unencryptedDockerConnection')); then the image is downloaded
   * without them, as Docker does with its own credentials (a public image on ghcr.io still downloads), and the GitHub
   * sign-in is never sent. When that download fails too, the error says why the sign-in was not used.
   */
  private async pullWith(ctx: PipelineContext, reference: string, credentials: PullCredentials | undefined): Promise<void> {
    const docker = this.deps.docker;
    try {
      await docker.pullImage(reference, { onOutput: this.output, signal: ctx.signal, ...(credentials ? { credentials } : {}) });
      return;
    } catch (error) {
      if (!credentials || !isUserFacingError(error) || error.code !== 'unencryptedDockerConnection') throw error;
      this.logger.warn(`${error.detail ?? error.message} ${reference} is downloaded without the GitHub sign-in.`);
      try {
        await docker.pullImage(reference, { onOutput: this.output, signal: ctx.signal });
      } catch (plainError) {
        if (this.isCancellation(plainError, ctx.signal)) throw plainError;
        throw new UserFacingError(error.code, error.message, `${error.detail ?? ''} The download without the sign-in failed: ${errorMessage(plainError)}`.trim());
      }
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
    // Concept section 9: a container of an older setup (label nimblescape.devenv.container-version) is created again
    // from its environment image, like a missing one. The volume stays. So is a container that was created without the
    // configuration (it could not be read then), once the configuration can be read: it lacks its runArgs and appPort.
    // So is a container that was created while the host access checks were off, once they are on again: it is created
    // again when the checks pass (the image metadata before `up`), and never started as it is.
    const configKnown = loaded !== undefined;
    // A Docker Compose environment: also when its configuration cannot be read now (its build record, or its container).
    const compose = loaded?.compose !== undefined || (loaded === undefined && this.isComposeEnvironment(ctx.env, record, container));
    let outdated = container !== undefined && !containerIsCurrent(container.labels, configKnown, ctx.hostAccessChecks);
    // Why a current dev container is created again all the same: the log line and the progress detail.
    let recreation: { log: string; detail: string } | undefined;
    // The container of another service that makes the environment outdated (review round 22 of PR #64, A-R22-1).
    let unrestrictedService: string | undefined;
    if (container !== undefined && !outdated && compose && ctx.hostAccessChecks === 'on') {
      // The containers of the other services follow the same rule (containerIsCurrent): one that was created while the
      // checks were off makes the environment outdated; `up` then creates the dev container again, and Compose the
      // services whose model changed (the label nimblescape.devenv.host-access is gone from it).
      const unrestricted = await this.unrestrictedServiceContainer(ctx);
      if (unrestricted) {
        outdated = true;
        unrestrictedService = unrestricted.name;
        recreation = {
          log: `The container ${unrestricted.name} was created while the host access checks were off. They are on now: the containers of ${ctx.env.repository} are created again; the files in the volumes are kept.`,
          detail: Messages.containerHostAccessChecksOn,
        };
      }
    }
    // A configuration that is no Docker Compose configuration any more for a container of Docker Compose (or the other way
    // round) does not get here: without a build, the environment keeps its kind (configurationOfKind, review round 1,
    // P-1); buildAndReplace switches it (runUp, runComposeUp).
    // Review round 3 of PR #68 (A-R3-5): a running container whose lifecycle commands did not run (the workspace helper
    // failed, and it could be neither removed nor stopped: Environment.lifecycleIncomplete) is not opened as it is: `up`
    // (without removal) and run-user-commands run for it below.
    const incomplete = this.decideOnLifecycleMark(ctx, container);
    if (container?.state === 'running' && incomplete) {
      this.logger.info(`The container ${container.name} runs, but its lifecycle commands did not run. They run now.`);
    }
    if (container?.state === 'running' && !outdated && !incomplete) {
      this.logger.info(`The container ${container.name} runs already.`);
      // Recreate offer: a running container that the remote user cannot use (for example its /etc/passwd lacks the user,
      // or a failed `up` of an earlier open left it running) is not opened as it is: the window could not attach.
      const fault = await this.runningContainerFault(ctx, container, loaded);
      if (fault !== undefined) {
        const image = await this.recreationImage(ctx, container, record, imagePresent, loaded, compose);
        if (image !== undefined) return this.offerRecreation(ctx, container, image, loaded, compose, fault);
      }
      // D-22: the Dev Container CLI does not call Compose for a running dev container, so a stopped service stays stopped.
      if (compose) await this.startStoppedServices(ctx);
      await this.quietly('record the volumes of the container', () => this.recordContainerVolumes(ctx, compose));
      await this.prepareGit(ctx);
      return { created: false, container };
    }
    ctx.steps.step('starting');
    // No docker start fallback (user decision 2026-09-29): every start runs through the Dev Container CLI (`up` and
    // run-user-commands), so postStartCommand always runs. Without the workspace helper nothing starts.
    if (ctx.helperUnavailable) throw new UserFacingError('helperFailed', Messages.helperFailed);
    if (compose && loaded === undefined) {
      // D-15: without the configuration there is no model, so no `up`, and the containers are not started (user decision
      // 2026-09-29: no start of the containers as they are).
      // Review round 1 of PR #64 (L2): a configuration that was read, but that could not be checked (for example Docker did
      // not answer for its images, review round 11, G1), is not called unreadable.
      const failure = ctx.configurationUnchecked ? 'could not be checked' : 'cannot be read';
      const reason = ctx.kindKept ? 'The configuration no longer uses Docker Compose, which applies with a rebuild' : `The Docker Compose configuration ${failure}`;
      if (!ctx.kindKept) this.logger.warn(`The Docker Compose configuration of ${ctx.env.repository} ${failure}. Its containers are not started.`);
      throw new UserFacingError(
        'startFailed',
        PipelineTexts.startFailed,
        container && outdated
          ? unrestrictedService !== undefined
            ? `${reason}, and the containers of the environment must be created again (the container ${unrestrictedService} was created while the host access checks were off), which needs the configuration.`
            : `${reason}, and the container ${container.name} must be created again (it was created while the host access checks were off, or by an older version), which needs the configuration.`
          : container && ctx.kindKept && ctx.composeContainer !== true
            ? // Review round 3 of PR #68 (A-R3-1): a single container that a failed switch from Docker Compose left over.
              `${reason}. The container ${container.name} is no container of Docker Compose; it is not started until the rebuild.`
            : container
              ? `${reason}. The containers of Docker Compose start only through the Dev Container CLI, which needs the Docker Compose configuration.`
            : `${reason}, and the environment has no container.`,
      );
    }
    // Assumption (V-10): `up` finds an existing container by --id-label and starts it without using the image of the
    // override configuration; a missing container is created from the environment image, without network access.
    let image = record && imagePresent ? record.environmentImage : container?.image;
    if (outdated && image === container?.image && image !== undefined && !(await this.deps.docker.imageExists(image).catch(() => false))) {
      image = undefined;
    }
    if (!image) throw new UserFacingError('buildFailed', Messages.buildFailed, 'There is no environment image.');
    if (outdated && container && recreation) {
      this.logger.info(recreation.log);
      ctx.steps.detail(recreation.detail);
    } else if (outdated && container) {
      this.logger.info(
        this.recreatedForHostAccess(ctx, container)
          ? `The container ${container.name} was created while the host access checks were off. They are on now: it is created again from ${image}; the files in the volume are kept.`
          : containerIsCurrent(container.labels, false, ctx.hostAccessChecks)
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
    // Review round 4 of PR #68 (A-R4-5): Step 9 holds no busy mark, so `up --remove-existing-container` of an existing
    // container needs the busy mark first, and no other window that uses the environment (when in doubt, it stays).
    if (outdated && container !== undefined) {
      await this.requireNoOtherWindow(ctx, `To start the environment, the container ${container.name} must be created again`);
    }
    try {
      const result = await this.runUp(ctx, image, loaded?.config, outdated, container === undefined || outdated, loaded?.compose);
      return { result, created: container === undefined || outdated, container: outdated ? undefined : container };
    } catch (error) {
      // Review round 4 of PR #68 (A-R4-5): another window uses the environment; nothing was changed.
      if (error instanceof OtherWindowUsesError) throw error;
      if (this.isCancellation(error, ctx.signal) || isFilesMissing(error) || isHostAccess(error)) throw error;
      // No docker start fallback (user decision 2026-09-29): a workspace helper that failed during `up` fails the open.
      // Review round 2 of PR #68: when `up` returned, the container whose lifecycle commands did not run was stopped (or
      // removed, when this `up` created it) by withdrawAfterHelperFailed, and the detail says so.
      if (isHelperFailed(error)) {
        const withdrawn = ctx.upWithdrawn;
        if (withdrawn === undefined) throw error;
        // Review round 4 of PR #68 (A-R4-4): a container that ran before `up` (for example one of the mark
        // Environment.lifecycleIncomplete) was neither created nor started by it.
        if (withdrawn.ranBefore === true) {
          const text =
            withdrawn.outcome !== 'unchanged'
              ? `The container runs, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)}`
              : withdrawn.marked === true
                ? 'The container runs; its lifecycle commands could not run and run at the next open.'
                : 'The container runs as before this open; its lifecycle commands could not run.';
          throw new UserFacingError('helperFailed', Messages.helperFailed, `${text} ${causeOf(error)}`);
        }
        const what = container === undefined ? 'The container was created' : outdated ? 'The container was created again' : 'The container was started';
        throw new UserFacingError('helperFailed', Messages.helperFailed, `${what}, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(error)}`);
      }
      this.logger.error(`The container of ${ctx.env.repository} could not be started.`, error);
      // Recreate offer: `up` or run-user-commands of the existing container failed because the container itself is
      // damaged. Never for a container that this run creates (it is created again anyway).
      if (container && !outdated && (await this.upFailedForContainer(ctx, error))) {
        // Docker Compose: the fault must be the dev container's (the other services, for example a database, are never
        // recreated): the check as the remote user in the dev container, which the failed `up` left running, must find
        // it. When the fault cannot be tied to the dev container, nothing is offered.
        const cause = compose ? await this.composeDevContainerFault(ctx, loaded) : errorDetail(error);
        const damaged = compose ? await this.deps.docker.findContainer(ctx.env.id, ctx.env.containerName).catch(() => undefined) : container;
        const recreationImage =
          cause !== undefined && damaged !== undefined ? await this.recreationImage(ctx, damaged, record, imagePresent, loaded, compose) : undefined;
        if (recreationImage !== undefined && damaged !== undefined && cause !== undefined) {
          return this.offerRecreation(ctx, damaged, recreationImage, loaded, compose, cause);
        }
      }
      throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(error));
    }
  }

  /**
   * Recreate offer (user request 2026-09-26): whether a failed `up` of an existing container (or the run-user-commands
   * after it) failed because the container itself is damaged (isContainerFault): only an error of the Dev Container CLI
   * (so the workspace helper and Docker ran), not a failed lifecycle command (the configuration's), and only while
   * Docker answers. Any other failure (Docker not running or not reachable, also on a remote host, a refusal of the
   * policy, a cancel, a missing image, the network) keeps its message.
   */
  private async upFailedForContainer(ctx: PipelineContext, error: unknown): Promise<boolean> {
    if (this.isCancellation(error, ctx.signal) || !(error instanceof DevcontainerCommandError)) return false;
    if (lifecycleHookFailure(error.result) !== undefined) return false;
    return this.isDamagedContainer(ctx, `${error.message}\n${error.stderr}\n${error.stdout}`);
  }

  /**
   * Recreate offer, Docker Compose: after a failed `up`, the fault of the dev container (runningContainerFault of the
   * dev container, when it runs), else `undefined`: a fault of another service, or one of a dev container that did not
   * start, cannot be told apart from the text of Compose.
   */
  private async composeDevContainerFault(ctx: PipelineContext, loaded: LoadedConfiguration | undefined): Promise<string | undefined> {
    const dev = await this.deps.docker.findContainer(ctx.env.id, ctx.env.containerName).catch(() => undefined);
    if (dev?.state !== 'running') {
      this.logger.info(`The dev container of ${ctx.env.repository} does not run after the failed start; the fault cannot be tied to it.`);
      return undefined;
    }
    return this.runningContainerFault(ctx, dev, loaded);
  }

  /** The text names a damaged container (isContainerFault), and Docker still answers: its engine is not the cause. */
  private async isDamagedContainer(ctx: PipelineContext, text: string): Promise<boolean> {
    if (!isContainerFault(text)) return false;
    try {
      return await this.deps.docker.isRunning(ctx.signal);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      return false;
    }
  }

  /**
   * Recreate offer: `docker exec` of a shell as the remote user in the running container (the Dev Containers extension
   * attaches as that user). The text of the failure when it names a damaged container (isDamagedContainer), otherwise
   * `undefined`, also when the remote user is not known or the check itself fails (the open goes on as before).
   */
  private async runningContainerFault(ctx: PipelineContext, container: ContainerInfo, loaded: LoadedConfiguration | undefined): Promise<string | undefined> {
    // Review round 3 (F1): the user of the container itself (its label devcontainer.metadata, by which the Dev Containers
    // extension attaches), never the user that the registry recorded (it can be of an earlier container) or that the
    // configuration names now; when the label does not tell it, there is no check, and no offer.
    const user = containerMetadataUser(container.labels, helperCliVariables(ctx.env.repository));
    if (user === undefined) this.logger.info(`The label devcontainer.metadata of ${container.name} names no user; the container is not checked.`);
    if (user === undefined || ctx.helperUnavailable) return undefined;
    let text: string;
    try {
      const result = await this.deps.docker.exec(container.id, CONTAINER_CHECK_COMMAND, { user, timeoutMs: BRANCH_EXEC_TIMEOUT_MS, signal: ctx.signal });
      if (result.exitCode === 0 || result.timedOut) return undefined;
      text = `${result.stderr}\n${result.stdout}`.trim();
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The container ${container.name} could not be checked: ${errorMessage(error)}`);
      return undefined;
    }
    return (await this.isDamagedContainer(ctx, text)) ? text : undefined;
  }

  /**
   * Recreate offer: the environment image from which a damaged `container` can be created again without a build (the
   * image of the build record, else the image of the container), when it exists. `undefined` when the container cannot
   * be created again here: without the workspace helper, while the configuration is of the other kind than the
   * environment (configurationOfKind), or for Docker Compose without its configuration (no model).
   */
  private async recreationImage(
    ctx: PipelineContext,
    container: ContainerInfo,
    record: BuildRecord | undefined,
    imagePresent: boolean,
    loaded: LoadedConfiguration | undefined,
    compose: boolean,
  ): Promise<string | undefined> {
    if (ctx.helperUnavailable || ctx.kindKept || (compose && loaded?.compose === undefined)) return undefined;
    // Docker Compose: only the dev container of the service that the configuration names is ever recreated.
    if (compose && container.labels[COMPOSE_SERVICE_LABEL] !== loaded?.compose?.service) return undefined;
    if (compose && loaded?.compose !== undefined && !(await this.composeServicesStay(ctx, loaded.compose, record))) return undefined;
    const image = record && imagePresent ? record.environmentImage : container.image;
    if (await this.deps.docker.imageExists(image).catch(() => false)) return image;
    this.logger.info(`The environment image ${image} of ${ctx.env.repository} does not exist; the container cannot be created again without a build.`);
    return undefined;
  }

  /**
   * Recreate offer, review round 2 (E1–E3): right before the `up` that creates the removed dev container again, and
   * before anything is removed, the direct check that Docker Compose leaves every other service as it is. Without its
   * dev container, the CLI runs `docker compose up` without `--no-recreate`, and Compose creates a container again when its
   * label com.docker.compose.config-hash differs from the hash of its service in the model, or its label
   * com.docker.compose.image from the ID of the image of the service now. So for each container of another service of
   * the project (not a one-off container) that the model has: the hash that the Compose of the workspace helper (the one
   * that runs `up`) computes from exactly `model` (WorkspaceHelper.composeServiceHashes) must equal its label, and the
   * local ID of the image of the service must equal its image label; and (review round 4, H1, as composeServicesStay) no
   * other service that `up` builds first (builtOtherServices). The hashes of one Compose binary cover every change
   * of the model (the host access checks, a changed configuration) and of the hash method (another Compose version); the
   * image ID covers a tag that moved (also while the question was open). A difference, a missing label, or an error:
   * startFailed (composeServicesWouldBeRecreated), and nothing is changed.
   */
  private async requireOtherServicesKept(ctx: PipelineContext, compose: LoadedCompose, model: ComposeModel): Promise<void> {
    const env = ctx.env;
    const others = (await this.composeContainers(env)).filter(
      (c) => c.labels[COMPOSE_SERVICE_LABEL] !== compose.service && c.labels[COMPOSE_ONEOFF_LABEL] !== 'True' && model.services[c.labels[COMPOSE_SERVICE_LABEL] ?? ''] !== undefined,
    );
    const problems: Array<{ name: string; why: string }> = [];
    // Review round 4 (H1): defense in depth, as composeServicesStay: services that `up` builds first.
    for (const name of builtOtherServices(model, compose.service, compose.runServices)) {
      problems.push({ name, why: 'its image is built by `up` first (build:), and a new image would make Docker Compose create its container again' });
    }
    if (others.length === 0 && problems.length === 0) return;
    let hashes: Map<string, string> | undefined;
    try {
      if (others.length > 0) hashes = await this.deps.helper.composeServiceHashes({
        volumeName: env.volumeName,
        repository: env.repository,
        model: JSON.stringify(model, null, 2),
        project: compose.project,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || isHelperFailed(error)) throw error;
      this.logger.warn(`The configuration hashes of the services of ${env.repository} could not be computed: ${errorDetail(error)}`);
    }
    for (const other of others) {
      const service = other.labels[COMPOSE_SERVICE_LABEL] ?? '';
      const expected = hashes?.get(service);
      const actual = other.labels[COMPOSE_CONFIG_HASH_LABEL];
      if (expected === undefined || actual !== expected) {
        problems.push({ name: service, why: `the container ${other.name} has the configuration hash ${actual ?? '(none)'}, the model of this start gives ${expected ?? '(not known)'}` });
        continue;
      }
      const reference = typeof model.services[service].image === 'string' ? (model.services[service].image as string) : other.image;
      const imageId = await this.deps.docker.imageId(reference).catch(() => undefined);
      if (imageId === undefined || other.labels[COMPOSE_IMAGE_LABEL] !== imageId) {
        problems.push({ name: service, why: `the container ${other.name} has the image ${other.labels[COMPOSE_IMAGE_LABEL] ?? '(none)'}, ${reference} is ${imageId ?? 'missing'} now` });
      }
    }
    if (problems.length === 0) return;
    for (const problem of problems) this.logger.warn(`Docker Compose would create the service ${problem.name} of ${env.repository} again: ${problem.why}.`);
    this.logger.info(`The dev container of ${env.repository} is not created again; nothing was changed.`);
    throw new UserFacingError('startFailed', PipelineTexts.startFailed, Messages.composeServicesWouldBeRecreated(listSome([...new Set(problems.map((p) => p.name))])));
  }

  /**
   * Review round 1 of the recreate offer (D1): after the answer and with the busy mark of this run, the container of the
   * environment (for Docker Compose its dev container) is still the damaged one (the same ID), and the image of the
   * recreation (of the build record of the current entry when it exists, else of the container) is still `image`.
   * Otherwise startFailed, and nothing is changed (the mark goes in the `finally` of the open).
   */
  private async requireUnchangedSinceQuestion(ctx: PipelineContext, damaged: ContainerInfo, image: string): Promise<void> {
    const env = ctx.env;
    const current = await this.deps.docker.findContainer(env.id, env.containerName);
    const record = env.buildRecord;
    const imagePresent = record !== undefined && (await this.deps.docker.imageExists(record.environmentImage).catch(() => false));
    const currentImage = current === undefined ? undefined : record && imagePresent ? record.environmentImage : current.image;
    if (current !== undefined && current.id === damaged.id && currentImage === image) return;
    this.logger.info(
      `The environment ${env.repository} changed while the question was open (container ${current?.name ?? 'missing'}, image ${currentImage ?? 'none'}). The container is not created again; nothing was changed.`,
    );
    throw new UserFacingError('startFailed', PipelineTexts.startFailed, Messages.containerChangedMeanwhile);
  }

  /**
   * Review round 1 of the recreate offer (D2): whether the `up` that creates the removed dev container again leaves the
   * containers of the other services as they are. Without its dev container, the Dev Container CLI runs `docker compose
   * up` without `--no-recreate` (CLI 0.89.0: `(s||e.expectExistingContainer)&&b.push("--no-recreate")`, `s` the existing
   * dev container; `--expect-existing-container` fails without it: "The expected container does not exist."), so
   * Compose recreates each other service whose configuration hash or image differs (label com.docker.compose.image).
   * So the offer needs: the model of this run is the one of the build record (modelOfContainers: no changed
   * configuration, no newer image, no build), the same Compose version as the build record, and each container of
   * another service has the image that its reference names now (com.docker.compose.image is the ID of the local
   * image). Otherwise nothing is offered, and the log says why.
   */
  private async composeServicesStay(ctx: PipelineContext, compose: LoadedCompose, record: BuildRecord | undefined): Promise<boolean> {
    const env = ctx.env;
    const refuse = (why: string): false => {
      this.logger.info(`The dev container of ${env.repository} is not offered to be created again: ${why} Docker Compose would create the other services again too.`);
      return false;
    };
    if (ctx.modelOfContainers !== true) return refuse('the configuration or the images differ from those of the last build (for example after "Rebuild later" or a failed update).');
    // Review round 3 (G2): a shared namespace or `volumes_from` of another service never passes the direct check.
    const shared = sharedNamespaceServices(compose.output.model, compose.service);
    if (shared.length > 0) return refuse(`other services share a namespace or the volumes of another service (${shared.join('; ')}).`);
    // Review round 4 (H1): without its dev container, `up` builds the other services with `build:` first.
    const built = builtOtherServices(compose.output.model, compose.service, compose.runServices);
    if (built.length > 0) return refuse(`other services build their images (${built.join(', ')}), which \`up\` builds again first; a new image would make Docker Compose create them again, and a failed build would end \`up\` after the dev container is gone.`);
    const recorded = composeRecordOf(record);
    if (recorded === undefined || recorded.version !== compose.output.version) return refuse('the version of Docker Compose differs from the one of the last build.');
    const others = (await this.composeContainers(env)).filter((c) => c.labels[COMPOSE_SERVICE_LABEL] !== compose.service);
    for (const other of others) {
      const imageId = await this.deps.docker.imageId(other.image).catch(() => undefined);
      if (imageId === undefined || other.labels[COMPOSE_IMAGE_LABEL] !== imageId) return refuse(`the container ${other.name} does not have the current image ${other.image}.`);
    }
    return true;
  }

  /**
   * Recreate offer (user request 2026-09-26): the existing container is damaged (`cause`). The modal question names what
   * is kept (the repository and all files in the volumes) and what is lost (everything else in the container; the
   * setup commands run again). Nothing is removed before the answer. Cancel: startFailed with the cause, nothing
   * changed. Recreate: like the other recreations of an existing container (a container of an older setup), from the
   * environment image, without a build: `up --remove-existing-container` (the CLI removes the container with `docker rm
   * -f`, without its volumes); for Docker Compose, runComposeUp first stops and removes only the dev container, after the
   * checks (PipelineContext.recreateDevContainer), so the other services keep running with their data. No volume is
   * removed. The busy mark keeps the Session Monitor and other
   * windows away meanwhile. No safety check of the repository: it stays in the volume. Review round 5 of PR #68 (risk 3):
   * no busy mark of Step 9 is held during the question (only the mark that requireNoOtherWindow set is cleared), and after
   * the answer, with the mark of the recreation set, the files of the other windows are read (otherWindowOf, with a fresh
   * anyContainerRuns): another window that uses the environment, or that cannot be ruled out, ends the open with
   * startFailed (OtherWindowUsesError), and nothing is removed.
   */
  private async offerRecreation(
    ctx: PipelineContext,
    container: ContainerInfo,
    image: string,
    loaded: LoadedConfiguration | undefined,
    compose: boolean,
    cause: string,
  ): Promise<ContainerOutcome> {
    const env = ctx.env;
    this.logger.warn(`The container ${container.name} of ${env.repository} is damaged, so it cannot be started or used: ${cause}`);
    // Review round 2 (V1): its volumes without a name are not carried over; the question and the progress name them.
    const unnamed = unnamedVolumeFolders(container);
    if (!compose && loaded === undefined) {
      // Review round 3: as for any container that is created without the configuration.
      this.logger.warn(
        `The container of ${env.repository} is created without the configuration, which cannot be read. Its runArgs and published ports apply once it can be read; the container is then created again.`,
      );
    }
    if (unnamed.length > 0) this.logger.info(`Volumes without a name of ${container.name}, not carried over by a recreation: ${unnamed.join(', ')}.`);
    // Review round 5 of PR #68 (risk 3): the busy mark that requireNoOtherWindow set for this run (Step 9) is not held
    // while the question is open (it may stay open for long, and other windows would find the environment busy): only
    // that mark is cleared, and only when it is gone does this run count as holding none. The mark of the recreation
    // comes after the answer (markBusy), with requireUnchangedSinceQuestion and the check of the other windows.
    const stepMark = ctx.stepMark;
    if (ctx.busy && stepMark !== undefined) {
      ctx.stepMark = undefined;
      if (await this.releaseStepMark(ctx, stepMark)) ctx.busy = false;
    }
    const confirmed = await this.deps.ui.recreateContainer(env.repository, {
      message: Messages.containerRecreateQuestion(env.repository, compose),
      detail: Messages.containerRecreateDetail(compose, unnamed, !compose && loaded === undefined),
    });
    this.throwIfCancelled(ctx.signal);
    if (!confirmed) {
      this.logger.info(`The container ${container.name} of ${env.repository} is not created again. Nothing was changed.`);
      throw new UserFacingError('startFailed', PipelineTexts.startFailed, `${cause}\nThe container was not created again; nothing was changed.`);
    }
    await this.markBusy(ctx, 'rebuild');
    // Review round 1 (D1): the question had no busy mark, so another window may have changed the environment meanwhile
    // (a new, healthy container, or a new environment image). Only the same damaged container, from the same image, is
    // created again; otherwise nothing is changed.
    await this.requireUnchangedSinceQuestion(ctx, container, image);
    // Review round 5 of PR #68 (risk 3): no busy mark was held during the question, so another window may have connected
    // to the environment (or begun to open it) meanwhile: with the mark set, the files of the windows are read as in
    // requireNoOtherWindow (a status file counts when a container runs; a file that cannot be read means "not known").
    const user = await this.otherWindowOf(env, { runs: await this.anyContainerRuns(ctx.env) });
    if (user !== undefined) this.refuseForOtherWindow(`To create the damaged container ${container.name} again, it must be removed`, user);
    ctx.steps.step('starting');
    ctx.steps.detail(Messages.containerRecreatedDamaged(unnamed));
    this.logger.info(`The container ${container.name} of ${env.repository} is created again from ${image}; the files in the volumes are kept.`);
    if (compose) ctx.recreateDevContainer = container;
    try {
      const result = await this.runUp(ctx, image, loaded?.config, true, true, loaded?.compose);
      return { result, created: true };
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || isFilesMissing(error) || isHostAccess(error)) throw error;
      if (isHelperFailed(error)) {
        // Review round 2 of PR #68: `up` returned, and the lifecycle commands of the new container could not run: it was
        // removed (withdrawAfterHelperFailed), and the detail says so.
        const withdrawn = ctx.upWithdrawn;
        if (withdrawn === undefined) throw error;
        throw new UserFacingError(
          'helperFailed',
          Messages.helperFailed,
          `The damaged container was created again, but its lifecycle commands could not run. ${withdrawnOutcome(withdrawn)} ${causeOf(error)}`,
        );
      }
      // Review round 2 (E1–E3): the direct check refused it (requireOtherServicesKept), with its own detail.
      if (isUserFacingError(error) && error.code === 'startFailed') throw error;
      this.logger.error(`The container of ${env.repository} could not be created again from ${image}.`, error);
      throw new UserFacingError('startFailed', PipelineTexts.startFailed, errorDetail(error));
    }
  }

  /**
   * An existing container is created again without an update of its image (concept section 9): the files outside the
   * workspace volume, for example the home folder, are lost. The progress says so, as it names a newer image (concept 6.5).
   */
  private announceRecreation(ctx: PipelineContext, container: ContainerInfo): void {
    if (this.recreatedForHostAccess(ctx, container)) {
      ctx.steps.detail(Messages.containerHostAccessChecksOn);
      return;
    }
    // Current apart from the configuration: it was created while the configuration could not be read.
    const withoutConfiguration = containerIsCurrent(container.labels, false, ctx.hostAccessChecks);
    ctx.steps.detail(withoutConfiguration ? Messages.containerConfigApplied : Messages.containerRecreated);
  }

  /**
   * True when the container is created again only because it was created while the host access checks were off, and
   * they are on now (a container of the current version otherwise).
   */
  private recreatedForHostAccess(ctx: PipelineContext, container: ContainerInfo): boolean {
    return (
      ctx.hostAccessChecks === 'on' &&
      isUnrestrictedContainer(container.labels) &&
      containerIsCurrent(container.labels, false, 'off')
    );
  }

  /**
   * The switch of the host access checks for `repository`, read from the settings at each open (hostAccessChecks). The
   * log states it when the checks are off.
   */
  private hostAccessChecksFor(repository: string): HostAccessChecks {
    const checks = hostAccessChecks(repository, this.deps.settings());
    if (checks === 'off') {
      this.logger.warn(
        `The host access checks are off for ${repository} (setting devEnvLauncher.hostAccessChecksOff): its configuration may use files, devices, and Docker of the computer. Account separation, the identity of the owner account, and the options that Dev Environments does not support are still checked.`,
      );
    }
    return checks;
  }

  /**
   * Review round 1 of PR #64 (L2): whether startContainer opens `container` as it is when the configuration could not be
   * used: it runs, its lifecycle commands ran (no Environment.lifecycleIncomplete for it, review round 3 of PR #68, A-R3-5),
   * and it is current (containerIsCurrent without the configuration, and for Docker Compose with the host
   * access checks on, no container of another service that was created while they were off).
   */
  private async opensAsItIs(ctx: PipelineContext, container: ContainerInfo | undefined, record: BuildRecord | undefined, configKnown: boolean): Promise<boolean> {
    if (container?.state !== 'running' || !containerIsCurrent(container.labels, configKnown, ctx.hostAccessChecks)) return false;
    // Review round 3 of PR #68 (A-R3-5): its lifecycle commands did not run (Environment.lifecycleIncomplete).
    if (this.decideOnLifecycleMark(ctx, container)) return false;
    if (ctx.hostAccessChecks !== 'on' || !this.isComposeEnvironment(ctx.env, record, container)) return true;
    return (await this.unrestrictedServiceContainer(ctx)) === undefined;
  }

  /** A container of another Docker Compose service of the environment that was created while the host access checks were off. */
  private async unrestrictedServiceContainer(ctx: PipelineContext): Promise<ContainerInfo | undefined> {
    return (await this.environmentContainers(ctx.env.id)).find(
      (other) => other.labels[LABEL_COMPOSE_SERVICE] !== undefined && isUnrestrictedContainer(other.labels),
    );
  }

  /**
   * Review round 2 of PR #64 (A-N4): opensAsItIs for the handling of an error at Step 5: a failure of its Docker listing
   * is logged and counts as `false`, so the caller goes on with its own error; a cancellation passes through.
   */
  private async opensAsItIsOrFalse(ctx: PipelineContext, container: ContainerInfo | undefined, record: BuildRecord | undefined, configKnown: boolean): Promise<boolean> {
    try {
      return await this.opensAsItIs(ctx, container, record, configKnown);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The containers of ${ctx.env.repository} could not be listed: ${errorDetail(error)}`);
      return false;
    }
  }

  /**
   * A Docker Compose environment (D-15): its build record says so, or its container belongs to the project of the
   * environment.
   */
  private isComposeEnvironment(env: Environment, record: BuildRecord | undefined, container: ContainerInfo | undefined): boolean {
    // Review round 4 of PR #68 (A-R4-2): the key decides the kind (hasComposeRecord), not the validity of its fields.
    if (hasComposeRecord(record)) return true;
    return container !== undefined && isComposeContainer(container.labels, composeProjectName(env.id));
  }

  /**
   * D-22: the containers of the other services of a Docker Compose environment that do not run are started with
   * `docker start` (the dev container runs). A failure is a warning: the dev container runs, and the user can see why.
   */
  private async startStoppedServices(ctx: PipelineContext): Promise<void> {
    const stopped = (await this.environmentContainers(ctx.env.id)).filter(
      (container) => container.labels[LABEL_COMPOSE_SERVICE] !== undefined && container.state !== 'running',
    );
    for (const container of stopped) {
      this.logger.info(`Starting the container ${container.name} of the service ${container.labels[LABEL_COMPOSE_SERVICE]} of ${ctx.env.repository}.`);
      try {
        await this.deps.docker.runChecked(['start', container.id], { timeoutMs: DOCKER_START_TIMEOUT_MS, signal: ctx.signal });
      } catch (error) {
        if (this.isCancellation(error, ctx.signal)) throw error;
        this.logger.warn(`The container ${container.name} could not be started: ${errorDetail(error)}`);
      }
    }
  }

  /**
   * The containers with the label nimblescape.devenv.environment-id of `environmentId`: the dev container and the other
   * services.
   */
  private async environmentContainers(environmentId: string): Promise<ContainerInfo[]> {
    return (await this.deps.docker.listEnvironmentContainers()).filter((container) => container.labels[LABEL_ENVIRONMENT_ID] === environmentId);
  }

  /**
   * `devcontainer up` with the override configuration (concept 7.6). `createsContainer`: `up` creates a container from
   * `image` (no container, or `removeExistingContainer`); only then the image metadata is checked, because `up` starts
   * an existing container without the image, and that container passed the check when it was created. `compose`: a Docker
   * Compose configuration (runComposeUp).
   */
  private async runUp(
    ctx: PipelineContext,
    image: string,
    config: DevcontainerConfig | undefined,
    removeExistingContainer: boolean,
    createsContainer: boolean,
    compose?: LoadedCompose,
  ): Promise<DevcontainerResult> {
    // Review round 2 of PR #68: set only by this `up` (a restore after a failed update runs a second one).
    ctx.upWithdrawn = undefined;
    if (compose) return this.runComposeUp(ctx, image, config, compose, removeExistingContainer, createsContainer);
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
      hostAccessChecks: ctx.hostAccessChecks,
      // Review round 4 (D4-2): reconcileFromVolumes restores the configuration path from it.
      configPath: env.configPath,
    });
    // Concept section 9 "Host access": the arguments and published ports that Docker gets, after the changes of the
    // override configuration, pass the policy too (the check of the configuration covers them as read-configuration
    // returned them; the CLI substitutes both again at `up`, hotfix review 1).
    let finalRunArgs: HostAccessReport;
    try {
      finalRunArgs = await this.check(ctx, 'finalRunArgs', await this.hostAccessInput(env, { config: { runArgs: override.runArgs, appPort: override.appPort } }), ctx.hostAccessChecks);
    } catch (error) {
      // Review round 9 (P9-2): `up` only starts the existing container, which passed the check when it was created, and
      // applies no runArgs: an analysis that could not run does not keep it from starting.
      if (createsContainer || !isInternalAnalysisFailure(error)) throw error;
      this.logger.warn(`The runArgs of ${env.repository} could not be checked (${error.failure.reason}). The existing container is started as it is.`);
      finalRunArgs = { hostAccess: [], unsupported: [] };
    }
    // What Docker gets: its last --user decides the user of the container (imageRemoteUser).
    const dockerRunArgs = stringList(override.runArgs) ?? [];
    if (isRefused(finalRunArgs)) {
      this.logger.warn(`The runArgs of the container of ${env.repository} are refused by the host access policy: ${describeRefusal(finalRunArgs)}`);
      throw new HostAccessError(finalRunArgs);
    }
    // The container is in use from its start on (concept 7.9).
    await this.deps.sessionFiles.writePending(env.id, this.deps.owner.windowId);
    await this.requireVolume(env);
    if (createsContainer) {
      const metadataVolumes = await this.checkImageHostAccess(ctx, image);
      const configVolumes = mountedVolumeNames({
        ownVolume: env.volumeName,
        config: { mounts: config?.mounts, runArgs: dockerRunArgs },
        variables: helperCliVariables(env.repository),
      });
      await this.createAdditionalVolumes(ctx, [...configVolumes, ...metadataVolumes]);
    }
    if (ctx.cloned && !ctx.ownershipPrepared) await this.prepareOwnership(ctx, image, dockerRunArgs);
    // After the ownership fix (the files get the owner of the repository folder), and before `up`, so that the lifecycle
    // commands have the Git configuration (the token goes into the container after `up`, before them: runUserCommands).
    await this.prepareGit(ctx, true);
    // The environment was a Docker Compose environment: `up` finds the container by the ID label, which the containers
    // of the other services have too, so they go first. Review round 3 (D3-1): also the containers of other services that
    // exist without a Docker Compose dev container or record (for example after a failed switch to Docker Compose).
    let services = (await this.environmentContainers(env.id)).filter((container) => container.labels[LABEL_COMPOSE_SERVICE] !== undefined);
    if (!createsContainer && services.length > 0) {
      // `up` without a new container would take one of them for the dev container. Review round 4 (P4-3): next to a single
      // dev container (no container of Docker Compose), they are strays (for example of a failed switch to Docker
      // Compose): they go (`docker rm -f`, their volumes stay), and the single container starts as usual; a rebuild would
      // not help when the configuration cannot be used.
      const dev = await this.deps.docker.findContainer(env.id, env.containerName);
      const single = dev !== undefined && dev.labels[LABEL_COMPOSE_SERVICE] === undefined && !isComposeContainer(dev.labels, composeProjectName(env.id));
      if (!single) {
        // The caller reports it as startFailed.
        throw new Error(
          `Containers of other Docker Compose services of ${env.repository} exist (${services.map((container) => container.name).join(', ')}), and it is not known whether its dev container is a single container: rebuild the environment.`,
        );
      }
      // Review round 4 of PR #68 (A-R4-5): without a busy mark (Step 9), only with it and no other window.
      await this.requireNoOtherWindow(ctx, `To start the environment, the containers ${services.map((container) => container.name).join(', ')} of other Docker Compose services must be removed`);
      for (const container of services) {
        this.logger.info(
          `The container ${container.name} of the service ${container.labels[LABEL_COMPOSE_SERVICE]} of ${env.repository} is left over next to its single container. It is removed; its volumes are kept.`,
        );
        await this.stopServiceBeforeRemoval(container, env);
        await this.deps.docker.removeContainer(container.id);
      }
      services = [];
    }
    const leftovers = createsContainer && (ctx.composeContainer === true || composeRecordOf(env.buildRecord) !== undefined || services.length > 0);
    if (leftovers) {
      // Review round 4 of PR #68 (A-R4-5): without a busy mark (Step 9), only with it and no other window.
      await this.requireNoOtherWindow(ctx, 'To start the environment, the containers of its other Docker Compose services must be removed');
      this.logger.info(
        `The environment ${env.repository} was a Docker Compose environment. The container is created again for the configuration, and the containers of the other services are removed; the files in the volumes are kept.`,
      );
      // Review round 1 (P-1): named volumes of the services stay; their volumes without a name are no longer used.
      ctx.steps.detail(Messages.containerComposeReplaced);
      await this.removeComposeServices(ctx);
    }
    // Review round 11 (G3): the recorded paths of the services stay (before, round 10 cleared them here): their data is
    // still in the volume. finish drops those that no longer exist.
    let result: DevcontainerResult & { lifecycleCommandFailure?: unknown };
    // Review round 2 of PR #68: the containers right before `up`, so that a helperFailed of run-user-commands can tell a
    // container that this `up` created from one that it only started (withdrawAfterHelperFailed).
    const before = await this.containersBeforeUp(ctx, false);
    let upContainer: string | undefined;
    try {
      result = await this.deps.helper.up({
        volumeName: env.volumeName,
        repository: env.repository,
        override,
        environmentId: env.id,
        removeExistingContainer,
        token: ctx.session.token,
        onOutput: this.output,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
      ctx.upStarted = true;
      upContainer = nonEmptyString(result.containerId);
      // Lifecycle token (user decision 2026-09-27): `up` ran no lifecycle command; they run now, with the token.
      result = await this.runUserCommands(ctx, result, { override }, configRemoteUser(config, runArgs));
    } catch (error) {
      if (upContainer !== undefined && isHelperFailed(error)) await this.withdrawAfterHelperFailed(ctx, upContainer, before, false);
      const kept = await this.keptAfterLifecycleFailure(ctx, error);
      if (!kept) {
        // A container that `up` created before it failed or was cancelled mounts its volumes already.
        await this.quietly('record the volumes of the container', () => this.recordContainerVolumes(ctx));
        throw error;
      }
      result = kept;
    }
    // Review round 4 of PR #68 (A-R4-1): its lifecycle commands ran.
    ctx.lifecycleRanFor = nonEmptyString(result.containerId) ?? upContainer;
    // A volume named with ${devcontainerId} gets its name only at `up`, so neither the configuration nor the image
    // metadata named it: the container does. Also for an existing container, whose volumes an earlier failed or cancelled
    // `up` may not have recorded.
    await this.quietly('record the volumes of the container', () => this.recordContainerVolumes(ctx));
    // `up` replaced the dev container of Docker Compose: the networks of the project are no longer used.
    if (leftovers) await this.quietly('remove the networks of the Docker Compose project', () => this.removeComposeNetworks(env));
    const failure = nonEmptyString(result.lifecycleCommandFailure);
    return failure === undefined ? result : this.openAfterLifecycleFailure(ctx, result, failure, image, dockerRunArgs);
  }

  /**
   * `devcontainer up` of a Docker Compose configuration (implementation notes, section "Docker Compose"): the up model
   * (composeUpModel: the checked model with the environment image for the dev service, ports on 127.0.0.1, the labels
   * of the environment on every container, external volumes) as the only compose file of the override configuration
   * (buildComposeOverrideConfig), with the project name of the environment. When `up` creates the dev container
   * (`createsContainer`, concept section 9 "Host access"): the model is checked again with the labels of its volumes
   * now, the image metadata of the environment image is checked, and the named volumes of the model and of the `mounts`
   * are created with the labels of the environment (nimblescape.devenv.volume=compose for the volumes of the project,
   * `additional` for the others). The Dev Container CLI finds the dev container by the project and the service; `up`
   * replaces only the dev container (removeExistingContainer), and Compose recreates the other services whose model or
   * image changed.
   */
  private async runComposeUp(
    ctx: PipelineContext,
    image: string,
    config: DevcontainerConfig | undefined,
    compose: LoadedCompose,
    removeExistingContainer: boolean,
    createsContainer: boolean,
  ): Promise<DevcontainerResult> {
    const env = ctx.env;
    const { docker } = this.deps;
    // The container is in use from its start on (concept 7.9).
    await this.deps.sessionFiles.writePending(env.id, this.deps.owner.windowId);
    await this.requireVolume(env);
    // A container of the environment that Compose did not create (the configuration was no Docker Compose configuration
    // before) has the name of the dev container: it goes after the checks, and `up` creates the containers.
    const found = await docker.findContainer(env.id, env.containerName);
    const replaced = found !== undefined && !isComposeContainer(found.labels, compose.project) ? found : undefined;
    const creates = createsContainer || replaced !== undefined;
    // The `mounts` of the image metadata (Features) become volumes of the project too.
    let metadata: unknown[] = [];
    let labels: Record<string, string> = {};
    try {
      ({ metadata, labels } = await this.imageMetadataAndLabels(image, ctx.signal));
    } catch (error) {
      if (creates || this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The metadata of ${image} could not be read: ${errorMessage(error)}`);
    }
    // Review round 17 (D17-1): the metadata as written in the label, substituted as the CLI substitutes it at `up`.
    const mounts = this.composeMountVolumes(env, compose, [...compose.mounts, ...metadata.map((entry) => (isRecord(entry) ? entry.mounts : undefined))]);
    if (creates) {
      const { report } = await this.composeReport(ctx, compose, config ?? {});
      if (isRefused(report)) {
        this.logger.warn(`The Docker Compose configuration of ${env.repository} is refused by the host access policy: ${describeRefusal(report)}`);
        throw new HostAccessError(report);
      }
      const serviceLabels = await this.serviceImageLabelItems(ctx, compose);
      await this.checkMetadataHostAccess(ctx, image, metadata, compose.hostAccessChecks, labels, serviceLabels, true);
    }
    // Review round 1 (P-2): also when `up` only adds containers (a service that the model gained, after a "Rebuild
    // later"): Compose would refuse an external volume that does not exist. Only the missing ones are created.
    await this.createComposeVolumes(ctx, compose, mounts);
    // Review round 4 (D4-2): every container carries the configuration path (reconcileFromVolumes).
    const { model, rewrites, createFolders, serviceFolders } = composeUpModel(compose.output.model, {
      ...this.composeParams(env, compose, mounts.sources),
      image,
      configPath: env.configPath,
    });
    // Review round 10 (D10-1): before `up` (also before the first build record, so that a failed `up` leaves them
    // recorded). Review round 11 (G3, G4): with the paths that the existing containers mount; the list never shrinks
    // before `up` (after it, finish drops what nothing names any more).
    ctx.modelServiceFolders = serviceFolders ?? [];
    const before = await this.serviceFolderFacts(ctx.env, ctx.modelServiceFolders);
    ctx.serviceFolders = before.overflow ? 'repository' : before.folders;
    await this.recordServiceFolders(ctx, before);
    if (rewrites.length > 0) {
      this.logger.info(`Changed in the Docker Compose model of ${env.repository}: ${rewrites.map((rewrite) => `${rewrite.item} (${rewrite.reason})`).join(', ')}.`);
    }
    // Review round 8 (P8-2): the folders of the repository that bind mounts name and that do not exist yet (for example
    // a data folder in .gitignore): Docker would create them; the subpath of the workspace volume must exist.
    if (createFolders !== undefined && createFolders.length > 0) {
      await this.requireVolume(env);
      await this.deps.helper.createRepositoryFolders({
        volumeName: env.volumeName,
        repository: env.repository,
        folders: createFolders,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
    }
    // The user of the dev service decides the owner of the files (imageRemoteUser reads `--user`).
    const userArgs = composeUserArgs(compose.output.model.services[compose.service]);
    // Review round 12 of PR #64 (R12-1): before anything is removed, stopped or renamed (as in runUp), so that a helperFailed
    // of the Git setup leaves the running containers as they are.
    if (ctx.cloned && !ctx.ownershipPrepared) await this.prepareOwnership(ctx, image, userArgs);
    await this.prepareGit(ctx, true);
    // Review round 22 (D22-1): the dev container of another service of the project (Select configuration… between two
    // configurations of one compose file with another `service`): it holds the name that the new dev service gets.
    const previousService = found !== undefined && replaced === undefined ? found.labels[COMPOSE_SERVICE_LABEL] : undefined;
    const movesPrevious = found !== undefined && previousService !== undefined && previousService !== compose.service;
    // Review round 4 of PR #68 (A-R4-5): without a busy mark (Step 9, for example for a container of the mark
    // Environment.lifecycleIncomplete that a failed switch left running for another window), a container is removed or
    // renamed only with the busy mark set and no other window that uses the environment; else nothing is changed.
    if (replaced) {
      await this.requireNoOtherWindow(ctx, `To start the environment with its Docker Compose configuration, the container ${replaced.name}, which Docker Compose did not create, must be removed`);
    } else if (movesPrevious) {
      await this.requireNoOtherWindow(ctx, `To start the environment, the dev container ${found.name} of the service ${previousService} must be renamed and stopped`);
    }
    if (replaced) {
      this.logger.info(
        `The container ${replaced.name} of ${env.repository} was not created by Docker Compose. It is replaced by the containers of the Docker Compose configuration; the files in the volume are kept.`,
      );
      // Review round 1 (P-1): as for the other recreations, the user learns that the files outside the repository go.
      ctx.steps.detail(Messages.containerComposeCreated);
      // Review round 9 (D9-3): stopped first, so that it can shut down cleanly, as the side services (D7-1).
      await this.stopServiceBeforeRemoval(replaced, env);
      await docker.removeContainer(replaced.id);
      (ctx.kindSwitchRemoved ??= []).push(`the container ${replaced.name}`);
      // Review round 4 (D4-1): the containers of Docker Compose that exist now (for example of an earlier switch that
      // was cancelled, which the user may have used since) are not new, whatever the failed `up` does.
      ctx.composeSwitch = { existing: await this.composeContainerIds(env) };
    }
    if (movesPrevious) {
      await this.movePreviousDevContainer(ctx, compose, found, previousService, removeExistingContainer);
    }
    // Recreate offer: the user chose to create the damaged dev container again. After the checks above (a refusal leaves
    // it as it is), and only when Docker Compose would leave every other service as it is (review round 2:
    // requireOtherServicesKept, with this very model), only it goes: stopped first (D7-1), then `docker rm -f` without
    // its volumes. `up` creates it again; the containers of the other services and their volumes stay as they are.
    const damaged = ctx.recreateDevContainer;
    if (damaged !== undefined) {
      ctx.recreateDevContainer = undefined;
      await this.requireOtherServicesKept(ctx, compose, model);
      this.logger.info(`The dev container ${damaged.name} of ${env.repository} is removed to be created again. The other services and all volumes are kept.`);
      await this.stopServiceBeforeRemoval(damaged, env);
      await docker.removeContainer(damaged.id);
    }
    const override = buildComposeOverrideConfig({
      modelPath: COMPOSE_MODEL_PATH,
      service: compose.service,
      ...(compose.runServices !== undefined ? { runServices: compose.runServices } : {}),
      repositoryName: splitRepository(env.repository).name,
    });
    let result: DevcontainerResult & { lifecycleCommandFailure?: unknown };
    const inputs = {
      override,
      files: { [COMPOSE_MODEL_PATH]: JSON.stringify(model, null, 2) },
      env: { COMPOSE_PROJECT_NAME: compose.project },
    };
    // Review round 2 of PR #68: as in runUp, with the containers of the project.
    const containersBefore = await this.containersBeforeUp(ctx, true);
    let upContainer: string | undefined;
    try {
      result = await this.deps.helper.up({
        volumeName: env.volumeName,
        repository: env.repository,
        environmentId: env.id,
        removeExistingContainer,
        ...inputs,
        token: ctx.session.token,
        onOutput: this.output,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
      ctx.upStarted = true;
      upContainer = nonEmptyString(result.containerId);
      // Lifecycle token (user decision 2026-09-27): as for a single container (runUp). The CLI ignores runArgs for Compose.
      result = await this.runUserCommands(ctx, result, inputs, configRemoteUser(config, undefined));
    } catch (error) {
      if (upContainer !== undefined && isHelperFailed(error)) await this.withdrawAfterHelperFailed(ctx, upContainer, containersBefore, true);
      const kept = await this.keptAfterLifecycleFailure(ctx, error);
      if (!kept) {
        await this.quietly('record the volumes of the containers', () => this.recordContainerVolumes(ctx, true));
        throw error;
      }
      result = kept;
    }
    // Review round 4 of PR #68 (A-R4-1): its lifecycle commands ran.
    ctx.lifecycleRanFor = nonEmptyString(result.containerId) ?? upContainer;
    await this.quietly('record the volumes of the containers', () => this.recordContainerVolumes(ctx, true));
    // L-2: the CLI finds the dev container again only by the project; another project would be a second environment.
    if (result.composeProjectName !== undefined && result.composeProjectName !== compose.project) {
      throw new Error(`devcontainer up used the Docker Compose project ${String(result.composeProjectName)}, not ${compose.project}.`);
    }
    const failure = nonEmptyString(result.lifecycleCommandFailure);
    return failure === undefined ? result : this.openAfterLifecycleFailure(ctx, result, failure, image, userArgs);
  }

  /**
   * Review round 2 of PR #68: the containers of the environment (with `compose`, also those of its Docker Compose project)
   * right before `up`, by ID, with whether each ran. `undefined` when they cannot be listed (logged): then a container of
   * `up` whose lifecycle commands could not run is only stopped, never removed (withdrawAfterHelperFailed).
   */
  private async containersBeforeUp(ctx: PipelineContext, compose: boolean): Promise<ReadonlyMap<string, boolean> | undefined> {
    try {
      return new Map((await this.upContainers(ctx.env, compose)).map((container) => [container.id, container.state === 'running']));
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(
        `The containers of ${ctx.env.repository} could not be listed before up: ${errorMessage(error)}. If the lifecycle commands cannot run, its container is only stopped, never removed.`,
      );
      return undefined;
    }
  }

  /** The containers with the ID label of the environment and, with `compose`, those of its Docker Compose project, once each. */
  private async upContainers(env: Environment, compose: boolean): Promise<ContainerInfo[]> {
    const all = [...(await this.environmentContainers(env.id)), ...(compose ? await this.deps.docker.listProjectContainers(composeProjectName(env.id)) : [])];
    const seen = new Set<string>();
    return all.filter((container) => {
      if (seen.has(container.id)) return false;
      seen.add(container.id);
      return true;
    });
  }

  /**
   * Review round 2 of PR #68 (A-R2-1 to A-R2-4; user decision 2026-09-29: never opened as it is after the helper was
   * prepared): `up` returned the container `containerId`, and run-user-commands then failed with helperFailed, so its
   * lifecycle commands did not run. So that no later open opens it as it is: a container that this `up` created (not
   * among `before`) is removed (the files are in the volumes), and stopped when that fails; one that existed and did not
   * run before `up` is stopped again (the next open starts it and runs its lifecycle commands); one that ran before `up`
   * is left as it is (it ran before this open). With `before` unknown, it is only stopped, and the containers of the other
   * services are left as they are (review round 3, A-R3-3: it is not known which of them `up` created or started). The
   * containers of the other services that did not run before `up` (new ones, or stopped ones that `up` started) are
   * stopped too. Review round 3 (A-R3-4): when another window is connected to the environment (its window status file or
   * its pending connection file, otherWindowUsesEnvironment), nothing is touched: that window uses the containers; so too
   * when those files cannot be read (when in doubt, nothing is stopped or removed). Review round 3 (A-R3-5): a container
   * that could be neither removed nor stopped, or that was left running for another window (and did not run before `up`),
   * is named in Environment.lifecycleIncomplete, so that the next open runs its lifecycle commands. Every failure is logged; a cancellation does not stop the cleanup. The
   * result goes to PipelineContext.upWithdrawn.
   *
   * Review round 4 of PR #68 (A-R4-6): without a busy mark of this run (Step 9), a busy mark is set first, before the
   * files of the windows are read, and held until the withdrawal ends: another window that begins to open the environment
   * meanwhile waits for it (waitForOtherOperation) instead of opening the container that is about to be stopped or removed.
   * When it cannot be set (another window holds one, or the mark of this window is there already, which is never
   * overwritten), the containers stay as they are, as with another window connected (`inUse`); when the registry fails,
   * as when the files cannot be read (`useUnknown`). Only the mark set here is cleared, in `finally`; nothing waits for
   * another window while it is held.
   */
  private async withdrawAfterHelperFailed(
    ctx: PipelineContext,
    containerId: string,
    before: ReadonlyMap<string, boolean> | undefined,
    compose: boolean,
  ): Promise<void> {
    let own: BusyMark | undefined;
    let blocked: WindowUse | undefined;
    if (!ctx.busy) {
      const taken = await this.takeStepMark(ctx, 'update');
      if ('mark' in taken) own = taken.mark;
      else blocked = taken.user;
    }
    try {
      await this.withdrawContainer(ctx, containerId, before, compose, blocked);
    } finally {
      if (own !== undefined) await this.releaseStepMark(ctx, own);
    }
  }

  /** withdrawAfterHelperFailed, with the busy mark set (or `blocked`: why it could not be set). */
  private async withdrawContainer(
    ctx: PipelineContext,
    containerId: string,
    before: ReadonlyMap<string, boolean> | undefined,
    compose: boolean,
    blocked: WindowUse | undefined,
  ): Promise<void> {
    const env = ctx.env;
    const { docker } = this.deps;
    let current: ContainerInfo[] | undefined;
    try {
      current = await this.upContainers(env, compose);
    } catch (error) {
      this.logger.warn(`The containers of ${env.repository} could not be listed after its lifecycle commands could not run: ${errorMessage(error)}`);
    }
    const found = current?.find((container) => sameContainer(container.id, containerId));
    const id = found?.id ?? containerId;
    const name = found?.name ?? env.containerName;
    const known = before === undefined ? undefined : [...before.keys()].find((other) => sameContainer(other, id));
    // Review round 3 (A-R3-3): not known when the listing before `up` failed.
    const created = before === undefined ? undefined : known === undefined;
    const ranBefore = known !== undefined && before?.get(known) === true;
    // Review round 3 (A-R3-4): Step 9 holds no busy mark, so another window may have started this container (its `up`)
    // and connected to it meanwhile.
    // When the files cannot be read, it is not known: the containers stay too (when in doubt, nothing is stopped or removed).
    // Review round 4 (A-R4-6): read with the busy mark of this run set; without it (`blocked`), nothing is touched either.
    const user = blocked ?? (await this.otherWindowOf(env));
    // Review round 4 (A-R4-4): a mark of an earlier open that names this container (it ran before `up`) stays.
    const mark = ctx.env.lifecycleIncomplete;
    const markedBefore = ranBefore && mark !== undefined && sameContainer(mark, id);
    if (user !== undefined) {
      const what = created === undefined ? 'created or started' : created ? 'created' : 'started';
      this.logger.info(
        ranBefore
          ? `The container ${name} ran before this open; its lifecycle commands could not run now. ${user.text} It is left running, and so are the containers of the other services.`
          : `The container ${name} was ${what}, but its lifecycle commands did not run. ${user.text} It is left running, and so are the containers of the other services.`,
      );
      // A container that did not run before `up` runs without its lifecycle commands: the mark (A-R3-5) makes the next
      // open run them. One that ran before this open runs as before.
      // Review round 4 (B-R4-2): nothing is stopped here, also when the mark cannot be written (another window may use it).
      const marked = ranBefore ? markedBefore : await this.markLifecycleIncomplete(ctx, id, name);
      const markFailed = !ranBefore && !marked;
      if (markFailed) this.lifecycleNotRecorded(ctx, id, name);
      ctx.upWithdrawn = {
        outcome: user.known ? 'inUse' : 'useUnknown',
        id,
        created,
        name,
        ...(marked ? { marked } : {}),
        ...(markFailed ? { markFailed } : {}),
        ...(user.known && user.use !== undefined ? { use: user.use } : {}),
        ...(ranBefore ? { ranBefore } : {}),
      };
      return;
    }
    const stop = async (): Promise<boolean> => {
      try {
        await docker.stopContainer(id);
        return true;
      } catch (error) {
        this.logger.warn(`The container ${name} could not be stopped: ${errorMessage(error)}`);
        return false;
      }
    };
    let outcome: UpWithdrawn['outcome'];
    if (ranBefore) {
      this.logger.info(`The container ${name} ran before this open; its lifecycle commands could not run now. It is left as it is.`);
      outcome = 'unchanged';
    } else if (created === true) {
      this.logger.info(`The container ${name} was created, but its lifecycle commands did not run. It is removed; the next open creates it again.`);
      try {
        await docker.removeContainer(id);
        outcome = 'removed';
      } catch (error) {
        this.logger.warn(`Could not remove the container ${name}: ${errorMessage(error)}. It is stopped instead.`);
        outcome = (await stop()) ? 'stoppedAfterRemovalFailed' : 'kept';
      }
    } else {
      this.logger.info(
        `The container ${name} was ${created === undefined ? 'created or started' : 'started'}, but its lifecycle commands did not run. It is stopped; the next open starts it again.`,
      );
      outcome = (await stop()) ? 'stopped' : 'kept';
    }
    // The other services (Docker Compose) that `up` created or started are stopped again; those that ran before stay.
    // Review round 3 (A-R3-3): without the list before `up`, they are left as they are.
    if (before !== undefined) {
      for (const other of current ?? []) {
        if (sameContainer(other.id, id) || other.state !== 'running') continue;
        const ran = [...before.entries()].some(([known, running]) => running && sameContainer(known, other.id));
        if (ran) continue;
        await this.quietly(`stop the container ${other.name}`, () => docker.stopContainer(other.id));
      }
    } else if (compose) {
      this.logger.info(`The containers of the other services of ${env.repository} are left as they are: it is not known which of them ran before up.`);
    }
    // Review round 3 (A-R3-5): the container runs without its lifecycle commands: the mark makes the next open run them.
    let marked = markedBefore;
    let markFailed = false;
    if (outcome === 'kept') {
      marked = await this.markLifecycleIncomplete(ctx, id, name);
      // Review round 4 (B-R4-2): the mark could not be written: the stop of this container (which this `up` created or
      // started, and which no other window uses) is tried once more; when it still runs, this window remembers it, and the
      // detail and a warning say that it could not be recorded.
      if (!marked) {
        if (await stop()) {
          outcome = created === true ? 'stoppedAfterRemovalFailed' : 'stopped';
        } else {
          markFailed = true;
          this.lifecycleNotRecorded(ctx, id, name);
        }
      }
    } else if (outcome === 'removed') {
      await this.clearLifecycleMark(ctx, id);
    }
    ctx.upWithdrawn = { outcome, id, created, name, ...(marked ? { marked } : {}), ...(markFailed ? { markFailed } : {}), ...(ranBefore ? { ranBefore } : {}) };
  }

  /**
   * Review round 4 of PR #68 (A-R4-5, A-R4-6): sets a busy mark for a step of a run that holds none (Step 9), unless the
   * entry has a mark already that is not an ended one: a live mark of another window, and any mark of this window or
   * process (an outer mark is never overwritten). Never waits. Returns the mark that was set, or else how the environment
   * is used (`busy`; `known: false` when the registry could not be written, logged).
   */
  private async takeStepMark(ctx: PipelineContext, operation: BusyOperation): Promise<{ mark: BusyMark } | { user: WindowUse }> {
    const mark = this.busyMark(operation);
    const state: { conflict?: BusyMark } = {};
    try {
      // Read before the lock: the mutator does no I/O.
      const blocks = await this.markBlocker();
      const updated = await this.deps.registry.updateEnvironment(ctx.env.id, (entry) => {
        if (entry.busy && (blocks(entry.busy) || this.isOwnMark(entry.busy) || entry.busy.pid === this.deps.owner.pid)) {
          state.conflict = entry.busy;
          return;
        }
        entry.busy = mark;
      });
      if (!updated) {
        this.logger.warn(`The registry entry of ${ctx.env.repository} is missing; no busy mark was set.`);
        return { user: { known: false, text: `It is not known whether another window uses ${ctx.env.repository}.` } };
      }
      ctx.env = updated;
      if (state.conflict) {
        const other = state.conflict;
        return { user: { known: true, use: 'busy', text: `The window ${other.windowId} (process ${other.pid}) holds the busy mark ${other.operation} since ${other.since}.` } };
      }
      this.logger.info(`${ctx.env.repository} is marked as busy (${operation}).`);
      return { mark };
    } catch (error) {
      this.logger.warn(`The busy mark of ${ctx.env.repository} could not be set: ${errorMessage(error)}.`);
      return { user: { known: false, text: `It is not known whether another window uses ${ctx.env.repository}.` } };
    }
  }

  /**
   * Review round 4 of PR #68 (A-R4-5): before a step of a run without a busy mark (Step 9) stops, removes, or renames a
   * container (`change` says which and why): the busy mark is set (takeStepMark, never over another mark), and then the
   * files of the windows are read. When another window uses the environment, when its busy mark is there, or when that
   * cannot be checked, nothing is changed and the open ends with startFailed (OtherWindowUsesError); the mark
   * Environment.lifecycleIncomplete stays. Otherwise the mark is held for the rest of this run (PipelineContext.busy:
   * releaseBusy in `finally`, or finish, clears it), so that no other window opens the environment meanwhile. With a busy
   * mark of this run already, nothing is checked.
   *
   * Review round 5 of PR #68 (A-R5-1): with the mark held, the containers of the environment are listed again
   * (anyContainerRuns; never the listing of Step 9). When none of them runs, a status file of another window does not
   * count (its connection is lost: it cannot be attached to a stopped container, concept 6.2), only its pending connection
   * file, a busy mark, and files that cannot be read. When one runs, or when that is not known, the rule stays as it was,
   * and a status file of a live window that is no longer fresh, but not stale either, counts as "not known" (risk 2).
   */
  private async requireNoOtherWindow(ctx: PipelineContext, change: string): Promise<void> {
    if (ctx.busy) return;
    const taken = await this.takeStepMark(ctx, 'update');
    let user: WindowUse | undefined;
    if ('mark' in taken) {
      ctx.busy = true;
      ctx.stepMark = taken.mark;
      user = await this.otherWindowOf(ctx.env, { runs: await this.anyContainerRuns(ctx.env) });
    } else {
      user = taken.user;
    }
    if (user !== undefined) this.refuseForOtherWindow(change, user);
  }

  /** Review round 4 of PR #68 (A-R4-5): ends the open with startFailed (OtherWindowUsesError): `user` uses the environment. */
  private refuseForOtherWindow(change: string, user: WindowUse): never {
    this.logger.warn(`${change}. ${user.text} Nothing is changed, and the open ends.`);
    const who = !user.known
      ? 'it could not be checked whether another window uses the environment'
      : user.use === 'opening'
        ? 'another window is opening the environment'
        : user.use === 'busy'
          ? 'another window is working on the environment'
          : 'another window is connected to the environment';
    throw new OtherWindowUsesError(`${change}, but ${who}. Nothing was stopped, removed, or renamed. Open or rebuild the environment again when that window is closed.`);
  }

  /**
   * Review round 5 of PR #68 (A-R5-1): whether a container of the environment runs, listed now: every container with its
   * ID label (the dev container and the other services of Docker Compose) and every container of its Compose project.
   * Every state but `exited` and `created` counts as running (`running`, `restarting`, `paused`, and any other). When the
   * listing (or an inspect in it) fails, it is not known: true (when in doubt, the strict rule stays).
   */
  private async anyContainerRuns(env: Environment): Promise<boolean> {
    let containers: ContainerInfo[];
    try {
      containers = await this.upContainers(env, true);
    } catch (error) {
      this.logger.warn(`The containers of ${env.repository} could not be listed: ${errorMessage(error)}. They count as running.`);
      return true;
    }
    const running = containers.filter((container) => !NOT_RUNNING_STATES.has((container.rawState ?? '').toLowerCase()));
    if (running.length > 0) {
      this.logger.info(`Containers of ${env.repository} run: ${running.map((container) => `${container.name} (${container.rawState})`).join(', ')}.`);
      return true;
    }
    this.logger.info(`No container of ${env.repository} runs.`);
    return false;
  }

  /**
   * Review round 4 of PR #68 (A-R4-6): clears the busy mark `mark` that takeStepMark set, and no other. Never throws.
   * Review round 5 of PR #68 (risk 3): whether that mark is gone from the entry afterwards (false when the registry could
   * not be written).
   */
  private async releaseStepMark(ctx: PipelineContext, mark: BusyMark): Promise<boolean> {
    let gone = false;
    await this.quietly('clear the busy mark', async () => {
      const updated = await this.deps.registry.updateEnvironment(ctx.env.id, (entry) => {
        if (entry.busy !== undefined && sameBusyMark(entry.busy, mark)) delete entry.busy;
      });
      if (updated) {
        ctx.env = updated;
        gone = updated.busy === undefined || !sameBusyMark(updated.busy, mark);
      }
    });
    return gone;
  }

  /**
   * Review round 3 of PR #68 (A-R3-5): records `id` in Environment.lifecycleIncomplete (the container runs without its
   * lifecycle commands, so the next open runs them). Whether that worked; a failure is logged.
   */
  private async markLifecycleIncomplete(ctx: PipelineContext, id: string, name: string): Promise<boolean> {
    // Review round 4 of PR #68 (B-R4-2): written twice at most, with a short pause; "the next open runs them" only once it
    // is written.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.updateEntry(ctx, (entry) => {
          entry.lifecycleIncomplete = id;
        });
        this.logger.warn(`The container ${name} runs without its lifecycle commands. The next open runs them.`);
        return true;
      } catch (error) {
        this.logger.warn(`Could not record the container whose lifecycle commands did not run: ${errorMessage(error)}`);
        if (attempt >= 2) return false;
      }
      await this.sleepFn(LIFECYCLE_MARK_RETRY_MS).catch(() => undefined);
    }
  }

  /**
   * Review round 4 of PR #68 (B-R4-2): the container `id` runs without its lifecycle commands, and the registry could not
   * record it: this window remembers it (unrecordedLifecycle), and the log and a warning say so.
   */
  private lifecycleNotRecorded(ctx: PipelineContext, id: string, name: string): void {
    this.unrecordedLifecycle.set(ctx.env.id, id);
    this.logger.error(
      `The container ${name} of ${ctx.env.repository} runs without its lifecycle commands, and this could not be recorded. Stop or rebuild the environment before working in it.`,
    );
    this.deps.ui.warn(Messages.lifecycleNotRecorded(ctx.env.repository));
  }

  /**
   * Review round 3 of PR #68 (A-R3-4): whether another window uses the environment (otherWindowUsesEnvironment, with the
   * window status files and the pending connection files), with a sentence for the log; `undefined` when none does.
   * `known: false`: a file could not be read (logged), so it is not known, and the caller keeps the containers as when
   * another window uses them (when in doubt, nothing is stopped or removed).
   */
  private async otherWindowOf(env: Environment, check?: { runs: boolean }): Promise<WindowUse | undefined> {
    let unreadable = false;
    let windowStatuses: readonly WindowStatus[] | undefined;
    if (this.deps.windowStatuses) {
      try {
        windowStatuses = await this.deps.windowStatuses();
      } catch (error) {
        unreadable = true;
        this.logger.warn(`The window status files could not be read: ${errorMessage(error)}.`);
      }
    }
    let pendings: readonly PendingConnection[] | undefined;
    try {
      pendings = await this.deps.sessionFiles.readPendings();
    } catch (error) {
      unreadable = true;
      this.logger.warn(`The pending connection files could not be read: ${errorMessage(error)}.`);
    }
    const now = this.deps.clock.now();
    // Review round 5 of PR #68 (A-R5-1): for a destructive check while no container of the environment runs (`check.runs`
    // false), the status files of other windows do not count (their files are still read: one that cannot be read keeps
    // the answer "not known").
    const windows = check?.runs === false ? [] : windowStatuses;
    const other = otherWindowUsesEnvironment(env.id, this.deps.owner.windowId, { now, isAlive: this.isAlive, windowStatuses: windows, pendings });
    if (other !== undefined) {
      // Review round 4 (A-R4-3): a pending connection file: that window opens the environment (it may still wait or build).
      return 'window' in other
        ? { known: true, use: 'connected', text: `The window ${other.window.windowId} is connected to it.` }
        : { known: true, use: 'opening', text: `The window ${other.pending.windowId} is opening the environment.` };
    }
    // Review round 5 of PR #68 (risk 2): for a destructive check while a container runs, a live window whose status file
    // is no longer fresh, but not stale by the Session Monitor's rule (its waiting time, and the sleep grace), may only
    // have missed its updates (computer sleep): it is not known whether it is connected.
    if (check?.runs === true && !unreadable) {
      const late = otherWindowMayUseEnvironment(env.id, this.deps.owner.windowId, {
        now,
        isAlive: this.isAlive,
        windowStatuses,
        waitingMs: waitingTimeMs(this.deps.settings()),
        grace: sleepGraceOfWindow(windowStatuses, this.deps.owner, now),
      });
      if (late !== undefined) {
        return { known: false, text: `The window ${late.windowId} (process ${late.pid}) last wrote its status at ${late.updatedAt}; it may still be connected to ${env.repository}.` };
      }
    }
    return unreadable ? { known: false, text: `It is not known whether another window is connected to ${env.repository}.` } : undefined;
  }

  /**
   * Review round 3 of PR #68 (A-R3-5): whether Environment.lifecycleIncomplete names `container`: its lifecycle commands
   * did not run, so it is not opened as it is.
   */
  private lifecycleIncomplete(ctx: PipelineContext, container: ContainerInfo | undefined): boolean {
    if (container === undefined) return false;
    // Review round 4 of PR #68 (B-R4-2): also a container that this window remembers because the mark could not be written.
    return [ctx.env.lifecycleIncomplete, this.unrecordedLifecycle.get(ctx.env.id)].some((mark) => mark !== undefined && sameContainer(mark, container.id));
  }

  /**
   * Review round 4 of PR #68 (A-R4-1): lifecycleIncomplete for a decision whether `container` opens as it is; the value
   * that the decision used is kept (PipelineContext.lifecycleMarkRead), so that finish clears only that one.
   */
  private decideOnLifecycleMark(ctx: PipelineContext, container: ContainerInfo | undefined): boolean {
    // The value that an earlier decision of this run read (the start of the pipeline, or Step 5) counts too, so that Step 5
    // and Step 9 decide with the same snapshot at least; a newer mark in the entry counts as well (when in doubt, `up`).
    const earlier = ctx.lifecycleMarkRead;
    ctx.lifecycleMarkRead = ctx.env.lifecycleIncomplete;
    if (container !== undefined && earlier !== undefined && sameContainer(earlier, container.id)) return true;
    return this.lifecycleIncomplete(ctx, container);
  }

  /** Review round 3 of PR #68 (A-R3-5): clears Environment.lifecycleIncomplete when it names `containerId` (the container is gone). */
  private async clearLifecycleMark(ctx: PipelineContext, containerId: string): Promise<void> {
    // Review round 4 of PR #68 (B-R4-2): also the mark that this window remembers.
    const unrecorded = this.unrecordedLifecycle.get(ctx.env.id);
    if (unrecorded !== undefined && sameContainer(unrecorded, containerId)) this.unrecordedLifecycle.delete(ctx.env.id);
    const mark = ctx.env.lifecycleIncomplete;
    if (mark === undefined || !sameContainer(mark, containerId)) return;
    await this.quietly('clear the mark of the container whose lifecycle commands did not run', () =>
      this.updateEntry(ctx, (entry) => {
        delete entry.lifecycleIncomplete;
      }),
    );
  }

  /**
   * Review round 2 of PR #68 (A-R2-3): the sentence of the detail of a failed switch of the dev service about the previous
   * dev container (PipelineContext.previousDevContainer): removed when its rename failed; else kept, stopped (it is stopped
   * here when it runs); or created again by Docker Compose as its own service (`up` returned), stopped too.
   */
  private async previousDevContainerAfterFailedSwitch(ctx: PipelineContext, previousService: string): Promise<string> {
    const previous = ctx.previousDevContainer;
    if (previous === undefined) return 'The previous dev container is kept, stopped.';
    if (previous.removed) return `The previous dev container ${previous.name} could not be renamed and was removed; its volumes are kept.`;
    let containers: ContainerInfo[];
    try {
      containers = await this.composeContainers(ctx.env);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The containers of ${ctx.env.repository} could not be listed: ${errorMessage(error)}`);
      return `The state of the previous dev container ${previous.name} is not known.`;
    }
    const stopped = async (container: ContainerInfo): Promise<boolean> => {
      if (container.state !== 'running') return true;
      try {
        await this.deps.docker.stopContainer(container.id);
        return true;
      } catch (error) {
        this.logger.warn(`The container ${container.name} could not be stopped: ${errorMessage(error)}`);
        return false;
      }
    };
    const same = containers.find((container) => container.id === previous.id);
    if (same !== undefined) return (await stopped(same)) ? 'The previous dev container is kept, stopped.' : 'The previous dev container is kept, but it could not be stopped.';
    const again = containers.find((container) => container.labels[COMPOSE_SERVICE_LABEL] === previousService);
    if (again !== undefined) {
      const state = (await stopped(again)) ? '' : ' It could not be stopped.';
      return `Docker Compose created the previous dev container again as the service ${previousService} (${again.name}); the files outside its volumes are gone.${state}`;
    }
    return `The previous dev container ${previous.name} is gone.`;
  }

  /**
   * Review round 22 (D22-1): the dev container `previous` of the service `previousService` of the project, while the
   * configuration names another dev service (compose.service), which gets the name of the environment. It is renamed to
   * the default name of Compose for its service, so that Compose creates it again as another service (and keeps its
   * volumes without a name, for example `node_modules`) and stopped (final review, FC-1: when the configuration does
   * not start that service, it stays as it is); when the rename fails, it is stopped and removed (its volumes stay),
   * as at a switch of the kind, and the user learns it. A container that an earlier failed attempt of Compose left in the
   * state `created` (`<id>_<name>`) is removed. The container of the new dev service is stopped before the Dev Container
   * CLI removes it (`--remove-existing-container`, D9-3).
   */
  private async movePreviousDevContainer(
    ctx: PipelineContext,
    compose: LoadedCompose,
    previous: ContainerInfo,
    previousService: string,
    removeExistingContainer: boolean,
  ): Promise<void> {
    // Review round 11 of PR #64 (R11-1): from here on, the switch of the dev service may have changed the containers.
    ctx.devServiceMoved = true;
    // Review round 5 of PR #68 (A-R5-3): for the guard of a failed switch (FF-1), whatever the build record holds.
    ctx.devServiceMovedFrom = previousService;
    const env = ctx.env;
    const { docker } = this.deps;
    const number = previous.labels[COMPOSE_CONTAINER_NUMBER_LABEL] ?? '1';
    const name = `${compose.project}-${previousService}-${number}`;
    this.logger.info(`The dev container ${previous.name} of ${env.repository} is of the service ${previousService}; the configuration uses the service ${compose.service}.`);
    let renamed = false;
    try {
      // Final review (FF-1): an earlier attempt (for example a failed switch) renamed it already; Docker refuses a rename
      // to the current name, and the container must never be removed for that.
      if (previous.name !== name) await docker.renameContainer(previous.id, name);
      renamed = true;
      // Review round 2 of PR #68 (A-R2-3): for the detail of a failed switch.
      ctx.previousDevContainer = { id: previous.id, name, removed: false, service: previousService };
      this.logger.info(`The container ${previous.name} is now ${name}; Docker Compose creates it again as the service ${previousService} when the configuration starts it.`);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The container ${previous.name} could not be renamed (${errorMessage(error)}). It is removed; its volumes are kept.`);
      ctx.steps.detail(Messages.containerComposeDevServiceChanged);
      ctx.previousDevContainer = { id: previous.id, name: previous.name, removed: false, service: previousService };
      await this.stopServiceBeforeRemoval(previous, env);
      await docker.removeContainer(previous.id);
      ctx.previousDevContainer = { id: previous.id, name: previous.name, removed: true, service: previousService };
      (ctx.kindSwitchRemoved ??= []).push(`the container ${previous.name} of the service ${previousService}`);
    }
    // Final review (FC-1): a renamed one is stopped (never removed, nor its volumes), as it keeps the labels of a dev
    // container: when the new configuration does not start its service (runServices, depends_on), Compose leaves it
    // alone, and a running one would outlive Stop. A failed switch leaves it startable: the next open with the previous
    // configuration starts it again.
    if (renamed) await this.stopContainerGracefully(ctx, { ...previous, name });
    for (const container of await this.composeContainers(env)) {
      if (container.id === previous.id) continue;
      if (container.rawState === 'created' && isComposeRecreateLeftoverName(container.name)) {
        this.logger.info(`The container ${container.name} that an earlier start of Docker Compose left behind is removed. Its volumes are kept.`);
        await docker.removeContainer(container.id);
      } else if (removeExistingContainer && container.labels[COMPOSE_SERVICE_LABEL] === compose.service) {
        await this.stopServiceBeforeRemoval(container, env);
      }
    }
  }

  /**
   * Review round 11 (G3, G4, G5): the paths of the repository that the ownership fixes leave to the services, computed
   * from facts (boundServiceFolders), in this order: `model` (the paths of the model of this run, with their real
   * paths), the paths that the existing containers of the other services mount (liveServiceFolders; read with the list of
   * the containers, one `docker inspect` for all of them), and the recorded paths (Environment.serviceFolders, of earlier
   * runs). With `existing` (after `up`, in the running dev container), a recorded path that neither the model nor a
   * container names is kept only while it still exists in the volume (existingServiceFolders). When the containers cannot
   * be read, the recorded list is kept whole: it never shrinks on an error.
   */
  private async serviceFolderFacts(
    env: Environment,
    model: readonly string[],
    existing?: { ctx: PipelineContext; container: string },
  ): Promise<{ folders: string[]; overflow: boolean }> {
    const repoFolder = repositoryFolder(env.repository);
    let live: string[] | undefined;
    try {
      live = liveServiceFolders(await this.composeContainers(env), env);
    } catch (error) {
      if (existing !== undefined && this.isCancellation(error, existing.ctx.signal)) throw error;
      this.logger.warn(`The mounts of the containers of the Docker Compose project of ${env.repository} could not be read: ${errorMessage(error)}`);
    }
    let recorded = serviceFoldersOf(env);
    if (existing !== undefined && live !== undefined) {
      const named = new Set([...model, ...live]);
      const retired = recorded.filter((folder) => !named.has(folder));
      if (retired.length > 0) {
        const found = await this.existingServiceFolders(existing.ctx, existing.container, retired);
        if (found !== undefined) {
          const dropped = retired.filter((folder) => !found.has(folder));
          if (dropped.length > 0) this.logger.info(`No longer in the volume of ${env.repository}, so no longer left to the services: ${dropped.join(', ')}.`);
          recorded = recorded.filter((folder) => named.has(folder) || found.has(folder));
        }
      }
    }
    const result = boundServiceFolders(repoFolder, [model, live, recorded], env.serviceFoldersOverflow === true);
    if (result.overflow && env.serviceFoldersOverflow !== true) {
      this.logger.warn(
        `More than ${MAX_SERVICE_FOLDERS} paths of ${env.repository} are mounted by other services: the ownership fixes give only the files of root in the repository their owner.`,
      );
    }
    return result;
  }

  /**
   * Review round 11 (G3): of `folders`, those that exist in the volume (EXISTING_PATHS_SCRIPT with `docker exec -u root`
   * in the running dev container `container`); `undefined` when that fails (the caller keeps them all).
   */
  private async existingServiceFolders(ctx: PipelineContext, container: string, folders: readonly string[]): Promise<Set<string> | undefined> {
    const found = new Set<string>();
    // In calls of at most EXISTING_PATHS_CHARACTERS characters of paths (the command line on Windows).
    const batches: string[][] = [[]];
    let characters = 0;
    for (const folder of folders) {
      if (characters + folder.length > EXISTING_PATHS_CHARACTERS && batches[batches.length - 1].length > 0) {
        batches.push([]);
        characters = 0;
      }
      batches[batches.length - 1].push(folder);
      characters += folder.length + 1;
    }
    try {
      for (const batch of batches) {
        const result = await this.deps.docker.exec(container, existingPathsCommand(batch), { user: 'root', signal: ctx.signal, timeoutMs: OWNERSHIP_TIMEOUT_MS });
        if (result.exitCode !== 0) {
          this.logger.warn(`The recorded paths of the services of ${ctx.env.repository} could not be checked: ${(result.stderr || result.stdout).trim()}`);
          return undefined;
        }
        for (const folder of parseExistingPaths(result.stdout)) found.add(folder);
      }
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The recorded paths of the services of ${ctx.env.repository} could not be checked: ${errorMessage(error)}`);
      return undefined;
    }
    return found;
  }

  /**
   * Review round 9 (D9-1), round 10 (D10-1), round 11 (G3, G5): writes `facts` (serviceFolderFacts) to
   * Environment.serviceFolders and Environment.serviceFoldersOverflow when they differ.
   */
  private async recordServiceFolders(ctx: PipelineContext, facts: { folders: string[]; overflow: boolean }): Promise<void> {
    const next = facts.folders;
    const own = ctx.env.serviceFolders ?? [];
    const sameOverflow = (ctx.env.serviceFoldersOverflow === true) === facts.overflow;
    if (sameOverflow && own.length === next.length && own.every((folder, i) => folder === next[i])) return;
    await this.updateEntry(ctx, (entry) => {
      if (next.length > 0) entry.serviceFolders = [...next];
      else delete entry.serviceFolders;
      if (facts.overflow) entry.serviceFoldersOverflow = true;
      else delete entry.serviceFoldersOverflow;
    });
  }

  /**
   * Review round 11 (G3, G4, G5): after `up` (finish), the list of the paths of the services from facts, written back to
   * the entry, for the ownership fix after `up`. `undefined` for an environment that neither is of Docker Compose nor has
   * recorded paths.
   */
  private async refreshServiceFolders(ctx: PipelineContext, container: string, loaded: LoadedConfiguration | undefined): Promise<ServiceFolders | undefined> {
    const env = ctx.env;
    const compose = loaded?.compose !== undefined || ctx.composeContainer === true || ctx.modelServiceFolders !== undefined;
    if (!compose && serviceFoldersOf(env).length === 0 && env.serviceFoldersOverflow !== true) return undefined;
    const facts = await this.serviceFolderFacts(env, ctx.modelServiceFolders ?? [], { ctx, container });
    await this.recordServiceFolders(ctx, facts);
    return facts.overflow ? 'repository' : facts.folders;
  }

  /**
   * Review round 9 (D9-2), round 11 (G3, G4): the paths of the repository with data of the services, relative to the
   * repository folder (`./data/postgres`), for the confirmation of Delete: the recorded paths and those that the existing
   * containers of the other services mount. Never throws: without Docker, the recorded paths.
   */
  async repositoryServiceData(environmentId: string): Promise<string[]> {
    const env = await this.deps.registry.get(environmentId);
    if (!env || !(await this.isOnCurrentHost(env))) return [];
    let folders: string[];
    try {
      folders = (await this.serviceFolderFacts(env, [])).folders;
    } catch (error) {
      this.logger.warn(`The paths of the services of ${env.repository} could not be read: ${errorMessage(error)}`);
      folders = serviceFoldersOf(env);
    }
    return repositoryServiceDataFolders({ repository: env.repository, serviceFolders: folders });
  }

  /**
   * Review round 1 (D2): the labels of the images of the other services that exist (the images that Compose pulls or
   * that the pipeline pulled, not those that Compose builds during `up`), as imageLabelItems names them.
   */
  private async serviceImageLabelItems(ctx: PipelineContext, compose: LoadedCompose): Promise<string[]> {
    const items: string[] = [];
    for (const reference of composeServiceImageReferences(compose.output.model, compose.service)) {
      let labels: Record<string, string>;
      try {
        labels = (await this.imageMetadataAndLabels(reference, ctx.signal)).labels;
      } catch (error) {
        if (this.isCancellation(error, ctx.signal)) throw error;
        // Not here yet: Compose pulls it in the workspace helper (a limit, implementation notes section 15).
        continue;
      }
      items.push(...imageLabelItems(reference, labels));
    }
    return items;
  }

  /**
   * Before `up` creates the containers of a Docker Compose configuration (D-7): the named volumes of the model and the
   * volumes of the `mounts` (composeMountVolumes) that do not exist are created with the labels of the environment, so
   * that they are its own and our model can declare them external: nimblescape.devenv.volume=compose for a volume of
   * the project (`<project>_<key>` of the model, the data of the services, and `<project>_<source>` of a `mounts`
   * entry, which the CLI puts into the project), `additional` for the other ones (a volume that the model or a mount
   * names itself, which another environment of the same owner may share). A `compose` volume is never shared with
   * another environment (isSameOwnerAdditionalVolume needs `additional`).
   */
  private async createComposeVolumes(ctx: PipelineContext, compose: LoadedCompose, mounts: { names: readonly string[]; sources: readonly string[] }): Promise<void> {
    const kinds = new Map<string, string>();
    for (const volume of composeVolumeNames(compose.output.model, compose.project)) {
      kinds.set(volume.name, volume.project ? VOLUME_KIND_COMPOSE : VOLUME_KIND_ADDITIONAL);
    }
    for (const source of mounts.sources) {
      const name = `${compose.project}_${source}`;
      if (!kinds.has(name)) kinds.set(name, VOLUME_KIND_COMPOSE);
    }
    for (const name of mounts.names) if (!kinds.has(name)) kinds.set(name, VOLUME_KIND_ADDITIONAL);
    // Review round 2 (D2-3): the volumes of the other services hold their data (whatever their kind): the label says so
    // also after a lost registry.
    const serviceData = new Set(composeServiceVolumeNames(compose.output.model, compose.project, compose.service));
    await this.createAdditionalVolumes(ctx, [...kinds.keys()], (name) => ({
      [LABEL_VOLUME]: kinds.get(name) ?? VOLUME_KIND_ADDITIONAL,
      ...(serviceData.has(name) ? { [LABEL_SERVICE_DATA]: SERVICE_DATA } : {}),
    }));
  }

  /**
   * The named volumes that the container of the environment mounts join its additional volumes (recordedVolumes).
   * `all`: the volumes of every container of the environment (the services of a Docker Compose configuration).
   */
  private async recordContainerVolumes(ctx: PipelineContext, all = false): Promise<void> {
    const containers = all ? await this.environmentContainers(ctx.env.id) : [await this.deps.docker.findContainer(ctx.env.id, ctx.env.containerName)];
    const volumes = await this.recordedVolumes(
      containers.flatMap((container) => container?.volumes ?? []),
      ctx.env,
    );
    await this.recordAdditionalVolumes(ctx, volumes);
  }

  /**
   * The volumes of `names` that the pipeline records as additional volumes of `env`: existing volumes, other than the
   * workspace volume, whose labels make them its own (isOwnVolume: nimblescape.devenv.environment-id and
   * nimblescape.devenv.owner-id), and existing additional volumes of other environments of the same owner
   * (isSameOwnerAdditionalVolume), which the environments of one account share (for example
   * `${localWorkspaceFolderBasename}-node_modules` of a fork and its upstream repository). Such a record only protects
   * the shared volume: the Delete of the other environment keeps a volume that another entry records, and the Delete of
   * this one never removes it (removableVolumes: not its own). Any other volume (an anonymous volume, a volume of
   * another program or account, a volume that Docker created at `up`) is never recorded, so Delete never removes it.
   */
  private async recordedVolumes(names: readonly string[], env: Pick<Environment, 'id' | 'volumeName' | 'owner'>): Promise<string[]> {
    const candidates = [...new Set(names)].filter((name) => name !== env.volumeName);
    if (candidates.length === 0) return [];
    const volumes = await this.deps.docker.inspectVolumes(candidates);
    const recorded = new Set(
      volumes
        .filter((volume) => isOwnVolume(volume.labels, env.id, env.owner.id) || isSameOwnerAdditionalVolume(volume.labels, env.owner.id))
        .map((volume) => volume.name),
    );
    return candidates.filter((name) => recorded.has(name));
  }

  /**
   * Before `up` creates a container: each named volume that it mounts (the configuration, the `runArgs` that Docker
   * gets, and the image metadata) and that does not exist yet is created with the labels of the environment
   * (additionalVolumeLabels), so that it is the environment's own; then the own volumes and the existing additional
   * volumes of other environments of the same owner are recorded (recordedVolumes). An existing volume keeps its labels
   * (Docker does not change them). A name with `${devcontainerId}` is not among them: the Dev Container
   * CLI 0.89.0 resolves it only at `up` (read-configuration substitutes it only for an existing container), so Docker
   * creates that volume without labels, and it is never the environment's (for a single container; the volumes of the
   * `mounts` of Docker Compose come with the real ID, composeMountVolumes, review round 17, D17-1). A volume that cannot
   * be created is logged:
   * Docker creates it at `up` without the labels, and Delete keeps it.
   */
  private async createAdditionalVolumes(ctx: PipelineContext, names: readonly string[], labelsOf?: (name: string) => Record<string, string>): Promise<void> {
    const env = ctx.env;
    const candidates = [...new Set(names)].filter((name) => name !== env.volumeName);
    if (candidates.length === 0) return;
    const inspected = await this.deps.docker.inspectVolumes(candidates);
    const existing = new Set(inspected.map((volume) => volume.name));
    // hotfix review 2, P5 (a known limit, docs/container-restrictions.md): an existing volume without labels is nobody's,
    // so every environment that mounts it by the same name shares it, also of another account.
    for (const volume of inspected) {
      if (Object.keys(volume.labels).length === 0) {
        this.logger.info(`The volume ${volume.name} exists without labels (created by Docker at a start, or by hand): it is not the environment's, and every environment that mounts it shares it.`);
      }
    }
    for (const name of candidates) {
      if (existing.has(name)) continue;
      this.throwIfCancelled(ctx.signal);
      try {
        await this.deps.docker.createVolume(name, labelsOf ? { ...volumeLabels(env), ...labelsOf(name) } : additionalVolumeLabels(env));
      } catch (error) {
        this.logger.warn(`The volume ${name} could not be created with the labels of the environment. Docker creates it at the start without them, and Delete keeps it: ${errorMessage(error)}`);
      }
    }
    await this.recordAdditionalVolumes(ctx, await this.recordedVolumes(candidates, env));
  }

  /**
   * Lifecycle token (user decision 2026-09-27): after `up --skip-post-create` (upArgs), the token goes into the container
   * of `result` (writeGitToken: a failure is a warning, and the commands run without the token, as before), then
   * `devcontainer run-user-commands` runs the lifecycle commands with the inputs of `up` (WorkspaceHelper.runUserCommands),
   * as `up` would have run them. The result of `up`, with `lifecycleCommandFailure` when a command failed and the container
   * runs (WorkspaceHelper.runUserCommands); throws the other failures, which the callers handle as failures of `up`
   * (keptAfterLifecycleFailure covers a failed command reported as an error). A result of `up` that reports a failed
   * command, or has no container, is returned as it is. `configUser`: the remote user of the configuration, when `up` names
   * none (as finish reads it).
   */
  private async runUserCommands(
    ctx: PipelineContext,
    result: DevcontainerResult & { lifecycleCommandFailure?: unknown },
    inputs: { override: Record<string, unknown>; files?: Record<string, string>; env?: Record<string, string> },
    configUser: string | undefined,
  ): Promise<DevcontainerResult & { lifecycleCommandFailure?: unknown }> {
    const containerId = nonEmptyString(result.containerId);
    if (containerId === undefined || nonEmptyString(result.lifecycleCommandFailure) !== undefined) return result;
    const env = ctx.env;
    const remoteUser = nonEmptyString(result.remoteUser) ?? env.remoteUser ?? configUser ?? 'root';
    await this.writeGitToken(ctx, containerId, remoteUser);
    ctx.tokenWrittenTo = containerId;
    // Review PL-2: Git older than 2.31 ignores GIT_CONFIG_COUNT and GIT_CONFIG_GLOBAL and reaches the credential helper of
    // the container only through ~/.gitconfig, so it is prepared before the commands (the script writes only a missing or
    // empty file, so also a started container gets it; a failure is logged, and the commands run all the same).
    await this.runHomeGitConfigScript(ctx, containerId, remoteUser);
    ctx.homeGitConfigWrittenTo = containerId;
    const commands = await this.deps.helper.runUserCommands({
      volumeName: env.volumeName,
      repository: env.repository,
      environmentId: env.id,
      containerId,
      ...inputs,
      // Review PL-1: the commands can read the token; the helper removes it from their output and from its errors.
      token: ctx.session.token,
      onOutput: this.output,
      image: ctx.helperImage,
      signal: ctx.signal,
    });
    const failure = nonEmptyString(commands.lifecycleCommandFailure);
    return failure === undefined ? result : { ...result, lifecycleCommandFailure: failure };
  }

  /**
   * `up` or run-user-commands failed because a lifecycle command failed (lifecycleHookFailure), and the container that it
   * created or started runs: the result for that container, with the description of the CLI in `lifecycleCommandFailure`.
   * Otherwise `undefined`. (WorkspaceHelper.up and runUserCommands return such a result themselves; this covers one that
   * is reported as an error.)
   */
  private async keptAfterLifecycleFailure(
    ctx: PipelineContext,
    error: unknown,
  ): Promise<(DevcontainerResult & { lifecycleCommandFailure: string }) | undefined> {
    if (this.isCancellation(error, ctx.signal) || !(error instanceof DevcontainerCommandError) || !error.result) return undefined;
    const containerId = nonEmptyString(error.result.containerId);
    if (containerId === undefined || lifecycleHookFailure(error.result) === undefined) return undefined;
    const container = await this.deps.docker.findContainer(ctx.env.id, ctx.env.containerName).catch(() => undefined);
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
    runArgs: readonly string[],
  ): Promise<DevcontainerResult> {
    this.logger.warn(`${description} The environment of ${ctx.env.repository} is opened anyway.`);
    this.deps.ui.warn(PipelineTexts.lifecycleCommandFailed(lifecycleHookName(description)));
    if (nonEmptyString(result.remoteUser) !== undefined) return result;
    try {
      // Not known when the label names it with a variable whose value is not known (hotfix review 2, P3): then none.
      const remoteUser = await this.imageUser(ctx, image, runArgs);
      return remoteUser === undefined ? result : { ...result, remoteUser };
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The remote user of ${image} could not be read: ${errorMessage(error)}`);
      return result;
    }
  }

  /**
   * The user that `devcontainer up` gives a container of `image` with the `runArgs` that it passes to Docker (label
   * devcontainer.metadata, as the CLI substitutes it at `up`, `--user` of the runArgs, and the user of the image; see
   * imageRemoteUser). `undefined` when it depends on a variable whose value is not known.
   */
  private async imageUser(ctx: PipelineContext, image: string, runArgs: readonly string[]): Promise<string | undefined> {
    return imageRemoteUser(await this.imageConfig(image, ctx.signal), runArgs, helperCliVariables(ctx.env.repository));
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
   * that the configuration mounts: the volumes of the environments of other accounts (their additional volumes), and the
   * volumes that the Delete of an environment of another account kept while they exist, except the volumes that `env`
   * recorded itself; and the labels of the volumes that exist.
   */
  private async hostAccessInput(
    env: Environment,
    input: Omit<HostAccessInput, 'ownVolume'>,
    moreVolumes: readonly string[] = [],
    moreNetworks: readonly string[] = [],
  ): Promise<HostAccessInput> {
    // Checked as the Dev Container CLI resolves the variables at `up` (helperCliVariables). Review round 18 (D18-1): the
    // runs of Docker Compose (composeMounts) get COMPOSE_PROJECT_NAME with the project name of the environment.
    const composeEnv: Record<string, string> = input.composeMounts === true ? { COMPOSE_PROJECT_NAME: composeProjectName(env.id) } : {};
    const checked: HostAccessInput = { ...input, ownVolume: env.volumeName, variables: helperCliVariables(env.repository, composeEnv) };
    const file = await this.deps.registry.read();
    const otherOwner = (owner: GitHubAccount) => owner.id !== env.owner.id;
    const others = file.environments.filter((other) => other.id !== env.id && otherOwner(other.owner));
    // `moreVolumes`: the named volumes of a Docker Compose model, whose labels its check needs too.
    const names = [...new Set([...mountedVolumeNames(checked), ...moreVolumes])];
    const volumeLabels: Record<string, Record<string, string>> = {};
    if (names.length > 0) for (const volume of await this.deps.docker.inspectVolumes(names)) volumeLabels[volume.name] = volume.labels;
    // A kept volume that was removed since (for example by `docker volume prune`) is no longer anybody's: a new one of that
    // name is empty. Its records are dropped, so that they do not protect the volume of that name that this start creates.
    const gone = names.filter((name) => !(name in volumeLabels) && (file.keptVolumes ?? []).some((record) => record.name === name));
    if (gone.length > 0) await this.deps.registry.forgetKeptVolumes(gone);
    const kept = (file.keptVolumes ?? []).filter((record) => otherOwner(record.owner) && record.name in volumeLabels);
    // A volume that the environment recorded itself stays its own: after a lost registry, the restored entries of two
    // accounts can both record a volume without labels of Dev Environments that their containers mount
    // (protectedMountedVolumes).
    const own = new Set(env.additionalVolumes ?? []);
    const foreignVolumes = [...others.flatMap((other) => other.additionalVolumes ?? []), ...kept.map((record) => record.name)].filter(
      (name) => !own.has(name),
    );
    const environment = { id: env.id, ownerId: env.owner.id };
    // Review round 1 (S2, S3): the networks that the configuration names, with their labels and containers, so that the
    // network of another environment is refused also under a name of its own.
    const networkNames = [...new Set([...runArgsNetworks(input.config?.runArgs), ...runArgsNetworks(input.merged?.runArgs), ...moreNetworks])];
    const networks = await this.networkStates(env, networkNames, file.environments);
    return { ...checked, foreignVolumes, volumeLabels, environment, networks };
  }

  /**
   * The networks of `names` (the references that the configuration writes) that exist (`docker network inspect`), each
   * under its reference (review round 2, S2-04: a name, an ID, or a unique prefix of an ID, resolveNetworkReference),
   * with its name, its labels, and the environments of the containers attached to it (label
   * nimblescape.devenv.environment-id), of which those of entries of the owner of `env` (review round 2, P2-2), for
   * foreignNetworkItem.
   */
  private async networkStates(env: Environment, names: readonly string[], entries: readonly Environment[]): Promise<Record<string, NetworkState>> {
    const states: Record<string, NetworkState> = {};
    if (names.length === 0) return states;
    const networks: NetworkInfo[] = await this.deps.docker.inspectNetworks(names);
    const environments = new Map<string, string>();
    if (networks.some((network) => network.containers.length > 0)) {
      for (const container of await this.deps.docker.listEnvironmentContainers()) {
        const id = container.labels[LABEL_ENVIRONMENT_ID];
        if (id !== undefined) environments.set(container.id, id);
      }
    }
    // An environment of no entry is never of the same owner.
    const owner = env.owner.id;
    const sameOwner = (id: string): boolean => entries.some((entry) => entry.id === id && entry.owner.id === owner);
    for (const reference of names) {
      const network = resolveNetworkReference(reference, networks);
      if (!network) continue;
      const ids = [...new Set(network.containers.map((id) => environments.get(id)).filter((id): id is string => id !== undefined))];
      states[reference] = { name: network.name, labels: network.labels, environments: ids, sameOwnerEnvironments: ids.filter(sameOwner) };
    }
    return states;
  }

  /**
   * Concept section 9 "Host access", before every `up`: the label devcontainer.metadata of the environment image holds
   * what `up` applies from the base image, the Features, and the configuration of the build (mounts, privileged mode,
   * capabilities). It also covers a configuration that could not be read, and Features that a build added after the
   * merged configuration was read. Throws UserFacingError('hostAccess'). Returns the named volumes that the metadata
   * mounts.
   */
  private async checkImageHostAccess(ctx: PipelineContext, image: string): Promise<string[]> {
    const { metadata, labels } = await this.imageMetadataAndLabels(image, ctx.signal);
    // The same switch as the check of the configuration (read at the start of this open).
    return this.checkMetadataHostAccess(ctx, image, metadata, ctx.hostAccessChecks, labels);
  }

  /** The entries of the label devcontainer.metadata of `image` (none when it has no valid label). */
  private async imageMetadata(image: string, signal: AbortSignal | undefined): Promise<unknown[]> {
    return (await this.imageMetadataAndLabels(image, signal)).metadata;
  }

  /** imageMetadata, and all labels of `image`. */
  private async imageMetadataAndLabels(image: string, signal: AbortSignal | undefined): Promise<{ metadata: unknown[]; labels: Record<string, string> }> {
    const config = await this.imageConfig(image, signal);
    const labels = isRecord(config) && isRecord(config.Labels) ? config.Labels : {};
    const stringLabels: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels)) if (typeof value === 'string') stringLabels[key] = value;
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
    return { metadata, labels: stringLabels };
  }

  /**
   * checkImageHostAccess for the metadata of `image` that was read already. `labels`: the labels of the image; those by
   * which the extension, the CLI, and Compose find containers stay refused whatever the switch says (imageLabelItems,
   * review round 1, D2), and so do `moreItems` (the labels of the images of the other services of Docker Compose).
   * `composeMounts`: the image of the dev service of Docker Compose (HostAccessInput.composeMounts).
   */
  private async checkMetadataHostAccess(
    ctx: PipelineContext,
    image: string,
    metadata: readonly unknown[],
    checks: HostAccessChecks,
    labels: Readonly<Record<string, string>> = {},
    moreItems: readonly string[] = [],
    composeMounts = false,
  ): Promise<string[]> {
    // Review round 15 (K1, K2): for Docker Compose, the `mounts` of the metadata also as the CLI writes them (composeMounts).
    const checked = await this.hostAccessInput(ctx.env, { metadata, ...(composeMounts ? { composeMounts: true } : {}) });
    const report = addRefusedItems(await this.check(ctx, 'imageMetadata', checked, checks), 'hostAccess', [...imageLabelItems(image, labels), ...moreItems]);
    if (!isRefused(report)) return mountedVolumeNames(checked);
    this.logger.warn(`The environment image ${image} of ${ctx.env.repository} is refused by the host access policy: ${describeRefusal(report)}`);
    throw new HostAccessError(report);
  }

  /**
   * Recorded volumes (recordedVolumes) join the additional volumes of the entry: Delete offers to remove the own ones
   * that no other entry records, and the policy refuses them to the environments of other accounts too.
   */
  private async recordAdditionalVolumes(ctx: PipelineContext, names: readonly string[]): Promise<void> {
    const added = names.filter((name) => name !== ctx.env.volumeName && !(ctx.env.additionalVolumes ?? []).includes(name));
    if (added.length === 0) return;
    await this.updateEntry(ctx, (entry) => {
      const current = entry.additionalVolumes ?? [];
      entry.additionalVolumes = [...current, ...added.filter((name) => !current.includes(name))];
    });
  }

  /**
   * Concept section 9 "Git inside the container": the Git configuration of the container, written into the volume once
   * per run, before `up` (unit 15: without the token, which goes into the memory of the container after its start,
   * writeGitToken). A failure is a warning: the environment
   * opens, but Git may not reach GitHub. Review round 11 of PR #64 (R11-2): before `up` (`beforeUp`), a helperFailed (the
   * helper image of the open is gone) ends the step instead, as `up` would fail the same way: nothing is removed for it.
   */
  private async prepareGit(ctx: PipelineContext, beforeUp = false): Promise<void> {
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
        identity,
        onOutput: this.output,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
    } catch (error) {
      if (this.isCancellation(error, ctx.signal) || isFilesMissing(error)) throw error;
      // Review round 11 of PR #64 (R11-2): before `up`, the caller handles the helperFailed (the open ends with it, user
      // decision 2026-09-29), without the warning about the Git configuration.
      if (beforeUp && isHelperFailed(error)) {
        ctx.helperUnavailable = true;
        throw error;
      }
      this.logger.error(`The Git configuration of ${env.repository} could not be written.`, error);
      this.deps.ui.warn(Messages.gitSetupFailed);
    }
  }

  /**
   * Unit 15 (concept section 9 "Git inside the container"): the token of the owner account and the sign-in of the GitHub
   * CLI as that account go into the tmpfs TOKEN_FOLDER of the running dev container (writeContainerToken: `docker exec
   * -i -u root`, the token on stdin only), owned by `user`. They stay there while the container runs, also without a
   * window, and are gone when it stops. A failure is a warning: the environment opens, but Git and the GitHub CLI in it
   * cannot reach GitHub as the owner account.
   */
  private async writeGitToken(ctx: PipelineContext, container: string, user: string): Promise<void> {
    const { token, account } = ctx.session;
    // The environment belongs to the account of the session (concept 7.5): the GitHub CLI there is signed in as it.
    if (!isGitHubLogin(account.login)) {
      this.logger.warn(`The GitHub login ${JSON.stringify(account.login)} is no valid GitHub login; the GitHub CLI in the container is not signed in.`);
    }
    try {
      const output = await writeContainerToken((c, command, options) => this.deps.docker.exec(c, command, options), {
        container,
        user,
        token,
        login: account.login,
        signal: ctx.signal,
        timeoutMs: GIT_EXEC_TIMEOUT_MS,
      });
      if (output !== '') this.logger.info(output);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.error(`The GitHub token could not be written into the container of ${ctx.env.repository}: ${errorMessage(error)}`);
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
   * Concept section 9, in a new container before the first attach (review PL-2: runUserCommands runs the script before
   * the lifecycle commands, runHomeGitConfigScript): the ~/.gitconfig of the remote user
   * (HOME_GIT_CONFIG_CONTENT: an include of the configuration of the volume, for Git older than 2.32 and for processes
   * without the variables of the container). Then the Git version of the container (checkGitVersion). A failure is
   * logged. Root may not write into the home folder of the user when the configuration takes rights away from the
   * container (for example `--cap-drop ALL`, concept section 9 "Host access"): then the user writes the file itself.
   */
  private async prepareHomeGitConfig(ctx: PipelineContext, container: string, user: string): Promise<void> {
    await this.runHomeGitConfigScript(ctx, container, user);
    await this.checkGitVersion(ctx, container, user);
  }

  /** The ~/.gitconfig of prepareHomeGitConfig, without the check of the Git version. A failure is logged. */
  private async runHomeGitConfigScript(ctx: PipelineContext, container: string, user: string): Promise<void> {
    let failure = await this.runHomeGitConfig(ctx, container, user, 'root');
    if (failure !== undefined && !isRootUser(user)) {
      this.logger.info(`The Git configuration of ${user} in the container could not be prepared as root: ${failure}. ${user} prepares it.`);
      failure = await this.runHomeGitConfig(ctx, container, user, user);
    }
    if (failure !== undefined) this.logger.warn(`The Git configuration of ${user} in the container could not be prepared: ${failure}`);
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
   * may use the forwarding credential helper of the Dev Containers extension (forwardingHelperReachesGit), so the user
   * gets a warning; Git 2.9 to 2.31 ignores GIT_CONFIG_GLOBAL and gets the configuration of the volume only through
   * ~/.gitconfig, which is logged. A container without Git needs nothing. Never fails the open.
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
      // The Dev Container CLI ignores runArgs for Docker Compose.
      configRemoteUser(loaded?.config, loaded?.compose ? undefined : stringList(loaded?.config.runArgs));
    const folder = repositoryFolder(env.repository);

    // Review round 11 (G3, G4, G5): the paths of the services from facts, written back after each `up`.
    const serviceFolders = await this.refreshServiceFolders(ctx, containerRef, loaded);
    if ((outcome.created || ctx.cloned) && remoteUser && !isRootUser(remoteUser)) {
      // Review round 9 (D9-1): without the paths that the other services mount (their data keeps its owner). Review
      // round 12 (D12-2): nor the paths where the dev container mounts other volumes.
      // Review round 16 (L2): the targets of the mounts are marked one by one (DevMountPaths), not the whole list.
      const dev = await this.withDevMountFolders(ctx, containerName, serviceFolders);
      await this.fixOwnership(ctx, containerRef, folder, remoteUser, dev.folders, dev.mounts);
      // The Git configuration was written before `up` with the owner of the repository folder (unit 15: the token is not there), which
      // is still root when the ownership fix before `up` did not run or failed. Review round 15 (K3): in a helper container
      // that mounts only the workspace volume, not in the dev container, whose mounts may lie in the folder.
      await this.fixConfigOwnership(ctx, containerRef, remoteUser);
    }
    if (outcome.created) {
      // Review PL-2: runUserCommands prepared ~/.gitconfig already, before the lifecycle commands; the Git version of the
      // new container is checked here as before (once per new container).
      if (ctx.homeGitConfigWrittenTo !== undefined && sameContainerId(ctx.homeGitConfigWrittenTo, containerRef)) {
        await this.checkGitVersion(ctx, containerRef, remoteUser ?? 'root');
      } else {
        await this.prepareHomeGitConfig(ctx, containerRef, remoteUser ?? 'root');
      }
    }
    // Unit 15: the container runs now, so its tmpfs can take the token (at every open: a new sign-in gives a new token).
    // Lifecycle token (user decision 2026-09-27): after `up`, runUserCommands wrote it already, before the lifecycle commands.
    if (ctx.tokenWrittenTo === undefined || !sameContainerId(ctx.tokenWrittenTo, containerRef)) {
      await this.writeGitToken(ctx, containerRef, remoteUser ?? 'root');
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
      // Unit 7, PR 2: Close and Keep Running holds only until a window connects again.
      delete entry.keepRunningOnce;
      // Review round 3 of PR #68 (A-R3-5): the container that opens ran its lifecycle commands now (or runs as it ran
      // before, and a mark of another container names one that this open replaced or that is gone). Review round 4
      // (A-R4-1): only the mark that this run decided with, or one that names the container whose lifecycle commands this
      // run ran; a mark that another window set meanwhile (Step 9 holds no busy mark) stays.
      if (lifecycleMarkClears(entry.lifecycleIncomplete, ctx.lifecycleMarkRead, ctx.lifecycleRanFor)) delete entry.lifecycleIncomplete;
      if (remoteUser) entry.remoteUser = remoteUser;
      entry.remoteWorkspaceFolder = remoteWorkspaceFolder;
      if (gitSummary) entry.gitSummary = gitSummary;
      // The own mark, and a mark that an ended window left behind (it protects nothing, see markBlocker). A live mark of
      // another window stays.
      if (entry.busy && (this.isOwnMark(entry.busy) || !blocks(entry.busy))) delete entry.busy;
    });
    ctx.busy = false;
    // Review round 4 of PR #68 (B-R4-2): the mark that this window remembers goes once the lifecycle commands of its
    // container ran.
    const unrecorded = this.unrecordedLifecycle.get(env.id);
    if (unrecorded !== undefined && ctx.lifecycleRanFor !== undefined && sameContainer(unrecorded, ctx.lifecycleRanFor)) this.unrecordedLifecycle.delete(env.id);
    this.logger.info(`${env.repository} is ready in the container ${containerName}.`);
    return { environment: ctx.env, containerName, remoteWorkspaceFolder };
  }

  /**
   * Implementation notes 7 "Ownership", before the container exists: the helper clones as root, and the lifecycle
   * commands (run-user-commands after `up`) run onCreateCommand and postCreateCommand as the remote user in a new
   * container. A command that writes to the repository (for example `npm install`) would fail, and with it the open. So the files get their owner first,
   * in a short-lived container of the environment image, which knows the user. The fix after `up` (fixOwnership) stays
   * for files that `up` itself creates as root. A failure is logged, it does not fail the pipeline.
   * Assumption (V-10): the environment image has sh, id, find, and chown, and its label devcontainer.metadata names the
   * remote user as the Dev Container CLI resolves it.
   */
  private async prepareOwnership(ctx: PipelineContext, image: string, runArgs: readonly string[]): Promise<void> {
    ctx.ownershipPrepared = true;
    const { docker } = this.deps;
    const env = ctx.env;
    const folder = repositoryFolder(env.repository);
    let cleanup: string | undefined;
    try {
      const user = await this.imageUser(ctx, image, runArgs);
      if (user === undefined) {
        // hotfix review 2, P3: the fix after `up` gives the files to the remote user that `up` reports.
        this.logger.info(`The remote user of ${image} is not known before the container is created (the label devcontainer.metadata names it with a variable of the Dev Container CLI): the files in ${folder} get their owner after the start.`);
        return;
      }
      if (isRootUser(user)) return;
      this.logger.info(`Giving the files in ${folder} to ${user} before the container is created.`);
      // Review round 9 (D9-1): after a new clone, no service has run on the files yet: every file gets its owner (also the
      // source folders that a service mounts). After a resumed clone, the paths of the services are left out. Review
      // round 12 (D12-1): on the path of a single container, runComposeUp has not computed them: from the facts
      // (serviceFolderFacts: the recorded paths and those of the existing containers).
      if (ctx.resumedClone === true && ctx.serviceFolders === undefined) {
        const facts = await this.serviceFolderFacts(env, []);
        ctx.serviceFolders = facts.overflow ? 'repository' : facts.folders;
      }
      const [shell, ...args] = ownershipFixCommand(folder, user, ctx.resumedClone === true ? ctx.serviceFolders : undefined);
      // Review round 1 of PR #82 (A-R1-1): a cleanup label of its own (channelStepLabel with a new value), by which a
      // cancel or a failure removes the container before anything removes the volume, and `--init`, so that a SIGTERM
      // ends `sh` (as PID 1 it would ignore it) and the container does not keep the volume.
      cleanup = newCleanupLabel();
      await docker.runChecked(
        [
          'run',
          '--rm',
          '--init',
          '--pull',
          'never',
          '--network',
          'none',
          '--label',
          `${LABEL_HELPER_RUN}=true`,
          '--label',
          channelStepLabel(cleanup),
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
      // Review round 1 of PR #82 (A-R1-1): the container of the run goes first (also after a cancel, before the error
      // reaches removeFailedFirstOpen and its volume removal).
      if (cleanup !== undefined) await this.removeOwnershipContainers(cleanup);
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The owner of the files in ${folder} could not be changed before the container was created: ${errorDetail(error)}`);
    }
  }

  /**
   * Review round 1 of PR #82 (A-R1-1): `docker rm -f` of the containers of a prepareOwnership run, by its cleanup label
   * (`docker ps -aq --no-trunc --filter label=…`). Without the signal of the operation, which may be aborted: under the
   * lock, both calls go through the worker that holds it. Best effort: a failure is logged.
   */
  private async removeOwnershipContainers(cleanup: string): Promise<void> {
    await this.quietly('remove the container of the ownership fix', async () => {
      const listed = await this.deps.docker.runChecked(['ps', '-aq', '--no-trunc', '--filter', `label=${channelStepLabel(cleanup)}`], {
        timeoutMs: IMAGE_INSPECT_TIMEOUT_MS,
      });
      for (const id of listed.split('\n').map((line) => line.trim()).filter((line) => line !== '')) await this.deps.docker.removeContainer(id);
    });
  }

  /**
   * Review round 12 (D12-2): `serviceFolders` with the paths of the repository at which the dev container mounts something
   * else than the workspace volume (devMountFolders, from `docker inspect` of the dev container: this covers the model of
   * Docker Compose, the `mounts` of devcontainer.json, and runArgs, for a single container too). They are not recorded:
   * they matter only in the dev container, where they are mounted. When the dev container cannot be read, the whole
   * repository (only the files of root change). Review round 13 (D13-1, D13-3): also the mounts of the workspace volume
   * below the repository, but not the anonymous volumes of the dev container while the host access checks are on.
   * Review round 16 (L2 = D16-2): with the targets of the mounts (`mounts`), which the fix marks one by one: a real path
   * in `.git` of a target is kept, that of a path of the services is not.
   */
  private async withDevMountFolders(
    ctx: PipelineContext,
    containerName: string,
    serviceFolders: ServiceFolders | undefined,
  ): Promise<{ folders: ServiceFolders | undefined; mounts: ReadonlySet<string> }> {
    const none: ReadonlySet<string> = new Set();
    if (serviceFolders === 'repository') return { folders: serviceFolders, mounts: none };
    const repository = repositoryFolder(ctx.env.repository);
    // Review round 15 (K4): the paths of the services without `.git` (their filter), before the targets of the mounts,
    // which may lie in `.git` (the list is passed to the fix with `gitPaths`).
    const records = serviceFolders === undefined ? undefined : serviceFolderPaths(repository, serviceFolders);
    let mounts: string[];
    try {
      const container = await this.deps.docker.findContainer(ctx.env.id, containerName);
      mounts = devMountFolders(container, ctx.env, ctx.hostAccessChecks, await this.workspaceIdentities(ctx, container));
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The mounts of the container of ${ctx.env.repository} could not be read: ${errorMessage(error)}`);
      return { folders: 'repository', mounts: none };
    }
    if (mounts.length === 0) return { folders: records, mounts: none };
    const bounded = boundServiceFolders(repository, [records, mounts], false, true);
    return bounded.overflow ? { folders: 'repository', mounts: none } : { folders: bounded.folders, mounts: new Set(mounts) };
  }

  /**
   * Review round 14 (P14-1): the targets of the mounts of the workspace volume in the dev container that show their folder
   * at its own canonical path (workspaceIdentityMounts), checked with `/proc/self/mountinfo` of the container
   * (verifiedIdentityTargets). When it cannot be read, none: the mounts stay protected.
   */
  private async workspaceIdentities(ctx: PipelineContext, container: ContainerInfo | undefined): Promise<Set<string>> {
    const candidates = workspaceIdentityMounts(container, ctx.env);
    if (container === undefined || candidates.length === 0) return new Set();
    try {
      const result = await this.deps.docker.exec(container.id, ['cat', '/proc/self/mountinfo'], { user: 'root', signal: ctx.signal, timeoutMs: OWNERSHIP_TIMEOUT_MS });
      if (result.exitCode === 0) return verifiedIdentityTargets(candidates, result.stdout);
      this.logger.info(`The mounts of the container of ${ctx.env.repository} could not be read: ${(result.stderr || result.stdout).trim()}`);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.info(`The mounts of the container of ${ctx.env.repository} could not be read: ${errorMessage(error)}`);
    }
    return new Set();
  }

  /**
   * Review round 15 (K3 = P15-1, D15-1, S15-3): the ownership fix of the extension's internal folder (CONFIG_FOLDER: the
   * token, the Git configuration, the folders of Docker and the GitHub CLI) runs in a container of the workspace helper
   * that mounts only the workspace volume (WorkspaceHelper.fixConfigOwnership), with the numeric user and group IDs of
   * the remote user, which `id -u` and `id -g` print as root in the dev container. In the dev container, a mount could
   * lie in the folder although no configuration may name a target there (configFolderTarget checks the text only): a
   * link of the repository in a target (`x -> ../.devenv+`, followed by the runtime inside the container), `volumes_from`
   * of a service that mounts there, or a tmpfs; the fix walked it in full and gave its files (for example the data of a
   * database, uid 999) to the remote user. The helper sees only the folder of the volume. Such a mount can still hide the
   * token and the Git configuration in the dev container, which breaks only the Git authentication of the owner. IDs that
   * are not decimal numbers skip the fix. A failure is logged, it does not fail the pipeline (as fixOwnership).
   */
  private async fixConfigOwnership(ctx: PipelineContext, container: string, user: string): Promise<void> {
    const folder = CONFIG_FOLDER;
    try {
      const ids: string[] = [];
      for (const flag of ['-u', '-g']) {
        const result = await this.deps.docker.exec(container, ['id', flag, user], { user: 'root', signal: ctx.signal, timeoutMs: OWNERSHIP_TIMEOUT_MS });
        const id = result.stdout.trim();
        if (result.exitCode !== 0 || !isNumericId(id)) {
          this.logger.warn(
            `The owner of the files in ${folder} could not be changed: \`id ${flag} ${user}\` in the container gave no user or group ID (${JSON.stringify((result.stderr || result.stdout).trim().slice(0, 200))}).`,
          );
          return;
        }
        ids.push(id);
      }
      const [uid, gid] = ids;
      this.logger.info(`Giving the files in ${folder} to ${user} (${uid}:${gid}) in a helper container.`);
      const result = await this.deps.helper.fixConfigOwnership({
        volumeName: ctx.env.volumeName,
        folder,
        uid,
        gid,
        timeoutMs: OWNERSHIP_TIMEOUT_MS,
        image: ctx.helperImage,
        signal: ctx.signal,
      });
      if (result.exitCode !== 0) {
        this.logger.warn(`The owner of the files in ${folder} could not be changed: ${(result.stderr || result.stdout).trim()}`);
      }
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The owner of the files in ${folder} could not be changed: ${errorMessage(error)}`);
    }
  }

  /** Implementation notes 7 "Ownership": the helper clones as root. A failure is logged, it does not fail the pipeline. */
  private async fixOwnership(
    ctx: PipelineContext,
    container: string,
    folder: string,
    user: string,
    serviceFolders?: ServiceFolders,
    gitPaths: DevMountPaths = false,
  ): Promise<void> {
    const except =
      serviceFolders === 'repository'
        ? ' of root only (more paths of the repository are mounted by other services than the ownership fix can name)'
        : serviceFolders !== undefined && serviceFolders.length > 0
          ? `, except ${serviceFolders.length > 20 ? `${serviceFolders.slice(0, 20).join(', ')} and ${serviceFolders.length - 20} more` : serviceFolders.join(', ')} (mounted by other services)`
          : '';
    this.logger.info(`Giving the files in ${folder} to ${user}${except}.`);
    try {
      const result = await this.deps.docker.exec(container, ownershipFixCommand(folder, user, serviceFolders, gitPaths), {
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

  /**
   * Stop: records the Git summary from the running container, then `docker stop`. Does not start Docker. The other
   * services of a Docker Compose environment are stopped after the dev container (D-20).
   */
  async stop(environmentId: string): Promise<void> {
    const environment = await this.deps.registry.get(environmentId);
    if (!environment) {
      this.logger.info(`Stop: the environment ${environmentId} does not exist.`);
      return;
    }
    await this.requireCurrentHost(environment);
    await this.requireOwnAccount(environment, false);
    await this.exclusive(repositoryKey(environment.repository), undefined, async () => {
      // Unit 7, PR 2: Stop ends Close and Keep Running (Keep Running When Closed stays).
      if ((await this.deps.registry.get(environmentId))?.keepRunningOnce !== undefined) {
        await this.quietly('clear Close and Keep Running', () =>
          this.deps.registry.updateEnvironment(environmentId, (entry) => {
            delete entry.keepRunningOnce;
          }),
        );
      }
      if (!(await this.deps.docker.isRunning())) {
        this.logger.info('Docker is not running, so no container runs.');
        return;
      }
      // An update, rebuild, or delete in another window replaces or removes the container: no stop in between (concept
      // 7.9 rule 1 applies to the Session Monitor; a Stop from a sidebar that is not up to date must respect it too).
      const env = await this.waitForOtherOperation((await this.deps.registry.get(environmentId)) ?? environment, undefined);
      // Plan step 5, PR B: under the lock of the environment on the Docker host (user decisions D1 to D3).
      await this.withEnvironmentLock(env, undefined, async () => {
        const container = await this.deps.docker.findContainer(env.id, env.containerName);
        if (!container || container.state !== 'running') {
          this.logger.info(`The container of ${env.repository} does not run.`);
          await this.stopServices(env);
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
        await this.stopServices(env);
      });
    });
  }

  /**
   * The containers of the other services of a Docker Compose environment (label nimblescape.devenv.compose-service) are
   * removed, before `up` creates a single container for a configuration that no longer uses Docker Compose. Their
   * volumes stay.
   */
  private async removeComposeServices(ctx: PipelineContext): Promise<void> {
    const services = (await this.environmentContainers(ctx.env.id)).filter((container) => container.labels[LABEL_COMPOSE_SERVICE] !== undefined);
    for (const container of services) {
      this.logger.info(
        `The configuration of ${ctx.env.repository} no longer uses Docker Compose: the container ${container.name} of the service ${container.labels[LABEL_COMPOSE_SERVICE]} is removed. Its volumes are kept.`,
      );
      await this.stopServiceBeforeRemoval(container, ctx.env);
      await this.deps.docker.removeContainer(container.id);
      (ctx.kindSwitchRemoved ??= []).push(`the container ${container.name} of the service ${container.labels[LABEL_COMPOSE_SERVICE]}`);
    }
  }

  /**
   * Review round 3 (D3-1, P3-3): after a failed `up` that switched a single container to Docker Compose, the containers of
   * the project that Compose created (composeContainers) are removed, and the networks of the project; their volumes
   * stay. Never a container of another environment, and never the previous single container (it is no container of
   * Compose). Review round 4 (D4-1): only when runComposeUp removed the single container in this run
   * (PipelineContext.composeSwitch), and never a container of Docker Compose that existed before its `up`; with such a
   * container, the networks stay too. Returns the removed ones (with their IDs, review round 3 of PR #68, A-R3-1) and the kept ones, for kindSwitchFailure; a failure is logged.
   */
  private async removeFailedComposeContainers(ctx: PipelineContext): Promise<{ removed: string[]; kept: string[]; removedIds: string[] }> {
    const env = ctx.env;
    const removed: string[] = [];
    const kept: string[] = [];
    // Review round 3 of PR #68 (A-R3-1): the IDs of the removed containers, in the order of `removed`.
    const removedIds: string[] = [];
    // Review round 4 (D4-1): only after a switch that removed the single container in this run; only the containers that
    // did not exist before its `up`.
    const existing = ctx.composeSwitch?.existing;
    if (existing === undefined) return { removed, kept, removedIds };
    const describe = (container: ContainerInfo): string =>
      container.labels[LABEL_COMPOSE_SERVICE] !== undefined ? `the container ${container.name} of the service ${container.labels[LABEL_COMPOSE_SERVICE]}` : `the container ${container.name}`;
    await this.quietly('remove the containers that the failed up of Docker Compose created', async () => {
      for (const container of await this.composeContainers(env)) {
        if (existing.has(container.id)) {
          kept.push(describe(container));
          continue;
        }
        this.logger.info(`The container ${container.name} that the failed start of Docker Compose created is removed. Its volumes are kept.`);
        // Review round 8 (P8-3): stopped first, as at Delete (D7-1).
        await this.stopServiceBeforeRemoval(container, env);
        await this.deps.docker.removeContainer(container.id);
        removed.push(describe(container));
        removedIds.push(container.id);
      }
    });
    if (kept.length === 0) await this.quietly('remove the networks of the Docker Compose project', () => this.removeComposeNetworks(env));
    return { removed, kept, removedIds };
  }

  /**
   * The containers of Docker Compose of the project of the environment (isComposeContainer), with the ID label of the
   * environment or without one; never a container of another environment, and never a single container.
   */
  private async composeContainers(env: Environment): Promise<ContainerInfo[]> {
    const project = composeProjectName(env.id);
    const containers = [...(await this.environmentContainers(env.id)), ...(await this.deps.docker.listProjectContainers(project))];
    const seen = new Set<string>();
    const result: ContainerInfo[] = [];
    for (const container of containers) {
      if (seen.has(container.id)) continue;
      seen.add(container.id);
      const owner = container.labels[LABEL_ENVIRONMENT_ID];
      if ((owner !== undefined && owner !== env.id) || !isComposeContainer(container.labels, project)) continue;
      result.push(container);
    }
    return result;
  }

  private async composeContainerIds(env: Environment): Promise<ReadonlySet<string>> {
    return new Set((await this.composeContainers(env)).map((container) => container.id));
  }

  /**
   * The networks that Docker Compose created for the project of the environment (label com.docker.compose.project), once
   * no container of the project uses them. A network that cannot be removed is logged.
   */
  private async removeComposeNetworks(env: Environment): Promise<void> {
    for (const network of await this.deps.docker.listProjectNetworks(composeProjectName(env.id))) {
      try {
        await this.deps.docker.removeNetwork(network);
      } catch (error) {
        this.logger.warn(`The network ${network} could not be removed: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * The running containers of the other services of a Docker Compose environment are stopped (label
   * nimblescape.devenv.compose-service).
   */
  /**
   * Review round 7, D7-1: a running container of another service of Docker Compose (label
   * nimblescape.devenv.compose-service) is stopped before `docker rm -f` removes it (review round 9, D9-3: also a dev
   * container), so that it can shut down cleanly (for example a database whose volume is kept) instead of a SIGKILL.
   * `docker stop` gives it its own stop time (`stop_grace_period`, which the policy caps at 20 s, else 10 s). A failed
   * stop is logged; the removal follows anyway.
   */
  private async stopServiceBeforeRemoval(container: ContainerInfo, env: Environment): Promise<void> {
    if (container.state !== 'running') return;
    // Review round 9 (D9-3): the dev container too (its stop time is capped by the policy as well: `--stop-timeout`).
    const service = container.labels[LABEL_COMPOSE_SERVICE];
    this.logger.info(`Stopping the container ${container.name}${service !== undefined ? ` of the service ${service}` : ''} of ${env.repository} before it is removed.`);
    try {
      await this.deps.docker.stopContainer(container.id);
    } catch (error) {
      this.logger.warn(`The container ${container.name} could not be stopped, it is removed anyway: ${errorMessage(error)}`);
    }
  }

  /**
   * Final review (FC-1): `docker stop` of a container that is kept, with its own stop time (capped by the policy, as for
   * stopServiceBeforeRemoval). A failed stop is logged; a cancellation throws.
   */
  private async stopContainerGracefully(ctx: PipelineContext, container: ContainerInfo): Promise<void> {
    if (container.state !== 'running') return;
    this.logger.info(`Stopping the container ${container.name} of ${ctx.env.repository}.`);
    try {
      await this.deps.docker.stopContainer(container.id);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The container ${container.name} could not be stopped: ${errorMessage(error)}`);
    }
    this.throwIfCancelled(ctx.signal);
  }

  private async stopServices(env: Environment): Promise<void> {
    const services = (await this.environmentContainers(env.id)).filter(
      (container) => container.labels[LABEL_COMPOSE_SERVICE] !== undefined && container.state === 'running',
    );
    for (const container of services) {
      this.logger.info(`Stopping the container ${container.name} of the service ${container.labels[LABEL_COMPOSE_SERVICE]} of ${env.repository}.`);
      await this.deps.docker.stopContainer(container.id);
    }
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
    await this.requireCurrentHost(env);
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
    await this.requireCurrentHost(environment);
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
      // Plan step 5, PR B: the busy mark first, then the lock of the environment on the Docker host (user decisions D1 to
      // D3); both are released in `finally`.
      await this.withEnvironmentLock(env, options.signal, async () => {
        // Step 3: container, environment image, unused base images.
        const containers = (await docker.listEnvironmentContainers()).filter((c) => c.labels[LABEL_ENVIRONMENT_ID] === env.id);
        for (const container of containers) {
          await this.stopServiceBeforeRemoval(container, env);
          await docker.removeContainer(container.id);
        }
        // Review round 9 (D9-3): a dev container of the name without the ID label (for example relabelled by hand) is
        // stopped first too.
        const dev = await docker.findContainer(env.id, env.containerName).catch(() => undefined);
        if (dev !== undefined) await this.stopServiceBeforeRemoval(dev, env);
        await docker.removeContainer(env.containerName);
        // Docker Compose: the other containers, the networks, and the built images of the project too.
        const compose = composeRecordOf(env.buildRecord) !== undefined || containers.some((c) => isComposeContainer(c.labels, composeProjectName(env.id)));
        if (compose) await this.removeComposeProject(env, false);
        await this.removeEnvironmentImages(env, undefined, env.buildRecord);
        // Step 4: the workspace volume; additional volumes only when the user confirmed it.
        await this.removeVolumeWithRetry(env.volumeName);
        const removedVolumes =
          options.additionalVolumesToRemove.length > 0 ? await this.removeAdditionalVolumes(env, options.additionalVolumesToRemove) : [];
        // Step 5: the registry entry and the files that reference the environment. The additional volumes that stay keep
        // their owner in the registry: the environments of other accounts must not mount them (concept section 9).
        const keptVolumes = await this.existingVolumes((env.additionalVolumes ?? []).filter((name) => !removedVolumes.includes(name)));
        await this.deps.registry.remove(env.id, { kept: keptVolumes, removed: removedVolumes });
        removed = true;
      });
      await this.removeEnvironmentFiles(env.id);
      // Unit 7, PR 2: the heartbeat record of this computer on the remote host (best effort).
      const host = dockerHostOf(env);
      if (host !== '' && this.deps.remoteMonitor) {
        await this.quietly('remove the heartbeat record on the remote host', () => this.deps.remoteMonitor!.forget(host, env.id));
      }
      this.logger.info(`The environment of ${env.repository} was deleted.`);
    } finally {
      if (!removed) await this.clearOwnMark(env.id);
    }
  }

  /**
   * Whether the containers of an environment use Docker Compose, as the pipeline tells them before a switch of the kind
   * (review round 3, D3-2; round 4, D4-2): its dev container `container`, or else a container of another service of
   * Docker Compose (true); `undefined` without either.
   */
  private async containersUseCompose(env: Environment, container: ContainerInfo | undefined): Promise<boolean | undefined> {
    if (container !== undefined) return isComposeContainer(container.labels, composeProjectName(env.id));
    return (await this.environmentContainers(env.id)).some((other) => other.labels[LABEL_COMPOSE_SERVICE] !== undefined) ? true : undefined;
  }

  /** Configuration paths in the volume (current branch), in the order of precedence. */
  async listConfigurations(environmentId: string, options: OperationOptions): Promise<string[]> {
    const env = await this.deps.registry.get(environmentId);
    if (!env) return [];
    await this.requireCurrentHost(env);
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

  /**
   * Container and volume state of each environment. Does not start Docker: `undefined` when Docker does not run. Review
   * D2: no Docker call at all on an endpoint that is neither local nor SSH; its (empty) map of states. Plan step 5, PR C:
   * refreshStates without branches.
   */
  async inspectStates(): Promise<Map<string, EnvironmentRuntimeState> | undefined> {
    return (await this.refreshStates(new Set())).runtime;
  }

  /**
   * Plan step 5, PR C: the states of inspectStates and the branches of the running dev containers of `branchIds` (the
   * sidebar: the environments of the account), in one worker operation (`refresh`); outside of an operation directly
   * (readEnvironmentStates). Plan step 5, PR D (rule D1 of 2026-09-30): a worker refresh that cannot be made or fails is
   * never read directly: the refresh fails (logged, with the cause). `runtime` is `undefined` when Docker does not run or
   * the states could not be read; then there are no branches.
   */
  async refreshStates(
    branchIds: ReadonlySet<string>,
  ): Promise<{ runtime: Map<string, EnvironmentRuntimeState> | undefined; branches: Map<string, string> }> {
    const { docker } = this.deps;
    try {
      const readable = await this.readableDockerHost();
      if (readable === undefined) return { runtime: new Map(), branches: new Map() };
      if (!(await docker.isRunning())) return { runtime: undefined, branches: new Map() };
      // Unit 7: only the environments of the current Docker host; the others are hidden.
      const environments: StateEnvironment[] = environmentsOfHost(await this.deps.registry.list(), readable).map((env) => ({
        id: env.id,
        containerName: env.containerName,
        volumeName: env.volumeName,
        ...(env.remoteUser ? { user: env.remoteUser } : {}),
        folder: repositoryFolder(env.repository),
        branch: branchIds.has(env.id),
      }));
      // Plan step 5, PR D (rule D1 of 2026-09-30): a failure of the worker refresh fails the refresh (below).
      return (await this.deps.workerRefresh?.(environments)) ?? (await readEnvironmentStates(docker, environments));
    } catch (error) {
      this.logger.warn(`The state of the environments could not be read: ${errorMessage(error)}`);
      return { runtime: undefined, branches: new Map() };
    }
  }

  /** Current branch from the running container (`git branch --show-current` through `docker exec`). */
  async currentBranch(environmentId: string): Promise<string | undefined> {
    const env = await this.deps.registry.get(environmentId);
    if (!env || !(await this.isOnCurrentHost(env))) return undefined;
    const branch = await this.branchInContainer(env.containerName, env.remoteUser, repositoryFolder(env.repository));
    return branch ?? undefined;
  }

  /**
   * Registry lost (concept 7.5): adds an entry for each volume with the label nimblescape.devenv.environment-id that
   * the registry lacks, with the owner of its label nimblescape.devenv.owner-id; a volume without a valid owner label
   * is skipped. A volume of a repository of which the owner account has an environment already is not added: one
   * environment per repository and account (concept D-3). The additional volumes of an entry are its own labelled
   * volumes (nimblescape.devenv.volume, isOwnVolume), the additional volumes of other environments of the same owner
   * that its surviving container mounts (isSameOwnerAdditionalVolume), and the volumes without labels of Dev
   * Environments that it mounts (protectedMountedVolumes), which protect them from other accounts and from the Delete
   * of the other environments; Delete removes only the own ones. The entries have no build record, so the next
   * connection with internet access rebuilds the container. Returns the number of added entries. Does not start Docker.
   */
  async reconcileFromVolumes(): Promise<number> {
    const { docker } = this.deps;
    // Review D2: never on an endpoint that is neither local nor SSH (it would be recorded as the host of the entries).
    const readable = await this.readableDockerHost();
    if (readable === undefined) return 0;
    if (!(await docker.isRunning())) return 0;
    // Unit 7: the volumes of the current Docker host only; the restored entries record it.
    const dockerHost = readable;
    const volumes = await docker.listEnvironmentVolumes();
    const now = isoTime(this.deps.clock);
    const candidates: Environment[] = [];
    const additional: VolumeInfo[] = [];
    for (const volume of volumes) {
      // An additional volume (nimblescape.devenv.volume) joins the entry of its environment below.
      if (volume.labels[LABEL_VOLUME] !== undefined) {
        additional.push(volume);
        continue;
      }
      const id = volume.labels[LABEL_ENVIRONMENT_ID];
      const repository = volume.labels[LABEL_REPOSITORY];
      const ownerId = volume.labels[LABEL_OWNER_ID];
      if (!isStorageId(id) || !isRepositoryName(repository) || !isStorageId(ownerId)) {
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
      candidates.push({
        id,
        repository,
        configPath: DEFAULT_CONFIG_PATH,
        volumeName: volume.name,
        containerName: volume.name,
        createdAt: now,
        lastUsedAt: now,
        owner: { id: ownerId, login: '' },
        ...dockerHostField(dockerHost),
      });
    }
    if (candidates.length === 0) return 0;
    // The additional volumes are not on the workspace volume: they are found by their labels, which make them the
    // environment's own (isOwnVolume), as the pipeline records them.
    const containers = await docker.listEnvironmentContainers();
    for (const candidate of candidates) {
      const labelled = additional
        .filter((volume) => isOwnVolume(volume.labels, candidate.id, candidate.owner.id))
        .map((volume) => volume.name)
        .filter((name) => name !== candidate.volumeName);
      const mounted = containers
        .filter((container) => container.labels[LABEL_ENVIRONMENT_ID] === candidate.id)
        .flatMap((container) => container.volumes ?? []);
      // An additional volume of another environment of the same owner that the container mounts: recorded again, so that
      // the Delete of that environment keeps it, as the pipeline records it (recordedVolumes).
      const shared = additional
        .filter((volume) => mounted.includes(volume.name) && isSameOwnerAdditionalVolume(volume.labels, candidate.owner.id))
        .map((volume) => volume.name)
        .filter((name) => name !== candidate.volumeName);
      const volumes = [...new Set([...labelled, ...shared, ...(await this.protectedMountedVolumes(mounted, candidate.volumeName))])];
      if (volumes.length > 0) candidate.additionalVolumes = volumes;
      // Review round 2 (D2-3): the volumes that the pipeline created for the other services of Docker Compose.
      const serviceVolumes = additional
        .filter((volume) => labelled.includes(volume.name) && volume.labels[LABEL_SERVICE_DATA] === SERVICE_DATA)
        .map((volume) => volume.name);
      if (serviceVolumes.length > 0) candidate.serviceVolumes = serviceVolumes;
      // Review round 11 (G4): the paths of the repository that the containers of the other services mount, so that
      // the ownership fixes leave their data alone before the next open writes the list.
      const serviceFolders = boundServiceFolders(repositoryFolder(candidate.repository), [
        liveServiceFolders(
          containers.filter((container) => container.labels[LABEL_ENVIRONMENT_ID] === candidate.id),
          candidate,
        ),
      ]);
      if (serviceFolders.folders.length > 0) candidate.serviceFolders = serviceFolders.folders;
      if (serviceFolders.overflow) candidate.serviceFoldersOverflow = true;
      // Review round 4 (D4-2): the configuration path of the label nimblescape.devenv.config-path of its dev container,
      // when it is a configuration path of a repository (isConfigPathLabelValue); else the default one. Review round 6
      // (S6-2): only the dev container (a container without nimblescape.devenv.compose-service) counts; the label of
      // another service can come from its image.
      const labelledPath = containers.find(
        (container) =>
          container.labels[LABEL_ENVIRONMENT_ID] === candidate.id && container.labels[LABEL_COMPOSE_SERVICE] === undefined && container.labels[LABEL_CONFIG_PATH] !== undefined,
      )?.labels[LABEL_CONFIG_PATH];
      if (labelledPath !== undefined) {
        if (isConfigPathLabelValue(labelledPath)) candidate.configPath = labelledPath;
        else this.logger.warn(`The containers of the volume ${candidate.volumeName} name the configuration ${JSON.stringify(labelledPath)}, which is no configuration path. The default configuration is used.`);
      }
    }
    const skipped: string[] = [];
    const added = await this.deps.registry.update((file) => {
      let count = 0;
      for (const candidate of candidates) {
        if (file.environments.some((e) => e.id === candidate.id || e.volumeName === candidate.volumeName)) continue;
        if (file.environments.some((e) => isEnvironmentOf(e, candidate.repository, candidate.owner.id, dockerHost))) {
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

  /**
   * Registry lost: the named volumes without labels of Dev Environments that the container of a restored environment
   * mounts (the container, which a lost registry does not remove, still mounts them), for example volumes that Docker
   * created at `up` without labels. Recorded again, they protect the data of the environment: without them, the
   * environment of another account could mount them (the host access policy refuses the recorded volumes of other
   * accounts). Delete never removes them (removableVolumes: they are not the environment's own). Not a volume that the
   * policy gives to something else by its name (the workspace volume, an anonymous volume, a volume of the Dev
   * Containers extension, of the helper, or of another environment, foreignVolumeName) or by its labels
   * (volumeLabelOwner: Docker Compose, the Dev Containers extension, an anonymous volume, a volume of an environment),
   * and not a volume that does not exist.
   */
  private async protectedMountedVolumes(names: readonly string[], workspaceVolume: string): Promise<string[]> {
    const candidates = [...new Set(names)].filter((name) => name !== workspaceVolume && foreignVolumeName(name) === undefined);
    if (candidates.length === 0) return [];
    const labels = new Map((await this.deps.docker.inspectVolumes(candidates)).map((volume) => [volume.name, volume.labels]));
    return candidates.filter((name) => {
      const volumeLabelsOf = labels.get(name);
      return volumeLabelsOf !== undefined && volumeLabelOwner(volumeLabelsOf) === undefined;
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Steps and helpers

  /**
   * Unit 7, review D2: the one check of the Docker target of the service. The target of the operation (dockerTarget),
   * else the host of `dockerHost` (local or SSH).
   */
  private async dockerTarget(): Promise<Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>> {
    if (this.deps.dockerTarget) return this.deps.dockerTarget();
    const host = (await this.deps.dockerHost?.()) ?? '';
    return { kind: host === '' ? 'local' : 'remote', host, endpoint: '' };
  }

  /**
   * Unit 7: the Docker host of the operation ('' = the local Docker). Review D2: an endpoint that is neither local nor
   * SSH is refused (UserFacingError dockerEndpointUnsupported), so no operation reaches it or records it.
   */
  private async currentDockerHost(): Promise<string> {
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
  private async readableDockerHost(): Promise<string | undefined> {
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

  private async isOnCurrentHost(environment: Environment): Promise<boolean> {
    const host = await this.readableDockerHost();
    return host !== undefined && isOnDockerHost(environment, host);
  }

  /**
   * Unit 7: an environment of another Docker host is never acted on (no clone, restore, recreation, deletion, stop, or
   * token write there): UserFacingError('otherDockerHost').
   */
  private async requireCurrentHost(environment: Environment): Promise<void> {
    const host = await this.currentDockerHost();
    if (isOnDockerHost(environment, host)) return;
    const environmentHost = dockerHostOf(environment);
    this.logger.warn(`${environment.repository}: the environment is on the Docker host ${environmentHost || '(local)'}, and Docker is set to ${host || '(local)'}. Nothing is done.`);
    throw new UserFacingError('otherDockerHost', Messages.otherDockerHost(environment.repository, environmentHost, host));
  }

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
   * the helper follows the setting updateImagesOnConnect, like the image check (concept 7.7). Review round 2 of PR #64
   * (A-N1): the first call of a run resolves the helper image of the run (ctx.helperImage); later calls do nothing.
   */
  private async prepareHelper(ctx: PipelineContext): Promise<void> {
    // Review round 2 of PR #64 (A-N1): the helper image is resolved once per run.
    if (ctx.helperImage !== undefined) return;
    let announced = false;
    const announce = (text: string): void => {
      if (announced) return;
      announced = true;
      ctx.steps.detail(text);
    };
    let image: HelperImageUse;
    try {
      // Review round 3 of PR #64 (P1): the helper image of the open is the one that this call awaited (its return value),
      // never learned from a callback, so a reset of the cache of the window meanwhile cannot lose the ID of the image.
      image = await this.deps.helper.ensureImageUse({
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
    // Review round 3 of PR #64 (P2): pinned by the ID of its image, for the current tag too.
    ctx.helperImage = { ...image };
    await this.ensureRemoteMonitor(ctx, image);
  }

  /**
   * Unit 7, PR 2: on a remote Docker host, the Session Monitor container there (with the helper image just ensured), and
   * the first heartbeat of this computer for the environment, once per run and before the container is created or
   * started: the remote monitor acts only on environments with a record, so this keeps the stop without contact for
   * every remote environment. The keep-running flag follows the rules of the local Session Monitor (keptWhenClosed). A
   * failure of either is logged as a warning and does not fail the open (the local Session Monitor sends heartbeats on
   * its ticks). Review round 3 of PR #64 (P2): the monitor gets the tag for its label and the log lines, and the ID of the
   * helper image of the open as the image of its `docker run`, like every helper run of the open;
   * the tag only when the ID could not be read.
   */
  private async ensureRemoteMonitor(ctx: PipelineContext, image: HelperImageUse): Promise<void> {
    const remoteMonitor = this.deps.remoteMonitor;
    if (!remoteMonitor || ctx.remoteMonitorEnsured) return;
    const target = await this.dockerTarget();
    if (target.kind !== 'remote') return;
    ctx.remoteMonitorEnsured = true;
    try {
      // Review round 1 of PR #64 (S1), review round 3 of PR #64 (P2): by the ID of the image that the open pinned.
      await remoteMonitor.ensure(target.host, image.tag, ctx.signal, image.id);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The Session Monitor on ${target.host} could not be started: ${errorMessage(error)}`);
    }
    this.throwIfCancelled(ctx.signal);
    // User requests 2026-09-28: the list of image repositories for the image maintenance of the monitor.
    try {
      await remoteMonitor.images?.(target.host, ctx.signal);
    } catch (error) {
      if (this.isCancellation(error, ctx.signal)) throw error;
      this.logger.warn(`The image list for the Session Monitor on ${target.host} could not be sent: ${errorMessage(error)}`);
    }
    this.throwIfCancelled(ctx.signal);
    // Review round 2 of PR #39 (L1): `seq` is the time at which the flags are read; the entry is read again for them.
    const seq = this.deps.clock.now();
    const env = (await this.deps.registry.get(ctx.env.id)) ?? ctx.env;
    const settings = this.deps.settings();
    const keepRunning =
      env.keepRunning === true ||
      env.keepRunningOnce === true ||
      settings.stopOnClose === false ||
      (settings.respectShutdownActionNone === true && env.shutdownActionNone === true);
    try {
      const sent = await remoteMonitor.heartbeat(target.host, env.id, keepRunning, seq);
      if (!sent.ok) {
        this.logger.warn(`The first heartbeat for ${env.repository} to the Session Monitor on ${target.host} failed; the Session Monitor of this computer tries again. ${sent.detail}`);
      }
    } catch (error) {
      this.logger.warn(`The first heartbeat for ${env.repository} to the Session Monitor on ${target.host} failed: ${errorMessage(error)}`);
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
        image: ctx.helperImage,
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
   * Docker Compose: the images that Compose built for the project (BuildRecord.compose.images of `oldRecord`) go too,
   * except those of `keepCompose` (the images of the new build record, which have the same names).
   */
  private async removeEnvironmentImages(
    env: Environment,
    keep: string | undefined,
    oldRecord: BuildRecord | undefined,
    keepCompose: readonly string[] = [],
  ): Promise<void> {
    const repository = environmentImageRepository(env.id);
    const images = new Set<string>();
    try {
      for (const tag of await this.deps.docker.listImageTags(repository)) images.add(tag);
    } catch (error) {
      this.logger.warn(`The tags of ${repository} could not be listed: ${errorMessage(error)}`);
    }
    if (oldRecord) images.add(oldRecord.environmentImage);
    for (const image of composeRecordOf(oldRecord)?.images ?? []) if (!keepCompose.includes(image)) images.add(image);
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
    // Review round 1 (D5): the images of the other services of Docker Compose that are not built (for example
    // `postgres:16`) are images of the user, not base images of the environment image (concept 7.7 "Disk space" removes
    // only base images).
    const serviceImages = new Set(composeRecordOf(oldRecord)?.serviceImages ?? []);
    for (const [reference, digest] of Object.entries(oldRecord.images)) {
      if (inUse.has(baseImageKey(reference, digest)) || serviceImages.has(reference)) continue;
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
   * The additional volumes that Delete of `environmentId` would remove (removableVolumes), for the question of Delete:
   * it lists only these, and keeps the others. Empty when the environment or Docker does not answer. Without the
   * volumes of a Docker Compose project (nimblescape.devenv.volume=compose), which removableServiceDataVolumes lists
   * for a question of their own.
   */
  async removableAdditionalVolumes(environmentId: string): Promise<string[]> {
    return (await this.removableVolumesByKind(environmentId)).filter((volume) => volume.kind !== VOLUME_KIND_COMPOSE).map((volume) => volume.name);
  }

  /**
   * The volumes of the Docker Compose project of `environmentId` that Delete would remove
   * (nimblescape.devenv.volume=compose, D-19): the data of its services, for example of a database. The question of
   * Delete lists them apart, none ticked: they are removed only when the user ticks them. Empty when the environment or
   * Docker does not answer.
   */
  async removableServiceDataVolumes(environmentId: string): Promise<string[]> {
    return (await this.removableVolumesByKind(environmentId)).filter((volume) => volume.kind === VOLUME_KIND_COMPOSE).map((volume) => volume.name);
  }

  /**
   * Review round 3 (P3-4): of removableServiceDataVolumes, the volumes that are listed there only because the entry
   * knows neither the volumes of its services nor its build (review round 2, D2-3): additional volumes that may hold data
   * of services, or not (for example of a single container restored from its volumes). The question names them so.
   */
  async possibleServiceDataVolumes(environmentId: string): Promise<string[]> {
    return (await this.removableVolumesByKind(environmentId)).filter((volume) => volume.possibly === true).map((volume) => volume.name);
  }

  /**
   * removableVolumes of the additional volumes of `environmentId`, each with its kind: VOLUME_KIND_COMPOSE for a volume
   * that holds data of the services of Docker Compose (review round 1, D1: classified by use, whatever its label
   * nimblescape.devenv.volume; a volume with `name:` in the model has the label `additional`): the label `compose`, a
   * volume that the open recorded as mounted by another service (Environment.serviceVolumes), or a volume that a
   * container of another service mounts now. Otherwise its label nimblescape.devenv.volume.
   */
  private async removableVolumesByKind(environmentId: string): Promise<Array<{ name: string; kind: string | undefined; possibly?: boolean }>> {
    const env = await this.deps.registry.get(environmentId);
    if (!env || (env.additionalVolumes ?? []).length === 0 || !(await this.isOnCurrentHost(env))) return [];
    try {
      const { removable, labels } = await this.removableVolumes(env, env.additionalVolumes ?? []);
      const services = new Set(env.serviceVolumes ?? []);
      const containers = await this.environmentContainers(env.id);
      for (const container of containers) {
        if (!isDevContainer(container, env.containerName)) for (const name of container.volumes ?? []) services.add(name);
      }
      // Review round 2 (D2-3): an entry that knows neither the volumes of its services nor its build (for example one
      // restored from its volumes, or whose service volume Docker created at `up` without the label
      // nimblescape.devenv.service-data): every volume may hold the data of a service, so each goes to that question,
      // none ticked (the conservative side).
      const unknown = env.serviceVolumes === undefined && env.buildRecord === undefined;
      const known = (name: string): boolean => services.has(name) || labels.get(name)?.[LABEL_SERVICE_DATA] === SERVICE_DATA;
      return removable.map((name) =>
        known(name) || !unknown
          ? { name, kind: known(name) ? VOLUME_KIND_COMPOSE : labels.get(name)?.[LABEL_VOLUME] }
          : // Review round 3 (P3-4): perhaps data of a service, perhaps not; the question names it so.
            { name, kind: VOLUME_KIND_COMPOSE, possibly: true },
      );
    } catch (error) {
      this.logger.warn(`The additional volumes of ${env.repository} could not be read: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * Of the additional volumes `names` that `env` records, those that Delete may remove, and the reason for each other
   * one. Removable is only an existing volume whose labels make it the environment's own (isOwnVolume) and that no other
   * environment records and no Delete of another account kept. Kept, with its reason: every other volume, among them a
   * volume without the labels of the environment (the user removes it), a volume of another program (for example of
   * Docker Compose, which took a name that the environment used before), and a volume of another environment.
   */
  private async removableVolumes(
    env: Environment,
    names: readonly string[],
  ): Promise<{ removable: string[]; kept: Array<{ name: string; reason: string }>; labels: ReadonlyMap<string, Record<string, string>> }> {
    const volumes = (env.additionalVolumes ?? []).filter((name) => names.includes(name) && name !== env.volumeName);
    const labels = new Map<string, Record<string, string>>();
    const result = { removable: [] as string[], kept: [] as Array<{ name: string; reason: string }>, labels };
    if (volumes.length === 0) return result;
    const file = await this.deps.registry.read();
    const others = file.environments.filter((other) => other.id !== env.id);
    // A volume that the Delete of an environment of another account kept holds that account's data.
    const keptByOthers = (file.keptVolumes ?? []).filter((record) => record.owner.id !== env.owner.id).map((record) => record.name);
    for (const volume of await this.deps.docker.inspectVolumes(volumes)) labels.set(volume.name, volume.labels);
    for (const name of volumes) {
      const volumeLabelsOf = labels.get(name);
      if (volumeLabelsOf === undefined) continue;
      if (others.some((other) => other.volumeName === name || (other.additionalVolumes ?? []).includes(name)) || keptByOthers.includes(name)) {
        result.kept.push({ name, reason: 'another environment uses it too' });
      } else if (!isOwnVolume(volumeLabelsOf, env.id, env.owner.id)) {
        const owner = volumeLabelOwner(volumeLabelsOf);
        result.kept.push({
          name,
          reason:
            owner !== undefined
              ? `${owner} created it`
              : 'its labels do not show that this environment created it',
        });
      } else {
        result.removable.push(name);
      }
    }
    return result;
  }

  /**
   * Concept 7.14 Delete step 4: the additional volumes that the user confirmed (`confirmed`, as the question listed them)
   * and that the environment still records, when removableVolumes allows it; each other one is kept with a log line
   * that names why. Returns the names of the removed volumes.
   */
  private async removeAdditionalVolumes(env: Environment, confirmed: readonly string[]): Promise<string[]> {
    const { removable, kept } = await this.removableVolumes(env, confirmed);
    for (const { name, reason } of kept) this.logger.info(`The volume ${name} is kept, because ${reason}.`);
    const removed: string[] = [];
    for (const name of removable) {
      try {
        await this.deps.docker.removeVolume(name);
        removed.push(name);
      } catch (error) {
        this.logger.warn(`Could not remove the volume ${name}: ${errorMessage(error)}`);
      }
    }
    return removed;
  }

  /** The volumes of `names` that exist. */
  private async existingVolumes(names: readonly string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const existing = new Set((await this.deps.docker.inspectVolumes(names)).map((volume) => volume.name));
    return names.filter((name) => existing.has(name));
  }

  private async removeVolumeWithRetry(name: string): Promise<void> {
    // Plan step 6, PR C: the batch helper of the open mounts the volume; it ends first (a later step would open a new one).
    const scope = currentBatchScope();
    if (scope !== undefined && scope.volume === name) await scope.closeSession();
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

  /** Removes the pending connection file, the pending operation, the disconnect request (R7), and a reopen record of the environment. */
  private async removeEnvironmentFiles(environmentId: string): Promise<void> {
    const files = this.deps.sessionFiles;
    await this.quietly('remove the pending connection file', () => files.removePending(environmentId));
    await this.quietly('remove the pending operation', () => files.removeOperation(environmentId));
    // Monitor cleanup, user decision 2026-09-29 (R7): a disconnect request of the deleted environment.
    await this.quietly('remove the disconnect request', () => files.removeDisconnectRequest(environmentId));
    await this.quietly('remove the reopen record', async () => {
      const record = await files.readReopen();
      if (record?.environmentId === environmentId) await files.removeReopen();
    });
  }

  /**
   * Delete and a failed first open of a Docker Compose environment (implementation notes, section "Docker Compose"),
   * after the containers with the label nimblescape.devenv.environment-id: the containers of the project that have no
   * such label (for example one-off containers of `docker compose run`), the networks of the project, and the images
   * that Compose built for it (`<project>-<service>`, found by their names: the build record may be missing, after a
   * failed first open or a lost registry). Its volumes are the environment's own and follow the rules of Delete
   * (removeAdditionalVolumes). `quiet`: every failure is logged, not thrown (a failed first open).
   */
  private async removeComposeProject(env: Environment, quiet: boolean): Promise<void> {
    const { docker } = this.deps;
    const project = composeProjectName(env.id);
    const run = (what: string, fn: () => Promise<unknown>): Promise<unknown> => (quiet ? this.quietly(what, fn) : fn());
    await run('remove the containers of the Docker Compose project', async () => {
      for (const container of await docker.listProjectContainers(project)) {
        // Review round 1 (D3): the label of the project can come from an image (a container of another environment, for
        // example a single container whose image has the label): never a container of another environment.
        const owner = container.labels[LABEL_ENVIRONMENT_ID];
        if (owner !== undefined && owner !== env.id) {
          this.logger.warn(`The container ${container.name} has the label of the Docker Compose project ${project} but belongs to another environment. It is not removed.`);
          continue;
        }
        // Review round 8 (P8-3): stopped first, as at Delete (D7-1).
        await this.stopServiceBeforeRemoval(container, env);
        await docker.removeContainer(container.id);
      }
    });
    await this.quietly('remove the networks of the Docker Compose project', () => this.removeComposeNetworks(env));
    await this.quietly('remove the images of the Docker Compose project', async () => {
      const images = new Set([...(composeRecordOf(env.buildRecord)?.images ?? []), ...(await docker.listProjectImages(project, env.id))]);
      for (const image of images) await this.quietly(`remove the image ${image}`, () => docker.removeImage(image));
    });
  }

  /** A failed first open leaves nothing behind, so the next Start begins cleanly. `compose`: a Docker Compose configuration. */
  private async removeFailedFirstOpen(env: Environment, compose = false): Promise<boolean> {
    const { docker } = this.deps;
    this.logger.info(`Removing what the failed first open of ${env.repository} created.`);
    await this.quietly('remove the container', async () => {
      const containers = (await docker.listEnvironmentContainers()).filter((c) => c.labels[LABEL_ENVIRONMENT_ID] === env.id);
      for (const container of containers) {
        // Review round 8 (P8-3): a running side service is stopped first, as at Delete (D7-1).
        await this.stopServiceBeforeRemoval(container, env);
        await docker.removeContainer(container.id);
      }
      await docker.removeContainer(env.containerName);
      if (compose || containers.some((c) => isComposeContainer(c.labels, composeProjectName(env.id)))) await this.removeComposeProject(env, true);
    });
    await this.quietly('remove the environment images', () => this.removeEnvironmentImages(env, undefined, undefined));
    try {
      await this.removeVolumeWithRetry(env.volumeName);
    } catch (error) {
      this.logger.warn(`Could not remove the volume ${env.volumeName}: ${errorMessage(error)}. The environment is kept; open it again to complete the clone, or delete it.`);
      await this.quietly('remove the pending connection file', () => this.deps.sessionFiles.removePending(env.id));
      return false;
    }
    // The additional volumes that the failed open recorded stay (a known limit), with their account: the environments of
    // other accounts must not mount them (concept section 9), as after a Delete that kept them.
    await this.quietly('remove the registry entry', async () => {
      const current = (await this.deps.registry.get(env.id)) ?? env;
      await this.deps.registry.remove(env.id, { kept: await this.existingVolumes(current.additionalVolumes ?? []) });
    });
    await this.quietly('remove the pending connection file', () => this.deps.sessionFiles.removePending(env.id));
    return true;
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
  private branchInContainer(container: string, user: string | undefined, folder: string, signal?: AbortSignal): Promise<string | null | undefined> {
    return readBranch(this.deps.docker, container, user, folder, signal);
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

  /**
   * Plan step 5, PR B: runs `fn` under the lock of the environment on the Docker host of the operation. User decision D1
   * (the state is made consistent before the operation, or the operation is refused): first the helper image (built when
   * it is missing, without the maintenance: WorkspaceHelper.ensureImagePresent), then the worker with the lock
   * (HelperChannels.lock opens it, also within the wait after a failed open). When either fails, the operation is refused (environmentLockUnavailable, with the cause) and `fn` never runs:
   * never without the lock, never the direct way. User decision D3: a lock held by another window or computer is waited
   * for ENVIRONMENT_LOCK_WAIT_SECONDS, then the operation is refused (environmentLockBusy); no retry loop. Within `fn` the
   * plain Docker calls go only through the worker that holds the lock (environmentLock.ts). The lock is released in
   * `finally`. Re-entrant: an operation that holds the lock of `env` runs `fn` at once. The caller took its busy mark
   * first (Delete), so a refusal leaves nothing behind that its own `finally` does not clear. Plan step 6, PR A: also
   * the opens (openExisting: Start, Rebuild, Select configuration, Clone again; openFirst), see there.
   */
  private async withEnvironmentLock<T>(
    env: Environment,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
    // Plan step 6, PR C: `batchVolume` (the opens): `fn` runs in the batch scope of that volume (batchScope.ts) under the
    // lock; its session is closed before the lock is released.
    options: { batchVolume?: string } = {},
  ): Promise<T> {
    if (holdsEnvironmentLock(env.id)) return fn();
    try {
      // PR #74 review round 1 (A-R1-1): only a missing tag is built (no rebuild, check, or cleanup before Stop or Delete).
      await this.deps.helper.ensureImagePresent({ onOutput: (text) => this.logger.output(text), signal });
    } catch (error) {
      if (this.isCancellation(error, signal)) throw error;
      const cause = isUserFacingError(error) && error.detail ? `${error.message} ${error.detail}` : errorMessage(error);
      this.logger.warn(`${env.repository}: the helper image for the worker could not be prepared, so nothing is changed: ${cause}`);
      throw new UserFacingError('helperFailed', PipelineTexts.environmentLockUnavailable(env.repository, cause), cause);
    }
    let lock: HeldEnvironmentLock;
    try {
      lock = await this.deps.environmentLock(env.id, ENVIRONMENT_LOCK_WAIT_SECONDS, signal);
    } catch (error) {
      if (this.isCancellation(error, signal)) throw error;
      if (error instanceof EnvironmentLockError && error.kind === 'busy') {
        this.logger.info(`${env.repository} is locked on the Docker host by another window or computer: ${error.message}`);
        throw new UserFacingError('startFailed', PipelineTexts.environmentLockBusy(env.repository), error.message);
      }
      this.logger.warn(`${env.repository}: the lock on the Docker host could not be taken, so nothing is changed: ${errorMessage(error)}`);
      throw new UserFacingError('helperFailed', PipelineTexts.environmentLockUnavailable(env.repository, errorMessage(error)), errorMessage(error));
    }
    this.logger.info(`${env.repository} is locked on the Docker host.`);
    const batchVolume = options.batchVolume;
    try {
      return await runWithEnvironmentLock(lock, batchVolume === undefined ? fn : () => runWithBatchScope(lock, batchVolume, this.logger, fn));
    } finally {
      await lock.release();
      this.logger.info(`${env.repository} is unlocked on the Docker host.`);
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
    ctx.stepMark = undefined;
  }

  /** Clears the busy mark of this run. Never throws: it runs in `finally` blocks. */
  private async releaseBusy(ctx: PipelineContext): Promise<void> {
    if (!ctx.busy) return;
    ctx.busy = false;
    ctx.stepMark = undefined;
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
