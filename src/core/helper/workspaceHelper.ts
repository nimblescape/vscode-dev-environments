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
import { SECRET_TOKEN } from '../helperChannel/protocol';
import { DOCKER_QUERY_TIMEOUT_MS, type BootstrapDocker } from '../docker/bootstrapDocker';
import { CommandError, UserFacingError, errorMessage } from '../errors';
import { boundServiceFolders, configOwnershipFixCommand, repositoryOwnershipFixCommand, type ServiceFolders } from '../git/gitSummary';
import { Messages } from '../messages';
import { WORKSPACES_ROOT, environmentIdLabel } from '../names';
import { abortError, isAbortError, type RunResult } from '../ports';
import type { DevcontainerConfig, DevcontainerResult } from '../types';
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
import type { HelperBuildKind, HelperImageUse } from './helperImage';
// Plan step 11F2: the helper image moved to helperImages.ts.
import {
  DOCKER_SOCKET,
  HELPER_IMAGE_RECHECK_MS,
  HelperImages,
  helperDockerSocket,
  helperStatePathFor,
  type EnsureImageOptions,
  type HelperEngine,
  type HelperImageDocker,
  type HelperImagesDeps,
  type PresentImageOptions,
} from './helperImages';

export {
  DOCKER_SOCKET,
  HELPER_IMAGE_RECHECK_MS,
  helperDockerSocket,
  helperStatePathFor,
  type EnsureImageOptions,
  type HelperEngine,
  type HelperImagesDeps,
  type HelperImageUse,
  type PresentImageOptions,
};
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
import { batchStepCommand, type BatchStepKind } from './batchSteps';

export { isPassableEnvName };

/** The part of the Docker port that the helper uses: the helper image's, and `run` (containerRuns without the dep). */
export type HelperDocker = HelperImageDocker & Pick<BootstrapDocker, 'run'>;

/** Result of WorkspaceHelper.up. */
export interface UpResult extends DevcontainerResult {
  /** The description of the CLI when a lifecycle command failed and the running container was kept. */
  lifecycleCommandFailure?: string;
}

/** Plan step 11F2: the deps of the helper image (HelperImagesDeps), and the ones of the steps. */
export interface HelperDeps extends HelperImagesDeps {
  docker: HelperDocker;
  /**
   * Plan step 11B3b: the helper image of the worker in which this helper runs (its tag and ID). With it, every helper
   * image of an operation is that one (section 3b of the plan: the helper image of an open is the worker's own image):
   * nothing is checked, built, maintained or recorded, and the Dockerfile is never read.
   */
  ownImage?: HelperImageUse;
  /**
   * Plan step 11E6 (review round 1 of PR #111, A-M2): whether a container runs, for the open in the worker, which
   * runs no Docker CLI of its own (its engine answers). Default: `docker container inspect` through `docker.run`.
   */
  containerRuns?: (containerId: string, signal?: AbortSignal) => Promise<boolean>;
}

/**
 * Time limit of the helper run that reads the merged configuration (readConfiguration). Without a container, the CLI
 * reads the base image and the Features for it from the registries, and a network that drops packets would hold the
 * open for as long as the time limits of TCP and HTTP. After this time the configuration is read without it.
 */
export const MERGED_CONFIGURATION_TIMEOUT_MS = 10_000;

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

/**
 * Review round 1 of PR #114 (A-M2): the most characters of the paths of the services in the request of the ownership fix
 * before the create, well below the bound of a request of the batch helper (MAX_BATCH_INPUT_CHARACTERS, 3 MiB); over it,
 * the whole repository counts as a path of the services.
 */
const MAX_SERVICE_FOLDERS_REQUEST_CHARACTERS = 1024 * 1024;

/** Time limit of the model run of a Docker Compose configuration (composeModel). */
export const COMPOSE_MODEL_TIMEOUT_MS = 60_000;

/** Workspace helper (implementation notes 7, concept 7.6). */
export class WorkspaceHelper {
  /** Plan step 11F2: the helper image (helperImages.ts); unused with HelperDeps.ownImage. */
  private readonly images: HelperImages;

  constructor(private readonly deps: HelperDeps) {
    this.images = new HelperImages(deps);
  }

  /** HelperImages.ensureImage; with HelperDeps.ownImage, its tag. */
  async ensureImage(options: EnsureImageOptions = {}): Promise<string> {
    return (await this.ensureImageUse(options)).tag;
  }

  /** HelperImages.ensureImageUse; with HelperDeps.ownImage, that image. */
  async ensureImageUse(options: EnsureImageOptions = {}): Promise<HelperImageUse> {
    if (this.deps.ownImage !== undefined) return this.ownImageUse(options.signal);
    return this.images.ensureImageUse(options);
  }

  /** HelperImages.ensureImagePresent; with HelperDeps.ownImage, that image. */
  async ensureImagePresent(options: PresentImageOptions = {}): Promise<HelperImageUse> {
    if (this.deps.ownImage !== undefined) return this.ownImageUse(options.signal);
    return this.images.ensureImagePresent(options);
  }

