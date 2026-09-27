// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker on another computer through SSH (unit 7): the test of a host before the switch, the Docker context commands,
// the reachability check that replaces the Docker Desktop start for a remote host, and the rootless socket.
//
// No questions, ever: the Docker CLI starts `ssh` for an `ssh://` endpoint in a new session without a terminal
// (docker/cli connhelper/commandconn, session_unix.go: Setsid), so ssh cannot ask for a password, a passphrase, or a host
// key on a terminal; SSH_ASKPASS_REQUIRE=never (ssh(1), OpenSSH 8.4 and later) also keeps it from opening a graphical
// askpass program for the test. The Docker CLI gives ssh a connection time limit of 30 s ("-o ConnectTimeout=30",
// connhelper.go addSSHTimeout); each call here has its own time limit on top. Our own `ssh` call (the runtime folder of
// a rootless engine) uses the documented options BatchMode=yes and ConnectTimeout. Host keys are never accepted here:
// an unknown key fails, and the message asks the user to run `ssh <host>` once in a terminal (sshCommandLine).
//
// Review, C3: on Windows the Docker CLI starts ssh.exe without Setsid, and the OpenSSH client of Windows asks on the
// hidden console (a host key, a password) until the time limit; the answer was "does not answer". So before the test of
// a host and before each operation on it, our own `ssh -o BatchMode=yes -o ConnectTimeout=15 -T -- <host> true` runs
// first (checkSshLogin), on every platform: BatchMode makes ssh fail at once instead of asking, and its error names the
// reason (host key, login, unreachable, closed before the login). It is one connection instead of the several of the
// Docker CLI, which also lowers the risk of a lock-out by PerSourcePenalties. A success is kept for SSH_CHECK_CACHE_MS
// per host (SshLoginCache), a failure never.
import { errorMessage, UserFacingError } from '../errors';
import { Messages, dockerHostReason } from '../messages';
import { isAbortError, systemClock, type Clock, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import type { RemoteDockerState } from '../storage/remoteDockerState';
import { envValue } from './dockerCli';
import {
  DEFAULT_CONTEXT_NAME,
  RUNTIME_DIR_COMMAND,
  classifyDockerEndpoint,
  dockerHostProblem,
  isOwnRemoteContext,
  isRootlessEngine,
  parseContextInspect,
  remoteContextName,
  rootlessSocketPath,
  sshCommandArgs,
  sshEndpoint,
  sshTargetOf,
  type DockerHostProblem,
  type DockerTarget,
} from './dockerHost';

/** Time limit of `docker info` on a remote host: an SSH connection plus the question (the CLI gives ssh 30 s to connect). */
export const REMOTE_INFO_TIMEOUT_MS = 45_000;
/** Time limit of our own `ssh` call. */
export const SSH_TIMEOUT_MS = 30_000;
/** Time limit of `docker context create|update|use`, which only write files of the Docker CLI. */
export const CONTEXT_COMMAND_TIMEOUT_MS = 15_000;
/** `docker info` in one line of JSON: the server version and the security options (`name=rootless`). */
export const ENGINE_INFO_FORMAT = '{"version":{{json .ServerVersion}},"securityOptions":{{json .SecurityOptions}}}';

/** The part of ContainerAdapter used here. */
export interface RemoteDockerCli {
  isInstalled(): boolean;
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** The environment of the Docker calls outside of an operation. */
  processEnv(): NodeJS.ProcessEnv;
}

export type EngineCheck =
  | { ok: true; version: string; rootless: boolean }
  | { ok: false; problem: DockerHostProblem; detail: string };

/** The result of `docker info --format ENGINE_INFO_FORMAT`; `undefined` without a server version. */
export function parseEngineInfo(stdout: string): { version: string; rootless: boolean } | undefined {
  const line = stdout.trim().split(/\r?\n/).pop() ?? '';
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { version, securityOptions } = value as Record<string, unknown>;
  if (typeof version !== 'string' || version === '') return undefined;
  return { version, rootless: isRootlessEngine(securityOptions) };
}

/** The environment of a Docker call that must never ask a question: SSH_ASKPASS_REQUIRE=never (see the module comment). */
export function noPromptEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'SSH_ASKPASS_REQUIRE') delete env[key];
  env.SSH_ASKPASS_REQUIRE = 'never';
  return env;
}

