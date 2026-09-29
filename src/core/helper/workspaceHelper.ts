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
import { configOwnershipFixCommand, gitSummaryCommand, parseGitSummaryOutput, type ServiceFolders } from '../git/gitSummary';
import { Messages } from '../messages';
import {
  CONFIG_FOLDER,
  HELPER_CACHE_VOLUME,
  HELPER_DOCKER_SOCKET,
  LABEL_HELPER_RUN,
  WORKSPACES_ROOT,
  environmentIdLabel,
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
  runUserCommandsArgs,
  tryParseDevcontainerResult,
  upArgs,
} from './devcontainerCli';
import {
  HELPER_LAST_USED_INTERVAL_MS,
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
  OVERRIDE_FOLDER,
  SECRETS_FOLDER,
  buildCommand,
  cloneCommand,
  composeHashCommand,
  composeModelCommand,
  createFoldersCommand,
  gitFilesCommand,
  listConfigsCommand,
  parseComposeHashes,
  readFilesCommand,
  switchBranchCommand,
  upCommand,
  writeAndRunCommand,
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
  /**
   * Unit 7: the Docker engine that the operation uses (the current Docker context). `key` names it ('' for the local
   * Docker, else the remote host): the image found or built for one engine is not reused for another, and a remote
   * engine has its own state file. `socket`: the source of the socket mount on the machine of that engine (for a remote
   * host `/var/run/docker.sock`, or the recorded socket of a rootless engine); `endpoint`: the local endpoint of the
   * context, for helperDockerSocket. Without it, the local Docker of DOCKER_HOST.
   */
  engine?: () => Promise<HelperEngine>;
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
  /**
   * Previous helper (user decision 2026-09-29): called when the resolved tag is a previous helper tag, because the
   * current tag could not be built (ensureHelperImage), with the ID of its image that was checked against helper.json.
   * The next ensureImage tries to build the current tag again. Review round 3 of PR #64 (P1): only for log lines and
   * notices; the helper image of an open is the HelperImageUse that ensureImageUse returns.
   */
  onPreviousHelper?: (tag: string, imageId: string) => void;
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
  /**
   * The image reference: the image ID of the helper image of an open (review round 3 of PR #64, P2), the checked image
   * ID of a previous helper (review round 1 of PR #64, S1), or the current helper tag for a run outside an open.
   */
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
  /**
   * An empty tmpfs over the configuration folder of the volume (CONFIG_FOLDER, with the GitHub token), for runs that
   * read files of the repository with a tool that follows its references (the model run of Docker Compose).
   */
  hideConfigFolder?: boolean;
  command: readonly string[];
}

/**
 * `docker run` arguments of one helper run: `--rm -i`, never a pull (the image exists only locally), the label
 * nimblescape.devenv.helper-run=true, the workspace volume at /workspaces, [the Docker socket and the cache volume],
 * [`--network none`], and for runs with the token a tmpfs mount (in memory, mode 0700).
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
  if (spec.hideConfigFolder === true) args.push('--mount', mountOption({ type: 'tmpfs', destination: CONFIG_FOLDER }));
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

/**
 * A configuration path relative to the repository folder, without `..`. Review round 6 (note of S): a backslash is allowed, as the
 * discovery and isConfigPathLabelValue allow it; in the workspace helper (Linux) it is a character of a name, no
 * separator, and the path goes to the scripts as an argument, never through a shell.
 */
