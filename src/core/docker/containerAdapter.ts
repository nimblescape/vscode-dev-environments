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
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID } from '../names';
import {
  abortError,
  isAbortError,
  systemClock,
  type Clock,
  type Credentials,
  type Logger,
  type ProcessRunner,
  type RunOptions,
  type RunResult,
} from '../ports';
import type { ContainerState } from '../types';
import { dockerProcessEnv, envValue } from './dockerCli';

export interface ContainerInfo {
  id: string;
  /** Without the leading '/'. */
  name: string;
  state: ContainerState;
  /** `State.Status` of `docker inspect`, for example `exited`. */
  rawState: string;
  labels: Record<string, string>;
  /** Image reference that the container was created from (`Config.Image`), for example `devenv-3f2a9c1e:2`. */
  image: string;
  /** Names of the named volumes that the container mounts (`Mounts` with `Type` volume). */
  volumes?: string[];
  /**
   * Review round 11 (G3, G4): the subpaths of named volumes that the container mounts (`HostConfig.Mounts`, and
   * `Mounts`, with `Type` volume and `VolumeOptions.Subpath`), as Docker Compose creates them for a bind mount of
   * repository files that the pipeline rewrote to the workspace volume.
   */
  volumeSubpaths?: VolumeSubpathMount[];
  /**
   * Review round 12 (D12-2): the targets of the mounts of the container in it (`Mounts`: volumes, bind mounts, tmpfs;
   * and the tmpfs of `HostConfig.Tmpfs`), for the ownership fix in the dev container (devMountFolders).
   */
  mountTargets?: MountTarget[];
}

/** Review round 12 (D12-2): a mount of a container (ContainerInfo.mountTargets). */
export interface MountTarget {
  /** `volume`, `bind`, `tmpfs`, … */
  type: string;
  /** The name of a named volume. */
  volume?: string;
  /** The path in the container (`Destination`). */
  target: string;
  /**
   * Review round 14 (P14-1): the subpath of a named volume (`VolumeOptions.Subpath` of the entry of `HostConfig.Mounts`
   * with the same volume and target; the top-level `Mounts` do not have it). Missing: the whole volume, or not known.
   */
  subpath?: string;
}

/** Review round 11 (G3, G4): a mount of a subpath of a named volume (ContainerInfo.volumeSubpaths). */
export interface VolumeSubpathMount {
  volume: string;
  /** Relative to the root of the volume, as Docker has it (for example `api/data/postgres`). */
  subpath: string;
  readOnly: boolean;
}

export interface VolumeInfo {
  name: string;
  labels: Record<string, string>;
}

/** A network of `docker network inspect`. */
export interface NetworkInfo {
  name: string;
  /** The full ID of the network (review round 2, S2-04: a configuration may name a network by its ID or a prefix). */
  id: string;
  labels: Record<string, string>;
  /** The IDs of the containers attached to it. */
  containers: string[];
}

/** A local image of `docker image ls`. */
export interface ImageInfo {
  /** Full image ID, for example `sha256:7a83…`. */
  id: string;
  /** References `repository:tag`; empty for a dangling image. */
  tags: string[];
  /** Creation time as Docker prints it, for example `2026-09-25 02:31:55 +0200 CEST`. */
  createdAt: string;
}

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
/** Number of IDs per `docker inspect` call (command line length on Windows). */
const INSPECT_BATCH_SIZE = 50;
/**
 * A missing Docker CLI is looked up again at most this often (with `findDocker`), so that Docker Desktop installed or
 * updated while VS Code runs is found without a reload.
 */
export const DOCKER_CLI_LOOKUP_RETRY_MS = 10_000;

/** Credentials of one registry for one `docker pull` (for example the GitHub session for ghcr.io). */
export interface RegistryLogin extends Credentials {
  /** Registry host, for example `ghcr.io`. */
  registry: string;
}

export interface ContainerAdapterOptions {
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
}

type ObjectKind = 'container' | 'volume' | 'image' | 'network';

const MISSING_PATTERNS: Record<ObjectKind, RegExp> = {
  container: /no such (container|object)/i,
  volume: /no such (volume|object)/i,
  image: /no such (image|object)/i,
  network: /no such (network|object)|network \S+ not found/i,
};

