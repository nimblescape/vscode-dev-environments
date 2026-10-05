// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F2 (decision 1 of 2026-10-03: no bypass of the worker, by construction): the Docker CLI of the extension,
// only for the bootstrap: whether the CLI is installed and the engine answers (`docker info`), the helper image (its
// check, build and cleanup), the start of the worker (`docker run -i`), the Docker contexts, the test of a new remote
// host, and the attach diagnostics (what the Dev Containers extension sees through the local CLI). Every other Docker
// action runs in the worker. Each call runs directly; a call that does not only read is logged with its command
// (directCommandName), never its arguments. Output is read as JSON, never as a table. No `vscode`.
import * as crypto from 'crypto';
import { CommandError, errorMessage, UserFacingError } from '../errors';
import { Messages } from '../messages';
import { LABEL_BUILD_ID } from '../names';
import { isAbortError, sleep, systemClock, type Clock, type Logger, type ProcessRunner, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import type { ContainerState } from '../types';
import { dockerCommandWords, dockerProcessEnv, isReadOnlyDockerCall } from './dockerCli';
import { isSshClosedBeforeLogin } from './dockerHost';
import { mapContainerState, type ImageInfo } from './dockerObjects';
import { operationDockerTarget } from './dockerTargets';
import { runPreparingWorker } from './workerPreparation';

/** Result of `docker info`. */
export interface DaemonStatus {
  running: boolean;
  /** Server version when running; otherwise the error of `docker info`, for the log. */
  detail: string;
}

/** Time limit of `docker info` (the engine can take some seconds to leave the Resource Saver mode). */
export const DOCKER_INFO_TIMEOUT_MS = 20_000;
/** Time limit of short Docker calls (queries, stop, remove), so that a hanging engine does not block forever. */
export const DOCKER_QUERY_TIMEOUT_MS = 60_000;

/**
 * A missing Docker CLI is looked up again at most this often (with `findDocker`), so that Docker Desktop installed or
 * updated while VS Code runs is found without a reload.
 */
export const DOCKER_CLI_LOOKUP_RETRY_MS = 10_000;

/**
 * Unit 7: the wait before the one repetition of a Docker call that only reads, after the SSH server of a remote Docker
 * host closed the connection before the login (see sshDroppedReadCall).
 */
export const SSH_DROP_RETRY_DELAY_MS = 1_000;

/**
 * Unit 7: true when a Docker call that only reads failed because the SSH server of the remote Docker host closed the
 * connection before the login (the Docker CLI's `ssh … docker system dial-stdio` exited with 255, and ssh said nothing
 * else, see isSshClosedBeforeLogin). The command never reached the engine then. The Docker CLI opens a new SSH connection
 * for each call (up to five for one failing call), and sshd drops new connections at random while more than 10 are not
 * logged in yet (MaxStartups 10:30:100), so a call is repeated once, after SSH_DROP_RETRY_DELAY_MS. A refusal of
 * PerSourcePenalties lasts longer; the repetition fails too, and the error says why (DockerHostProblem closedBeforeLogin).
 */
export function sshDroppedReadCall(args: readonly string[], result: RunResult): boolean {
  if (result.exitCode === 0 || result.timedOut || !isReadOnlyDockerCall(args)) return false;
  return /\bdial-stdio\b[^\n]*exit status 255/.test(result.stderr) && isSshClosedBeforeLogin(result.stderr);
}


/** Docker objects whose command is the second word (`docker image rm`, `docker context create`). */
const DOCKER_OBJECTS = new Set(['container', 'image', 'volume', 'network', 'context', 'system', 'builder', 'buildx', 'compose', 'plugin', 'manifest']);

/**
 * Plan step 10A: the command of a direct call for its log line (`build`, `pull`, `image rm`), never an argument (an image
 * name, a path, or a value).
 */
export function directCommandName(args: readonly string[]): string {
  const [command, subcommand] = dockerCommandWords(args);
  if (command === undefined) return '';
  return DOCKER_OBJECTS.has(command) && subcommand !== undefined && !subcommand.startsWith('-') ? `${command} ${subcommand}` : command;
}


export type ObjectKind = 'container' | 'volume' | 'image' | 'network';

export const MISSING_PATTERNS: Record<ObjectKind, RegExp> = {
  container: /no such (container|object)/i,
  volume: /no such (volume|object)/i,
  image: /no such (image|object)/i,
  network: /no such (network|object)|network \S+ not found/i,
};


/** Docker refuses to remove an image that a container or another image uses. */
export const IMAGE_IN_USE_PATTERN = /conflict|in use|being used|is using|dependent child images/i;


/** Parses output with one JSON value per line (`--format '{{json …}}'`). Empty and invalid lines are skipped. */
export function parseJsonLines(stdout: string): unknown[] {
  const values: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      values.push(JSON.parse(text));
    } catch {
      // A warning or another line that is not JSON.
    }
  }
  return values;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


