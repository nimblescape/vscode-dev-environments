// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup C7 (plan step 11J, E1 step 1 and E2): the ports of the environment service (environmentService.ts), in their
// own module: its Docker, its part of WorkspaceHelper, the Session Monitor, the extension cache and its deps. Types only.
import type { EnvironmentBusyMarks } from './busyMarks';
import type { ContainerInfo, ImageInfo, ImageInspection, ListedContainer, NetworkInfo, VolumeInfo } from '../docker/dockerObjects';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import type { UserIds } from '../docker/passwdUsers';
import type { SECRET_TOKEN, VscodePlatform, VscodeServerRef } from '../helperChannel/protocol';
import type { ConfigurationAnalyzer } from '../helper/configurationAnalysis';
import type { GitHubViewer } from '../helper/containerGit';
import type { WorkspaceHelper } from '../helper/workspaceHelper';
import type { ImageChecker } from '../imageCheck/imageCheck';
import type { GitHubAuth, PipelineUi, RunResult } from '../ports';
import type { ContainerState, GitSummary } from '../types';
import type { ExtensionRef } from '../vscodeExtensions';
import type { DockerStarter, OperationBaseDeps } from './operationBase';
import type { OpenRecords } from './openRecords';

/**
 * The Docker of the pipeline: the calls that the service and the refresh make (concept 7.2). Plan step 11I2 (decision D8
 * of 2026-10-07): its own interface, no longer a part of the CLI adapter ContainerAdapter, which is removed; the worker's
 * EngineDocker (src/core/worker/engineDocker.ts, over the Engine API) is the one implementation (section 0 of the plan,
 * one concept for commanding Docker). The calls throw when Docker fails; a missing object is an answer where it says so.
 */