/** Label that Docker Compose gives each container, network, and volume of a project. */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/** Docker refuses to remove an image that a container or another image uses. */
const IMAGE_IN_USE_PATTERN = /conflict|in use|being used|is using|dependent child images/i;

/**
 * Maps `State.Status` to the simplified state: running|restarting|paused → 'running';
 * created|exited|dead|removing (and unknown values) → 'stopped'.
 */
export function mapContainerState(rawState: string): ContainerState {
  switch (rawState.toLowerCase()) {
    case 'running':
    case 'restarting':
    case 'paused':
      return 'running';
    default:
      return 'stopped';
  }
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Labels object of `docker inspect` (may be `null`). Values that are not strings are ignored. */
export function toLabels(value: unknown): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!isRecord(value)) return labels;
  for (const [key, labelValue] of Object.entries(value)) {
    if (typeof labelValue === 'string') labels[key] = labelValue;
  }
  return labels;
}

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

/** Parses the output of `--format '{{json .X}}'` for a single object. */
function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

interface InspectedContainer extends ContainerInfo {
  created: string;
}

function toContainerInfo(value: unknown): InspectedContainer | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.Id;
  const name = value.Name;
  const state = value.State;
  const config = value.Config;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !isRecord(state) || typeof state.Status !== 'string') {
    return undefined;
  }
  const image = isRecord(config) && typeof config.Image === 'string' ? config.Image : '';
  return {
    id,
    name: name.replace(/^\//, ''),
    state: mapContainerState(state.Status),
    rawState: state.Status,
    labels: toLabels(isRecord(config) ? config.Labels : undefined),
    image,
    volumes: mountedVolumes(value.Mounts),
    volumeSubpaths: volumeSubpathMounts([
      ...(Array.isArray(value.Mounts) ? value.Mounts : []),
      ...(isRecord(value.HostConfig) && Array.isArray(value.HostConfig.Mounts) ? value.HostConfig.Mounts : []),
    ]),
    mountTargets: mountTargets(
      value.Mounts,
      isRecord(value.HostConfig) ? value.HostConfig.Tmpfs : undefined,
      isRecord(value.HostConfig) ? value.HostConfig.Mounts : undefined,
    ),
    created: typeof value.Created === 'string' ? value.Created : '',
  };
}

/** A target path as Docker compares it: normalized, without a trailing slash. */
function cleanTarget(target: string): string {
  const normal = path.posix.normalize(target);
  return normal.length > 1 ? normal.replace(/\/+$/, '') : normal;
}

/**
 * Review round 12 (D12-2): the mounts of `docker container inspect` with their targets (ContainerInfo.mountTargets).
 * Review round 14 (P14-1): a volume mount with the subpath of the entry of `HostConfig.Mounts` (`hostMounts`) with the
 * same volume (`Source`) and target; with more than one such entry of different subpaths, none (not known).
 */
function mountTargets(mounts: unknown, tmpfs: unknown, hostMounts: unknown): MountTarget[] {
  const subpaths = new Map<string, string | null>();
  for (const mount of Array.isArray(hostMounts) ? hostMounts : []) {
    if (!isRecord(mount) || mount.Type !== 'volume' || typeof mount.Target !== 'string' || !mount.Target.startsWith('/')) continue;
    if (typeof mount.Source !== 'string' || mount.Source === '' || !isRecord(mount.VolumeOptions)) continue;
    const subpath = mount.VolumeOptions.Subpath;
    if (typeof subpath !== 'string' || subpath === '') continue;
    const key = `${mount.Source}\0${cleanTarget(mount.Target)}`;
    subpaths.set(key, subpaths.has(key) && subpaths.get(key) !== subpath ? null : subpath);
  }
  const result: MountTarget[] = [];
  for (const mount of Array.isArray(mounts) ? mounts : []) {
    if (!isRecord(mount) || typeof mount.Destination !== 'string' || mount.Destination === '' || typeof mount.Type !== 'string') continue;
    const volume = mount.Type === 'volume' && typeof mount.Name === 'string' && mount.Name !== '' ? mount.Name : undefined;
    const subpath = volume !== undefined && mount.Destination.startsWith('/') ? subpaths.get(`${volume}\0${cleanTarget(mount.Destination)}`) : undefined;
    result.push({ type: mount.Type, ...(volume !== undefined ? { volume } : {}), target: mount.Destination, ...(typeof subpath === 'string' ? { subpath } : {}) });
  }
  if (isRecord(tmpfs)) for (const target of Object.keys(tmpfs)) if (target !== '') result.push({ type: 'tmpfs', target });
  return result;
}