/** Parses the output of `--format '{{json .X}}'` for a single object. */
export function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}


/** Options of `docker run` / `docker exec` whose `NAME=value` can hold a secret (for example a `${localEnv:…}` token). */
const ENV_FLAGS = new Set(['-e', '--env']);

function redactEnv(assignment: string): string {
  const index = assignment.indexOf('=');
  return index < 0 ? assignment : `${assignment.slice(0, index)}=***`;
}

/** Command for error messages, which end up in the log: values of environment variables are hidden. */
export function commandText(args: readonly string[]): string {
  const shown = args.map((arg, index) => {
    if (index > 0 && ENV_FLAGS.has(args[index - 1])) return redactEnv(arg);
    if (arg.startsWith('--env=')) return `--env=${redactEnv(arg.slice('--env='.length))}`;
    return arg;
  });
  const text = `docker ${shown.join(' ')}`;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}


/** Removes a variable in every spelling of its name (names are case-insensitive on Windows). */
export function deleteEnv(env: NodeJS.ProcessEnv, name: string): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name) delete env[key];
  }
}

export function labelArgs(labels: Record<string, string> | undefined, flag: string): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(labels ?? {})) args.push(flag, `${key}=${value}`);
  return args;
}

/** Options of BootstrapDocker. */
export interface BootstrapDockerOptions {
  /**
   * Looks up the Docker CLI (for example `findDockerCli`). With it, the adapter looks again while the CLI is missing,
   * at most every DOCKER_CLI_LOOKUP_RETRY_MS, and after the CLI could not be started. Without it, the path stays fixed.
   */
  findDocker?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | undefined;
  /** Default: the system clock. */
  clock?: Clock;
  /**
   * Called with the result of each `docker info` (daemonStatus), for the context key of the Docker setup. Docker is not
   * asked for it: only the checks that run anyway are reported.
   */
  onDaemonStatus?: (running: boolean) => void;
  /**
   * With `findDocker`: called when a CLI that was found before cannot be started anymore (ENOENT, for example Docker was
   * uninstalled or moved while VS Code runs), after the adapter forgot its path. The Docker setup shows the setup in the
   * sidebar then. The callback should not look the CLI up itself: that would count as the next lookup, and a CLI back
   * seconds later (for example after Docker Desktop updated itself) would be found only 10 seconds later.
   */
  onCliLost?: () => void;
  /** Only for tests. Default: SSH_DROP_RETRY_DELAY_MS. */
  sshDropRetryDelayMs?: number;
}

/** Plan step 11F2: the Docker CLI of the bootstrap (see the module comment). */
export class BootstrapDocker {
  protected path: string | undefined;
  protected env: NodeJS.ProcessEnv;
  protected readonly rawEnv: NodeJS.ProcessEnv;
  protected readonly findDocker: BootstrapDockerOptions['findDocker'];
  protected readonly clock: Clock;
  protected readonly onDaemonStatus: BootstrapDockerOptions['onDaemonStatus'];
  protected readonly onCliLost: BootstrapDockerOptions['onCliLost'];
  protected readonly sshDropRetryDelayMs: number;
  protected lookedUpAt: number | undefined;

