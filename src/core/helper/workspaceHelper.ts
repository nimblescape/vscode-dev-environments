// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Workspace helper (implementation notes 7, concept 7.6): the image with Git and the Dev Container CLI, and the steps
// that run in it on the workspace volume (at /workspaces). Plan step 7 (user decision of 2026-10-01): every step runs in
// the batch helper of an operation (batchScope.ts, batchSteps.ts, src/helperChannel/batchHelper.ts), never as a container
// of its own; a step outside the batch scope of an operation is an internal error. In the batch helper the runs of the
// Dev Container CLI get the Docker socket, so the CLI builds and starts dev containers with the Docker engine; the clone
// runs as an unprivileged Git user and the read steps as the owner of the repository, without the socket: Git runs
// programs that the repository configuration names (for example filter drivers).
import * as crypto from 'crypto';
import { DOCKER_QUERY_TIMEOUT_MS, type ContainerAdapter } from '../docker/containerAdapter';
import { runPreparingWorker } from '../docker/workerPreparation';
import { CommandError, UserFacingError, errorMessage, isUserFacingError } from '../errors';
import { configOwnershipFixCommand, gitSummaryCommand, parseGitSummaryOutput } from '../git/gitSummary';
import { Messages } from '../messages';
import { HELPER_DOCKER_SOCKET, WORKSPACES_ROOT, environmentIdLabel } from '../names';
import { abortError, isAbortError, isoTime, systemClock, type Clock, type Logger, type RunResult } from '../ports';
import type { DevcontainerConfig, DevcontainerResult, GitSummary } from '../types';
import {
  DevcontainerCommandError,
  buildArgs,
  isLifecycleCommandFailure,
  parseDevcontainerResult,
  readConfigurationArgs,
  runUserCommandsArgs,
  tryParseDevcontainerResult,
  upArgs,
} from './devcontainerCli';
import {
  HELPER_LAST_USED_INTERVAL_MS,
  currentHelperImageTag,
  ensureHelperImageUse,
  recordHelperImageUse,
  type BaseDigestLookup,
  type HelperBuildKind,
  type HelperImageUse,
} from './helperImage';
import { CONTAINER_CREDENTIAL_HELPER, type GitIdentity } from './containerGit';
import { COMPOSE_MODEL_PATH, parseComposeModelOutput, type ComposeModelOutput } from './compose';
import {
  OVERRIDE_CONFIG_PATH,
  buildCommand,
  cloneCommand,
  composeHashCommand,
  composeModelCommand,
  createFoldersCommand,
  gitFilesCommand,
  listConfigsCommand,
  parseComposeHashes,
  readFilesCommand,
  writeAndRunCommand,
} from './scripts';
// Plan step 6, PR B: the checks of the inputs and the commands of the Dev Container CLI runs are shared with the batch
// helper (stepInputs.ts), so that both build every command from the same builders.
import { checkConfigPath, checkRepository, isPassableEnvName, overrideCommand, overrideInput, writeAndRunInput, type HelperFiles } from './stepInputs';
// Plan step 6, PR C, plan step 7: the volume steps run only in the batch helper of an operation.
import { currentBatchScope, type BatchScope } from './batchScope';
import type { BatchStepKind } from './batchSteps';

export { isPassableEnvName };

/** The part of ContainerAdapter that the helper uses. A ContainerAdapter fits. */
export type HelperDocker = Pick<
  ContainerAdapter,
  'run' | 'imageExists' | 'imageId' | 'buildImage' | 'listImagesByLabel' | 'removeImage'
>;

/** Result of WorkspaceHelper.up. */
export interface UpResult extends DevcontainerResult {
  /** The description of the CLI when a lifecycle command failed and the running container was kept. */
  lifecycleCommandFailure?: string;
}

export interface HelperDeps {
  docker: HelperDocker;
  logger: Logger;
  /** resources/helper/Dockerfile of the installed extension. */
  dockerfilePath: string;
  /** Environment of the extension host. Only DOCKER_HOST is read (for the socket path); nothing of it enters the helper. */
  env: NodeJS.ProcessEnv;
  /** Default: the platform of this process. */
  platform?: NodeJS.Platform;
  clock?: Clock;
  /**
   * `helper.json` in the global storage folder (StoragePaths.helperState). With it, ensureImage also checks the base
   * image weekly (in the background), rebuilds the image when a check asked for it, and removes old helper images daily
   * (ensureHelperImage); the helper runs only build a missing tag and record the use. Without it, the image is only
   * built when its tag is missing.
   */
  statePath?: string;
  /** Current digest of the base image of the helper (registryBaseDigest). Without it, the base image is not checked. */
  baseDigest?: BaseDigestLookup;
  /** Called with each check of the base image that ensureImage starts in the background (for tests). */
  onBaseImageCheck?: (check: Promise<void>) => void;
  /**
   * Unit 7: the Docker engine that the operation uses (the current Docker context). `key` names it ('' for the local
   * Docker, else the remote host): the image found or built for one engine is not reused for another, and a remote
   * engine has its own state file. `socket`: the source of the socket mount on the machine of that engine (for a remote
   * host `/var/run/docker.sock`, or the recorded socket of a rootless engine); `endpoint`: the local endpoint of the
   * context, for helperDockerSocket. Without it, the local Docker of DOCKER_HOST.
   */
  engine?: () => Promise<HelperEngine>;
  /** Plan step 5, PR A: called after a build of the helper image succeeded (the worker can be opened again at once). */
  onImageBuilt?: () => void;
}

/** See HelperDeps.engine. */
export interface HelperEngine {
  key: string;
  socket?: string;
  endpoint?: string;
}

/**
 * The state file of the helper images of a remote engine: `helper.json` → `helper-remote-<hash>.json` (unit 7). The
 * state of the local Docker stays in `helper.json`.
 */
export function helperStatePathFor(statePath: string, engineKey: string): string {
  if (engineKey === '') return statePath;
  const hash = crypto.createHash('sha256').update(engineKey).digest('hex').slice(0, 16);
  return statePath.replace(/(\.json)?$/, `-remote-${hash}.json`);
}

/** Options of WorkspaceHelper.ensureImage. */
export interface EnsureImageOptions {
  onOutput?: (text: string) => void;
  signal?: AbortSignal;
  /** `false` when the setting updateImagesOnConnect is off: no check of the base image (default `true`). */
  checkBaseImage?: boolean;
  /** Called right before a build of the helper image: `create` for a missing tag, `refresh` for a rebuild. */
  onBuild?: (kind: HelperBuildKind) => void;
}

/**
 * The result of ensureHelperImage that WorkspaceHelper caches, and the helper image of an open (see HelperImageUse in
 * helperImage.ts). Review round 3 of PR #64 (P2): the runs of an open use its `id`, for the current tag too.
 */
export type { HelperImageUse };

/**
 * ensureImage reuses its result for this long. After that, it runs ensureHelperImage again, so a window that stays open
 * for days still checks the base image and cleans up when that is due.
 */
export const HELPER_IMAGE_RECHECK_MS = 60 * 60 * 1000;

/** Path of the Docker socket inside the helper, and the default source of the socket mount. */
export const DOCKER_SOCKET = HELPER_DOCKER_SOCKET;

/**
 * Time limit of the helper run that reads the merged configuration (readConfiguration). Without a container, the CLI
 * reads the base image and the Features for it from the registries, and a network that drops packets would hold the
 * open for as long as the time limits of TCP and HTTP. After this time the configuration is read without it.
 */