function mountedVolumes(mounts: unknown): string[] {
  if (!Array.isArray(mounts)) return [];
  return mounts
    .filter((mount): mount is Record<string, unknown> => isRecord(mount) && mount.Type === 'volume' && typeof mount.Name === 'string' && mount.Name !== '')
    .map((mount) => mount.Name as string);
}

/**
 * Review round 11 (G3, G4): the volume mounts with a subpath of `docker container inspect` (`HostConfig.Mounts` has
 * `Source`, the name of the volume; `Mounts` has `Name`), without duplicates.
 */
function volumeSubpathMounts(mounts: readonly unknown[]): VolumeSubpathMount[] {
  const result = new Map<string, VolumeSubpathMount>();
  for (const mount of mounts) {
    if (!isRecord(mount) || mount.Type !== 'volume' || !isRecord(mount.VolumeOptions)) continue;
    const subpath = mount.VolumeOptions.Subpath;
    const volume = typeof mount.Name === 'string' && mount.Name !== '' ? mount.Name : mount.Source;
    if (typeof subpath !== 'string' || subpath === '' || typeof volume !== 'string' || volume === '') continue;
    const readOnly = mount.ReadOnly === true || mount.RW === false;
    const key = `${volume}\0${subpath}\0${readOnly}`;
    if (!result.has(key)) result.set(key, { volume, subpath, readOnly });
  }
  return [...result.values()];
}

function toVolumeInfo(value: unknown): VolumeInfo | undefined {
  if (!isRecord(value) || typeof value.Name !== 'string' || !value.Name) return undefined;
  return { name: value.Name, labels: toLabels(value.Labels) };
}

function toNetworkInfo(value: unknown): NetworkInfo | undefined {
  if (!isRecord(value) || typeof value.Name !== 'string' || !value.Name) return undefined;
  const containers = isRecord(value.Containers) ? Object.keys(value.Containers) : [];
  return { name: value.Name, id: typeof value.Id === 'string' ? value.Id : '', labels: toLabels(value.Labels), containers };
}

/**
 * Whether a container of an environment is its dev container (findContainer): without the label devenv.compose-service
 * of the other services of Docker Compose, or with the name of the environment.
 */
export function isDevContainer(container: Pick<ContainerInfo, 'name' | 'labels'>, containerName: string): boolean {
  return container.labels[LABEL_COMPOSE_SERVICE] === undefined || container.name === containerName;
}

function publicInfo(container: InspectedContainer): ContainerInfo {
  const { id, name, state, rawState, labels, image, volumes, volumeSubpaths, mountTargets } = container;
  return {
    id,
    name,
    state,
    rawState,
    labels,
    image,
    ...(volumes && volumes.length > 0 ? { volumes } : {}),
    ...(volumeSubpaths && volumeSubpaths.length > 0 ? { volumeSubpaths } : {}),
    ...(mountTargets && mountTargets.length > 0 ? { mountTargets } : {}),
  };
}

/** Newest first; a running container before a stopped one. */
function preferred(a: InspectedContainer, b: InspectedContainer): number {
  if (a.state !== b.state) return a.state === 'running' ? -1 : 1;
  return b.created.localeCompare(a.created);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/** Options of `docker run` / `docker exec` whose `NAME=value` can hold a secret (for example a `${localEnv:…}` token). */
const ENV_FLAGS = new Set(['-e', '--env']);

function redactEnv(assignment: string): string {
  const index = assignment.indexOf('=');
  return index < 0 ? assignment : `${assignment.slice(0, index)}=***`;
}

/** Command for error messages, which end up in the log: values of environment variables are hidden. */
function commandText(args: readonly string[]): string {
  const shown = args.map((arg, index) => {
    if (index > 0 && ENV_FLAGS.has(args[index - 1])) return redactEnv(arg);
    if (arg.startsWith('--env=')) return `--env=${redactEnv(arg.slice('--env='.length))}`;
    return arg;
  });
  const text = `docker ${shown.join(' ')}`;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
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

/** Removes a variable in every spelling of its name (names are case-insensitive on Windows). */
function deleteEnv(env: NodeJS.ProcessEnv, name: string): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name) delete env[key];
  }
}

