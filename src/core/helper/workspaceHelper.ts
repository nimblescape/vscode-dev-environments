// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Workspace helper (implementation notes 7, concept 7.6): a short-lived container with Git and the Dev Container CLI.
// It mounts the workspace volume at /workspaces. The runs of the Dev Container CLI also get the Docker socket, so the
// CLI builds and starts dev containers with the Docker engine of the computer. Git and the scripts that read files run
// without the socket: Git runs programs that the repository configuration names (for example filter drivers).
import * as crypto from 'crypto';
import { DOCKER_QUERY_TIMEOUT_MS, type ContainerAdapter } from '../docker/containerAdapter';
import { CommandError, UserFacingError, errorMessage, isUserFacingError } from '../errors';
import { gitSummaryCommand, parseGitSummaryOutput } from '../git/gitSummary';
import { Messages } from '../messages';
import {
  HELPER_CACHE_VOLUME,
  LABEL_ENVIRONMENT_ID,
  LABEL_HELPER_RUN,
  WORKSPACES_ROOT,
  splitRepository,
} from '../names';
import { isAbortError, isoTime, systemClock, type Clock, type Logger, type RunResult } from '../ports';
import type { DevcontainerConfig, DevcontainerResult, GitSummary } from '../types';
import {
  DevcontainerCommandError,
  HELPER_CACHE_FOLDER,
  buildArgs,
  isLifecycleCommandFailure,
  parseDevcontainerResult,
  readConfigurationArgs,
  tryParseDevcontainerResult,
  upArgs,
} from './devcontainerCli';
import {
  HELPER_LAST_USED_INTERVAL_MS,
  ensureHelperImage,
  recordHelperImageUse,
  type BaseDigestLookup,
  type HelperBuildKind,
} from './helperImage';
import { CONTAINER_CREDENTIAL_HELPER, isGitHubLogin, type GitIdentity } from './containerGit';
import {
  OVERRIDE_CONFIG_PATH,
  SECRETS_FOLDER,
  buildCommand,
  cloneCommand,
  gitFilesCommand,
  listConfigsCommand,
  readFilesCommand,
  removeGitTokenCommand,
  switchBranchCommand,
  upCommand,
} from './scripts';

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
 * ensureImage reuses its result for this long. After that, it runs ensureHelperImage again, so a window that stays open
 * for days still checks the base image and cleans up when that is due.
 */
export const HELPER_IMAGE_RECHECK_MS = 60 * 60 * 1000;

/** Path of the Docker socket inside the helper, and the default source of the socket mount. */
export const DOCKER_SOCKET = '/var/run/docker.sock';

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
export function helperDockerSocket(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const host = env.DOCKER_HOST?.trim();
  if (platform !== 'linux' || !host || !host.startsWith('unix://')) return DOCKER_SOCKET;
  const socketPath = host.slice('unix://'.length);
  if (!socketPath.startsWith('/') || socketPath.includes('/.docker/desktop/')) return DOCKER_SOCKET;
  return socketPath;
}

// Variables that would break the tools in the helper (or point them to the computer) if a caller passed them with the
// `env` option of `run`. The pipeline passes no variable of the computer: `${localEnv:…}` resolves in the helper, to the
// value of the helper for a variable that it sets itself (HELPER_ENV_NAMES, for example HOME=/root), otherwise to an empty
// value or the default of the expression (concept section 9 "Host access").
const RESERVED_ENV_NAMES = new Set(['PATH', 'HOSTNAME', 'PWD', 'OLDPWD', 'SHLVL', 'IFS', 'ENV', 'TMPDIR', 'TMP', 'TEMP', 'NODE_OPTIONS']);
const RESERVED_ENV_PREFIXES = ['DOCKER_', 'BUILDX_', 'BUILDKIT_', 'LD_'];