export interface EnvironmentDocker {
  /** The engine answers. Rejects only with an AbortError. */
  isRunning(signal?: AbortSignal): Promise<boolean>;
  /**
   * The API version of the engine (for example `1.48`), or `undefined` when the engine does not tell it. Docker Compose
   * configurations need it for `volume.subpath` (supportsVolumeSubpath). Rejects only with an AbortError.
   */
  engineApiVersion(signal?: AbortSignal): Promise<string | undefined>;
  /** `Config` of the inspect of the image `reference`. */
  imageConfig(reference: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  /**
   * Plan step 11G1 ("No extra containers"): the numeric user and group IDs of `user` in the image `image`, as `id -u` and
   * `id -g` would print them in a container of it, read from its `/etc/passwd` without running anything
   * (EngineDocker.imageUserIds). Undefined when they cannot be known that way.
   */
  imageUserIds(image: string, user: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<UserIds | undefined>;
  /**
   * The dev container of the environment (label nimblescape.devenv.environment-id, isDevContainer) by the one rule of
   * plan step 11I (U4, decision of 2026-10-08; devContainerOf): the container named `containerName` whatever its state,
   * else the newest running one, else the newest one.
   */
  findContainer(environmentId: string, containerName: string): Promise<ContainerInfo | undefined>;
  /**
   * All containers with the label nimblescape.devenv.environment-id, running or not (the refresh reads all environments
   * at once). Plan step 11I (U4): each with the time of its create, for the rule of the dev container.
   */
  listEnvironmentContainers(): Promise<ListedContainer[]>;
  /**
   * Plan step 11I (U4, decision of 2026-10-08): the containers with the label nimblescape.devenv.environment-id of
   * `environmentId`, running or not: its dev container and the other services; each with the time of its create.
   */
  environmentContainers(environmentId: string): Promise<ListedContainer[]>;
  /** All containers of the Docker Compose project `project` (label com.docker.compose.project), running or not. */
  listProjectContainers(project: string): Promise<ContainerInfo[]>;
  /** The names of the networks of the Docker Compose project `project`. */
  listProjectNetworks(project: string): Promise<string[]>;
  /** A missing network is not an error; a network in use is. */
  removeNetwork(name: string): Promise<void>;
  /**
   * The images that Docker Compose built for the project `project` (`<project>-*` with a tag), as `repository:tag`; with
   * `environmentId`, only those whose label nimblescape.devenv.environment-id names that environment.
   */
  listProjectImages(project: string, environmentId?: string): Promise<string[]>;
  /**
   * 'missing' if not found; running|restarting|paused → 'running'; else 'stopped'. Review round 1 of PR #129 (B-L4): an
   * abort of `signal` ends the read at once (before, a cancel waited for the time limit of the query).
   */
  containerState(nameOrId: string, signal?: AbortSignal): Promise<ContainerState>;
  /** A missing container is not an error. */
  stopContainer(nameOrId: string): Promise<void>;
  /** Review round 22 (D22-1): throws when the container does not exist or the name is taken. */
  renameContainer(nameOrId: string, newName: string): Promise<void>;
  /** Removes the container, also a running one. A missing container is not an error. */
  removeContainer(nameOrId: string): Promise<void>;
  /**
   * `docker exec`; resolves also for a non-zero exit code. Plan step 11I (PR B): the pipeline runs only the scripts of
   * the registry through it (runScript, src/core/worker/containerScripts.ts). `secretInputName` names the secret of the
   * operation that is the standard input of the process, as DockerEngine.exec takes it (a name, never a value): only the
   * token (SECRET_TOKEN), which the operation must hold.
   */
  exec(
    container: string,
    command: readonly string[],
    options?: { user?: string; workdir?: string; input?: string; secretInputName?: typeof SECRET_TOKEN; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<RunResult>;
  /** Plan step 10A: starts the container with the full ID `id`. */
  startContainer(id: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  volumeExists(name: string): Promise<boolean>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  /** The volumes with the label nimblescape.devenv.environment-id. */
  listEnvironmentVolumes(signal?: AbortSignal): Promise<VolumeInfo[]>;
  /** The volumes of `names` that exist, each once. */
  inspectVolumes(names: readonly string[]): Promise<VolumeInfo[]>;
  /** The networks of `names` that exist, each once. */
  inspectNetworks(names: readonly string[]): Promise<NetworkInfo[]>;
  imageExists(reference: string): Promise<boolean>;
  /** The full ID of the image, or undefined for a missing image. */
  imageId(reference: string): Promise<string | undefined>;
  /** The labels of the image, or undefined for a missing image. */
  imageLabels(reference: string): Promise<Record<string, string> | undefined>;
  /** The labels of the images of `references` by their lower-case full IDs; a missing image is left out. */
  imageLabelsOf(references: readonly string[], signal?: AbortSignal): Promise<Map<string, Record<string, string>>>;
  /**
   * User decisions 2026-10-03: gives the image `image` the labels `labels` (its build record); the previous image is
   * removed only when nothing names it.
   */
  labelImage(image: string, labels: Record<string, string>, signal?: AbortSignal): Promise<void>;
  /**
   * Review rounds 9 to 11 of PR #64: the images that the references find; the references that could not be checked, each
   * with its reason (ImageUncheckedReason).
   */
  inspectImageNames(references: readonly string[], signal?: AbortSignal): Promise<ImageInspection>;
  /** True when the image was removed; false for a missing image or one in use. */
  removeImage(reference: string): Promise<boolean>;
  /** The tags `repository:tag` of exactly this repository, sorted by tag, numbers numerically. */
  listImageTags(repository: string): Promise<string[]>;
  /** User decision 2026-09-28: the named images `devenv-*`, each once with its references. */
  listEnvironmentImages(signal?: AbortSignal): Promise<ImageInfo[]>;
  /**
   * `docker pull`. Plan step 11E3b: EngineDocker.pullImage asks for the login of the registry of the reference itself, and
   * holds it only for this pull.
   */
  pullImage(reference: string, options?: { onOutput?: (text: string) => void; signal?: AbortSignal }): Promise<void>;
}

/** The part of WorkspaceHelper that the service uses. */
export type EnvironmentHelper = Pick<
  WorkspaceHelper,
  | 'ownImageUse'
  | 'clone'
  | 'readConfigFiles'
  | 'listConfigurations'
  | 'readConfiguration'
  | 'composeModel'
  | 'composeServiceHashes'
  | 'build'
  | 'up'
  | 'runUserCommands'
  | 'prepareGit'
  | 'createRepositoryFolders'
  | 'fixConfigOwnership'
  | 'fixRepositoryOwnership'
>;

/**
 * Unit 7, PR 2: the Session Monitor container of the Docker engine of the operation (RemoteSessionMonitor, with the
 * socket of that engine and the id of this computer). Plan step 8, PR A: on every engine, local and remote (user decision
 * of 2026-09-30, "One Session Monitor on every engine"). Cleanup C5 (plan step 11J, A11): the calls take no Docker
 * target, helper tag or image: the only implementation (workerSessionMonitor) is the monitor of the worker's own engine,
 * run with the worker's own helper image, and ignored them.
 */
export interface EnvironmentSessionMonitor {
  /**
   * Makes sure that the monitor container runs on the engine. Plan step 8, PR A (user decision Q3 of 2026-10-02): rejects
   * with the cause when it cannot (the open is refused), and with an AbortError when `signal` aborts.
   */
  ensure(signal: AbortSignal | undefined): Promise<unknown>;
  /**
   * One heartbeat of this computer for the environment (with the time limit of the settings). The monitor acts only on
   * environments that a computer sent a heartbeat for. `seq`: the wall clock when the keep flag was read
   * (HeartbeatEntry).
   */
  heartbeat(environmentId: string, keepRunning: boolean, seq: number): Promise<{ ok: true } | { ok: false; detail: string }>;
  /**
   * Removes the heartbeat record of this computer for a deleted environment (best effort). Plan step 11C2a: only the
   * worker's Session Monitor has it (Delete runs there; decision of 2026-10-04).
   */
  forget(environmentId: string): Promise<void>;
  /**
   * User requests 2026-09-28: gives the monitor of the engine the image repositories to update and clean (read from the
   * registry; at most once an hour per engine). Best effort: never throws, except an AbortError.
   */
  images(signal?: AbortSignal): Promise<void>;
}

/**
 * The deps of the worker's pipeline. Plan step 11I (PR D, audit D6): what it shares with the window's operations is
 * OperationBaseDeps; here only what is the pipeline's own, or wider for it.
 */
export interface EnvironmentServiceDeps extends OperationBaseDeps {
  docker: EnvironmentDocker;
  helper: EnvironmentHelper;
  imageChecker: Pick<ImageChecker, 'check'>;
  /** Also the report of a token that GitHub rejected. */
  auth: Pick<GitHubAuth, 'getToken' | 'getAccount' | 'reportRejectedToken'>;
  /**
   * The GitHub account of a token (DiscoveryService.viewer), for the Git identity of a new environment (concept section 9).
   * Without it, or when GitHub does not answer in time, the identity comes from the account of the session.
   */
  viewer?: (token: string, signal?: AbortSignal) => Promise<GitHubViewer>;
  /** Time limit of `viewer`. Default 5 s. */
  viewerTimeoutMs?: number;
  /** All questions and messages of the pipeline. */
  ui: PipelineUi;
  /**
   * Unit 7: the start of Docker, or the check that it answers. Plan step 11I2: required; the default (`ensureDockerRunning`
   * with the CLI adapter ContainerAdapter) is removed with that adapter. The worker gives a check that its engine answers.
   */
  startDocker: DockerStarter;
  /**
   * Unit 7, PR 2: the Session Monitor container of the engine. The open pipeline ensures it right after the helper image
   * (before the container is created or started); Delete removes the record of this computer there. Plan step 8, PR A:
   * on every engine, local and remote; an open is refused when it cannot be ensured (Q3). Without it (tests): nothing.
   */
  sessionMonitor?: EnvironmentSessionMonitor;
  /**
   * Plan step 11C2a (decision of 2026-10-04): the busy marks of the window that runs the operation; the worker's pipeline
   * sends them to the extension (`record markBusy`, `record clearBusy`). Plan step 11I (PR D): required, there is no
   * write to the registry by a function in the pipeline.
   */
  busyMarks: EnvironmentBusyMarks;
  /**
   * Plan step 11E4a (decision of 2026-10-04): the registry writes of the open, as specific operations; the worker's
   * pipeline sends them to the extension (hostOpenRecords, plan step 11E4b; the entry, configuration and build writes with
   * 11E4c). Plan step 11I (PR D): required, as `busyMarks`.
   */
  openRecords: OpenRecords;
  /**
   * Plan step 11C2b (decision of 2026-10-04): records the Git state of an environment (Environment.gitSummary); the
   * worker's pipeline sends it to the extension (`record recordGitSummary`). Plan step 11I (PR D): required, as `busyMarks`.
   */
  recordGitSummary: (environmentId: string, summary: GitSummary) => Promise<void>;
  /** Interval at which an open pipeline writes its pending connection file again. Default 15 s. */
  pendingRefreshMs?: number;
  /** For tests. Default: newEnvironmentId of names.ts. */
  newEnvironmentId?: () => string;
  /**
   * Review round 8: runs the host access analysis of a configuration (checkContainer of the container policy, ../policy,
   * and the FROM images of the Dockerfiles for the update check). The worker runs it in its analysis thread with limits
   * of time and memory (plan step 11E2); a failed analysis refuses the configuration.
   */
  analyzer: ConfigurationAnalyzer;
  /**
   * Plan step 5, PR B: takes the lock of an environment in the worker of the Docker target of the operation (plan step
   * 11I1, PR B1: the worker's own, workerEnvironmentLock), waiting at most `waitSeconds`. Throws EnvironmentLockError (`busy`, `unavailable`) or an
   * AbortError. Stop and Delete take it (user decision D2). Required (D1: there is no path without the lock).
   */
  environmentLock: (environmentId: string, waitSeconds: number, signal: AbortSignal | undefined) => Promise<HeldEnvironmentLock>;
  /**
   * Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"): the name of the shared VS Code server store of
   * the engine (the volume that the worker mounts read-write, OwnHelper.vscodeStore; default VSCODE_STORE_VOLUME). The host
   * access policy allows its mount in the override configuration (HostAccessInput.vscodeStoreVolume), the creation of the
   * additional volumes never creates or records it, and the link checks that the dev container mounts it.
   */
  vscodeStoreVolume?: string;
  /**
   * Plan step 11H1: the VS Code server of an open that carries one (OpenParams.vscodeServer) on a worker with a store, and
   * `fetch`, which makes sure that the store has it for the platform of the engine (ensureEngineServer; resolves with that
   * platform when it is ready, else `undefined`; never rejects). Without it the open runs as before: no mount of the store, no fetch, no link. The decision
   * of 2026-10-09: the open starts the fetch at its start (a present server costs nothing; a download that runs in another
   * window is waited for through its lock; a missing one is downloaded by the very first open) and waits for it before the
   * link.
   */
  vscodeServer?: { server: VscodeServerRef; fetch: (signal: AbortSignal) => Promise<VscodePlatform | undefined>; extensions?: VscodeExtensionCache };
}

/**
 * Plan step 11H3 (decision of 2026-10-09; live check 3): the shared extension cache of the store for an open with a VS
 * Code server (the worker's: recordExtensions, cachedExtensionFiles and seedSelection at VSCODE_STORE_DIR; review round 1
 * of 11H3: the record and the monitor's chosen files in the volume of the Session Monitor at LOCK_STATE_DIR).
 */
export interface VscodeExtensionCache {
  /**
   * Records the extension list of the open of `environmentId` (the configuration's extensions, undefined when the open
   * could not read its configuration: the recorded ones stay; and the user's defaults) with the time of the open;
   * resolves with the list of the open. Rejects with the cause.
   */
  record(environmentId: string, configuration: ExtensionRef[] | undefined): Promise<ExtensionRef[]>;
  /** The cached files of the store to seed for `list` (`<folder>/<cache name>`), for the engine's platform when known. */
  seedFiles(list: ExtensionRef[], platform: VscodePlatform | undefined): Promise<string[]>;
}