  /**
   * @param dockerPath Full path of the Docker CLI (see `findDockerCli`), or `undefined` if Docker is not installed.
   * @param env Process environment for Docker calls. The adapter applies `dockerProcessEnv` to it (idempotent), so that
   *   credential helpers and CLI plugins are found also with a short PATH.
   * @param platform Only for tests. Default: the platform of this process.
   * @param options `findDocker`: look the CLI up again while it is missing (see BootstrapDockerOptions).
   */
  constructor(
    protected readonly runner: ProcessRunner,
    dockerPath: string | undefined,
    env: NodeJS.ProcessEnv,
    protected readonly logger: Logger,
    protected readonly platform: NodeJS.Platform = process.platform,
    options: BootstrapDockerOptions = {},
  ) {
    this.path = dockerPath;
    this.rawEnv = env;
    this.env = dockerProcessEnv(env, platform, dockerPath);
    this.findDocker = options.findDocker;
    this.clock = options.clock ?? systemClock;
    this.onDaemonStatus = options.onDaemonStatus;
    this.onCliLost = options.onCliLost;
    this.sshDropRetryDelayMs = options.sshDropRetryDelayMs ?? SSH_DROP_RETRY_DELAY_MS;
    // The caller has just looked the CLI up.
    this.lookedUpAt = this.clock.now();
  }

  /** Full path of the Docker CLI, or `undefined` while it is not found. */
  get dockerPath(): string | undefined {
    return this.path;
  }

  /** True if the Docker CLI was found. With `findDocker`, a missing CLI is looked up again first. */
  isInstalled(): boolean {
    this.lookUpCliIfMissing();
    return this.path !== undefined;
  }

  /**
   * The call without the worker (the way of every call before plan step 5). A call that only reads is repeated once when
   * the SSH server of a remote Docker host closed the connection before the login (sshDroppedReadCall). Plan step 10A
   * (decision of 2026-10-03): a call that does not only read is logged with its command (directCommandName; never its
   * arguments or its input), its exit code, and its time, so the calls that still bypass the worker are visible.
   */
  async runDirect(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    if (isReadOnlyDockerCall(args)) return this.runDirectOnce(args, options);
    const startedAt = this.clock.now();
    const command = directCommandName(args);
    const seconds = (): string => (Math.max(0, this.clock.now() - startedAt) / 1000).toFixed(1);
    try {
      const result = await this.runDirectOnce(args, options);
      const end = result.timedOut ? 'timed out' : `exit code ${result.exitCode}`;
      this.logger.info(`docker ${command} (direct): ${end} after ${seconds()} s.`);
      return result;
    } catch (error) {
      this.logger.info(`docker ${command} (direct): ${isAbortError(error) ? 'cancelled' : 'failed'} after ${seconds()} s.`);
      throw error;
    }
  }

  protected async runDirectOnce(args: readonly string[], options: RunOptions): Promise<RunResult> {
    const result = await this.runOnce(args, options);
    if (!sshDroppedReadCall(args, result) || options.signal?.aborted) return result;
    const command = dockerCommandWords(args).join(' ');
    this.logger.warn(
      `docker ${command}: the SSH server of the Docker host closed the connection before the login. Trying once more in ${this.sshDropRetryDelayMs / 1000} s.`,
    );
    await sleep(this.sshDropRetryDelayMs, options.signal);
    return this.runOnce(args, options);
  }