function engineCheckOf(result: RunResult, timeoutMs: number): EngineCheck {
  if (result.timedOut) {
    return { ok: false, problem: 'unreachable', detail: `docker info did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
  }
  const info = result.exitCode === 0 ? parseEngineInfo(result.stdout) : undefined;
  if (info) return { ok: true, ...info };
  const detail = (result.stderr || result.stdout).trim() || `docker info failed with exit code ${result.exitCode}.`;
  return { ok: false, problem: dockerHostProblem(detail), detail };
}

async function runEngineInfo(
  docker: RemoteDockerCli,
  args: readonly string[],
  options: RunOptions,
  timeoutMs: number,
): Promise<EngineCheck> {
  try {
    return engineCheckOf(await docker.run(args, { ...options, timeoutMs }), timeoutMs);
  } catch (error) {
    if (isAbortError(error)) throw error;
    const detail = errorMessage(error);
    return { ok: false, problem: dockerHostProblem(detail), detail };
  }
}

/**
 * The test before the switch: the SSH check (checkSshLogin), then `docker -H ssh://<host> info`, without questions (see
 * the module comment). The current context is not used and not changed.
 */
export async function testRemoteDockerHost(
  docker: RemoteDockerCli,
  host: string,
  ssh: SshCheckDeps,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EngineCheck> {
  // Review, C3: our own ssh without questions first; it always connects (no cached success).
  const login = await checkSshLogin(host, ssh, { signal: options.signal, useCache: false });
  if (!login.ok) return login;
  const timeoutMs = options.timeoutMs ?? REMOTE_INFO_TIMEOUT_MS;
  const env = noPromptEnv(docker.processEnv());
  // -H decides the endpoint; DOCKER_CONTEXT would conflict with it.
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'DOCKER_CONTEXT' || key.toUpperCase() === 'DOCKER_HOST') delete env[key];
  return runEngineInfo(docker, ['-H', sshEndpoint(host), 'info', '--format', ENGINE_INFO_FORMAT], { env, signal: options.signal }, timeoutMs);
}

/** `docker info` of the current context (of the operation). */
export async function checkCurrentEngine(
  docker: Pick<RemoteDockerCli, 'run'>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EngineCheck> {
  const timeoutMs = options.timeoutMs ?? REMOTE_INFO_TIMEOUT_MS;
  return runEngineInfo(docker as RemoteDockerCli, ['info', '--format', ENGINE_INFO_FORMAT], { signal: options.signal }, timeoutMs);
}

/**
 * The folder of the runtime files of the SSH user on `host` ($XDG_RUNTIME_DIR), for the socket of a rootless engine:
 * `ssh -o BatchMode=yes -o ConnectTimeout=15 -T [-p port] [-l user] -- <host> 'printf %s "$XDG_RUNTIME_DIR"'`. The
 * command is a constant; the host is a checked alias or address, after `--`.
 */
export async function readRootlessSocket(
  runner: ProcessRunner,
  sshPath: string | undefined,
  host: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ ok: true; socket: string } | { ok: false; problem: DockerHostProblem; detail: string }> {
  if (sshPath === undefined) return { ok: false, problem: 'sshMissing', detail: 'The SSH client (ssh) was not found.' };
  const target = sshTargetOf(host);
  if (!target) return { ok: false, problem: 'unknown', detail: `${host} is no SSH alias or address that Dev Environments can use.` };
  let result: RunResult;
  try {
    result = await runner.run(sshPath, sshCommandArgs(target, RUNTIME_DIR_COMMAND), {
      env: noPromptEnv(env),
      timeoutMs: SSH_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    const detail = errorMessage(error);
    return { ok: false, problem: dockerHostProblem(detail), detail };
  }
  if (result.timedOut) return { ok: false, problem: 'unreachable', detail: `ssh did not answer within ${SSH_TIMEOUT_MS / 1000} seconds.` };
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `ssh failed with exit code ${result.exitCode}.`;
    return { ok: false, problem: dockerHostProblem(detail), detail };
  }
  const socket = rootlessSocketPath(result.stdout);
  if (!socket) {
    return { ok: false, problem: 'unknown', detail: `XDG_RUNTIME_DIR of the SSH user is not set or not a plain path: ${JSON.stringify(result.stdout.trim())}` };
  }
  return { ok: true, socket };
}

/** A successful SSH login to a host is not checked again for this time (review, C3). */
export const SSH_CHECK_CACHE_MS = 60_000;

/** The hosts whose SSH login succeeded within the last SSH_CHECK_CACHE_MS. Failures are never kept. */
export class SshLoginCache {
  private readonly succeededAt = new Map<string, number>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly maxAgeMs: number = SSH_CHECK_CACHE_MS,
  ) {}

  /** True when the login to `host` succeeded less than maxAgeMs ago. */
  isFresh(host: string): boolean {
    const at = this.succeededAt.get(host);
    if (at === undefined) return false;
    const age = this.clock.now() - at;
    if (age >= 0 && age < this.maxAgeMs) return true;
    this.succeededAt.delete(host);
    return false;
  }

  remember(host: string): void {
    this.succeededAt.set(host, this.clock.now());
  }

  forget(host: string): void {
    this.succeededAt.delete(host);
  }
}

/** What the SSH check before a Docker call over SSH needs. */
export interface SshCheckDeps {
  runner: ProcessRunner;
  /** The path of `ssh` (findExecutable). */
  sshPath: string | undefined;
  env: NodeJS.ProcessEnv;
  /** Keeps successes for a while; without it, every check opens a connection. */
  sshLogins?: SshLoginCache;
}

export type SshLoginCheck =
  | { ok: true; skipped?: 'cached' | 'notAnSshTarget' }
  | { ok: false; problem: DockerHostProblem; detail: string };

/**
 * The SSH check before a Docker call to `host` (see the module comment): `ssh -o BatchMode=yes -o ConnectTimeout=15 -T
 * [-p port] [-l user] -- <host> true`, without questions. `useCache`: a success of the last SSH_CHECK_CACHE_MS counts
 * (the test before a switch always connects). A host that is no usable alias or address (for example of a context of
 * the user with a path) is left to the Docker CLI.
 */
export async function checkSshLogin(
  host: string,
  deps: SshCheckDeps,
  options: { signal?: AbortSignal; useCache?: boolean } = {},
): Promise<SshLoginCheck> {
  if (options.useCache !== false && deps.sshLogins?.isFresh(host)) return { ok: true, skipped: 'cached' };
  const target = sshTargetOf(host);
  if (!target) return { ok: true, skipped: 'notAnSshTarget' };
  if (deps.sshPath === undefined) return { ok: false, problem: 'sshMissing', detail: 'The SSH client (ssh) was not found.' };
  let result: RunResult;
  try {
    result = await deps.runner.run(deps.sshPath, sshCommandArgs(target, 'true'), {
      env: noPromptEnv(deps.env),
      timeoutMs: SSH_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    const detail = errorMessage(error);
    return { ok: false, problem: dockerHostProblem(detail), detail };
  }
  if (result.timedOut) return { ok: false, problem: 'unreachable', detail: `ssh did not answer within ${SSH_TIMEOUT_MS / 1000} seconds.` };
  if (result.exitCode !== 0) {
    deps.sshLogins?.forget(host);
    const detail = result.stderr.trim() || `ssh failed with exit code ${result.exitCode}.`;
    return { ok: false, problem: dockerHostProblem(detail), detail };
  }
  deps.sshLogins?.remember(host);
  return { ok: true };
}

/** UserFacingError('dockerHostUnreachable') for `host`. */
export function dockerHostUnreachable(host: string, problem: DockerHostProblem, detail: string): UserFacingError {
  return new UserFacingError('dockerHostUnreachable', Messages.dockerHostUnreachable(host, dockerHostReason(problem, host)), detail);
}

/** UserFacingError('dockerEndpointUnsupported') for an endpoint that is neither local nor SSH. */
export function dockerEndpointUnsupported(endpoint: string): UserFacingError {
  return new UserFacingError('dockerEndpointUnsupported', Messages.dockerEndpointUnsupported(endpoint), `Docker endpoint: ${endpoint}`);
}

export interface RemoteReachabilityDeps {
  docker: Pick<RemoteDockerCli, 'run'>;
  runner: ProcessRunner;
  state: Pick<RemoteDockerState, 'rootlessSocket' | 'setRootlessSocket'>;
  logger: Logger;
  /** The path of `ssh` (findExecutable), for the runtime folder of a rootless engine. */
  sshPath: string | undefined;
  env: NodeJS.ProcessEnv;
  /** Review, C3: the successes of the SSH check, per host (one cache for the extension). */
  sshLogins?: SshLoginCache;
}

/**
 * The step "Docker start" for a remote host: the SSH check (checkSshLogin), then one `docker info` through the current context (no Docker Desktop start, no
 * setup, no "Starting Docker" step). Throws UserFacingError('dockerHostUnreachable') with the plain reason. A rootless
 * engine gets its socket recorded (read once with ssh), a rootful one has it forgotten, so the helper mounts the right
 * socket of that computer.
 */
export async function ensureDockerHostReachable(
  target: DockerTarget,
  deps: RemoteReachabilityDeps,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  // Review, C3: our own ssh without questions first (a success of the last minute counts).
  const login = await checkSshLogin(target.host, deps, { signal: options.signal });
  if (!login.ok) {
    deps.logger.warn(`The Docker host ${target.host} cannot be reached over SSH: ${login.detail}`);
    throw dockerHostUnreachable(target.host, login.problem, login.detail);
  }
  const check = await checkCurrentEngine(deps.docker, options);
  if (!check.ok) {
    deps.logger.warn(`The Docker host ${target.host} cannot be reached: ${check.detail}`);
    throw dockerHostUnreachable(target.host, check.problem, check.detail);
  }
  deps.logger.info(`Docker host ${target.host}: Docker engine ${check.version}${check.rootless ? ' (rootless)' : ''}.`);
  await recordRootlessSocket(target.host, check.rootless, deps, options.signal);
}

/** Records the rootless socket of `host` (reads it with ssh once), or forgets it for a rootful engine. */
export async function recordRootlessSocket(
  host: string,
  rootless: boolean,
  deps: Omit<RemoteReachabilityDeps, 'docker'>,
  signal?: AbortSignal,
): Promise<void> {
  if (!rootless) {
    await deps.state.setRootlessSocket(host, undefined);
    return;
  }
  if ((await deps.state.rootlessSocket(host)) !== undefined) return;
  const read = await readRootlessSocket(deps.runner, deps.sshPath, host, deps.env, signal);
  if (!read.ok) {
    deps.logger.warn(`The socket of the rootless Docker engine on ${host} could not be read: ${read.detail}`);
    throw dockerHostUnreachable(host, read.problem, read.detail);
  }
  deps.logger.info(`The Docker engine on ${host} runs rootless; its socket is ${read.socket}.`);
  await deps.state.setRootlessSocket(host, read.socket);
}

/**
 * The environment of a Docker context command: without DOCKER_CONTEXT (the command names its context itself). The
 * caller refuses a switch while DOCKER_HOST or DOCKER_CONTEXT is set for VS Code (dockerVariableOverride).
 */
function contextCommandEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'DOCKER_CONTEXT') delete env[key];
  return env;
}

/** DOCKER_HOST or DOCKER_CONTEXT set for VS Code: a context switch would have no effect on it. */
export function dockerVariableOverride(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): 'DOCKER_HOST' | 'DOCKER_CONTEXT' | undefined {
  if ((envValue(env, 'DOCKER_HOST', platform) ?? '').trim() !== '') return 'DOCKER_HOST';
  if ((envValue(env, 'DOCKER_CONTEXT', platform) ?? '').trim() !== '') return 'DOCKER_CONTEXT';
  return undefined;
}

async function contextCommand(docker: RemoteDockerCli, args: readonly string[]): Promise<RunResult> {
  return docker.run(['context', ...args], { env: contextCommandEnv(docker.processEnv()), timeoutMs: CONTEXT_COMMAND_TIMEOUT_MS });
}

function contextCommandError(args: readonly string[], result: RunResult): Error {
  return new Error(`docker context ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`}`);
}

/** The names of the Docker contexts (`docker context ls --format '{{.Name}}'`). */
export async function listContexts(docker: RemoteDockerCli): Promise<string[]> {
  const args = ['ls', '--format', '{{.Name}}'];
  const result = await contextCommand(docker, args);
  if (result.exitCode !== 0) throw contextCommandError(args, result);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s*\*$/, ''))
    .filter((line) => line !== '');
}

/**
 * The endpoint of the context `name` (`docker context inspect <name> --format '{{json .}}'`); undefined when it cannot
 * be read.
 */
export async function contextEndpoint(docker: RemoteDockerCli, name: string): Promise<string | undefined> {
  const args = ['inspect', name, '--format', '{{json .}}'];
  const result = await contextCommand(docker, args);
  if (result.exitCode !== 0) return undefined;
  return parseContextInspect(result.stdout)?.endpoint;
}

/**
 * Makes the context of `host` (remoteContextName: one per host) the current context (`docker context use`); creates it
 * with `ssh://<host>` first when it does not exist (`docker context create`). An existing context is never changed
 * (review, C1): an operation of another window that runs on it keeps its host. One of our names that points elsewhere
 * is refused. Returns the name of the context.
 */
export async function useRemoteContext(docker: RemoteDockerCli, host: string): Promise<string> {
  const name = remoteContextName(host);
  const endpoint = sshEndpoint(host);
  if ((await listContexts(docker)).includes(name)) {
    const existing = await contextEndpoint(docker, name);
    if (existing !== endpoint) {
      throw new Error(`The Docker context ${name} points to ${existing ?? 'an endpoint that cannot be read'}, not to ${endpoint}. Remove it (docker context rm ${name}) and try again.`);
    }
  } else {
    const args = ['create', name, '--description', `Dev Environments: remote Docker host ${host}`, '--docker', `host=${endpoint}`];
    const written = await contextCommand(docker, args);
    if (written.exitCode !== 0) throw contextCommandError(args, written);
  }
  await useContext(docker, name);
  return name;
}

/** `docker context use <name>`. */
export async function useContext(docker: RemoteDockerCli, name: string): Promise<void> {
  const args = ['use', name];
  const result = await contextCommand(docker, args);
  if (result.exitCode !== 0) throw contextCommandError(args, result);
}

/**
 * The context for "Use the Local Docker" by name: the remembered one (for example Docker Desktop's `desktop-linux`) when
 * it still exists and is not ours, else `default`. chooseLocalContext also checks where it points.
 */
export function localContextChoice(remembered: string | undefined, existing: readonly string[]): string {
  if (remembered !== undefined && !isOwnRemoteContext(remembered) && existing.includes(remembered)) return remembered;
  return DEFAULT_CONTEXT_NAME;
}

/**
 * The context for "Use the Local Docker": localContextChoice, and the remembered context only when its endpoint is the
 * local Docker (classifyDockerEndpoint); one that points to another computer (for example a context `mybox` with
 * `ssh://…` of the user) gives `default` (review, C2).
 */
export async function chooseLocalContext(docker: RemoteDockerCli, remembered: string | undefined, logger?: Logger): Promise<string> {
  const name = localContextChoice(remembered, await listContexts(docker));
  if (name === DEFAULT_CONTEXT_NAME) return name;
  const endpoint = await contextEndpoint(docker, name);
  if (endpoint !== undefined && classifyDockerEndpoint(endpoint).kind === 'local') return name;
  logger?.info(`The remembered Docker context ${name} does not point to the local Docker (${endpoint ?? 'not readable'}); the context ${DEFAULT_CONTEXT_NAME} is used.`);
  return DEFAULT_CONTEXT_NAME;
}

/**
 * The step "Docker start" of an operation on `target` (unit 7): the local Docker as before (`startLocal`, which starts
 * Docker Desktop or offers the setup); a remote host only gets the reachability check (never a Docker Desktop start);
 * an endpoint that is neither is refused.
 */
export async function startDockerFor(
  target: DockerTarget,
  startLocal: () => Promise<void>,
  remote: RemoteReachabilityDeps,
  signal?: AbortSignal,
): Promise<void> {
  switch (target.kind) {
    case 'local':
      return startLocal();
    case 'unsupported':
      remote.logger.warn(`The Docker endpoint ${target.endpoint} is neither local nor SSH. Nothing is started.`);
      throw dockerEndpointUnsupported(target.endpoint);
    case 'remote':
      return ensureDockerHostReachable(target, remote, { signal });
  }
}
