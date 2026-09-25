// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker start (concept 7.6 "Docker start", implementation notes 6, FR-14).
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage, UserFacingError } from '../errors';
import { Messages } from '../messages';
import { abortError, isAbortError, sleep as defaultSleep, systemClock, type Clock, type Logger, type ProcessRunner, type RunResult } from '../ports';
import { DOCKER_INFO_TIMEOUT_MS, type ContainerAdapter } from './containerAdapter';
import { windowsDockerDesktopFolders } from './dockerCli';

/** The start command gets this head start before the polling of `docker info` begins; it keeps running in parallel. */
export const START_COMMAND_WAIT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 2_000;
const MIN_INFO_TIMEOUT_MS = 2_000;
const MAC_OPEN = '/usr/bin/open';
const WINDOWS_DESKTOP_EXE = 'Docker Desktop.exe';
/** `docker info` of a user without access to the socket of a running engine. */
const SOCKET_PERMISSION_DENIED = /permission denied/i;

export interface DockerStarterOptions {
  platform: NodeJS.Platform;
  /** Called once, when Docker is not running and a start begins (progress step "Starting Docker"). */
  onStarting?: () => void;
  signal?: AbortSignal;
  /** Default 120000. */
  timeoutMs?: number;
  /** Default 2000. */
  intervalMs?: number;
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  clock?: Clock;
  /** For tests: checks the file `Docker Desktop.exe` on win32. */
  exists?: (file: string) => boolean;
  /** Environment for the installation folder of Docker Desktop on win32 (`ProgramFiles`). Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * For tests: starts a program detached, without waiting for it to end. Resolves when the process has started.
   * Default: `child_process.spawn` with `detached: true`, then `unref()`.
   */
  launchDetached?: (file: string, args: readonly string[]) => Promise<void>;
}

type StartOutcome =
  /** A start command succeeded, or a program was launched. Docker gets ready later. */
  | { kind: 'started'; detail: string }
  /** Linux without the Docker Desktop CLI: Docker Engine, which needs administrator rights to start. */
  | { kind: 'engine'; detail: string }
  /** Nothing could start Docker. */
  | { kind: 'failed'; detail: string };