export const MERGED_CONFIGURATION_TIMEOUT_MS = 10_000;

/**
 * Source of the socket mount (implementation notes 6). The source is a path on the machine of the Docker engine.
 * Assumption (V-7): Docker Desktop (macOS, Windows, and Linux) runs the engine in a VM, where the socket is
 * /var/run/docker.sock, whatever DOCKER_HOST points to on the computer. So a `unix://` DOCKER_HOST is used only on
 * Linux without Docker Desktop (for example rootless Docker Engine).
 */
export function helperDockerSocket(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, endpoint?: string): string {
  // Unit 7: the endpoint of the current Docker context (DOCKER_HOST when it is set), so a context of a local rootless
  // engine is followed like DOCKER_HOST.
  const host = (endpoint?.trim() || env.DOCKER_HOST?.trim()) ?? '';
  if (platform !== 'linux' || !host || !host.startsWith('unix://')) return DOCKER_SOCKET;
  const socketPath = host.slice('unix://'.length);
  if (!socketPath.startsWith('/') || socketPath.includes('/.docker/desktop/')) return DOCKER_SOCKET;
  return socketPath;
}

function checkToken(token: string): void {
  if (!token || /\s/.test(token)) throw new UserFacingError('signInRequired', Messages.signInRequired, 'No valid GitHub token.');
}

function redact(text: string, secret: string): string {
  return secret.length >= 4 ? text.split(secret).join('***') : text;
}

/** Review PL-1: a stream that is not redacted line by line holds at most this many characters before it passes them on. */
const REDACTION_BUFFER_LIMIT = 64 * 1024;

/**
 * Review PL-1: passes a stream on with `secret` replaced (redact), also when the secret is split across chunks: whole
 * lines go on at once; a line longer than REDACTION_BUFFER_LIMIT goes on except for its last characters (shorter than
 * the secret), which wait for the next chunk. flush passes on the rest.
 */
class RedactingStream {
  private buffer = '';

  constructor(
    private readonly forward: (text: string) => void,
    private readonly secret: string,
  ) {}

  write(text: string): void {
    this.buffer += text;
    const end = this.buffer.lastIndexOf('\n') + 1;
    if (end > 0) {
      this.forward(redact(this.buffer.slice(0, end), this.secret));
      this.buffer = this.buffer.slice(end);
    }
    if (this.buffer.length > REDACTION_BUFFER_LIMIT) {
      // A secret split at the end starts within its last `length - 1` characters, which stay.
      const text = redact(this.buffer, this.secret);
      const keep = Math.min(text.length, Math.max(this.secret.length - 1, 0));
      this.forward(text.slice(0, text.length - keep));
      this.buffer = text.slice(text.length - keep);
    }
  }

  flush(): void {
    if (this.buffer) this.forward(redact(this.buffer, this.secret));
    this.buffer = '';
  }
}

