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
// an unknown key fails, and the message asks the user to run `ssh <host>` once in a terminal.
import { errorMessage, UserFacingError } from '../errors';
import { Messages, dockerHostReason } from '../messages';
import { isAbortError, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import type { RemoteDockerState } from '../storage/remoteDockerState';
import { envValue } from './dockerCli';
import {
  DEFAULT_CONTEXT_NAME,
  REMOTE_CONTEXT_NAME,
  RUNTIME_DIR_COMMAND,
  dockerHostProblem,
  isRootlessEngine,
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
 * The test before the switch: `docker -H ssh://<host> info`, without questions (see the module comment). The current
 * context is not used and not changed.
 */
export async function testRemoteDockerHost(
  docker: RemoteDockerCli,
  host: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EngineCheck> {
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
}

/**
 * The step "Docker start" for a remote host: one `docker info` through the current context (no Docker Desktop start, no
 * setup, no "Starting Docker" step). Throws UserFacingError('dockerHostUnreachable') with the plain reason. A rootless
 * engine gets its socket recorded (read once with ssh), a rootful one has it forgotten, so the helper mounts the right
 * socket of that computer.
 */
export async function ensureDockerHostReachable(
  target: DockerTarget,
  deps: RemoteReachabilityDeps,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
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
 * Points the context `devenv-remote` to `ssh://<host>` (`docker context create`, or `docker context update` when it
 * exists) and makes it the current context (`docker context use`).
 */
export async function useRemoteContext(docker: RemoteDockerCli, host: string): Promise<void> {
  const exists = (await listContexts(docker)).includes(REMOTE_CONTEXT_NAME);
  const endpoint = `host=${sshEndpoint(host)}`;
  const args = exists
    ? ['update', REMOTE_CONTEXT_NAME, '--description', 'Dev Environments: remote Docker host', '--docker', endpoint]
    : ['create', REMOTE_CONTEXT_NAME, '--description', 'Dev Environments: remote Docker host', '--docker', endpoint];
  const written = await contextCommand(docker, args);
  if (written.exitCode !== 0) throw contextCommandError(args, written);
  await useContext(docker, REMOTE_CONTEXT_NAME);
}

/** `docker context use <name>`. */
export async function useContext(docker: RemoteDockerCli, name: string): Promise<void> {
  const args = ['use', name];
  const result = await contextCommand(docker, args);
  if (result.exitCode !== 0) throw contextCommandError(args, result);
}

/**
 * The context for "Use the Local Docker": the remembered one (for example Docker Desktop's `desktop-linux`) when it
 * still exists and is not ours, else `default`.
 */
export function localContextChoice(remembered: string | undefined, existing: readonly string[]): string {
  if (remembered !== undefined && remembered !== REMOTE_CONTEXT_NAME && existing.includes(remembered)) return remembered;
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