/** Whether a local variable may be passed to the helper with `-e NAME=value`. DOCKER_HOST never is. */
export function isPassableEnvName(name: string): boolean {
  if (name === '' || name.includes('=') || name.includes('\0')) return false;
  const upper = name.toUpperCase();
  return !RESERVED_ENV_NAMES.has(upper) && !RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

function mountOption(fields: Record<string, string>): string {
  // --mount is CSV: quote a field that contains a comma or a quote.
  return Object.entries(fields)
    .map(([key, value]) => {
      const field = `${key}=${value}`;
      return /[",]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
    })
    .join(',');
}

export interface HelperRunSpec {
  tag: string;
  volumeName: string;
  socketPath: string;
  containerName: string;
  /** Passed with `-e NAME=value`. */
  env: Record<string, string>;
  /** Adds the tmpfs mount for the token. */
  secrets: boolean;
  /**
   * Mounts the Docker socket and the cache volume (default `true`). Only the runs of the Dev Container CLI need them;
   * a Git run gets neither, because Git runs programs that the repository configuration names.
   */
  docker?: boolean;
  /** `false`: `--network none`, for runs that need no network (default `true`). */
  network?: boolean;
  command: readonly string[];
}

/**
 * `docker run` arguments of one helper run: `--rm -i`, never a pull (the image exists only locally), the label
 * devenv.helper-run=true, the workspace volume at /workspaces, [the Docker socket and the cache volume], [`--network
 * none`], and for runs with the token a tmpfs mount (in memory, mode 0700).
 */
export function helperRunArgs(spec: HelperRunSpec): string[] {
  const args = [
    'run',
    '--rm',
    '-i',
    '--pull',
    'never',
    '--name',
    spec.containerName,
    '--label',
    `${LABEL_HELPER_RUN}=true`,
    '--mount',
    mountOption({ type: 'volume', source: spec.volumeName, target: WORKSPACES_ROOT }),
  ];
  if (spec.docker !== false) {
    args.push(
      '--mount',
      mountOption({ type: 'bind', source: spec.socketPath, target: DOCKER_SOCKET }),
      '--mount',
      mountOption({ type: 'volume', source: HELPER_CACHE_VOLUME, target: HELPER_CACHE_FOLDER }),
    );
  }
  if (spec.network === false) args.push('--network', 'none');
  if (spec.secrets) args.push('--tmpfs', `${SECRETS_FOLDER}:rw,noexec,nosuid,nodev,size=1m,mode=0700`);
  for (const [name, value] of Object.entries(spec.env)) args.push('-e', `${name}=${value}`);
  args.push(spec.tag, ...spec.command);
  return args;
}

/** Validates `owner/name` (GitHub names: letters, digits, `.`, `-`, `_`), so it can be part of a URL and a path. */
function checkRepository(repository: string): { owner: string; name: string } {
  const parts = splitRepository(repository);
  for (const part of [parts.owner, parts.name]) {
    if (!/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..' || part.startsWith('-')) {
      throw new Error(`Invalid repository name: ${repository}`);
    }
  }
  return parts;
}

/** A configuration path relative to the repository folder, without `..`. */
function checkConfigPath(configPath: string): string {
  const segments = configPath.split('/');
  if (
    configPath === '' ||
    configPath.startsWith('/') ||
    configPath.includes('\\') ||
    configPath.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid configuration path: ${configPath}`);
  }
  return configPath;
}

function checkToken(token: string): void {
  if (!token || /\s/.test(token)) throw new UserFacingError('signInRequired', Messages.signInRequired, 'No valid GitHub token.');
}

function redact(text: string, secret: string): string {
  return secret.length >= 4 ? text.split(secret).join('***') : text;
}

/** Git's message for the user: at most 15 lines. */
function gitMessageFromOutput(text: string): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  const shown = lines.slice(0, 15);
  if (lines.length > shown.length) shown.push('…');
  return shown.join('\n').slice(0, 2000);
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
   * Time limit of the helper container (not of a build of the helper image before it). When it ends, the container is
   * removed, and the run rejects with an Error that is not an AbortError.
   */
  timeoutMs?: number;
  input?: string;
  secrets?: boolean;
  /** See HelperRunSpec.docker (default `true`). */
  docker?: boolean;
  /** See HelperRunSpec.network (default `true`). */
  network?: boolean;
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

/** Workspace helper (implementation notes 7, concept 7.6). */
export class WorkspaceHelper {
  private imagePromise: Promise<string> | undefined;
  /** Whether the cached image promise comes from ensureImage (with the maintenance), not from a helper run. */
  private imageMaintained = false;
  /** When the cached image promise resolved, and its tag. */
  private imageReadyAt: number | undefined;
  private imageTag: string | undefined;
  /** Last time this instance recorded a use of the tag in the state file. */
  private imageUsedAt: number | undefined;
  private readonly clock: Clock;
  private readonly socketPath: string;

  constructor(private readonly deps: HelperDeps) {
    this.clock = deps.clock ?? systemClock;
    this.socketPath = helperDockerSocket(deps.env, deps.platform ?? process.platform);
  }

  /**
   * ensureHelperImage, shared by concurrent callers (cached promise; retried after a failure). With `statePath`, it also
   * does the maintenance that is due (implementation notes 7): a rebuild that a check asked for, the check of the base
   * image (in the background), the cleanup of old helper images. The open pipeline calls it before the helper runs; a
   * result older than HELPER_IMAGE_RECHECK_MS, or one of a helper run (without the maintenance), is not reused. A failed
   * build throws UserFacingError('helperFailed', Messages.helperFailed, detail); AbortError and other UserFacingErrors
   * pass through.
   */
  async ensureImage(options: EnsureImageOptions = {}): Promise<string> {
    return this.image(options, true);
  }

  /**
   * docker run --rm -i --label devenv.helper-run=true, the volume at /workspaces, [the Docker socket and the cache
   * volume devenv-helper-cache, unless `docker: false`], [--network none for `network: false`], [a tmpfs for the token],
   * [-e NAME=value…], then the command. Resolves also for a non-zero exit code. On an abort, the helper container is
   * removed.
   */
  run(
    volumeName: string,
    command: readonly string[],
    options: {
      env?: Record<string, string>;
      input?: string;
      secrets?: boolean;
      docker?: boolean;
      network?: boolean;
      onOutput?: (text: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<RunResult> {
    return this.runStreams(volumeName, command, {
      env: options.env,
      input: options.input,
      secrets: options.secrets,
      docker: options.docker,
      network: options.network,
      signal: options.signal,
      onStdout: options.onOutput,
      onStderr: options.onOutput,
    });
  }

  /**
   * Clones the repository into the volume (idempotent), without the Docker socket and the cache volume. The token goes to
   * the helper on stdin only. Throws CommandError.
   */
  async clone(p: {
    volumeName: string;
    repository: string;
    branch?: string;
    token: string;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    checkToken(p.token);
    const { name } = checkRepository(p.repository);
    const output = this.redactingOutput(p.onOutput ?? this.logOutput, p.token);
    this.deps.logger.info(`Cloning ${p.repository}${p.branch ? ` (branch ${p.branch})` : ''} into the volume ${p.volumeName}.`);
    const result = await this.runStreams(p.volumeName, cloneCommand(p.repository, name, p.branch || undefined), {
      input: p.token,
      secrets: true,
      docker: false,
      signal: p.signal,
      onStdout: output,
      onStderr: output,
    });
    if (result.exitCode !== 0) {
      throw new CommandError('git clone', result.exitCode, redact(result.stdout, p.token), redact(result.stderr, p.token));
    }
  }

  /** devcontainer.json and its Dockerfile (if any) from the volume. `undefined` if the configuration file does not exist. */
  async readConfigFiles(p: {
    volumeName: string;
    repository: string;
    configPath: string;
    signal?: AbortSignal;
  }): Promise<{ configText: string; dockerfilePath?: string; dockerfileText?: string } | undefined> {
    const folder = this.repositoryFolder(p.repository);
    const result = await this.runStreams(p.volumeName, readFilesCommand(folder, checkConfigPath(p.configPath)), {
      docker: false,
      network: false,
      signal: p.signal,
      onStderr: this.logOutput,
    });
    if (result.exitCode !== 0) throw new CommandError('read configuration files', result.exitCode, result.stdout, result.stderr);
    const value = lastJsonLine(result.stdout);
    if (value === null) return undefined;
    if (!isRecord(value) || typeof value.configText !== 'string') {
      throw new Error('The workspace helper returned invalid configuration files.');
    }
    const files: { configText: string; dockerfilePath?: string; dockerfileText?: string } = { configText: value.configText };
    if (typeof value.dockerfilePath === 'string') files.dockerfilePath = value.dockerfilePath;
    if (typeof value.dockerfileText === 'string') files.dockerfileText = value.dockerfileText;
    return files;
  }

  /** Configuration paths in the volume, in the order of precedence (concept 7.4). */
  async listConfigurations(p: { volumeName: string; repository: string; signal?: AbortSignal }): Promise<string[]> {
    const folder = this.repositoryFolder(p.repository);
    const result = await this.runStreams(p.volumeName, listConfigsCommand(folder), {
      docker: false,
      network: false,
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
    p: { volumeName: string; repository: string; configPath: string; environmentId: string; onOutput?: (text: string) => void; signal?: AbortSignal },
    merged: boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown> & { configuration: Record<string, unknown> }> {
    const folder = this.repositoryFolder(p.repository);
    const args = readConfigurationArgs({
      workspaceFolder: folder,
      configPath: `${folder}/${checkConfigPath(p.configPath)}`,
      idLabel: `${LABEL_ENVIRONMENT_ID}=${p.environmentId}`,
      merged,
    });
    const result = await this.runStreams(p.volumeName, ['devcontainer', ...args], {
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
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<DevcontainerResult> {
    const folder = this.repositoryFolder(p.repository);
    const configFile = `${folder}/${checkConfigPath(p.configPath)}`;
    const args = buildArgs({ workspaceFolder: folder, configPath: configFile, imageName: p.imageName });
    this.deps.logger.info(`Building the environment image ${p.imageName} from ${p.configPath}.`);
    return this.runDevcontainer('devcontainer build', p.volumeName, buildCommand(configFile, args), {
      onOutput: p.onOutput,
      signal: p.signal,
    });
  }

  /**
   * devcontainer up with the override configuration. The override configuration is passed on stdin and written to a
   * temporary file inside the helper. SKIP_POST_ATTACH_ARG (V-1). Throws DevcontainerCommandError.
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
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<UpResult> {
    const folder = this.repositoryFolder(p.repository);
    const args = upArgs({
      workspaceFolder: folder,
      overrideConfigPath: OVERRIDE_CONFIG_PATH,
      idLabel: `${LABEL_ENVIRONMENT_ID}=${p.environmentId}`,
      removeExistingContainer: p.removeExistingContainer,
    });
    this.deps.logger.info(
      `Starting the container of ${p.repository}${p.removeExistingContainer ? ' (replacing the existing container)' : ''}.`,
    );
    try {
      return await this.runDevcontainer('devcontainer up', p.volumeName, upCommand(OVERRIDE_CONFIG_PATH, args), {
        input: JSON.stringify(p.override, null, 2),
        onOutput: p.onOutput,
        signal: p.signal,
      });
    } catch (error) {
      if (!(error instanceof DevcontainerCommandError) || !isLifecycleCommandFailure(error.result)) throw error;
      const { containerId, description } = error.result;
      if (!(await this.containerRuns(containerId, p.signal))) throw error;
      this.deps.logger.warn(`${description} The container ${containerId.slice(0, 12)} of ${p.repository} runs and is kept.`);
      return { outcome: 'success', containerId, lifecycleCommandFailure: description };
    }
  }

  /**
   * Writes the token of the owner account, the sign-in of the GitHub CLI as that account (`login`), and the Git and
   * Docker configuration of the dev container into the volume (GIT_FILES_SCRIPT, concept section 9 "Git inside the
   * container"), without the Docker socket, the cache volume, and network. The token goes to the helper on stdin only; it
   * is never on a command line, in a variable, or in the output. Throws CommandError (with the token removed from the
   * output), and Error for a `login` that is no GitHub login.
   */
  async prepareGit(p: {
    volumeName: string;
    repository: string;
    token: string;
    identity: GitIdentity;
    /** The GitHub login of the account that owns the environment (the account of the session). */
    login: string;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    checkToken(p.token);
    const { name } = checkRepository(p.repository);
    if (!isGitHubLogin(p.login)) throw new Error(`Invalid GitHub login: ${p.login}`);
    const output = this.redactingOutput(p.onOutput ?? this.logOutput, p.token);
    this.deps.logger.info(`Writing the Git configuration and the GitHub token of ${p.repository} into the volume ${p.volumeName}.`);
    const result = await this.runStreams(p.volumeName, gitFilesCommand(name, p.identity, CONTAINER_CREDENTIAL_HELPER, p.login), {
      input: p.token,
      secrets: true,
      docker: false,
      network: false,
      signal: p.signal,
      onStdout: output,
      onStderr: output,
    });
    if (result.exitCode !== 0) {
      throw new CommandError('prepare Git', result.exitCode, redact(result.stdout, p.token), redact(result.stderr, p.token));
    }
  }

  /**
   * Removes the token of the owner account from the volume (REMOVE_GIT_TOKEN_SCRIPT: the token file and the sign-in of
   * the GitHub CLI), concept 7.5, without the Docker socket, the cache volume, and network. Works whether the dev
   * container runs or not; it needs no tool of its image. `timeoutMs` limits the helper container (not a build of the
   * helper image before it). Throws CommandError when a file is still there.
   */
  async removeGitToken(p: { volumeName: string; timeoutMs?: number; signal?: AbortSignal }): Promise<void> {
    const result = await this.runStreams(p.volumeName, removeGitTokenCommand(), {
      docker: false,
      network: false,
      timeoutMs: p.timeoutMs,
      signal: p.signal,
      onStderr: this.logOutput,
    });
    if (result.exitCode !== 0) throw new CommandError('remove the GitHub token', result.exitCode, result.stdout, result.stderr);
  }

  /**
   * Git state of the repository in the volume (for a container that does not run). Without the Docker socket, the cache
   * volume, and network: Git runs programs that the repository configuration names. Throws CommandError.
   */
  async gitSummary(p: { volumeName: string; repository: string; signal?: AbortSignal }): Promise<GitSummary> {
    const folder = this.repositoryFolder(p.repository);
    const result = await this.runStreams(p.volumeName, gitSummaryCommand(folder), {
      docker: false,
      network: false,
      signal: p.signal,
      onStderr: this.logOutput,
    });
    if (result.exitCode !== 0) throw new CommandError('git summary', result.exitCode, result.stdout, result.stderr);
    return parseGitSummaryOutput(result.stdout, isoTime(this.clock));
  }

  /**
   * git fetch + git switch in the volume (concept 7.5), without the Docker socket and the cache volume. Throws
   * UserFacingError('gitSwitchFailed', Messages.gitSwitchFailed(branch, gitMessage)) when Git refuses; CommandError when
   * the helper itself fails.
   */
  async switchBranch(p: {
    volumeName: string;
    repository: string;
    branch: string;
    token: string;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    checkToken(p.token);
    const folder = this.repositoryFolder(p.repository);
    const output = this.redactingOutput(p.onOutput ?? this.logOutput, p.token);
    this.deps.logger.info(`Switching ${p.repository} to the branch ${p.branch}.`);
    const result = await this.runStreams(p.volumeName, switchBranchCommand(folder, p.branch, p.repository), {
      input: p.token,
      secrets: true,
      docker: false,
      signal: p.signal,
      onStdout: output,
      onStderr: output,
    });
    if (result.exitCode === 0) return;
    const stdout = redact(result.stdout, p.token);
    const stderr = redact(result.stderr, p.token);
    // 1: Git refused (its message is on stderr), 2: invalid argument or missing folder. Other codes: the helper failed.
    if (result.exitCode === 1 || result.exitCode === 2) {
      const gitMessage = gitMessageFromOutput(stderr || stdout);
      throw new UserFacingError('gitSwitchFailed', Messages.gitSwitchFailed(p.branch, gitMessage), `${stderr}\n${stdout}`.trim());
    }
    throw new CommandError('git switch', result.exitCode, stdout, stderr);
  }

  private readonly logOutput = (text: string): void => this.deps.logger.output(text);

  /**
   * The helper tag. `recheck` (ensureImage): ensureHelperImage with the maintenance; a result older than
   * HELPER_IMAGE_RECHECK_MS, or one of a helper run, is not reused. The helper runs (`recheck` false) reuse any result
   * and only record the use (at most once per hour); without a result (a new window), they run ensureHelperImage without
   * the maintenance, which only builds a missing tag. So no check of the base image, no rebuild, and no cleanup delays
   * a stop, a delete, or a branch switch.
   */
  private async image(options: EnsureImageOptions, recheck: boolean): Promise<string> {
    if (recheck && this.imagePromise && !this.imageMaintained) {
      // The result of a helper run: wait until it is ready (a missing tag is built only once), then maintain.
      const pending = this.imagePromise;
      if (this.imageReadyAt === undefined) await pending.catch(() => undefined);
      if (this.imagePromise === pending) this.resetImage();
    }
    if (this.imagePromise && this.imageReadyAt !== undefined) {
      const now = this.clock.now();
      if (recheck && Math.abs(now - this.imageReadyAt) >= HELPER_IMAGE_RECHECK_MS) this.resetImage();
      else await this.recordUse(now);
    }
    if (!this.imagePromise) {
      const promise: Promise<string> = ensureHelperImage(this.deps.docker, this.deps.dockerfilePath, {
        onOutput: options.onOutput ?? this.logOutput,
        signal: options.signal,
        statePath: this.deps.statePath,
        baseDigest: this.deps.baseDigest,
        maintain: recheck,
        checkBaseImage: options.checkBaseImage,
        onBuild: options.onBuild,
        onBaseImageCheck: this.deps.onBaseImageCheck,
        clock: this.clock,
        logger: this.deps.logger,
      }).then(
        (tag) => {
          if (this.imagePromise === promise) {
            this.imageReadyAt = this.clock.now();
            this.imageUsedAt = this.imageReadyAt;
            this.imageTag = tag;
          }
          return tag;
        },
        (error: unknown) => {
          if (this.imagePromise === promise) this.imagePromise = undefined;
          if (isAbortError(error) || isUserFacingError(error)) throw error;
          this.deps.logger.error('The workspace helper image could not be built.', error);
          throw new UserFacingError('helperFailed', Messages.helperFailed, errorMessage(error));
        },
      );
      this.imagePromise = promise;
      this.imageMaintained = recheck;
    }
    try {
      return await this.imagePromise;
    } catch (error) {
      // Another caller cancelled the shared build: build again for this caller.
      if (isAbortError(error) && !options.signal?.aborted) return this.image(options, recheck);
      throw error;
    }
  }

  private resetImage(): void {
    this.imagePromise = undefined;
    this.imageMaintained = false;
    this.imageReadyAt = undefined;
  }

  /** `lastUsedAt` of the tag in the state file, at most once per hour per instance. Never throws. */
  private async recordUse(now: number): Promise<void> {
    const statePath = this.deps.statePath;
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
    options: { input?: string; onOutput?: (text: string) => void; signal?: AbortSignal },
  ): Promise<DevcontainerResult> {
    const output = options.onOutput ?? this.logOutput;
    const stdoutFilter = new ResultLineFilter(output);
    let result: RunResult;
    try {
      result = await this.runStreams(volumeName, helperCommand, {
        input: options.input,
        signal: options.signal,
        onStdout: (text) => stdoutFilter.write(text),
        onStderr: output,
      });
    } finally {
      stdoutFilter.flush();
    }
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
    const env = this.helperEnv(options.env ?? {}, options.secrets === true);
    let tag = await this.image({ onOutput: options.onStderr, signal: options.signal }, false);
    let result = await this.runContainer(tag, volumeName, command, env, options);
    if (result.exitCode === 125 && /no such image/i.test(result.stderr)) {
      // The image was removed after this instance checked it (for example by `docker image prune -a`).
      this.deps.logger.warn(`The workspace helper image ${tag} is missing. It is built again.`);
      this.resetImage();
      tag = await this.image({ onOutput: options.onStderr, signal: options.signal }, false);
      result = await this.runContainer(tag, volumeName, command, env, options);
    }
    return result;
  }

  private helperEnv(env: Record<string, string>, secrets: boolean): Record<string, string> {
    const names = Object.keys(env);
    if (secrets && names.length > 0) {
      // Runs with the token get no variables of the computer, so nothing can change how Git handles the token.
      this.deps.logger.warn('Variables are not passed to a workspace helper run with credentials.');
      return {};
    }
    const result: Record<string, string> = {};
    for (const name of names) {
      if (isPassableEnvName(name)) result[name] = env[name];
      else this.deps.logger.warn(`The variable ${name} is not passed to the workspace helper.`);
    }
    return result;
  }

  private async runContainer(
    tag: string,
    volumeName: string,
    command: readonly string[],
    env: Record<string, string>,
    options: StreamOptions,
  ): Promise<RunResult> {
    const containerName = `devenv-helper-${crypto.randomBytes(6).toString('hex')}`;
    const args = helperRunArgs({
      tag,
      volumeName,
      socketPath: this.socketPath,
      containerName,
      env,
      secrets: options.secrets === true,
      docker: options.docker !== false,
      network: options.network !== false,
      command,
    });
    const envNames = Object.keys(env);
    this.deps.logger.info(
      `Workspace helper ${containerName}: ${describeCommand(command)}` +
        (envNames.length > 0 ? ` (variables: ${envNames.join(', ')})` : ''),
    );
    // The time limit ends the run like a cancel, but only of this container.
    const limit = options.timeoutMs !== undefined ? new AbortController() : undefined;
    const timer = limit ? setTimeout(() => limit.abort(), options.timeoutMs) : undefined;
    const signal = limit ? (options.signal ? AbortSignal.any([options.signal, limit.signal]) : limit.signal) : options.signal;
    // Killing the Docker CLI does not stop the container on every platform: remove it.
    const onAbort = (): void => {
      this.deps.docker.run(['rm', '-f', containerName], { timeoutMs: 30_000 }).catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.deps.docker.run(args, {
        input: options.input,
        signal,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
      });
    } catch (error) {
      if (limit?.signal.aborted && !options.signal?.aborted && isAbortError(error)) {
        const seconds = Math.round((options.timeoutMs ?? 0) / 1000);
        throw new Error(`The workspace helper ${containerName} did not end within ${seconds} seconds.`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