/** The last non-empty line of stdout, parsed as JSON. Throws if it is missing or invalid. */
function lastJsonLine(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error('The workspace helper printed no result.');
  return JSON.parse(lines[lines.length - 1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeCommand(command: readonly string[]): string {
  if (command[0] === 'sh' && command[1] === '-c') return ['sh', '<script>', ...command.slice(4)].join(' ');
  if (command[0] === 'node' && command[1] === '-e') return ['node', '<script>', ...command.slice(3)].join(' ');
  return command.join(' ');
}

/** Forwards stdout of `build`/`up` line by line, without the JSON result line. */
class ResultLineFilter {
  private buffer = '';

  constructor(private readonly forward: (text: string) => void) {}

  write(text: string): void {
    this.buffer += text;
    let lines = '';
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index + 1);
      this.buffer = this.buffer.slice(index + 1);
      if (!tryParseDevcontainerResult(line)) lines += line;
      index = this.buffer.indexOf('\n');
    }
    if (lines) this.forward(lines);
  }

  flush(): void {
    if (this.buffer && !tryParseDevcontainerResult(this.buffer)) this.forward(this.buffer);
    this.buffer = '';
  }
}

interface StreamOptions {
  env?: Record<string, string>;
  /**
   * Time limit of the step in the batch helper (not of a build of the helper image before it). When it ends, the step is
   * ended, and the run rejects with an Error that is not an AbortError.
   */
  timeoutMs?: number;
  input?: string;
  /**
   * Plan step 6, PR C: the step of the batch helper that this run is, with the inputs of its builder (batchSteps.ts) and
   * the secret (the token: the standard input of the clone, or only masked). Plan step 7 (user decision of 2026-10-01):
   * every run is such a step, and runs only in the batch scope of an operation (batchScope.ts).
   */
  batch: { kind: BatchStepKind; params: Record<string, unknown>; secret?: string };
  /** The helper image of the open (see HelperImageUse); without it, the image of this instance (WorkspaceHelper.image). */
  image?: HelperImageUse;
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

/** Files of the extension for a run of the Dev Container CLI (stepInputs.ts). */
export type { HelperFiles };

/** Plan step 6, PR C: the step kinds of the batch helper that take the variables of the request (`env`). */
const BATCH_ENV_KINDS: ReadonlySet<BatchStepKind> = new Set<BatchStepKind>(['readConfiguration', 'build', 'up', 'runUserCommands']);

/** Time limit of the model run of a Docker Compose configuration (composeModel). */
export const COMPOSE_MODEL_TIMEOUT_MS = 60_000;

/** Workspace helper (implementation notes 7, concept 7.6). */
export class WorkspaceHelper {
  private imagePromise: Promise<HelperImageUse> | undefined;
  /** Whether the cached image promise comes from ensureImage (with the maintenance), not from a helper run. */
  private imageMaintained = false;
  /** When the cached image promise resolved, and its tag. */
  private imageReadyAt: number | undefined;
  private imageTag: string | undefined;
  /**
   * Review round 4 of PR #64 (R4-1): the image ID of the cached result (HelperImageUse.id), set when it resolved. A pinned
   * run that finds no such image resets the cache when it still holds this ID, and ensureImage checks it before it reuses
   * the cache.
   */
  private imageCachedId: string | undefined;
  /** Last time this instance recorded a use of the tag in the state file. */
  private imageUsedAt: number | undefined;
  private readonly clock: Clock;
  /** The engine of the cached image (HelperDeps.engine). */
  private imageEngine = '';
  /**
   * Review round 5 of PR #64 (R5-1): the build that the cached image promise has started (HelperBuildKind), until it
   * settles, and the onBuild callbacks of the callers that await it. A caller that joins the promise gets the progress
   * too: at once when the build has started, otherwise when it starts.
   */
  private imageBuilding: HelperBuildKind | undefined;
  private imageBuildListeners: Set<(kind: HelperBuildKind) => void> | undefined;

  constructor(private readonly deps: HelperDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** The engine of the operation (HelperDeps.engine); the local Docker without it. */
  private async currentEngine(): Promise<HelperEngine> {
    return (await this.deps.engine?.()) ?? { key: '' };
  }

  /** The source of the socket mount for the engine (see HelperDeps.engine and helperDockerSocket). */
  private socketPathFor(engine: HelperEngine): string {
    if (engine.socket !== undefined) return engine.socket;
    return helperDockerSocket(this.deps.env, this.deps.platform ?? process.platform, engine.endpoint);
  }

  private statePathFor(engine: HelperEngine): string | undefined {
    const statePath = this.deps.statePath;
    return statePath === undefined ? undefined : helperStatePathFor(statePath, engine.key);
  }

  /**
   * ensureHelperImage, shared by concurrent callers (cached promise; retried after a failure). With `statePath`, it also
   * does the maintenance that is due (implementation notes 7): a rebuild that a check asked for, the check of the base
   * image (in the background), the cleanup of old helper images. The open pipeline calls it before the helper runs; a
   * result older than HELPER_IMAGE_RECHECK_MS, or one of a helper run (without the maintenance), is not reused. A failed
   * build throws UserFacingError('helperFailed', Messages.helperFailed, detail); AbortError and other UserFacingErrors
   * pass through. Returns the tag.
   */
  async ensureImage(options: EnsureImageOptions = {}): Promise<string> {
    return (await this.ensureImageUse(options)).tag;
  }

  /**
   * ensureImage, with the helper image that this call awaited (HelperImageUse: the tag and the ID of its image). Review
   * round 3 of PR #64 (P1): the open pipeline pins this return value as the helper image
   * of the open and passes it as `image` to every helper run of the open, because the cache of this instance is shared by
   * all opens of the window and may be replaced meanwhile (another engine, a missing image at another run).
   */
  async ensureImageUse(options: EnsureImageOptions = {}): Promise<HelperImageUse> {
    return this.image(options, true);
  }

  /**
   * PR #74 review round 1 (A-R1-1): the helper image for the worker of the environment lock (Stop, Delete), on the engine
   * of the operation, local or remote alike. It only builds a missing tag, like the helper runs: no check of the base
   * image, no rebuild of an existing tag, no cleanup, so nothing long runs before the lock. A cached result whose image
   * is gone (a prune, or another window moved the tag) is not trusted: the cache is reset and the tag ensured again.
   * PR #74 review round 2, A-R2-1: it does not join a pending maintaining ensure of an open (a `--pull --no-cache`
   * rebuild, the cleanup), which the caller could not cancel: when the tag exists, its image is used at once (the worker
   * is pinned to its ID; a rebuild that moves the tag later cannot remove an image that a container uses). Only a missing
   * tag, or a tag that cannot be checked, joins it, like before. Throws like ensureImage.
   */
  async ensureImagePresent(options: { onOutput?: (text: string) => void; signal?: AbortSignal } = {}): Promise<HelperImageUse> {
    // Plan step 5, PR D (rule D1 of 2026-09-30): the helper image makes the state for the worker consistent, so its calls
    // run without the worker (workerPreparation.ts).
    return runPreparingWorker(() => this.ensureImagePresentNow(options));
  }

  private async ensureImagePresentNow(options: { onOutput?: (text: string) => void; signal?: AbortSignal }): Promise<HelperImageUse> {
    const engine = await this.currentEngine();
    this.adoptEngine(engine.key);
    if (this.imagePromise && this.imageReadyAt !== undefined && !(await this.cachedImageCurrent())) this.resetImage();
    this.adoptEngine(engine.key);
    if (this.imagePromise && this.imageReadyAt === undefined && this.imageMaintained) {
      const present = await this.presentTag(options.signal);
      if (present !== undefined) return present;
      // The cache may have been replaced during the await (another engine): image() joins a promise of this engine.
      this.adoptEngine(engine.key);
    }
    return this.image({ onOutput: options.onOutput, signal: options.signal }, false);
  }

  /**
   * PR #76 review round 1 (A-R1-1, A-R1-2): whether the current helper tag exists on the engine of the operation, for the
   * refresh of the sidebar, which never builds it and never joins a pending build (its checks have time limits). Throws
   * UserFacingError('helperFailed') when the tag is missing or cannot be checked; an AbortError when `signal` aborts. In
   * the scope of the worker preparation, like ensureImagePresent (its check cannot go through the worker).
   */
  async checkImagePresent(options: { signal?: AbortSignal } = {}): Promise<void> {
    const present = await runPreparingWorker(() => this.presentTag(options.signal));
    if (present === undefined) throw new UserFacingError('helperFailed', Messages.helperImageNotPresent);
  }

  /**
   * PR #74 review round 2, A-R2-1: the current helper tag with the ID of its image, when the tag exists; `undefined` when
   * it is missing or cannot be checked (the caller then joins or builds). It leaves the cache untouched and records no
   * use. An abort of `signal` passes through.
   */
  private async presentTag(signal: AbortSignal | undefined): Promise<HelperImageUse | undefined> {
    if (signal?.aborted) throw abortError();
    let tag: string | undefined;
    let id: string | undefined;
    try {
      tag = await currentHelperImageTag(this.deps.dockerfilePath);
      id = await this.deps.docker.imageId(tag);
    } catch (error) {
      this.deps.logger.warn(`The workspace helper image${tag !== undefined ? ` ${tag}` : ''} could not be checked: ${errorMessage(error)}`);
      id = undefined;
    }
    if (signal?.aborted) throw abortError();
    return tag !== undefined && id !== undefined ? { tag, id } : undefined;
  }

  /**
   * The key of the engine of the operation (HelperDeps.engine; '' for the local Docker). Plan step 6, PR D: the
   * background prebuild reads the state file of this engine (helperStatePathFor), the one that an open on it writes.
   */
  async engineKey(): Promise<string> {
    return (await this.currentEngine()).key;
  }

  /**
   * The background prebuild (user decision 2026-09-29: no previous helper image; HelperPrebuild): makes sure that the
   * helper tag exists on the engine of the operation, and builds it when it is missing, without the maintenance of
   * ensureImage (like the helper runs). It shares the cached promise of this instance with ensureImage and the helper
   * runs, so an open that starts meanwhile waits for this build instead of building a second time; when `signal` aborts,
   * the build is cancelled, and an open that waited for it builds again for itself. Plan step 6, PR D: on every engine,
   * local or remote (it no longer returns `undefined` for a remote one). Throws like ensureImage.
   */
  async prebuildImage(options: { signal: AbortSignal; onBuild?: (kind: HelperBuildKind) => void }): Promise<HelperImageUse> {
    return this.image({ signal: options.signal, onBuild: options.onBuild }, false);
  }

  /**
   * Clones the repository into the volume (idempotent): the step clone, as the Git user of the batch helper, without the
   * Docker socket. The token is only the secret of the step (its standard input in the helper). Throws CommandError.
   */
  async clone(p: {
    volumeName: string;
    repository: string;
    branch?: string;
    token: string;
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    checkToken(p.token);
    const { name } = checkRepository(p.repository);
    const output = this.redactingOutput(p.onOutput ?? this.logOutput, p.token);
    this.deps.logger.info(`Cloning ${p.repository}${p.branch ? ` (branch ${p.branch})` : ''} into the volume ${p.volumeName}.`);
    const result = await this.runStreams(p.volumeName, cloneCommand(p.repository, name, p.branch || undefined), {
      // Plan step 6, PR C: in the batch helper the token travels only in the `secret` field.
      batch: { kind: 'clone', params: { repository: p.repository, ...(p.branch ? { branch: p.branch } : {}) }, secret: p.token },
      image: p.image,
      signal: p.signal,
      onStdout: output,
      onStderr: output,
    });
    if (result.exitCode !== 0) {
      throw new CommandError('git clone', result.exitCode, redact(result.stdout, p.token), redact(result.stderr, p.token));
    }
  }

  /**
   * devcontainer.json and its Dockerfile (if any) from the volume. `undefined` if the configuration file does not exist.
   * `dockerfile`: the Dockerfile that the configuration names after the Dev Container CLI resolved its variables (review
   * round 2, S2-01), read in place of the one that the text names. `dockerfileMissing` (review round 3, P3-1): the
   * Dockerfile does not exist in the repository (READ_FILES_SCRIPT).
   */
  async readConfigFiles(p: {
    volumeName: string;
    repository: string;
    configPath: string;
    dockerfile?: string;
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    signal?: AbortSignal;
  }): Promise<{ configText: string; dockerfilePath?: string; dockerfileText?: string; dockerfileMissing?: boolean } | undefined> {
    const folder = this.repositoryFolder(p.repository);
    const result = await this.runStreams(p.volumeName, readFilesCommand(folder, checkConfigPath(p.configPath), p.dockerfile), {
      batch: { kind: 'readFiles', params: { repository: p.repository, configPath: p.configPath, ...(p.dockerfile !== undefined ? { dockerfile: p.dockerfile } : {}) } },
      image: p.image,
      signal: p.signal,
      onStderr: this.logOutput,
    });
    if (result.exitCode !== 0) throw new CommandError('read configuration files', result.exitCode, result.stdout, result.stderr);
    const value = lastJsonLine(result.stdout);
    if (value === null) return undefined;
    if (!isRecord(value) || typeof value.configText !== 'string') {
      throw new Error('The workspace helper returned invalid configuration files.');
    }
    const files: { configText: string; dockerfilePath?: string; dockerfileText?: string; dockerfileMissing?: boolean } = { configText: value.configText };
    if (typeof value.dockerfilePath === 'string') files.dockerfilePath = value.dockerfilePath;
    if (typeof value.dockerfileText === 'string') files.dockerfileText = value.dockerfileText;
    // Review round 3 (P3-1): the Dockerfile does not exist in the repository (not a link out).
    if (value.dockerfileMissing === true && files.dockerfileText === undefined) files.dockerfileMissing = true;
    return files;
  }

  /** Configuration paths in the volume, in the order of precedence (concept 7.4). */
  async listConfigurations(p: { volumeName: string; repository: string; image?: HelperImageUse; signal?: AbortSignal }): Promise<string[]> {
    const folder = this.repositoryFolder(p.repository);
    const result = await this.runStreams(p.volumeName, listConfigsCommand(folder), {
      batch: { kind: 'listConfigs', params: { repository: p.repository } },
      image: p.image,
      signal: p.signal,
      onStderr: this.logOutput,
    });
    if (result.exitCode !== 0) throw new CommandError('list configurations', result.exitCode, result.stdout, result.stderr);
    const value = lastJsonLine(result.stdout);
    if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
      throw new Error('The workspace helper returned an invalid list of configurations.');
    }
    return value;
  }

  /**
   * devcontainer read-configuration --include-merged-configuration: the `configuration` object of its JSON output, and
   * `mergedConfiguration` (with the metadata of the base image and the Features, or of the existing container), which
   * the host access policy checks (concept section 9). Without a container, the CLI reads the base image and the Features
   * for the merged configuration, from the registries when they are not local, and without the credentials of the
   * extension; when that fails (for example offline, or a private base image), the configuration is read again without
   * it and `merged` is `undefined`: the image metadata is checked before `up` in any case. The same happens when the
   * read with the merged configuration takes longer than MERGED_CONFIGURATION_TIMEOUT_MS. With `merged: false`, the
   * configuration is read without it at once (no network is needed). Variables of the computer (`${localEnv:…}`) are not
   * passed. Throws CommandError.
   */
  async readConfiguration(p: {
    volumeName: string;
    repository: string;
    configPath: string;
    environmentId: string;
    /** Whether to read the merged configuration (default `true`). */
    merged?: boolean;
    /**
     * Docker Compose: `--override-config` (composeConfigOverride), written into the helper at OVERRIDE_CONFIG_PATH with
     * `files` (our model, COMPOSE_MODEL_PATH), and `env` (COMPOSE_PROJECT_NAME) for the helper.
     */
    override?: Record<string, unknown>;
    files?: HelperFiles;
    env?: Record<string, string>;
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<{ config: DevcontainerConfig; merged?: Record<string, unknown> }> {
    if (p.merged !== false) {
      try {
        const value = await this.readConfigurationOutput(p, true, MERGED_CONFIGURATION_TIMEOUT_MS);
        return { config: value.configuration as DevcontainerConfig, merged: isRecord(value.mergedConfiguration) ? value.mergedConfiguration : undefined };
      } catch (error) {
        // Only a cancel ends the read; the time limit is no AbortError.
        if (isAbortError(error) || p.signal?.aborted) throw error;
        this.deps.logger.warn(`The merged configuration of ${p.repository} could not be read: ${errorMessage(error)}`);
      }
    }
    const value = await this.readConfigurationOutput(p, false);
    return { config: value.configuration as DevcontainerConfig };
  }

  private async readConfigurationOutput(
    p: {
      volumeName: string;
      repository: string;
      configPath: string;
      environmentId: string;
      override?: Record<string, unknown>;
      files?: HelperFiles;
      env?: Record<string, string>;
      image?: HelperImageUse;
      onOutput?: (text: string) => void;
      signal?: AbortSignal;
    },
    merged: boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown> & { configuration: Record<string, unknown> }> {
    const folder = this.repositoryFolder(p.repository);
    const withFiles = p.override !== undefined || p.files !== undefined;
    const args = readConfigurationArgs({
      workspaceFolder: folder,
      configPath: `${folder}/${checkConfigPath(p.configPath)}`,
      idLabel: environmentIdLabel(p.environmentId),
      merged,
      overrideConfigPath: p.override !== undefined ? OVERRIDE_CONFIG_PATH : undefined,
    });
    const result = await this.runStreams(p.volumeName, withFiles ? writeAndRunCommand({}, args) : ['devcontainer', ...args], {
      batch: {
        kind: 'readConfiguration',
        params: {
          repository: p.repository,
          configPath: p.configPath,
          environmentId: p.environmentId,
          merged,
          ...(p.override !== undefined ? { override: p.override } : {}),
          ...(p.files !== undefined ? { files: p.files } : {}),
        },
      },
      input: withFiles ? writeAndRunInput(p.files, p.override) : undefined,
      env: p.env,
      image: p.image,
      timeoutMs,
      signal: p.signal,
      onStderr: p.onOutput ?? this.logOutput,
    });
    const command = 'devcontainer read-configuration';
    if (result.exitCode !== 0) throw new CommandError(command, result.exitCode, result.stdout, result.stderr);
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
    for (let i = lines.length - 1; i >= 0; i--) {
      let value: unknown;
      try {
        value = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (isRecord(value) && isRecord(value.configuration)) {
        return value as Record<string, unknown> & { configuration: Record<string, unknown> };
      }
    }
    throw new CommandError(command, result.exitCode, result.stdout, `No configuration in the output.\n${result.stderr}`);
  }

  /**
   * devcontainer build: the environment image from the configuration in the volume. Output lines go to onOutput, the
   * JSON result is returned. A failed build (exit code, or outcome 'error') throws DevcontainerCommandError.
   */
  build(p: {
    volumeName: string;
    repository: string;
    configPath: string;
    imageName: string;
    /**
     * Docker Compose: our copy of the configuration (composeConfigOverride), written into the helper at
     * OVERRIDE_CONFIG_PATH and named by `--config` (`build` has no `--override-config`, buildArgs), with `files` (our
     * model, the Dockerfile of a synthesized build) and `env` (COMPOSE_PROJECT_NAME). The repository's lockfile is used
     * (WRITE_AND_RUN_SCRIPT).
     */
    override?: Record<string, unknown>;
    files?: HelperFiles;
    env?: Record<string, string>;
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<DevcontainerResult> {
    const folder = this.repositoryFolder(p.repository);
    const configFile = `${folder}/${checkConfigPath(p.configPath)}`;
    this.deps.logger.info(`Building the environment image ${p.imageName} from ${p.configPath}.`);
    if (p.override === undefined && p.files === undefined) {
      const args = buildArgs({ workspaceFolder: folder, configPath: configFile, imageName: p.imageName });
      return this.runDevcontainer('devcontainer build', p.volumeName, buildCommand(configFile, args), {
        batch: { kind: 'build', params: { repository: p.repository, configPath: p.configPath, imageName: p.imageName } },
        env: p.env,
        image: p.image,
        onOutput: p.onOutput,
        signal: p.signal,
      });
    }
    const config = p.override !== undefined ? OVERRIDE_CONFIG_PATH : configFile;
    const args = buildArgs({ workspaceFolder: folder, configPath: config, imageName: p.imageName });
    const command = writeAndRunCommand({ repositoryConfig: configFile, config: p.override !== undefined ? OVERRIDE_CONFIG_PATH : undefined }, args);
    return this.runDevcontainer('devcontainer build', p.volumeName, command, {
      batch: {
        kind: 'build',
        params: {
          repository: p.repository,
          configPath: p.configPath,
          imageName: p.imageName,
          ...(p.override !== undefined ? { override: p.override } : {}),
          ...(p.files !== undefined ? { files: p.files } : {}),
        },
      },
      input: writeAndRunInput(p.files, p.override),
      env: p.env,
      image: p.image,
      onOutput: p.onOutput,
      signal: p.signal,
    });
  }

  /**
   * The merged model of a Docker Compose configuration (COMPOSE_MODEL_SCRIPT: `docker compose config --format json` of
   * `files`, all profiles, with COMPOSE_PROJECT_NAME=`project`): the step composeModel, as the owner of the repository,
   * without the Docker socket and with the configuration folder of the volume closed (implementation notes §17). `files`
   * are absolute paths in the repository folder (resolveComposeFiles). `{ error }` carries the message of Docker Compose. Throws CommandError when the helper fails.
   */
  async composeModel(p: {
    volumeName: string;
    repository: string;
    files: readonly string[];
    project: string;
    timeoutMs?: number;
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    signal?: AbortSignal;
  }): Promise<ComposeModelOutput | { error: string }> {
    const folder = this.repositoryFolder(p.repository);
    if (p.files.length === 0 || p.files.some((file) => !file.startsWith(`${folder}/`) || file.split('/').some((part) => part === '..' || part === '.'))) {
      throw new Error(`Invalid compose files: ${p.files.join(', ')}`);
    }
    this.deps.logger.info(`Reading the Docker Compose configuration of ${p.repository} (${p.files.join(', ')}).`);
    const result = await this.runStreams(p.volumeName, composeModelCommand(folder, p.files), {
      batch: { kind: 'composeModel', params: { repository: p.repository, files: [...p.files], project: p.project } },
      image: p.image,
      env: { COMPOSE_PROJECT_NAME: p.project },
      timeoutMs: p.timeoutMs ?? COMPOSE_MODEL_TIMEOUT_MS,
      signal: p.signal,
      onStderr: this.logOutput,
    });
    if (result.exitCode !== 0) throw new CommandError('docker compose config', result.exitCode, result.stdout, result.stderr);
    return parseComposeModelOutput(result.stdout);
  }

  /**
   * Recreate offer, review round 2: the configuration hash of each service of the up model `model` (its text, as `up`
   * gets it at COMPOSE_MODEL_PATH) with the project name `project`, computed by the Docker Compose of this helper, the
   * one that runs `up` (COMPOSE_HASH_SCRIPT): the step composeHash, as the owner of the repository, without the Docker
   * socket and with the configuration folder of the volume closed. Throws CommandError when Compose fails.
   */
  async composeServiceHashes(p: {
    volumeName: string;
    repository: string;
    model: string;
    project: string;
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    signal?: AbortSignal;
  }): Promise<Map<string, string>> {
    this.deps.logger.info(`Computing the configuration hashes of the Docker Compose services of ${p.repository}.`);
    const result = await this.runStreams(p.volumeName, composeHashCommand(COMPOSE_MODEL_PATH, p.project), {
      batch: { kind: 'composeHash', params: { repository: p.repository, model: p.model, project: p.project } },
      image: p.image,
      input: p.model,
      env: { COMPOSE_PROJECT_NAME: p.project },
      timeoutMs: COMPOSE_MODEL_TIMEOUT_MS,
      signal: p.signal,
      onStderr: this.logOutput,
    });
    if (result.exitCode !== 0) throw new CommandError('docker compose config --hash', result.exitCode, result.stdout, result.stderr);
    return parseComposeHashes(result.stdout);
  }

  /**
   * Review round 8 (P8-2): creates the folders of the repository that the bind mounts of a Docker Compose configuration
   * name and that do not exist yet (composeUpModel's `createFolders`, absolute paths below the repository folder), as
   * Docker would create them on the computer (CREATE_FOLDERS_SCRIPT: no part through a link out of the repository).
   * The step createFolders, as the owner of the repository, without the Docker socket and with the configuration folder of
   * the volume closed. Throws CommandError when a folder cannot be created.
   */
  async createRepositoryFolders(p: {
    volumeName: string;
    repository: string;
    folders: readonly string[];
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    signal?: AbortSignal;
  }): Promise<void> {
    const folder = this.repositoryFolder(p.repository);
    if (p.folders.some((entry) => !entry.startsWith(`${folder}/`) || entry.slice(folder.length + 1).split('/').some((part) => part === '..' || part === '.' || part === ''))) {
      throw new Error(`Invalid folders: ${p.folders.join(', ')}`);
    }
    if (p.folders.length === 0) return;
    this.deps.logger.info(`Creating the folders ${p.folders.join(', ')} of ${p.repository} for the bind mounts of Docker Compose.`);
    const result = await this.runStreams(p.volumeName, createFoldersCommand(folder, p.folders), {
      batch: { kind: 'createFolders', params: { repository: p.repository, folders: [...p.folders] } },
      image: p.image,
      signal: p.signal,
      onStderr: this.logOutput,
    });
    if (result.exitCode !== 0) throw new CommandError('create the folders of the bind mounts', result.exitCode, result.stdout, result.stderr);
  }

  /**
   * devcontainer up with the override configuration. The override configuration is passed on stdin and written to a
   * temporary file inside the helper. SKIP_POST_ATTACH_ARG (V-1). Throws DevcontainerCommandError.
   * Lifecycle token (user decision 2026-09-27): with SKIP_POST_CREATE_ARG, `up` runs no lifecycle command; runUserCommands
   * runs them once the token is in the container.
   * A failed lifecycle command (isLifecycleCommandFailure) does not throw when its container runs: like the Dev
   * Containers extension, which connects and reports the failed command, the container is kept (concept 7.6, 7.7).
   * The result then has outcome 'success', the container ID, and `lifecycleCommandFailure`.
   */
  async up(p: {
    volumeName: string;
    repository: string;
    override: Record<string, unknown>;
    environmentId: string;
    removeExistingContainer: boolean;
    /** Docker Compose: files for the helper besides the override configuration (our model), and `env` (COMPOSE_PROJECT_NAME). */
    files?: HelperFiles;
    env?: Record<string, string>;
    /** Review PL-1: removed from the output and from the error (none of the commands of `up` reads it). */
    token?: string;
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<UpResult> {
    const folder = this.repositoryFolder(p.repository);
    const args = upArgs({
      workspaceFolder: folder,
      overrideConfigPath: OVERRIDE_CONFIG_PATH,
      idLabel: environmentIdLabel(p.environmentId),
      removeExistingContainer: p.removeExistingContainer,
    });
    this.deps.logger.info(
      `Starting the container of ${p.repository}${p.removeExistingContainer ? ' (replacing the existing container)' : ''}.`,
    );
    try {
      return await this.runDevcontainer('devcontainer up', p.volumeName, overrideCommand(args, p.files), {
        batch: {
          kind: 'up',
          params: {
            repository: p.repository,
            override: p.override,
            environmentId: p.environmentId,
            removeExistingContainer: p.removeExistingContainer,
            ...(p.files !== undefined ? { files: p.files } : {}),
          },
        },
        input: overrideInput(p.files, p.override),
        env: p.env,
        secret: p.token,
        image: p.image,
        onOutput: p.onOutput,
        signal: p.signal,
      });
    } catch (error) {
      return this.keptAfterLifecycleFailure(error, p.repository, p.signal);
    }
  }

  /**
   * Lifecycle token (user decision 2026-09-27): `devcontainer run-user-commands` (runUserCommandsArgs) for the container
   * `containerId` that `up` returned, with the same inputs as `up` (the override configuration, and for Docker Compose
   * `files` and `env`), so the CLI runs the lifecycle commands that `up` skipped, as `up` would have run them (its
   * markers in the container skip what ran already). Throws DevcontainerCommandError. A failed lifecycle command whose
   * container runs does not throw (as for up): the result has `lifecycleCommandFailure`. The CLI's result of a failed
   * command names no container; the error gets `containerId`, so that it reads as the error of `up`.
   */
  async runUserCommands(p: {
    volumeName: string;
    repository: string;
    override: Record<string, unknown>;
    environmentId: string;
    containerId: string;
    files?: HelperFiles;
    env?: Record<string, string>;
    /**
     * Review PL-1: the token in the container, which the lifecycle commands can read: removed from their output and from
     * the error (the command output of DevcontainerCommandError), also when it is split across chunks.
     */
    token: string;
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<UpResult> {
    const args = runUserCommandsArgs({
      workspaceFolder: this.repositoryFolder(p.repository),
      overrideConfigPath: OVERRIDE_CONFIG_PATH,
      idLabel: environmentIdLabel(p.environmentId),
      containerId: p.containerId,
    });
    this.deps.logger.info(`Running the lifecycle commands of ${p.repository} in the container ${p.containerId.slice(0, 12)}.`);
    try {
      const result = await this.runDevcontainer('devcontainer run-user-commands', p.volumeName, overrideCommand(args, p.files), {
        batch: {
          kind: 'runUserCommands',
          params: {
            repository: p.repository,
            override: p.override,
            environmentId: p.environmentId,
            containerId: p.containerId,
            ...(p.files !== undefined ? { files: p.files } : {}),
          },
        },
        input: overrideInput(p.files, p.override),
        env: p.env,
        secret: p.token,
        image: p.image,
        onOutput: p.onOutput,
        signal: p.signal,
      });
      return { ...result, containerId: p.containerId };
    } catch (error) {
      if (error instanceof DevcontainerCommandError && error.result !== undefined && error.result.containerId === undefined) {
        const withContainer = new DevcontainerCommandError(error.command, error.exitCode, error.stdout, error.stderr, {
          ...error.result,
          containerId: p.containerId,
        });
        return this.keptAfterLifecycleFailure(withContainer, p.repository, p.signal);
      }
      return this.keptAfterLifecycleFailure(error, p.repository, p.signal);
    }
  }

  /** The result for a failed lifecycle command whose container runs (up, runUserCommands); rethrows anything else. */
  private async keptAfterLifecycleFailure(error: unknown, repository: string, signal: AbortSignal | undefined): Promise<UpResult> {
    if (!(error instanceof DevcontainerCommandError) || !isLifecycleCommandFailure(error.result)) throw error;
    const { containerId, description } = error.result;
    if (!(await this.containerRuns(containerId, signal))) throw error;
    this.deps.logger.warn(`${description} The container ${containerId.slice(0, 12)} of ${repository} runs and is kept.`);
    return { outcome: 'success', containerId, lifecycleCommandFailure: description };
  }

  /**
   * Writes the Git and Docker configuration of the dev container into the volume (GIT_FILES_SCRIPT, concept section 9
   * "Git inside the container"): the step gitFiles of the batch helper (root). Unit 15: no token; the token
   * and the sign-in of the GitHub CLI go into the memory of the dev container after its start (writeContainerToken,
   * ./containerToken.ts). Throws CommandError.
   */
  async prepareGit(p: {
    volumeName: string;
    repository: string;
    identity: GitIdentity;
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const { name } = checkRepository(p.repository);
    const output = p.onOutput ?? this.logOutput;
    this.deps.logger.info(`Writing the Git configuration of ${p.repository} into the volume ${p.volumeName}.`);
    const result = await this.runStreams(p.volumeName, gitFilesCommand(name, p.identity, CONTAINER_CREDENTIAL_HELPER), {
      batch: { kind: 'gitFiles', params: { repository: p.repository, identity: { name: p.identity.name, email: p.identity.email } } },
      image: p.image,
      signal: p.signal,
      onStdout: output,
      onStderr: output,
    });
    if (result.exitCode !== 0) throw new CommandError('prepare Git', result.exitCode, result.stdout, result.stderr);
  }

  /**
   * Review round 15 (K3 = P15-1, D15-1, S15-3): gives the files in `folder` of the volume (the extension's internal folder,
   * CONFIG_FOLDER) the owner `uid`:`gid` (numbers, as `id -u` and `id -g` print them in the dev container): the step
   * ownershipFix of the batch helper, which mounts only the workspace volume of the dev container, with
   * CONFIG_OWNERSHIP_FIX_SCRIPT. No mount of the dev container (for example through a link of the repository,
   * `volumes_from`, or a tmpfs) is there: the fix walks only the folder of the volume. Throws for IDs that are not numbers
   * (configOwnershipFixCommand); returns the result also for a non-zero exit code.
   */
  async fixConfigOwnership(p: {
    volumeName: string;
    folder: string;
    uid: string;
    gid: string;
    timeoutMs?: number;
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    return this.runStreams(p.volumeName, configOwnershipFixCommand(p.folder, p.uid, p.gid), {
      batch: { kind: 'ownershipFix', params: { folder: p.folder, uid: p.uid, gid: p.gid } },
      image: p.image,
      timeoutMs: p.timeoutMs,
      signal: p.signal,
    });
  }

  /**
   * Git state of the repository in the volume (for a container that does not run). Plan step 7 (user decision of
   * 2026-10-01): the step gitSummary, as the owner of the repository (as nobody when the folder is missing), without the
   * Docker socket: Git runs programs that the repository configuration names. Throws CommandError.
   */
  async gitSummary(p: { volumeName: string; repository: string; signal?: AbortSignal }): Promise<GitSummary> {
    const folder = this.repositoryFolder(p.repository);
    const result = await this.runStreams(p.volumeName, gitSummaryCommand(folder), {
      // Plan step 7 (user decision of 2026-10-01): a step of the batch helper, as the owner of the repository.
      batch: { kind: 'gitSummary', params: { repository: p.repository } },
      signal: p.signal,
      onStderr: this.logOutput,
    });
    if (result.exitCode !== 0) throw new CommandError('git summary', result.exitCode, result.stdout, result.stderr);
    return parseGitSummaryOutput(result.stdout, isoTime(this.clock));
  }

  private readonly logOutput = (text: string): void => this.deps.logger.output(text);

  /**
   * The helper image (HelperImageUse). `recheck` (ensureImage): ensureHelperImage with the maintenance; a result older
   * than HELPER_IMAGE_RECHECK_MS, or one of a helper run, is not reused. The helper runs (`recheck` false) reuse any result
   * and only record the use (at most once per hour); without a result (a new window), they run ensureHelperImage without
   * the maintenance, which only builds a missing tag. So no check of the base image, no rebuild, and no cleanup delays
   * a stop or a delete. Review round 2 of PR #64 (A-N1): a run with the helper image of an open
   * (`image`) does not use this cache; the open recorded the use when it resolved the image (ensureImage).
   */
  private image(options: EnsureImageOptions, recheck: boolean): Promise<HelperImageUse> {
    // Plan step 5, PR D (rule D1 of 2026-09-30): the check and the build of the helper image run without the worker, which
    // is opened from it (workerPreparation.ts); so also the shared promise of the cache never waits for the worker.
    return runPreparingWorker(() => this.imageNow(options, recheck));
  }

  private async imageNow(options: EnsureImageOptions, recheck: boolean): Promise<HelperImageUse> {
    const engine = await this.currentEngine();
    // Unit 7: an image of another engine (the Docker context changed) is not reused.
    this.adoptEngine(engine.key);
    const statePath = this.statePathFor(engine);
    if (recheck && this.imagePromise && !this.imageMaintained) {
      // The result of a helper run: wait until it is ready (a missing tag is built only once), then maintain.
      const pending = this.imagePromise;
      if (this.imageReadyAt === undefined) {
        try {
          await this.join(pending, options);
        } catch (error) {
          // Review round 5 of PR #64 (R5-1): the abort of this caller ends this call; a failure of the shared build
          // does not (it is tried again below).
          if (isAbortError(error) && options.signal?.aborted) throw error;
        }
      }
      if (this.imagePromise === pending) this.resetImage();
      // Review round 8 of PR #64 (R8-1): another open with another engine may have replaced the cache during the join.
      this.adoptEngine(engine.key);
    }
    if (this.imagePromise && this.imageReadyAt !== undefined) {
      const now = this.clock.now();
      if (recheck && Math.abs(now - this.imageReadyAt) >= HELPER_IMAGE_RECHECK_MS) this.resetImage();
      else if (recheck && !(await this.cachedImageCurrent())) this.resetImage();
      else await this.recordUse(now, statePath);
    }
    // Review round 8 of PR #64 (R8-1): another open with another engine may have replaced the cache during the awaits
    // above. No await follows until the join below, so the caller joins a promise of its own engine.
    this.adoptEngine(engine.key);
    if (!this.imagePromise) {
      // Review round 7 of PR #64 (R7-3): a caller cancelled during the awaits above starts no shared ensure, whose
      // rejection nothing would handle (join rejects at once for an aborted signal) and which could start a build.
      if (options.signal?.aborted) throw abortError();
      const listeners = new Set<(kind: HelperBuildKind) => void>();
      let built = false;
      const promise: Promise<HelperImageUse> = ensureHelperImageUse(this.deps.docker, this.deps.dockerfilePath, {
        onOutput: options.onOutput ?? this.logOutput,
        signal: options.signal,
        statePath,
        baseDigest: this.deps.baseDigest,
        maintain: recheck,
        checkBaseImage: options.checkBaseImage,
        // Review round 5 of PR #64 (R5-1): the progress reaches every caller that awaits this promise (join), not only
        // the caller that started it.
        onBuild: (kind) => {
          built = true;
          if (this.imagePromise === promise) this.imageBuilding = kind;
          for (const listener of [...listeners]) listener(kind);
        },
        onBaseImageCheck: this.deps.onBaseImageCheck,
        clock: this.clock,
        logger: this.deps.logger,
      }).then(
        (use) => {
          if (this.imagePromise === promise) {
            this.imageBuilding = undefined;
            this.imageReadyAt = this.clock.now();
            this.imageUsedAt = this.imageReadyAt;
            this.imageTag = use.tag;
            this.imageCachedId = use.id;
          }
          if (built) {
            try {
              this.deps.onImageBuilt?.();
            } catch (error) {
              this.deps.logger.warn(`The built helper image could not be reported: ${errorMessage(error)}`);
            }
          }
          return use;
        },
        (error: unknown) => {
          if (this.imagePromise === promise) {
            this.imagePromise = undefined;
            this.imageBuilding = undefined;
          }
          if (isAbortError(error) || isUserFacingError(error)) throw error;
          this.deps.logger.error('The workspace helper image could not be built.', error);
          throw new UserFacingError('helperFailed', Messages.helperFailed, errorMessage(error));
        },
      );
      this.imagePromise = promise;
      this.imageMaintained = recheck;
      this.imageBuilding = undefined;
      this.imageBuildListeners = listeners;
    }
    try {
      // Review round 3 of PR #64 (P1): the caller gets the image that it awaited, also when the cache was replaced
      // meanwhile (resetImage). Review round 5 of PR #64 (R5-1): its own signal ends its wait (join).
      return await this.join(this.imagePromise, options);
    } catch (error) {
      // Another caller cancelled the shared build: build again for this caller.
      if (isAbortError(error) && !options.signal?.aborted) return this.image(options, recheck);
      throw error;
    }
  }

  /**
   * Unit 7: makes `key` the engine of the cache; a cache of another engine is reset (its image is not reused). Review
   * round 8 of PR #64 (R8-1): called again after each await of `image`, because the opens of a window (each with the
   * engine of its operation) share the cache.
   */
  private adoptEngine(key: string): void {
    if (this.imagePromise && key !== this.imageEngine) this.resetImage();
    this.imageEngine = key;
  }

  private resetImage(): void {
    this.imagePromise = undefined;
    this.imageMaintained = false;
    this.imageReadyAt = undefined;
    this.imageCachedId = undefined;
    this.imageBuilding = undefined;
    this.imageBuildListeners = undefined;
  }

  /**
   * Review round 5 of PR #64 (R5-1): awaits the cached image promise `pending` (the current one) for one caller. The
   * signal of the caller ends only its own wait: it rejects with an AbortError at once (also when it was aborted before),
   * and the shared build goes on with the signal of the caller that started it. The onBuild of the caller gets the
   * progress of the shared build: at once when a build has started, otherwise when it starts, until `pending` settles.
   */
  private join(pending: Promise<HelperImageUse>, options: EnsureImageOptions): Promise<HelperImageUse> {
    const { signal, onBuild } = options;
    if (signal?.aborted) return Promise.reject(abortError());
    const listeners = this.imageBuildListeners;
    let listener: ((kind: HelperBuildKind) => void) | undefined;
    if (onBuild !== undefined) {
      if (this.imageBuilding !== undefined) onBuild(this.imageBuilding);
      else if (listeners !== undefined) {
        listener = (kind) => onBuild(kind);
        listeners.add(listener);
      }
    }
    if (signal === undefined && listener === undefined) return pending;
    return new Promise<HelperImageUse>((resolve, reject) => {
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        if (listener !== undefined) listeners?.delete(listener);
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (use) => {
          cleanup();
          resolve(use);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  /**
   * Review round 4 of PR #64 (R4-1): whether the resolved result in the cache is still the image of its tag, before an
   * open reuses it (ensureImage, within HELPER_IMAGE_RECHECK_MS). Another window may have rebuilt the tag (its old image
   * is then removed, or the containerd store drops it) or a prune may have removed it: an open would then pin an ID that
   * no longer exists and fail. `false` when the tag is gone or has another image now; `true` when Docker cannot answer
   * (the cache stays, as before the check) or when the cache changed meanwhile (the caller then awaits the new promise).
   */
  private async cachedImageCurrent(): Promise<boolean> {
    const promise = this.imagePromise;
    const tag = this.imageTag;
    const cachedId = this.imageCachedId;
    if (promise === undefined || tag === undefined) return true;
    let current: string | undefined;
    try {
      current = await this.deps.docker.imageId(tag);
    } catch (error) {
      this.deps.logger.warn(`The workspace helper image ${tag} could not be checked: ${errorMessage(error)}`);
      return true;
    }
    if (this.imagePromise !== promise) return true;
    if (current === cachedId) return true;
    this.deps.logger.info(
      current === undefined
        ? `The workspace helper image ${tag} was removed. It is prepared again.`
        : `The workspace helper image ${tag} has another image now. It is prepared again.`,
    );
    return false;
  }

  /** `lastUsedAt` of the tag in the state file, at most once per hour per instance. Never throws. */
  private async recordUse(now: number, statePath: string | undefined): Promise<void> {
    const tag = this.imageTag;
    if (statePath === undefined || tag === undefined) return;
    if (this.imageUsedAt !== undefined && Math.abs(now - this.imageUsedAt) < HELPER_LAST_USED_INTERVAL_MS) return;
    this.imageUsedAt = now;
    await recordHelperImageUse(statePath, tag, { clock: this.clock, logger: this.deps.logger });
  }

  /** Whether the container has the state `running`. A failed query counts as `false`; an abort passes through. */
  private async containerRuns(containerId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await this.deps.docker.run(['container', 'inspect', '--format', '{{json .State.Status}}', containerId], {
        timeoutMs: DOCKER_QUERY_TIMEOUT_MS,
        signal,
      });
      return result.exitCode === 0 && result.stdout.trim() === '"running"';
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.deps.logger.warn(`The state of the container ${containerId.slice(0, 12)} could not be read: ${errorMessage(error)}`);
      return false;
    }
  }

  private redactingOutput(output: (text: string) => void, secret: string): (text: string) => void {
    return (text) => output(redact(text, secret));
  }

  private repositoryFolder(repository: string): string {
    return `${WORKSPACES_ROOT}/${checkRepository(repository).name}`;
  }

  private async runDevcontainer(
    command: string,
    volumeName: string,
    helperCommand: string[],
    options: {
      /** Plan step 6, PR C: the step of the batch helper (StreamOptions.batch); `secret` is added here. */
      batch: NonNullable<StreamOptions['batch']>;
      input?: string;
      env?: Record<string, string>;
      secret?: string;
      image?: HelperImageUse;
      onOutput?: (text: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<DevcontainerResult> {
    const output = options.onOutput ?? this.logOutput;
    const secret = options.secret;
    // Review PL-1: stdout goes on in whole lines (ResultLineFilter), stderr through a RedactingStream.
    const stdoutFilter = new ResultLineFilter(secret === undefined ? output : this.redactingOutput(output, secret));
    const stderr = secret === undefined ? undefined : new RedactingStream(output, secret);
    let result: RunResult;
    try {
      result = await this.runStreams(volumeName, helperCommand, {
        // Plan step 6, PR C: `up` and run-user-commands take the token only to mask their output in the helper.
        batch: { ...options.batch, ...(secret !== undefined ? { secret } : {}) },
        input: options.input,
        env: options.env,
        image: options.image,
        signal: options.signal,
        onStdout: (text) => stdoutFilter.write(text),
        onStderr: stderr === undefined ? output : (text) => stderr.write(text),
      });
    } finally {
      stdoutFilter.flush();
      stderr?.flush();
    }
    if (secret !== undefined) result = { ...result, stdout: redact(result.stdout, secret), stderr: redact(result.stderr, secret) };
    let parsed: DevcontainerResult | undefined;
    try {
      parsed = parseDevcontainerResult(result.stdout);
    } catch {
      parsed = undefined;
    }
    if (result.exitCode === 0 && parsed?.outcome === 'success') return parsed;
    throw new DevcontainerCommandError(command, result.exitCode, result.stdout, result.stderr, parsed);
  }

  private async runStreams(volumeName: string, command: readonly string[], options: StreamOptions): Promise<RunResult> {
    // Plan step 6, PR C: within an operation, only through the batch helper of the operation (never a `docker run` of its
    // own). Plan step 7 (user decision of 2026-10-01): the per-step `docker run` is removed; a volume step outside the
    // batch scope of an operation is an internal error (D1), and no container is started for it.
    const scope = currentBatchScope();
    if (scope === undefined) {
      const message = `Internal error: the workspace helper step ${options.batch.kind} (${describeCommand(command)}) on the volume ${volumeName} ran outside the batch helper of an operation; it was not run.`;
      this.deps.logger.error(message);
      throw new Error(message);
    }
    return this.runInBatch(scope, volumeName, command, options);
  }

  /**
   * Plan step 6, PR C: a run as a step of the batch helper of the operation (batchScope.ts), with the result of the step:
   * the exit code, the output, and for the time limit an Error that is not an AbortError. User decision D1: a run is
   * never a `docker run` of its own (plan step 7: that path is removed). The variables pass the same
   * checks as for `-e` (helperEnv) and go on the process of the step in the helper. The session opens with the pinned
   * helper image of the open (its ID) and the socket of the engine.
   */
  private async runInBatch(scope: BatchScope, volumeName: string, command: readonly string[], options: StreamOptions): Promise<RunResult> {
    const batch = options.batch;
    const params: Record<string, unknown> = { ...batch.params };
    // The kinds with variables of the request; the Compose read steps set COMPOSE_PROJECT_NAME from their `project`.
    const env = BATCH_ENV_KINDS.has(batch.kind) ? this.helperEnv(options.env ?? {}) : {};
    const names = Object.keys(env);
    if (names.length > 0) params.env = env;
    this.deps.logger.info(`Batch helper step ${batch.kind}` + (names.length > 0 ? ` (variables: ${names.join(', ')})` : '') + '.');
    const result = await scope.step(
      {
        volume: volumeName,
        kind: batch.kind,
        params,
        options: {
          secret: batch.secret,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          onOutput: (stream, text) => (stream === 'stdout' ? options.onStdout : options.onStderr)?.(text),
        },
      },
      async () => {
        const use = options.image ?? (await this.image({ onOutput: options.onStderr, signal: options.signal }, false));
        if (use.id === undefined) throw new Error(`the ID of the helper image ${use.tag} is not known`);
        return { image: use.id, socket: this.socketPathFor(await this.currentEngine()) };
      },
    );
    if (result.timedOut) {
      const seconds = Math.round((options.timeoutMs ?? 0) / 1000);
      throw new Error(`The step ${batch.kind} of the batch helper did not end within ${seconds} seconds.`);
    }
    return result;
  }

  private helperEnv(env: Record<string, string>): Record<string, string> {
    const names = Object.keys(env);
    const result: Record<string, string> = {};
    for (const name of names) {
      if (isPassableEnvName(name)) result[name] = env[name];
      else this.deps.logger.warn(`The variable ${name} is not passed to the workspace helper.`);
    }
    return result;
  }
}
