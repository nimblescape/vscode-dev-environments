// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Container Adapter (concept 7.2): Docker CLI calls on the computer.
// Output is read as JSON (`--format '{{json …}}'` and `docker … inspect`), never as a table. Labels are read with
// `docker inspect`, because `docker ps`/`docker volume ls` join them into one string `a=b,c=d` that is ambiguous
// when a value contains a comma (for example `devcontainer.metadata`).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandError, errorMessage, UserFacingError } from '../errors';
import { IMAGE_INSPECT_BATCH, MAX_IMAGE_INSPECT_SINGLE_CALLS } from '../helper/analysisLimits';
import { Messages } from '../messages';
import { LABEL_ENVIRONMENT_ID } from '../names';
import { passwdUserIds, type UserIds } from './passwdUsers';
import {
  abortError,
  isAbortError,
  type Credentials,
  type Logger,
  type ProcessRunner,
  type RunOptions,
  type RunResult,
} from '../ports';
import type { ContainerState } from '../types';
import { envValue } from './dockerCli';
import {
  BootstrapDocker,
  DOCKER_QUERY_TIMEOUT_MS,
  MISSING_PATTERNS,
  commandText,
  deleteEnv,
  isRecord,
  labelArgs,
  parseJsonLines,
  parseJsonOutput,
  type BootstrapDockerOptions,
  type ObjectKind,
} from './bootstrapDocker';
import type { DockerTarget } from './dockerHost';
import { dockerCommandWords, isReadOnlyDockerCall, isRoutableDockerCall } from './dockerRouting';
import { operationDockerTarget } from './dockerTargets';
import { heldEnvironmentLock, type HeldEnvironmentLock } from './environmentLock';
import { preparingWorker } from './workerPreparation';
import { isDevContainer } from '../worker/dockerEngine';
import { HelperChannelError, HelperOperationError, type ChannelPullOptions } from '../helperChannel/helperChannel';
import { pullReference } from '../helperChannel/protocol';
import { IDENTITY_TOKEN_USER } from '../imageCheck/credentials';
import { credentialServerName, parseImageReference } from '../imageCheck/reference';

import {
  mapContainerState,
  preferred,
  publicInfo,
  toContainerInfo,
  toLabels,
  toNetworkInfo,
  toVolumeInfo,
  type ContainerInfo,
  type ImageInfo,
  type InspectedContainer,
  type MountTarget,
  type NetworkInfo,
  type VolumeInfo,
  type VolumeSubpathMount,
} from './dockerObjects';

// Plan step 11B3: the Docker objects and their reading moved to dockerObjects.ts (one definition for both adapters).
export { mapContainerState, toLabels, type ContainerInfo, type ImageInfo, type MountTarget, type NetworkInfo, type VolumeInfo, type VolumeSubpathMount };

// Plan step 5, PR A: the classification moved to dockerRouting.ts.
export { isReadOnlyDockerCall };

// Plan step 11F2: the Docker CLI of the bootstrap moved to bootstrapDocker.ts.
export {
  DOCKER_CLI_LOOKUP_RETRY_MS,
  DOCKER_INFO_TIMEOUT_MS,
  DOCKER_QUERY_TIMEOUT_MS,
  SSH_DROP_RETRY_DELAY_MS,
  directCommandName,
  parseJsonLines,
  sshDroppedReadCall,
  type DaemonStatus,
} from './bootstrapDocker';

// Plan step 11B1: isDevContainer lives with the port of the flows (src/core/worker/dockerEngine.ts), one definition.
export { isDevContainer };

/** Number of IDs per `docker inspect` call (command line length on Windows). */
const INSPECT_BATCH_SIZE = 50;
/** Credentials of one registry for one `docker pull` (for example the GitHub session for ghcr.io). */
export interface RegistryLogin extends Credentials {
  /** Registry host, for example `ghcr.io`. */
  registry: string;
}

/**
 * Plan step 5, PR A: runs one plain Docker call (isRoutableDockerCall) on the engine of `target` through the worker.
 * Plan step 5, PR D (rule D1 of 2026-09-30): it makes the worker ready first and never returns without the call:
 * rejects like HelperChannels.docker (an AbortError; HelperChannelError `unavailable`: the worker could not be made ready;
 * `unsendable` or `closed`: not sent; `lost` or `protocol`, HelperOperationError: the outcome is not known).
 */
export type DockerRouter = (
  target: DockerTarget,
  args: readonly string[],
  options: Pick<RunOptions, 'timeoutMs' | 'signal'>,
) => Promise<RunResult>;

/**
 * Plan step 10A (decision of 2026-10-03): the operations of the worker over the Engine API (HelperChannels.pull and
 * startContainers in the extension), for an operation on `target`. They reject like HelperChannels.docker.
 */