function outputOf(result: RunResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

/**
 * True if the CLI has no `docker desktop start`: the `desktop` plugin is missing (`docker: unknown command: docker desktop`,
 * older CLIs `'desktop' is not a docker command`), or the plugin does not know `start` (it then prints its usage, exit code 0).
 */
// Assumption (V-11): these outputs identify a CLI without `docker desktop start` (checked with Docker CLI 29.8 only).
function desktopStartUnsupported(result: RunResult): boolean {
  if (result.exitCode === 0) return /^\s*Usage:/m.test(result.stdout);
  return /unknown command|is not a docker command/i.test(outputOf(result));
}

/** Starts a GUI program without waiting for it. */
export function launchDetachedProcess(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { detached: true, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function startDocker(
  docker: ContainerAdapter,
  runner: ProcessRunner,
  logger: Logger,
  options: DockerStarterOptions,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<StartOutcome> {
  const hasFallback = options.platform === 'darwin' || options.platform === 'win32';
  let desktopDetail: string;
  logger.info('Starting Docker: docker desktop start');
  try {
    // Assumption (V-11): `docker desktop start` either returns at once or waits until Docker is ready. The caller polls
    // `docker info` in parallel and ends it.
    const result = await docker.run(['desktop', 'start'], { signal, timeoutMs: timeoutMs + START_COMMAND_WAIT_MS });
    const unsupported = desktopStartUnsupported(result);
    if (result.exitCode === 0 && !unsupported) return { kind: 'started', detail: 'docker desktop start succeeded.' };
    desktopDetail = `docker desktop start: ${outputOf(result) || `exit code ${result.exitCode}`}`;
    // Linux: without the Docker Desktop CLI, this is Docker Engine (a system service). With it, there is no other
    // documented way to start Docker Desktop.
    if (!hasFallback) return { kind: unsupported ? 'engine' : 'failed', detail: desktopDetail };
  } catch (error) {
    if (isAbortError(error)) return { kind: 'failed', detail: 'The start was cancelled.' };
    desktopDetail = `docker desktop start: ${errorMessage(error)}`;
    if (!hasFallback) return { kind: 'failed', detail: desktopDetail };
  }
  logger.info(desktopDetail);

  // Assumption (V-11): versions of Docker Desktop without `docker desktop start` start with these fallbacks.
  if (options.platform === 'darwin') {
    logger.info(`Starting Docker: ${MAC_OPEN} -g -a Docker`);
    try {
      const result = await runner.run(MAC_OPEN, ['-g', '-a', 'Docker'], { signal, timeoutMs: 30_000 });
      if (result.exitCode === 0) return { kind: 'started', detail: 'open -g -a Docker succeeded.' };
      return { kind: 'failed', detail: `${desktopDetail}\nopen -g -a Docker: ${outputOf(result) || `exit code ${result.exitCode}`}` };
    } catch (error) {
      if (isAbortError(error)) return { kind: 'failed', detail: 'The start was cancelled.' };
      return { kind: 'failed', detail: `${desktopDetail}\nopen -g -a Docker: ${errorMessage(error)}` };
    }
  }

  const exists = options.exists ?? ((file: string) => fs.existsSync(file));
  const candidates = windowsDockerDesktopFolders(options.env ?? process.env).map((folder) => path.win32.join(folder, WINDOWS_DESKTOP_EXE));
  const program = candidates.find((file) => exists(file));
  if (!program) {
    return { kind: 'failed', detail: `${desktopDetail}\n${WINDOWS_DESKTOP_EXE} was not found in ${candidates.join(', ')}.` };
  }
  logger.info(`Starting Docker: ${program}`);
  try {
    await (options.launchDetached ?? launchDetachedProcess)(program, []);
    return { kind: 'started', detail: `${program} was started.` };
  } catch (error) {
    return { kind: 'failed', detail: `${desktopDetail}\n${program}: ${errorMessage(error)}` };
  }
}

/** Waits for `promise`, but at most `ms`. Rejects only when `signal` aborts. */
async function waitAtMost(
  promise: Promise<unknown>,
  ms: number,
  sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const timer = new AbortController();
  const onAbort = () => timer.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([
      promise.then(() => undefined),
      sleepFn(ms, timer.signal).catch((error: unknown) => {
        if (!isAbortError(error)) throw error;
      }),
    ]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    timer.abort();
  }
  if (signal?.aborted) throw abortError();
}

function startFailed(detail: string): UserFacingError {
  return new UserFacingError('dockerStartFailed', Messages.dockerStartFailed, detail);
}

/**
 * Resolves when `docker info` succeeds. Starts Docker when needed: `docker desktop start`; fallback on darwin `open -g -a Docker`,
 * on win32 `Docker Desktop.exe` from C:\Program Files\Docker\Docker (spawned detached, not awaited); on linux without Docker Desktop
 * (the `desktop` command is missing) → UserFacingError('dockerEngineNotRunning', Messages.dockerEngineNotRunning).
 * No CLI → UserFacingError('dockerNotInstalled'). Timeout, or no way to start Docker → UserFacingError('dockerStartFailed',
 * Messages.dockerStartFailed, detail). Rejects with an AbortError when the signal aborts.
 *
 * The start command runs in parallel with the polling (every `intervalMs`, for at most `timeoutMs`); it gets a head start of
 * at most 10 s, and it is ended when this function returns.
 */
export async function ensureDockerRunning(
  docker: ContainerAdapter,
  runner: ProcessRunner,
  logger: Logger,
  options: DockerStarterOptions,
): Promise<void> {
  const { signal } = options;
  const clock = options.clock ?? systemClock;
  const sleepFn = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  if (!docker.isInstalled()) throw new UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled);
  if (signal?.aborted) throw abortError();
  const initial = await docker.daemonStatus(signal);
  if (initial.running) return;
  if (SOCKET_PERMISSION_DENIED.test(initial.detail)) {
    // The engine runs, but this user may not use its socket (Linux: not in the group `docker`). A start does not help.
    throw startFailed(
      `The Docker engine runs, but this user has no access to it. On Linux, add the user to the group docker ` +
        `(sudo usermod -aG docker $USER) and sign in again.\ndocker info: ${initial.detail}`,
    );
  }

  logger.info(`Docker is not running: ${initial.detail}`);
  options.onStarting?.();
  const deadline = clock.now() + timeoutMs;
  const startControl = new AbortController();
  const forwardAbort = () => startControl.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });

  let outcome: StartOutcome | undefined;
  const startTask = startDocker(docker, runner, logger, options, timeoutMs, startControl.signal).then(
    (result) => {
      outcome = result;
      logger.info(`Docker start: ${result.detail}`);
    },
    (error: unknown) => {
      // startDocker catches its errors; this is only a safety net against an unhandled rejection.
      outcome = { kind: 'failed', detail: errorMessage(error) };
    },
  );

  try {
    await waitAtMost(startTask, Math.min(START_COMMAND_WAIT_MS, timeoutMs), sleepFn, signal);
    let lastDetail = initial.detail;
    for (;;) {
      if (signal?.aborted) throw abortError();
      const current = outcome as StartOutcome | undefined;
      if (current?.kind === 'engine') {
        throw new UserFacingError('dockerEngineNotRunning', Messages.dockerEngineNotRunning, `${current.detail}\ndocker info: ${lastDetail}`);
      }
      const remaining = deadline - clock.now();
      const infoTimeout = Math.min(DOCKER_INFO_TIMEOUT_MS, Math.max(MIN_INFO_TIMEOUT_MS, remaining));
      const status = await docker.daemonStatus(signal, infoTimeout);
      if (status.running) {
        logger.info(`Docker is ready (${status.detail}).`);
        return;
      }
      lastDetail = status.detail;
      const after = outcome as StartOutcome | undefined;
      if (after?.kind === 'failed') throw startFailed(`${after.detail}\ndocker info: ${lastDetail}`);
      const left = deadline - clock.now();
      if (left <= 0) {
        const start = after ? after.detail : 'The start command had not ended.';
        throw startFailed(`Docker was not ready after ${Math.round(timeoutMs / 1000)} seconds.\n${start}\ndocker info: ${lastDetail}`);
      }
      await sleepFn(Math.min(intervalMs, left), signal);
    }
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
    // Ends a `docker desktop start` that still waits. Docker itself keeps starting or running.
    startControl.abort();
  }
}