  protected async runOnce(args: readonly string[], options: RunOptions): Promise<RunResult> {
    this.lookUpCliIfMissing();
    const dockerPath = this.path;
    if (dockerPath === undefined) throw new UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled);
    try {
      return await this.runner.run(dockerPath, args, { ...options, env: options.env ?? this.operationEnv() });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        if (this.findDocker && this.path === dockerPath) {
          // For example while Docker Desktop updates itself: the next call looks for the CLI again (unless `onCliLost`
          // looks it up first, see BootstrapDockerOptions).
          this.path = undefined;
          this.lookedUpAt = undefined;
          this.reportCliLost();
        }
        throw new UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled, `${dockerPath}: ${errorMessage(error)}`);
      }
      throw error;
    }
  }

  /**
   * The helper channel (user request 2026-09-28): starts `docker <args>` with standard input open, with the environment
   * of `run` (within an operation: its Docker context). Undefined without a Docker CLI or when the runner cannot start
   * such a program.
   */
  start(args: readonly string[]): StartedProcess | undefined {
    this.lookUpCliIfMissing();
    const dockerPath = this.path;
    if (dockerPath === undefined || this.runner.start === undefined) return undefined;
    return this.runner.start(dockerPath, args, { env: this.operationEnv() });
  }

  /**
   * The environment of a Docker call. Within an operation (unit 7, dockerTargets.ts) that read its Docker context, the
   * call gets DOCKER_CONTEXT with that context's name, so the whole operation stays on the Docker host it started with,
   * even when the user switches the context meanwhile. DOCKER_HOST is never set here; when it is set for VS Code, it
   * decides the endpoint and the operation has no context name.
   */
  protected operationEnv(): NodeJS.ProcessEnv {
    const context = operationDockerTarget()?.context;
    if (context === undefined) return this.env;
    const env: NodeJS.ProcessEnv = { ...this.env };
    deleteEnv(env, 'DOCKER_CONTEXT');
    env.DOCKER_CONTEXT = context;
    return env;
  }

  /** A copy of the environment of the Docker calls outside of an operation. */
  processEnv(): NodeJS.ProcessEnv {
    return { ...this.env };
  }

  /**
   * True if the Docker CLI was found. With `findDocker`, a missing CLI is looked up again now, without the waiting time
   * of `isInstalled` (after an installation was started, the CLI is looked up more often).
   */
  lookUpCliNow(): boolean {
    this.lookUpCliIfMissing(true);
    return this.path !== undefined;
  }

  protected reportCliLost(): void {
    try {
      this.onCliLost?.();
    } catch (error) {
      this.logger.warn(`The lost Docker CLI could not be reported: ${errorMessage(error)}`);
    }
  }

  /** With `findDocker`: looks for a missing CLI again, at most every DOCKER_CLI_LOOKUP_RETRY_MS unless `force` is set. */
  protected lookUpCliIfMissing(force = false): void {
    if (this.path !== undefined || !this.findDocker) return;
    const now = this.clock.now();
    if (!force && this.lookedUpAt !== undefined && Math.abs(now - this.lookedUpAt) < DOCKER_CLI_LOOKUP_RETRY_MS) return;
    this.lookedUpAt = now;
    let found: string | undefined;
    try {
      found = this.findDocker(this.rawEnv, this.platform);
    } catch (error) {
      this.logger.warn(`The Docker CLI could not be looked up: ${errorMessage(error)}`);
      return;
    }
    if (found === undefined) return;
    this.path = found;
    this.env = dockerProcessEnv(this.rawEnv, this.platform, found);
    this.logger.info(`Docker CLI: ${found}`);
  }

  /** Like run, but throws CommandError on a non-zero exit code (also after a timeout); returns stdout. */
  async runChecked(args: readonly string[], options?: RunOptions): Promise<string> {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) throw this.commandError(args, result);
    return result.stdout;
  }

  /**
   * `docker info`: whether the Docker engine answers. Never throws, except an AbortError when the signal aborts.
   * Without a CLI, the engine counts as not running.
   */
  async daemonStatus(signal?: AbortSignal, timeoutMs: number = DOCKER_INFO_TIMEOUT_MS): Promise<DaemonStatus> {
    const status = await this.queryDaemonStatus(signal, timeoutMs);
    try {
      this.onDaemonStatus?.(status.running);
    } catch (error) {
      this.logger.warn(`The Docker state could not be reported: ${errorMessage(error)}`);
    }
    return status;
  }

  protected async queryDaemonStatus(signal: AbortSignal | undefined, timeoutMs: number): Promise<DaemonStatus> {
    if (!this.isInstalled()) return { running: false, detail: 'The Docker CLI was not found.' };
    let result: RunResult;
    try {
      // Plan step 5, PR D (rule D1 of 2026-09-30): the check whether Docker runs comes before the worker (which needs it),
      // so "Docker is not running" stays its own answer: directly, unless the lock of an environment is held.
      result = await runPreparingWorker(() => this.run(['info', '--format', '{{json .ServerVersion}}'], { signal, timeoutMs }));
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { running: false, detail: errorMessage(error) };
    }
    if (result.timedOut) {
      return { running: false, detail: `docker info did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
    }
    if (result.exitCode !== 0) {
      return { running: false, detail: (result.stderr || result.stdout).trim() || `docker info failed with exit code ${result.exitCode}.` };
    }
    // Some versions print the client part and an empty server version when the engine cannot be reached.
    const version = parseJsonOutput(result.stdout);
    if (typeof version !== 'string' || !version) {
      return { running: false, detail: result.stderr.trim() || 'docker info returned no server version.' };
    }
    return { running: true, detail: `Docker engine ${version}` };
  }

  /** `docker info` exit code 0 (time limit 20 s). False without a CLI. Rejects only with an AbortError. */
  async isRunning(signal?: AbortSignal): Promise<boolean> {
    return (await this.daemonStatus(signal)).running;
  }

  /** 'missing' if not found; running|restarting|paused → 'running'; created|exited|dead|removing → 'stopped'. */
  async containerState(nameOrId: string): Promise<ContainerState> {
    const args = ['container', 'inspect', '--format', '{{json .State.Status}}', nameOrId];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      if (this.isMissing(result, 'container')) return 'missing';
      throw this.commandError(args, result);
    }
    const status = parseJsonOutput(result.stdout);
    if (typeof status !== 'string') throw this.commandError(args, result, 'Unexpected output of docker container inspect.');
    return mapContainerState(status);
  }

  /** True if the image exists locally. Throws CommandError for other errors (for example an invalid reference). */
  async imageExists(reference: string): Promise<boolean> {
    const args = ['image', 'inspect', '--format', '{{json .Id}}', reference];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode === 0) return true;
    if (this.isMissing(result, 'image')) return false;
    throw this.commandError(args, result);
  }

  /** ID of a local image (`sha256:…`), or `undefined` if it does not exist. Throws CommandError for other errors. */
  async imageId(reference: string): Promise<string | undefined> {
    const args = ['image', 'inspect', '--format', '{{json .Id}}', reference];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      if (this.isMissing(result, 'image')) return undefined;
      throw this.commandError(args, result);
    }
    const id = parseJsonOutput(result.stdout);
    if (typeof id !== 'string' || id === '') throw this.commandError(args, result, 'Unexpected output of docker image inspect.');
    return id;
  }

  /**
   * Local images with a label (`docker image ls --filter label=<label> --no-trunc`, then the same with `--filter
   * dangling=true`), for example `nimblescape.devenv.helper=true`. Dangling images are included, with no tags. One
   * entry per image ID, with all its tags. Throws CommandError.
   */
  async listImagesByLabel(label: string): Promise<ImageInfo[]> {
    const images = new Map<string, ImageInfo>();
    // The containerd image store lists dangling images only with `--filter dangling=true` (or `-a`). `-a` would also
    // list the intermediate images of the classic builder, which are not dangling.
    for (const filters of [[], ['--filter', 'dangling=true']]) {
      const args = ['image', 'ls', '--filter', `label=${label}`, ...filters, '--no-trunc', '--format', '{{json .}}'];
      const stdout = await this.runChecked(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
      for (const item of parseJsonLines(stdout)) {
        if (!isRecord(item) || typeof item.ID !== 'string' || item.ID === '') continue;
        let image = images.get(item.ID);
        if (!image) {
          image = { id: item.ID, tags: [], createdAt: typeof item.CreatedAt === 'string' ? item.CreatedAt : '' };
          images.set(item.ID, image);
        }
        // A dangling image is listed as `<none>:<none>`.
        const { Repository: repository, Tag: tag } = item;
        if (typeof repository !== 'string' || typeof tag !== 'string') continue;
        if (!repository || !tag || repository === '<none>' || tag === '<none>') continue;
        const reference = `${repository}:${tag}`;
        if (!image.tags.includes(reference)) image.tags.push(reference);
      }
    }
    return [...images.values()];
  }

  /** docker image rm without force. Returns false if the image is missing or in use (never throws for these). */
  async removeImage(reference: string): Promise<boolean> {
    const args = ['image', 'rm', reference];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode === 0) {
      this.logger.info(`Removed image ${reference}.`);
      return true;
    }
    if (this.isMissing(result, 'image')) return false;
    const message = `${result.stderr}\n${result.stdout}`;
    if (IMAGE_IN_USE_PATTERN.test(message)) {
      this.logger.info(`Image ${reference} is in use and was not removed: ${result.stderr.trim()}`);
      return false;
    }
    throw this.commandError(args, result);
  }

  /**
   * `docker build -t <tag> -f <dockerfile> [--pull] [--no-cache] [--label k=v]… --label nimblescape.devenv.build-id=<nonce>
   * [--build-arg k=v]… <context>`. `pull`: pull the base images even if they exist locally; `noCache`: build every step
   * again. Docker moves the tag only when the build succeeds. Throws CommandError when the build fails.
   *
   * Review round 4 of PR #64 (R4-2/R4-3): returns the ID of the image that this build made, found by its build label
   * (LABEL_BUILD_ID with a random nonce of this build, listImagesByLabel, which also lists a dangling image), not by the
   * tag, which another build may have moved meanwhile. No `--iidfile`: the Docker CLI fails after a successful build when
   * it cannot write the file (a Docker CLI outside the sandbox of VS Code), and with the containerd image store the file may
   * hold a digest that does not resolve. The lookup never decides whether the build succeeded: when it fails, or does not
   * find exactly one image, the result is `undefined` (with a warning).
   */
  async buildImage(options: {
    tag: string;
    dockerfile: string;
    context: string;
    labels?: Record<string, string>;
    buildArgs?: Record<string, string>;
    pull?: boolean;
    noCache?: boolean;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<string | undefined> {
    const flags = [...(options.pull ? ['--pull'] : []), ...(options.noCache ? ['--no-cache'] : [])];
    this.logger.info(`Building image ${options.tag}${flags.length > 0 ? ` (${flags.join(' ')})` : ''}.`);
    const onOutput = options.onOutput ?? ((text: string) => this.logger.output(text));
    const buildLabel = `${LABEL_BUILD_ID}=${crypto.randomBytes(16).toString('hex')}`;
    const args = [
      'build',
      '-t',
      options.tag,
      '-f',
      options.dockerfile,
      ...flags,
      ...labelArgs(options.labels, '--label'),
      '--label',
      buildLabel,
      ...labelArgs(options.buildArgs, '--build-arg'),
      options.context,
    ];
    await this.runChecked(args, { signal: options.signal, onStdout: onOutput, onStderr: onOutput });
    let images: ImageInfo[];
    try {
      images = await this.listImagesByLabel(buildLabel);
    } catch (error) {
      this.logger.warn(`The ID of the image ${options.tag} that was just built could not be read: ${errorMessage(error)}`);
      return undefined;
    }
    if (images.length !== 1) {
      this.logger.warn(`The image ${options.tag} that was just built was found ${images.length} times by its build label. Its ID is not used.`);
      return undefined;
    }
    return images[0].id;
  }

  /**
   * Review round 10 (P10-1): whether a failed command failed only for missing objects: every line of its (end of) stderr
   * says so. Unlike isMissing, one "No such …" among other errors is not enough.
   */
  protected onlyMissing(result: RunResult, kind: ObjectKind): boolean {
    if (result.timedOut || result.exitCode === 0) return false;
    const errors = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
    return errors.length > 0 && errors.every((line) => MISSING_PATTERNS[kind].test(line));
  }

  protected isMissing(result: RunResult, kind: ObjectKind): boolean {
    return !result.timedOut && result.exitCode !== 0 && MISSING_PATTERNS[kind].test(result.stderr);
  }

  protected commandError(args: readonly string[], result: RunResult, note?: string): CommandError {
    const notes = [result.timedOut ? 'The command did not end within the time limit.' : undefined, note].filter(Boolean);
    const stderr = notes.length > 0 ? `${result.stderr.trimEnd()}\n${notes.join('\n')}`.trim() : result.stderr;
    return new CommandError(commandText(args), result.exitCode, result.stdout, stderr);
  }

  /**
   * Raw call, directly with the Docker CLI of this computer (runDirect). Resolves also for a non-zero exit code. Throws
   * UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled) without a CLI, or when the CLI cannot be started
   * anymore (removed after it was found).
   */
  async run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return this.runDirect(args, options);
  }
}