export interface WorkerEngine {
  pull(target: DockerTarget, reference: string, options: ChannelPullOptions): Promise<void>;
  startContainers(target: DockerTarget, ids: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
}

/** Plan step 11F2: the options of BootstrapDocker, and the credentials of a pull through the worker. */
export interface ContainerAdapterOptions extends BootstrapDockerOptions {
  /**
   * Plan step 10A (decision of 2026-10-03): the registry credentials that Docker has stored on this computer
   * (DockerCredentialStore.getForPull: an identity token as `{ username: '<token>', password: <token> }`). A pull through the worker sends them as the secret of the operation, as the Docker CLI on
   * this computer sent them to the engine before (the worker has no credentials of its own).
   */
  storedCredentials?: (registry: string, signal?: AbortSignal) => Promise<Credentials | undefined>;
}

/** Label that Docker Compose gives each container, network, and volume of a project. */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/** Review round 9 (S9-3): an image as `docker image inspect` describes it: its ID, tags, and digests. */
export interface ImageNames {
  id: string;
  repoTags: string[];
  repoDigests: string[];
}

/**
 * Review round 11 (G1): why inspectImageNames could not check a reference. `invalid`: Docker's answer is about the
 * reference itself ("invalid reference format", or an image ID prefix that matches more than one image), the same at
 * every call. `transient`: the answer says nothing about the reference (a timeout, a daemon that cannot be reached or
 * fails, an unknown error, a Docker CLI that cannot be started, or a reference beyond MAX_IMAGE_INSPECT_SINGLE_CALLS).
 */
export type ImageUncheckedReason = 'invalid' | 'transient';

/** The result of inspectImageNames (review round 10, P10-1). */
export interface ImageInspection {
  /** The local images that the references found. */
  images: ImageNames[];
  /** The references that Docker could not inspect for another reason than a missing image, each with its reason. */
  unchecked: Array<{ reference: string; reason: ImageUncheckedReason }>;
}

/**
 * Review round 11 (G1): the errors of `docker image inspect` about a reference itself, matched loosely: an invalid
 * reference ("invalid reference format", "repository name must be lowercase", "invalid tag format"), and an ID prefix
 * that matches several images (the classic image store: "multiple IDs found with provided prefix"; the containerd image
 * store: "ambiguous reference", "ambiguous image", "multiple images match"). Review round 12 (P12-1): also the errors
 * of go-digest ("invalid checksum digest format", "invalid checksum digest length", "unsupported digest algorithm") and
 * of the length of a name ("repository name must not be more than 255 characters").
 */
const IMAGE_REFERENCE_ERROR =
  /invalid reference|reference format|must be lowercase|invalid (repository|tag|digest|image)|checksum digest|digest algorithm|must not be more than|ambiguous|multiple (ids|images|digests|matches)|matches multiple|more than one/i;

/** Parses the JSON array that `docker inspect` prints. Empty output is an empty list. */
function parseInspectArray(stdout: string): unknown[] | undefined {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}


/**
 * Plan step 11B3: a container that runs `entrypoint args…` on a volume and is removed after it (the ownership fix before
 * the create, review round 1 of PR #82: `--init`, so that a SIGTERM ends it, and a cleanup label by which a cancel
 * removes it). Plan step 11G replaces it by a step of the batch helper.
 */
export interface VolumeRun {
  image: string;
  volume: string;
  target: string;
  entrypoint: string;
  args: readonly string[];
  user: string;
  labels: Record<string, string>;
}

/** The arguments of `docker run` of a VolumeRun: no pull, no network. */
export function volumeRunArgs(p: VolumeRun): string[] {
  return [
    'run',
    '--rm',
    '--init',
    '--pull',
    'never',
    '--network',
    'none',
    ...labelArgs(p.labels, '--label'),
    '--user',
    p.user,
    '--entrypoint',
    p.entrypoint,
    '--mount',
    `type=volume,source=${p.volume},target=${p.target}`,
    p.image,
    ...p.args,
  ];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/** Content of a Docker `config.json` that holds only the credentials of one registry. */
export function registryLoginConfig(login: RegistryLogin): string {
  const auth = Buffer.from(`${login.username}:${login.password}`, 'utf8').toString('base64');
  return JSON.stringify({ auths: { [login.registry]: { auth } } });
}

/**
 * True when a Docker call to `host` keeps registry credentials from travelling in clear text: an empty endpoint (the
 * default of the platform, a Unix socket or a named pipe), `unix://`, `npipe://`, `ssh://`, or `tcp://` with
 * DOCKER_TLS_VERIFY set to a value other than `0` and DOCKER_CERT_PATH set in `env` (the environment that the Docker
 * call gets). Every other endpoint is not: `tcp://` without these variables is plain HTTP, and an unknown scheme cannot
 * be judged. The TLS files of a Docker context are not used: a call with its own config folder (`docker --config`) does
 * not see the context, and its store is internal to Docker.
 */
export function isProtectedDockerEndpoint(host: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const endpoint = (host ?? '').trim();
  if (endpoint === '') return true;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(endpoint)?.[1].toLowerCase();
  if (scheme === 'unix' || scheme === 'npipe' || scheme === 'ssh') return true;
  if (scheme !== 'tcp') return false;
  const verify = (envValue(env, 'DOCKER_TLS_VERIFY', platform) ?? '').trim();
  const certPath = (envValue(env, 'DOCKER_CERT_PATH', platform) ?? '').trim();
  return verify !== '' && verify !== '0' && certPath !== '';
}

/**
 * The Docker CLI of the pipeline before the worker ran it (concept 7.2): the bootstrap's calls (BootstrapDocker) and the
 * calls of the flows, routed through the worker within an operation. Plan step 11F2: no longer used by the extension;
 * removed with the rest of the CLI adapter beyond the bootstrap (plan step 11I).
 */
export class ContainerAdapter extends BootstrapDocker {
  private router: DockerRouter | undefined;
  private workerEngine: WorkerEngine | undefined;
  private readonly storedCredentials: ContainerAdapterOptions['storedCredentials'];

  /** See BootstrapDocker. */
  constructor(
    runner: ProcessRunner,
    dockerPath: string | undefined,
    env: NodeJS.ProcessEnv,
    logger: Logger,
    platform: NodeJS.Platform = process.platform,
    options: ContainerAdapterOptions = {},
  ) {
    super(runner, dockerPath, env, logger, platform, options);
    this.storedCredentials = options.storedCredentials;
  }

  /**
   * Plan step 5, PR A: the worker for the plain Docker calls of an operation (HelperChannels.docker in the extension).
   * Undefined: every call runs directly.
   */
  setRouter(router: DockerRouter | undefined): void {
    this.router = router;
  }

  /** Plan step 10A: the operations of the worker over the Engine API (WorkerEngine). Undefined: they run directly. */
  setWorkerEngine(engine: WorkerEngine | undefined): void {
    this.workerEngine = engine;
  }

  /**
   * Plan step 10A (decision of 2026-10-03): where an operation of the Engine API goes, like `run`: the worker that holds
   * the lock of the environment, the worker of the operation's engine, or (outside an operation, while the worker is
   * prepared, or without a worker) the Docker CLI of this computer.
   */
  private engineRoute(): { kind: 'lock'; lock: HeldEnvironmentLock } | { kind: 'worker'; target: DockerTarget; engine: WorkerEngine } | { kind: 'direct' } {
    const held = heldEnvironmentLock();
    if (held !== undefined) return { kind: 'lock', lock: held.lock };
    const target = this.workerEngine === undefined ? undefined : operationDockerTarget();
    if (target !== undefined && this.workerEngine !== undefined && !preparingWorker()) return { kind: 'worker', target, engine: this.workerEngine };
    return { kind: 'direct' };
  }

  /**
   * Plan step 10A: an operation of the Engine API through the lock's worker (`viaLock`) or the operation's worker
   * (`viaWorker`); `command` names it in errors (`pull <image>`). Never the way without the worker (D1). Errors as in
   * runRouted: the worker could not be prepared → UserFacingError('helperFailed'); not sent → CommandError (it did not
   * run); a failure of the operation → CommandError with its message; a lost worker → CommandError (outcome not known).
   */
  private async throughWorker(
    command: string,
    signal: AbortSignal | undefined,
    route: Exclude<ReturnType<ContainerAdapter['engineRoute']>, { kind: 'direct' }>,
    viaLock: (lock: HeldEnvironmentLock) => Promise<void>,
    viaWorker: (engine: WorkerEngine, target: DockerTarget) => Promise<void>,
  ): Promise<void> {
    if (route.kind === 'lock') {
      const lost = heldEnvironmentLock()?.lostReason();
      if (lost !== undefined) throw new CommandError(`docker ${command}`, null, '', `The lock of the environment on the Docker host was lost (${lost}); docker ${command} was not run.`);
    }
    try {
      if (route.kind === 'lock') await viaLock(route.lock);
      else await viaWorker(route.engine, route.target);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (signal?.aborted) throw abortError();
      if (error instanceof HelperChannelError && error.code === 'unavailable') {
        this.logger.warn(`docker ${command} was refused: the worker on the Docker host could not be prepared (${error.message}).`);
        throw new UserFacingError('helperFailed', Messages.workerUnavailable(error.message), error.message);
      }
      if (error instanceof HelperChannelError && (error.code === 'unsendable' || error.code === 'closed')) {
        throw new CommandError(`docker ${command}`, null, '', `docker ${command} was not sent to the worker on the Docker host (${errorMessage(error)}); it did not run.`);
      }
      if (error instanceof HelperOperationError) throw new CommandError(`docker ${command}`, 1, '', error.message);
      if (error instanceof HelperChannelError) {
        throw new CommandError(`docker ${command}`, null, '', `The connection to the Docker host was lost; the outcome of docker ${command} is not known.`);
      }
      throw error;
    }
  }

  /**
   * Plan step 10A (decision of 2026-10-03): `docker start <id>` of a container by its full ID; within an operation by the
   * worker (the operation `startContainers` over the Engine API), else by the Docker CLI. Throws CommandError.
   */
  async startContainer(id: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    const route = this.engineRoute();
    if (route.kind === 'direct') {
      await this.runChecked(['start', id], options);
      return;
    }
    await this.throughWorker(
      `start ${id.slice(0, 12)}`,
      options.signal,
      route,
      async (lock) => {
        if (lock.startContainers === undefined) throw new HelperChannelError('unsendable', 'the worker that holds the lock cannot start containers');
        await lock.startContainers([id], options);
      },
      (engine, target) => engine.startContainers(target, [id], options),
    );
  }

  /**
   * Raw call. Resolves also for a non-zero exit code. Throws UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled)
   * without a CLI, or when the CLI cannot be started anymore (removed after it was found).
   *
   * Plan step 5, PR A: within an operation (operationDockerTarget), a routable call (isRoutableDockerCall) goes through
   * the router when one is set. Plan step 5, PR D (rule D1 of 2026-09-30): only through it, never directly (see
   * runRouted); the exception are the calls that make the state for the worker consistent (workerPreparation.ts: the
   * check whether Docker runs, the helper image), which run directly.
   */
  override async run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    // Plan step 5, PR B: an operation that holds the lock of an environment (environmentLock.ts).
    const held = heldEnvironmentLock();
    if (held !== undefined) return this.runLocked(held, args, options);
    const target = this.router === undefined ? undefined : operationDockerTarget();
    // Plan step 5, PR D (rule D1 of 2026-09-30): no direct way after the router.
    if (target !== undefined && isRoutableDockerCall(args, options) && !preparingWorker()) return this.runRouted(target, args, options);
    return this.runDirect(args, options);
  }

  /**
   * Plan step 5, PR B: a call while the operation holds the lock of an environment. After the lock was lost, no call runs
   * (CommandError). A routable call goes only through the worker that holds the lock: when it was not sent, or the worker
   * was lost or failed while it ran, it throws a CommandError and never runs directly (also a call that only reads), so
   * a lost lock never lets the operation go on without it. Any other call runs directly, as without the lock.
   */
  private async runLocked(held: NonNullable<ReturnType<typeof heldEnvironmentLock>>, args: readonly string[], options: RunOptions): Promise<RunResult> {
    const command = dockerCommandWords(args).join(' ');
    const lost = held.lostReason();
    if (lost !== undefined) {
      throw new CommandError(commandText(args), null, '', `The lock of the environment on the Docker host was lost (${lost}); docker ${command} was not run.`);
    }
    if (!isRoutableDockerCall(args, options)) return this.runDirect(args, options);
    try {
      return await held.lock.docker(args, { timeoutMs: options.timeoutMs, signal: options.signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (options.signal?.aborted) throw abortError();
      this.logger.warn(`docker ${command} through the worker that holds the lock failed (${errorMessage(error)}); it is not run directly.`);
      // PR #74 review round 1 (A-R1-2): a call that was not sent (no place of its own, or a closed channel) did not run.
      if (error instanceof HelperChannelError && (error.code === 'unsendable' || error.code === 'closed')) {
        throw new CommandError(
          commandText(args),
          null,
          '',
          `docker ${command} was not sent to the worker that holds the lock of the environment (${errorMessage(error)}); it did not run.`,
        );
      }
      throw new CommandError(
        commandText(args),
        null,
        '',
        `The connection to the worker that holds the lock of the environment failed; the outcome of docker ${command} is not known.`,
      );
    }
  }

  /**
   * run through the router. Plan step 5, PR D (rule D1 of 2026-09-30): never directly, whatever happens. The worker could
   * not be made ready (the helper image, the open): UserFacingError('helperFailed', Messages.workerUnavailable) with the
   * cause, nothing ran. Not sent (`unsendable`, or `closed` twice): a CommandError, it did not run. The worker was lost,
   * answered wrongly, or the operation failed in it: a call that only reads throws a CommandError that says it failed
   * through the worker (it is not run directly); any other call throws a CommandError, because its outcome is not known,
   * and is never repeated.
   */
  private async runRouted(target: DockerTarget, args: readonly string[], options: RunOptions): Promise<RunResult> {
    const router = this.router;
    if (router === undefined) return this.runDirect(args, options);
    try {
      return await router(target, args, { timeoutMs: options.timeoutMs, signal: options.signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (options.signal?.aborted) throw abortError();
      const command = dockerCommandWords(args).join(' ');
      if (error instanceof HelperChannelError && error.code === 'unavailable') {
        this.logger.warn(`docker ${command} was refused: the worker on the Docker host could not be prepared (${error.message}); it is not run directly.`);
        throw new UserFacingError('helperFailed', Messages.workerUnavailable(error.message), error.message);
      }
      if (error instanceof HelperChannelError && (error.code === 'unsendable' || error.code === 'closed')) {
        this.logger.warn(`docker ${command} was not sent to the worker (${errorMessage(error)}); it is not run directly.`);
        throw new CommandError(commandText(args), null, '', `docker ${command} was not sent to the worker on the Docker host (${errorMessage(error)}); it did not run.`);
      }
      const unknownOutcome =
        (error instanceof HelperChannelError && (error.code === 'lost' || error.code === 'protocol')) || error instanceof HelperOperationError;
      if (!unknownOutcome) throw error;
      if (isReadOnlyDockerCall(args)) {
        this.logger.warn(`docker ${command} through the worker failed (${errorMessage(error)}); it is not run directly.`);
        throw new CommandError(commandText(args), null, '', `docker ${command} failed through the worker on the Docker host (${errorMessage(error)}).`);
      }
      this.logger.warn(`docker ${command} through the worker failed (${errorMessage(error)}); its outcome is not known, and it is not repeated.`);
      throw new CommandError(
        commandText(args),
        null,
        '',
        `The connection to the Docker host was lost; the outcome of docker ${command} is not known.`,
      );
    }
  }

  /**
   * The container with the label nimblescape.devenv.environment-id=<id>. If there are several, a running one, then the
   * newest. The other services of a Docker Compose environment carry the label too, with
   * nimblescape.devenv.compose-service: they are skipped, so this is always the dev container. A container with the
   * name of the environment (`containerName`, the name of the dev container) is never skipped, whatever labels its
   * image gave it (review round 1, D2: an image with the label nimblescape.devenv.compose-service would hide a single
   * container, which then kept running after the checks were turned on). That container comes first (final review,
   * FC-1: the previous dev container of a Select configuration…, renamed and without
   * nimblescape.devenv.compose-service, or a stray container of the environment never wins over it); without it (an
   * older container, a failed switch), a running one, then the newest.
   */
  async findContainer(environmentId: string, containerName: string): Promise<ContainerInfo | undefined> {
    const all = await this.inspectContainers(await this.containerIds(`label=${LABEL_ENVIRONMENT_ID}=${environmentId}`));
    const containers = all.filter((container) => isDevContainer(container, containerName));
    if (containers.length === 0) return undefined;
    if (containers.length > 1) {
      this.logger.warn(`${containers.length} containers have the label ${LABEL_ENVIRONMENT_ID}=${environmentId}: ${containers.map((c) => c.name).join(', ')}`);
    }
    const named = containers.find((container) => container.name === containerName);
    return publicInfo(named ?? [...containers].sort(preferred)[0]);
  }

  /**
   * The API version of the Docker Engine (`docker version --format '{{.Server.APIVersion}}'`, for example `1.48`), or
   * `undefined` when the engine does not tell it. Docker Compose configurations need it for `volume.subpath`
   * (supportsVolumeSubpath). Rejects only with an AbortError.
   */
  async engineApiVersion(signal?: AbortSignal): Promise<string | undefined> {
    let result: RunResult;
    try {
      result = await this.run(['version', '--format', '{{.Server.APIVersion}}'], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.logger.warn(`The API version of the Docker Engine could not be read: ${errorMessage(error)}`);
      return undefined;
    }
    const version = result.stdout.trim();
    if (result.exitCode === 0 && /^\d+\.\d+$/.test(version)) return version;
    this.logger.warn(`The API version of the Docker Engine could not be read: ${(result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`}`);
    return undefined;
  }

  /** All containers with the label nimblescape.devenv.environment-id, running or not. */
  async listEnvironmentContainers(): Promise<ContainerInfo[]> {
    const containers = await this.inspectContainers(await this.containerIds(`label=${LABEL_ENVIRONMENT_ID}`));
    return containers.map(publicInfo);
  }

  /**
   * All containers of the Docker Compose project `project` (label com.docker.compose.project), running or not, also
   * those without the label nimblescape.devenv.environment-id (for example one-off containers of `docker compose run`).
   */
  async listProjectContainers(project: string): Promise<ContainerInfo[]> {
    const containers = await this.inspectContainers(await this.containerIds(`label=${COMPOSE_PROJECT_LABEL}=${project}`));
    return containers.map(publicInfo);
  }

  /** The names of the networks of the Docker Compose project `project` (label com.docker.compose.project). */
  async listProjectNetworks(project: string): Promise<string[]> {
    const args = ['network', 'ls', '--filter', `label=${COMPOSE_PROJECT_LABEL}=${project}`, '--format', '{{json .Name}}'];
    const names = parseJsonLines(await this.runChecked(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS }));
    return [...new Set(names.filter((name): name is string => typeof name === 'string' && name !== ''))];
  }

  /** `docker network rm`. A missing network is not an error; a network in use is (CommandError). */
  async removeNetwork(name: string): Promise<void> {
    this.logger.info(`Removing network ${name}.`);
    const args = ['network', 'rm', name];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode === 0 || (!result.timedOut && /not found|no such network/i.test(result.stderr))) return;
    throw this.commandError(args, result);
  }

  /**
   * The images that Docker Compose built for the project `project`: `<project>-<service>` (composeServiceImage), as
   * `repository:tag` (`docker image ls --filter reference=<project>-*`). With `environmentId`, only the images whose label
   * nimblescape.devenv.environment-id names that environment (review round 1, D3; user decisions 2026-10-03: every image
   * that Compose builds for an environment carries it, so an image without it, perhaps of another environment whose name
   * starts with `<project>-`, is left out too). Throws CommandError.
   */
  async listProjectImages(project: string, environmentId?: string): Promise<string[]> {
    const args = ['image', 'ls', '--filter', `reference=${project}-*`, '--format', '{{json .}}'];
    const stdout = await this.runChecked(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    const images = new Set<string>();
    for (const item of parseJsonLines(stdout)) {
      if (!isRecord(item) || typeof item.Repository !== 'string' || typeof item.Tag !== 'string') continue;
      if (!item.Repository.startsWith(`${project}-`) || !item.Tag || item.Tag === '<none>') continue;
      images.add(`${item.Repository}:${item.Tag}`);
    }
    const sorted = [...images].sort();
    if (environmentId === undefined || sorted.length === 0) return sorted;
    const foreign = new Set<string>();
    for (const batch of chunks(sorted, INSPECT_BATCH_SIZE)) {
      const items = await this.inspectBatch(['image', 'inspect', ...batch], 'image');
      items.forEach((item) => {
        const config = isRecord(item) ? item.Config : undefined;
        const owner = toLabels(isRecord(config) ? config.Labels : undefined)[LABEL_ENVIRONMENT_ID];
        const tags = isRecord(item) && Array.isArray(item.RepoTags) ? item.RepoTags.filter((tag): tag is string => typeof tag === 'string') : [];
        if (owner !== environmentId) for (const tag of tags) foreign.add(tag);
      });
    }
    return sorted.filter((image) => !foreign.has(image));
  }

  /** 'missing' if not found; running|restarting|paused → 'running'; created|exited|dead|removing → 'stopped'. */
  // Review round 1 of PR #113 (A-M1): not a call of the bootstrap, so not in BootstrapDocker.
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

  /** `docker stop` (the container gets 10 s to end, then SIGKILL). A missing container is not an error. */
  async stopContainer(nameOrId: string): Promise<void> {
    this.logger.info(`Stopping container ${nameOrId}.`);
    const args = ['stop', nameOrId];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode === 0) return;
    if (this.isMissing(result, 'container')) {
      this.logger.info(`Container ${nameOrId} does not exist.`);
      return;
    }
    throw this.commandError(args, result);
  }

  /**
   * Review round 22 (D22-1): `docker rename`. Throws when the container does not exist or the name is taken.
   */
  async renameContainer(nameOrId: string, newName: string): Promise<void> {
    this.logger.info(`Renaming container ${nameOrId} to ${newName}.`);
    const args = ['rename', nameOrId, newName];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode !== 0) throw this.commandError(args, result);
  }

  /** `docker rm -f`. A missing container is not an error. */
  async removeContainer(nameOrId: string): Promise<void> {
    this.logger.info(`Removing container ${nameOrId}.`);
    const args = ['rm', '-f', nameOrId];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode === 0 || this.isMissing(result, 'container')) return;
    throw this.commandError(args, result);
  }

  /**
   * `docker exec` in a running container. Resolves also for a non-zero exit code. Standard input is attached (`-i`) only
   * when `input` or `secretInput` is given.
   *
   * Plan step 6, PR C (Q4 of 2026-10-01): `secretInput` is a standard input that is a secret (the GitHub token written
   * into the dev container). It goes only through the worker that holds the lock of the environment (`docker exec -i` in
   * the worker, the token as the secret of the operation, masked in what comes back): never as a direct `docker exec`,
   * never in an argument or a variable. Without a held lock, or after the lock was lost, the call is refused
   * (CommandError) and nothing runs (rule D1).
   */
  exec(
    container: string,
    command: readonly string[],
    options: { user?: string; workdir?: string; input?: string; secretInput?: string; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    if (options.input !== undefined && options.secretInput !== undefined) throw new Error('A docker exec has either an input or a secret input.');
    const args = ['exec'];
    if (options.input !== undefined || options.secretInput !== undefined) args.push('-i');
    if (options.user) args.push('-u', options.user);
    if (options.workdir) args.push('-w', options.workdir);
    args.push(container, ...command);
    if (options.secretInput !== undefined) return this.runWithSecretInput(args, options.secretInput, { signal: options.signal, timeoutMs: options.timeoutMs });
    return this.run(args, { input: options.input, signal: options.signal, timeoutMs: options.timeoutMs });
  }

  /** Plan step 6, PR C: see `exec` (`secretInput`). */
  private async runWithSecretInput(args: readonly string[], secretInput: string, options: Pick<RunOptions, 'signal' | 'timeoutMs'>): Promise<RunResult> {
    const command = dockerCommandWords(args).join(' ');
    const held = heldEnvironmentLock();
    if (held === undefined) {
      throw new CommandError(commandText(args), null, '', `docker ${command} with a secret input runs only through the worker that holds the lock of the environment; it was not run.`);
    }
    const lost = held.lostReason();
    if (lost !== undefined) {
      throw new CommandError(commandText(args), null, '', `The lock of the environment on the Docker host was lost (${lost}); docker ${command} was not run.`);
    }
    try {
      return await held.lock.docker(args, { timeoutMs: options.timeoutMs, signal: options.signal, secretInput });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (options.signal?.aborted) throw abortError();
      this.logger.warn(`docker ${command} with a secret input through the worker that holds the lock failed (${errorMessage(error)}); it is not run directly.`);
      if (error instanceof HelperChannelError && (error.code === 'unsendable' || error.code === 'closed')) {
        throw new CommandError(commandText(args), null, '', `docker ${command} was not sent to the worker that holds the lock of the environment (${errorMessage(error)}); it did not run.`);
      }
      throw new CommandError(commandText(args), null, '', `The connection to the worker that holds the lock of the environment failed; the outcome of docker ${command} is not known.`);
    }
  }

  /** Plan step 11B3: `Config` of `docker image inspect` (a typed call instead of runChecked). Throws CommandError. */
  async imageConfig(reference: string, options: Pick<RunOptions, 'timeoutMs' | 'signal'> = {}): Promise<unknown> {
    const inspect = await this.runChecked(['image', 'inspect', '--format', '{{json .Config}}', reference], options);
    return JSON.parse(inspect.trim()) as unknown;
  }

  /**
   * Plan step 11B3: `docker run --rm` of `entrypoint args…` from `image` with `volume` at `target` (a typed call instead
   * of runChecked; volumeRunArgs). Throws CommandError when it fails.
   */
  async runOnVolume(p: VolumeRun, options: Pick<RunOptions, 'timeoutMs' | 'signal'> = {}): Promise<void> {
    await this.runChecked(volumeRunArgs(p), options);
  }

  /**
   * Plan step 11G1: the numeric user and group IDs of `user` in the image `image`, from its `/etc/passwd`
   * (passwdUserIds), or undefined when they cannot be read. This adapter serves only the Docker tests of the pipeline
   * until plan step 11I removes it; it reads the file with a short-lived `docker run` (`cat`, which follows a link),
   * where the worker's EngineDocker reads it through the Engine API without running anything.
   */
  async imageUserIds(image: string, user: string, options: Pick<RunOptions, 'timeoutMs' | 'signal'> = {}): Promise<UserIds | undefined> {
    const result = await this.run(['run', '--rm', '--pull', 'never', '--network', 'none', '--user', 'root', '--entrypoint', 'cat', image, '/etc/passwd'], options);
    return result.exitCode === 0 ? passwdUserIds(result.stdout, user) : undefined;
  }

  /** Plan step 11B3: the full IDs of the containers with the label `label` (`key=value`), stopped ones included. */
  async containerIdsWithLabel(label: string, options: Pick<RunOptions, 'timeoutMs' | 'signal'> = {}): Promise<string[]> {
    const listed = await this.runChecked(['ps', '-aq', '--no-trunc', '--filter', `label=${label}`], options);
    return listed.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  }

  /** True if the volume exists. Throws CommandError if Docker fails for another reason. */
  async volumeExists(name: string): Promise<boolean> {
    const args = ['volume', 'inspect', '--format', '{{json .Name}}', name];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode === 0) return true;
    if (this.isMissing(result, 'volume')) return false;
    throw this.commandError(args, result);
  }

  /** `docker volume create --label k=v … <name>`. Docker keeps an existing volume of this name unchanged. */
  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    this.logger.info(`Creating volume ${name}.`);
    await this.runChecked(['volume', 'create', ...labelArgs(labels, '--label'), name], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
  }

  /** `docker volume rm`. A missing volume is not an error; a volume in use is (CommandError). */
  async removeVolume(name: string): Promise<void> {
    this.logger.info(`Removing volume ${name}.`);
    const args = ['volume', 'rm', name];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode === 0 || this.isMissing(result, 'volume')) return;
    throw this.commandError(args, result);
  }

  /** Volumes with the label nimblescape.devenv.environment-id, with all their labels. */
  async listEnvironmentVolumes(signal?: AbortSignal): Promise<VolumeInfo[]> {
    const listArgs = ['volume', 'ls', '--filter', `label=${LABEL_ENVIRONMENT_ID}`, '--format', '{{json .Name}}'];
    const names = parseJsonLines(await this.runChecked(listArgs, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, signal })).filter(
      (name): name is string => typeof name === 'string' && name !== '',
    );
    // User decision 2026-09-28: a cancellation of the check of the images of the environments ends before the inspect.
    if (signal?.aborted) throw abortError();
    return this.inspectVolumes(names);
  }

  /** The volumes of `names` that exist, with all their labels (`docker volume inspect`); missing ones are left out. */
  async inspectVolumes(names: readonly string[]): Promise<VolumeInfo[]> {
    const volumes: VolumeInfo[] = [];
    for (const batch of chunks([...new Set(names)], INSPECT_BATCH_SIZE)) {
      for (const item of await this.inspectBatch(['volume', 'inspect', ...batch], 'volume')) {
        const volume = toVolumeInfo(item);
        if (volume) volumes.push(volume);
      }
    }
    return volumes;
  }

  /**
   * The networks of `names` that exist, with their labels and the IDs of the containers attached to them
   * (`docker network inspect`); missing ones are left out. Throws CommandError.
   */
  async inspectNetworks(names: readonly string[]): Promise<NetworkInfo[]> {
    const networks: NetworkInfo[] = [];
    for (const batch of chunks([...new Set(names)], INSPECT_BATCH_SIZE)) {
      for (const item of await this.inspectBatch(['network', 'inspect', ...batch], 'network')) {
        const network = toNetworkInfo(item);
        if (network) networks.push(network);
      }
    }
    return networks;
  }

  /**
   * The labels of the local images `references` (one `docker image inspect`), by their full IDs; an image that does not
   * exist is left out (the call fails for every reference then, so they are asked one by one). Throws CommandError when
   * Docker cannot answer, or an AbortError when `signal` aborts.
   */
  async imageLabelsOf(references: readonly string[], signal?: AbortSignal): Promise<Map<string, Record<string, string>>> {
    const labels = new Map<string, Record<string, string>>();
    if (references.length === 0) return labels;
    const format = '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}';
    const read = async (batch: readonly string[]): Promise<RunResult> => {
      const result = await this.run(['image', 'inspect', '--format', format, ...batch], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, signal });
      if (signal?.aborted) throw abortError();
      return result;
    };
    const take = (stdout: string): void => {
      for (const item of parseJsonLines(stdout)) {
        if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') continue;
        labels.set(item.id.toLowerCase(), toLabels(item.labels));
      }
    };
    const all = await read(references);
    if (all.exitCode === 0) {
      take(all.stdout);
      return labels;
    }
    for (const reference of references) {
      const args = ['image', 'inspect', '--format', format, reference];
      const one = await read([reference]);
      if (one.exitCode === 0) take(one.stdout);
      else if (!this.isMissing(one, 'image')) throw this.commandError(args, one);
    }
    return labels;
  }

  /**
   * User decisions 2026-10-03: gives the local image `image` the labels `labels` (the environment ID, its repository and
   * owner, and its build record): `docker build --quiet -t <image> --label k=v… -` with only `FROM <image>` on standard
   * input, a build of metadata without a new layer and without the network (its base is the local image). Docker moves
   * the tag only when the build succeeds. The previous image under the tag is removed after that only when it has no
   * other tag or digest left (best effort; review of PR #88: never another name's image). Throws CommandError when the build fails.
   */
  async labelImage(image: string, labels: Record<string, string>, signal?: AbortSignal): Promise<void> {
    const previous = await this.imageId(image);
    if (previous === undefined) throw new CommandError(commandText(['image', 'inspect', image]), 1, '', `The image ${image} does not exist.`);
    await this.runChecked(['build', '--quiet', '-t', image, ...labelArgs(labels, '--label'), '-'], { input: `FROM ${image}\n`, signal });
    const now = await this.imageId(image);
    if (now === undefined || now === previous) return;
    // Only an image that nothing names any more: `docker image rm <ID>` of an image with one other tag removes that tag
    // too (for example `<project>-<service>` that Docker Compose built, or the base image of an image-only configuration
    // that the Dev Container CLI only tagged).
    try {
      const names = await this.imageNames(previous);
      if (names === undefined || names.repoTags.length > 0 || names.repoDigests.length > 0) return;
      await this.removeImage(previous);
    } catch (error) {
      this.logger.info(`The image ${previous} before the labels of ${image} was not removed: ${errorMessage(error)}`);
    }
  }

  /**
   * The names of the local image that `reference` names (`RepoTags` and `RepoDigests` of `docker image inspect`), or
   * `undefined` if it does not exist (review round 2, S2-05: whether Docker took the reference for an image ID,
   * resolvedByImageId). Throws CommandError for other errors.
   */
  async imageNames(reference: string): Promise<{ repoTags: string[]; repoDigests: string[] } | undefined> {
    const args = ['image', 'inspect', '--format', '{"repoTags":{{json .RepoTags}},"repoDigests":{{json .RepoDigests}}}', reference];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      if (this.isMissing(result, 'image')) return undefined;
      throw this.commandError(args, result);
    }
    const value = parseJsonOutput(result.stdout);
    if (!isRecord(value)) throw this.commandError(args, result, 'Unexpected output of docker image inspect.');
    const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []);
    return { repoTags: texts(value.repoTags), repoDigests: texts(value.repoDigests) };
  }

  /**
   * Review round 9 (S9-3): the ID, tags, and digests of the local images that `references` name, with one `docker image
   * inspect` per IMAGE_INSPECT_BATCH references (not one per reference), in the order that Docker prints them (the
   * order of the references; a missing one is left out). Which reference found which image: imageIdResolvedReferences.
   * Review round 10 (P10-1): when Docker fails for a batch only for missing references (every line of stderr "No such
   * image") and references that it takes for invalid (IMAGE_REFERENCE_ERROR), the references of that batch are
   * inspected one by one; `unchecked` names each one whose own inspect fails for another reason than a missing image,
   * which the caller must not take for a missing image.
   * Review round 11 (G1, G2): each unchecked reference has its reason (ImageUncheckedReason). After the first timeout,
   * or the first failure that is neither a missing nor an invalid reference (a daemon that cannot be reached, an
   * unknown error, an answer that cannot be read, a Docker CLI that cannot be started), of a batch or of a single
   * reference, it asks no more: that reference and all that are not checked yet are `transient`. At most
   * MAX_IMAGE_INSPECT_SINGLE_CALLS single calls; the references beyond are `transient`. `signal` is passed to each call
   * and checked between them. Throws only an AbortError (when `signal` aborts); every other failure is in `unchecked`.
   */
  async inspectImageNames(references: readonly string[], signal?: AbortSignal): Promise<ImageInspection> {
    const images: ImageNames[] = [];
    const unchecked: ImageInspection['unchecked'] = [];
    type Outcome = 'done' | 'invalid' | 'transient';
    const inspect = async (batch: readonly string[]): Promise<Outcome> => {
      if (signal?.aborted) throw abortError();
      const args = ['image', 'inspect', '--format', '{"id":{{json .Id}},"repoTags":{{json .RepoTags}},"repoDigests":{{json .RepoDigests}}}', '--', ...batch];
      let result: RunResult;
      try {
        result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, signal });
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        this.logger.warn(`docker image inspect failed: ${errorMessage(error)}`);
        return 'transient';
      }
      if (result.timedOut) return 'transient';
      if (result.exitCode !== 0 && !this.onlyMissing(result, 'image')) {
        // Only missing and invalid references: which ones are invalid, the single calls tell.
        const errors = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
        const aboutReferences = errors.length > 0 && errors.every((line) => MISSING_PATTERNS.image.test(line) || IMAGE_REFERENCE_ERROR.test(line));
        return aboutReferences && errors.some((line) => IMAGE_REFERENCE_ERROR.test(line)) ? 'invalid' : 'transient';
      }
      const found: ImageNames[] = [];
      const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []);
      for (const value of parseJsonLines(result.stdout)) {
        if (!isRecord(value) || typeof value.id !== 'string') return 'transient';
        found.push({ id: value.id, repoTags: texts(value.repoTags), repoDigests: texts(value.repoDigests) });
      }
      images.push(...found);
      return 'done';
    };
    const giveUp = (from: number): ImageInspection => {
      unchecked.push(...references.slice(from).map((reference) => ({ reference, reason: 'transient' as const })));
      return { images, unchecked };
    };
    let singleCalls = 0;
    for (let start = 0; start < references.length; start += IMAGE_INSPECT_BATCH) {
      const batch = references.slice(start, start + IMAGE_INSPECT_BATCH);
      const outcome = await inspect(batch);
      if (outcome === 'done') continue;
      // A daemon that does not answer (in time) would not answer each reference either.
      if (outcome === 'transient') return giveUp(start);
      if (batch.length === 1) {
        unchecked.push({ reference: batch[0], reason: 'invalid' });
        continue;
      }
      for (let index = 0; index < batch.length; index++) {
        if (singleCalls >= MAX_IMAGE_INSPECT_SINGLE_CALLS) {
          this.logger.warn(`docker image inspect: more than ${MAX_IMAGE_INSPECT_SINGLE_CALLS} references to inspect one by one.`);
          return giveUp(start + index);
        }
        singleCalls++;
        const single = await inspect([batch[index]]);
        if (single === 'transient') return giveUp(start + index);
        if (single === 'invalid') unchecked.push({ reference: batch[index], reason: 'invalid' });
      }
    }
    return { images, unchecked };
  }

  /**
   * User decision 2026-09-28: the named images of the Docker host whose repository starts with `devenv-` (`docker image
   * ls --filter reference=devenv-*`), each image once with its full ID and its references `repository:tag`: the
   * environment images `<environment name>:<build>` and the images that Docker Compose built for an environment
   * (`<environment name>-<service>`; resourceName), whichever computer built them. Throws CommandError, or an AbortError when `signal`
   * aborts.
   */
  async listEnvironmentImages(signal?: AbortSignal): Promise<ImageInfo[]> {
    const args = ['image', 'ls', '--filter', 'reference=devenv-*', '--no-trunc', '--format', '{{json .}}'];
    const stdout = await this.runChecked(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, signal });
    if (signal?.aborted) throw abortError();
    const images = new Map<string, ImageInfo>();
    for (const item of parseJsonLines(stdout)) {
      if (!isRecord(item) || typeof item.ID !== 'string' || item.ID === '') continue;
      const { Repository: repository, Tag: tag } = item;
      if (typeof repository !== 'string' || typeof tag !== 'string' || !repository || !tag || repository === '<none>' || tag === '<none>') continue;
      let image = images.get(item.ID);
      if (!image) {
        image = { id: item.ID, tags: [], createdAt: typeof item.CreatedAt === 'string' ? item.CreatedAt : '' };
        images.set(item.ID, image);
      }
      const reference = `${repository}:${tag}`;
      if (!image.tags.includes(reference)) image.tags.push(reference);
    }
    return [...images.values()];
  }

  /** Tags of a repository, e.g. listImageTags('devenv-3f2a9c1e') → ['devenv-3f2a9c1e:1', 'devenv-3f2a9c1e:2']. Sorted by tag (numbers numerically). */
  async listImageTags(repository: string): Promise<string[]> {
    const stdout = await this.runChecked(['image', 'ls', '--format', '{{json .}}', repository], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    const tags = new Set<string>();
    for (const item of parseJsonLines(stdout)) {
      if (!isRecord(item) || item.Repository !== repository || typeof item.Tag !== 'string') continue;
      if (!item.Tag || item.Tag === '<none>') continue;
      tags.add(item.Tag);
    }
    return [...tags]
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((tag) => `${repository}:${tag}`);
  }

  /**
   * `docker pull`. Output goes to `onOutput` (default: the log). Throws CommandError.
   * With `credentials`, the pull uses them instead of the credentials that Docker has stored, for this pull only: the
   * CLI gets its own config folder with only these credentials (`docker --config`), created with mode 0700 and removed
   * afterwards. The daemon stays the one of the current Docker context (DOCKER_HOST). The secret is never logged.
   * The credentials are sent only over a local or encrypted connection (isProtectedDockerEndpoint); otherwise the call
   * throws UserFacingError('unencryptedDockerConnection') before anything is written or sent.
   */
  async pullImage(
    reference: string,
    options: { onOutput?: (text: string) => void; signal?: AbortSignal; credentials?: RegistryLogin } = {},
  ): Promise<void> {
    const onOutput = options.onOutput ?? ((text: string) => this.logger.output(text));
    const login = options.credentials;
    // Plan step 10A (decision of 2026-10-03): within an operation, the worker pulls over the Engine API.
    const route = this.engineRoute();
    if (route.kind !== 'direct') {
      await this.pullThroughWorker(reference, login, onOutput, options.signal, route);
      return;
    }
    if (!login) {
      this.logger.info(`Pulling image ${reference}.`);
      await this.runChecked(['pull', reference], { signal: options.signal, onStdout: onOutput, onStderr: onOutput });
      return;
    }
    this.logger.info(`Pulling image ${reference} with the credentials for ${login.registry}.`);
    const env = await this.envForOwnConfig(options.signal);
    const host = envValue(env, 'DOCKER_HOST', this.platform);
    if (!isProtectedDockerEndpoint(host, env, this.platform)) {
      throw new UserFacingError(
        'unencryptedDockerConnection',
        Messages.unencryptedDockerConnection,
        `The credentials for ${login.registry} are not sent to the Docker endpoint ${host ?? ''}: it is not local, and TLS is not set up with DOCKER_TLS_VERIFY and DOCKER_CERT_PATH.`,
      );
    }
    const configDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devenv-pull-'));
    try {
      await fs.promises.chmod(configDir, 0o700);
      await fs.promises.writeFile(path.join(configDir, 'config.json'), registryLoginConfig(login), { mode: 0o600, flag: 'wx' });
      await this.runChecked(['--config', configDir, 'pull', reference], {
        signal: options.signal,
        onStdout: onOutput,
        onStderr: onOutput,
        env,
      });
    } finally {
      await fs.promises
        .rm(configDir, { recursive: true, force: true })
        .catch((error: unknown) => this.logger.warn(`The folder ${configDir} could not be removed: ${errorMessage(error)}`));
    }
  }

  /**
   * Plan step 10A (decision of 2026-10-03): the pull of `reference` (with `latest` when it has no tag) by the worker. The
   * credentials are `login`, or else those that Docker has stored on this computer for the registry (storedCredentials);
   * they travel only as the secret of the operation, and only to an engine behind a local socket or SSH (the worker's
   * channel runs over the connection of the operation's engine): `login` to any other engine throws
   * UserFacingError('unencryptedDockerConnection') before anything is sent; stored credentials are then left out.
   */
  private async pullThroughWorker(
    reference: string,
    login: RegistryLogin | undefined,
    onOutput: (text: string) => void,
    signal: AbortSignal | undefined,
    route: Exclude<ReturnType<ContainerAdapter['engineRoute']>, { kind: 'direct' }>,
  ): Promise<void> {
    const target = route.kind === 'worker' ? route.target : operationDockerTarget();
    const protectedEngine = target === undefined || target.kind === 'local' || target.kind === 'remote' || isProtectedDockerEndpoint(target.endpoint, this.env, this.platform);
    if (login !== undefined && !protectedEngine) {
      throw new UserFacingError(
        'unencryptedDockerConnection',
        Messages.unencryptedDockerConnection,
        `The credentials for ${login.registry} are not sent to the Docker endpoint ${target?.endpoint ?? ''}: it is not local, and TLS is not set up with DOCKER_TLS_VERIFY and DOCKER_CERT_PATH.`,
      );
    }
    const pulled = pullReference(reference);
    let credentials: ChannelPullOptions['credentials'];
    if (login !== undefined) {
      credentials = { username: login.username, password: login.password, serveraddress: credentialServerName(login.registry) };
    } else if (protectedEngine && this.storedCredentials !== undefined) {
      const registry = parseImageReference(pulled)?.registry;
      const stored = registry === undefined ? undefined : await this.storedCredentials(registry, signal);
      if (signal?.aborted) throw abortError();
      if (stored !== undefined && registry !== undefined) {
        // Review round 1 of PR #89 (A-R1-3): an identity token of `docker login` goes as such (IDENTITY_TOKEN_USER).
        credentials =
          stored.username === IDENTITY_TOKEN_USER
            ? { identityToken: stored.password, serveraddress: credentialServerName(registry) }
            : { username: stored.username, password: stored.password, serveraddress: credentialServerName(registry) };
      }
    }
    this.logger.info(`Pulling image ${pulled} through the worker${credentials !== undefined ? ` with the credentials for ${credentials.serveraddress}` : ''}.`);
    const options: ChannelPullOptions = { signal, onOutput, ...(credentials !== undefined ? { credentials } : {}) };
    await this.throughWorker(
      `pull ${pulled}`,
      signal,
      route,
      async (lock) => {
        if (lock.pull === undefined) throw new HelperChannelError('unsendable', 'the worker that holds the lock cannot pull images');
        await lock.pull(pulled, options);
      },
      (engine, workerTarget) => engine.pull(workerTarget, pulled, options),
    );
  }

  /**
   * Environment for a call with its own config folder (`docker --config`): that folder has no Docker contexts, so the
   * endpoint of the current context is passed as DOCKER_HOST (for example the socket of Docker Desktop in the home
   * folder). A DOCKER_HOST that is set already stays. When the endpoint cannot be read, the default endpoint is used.
   */
  private async envForOwnConfig(signal: AbortSignal | undefined): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...this.operationEnv() };
    if (!envValue(env, 'DOCKER_HOST', this.platform)) {
      const args = ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'];
      const result = await this.run(args, { signal, timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
      const host = result.exitCode === 0 ? parseJsonOutput(result.stdout) : undefined;
      if (typeof host === 'string' && host !== '') {
        env.DOCKER_HOST = host;
      } else {
        this.logger.info(`The endpoint of the Docker context could not be read. The default endpoint is used: ${result.stderr.trim()}`);
      }
    }
    // The context of DOCKER_CONTEXT does not exist in the new config folder.
    deleteEnv(env, 'DOCKER_CONTEXT');
    return env;
  }

  /** Labels of a local image (`{}` if it has none), or `undefined` if the image does not exist. */
  async imageLabels(reference: string): Promise<Record<string, string> | undefined> {
    const args = ['image', 'inspect', '--format', '{{json .Config.Labels}}', reference];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      if (this.isMissing(result, 'image')) return undefined;
      throw this.commandError(args, result);
    }
    return toLabels(parseJsonOutput(result.stdout));
  }

  private async containerIds(filter: string): Promise<string[]> {
    const args = ['ps', '-a', '--no-trunc', '--filter', filter, '--format', '{{json .ID}}'];
    const stdout = await this.runChecked(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    const ids = parseJsonLines(stdout).filter((id): id is string => typeof id === 'string' && id !== '');
    return [...new Set(ids)];
  }

  private async inspectContainers(ids: readonly string[]): Promise<InspectedContainer[]> {
    const containers: InspectedContainer[] = [];
    for (const batch of chunks(ids, INSPECT_BATCH_SIZE)) {
      for (const item of await this.inspectBatch(['container', 'inspect', ...batch], 'container')) {
        const container = toContainerInfo(item);
        if (container) containers.push(container);
      }
    }
    return containers;
  }

  /**
   * Runs `docker … inspect` for several objects. An object that was removed after the list call is skipped: Docker then
   * prints the others on stdout and "No such …" on stderr, with exit code 1.
   */
  private async inspectBatch(args: readonly string[], kind: ObjectKind): Promise<unknown[]> {
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    const items = parseInspectArray(result.stdout);
    if (result.exitCode !== 0 && !this.onlyMissing(result, kind)) throw this.commandError(args, result);
    if (!items) throw this.commandError(args, result, `Unexpected output of docker ${kind} inspect.`);
    return items;
  }

}