  /** HelperImages.checkImagePresent; with HelperDeps.ownImage, present. */
  async checkImagePresent(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.deps.ownImage !== undefined) {
      await this.ownImageUse(options.signal);
      return;
    }
    await this.images.checkImagePresent(options);
  }

  /** HelperImages.presentImage; with HelperDeps.ownImage, that image. */
  async presentImage(options: { signal?: AbortSignal } = {}): Promise<HelperImageUse | undefined> {
    if (this.deps.ownImage !== undefined) return this.ownImageUse(options.signal);
    return this.images.presentImage(options);
  }

  /** HelperImages.engineKey. */
  async engineKey(): Promise<string> {
    return this.images.engineKey();
  }

  /** HelperImages.prebuildImage; with HelperDeps.ownImage, that image. */
  async prebuildImage(options: { signal: AbortSignal; onBuild?: (kind: HelperBuildKind) => void }): Promise<HelperImageUse> {
    if (this.deps.ownImage !== undefined) return this.ownImageUse(options.signal);
    return this.images.prebuildImage(options);
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
   * Plan step 11G1 ("No extra containers"): gives the files of the repository folder of `repository` in the volume the
   * owner `uid`:`gid` (numbers, read from the /etc/passwd of the environment image), except in the paths of the services
   * `serviceFolders`, where only the files of root change: the step repositoryOwnershipFix of the batch helper, with
   * NUMERIC_OWNERSHIP_FIX_SCRIPT, before the dev container is created (it replaced the short-lived container of the
   * environment image). The paths are bounded as the pipeline bounds them (boundServiceFolders; an overflow is
   * `'repository'`), so that the step's checks accept them. Throws for IDs that are not numbers
   * (repositoryOwnershipFixCommand); returns the result also for a non-zero exit code.
   */
  async fixRepositoryOwnership(p: {
    volumeName: string;
    repository: string;
    uid: string;
    gid: string;
    serviceFolders?: ServiceFolders;
    timeoutMs?: number;
    /** The helper image of the open (HelperImageUse). */
    image?: HelperImageUse;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    const { name } = checkRepository(p.repository);
    const folder = `${WORKSPACES_ROOT}/${name}`;
    let serviceFolders: ServiceFolders | undefined = p.serviceFolders;
    if (serviceFolders !== undefined && serviceFolders !== 'repository') {
      const bounded = boundServiceFolders(folder, [serviceFolders]);
      serviceFolders = bounded.overflow ? 'repository' : bounded.folders;
    }
    const params = (folders: ServiceFolders | undefined) => ({
      repository: p.repository,
      uid: p.uid,
      gid: p.gid,
      ...(folders === undefined ? {} : { serviceFolders: folders === 'repository' ? folders : [...folders] }),
    });
    // Review round 1 of PR #114 (A-M2): paths of the services that the step would refuse (a control character, a path
    // too long, a list too large for the request) count as the whole repository (only the files of root change), as the
    // fix did before, instead of a refusal of the step that refuses the open.
    if (serviceFolders !== undefined && serviceFolders !== 'repository') {
      try {
        batchStepCommand('repositoryOwnershipFix', params(serviceFolders));
        if (JSON.stringify(serviceFolders).length > MAX_SERVICE_FOLDERS_REQUEST_CHARACTERS) serviceFolders = 'repository';
      } catch {
        serviceFolders = 'repository';
      }
    }
    const command = repositoryOwnershipFixCommand(folder, p.uid, p.gid, serviceFolders);
    return this.runStreams(p.volumeName, command, {
      batch: {
        kind: 'repositoryOwnershipFix',
        params: params(serviceFolders),
      },
      image: p.image,
      timeoutMs: p.timeoutMs,
      signal: p.signal,
    });
  }

  private readonly logOutput = (text: string): void => this.deps.logger.output(text);

  /**
   * The helper image of a run without the image of an open: HelperDeps.ownImage, else the image of HelperImages without
   * its maintenance (only a missing tag is built).
   */
  private runImage(options: EnsureImageOptions): Promise<HelperImageUse> {
    if (this.deps.ownImage !== undefined) return this.ownImageUse(options.signal);
    return this.images.runImage(options);
  }

  /** Plan step 11B3b: HelperDeps.ownImage (an abort of `signal` passes through, as for the other image calls). */
  private async ownImageUse(signal: AbortSignal | undefined): Promise<HelperImageUse> {
    if (signal?.aborted) throw abortError();
    return { ...(this.deps.ownImage as HelperImageUse) };
  }

  /** Whether the container has the state `running`. A failed query counts as `false`; an abort passes through. */
  private async containerRuns(containerId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      if (this.deps.containerRuns !== undefined) return await this.deps.containerRuns(containerId, signal);
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
          // Plan step 11A: the token is the named secret SECRET_TOKEN of the step.
          ...(batch.secret === undefined ? {} : { secrets: { [SECRET_TOKEN]: batch.secret } }),
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          onOutput: (stream, text) => (stream === 'stdout' ? options.onStdout : options.onStderr)?.(text),
        },
      },
      async () => {
        const use = options.image ?? (await this.runImage({ onOutput: options.onStderr, signal: options.signal }));
        if (use.id === undefined) throw new Error(`the ID of the helper image ${use.tag} is not known`);
        return { image: use.id, socket: this.images.socketPathFor(await this.images.currentEngine()) };
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