function checkConfigPath(configPath: string): string {
  const segments = configPath.split('/');
  if (
    configPath === '' ||
    configPath.startsWith('/') ||
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

/**
 * The image reference of a helper run outside an open: the current tag by its tag (such a run takes the image that the
 * tag has), a previous helper by the ID of its image that was checked (review round 1 of PR #64, S1).
 */
function runReference(use: HelperImageUse): string {
  return use.previous === true && use.id !== undefined ? use.id : use.tag;
}

/** `sha256:` and the first 12 hex characters of an image ID, for log lines. */
function shortImageId(id: string): string {
  return id.slice(0, 'sha256:'.length + 12);
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
  /** See HelperRunSpec.hideConfigFolder. */
  hideConfigFolder?: boolean;
  /** The helper image of the open (see HelperImageUse); without it, the image of this instance (WorkspaceHelper.image). */
  image?: HelperImageUse;
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

/** Files of the extension for a run of the Dev Container CLI (WRITE_AND_RUN_SCRIPT): absolute path below OVERRIDE_FOLDER → text. */
export type HelperFiles = Readonly<Record<string, string>>;

/** Time limit of the model run of a Docker Compose configuration (composeModel). */
export const COMPOSE_MODEL_TIMEOUT_MS = 60_000;

/** Paths of `files` below OVERRIDE_FOLDER, absolute and without `.`/`..` (WRITE_AND_RUN_SCRIPT checks them again). */
function checkHelperFiles(files: HelperFiles): void {
  for (const file of Object.keys(files)) {
    const segments = file.split('/').slice(1);
    if (!file.startsWith(`${OVERRIDE_FOLDER}/`) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`Invalid helper file: ${file}`);
    }
  }
}

/** Standard input of WRITE_AND_RUN_SCRIPT: the files, and the override configuration at OVERRIDE_CONFIG_PATH. */
function writeAndRunInput(files: HelperFiles | undefined, override: Record<string, unknown> | undefined): string {
  const all: Record<string, string> = { ...(files ?? {}) };
  if (override !== undefined) all[OVERRIDE_CONFIG_PATH] = JSON.stringify(override, null, 2);
  checkHelperFiles(all);
  return JSON.stringify({ files: all });
}

/**
 * The helper command of `up` and `run-user-commands`: UP_SCRIPT with the override configuration on stdin, or, with
 * `files` (Docker Compose: our model), WRITE_AND_RUN_SCRIPT.
 */
function overrideCommand(args: readonly string[], files: HelperFiles | undefined): string[] {
  return files !== undefined ? writeAndRunCommand({}, args) : upCommand(OVERRIDE_CONFIG_PATH, args);
}

/** The standard input of overrideCommand. */
function overrideInput(files: HelperFiles | undefined, override: Record<string, unknown>): string {
  return files !== undefined ? writeAndRunInput(files, override) : JSON.stringify(override, null, 2);
}

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
  /** The cached tag is a previous helper tag (user decision 2026-09-29): ensureImage never reuses it. */
  private imagePrevious = false;
  /** Last time this instance recorded a use of the tag in the state file. */
  private imageUsedAt: number | undefined;
  private readonly clock: Clock;
  /** The engine of the cached image (HelperDeps.engine). */
  private imageEngine = '';

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
   * ensureImage, with the helper image that this call awaited (HelperImageUse: the tag, the ID of its image, and whether
   * it is a previous helper). Review round 3 of PR #64 (P1): the open pipeline pins this return value as the helper image
   * of the open and passes it as `image` to every helper run of the open, because the cache of this instance is shared by
   * all opens of the window and may be replaced meanwhile (another engine, a missing image at another run).
   */
  async ensureImageUse(options: EnsureImageOptions = {}): Promise<HelperImageUse> {
    return this.image(options, true);
  }

  /**
   * docker run --rm -i --label nimblescape.devenv.helper-run=true, the volume at /workspaces, [the Docker socket and
   * the cache volume devenv-helper-cache, unless `docker: false`], [--network none for `network: false`], [a tmpfs for
   * the token], [-e NAME=value…], then the command. Resolves also for a non-zero exit code. On an abort, the helper
   * container is removed.
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
      /** The helper image of the open (HelperImageUse). */
      image?: HelperImageUse;
      onOutput?: (text: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<RunResult> {
    return this.runStreams(volumeName, command, {
      image: options.image,
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
      image: p.image,
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
      image: p.image,
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
      image: p.image,
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
      input: writeAndRunInput(p.files, p.override),
      env: p.env,
      image: p.image,
      onOutput: p.onOutput,
      signal: p.signal,
    });
  }

  /**
   * The merged model of a Docker Compose configuration (COMPOSE_MODEL_SCRIPT: `docker compose config --format json` of
   * `files`, all profiles, with COMPOSE_PROJECT_NAME=`project`), without the Docker socket, the cache volume, and
   * network, and with the configuration folder of the volume hidden (the GitHub token): the files of the repository can
   * reach only files of the helper image and of the repository. `files` are absolute paths in the repository folder
   * (resolveComposeFiles). `{ error }` carries the message of Docker Compose. Throws CommandError when the helper fails.
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
      image: p.image,
      env: { COMPOSE_PROJECT_NAME: p.project },
      docker: false,
      network: false,
      hideConfigFolder: true,
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
   * one that runs `up` (COMPOSE_HASH_SCRIPT). Without the Docker socket, the cache volume, and network, and with the
   * configuration folder of the volume hidden. Throws CommandError when Compose fails.
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
      image: p.image,
      input: p.model,
      env: { COMPOSE_PROJECT_NAME: p.project },
      docker: false,
      network: false,
      hideConfigFolder: true,
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
   * Without the Docker socket, the cache volume, and network, and with the configuration folder of the volume hidden.
   * Throws CommandError when a folder cannot be created.
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
      image: p.image,
      docker: false,
      network: false,
      hideConfigFolder: true,
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
   * "Git inside the container"), without the Docker socket, the cache volume, and network. Unit 15: no token; the token
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
      image: p.image,
      docker: false,
      network: false,
      signal: p.signal,
      onStdout: output,
      onStderr: output,
    });
    if (result.exitCode !== 0) throw new CommandError('prepare Git', result.exitCode, result.stdout, result.stderr);
  }

  /**
   * Review round 15 (K3 = P15-1, D15-1, S15-3): gives the files in `folder` of the volume (the extension's internal folder,
   * CONFIG_FOLDER) the owner `uid`:`gid` (numbers, as `id -u` and `id -g` print them in the dev container), in a helper
   * container that mounts only the workspace volume (without the Docker socket, the cache volume, and network), with
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
      image: p.image,
      docker: false,
      network: false,
      timeoutMs: p.timeoutMs,
      signal: p.signal,
    });
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
    /**
     * Review round 9 (D9-1): the paths of the repository that the other services of Docker Compose mount
     * (Environment.serviceFolders); the restore of the owner leaves them out. Review round 11 (G5):
     * `'repository'` over MAX_SERVICE_FOLDERS (only the files of root get their owner).
     */
    serviceFolders?: ServiceFolders;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    checkToken(p.token);
    const folder = this.repositoryFolder(p.repository);
    const output = this.redactingOutput(p.onOutput ?? this.logOutput, p.token);
    this.deps.logger.info(`Switching ${p.repository} to the branch ${p.branch}.`);
    const result = await this.runStreams(p.volumeName, switchBranchCommand(folder, p.branch, p.repository, p.serviceFolders), {
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
   * The helper image (HelperImageUse). `recheck` (ensureImage): ensureHelperImage with the maintenance; a result older
   * than HELPER_IMAGE_RECHECK_MS, or one of a helper run, is not reused. The helper runs (`recheck` false) reuse any result
   * and only record the use (at most once per hour); without a result (a new window), they run ensureHelperImage without
   * the maintenance, which only builds a missing tag. So no check of the base image, no rebuild, and no cleanup delays
   * a stop, a delete, or a branch switch. Review round 2 of PR #64 (A-N1): a run with the helper image of an open
   * (`image`) does not use this cache; the open recorded the use when it resolved the image (ensureImage).
   */
  private async image(options: EnsureImageOptions, recheck: boolean): Promise<HelperImageUse> {
    const engine = await this.currentEngine();
    // Unit 7: an image of another engine (the Docker context changed) is not reused.
    if (this.imagePromise && engine.key !== this.imageEngine) this.resetImage();
    this.imageEngine = engine.key;
    const statePath = this.statePathFor(engine);
    if (recheck && this.imagePromise && !this.imageMaintained) {
      // The result of a helper run: wait until it is ready (a missing tag is built only once), then maintain.
      const pending = this.imagePromise;
      if (this.imageReadyAt === undefined) await pending.catch(() => undefined);
      if (this.imagePromise === pending) this.resetImage();
    }
    if (this.imagePromise && this.imageReadyAt !== undefined) {
      const now = this.clock.now();
      // Previous helper (user decision 2026-09-29): each open tries to build the current tag again.
      if (recheck && (this.imagePrevious || Math.abs(now - this.imageReadyAt) >= HELPER_IMAGE_RECHECK_MS)) this.resetImage();
      else if (recheck && !(await this.cachedImageCurrent())) this.resetImage();
      else await this.recordUse(now, statePath);
    }
    if (!this.imagePromise) {
      const promise: Promise<HelperImageUse> = ensureHelperImageUse(this.deps.docker, this.deps.dockerfilePath, {
        onOutput: options.onOutput ?? this.logOutput,
        signal: options.signal,
        statePath,
        baseDigest: this.deps.baseDigest,
        maintain: recheck,
        checkBaseImage: options.checkBaseImage,
        onBuild: options.onBuild,
        onBaseImageCheck: this.deps.onBaseImageCheck,
        clock: this.clock,
        logger: this.deps.logger,
      }).then(
        (use) => {
          if (this.imagePromise === promise) {
            this.imageReadyAt = this.clock.now();
            this.imageUsedAt = this.imageReadyAt;
            this.imageTag = use.tag;
            this.imageCachedId = use.id;
            this.imagePrevious = use.previous === true;
          }
          return use;
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
      // Review round 3 of PR #64 (P1): the caller gets the image that it awaited, also when the cache was replaced
      // meanwhile (resetImage), and every caller of a previous helper learns it.
      const use = await this.imagePromise;
      if (use.previous === true && use.id !== undefined) options.onPreviousHelper?.(use.tag, use.id);
      return use;
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
    this.imageCachedId = undefined;
    this.imagePrevious = false;
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
    const env = this.helperEnv(options.env ?? {}, options.secrets === true);
    // Review round 2 of PR #64 (A-N1): a run of an open uses the helper image of that open, never the image that this
    // instance resolved for another open meanwhile.
    const pinned = options.image;
    if (pinned !== undefined) {
      // Review round 3 of PR #64 (P2): by the ID of its image, for the current tag too, so a rebuild of the tag by another
      // window (`--pull --no-cache`, other packages) never changes the helper image in the middle of an open.
      const reference = pinned.id ?? pinned.tag;
      const result = await this.runContainer(reference, volumeName, command, env, options);
      if (result.exitCode === 125 && /no such image/i.test(result.stderr)) {
        // Review round 2 of PR #64 (A-N1, B3), review round 3 of PR #64 (P2, P8): the image of the open was removed (for
        // example by `docker image prune -a`, by another window that rebuilt the tag and removed the image that the tag
        // had before, or by the cleanup of another installation). The open ends: nothing is built and no other image is
        // used, because another helper image has another Dev Container CLI than the one that read and checked the
        // configuration of this open. Review round 4 of PR #64 (R4-1): the cache of the window is reset when it still
        // holds this image, so the next open resolves the helper image again instead of pinning the removed ID.
        if (this.imageReadyAt !== undefined && this.imageTag === pinned.tag && this.imageCachedId === pinned.id) this.resetImage();
        this.deps.logger.warn(
          `The ${pinned.previous === true ? 'previous helper image' : 'workspace helper image'} ${pinned.tag}${pinned.id !== undefined ? ` (${shortImageId(pinned.id)})` : ''} that this open uses was removed. The open cannot go on with another helper image.`,
        );
        throw new UserFacingError('helperFailed', Messages.helperFailed, `No such image: ${reference}`);
      }
      return result;
    }
    let use = await this.image({ onOutput: options.onStderr, signal: options.signal }, false);
    // A run outside an open: the current tag runs by its tag; a previous helper runs by the ID of its image that was
    // checked, not by its tag (review round 1 of PR #64, S1).
    let result = await this.runContainer(runReference(use), volumeName, command, env, options);
    if (result.exitCode === 125 && /no such image/i.test(result.stderr)) {
      // The image was removed after it was checked (for example by `docker image prune -a`, or the cleanup of another
      // installation for a previous helper). The run takes what ensureHelperImage returns now: the current tag, built
      // again, or else a previous helper.
      this.deps.logger.warn(
        use.previous === true && use.id !== undefined
          ? `The previous helper image ${use.tag} (${shortImageId(use.id)}) is missing. The workspace helper image is prepared again.`
          : `The workspace helper image ${use.tag} is missing. It is built again.`,
      );
      this.resetImage();
      use = await this.image({ onOutput: options.onStderr, signal: options.signal }, false);
      result = await this.runContainer(runReference(use), volumeName, command, env, options);
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
    image: string,
    volumeName: string,
    command: readonly string[],
    env: Record<string, string>,
    options: StreamOptions,
  ): Promise<RunResult> {
    const containerName = `devenv-helper-${crypto.randomBytes(6).toString('hex')}`;
    const args = helperRunArgs({
      tag: image,
      volumeName,
      socketPath: this.socketPathFor(await this.currentEngine()),
      containerName,
      env,
      secrets: options.secrets === true,
      docker: options.docker !== false,
      network: options.network !== false,
      hideConfigFolder: options.hideConfigFolder === true,
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