function labelArgs(labels: Record<string, string> | undefined, flag: string): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(labels ?? {})) args.push(flag, `${key}=${value}`);
  return args;
}

export class ContainerAdapter {
  private path: string | undefined;
  private env: NodeJS.ProcessEnv;
  private readonly rawEnv: NodeJS.ProcessEnv;
  private readonly findDocker: ContainerAdapterOptions['findDocker'];
  private readonly clock: Clock;
  private readonly onDaemonStatus: ContainerAdapterOptions['onDaemonStatus'];
  private readonly onCliLost: ContainerAdapterOptions['onCliLost'];
  private lookedUpAt: number | undefined;

  /**
   * @param dockerPath Full path of the Docker CLI (see `findDockerCli`), or `undefined` if Docker is not installed.
   * @param env Process environment for Docker calls. The adapter applies `dockerProcessEnv` to it (idempotent), so that
   *   credential helpers and CLI plugins are found also with a short PATH.
   * @param platform Only for tests. Default: the platform of this process.
   * @param options `findDocker`: look the CLI up again while it is missing (see ContainerAdapterOptions).
   */
  constructor(
    private readonly runner: ProcessRunner,
    dockerPath: string | undefined,
    env: NodeJS.ProcessEnv,
    private readonly logger: Logger,
    private readonly platform: NodeJS.Platform = process.platform,
    options: ContainerAdapterOptions = {},
  ) {
    this.path = dockerPath;
    this.rawEnv = env;
    this.env = dockerProcessEnv(env, platform, dockerPath);
    this.findDocker = options.findDocker;
    this.clock = options.clock ?? systemClock;
    this.onDaemonStatus = options.onDaemonStatus;
    this.onCliLost = options.onCliLost;
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
   * Raw call. Resolves also for a non-zero exit code. Throws UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled)
   * without a CLI, or when the CLI cannot be started anymore (removed after it was found).
   */
  async run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.lookUpCliIfMissing();
    const dockerPath = this.path;
    if (dockerPath === undefined) throw new UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled);
    try {
      return await this.runner.run(dockerPath, args, { ...options, env: options.env ?? this.env });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        if (this.findDocker && this.path === dockerPath) {
          // For example while Docker Desktop updates itself: the next call looks for the CLI again (unless `onCliLost`
          // looks it up first, see ContainerAdapterOptions).
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
   * True if the Docker CLI was found. With `findDocker`, a missing CLI is looked up again now, without the waiting time
   * of `isInstalled` (after an installation was started, the CLI is looked up more often).
   */
  lookUpCliNow(): boolean {
    this.lookUpCliIfMissing(true);
    return this.path !== undefined;
  }

  private reportCliLost(): void {
    try {
      this.onCliLost?.();
    } catch (error) {
      this.logger.warn(`The lost Docker CLI could not be reported: ${errorMessage(error)}`);
    }
  }

  /** With `findDocker`: looks for a missing CLI again, at most every DOCKER_CLI_LOOKUP_RETRY_MS unless `force` is set. */
  private lookUpCliIfMissing(force = false): void {
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

  private async queryDaemonStatus(signal: AbortSignal | undefined, timeoutMs: number): Promise<DaemonStatus> {
    if (!this.isInstalled()) return { running: false, detail: 'The Docker CLI was not found.' };
    let result: RunResult;
    try {
      result = await this.run(['info', '--format', '{{json .ServerVersion}}'], { signal, timeoutMs });
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

  /**
   * The container with the label devenv.environment-id=<id>. If there are several, a running one, then the newest. The
   * other services of a Docker Compose environment carry the label too, with devenv.compose-service: they are skipped,
   * so this is always the dev container. A container with the name of the environment (`containerName`, the name of
   * the dev container) is never skipped, whatever labels its image gave it (review round 1, D2: an image with the label
   * devenv.compose-service would hide a single container, which then kept running after the checks were turned on).
   * That container comes first (final review, FC-1: the previous dev container of a Select configuration…, renamed and
   * without devenv.compose-service, or a stray container of the environment never wins over it); without it (an older
   * container, a failed switch), a running one, then the newest.
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

  /** All containers with the label devenv.environment-id, running or not. */
  async listEnvironmentContainers(): Promise<ContainerInfo[]> {
    const containers = await this.inspectContainers(await this.containerIds(`label=${LABEL_ENVIRONMENT_ID}`));
    return containers.map(publicInfo);
  }

  /**
   * All containers of the Docker Compose project `project` (label com.docker.compose.project), running or not, also
   * those without the label devenv.environment-id (for example one-off containers of `docker compose run`).
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
   * `repository:tag` (`docker image ls --filter reference=<project>-*`). With `environmentId`, an image whose label
   * devenv.environment-id names another environment is left out (review round 1, D3). Throws CommandError.
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
        if (owner !== undefined && owner !== environmentId) for (const tag of tags) foreign.add(tag);
      });
    }
    return sorted.filter((image) => !foreign.has(image));
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
   * when `input` is given.
   */
  exec(
    container: string,
    command: readonly string[],
    options: { user?: string; workdir?: string; input?: string; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    const args = ['exec'];
    if (options.input !== undefined) args.push('-i');
    if (options.user) args.push('-u', options.user);
    if (options.workdir) args.push('-w', options.workdir);
    args.push(container, ...command);
    return this.run(args, { input: options.input, signal: options.signal, timeoutMs: options.timeoutMs });
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

  /** Volumes with the label devenv.environment-id, with all their labels. */
  async listEnvironmentVolumes(): Promise<VolumeInfo[]> {
    const listArgs = ['volume', 'ls', '--filter', `label=${LABEL_ENVIRONMENT_ID}`, '--format', '{{json .Name}}'];
    const names = parseJsonLines(await this.runChecked(listArgs, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS })).filter(
      (name): name is string => typeof name === 'string' && name !== '',
    );
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
   * Local images with a label (`docker image ls --filter label=<label> --no-trunc`, then the same with
   * `--filter dangling=true`), for example `devenv.helper=true`. Dangling images are included, with no tags. One entry
   * per image ID, with all its tags. Throws CommandError.
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
   * Environment for a call with its own config folder (`docker --config`): that folder has no Docker contexts, so the
   * endpoint of the current context is passed as DOCKER_HOST (for example the socket of Docker Desktop in the home
   * folder). A DOCKER_HOST that is set already stays. When the endpoint cannot be read, the default endpoint is used.
   */
  private async envForOwnConfig(signal: AbortSignal | undefined): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...this.env };
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

  /**
   * `docker build -t <tag> -f <dockerfile> [--pull] [--no-cache] [--label k=v]… [--build-arg k=v]… <context>`.
   * `pull`: pull the base images even if they exist locally; `noCache`: build every step again. Docker moves the tag
   * only when the build succeeds. Throws CommandError.
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
  }): Promise<void> {
    const flags = [...(options.pull ? ['--pull'] : []), ...(options.noCache ? ['--no-cache'] : [])];
    this.logger.info(`Building image ${options.tag}${flags.length > 0 ? ` (${flags.join(' ')})` : ''}.`);
    const onOutput = options.onOutput ?? ((text: string) => this.logger.output(text));
    const args = [
      'build',
      '-t',
      options.tag,
      '-f',
      options.dockerfile,
      ...flags,
      ...labelArgs(options.labels, '--label'),
      ...labelArgs(options.buildArgs, '--build-arg'),
      options.context,
    ];
    await this.runChecked(args, { signal: options.signal, onStdout: onOutput, onStderr: onOutput });
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

  /**
   * Review round 10 (P10-1): whether a failed command failed only for missing objects: every line of its (end of) stderr
   * says so. Unlike isMissing, one "No such …" among other errors is not enough.
   */
  private onlyMissing(result: RunResult, kind: ObjectKind): boolean {
    if (result.timedOut || result.exitCode === 0) return false;
    const errors = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
    return errors.length > 0 && errors.every((line) => MISSING_PATTERNS[kind].test(line));
  }

  private isMissing(result: RunResult, kind: ObjectKind): boolean {
    return !result.timedOut && result.exitCode !== 0 && MISSING_PATTERNS[kind].test(result.stderr);
  }

  private commandError(args: readonly string[], result: RunResult, note?: string): CommandError {
    const notes = [result.timedOut ? 'The command did not end within the time limit.' : undefined, note].filter(Boolean);
    const stderr = notes.length > 0 ? `${result.stderr.trimEnd()}\n${notes.join('\n')}`.trim() : result.stderr;
    return new CommandError(commandText(args), result.exitCode, result.stdout, stderr);
  }
}
