// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// In-memory fakes for the tests of the environment service: Docker, workspace helper, image check, and user interface.
// The registry and the session files are the real ones, in a temporary folder. Only test files import this module.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDevContainer, type ContainerInfo, type NetworkInfo, type VolumeInfo } from '../docker/containerAdapter';
import { CommandError } from '../errors';
import { COMPOSE_MODEL_PATH, type ComposeModel, type ComposeModelOutput } from '../helper/compose';
import { checkConfiguration } from '../helper/configChecks';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import type { CheckOutcome, ConfigReferences } from '../imageCheck/imageCheck';
import { parseJsonc } from '../jsonc';
import type { ProgressStep } from '../messages';
import {
  CONTAINER_VERSION,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_VERSION,
  LABEL_ENVIRONMENT_ID,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  LABEL_VOLUME,
  VOLUME_KIND_ADDITIONAL,
  environmentImageName,
  resourceName,
} from '../names';
import { abortError, type Clock, type Logger, type PipelineUi, type ProgressReporter, type RunResult } from '../ports';
import { StoragePaths } from '../storage/paths';
import { EnvironmentRegistry } from '../storage/registry';
import { SessionFiles } from '../storage/sessionFiles';
import type {
  BuildRecord,
  ContainerState,
  DevcontainerConfig,
  DevcontainerResult,
  Environment,
  ExtensionSettings,
  GitHubAccount,
  GitSummary,
} from '../types';
import {
  EnvironmentService,
  type DockerStarter,
  type EnvironmentDocker,
  type EnvironmentHelper,
  type EnvironmentServiceDeps,
} from './environmentService';
import { DEFAULT_CONFIG_PATH, configHash } from './pipelineRules';
import type { PullCredentials } from './pullCredentials';

export const REPO = 'acme/api';
export const ENV_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
export const OTHER_ID = '7c1d2e3f-0000-4000-8000-000000000002';
export const BASE_IMAGE = 'mcr.microsoft.com/devcontainers/base:ubuntu';
export const FEATURE = 'ghcr.io/devcontainers/features/node:1';
export const DIGEST_OLD = `sha256:${'a'.repeat(64)}`;
export const DIGEST_NEW = `sha256:${'b'.repeat(64)}`;
export const FEATURE_DIGEST = `sha256:${'c'.repeat(64)}`;
export const TOKEN = 'gho_testtoken';
/** The signed-in account of the harness; seeded environments belong to it. */
export const ACCOUNT: GitHubAccount = { id: '1001', login: 'octo' };
export const OTHER_ACCOUNT: GitHubAccount = { id: '2002', login: 'someone' };
export const WINDOW_ID = 'window-1';
export const PID = 4242;
export const T0 = Date.parse('2026-09-24T15:40:00.000Z');
/**
 * The labels of Docker Compose with empty values that the override configuration of a single container adds after its
 * own labels (review round 2, D2-1): the expectations of the runArgs name them.
 */
export const CLEARED_COMPOSE_LABELS: readonly string[] = ['--label', 'com.docker.compose.project=', '--label', 'com.docker.compose.service='];
/** Review round 4 (D4-2): the label devenv.config-path of the override configuration, for the default configuration. */
export const CONFIG_PATH_LABEL: readonly string[] = ['--label', 'devenv.config-path=.devcontainer/devcontainer.json'];

export const DEFAULT_CONFIG_TEXT = `{
  // test configuration
  "image": "${BASE_IMAGE}",
  "features": { "${FEATURE}": {} },
  "remoteUser": "vscode"
}`;

export const DEFAULT_SETTINGS: ExtensionSettings = {
  reopenLastOnStartup: true,
  stopOnClose: true,
  waitingTimeSeconds: 30,
  updateImagesOnConnect: true,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: true,
  refreshIntervalMinutes: 60,
  hostAccessChecksOff: [],
};

// ---------------------------------------------------------------------------------------------------------------------
// Docker

export class FakeDocker implements EnvironmentDocker {
  running = true;
  readonly containers = new Map<string, ContainerInfo>();
  readonly volumes = new Map<string, Record<string, string>>();
  readonly images = new Set<string>();
  /** Image IDs of references that name one image (a tag and a digest reference). Default: an image per reference. */
  readonly imageIds = new Map<string, string>();
  /** Changing calls, in order: `pull x`, `rm x`, `rmi x`, `stop x`, `volume create x`, `volume rm x`, `start x`. */
  readonly log: string[] = [];
  readonly execs: Array<{ container: string; command: readonly string[]; user?: string; signal?: AbortSignal }> = [];
  /** Each `docker pull`, with the credentials that it got instead of those of Docker. */
  readonly pulls: Array<{ reference: string; credentials?: PullCredentials }> = [];
  pullError: (reference: string, credentials?: PullCredentials) => Error | undefined = () => undefined;
  execHandler: (container: string, command: readonly string[], user?: string) => Partial<RunResult> = () => ({});
  /** Volumes that `docker volume rm` refuses to remove. */
  readonly volumesInUse = new Set<string>();
  /** The names of each `docker volume inspect` (inspectVolumes). */
  readonly volumeInspections: string[][] = [];
  /** `Config` of `docker image inspect` per image. Default: no labels, no user. */
  readonly imageConfigs = new Map<string, { User?: string; Labels?: Record<string, string> }>();
  /** `docker run` calls: the image and the arguments after it. */
  readonly runs: Array<{ image: string; args: readonly string[]; all: readonly string[] }> = [];
  runError: Maybe<Error>;
  /** The API version of the Docker Engine (engineApiVersion). `undefined`: the engine does not tell it. */
  apiVersion: string | undefined = '1.48';
  /** Networks by name, with their labels (Docker Compose creates them for a project). */
  readonly networks = new Map<string, Record<string, string>>();
  private counter = 0;

  async listProjectContainers(project: string): Promise<ContainerInfo[]> {
    return [...this.containers.values()]
      .filter((c) => c.labels['com.docker.compose.project'] === project)
      .map((c) => ({ ...c, labels: { ...c.labels } }));
  }

  async listProjectNetworks(project: string): Promise<string[]> {
    return [...this.networks.entries()].filter(([, labels]) => labels['com.docker.compose.project'] === project).map(([name]) => name);
  }

  /** The IDs of the containers attached to each network of `networks` (inspectNetworks). */
  readonly networkContainers = new Map<string, string[]>();
  /** The names of each `docker network inspect` (inspectNetworks). */
  readonly networkInspections: string[][] = [];

  /** The ID of each network of `networks` by name. Default: `<name>-id` (hexadecimal enough for a test). */
  readonly networkIds = new Map<string, string>();

  networkId(name: string): string {
    return this.networkIds.get(name) ?? `${name}-id`;
  }

  /** Like `docker network inspect`: each reference by its full ID, its name, or a unique prefix of its ID. */
  async inspectNetworks(names: readonly string[]): Promise<NetworkInfo[]> {
    this.networkInspections.push([...names]);
    const found = new Map<string, NetworkInfo>();
    for (const reference of new Set(names)) {
      const all = [...this.networks.keys()];
      const byId = all.find((name) => this.networkId(name) === reference);
      const prefixed = all.filter((name) => this.networkId(name).startsWith(reference));
      const name = byId ?? (this.networks.has(reference) ? reference : prefixed.length === 1 ? prefixed[0] : undefined);
      if (name === undefined) continue;
      found.set(name, { name, id: this.networkId(name), labels: { ...this.networks.get(name) }, containers: [...(this.networkContainers.get(name) ?? [])] });
    }
    return [...found.values()];
  }

  async removeNetwork(name: string): Promise<void> {
    this.log.push(`network rm ${name}`);
    this.networks.delete(name);
  }

  async listProjectImages(project: string, environmentId?: string): Promise<string[]> {
    const owner = (image: string): string | undefined => this.imageConfigs.get(image)?.Labels?.[LABEL_ENVIRONMENT_ID];
    return [...this.images]
      .filter((image) => image.startsWith(`${project}-`))
      .filter((image) => environmentId === undefined || owner(image) === undefined || owner(image) === environmentId)
      .sort();
  }

  async engineApiVersion(): Promise<string | undefined> {
    return this.apiVersion;
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  async runChecked(args: readonly string[]): Promise<string> {
    if (args[0] === 'image' && args[1] === 'inspect') {
      const reference = args[args.length - 1];
      if (!this.images.has(reference)) throw new CommandError(`docker ${args.join(' ')}`, 1, '', `Error: No such image: ${reference}`);
      return `${JSON.stringify(this.imageConfigs.get(reference) ?? { User: '', Labels: {} })}\n`;
    }
    if (args[0] === 'run') {
      const index = args.indexOf('--mount') + 2;
      const image = args[index];
      this.log.push(`run ${image}`);
      this.runs.push({ image, args: args.slice(index + 1), all: args });
      if (!this.images.has(image)) throw new CommandError('docker run', 125, '', `Unable to find image '${image}' locally`);
      if (this.runError) throw this.runError;
      return '';
    }
    this.log.push(args.join(' '));
    if (args[0] === 'start') {
      const container = this.containerByRef(args[1]);
      if (!container) throw new CommandError(`docker start ${args[1]}`, 1, '', 'No such container');
      container.state = 'running';
      container.rawState = 'running';
    }
    return '';
  }

  /** Like ContainerAdapter.findContainer: the other services of a Docker Compose environment are skipped. */
  async findContainer(environmentId: string, containerName: string): Promise<ContainerInfo | undefined> {
    const matching = [...this.containers.values()].filter(
      (c) => c.labels[LABEL_ENVIRONMENT_ID] === environmentId && isDevContainer(c, containerName),
    );
    const found = matching.find((c) => c.state === 'running') ?? matching[matching.length - 1];
    return found && { ...found, labels: { ...found.labels } };
  }

  async listEnvironmentContainers(): Promise<ContainerInfo[]> {
    return [...this.containers.values()]
      .filter((c) => LABEL_ENVIRONMENT_ID in c.labels)
      .map((c) => ({ ...c, labels: { ...c.labels } }));
  }

  async removeContainer(nameOrId: string): Promise<void> {
    this.log.push(`rm ${nameOrId}`);
    const container = this.containerByRef(nameOrId);
    if (container) this.containers.delete(container.id);
  }

  async stopContainer(nameOrId: string): Promise<void> {
    this.log.push(`stop ${nameOrId}`);
    const container = this.containerByRef(nameOrId);
    if (container) {
      container.state = 'stopped';
      container.rawState = 'exited';
    }
  }

  async exec(
    container: string,
    command: readonly string[],
    options: { user?: string; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    this.execs.push({ container, command, user: options.user, signal: options.signal });
    const result: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...this.execHandler(container, command, options.user) };
    // Like the process runner: an abort during the call kills the process and rejects.
    if (options.signal?.aborted) throw abortError();
    return result;
  }

  async volumeExists(name: string): Promise<boolean> {
    return this.volumes.has(name);
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    this.log.push(`volume create ${name}`);
    if (!this.volumes.has(name)) this.volumes.set(name, { ...labels });
  }

  async removeVolume(name: string): Promise<void> {
    this.log.push(`volume rm ${name}`);
    if (this.volumesInUse.has(name)) throw new CommandError(`docker volume rm ${name}`, 1, '', 'volume is in use');
    this.volumes.delete(name);
  }

  async listEnvironmentVolumes(): Promise<VolumeInfo[]> {
    return [...this.volumes.entries()]
      .filter(([, labels]) => LABEL_ENVIRONMENT_ID in labels)
      .map(([name, labels]) => ({ name, labels: { ...labels } }));
  }

  async inspectVolumes(names: readonly string[]): Promise<VolumeInfo[]> {
    this.volumeInspections.push([...names]);
    return [...new Set(names)].filter((name) => this.volumes.has(name)).map((name) => ({ name, labels: { ...this.volumes.get(name) } }));
  }

  /** The tags and digests of an image (imageNames), where they differ from the reference itself (an ID prefix). */
  readonly imageRepoNames = new Map<string, { repoTags: string[]; repoDigests: string[] }>();

  async imageNames(reference: string): Promise<{ repoTags: string[]; repoDigests: string[] } | undefined> {
    if (!this.images.has(reference)) return undefined;
    return this.imageRepoNames.get(reference) ?? (reference.includes('@') ? { repoTags: [], repoDigests: [reference] } : { repoTags: [reference], repoDigests: [] });
  }

  async imageExists(reference: string): Promise<boolean> {
    return this.images.has(reference);
  }

  async imageId(reference: string): Promise<string | undefined> {
    if (!this.images.has(reference)) return undefined;
    return this.imageIds.get(reference) ?? `sha256:image-of-${reference}`;
  }

  async removeImage(reference: string): Promise<boolean> {
    this.log.push(`rmi ${reference}`);
    return this.images.delete(reference);
  }

  async listImageTags(repository: string): Promise<string[]> {
    return [...this.images]
      .filter((image) => image.startsWith(`${repository}:`))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }

  async pullImage(reference: string, options: { signal?: AbortSignal; credentials?: PullCredentials } = {}): Promise<void> {
    this.log.push(`pull ${reference}`);
    this.pulls.push(options.credentials ? { reference, credentials: { ...options.credentials } } : { reference });
    if (options.signal?.aborted) throw abortError();
    const error = this.pullError(reference, options.credentials);
    if (error) throw error;
    this.images.add(reference);
  }

  /** `labels` default: the label devenv.container-version of the current setup. */
  addContainer(p: { environmentId: string; name: string; state: ContainerState; image: string; labels?: Record<string, string> }): ContainerInfo {
    const id = `container-${++this.counter}`;
    const container: ContainerInfo = {
      id,
      name: p.name,
      state: p.state,
      rawState: p.state === 'running' ? 'running' : 'exited',
      labels: { ...(p.labels ?? { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION) }), [LABEL_ENVIRONMENT_ID]: p.environmentId },
      image: p.image,
    };
    this.containers.set(id, container);
    return container;
  }

  containerByRef(ref: string): ContainerInfo | undefined {
    return this.containers.get(ref) ?? [...this.containers.values()].find((c) => c.name === ref);
  }

  containersOf(environmentId: string): ContainerInfo[] {
    return [...this.containers.values()].filter((c) => c.labels[LABEL_ENVIRONMENT_ID] === environmentId);
  }
}

/**
 * Labels of an additional volume that the pipeline created for the environment `id` (additionalVolumeLabels): only
 * these make a volume the environment's own. `owner` null: an entry of an older version without owner.
 */
export function additionalVolumeLabels(
  id: string = ENV_ID,
  owner: GitHubAccount | null = ACCOUNT,
  repository: string = REPO,
): Record<string, string> {
  const labels: Record<string, string> = { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [LABEL_VOLUME]: VOLUME_KIND_ADDITIONAL };
  if (owner) labels[LABEL_OWNER_ID] = owner.id;
  return labels;
}

/**
 * `Config` of an environment image whose metadata label names `remoteUser` (the base image entry comes first), with more
 * entries (for example of Features) before the configuration.
 */
export function imageConfigWithUser(
  remoteUser: string,
  entries: Array<Record<string, unknown>> = [],
): { User: string; Labels: Record<string, string> } {
  return {
    User: '',
    Labels: { 'devcontainer.metadata': JSON.stringify([{ id: 'base', remoteUser: 'root' }, ...entries, { remoteUser }]) },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Workspace helper

export interface FakeFiles {
  configText: string;
  dockerfilePath?: string;
  dockerfileText?: string;
  dockerfileMissing?: boolean;
}

type Maybe<T> = T | undefined;

export class FakeHelper implements EnvironmentHelper {
  /** Calls in order, for example `clone main`, `build devenv-3f2a9c1e:1`, `up devenv-3f2a9c1e:1 --remove-existing-container`. */
  readonly calls: string[] = [];
  /** Files of the repository in the volume, per configuration path. */
  files: Record<string, FakeFiles> = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
  /** Result of listConfigurations. Default: the keys of `files`. */
  configurations: string[] | undefined;
  /** Resolved configuration that readConfiguration returns. */
  config: DevcontainerConfig = { image: BASE_IMAGE, features: { [FEATURE]: {} }, remoteUser: 'vscode' };
  /** `mergedConfiguration` that readConfiguration returns (`undefined`: the CLI could not read it). */
  merged: Record<string, unknown> | undefined = {};
  remoteUser = 'vscode';
  ensureImageError: Maybe<Error>;
  cloneError: Maybe<Error>;
  readConfigurationError: Maybe<Error>;
  buildError: (imageName: string) => Maybe<Error> = () => undefined;
  upError: (image: string, removeExisting: boolean) => Maybe<Error> = () => undefined;
  /**
   * Review round 3 (D3-1): runs when `up` of Docker Compose fails with upError after the removal of the dev container, for
   * example to add the containers that Compose created before the failure.
   */
  beforeUpError: (() => void) | undefined;
  /** upError fails before the CLI removes the existing container (for example an invalid override configuration). */
  upFailsBeforeRemoval = false;
  /**
   * A lifecycle command fails after `up` created or started the container, which keeps running: the description of the
   * CLI, for example `postStartCommand from devcontainer.json failed.`
   */
  lifecycleFailure: (image: string) => Maybe<string> = () => undefined;
  /**
   * How `up` reports a lifecycle failure: `error` as the CLI does (DevcontainerCommandError with the JSON result), or
   * `result` as WorkspaceHelper.up does for a running container (outcome success with `lifecycleCommandFailure`).
   */
  lifecycleFailureReport: 'error' | 'result' = 'error';
  gitSummaryResult: GitSummary | Error = { branch: 'main', uncommittedFiles: 2, unpushedCommits: 1, stashes: 0, recordedAt: '2026-09-24T15:40:00.000Z' };
  switchError: Maybe<Error>;
  /** Named volumes that a container created by `up` mounts besides the workspace volume. */
  containerVolumes: string[] = [];
  prepareGitError: Maybe<Error>;
  /** More entries of the label devcontainer.metadata of a built image (for example of a Feature). */
  buildMetadata: Array<Record<string, unknown>> = [];
  /** Hook while a build runs (to look at the registry or to abort). */
  onBuild: (imageName: string) => void | Promise<void> = () => undefined;
  onClone: () => void | Promise<void> = () => undefined;
  readonly clones: Array<{ volumeName: string; repository: string; branch?: string; token: string }> = [];
  /** `override`, `files`, and `env` only for a Docker Compose configuration. */
  readonly builds: Array<{
    imageName: string;
    configPath: string;
    override?: Record<string, unknown>;
    files?: Readonly<Record<string, string>>;
    env?: Record<string, string>;
  }> = [];
  /** `files` and `env` only for a Docker Compose configuration. */
  readonly ups: Array<{
    image: string;
    removeExistingContainer: boolean;
    override: Record<string, unknown>;
    files?: Readonly<Record<string, string>>;
    env?: Record<string, string>;
  }> = [];
  /** Each readConfiguration, with what a Docker Compose configuration passes. */
  readonly readConfigurations: Array<{
    configPath: string;
    merged?: boolean;
    override?: Record<string, unknown>;
    files?: Readonly<Record<string, string>>;
    env?: Record<string, string>;
  }> = [];
  /** Result of composeModel (the model run of a Docker Compose configuration); an Error is thrown. */
  composeOutput: ComposeModelOutput | { error: string } | Error = new Error('No Docker Compose model in this test.');
  /** Each composeModel. */
  readonly composeModels: Array<{ files: readonly string[]; project: string }> = [];
  /** `composeProjectName` of the result of `up` of a Docker Compose configuration. Default: COMPOSE_PROJECT_NAME. */
  composeProjectNameResult: string | undefined;
  /** Each write of the token and the Git configuration into the volume. */
  readonly gitPreparations: Array<{
    volumeName: string;
    repository: string;
    token: string;
    identity: { name: string; email: string };
    login: string;
  }> = [];
  /** Volumes that a helper run created silently (the real helper does this for a missing volume). Must stay empty. */
  readonly silentlyCreatedVolumes: string[] = [];

  constructor(private readonly docker: FakeDocker) {}

  private mount(volumeName: string): void {
    if (!this.docker.volumes.has(volumeName)) {
      this.docker.volumes.set(volumeName, {});
      this.silentlyCreatedVolumes.push(volumeName);
    }
  }

  async ensureImage(): Promise<string> {
    this.calls.push('ensureImage');
    if (this.ensureImageError) throw this.ensureImageError;
    return 'devenv-helper:test';
  }

  async clone(p: { volumeName: string; repository: string; branch?: string; token: string; signal?: AbortSignal }): Promise<void> {
    this.mount(p.volumeName);
    this.calls.push(`clone ${p.branch ?? ''}`.trim());
    this.clones.push({ volumeName: p.volumeName, repository: p.repository, branch: p.branch, token: p.token });
    await this.onClone();
    if (p.signal?.aborted) throw abortError();
    if (this.cloneError) throw this.cloneError;
  }

  /**
   * Dockerfiles of the repository by their path relative to it, for a readConfigFiles with `dockerfile` (the path that
   * the resolved configuration names, review round 2, S2-01). Default: the Dockerfiles of `files`.
   */
  dockerfiles: Record<string, string> | undefined;
  /** Each `dockerfile` of readConfigFiles. */
  readonly dockerfileReads: string[] = [];
  /**
   * Review round 3 (P3-1): Dockerfiles (relative to the repository) that exist but cannot be read (for example a link out
   * of the repository). Any other Dockerfile that `dockerfiles` lacks does not exist (`dockerfileMissing`).
   */
  unreadableDockerfiles: string[] = [];

  async readConfigFiles(p: { volumeName: string; configPath: string; dockerfile?: string }): Promise<FakeFiles | undefined> {
    this.mount(p.volumeName);
    this.calls.push(`readConfigFiles ${p.configPath}`);
    if (!Object.prototype.hasOwnProperty.call(this.files, p.configPath)) return undefined;
    const files = { ...this.files[p.configPath] };
    if (p.dockerfile === undefined) return files;
    // As READ_FILES_SCRIPT: the path against the folder of the configuration, only in the repository.
    this.dockerfileReads.push(p.dockerfile);
    const root = '/r';
    const file = path.posix.resolve(root, path.posix.dirname(p.configPath), p.dockerfile);
    const result: FakeFiles = { configText: files.configText };
    if (!file.startsWith(`${root}/`)) return result;
    result.dockerfilePath = path.posix.relative(root, file);
    const known =
      this.dockerfiles ??
      Object.fromEntries(
        Object.values(this.files)
          .filter((entry) => entry.dockerfilePath !== undefined && entry.dockerfileText !== undefined)
          .map((entry) => [entry.dockerfilePath as string, entry.dockerfileText as string]),
      );
    if (Object.prototype.hasOwnProperty.call(known, result.dockerfilePath)) result.dockerfileText = known[result.dockerfilePath];
    else if (!this.unreadableDockerfiles.includes(result.dockerfilePath)) result.dockerfileMissing = true;
    return result;
  }

  async listConfigurations(p: { volumeName: string }): Promise<string[]> {
    this.mount(p.volumeName);
    this.calls.push('listConfigurations');
    return this.configurations ?? Object.keys(this.files);
  }

  async readConfiguration(p: {
    volumeName: string;
    configPath: string;
    merged?: boolean;
    override?: Record<string, unknown>;
    files?: Readonly<Record<string, string>>;
    env?: Record<string, string>;
  }): Promise<{ config: DevcontainerConfig; merged?: Record<string, unknown> }> {
    this.mount(p.volumeName);
    this.calls.push(`readConfiguration ${p.configPath}`);
    this.readConfigurations.push({
      configPath: p.configPath,
      ...(p.merged !== undefined ? { merged: p.merged } : {}),
      ...(p.override !== undefined ? { override: p.override } : {}),
      ...(p.files !== undefined ? { files: p.files } : {}),
      ...(p.env !== undefined ? { env: p.env } : {}),
    });
    if (this.readConfigurationError) throw this.readConfigurationError;
    // A Docker Compose configuration resolves to its own text (the fake resolves no variables); any other one to `config`.
    const text = Object.prototype.hasOwnProperty.call(this.files, p.configPath) ? this.files[p.configPath].configText : undefined;
    const compose = text !== undefined && checkConfiguration(text).compose;
    const config = (compose && text !== undefined ? parseJsonc(text) : JSON.parse(JSON.stringify(this.config))) as DevcontainerConfig;
    if (p.merged === false) return { config };
    return this.merged === undefined ? { config } : { config, merged: { ...config, ...this.merged } };
  }

  async composeModel(p: { volumeName: string; files: readonly string[]; project: string }): Promise<ComposeModelOutput | { error: string }> {
    this.mount(p.volumeName);
    this.calls.push(`composeModel ${p.project}`);
    this.composeModels.push({ files: [...p.files], project: p.project });
    if (this.composeOutput instanceof Error) throw this.composeOutput;
    return JSON.parse(JSON.stringify(this.composeOutput)) as ComposeModelOutput | { error: string };
  }

  async prepareGit(p: {
    volumeName: string;
    repository: string;
    token: string;
    identity: { name: string; email: string };
    login: string;
  }): Promise<void> {
    this.mount(p.volumeName);
    this.calls.push('prepareGit');
    this.gitPreparations.push({ volumeName: p.volumeName, repository: p.repository, token: p.token, identity: { ...p.identity }, login: p.login });
    if (this.prepareGitError) throw this.prepareGitError;
  }

  async build(p: {
    volumeName: string;
    configPath: string;
    imageName: string;
    override?: Record<string, unknown>;
    files?: Readonly<Record<string, string>>;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<DevcontainerResult> {
    this.mount(p.volumeName);
    this.calls.push(`build ${p.imageName}`);
    this.builds.push({
      imageName: p.imageName,
      configPath: p.configPath,
      ...(p.override !== undefined ? { override: p.override } : {}),
      ...(p.files !== undefined ? { files: p.files } : {}),
      ...(p.env !== undefined ? { env: p.env } : {}),
    });
    await this.onBuild(p.imageName);
    if (p.signal?.aborted) throw abortError();
    const error = this.buildError(p.imageName);
    if (error) throw error;
    this.docker.images.add(p.imageName);
    // Like `devcontainer build`: the configuration (with the remote user) is the last entry of the metadata label.
    this.docker.imageConfigs.set(p.imageName, imageConfigWithUser(this.remoteUser, this.buildMetadata));
    return { outcome: 'success', imageName: p.imageName };
  }

  async up(p: {
    volumeName: string;
    override: Record<string, unknown>;
    environmentId: string;
    removeExistingContainer: boolean;
    files?: Readonly<Record<string, string>>;
    env?: Record<string, string>;
  }): Promise<DevcontainerResult> {
    this.mount(p.volumeName);
    if (p.override.dockerComposeFile !== undefined) return this.composeUp(p);
    const image = String(p.override.image);
    this.calls.push(`up ${image}${p.removeExistingContainer ? ' --remove-existing-container' : ''}`);
    this.ups.push({ image, removeExistingContainer: p.removeExistingContainer, override: p.override });
    const existing = this.docker.containersOf(p.environmentId)[0];
    const error = this.upError(image, p.removeExistingContainer);
    if (error && this.upFailsBeforeRemoval) throw error;
    if (existing && p.removeExistingContainer) this.docker.containers.delete(existing.id);
    if (error) throw error;
    const workspaceFolder = String(p.override.workspaceFolder);
    let containerId: string;
    if (existing && !p.removeExistingContainer) {
      existing.state = 'running';
      existing.rawState = 'running';
      containerId = existing.id;
    } else {
      if (!this.docker.images.has(image)) {
        throw new DevcontainerCommandError('devcontainer up', 1, '', `Error: No such image: ${image}`);
      }
      const runArgs = p.override.runArgs as string[];
      const name = runArgs[runArgs.lastIndexOf('--name') + 1];
      // Like `docker run`: the labels of runArgs.
      const labels: Record<string, string> = {};
      runArgs.forEach((arg, index) => {
        if (arg !== '--label') return;
        const [key, ...value] = runArgs[index + 1].split('=');
        labels[key] = value.join('=');
      });
      const created = this.docker.addContainer({ environmentId: p.environmentId, name, state: 'running', image, labels });
      if (this.containerVolumes.length > 0) this.docker.containers.set(created.id, { ...created, volumes: [p.volumeName, ...this.containerVolumes] });
      containerId = created.id;
    }
    const failure = this.lifecycleFailure(image);
    if (failure !== undefined) {
      if (this.lifecycleFailureReport === 'result') return { outcome: 'success', containerId, lifecycleCommandFailure: failure } as DevcontainerResult;
      const result: DevcontainerResult = { outcome: 'error', message: 'Command failed: /bin/sh -c npm run db:migrate', description: failure, containerId };
      throw new DevcontainerCommandError('devcontainer up', 1, `${JSON.stringify(result)}\n`, 'npm ERR! code 1', result);
    }
    return { outcome: 'success', containerId, remoteUser: this.remoteUser, remoteWorkspaceFolder: workspaceFolder };
  }

  /**
   * `up` of a Docker Compose configuration, as the Dev Container CLI and Compose do it: the dev container is found by the
   * project and the service; `removeExistingContainer` replaces only it; the containers of the other services (of
   * `runServices`, default all) are created with the labels of the model, or started.
   */
  private async composeUp(p: {
    volumeName: string;
    override: Record<string, unknown>;
    environmentId: string;
    removeExistingContainer: boolean;
    files?: Readonly<Record<string, string>>;
    env?: Record<string, string>;
  }): Promise<DevcontainerResult> {
    const text = p.files?.[COMPOSE_MODEL_PATH];
    if (text === undefined) throw new DevcontainerCommandError('devcontainer up', 1, '', 'No compose file.');
    const model = JSON.parse(text) as ComposeModel;
    const service = String(p.override.service);
    const dev = model.services[service];
    const image = String(dev.image);
    const project = p.env?.COMPOSE_PROJECT_NAME ?? String(model.name);
    this.calls.push(`up ${image}${p.removeExistingContainer ? ' --remove-existing-container' : ''}`);
    this.ups.push({
      image,
      removeExistingContainer: p.removeExistingContainer,
      override: p.override,
      ...(p.files !== undefined ? { files: p.files } : {}),
      ...(p.env !== undefined ? { env: p.env } : {}),
    });
    const ofProject = (name: string) =>
      this.docker
        .containersOf(p.environmentId)
        .find((c) => c.labels['com.docker.compose.project'] === project && c.labels['com.docker.compose.service'] === name);
    const existing = ofProject(service);
    const error = this.upError(image, p.removeExistingContainer);
    if (error && this.upFailsBeforeRemoval) throw error;
    if (existing && p.removeExistingContainer) this.docker.containers.delete(existing.id);
    if (error) {
      this.beforeUpError?.();
      throw error;
    }
    // Compose creates the default network of the project.
    this.docker.networks.set(`${project}_default`, { 'com.docker.compose.project': project });
    const volumeNames = (entries: unknown): string[] =>
      (Array.isArray(entries) ? entries : [])
        .map((entry: { type?: string; source?: string }) => (entry.type === 'volume' && entry.source ? model.volumes?.[entry.source]?.name : undefined))
        .filter((name): name is string => typeof name === 'string');
    const create = (name: string, containerName: string, serviceImage: string, labels: unknown, volumes: string[]): ContainerInfo => {
      if (!this.docker.images.has(serviceImage)) throw new DevcontainerCommandError('devcontainer up', 1, '', `Error: No such image: ${serviceImage}`);
      const created = this.docker.addContainer({
        environmentId: p.environmentId,
        name: containerName,
        state: 'running',
        image: serviceImage,
        // Compose's labels of a container (the container number only on containers, not on images: isComposeContainer).
        // Like `docker run`: the labels of the image, then those of the model.
        labels: {
          ...(this.docker.imageConfigs.get(serviceImage)?.Labels ?? {}),
          ...(labels as Record<string, string>),
          'com.docker.compose.project': project,
          'com.docker.compose.service': name,
          'com.docker.compose.container-number': '1',
          'com.docker.compose.config-hash': 'hash',
        },
      });
      if (volumes.length > 0) this.docker.containers.set(created.id, { ...created, volumes });
      return created;
    };
    let containerId: string;
    if (existing && !p.removeExistingContainer) {
      existing.state = 'running';
      existing.rawState = 'running';
      containerId = existing.id;
    } else {
      const volumes = [...volumeNames(dev.volumes), ...this.containerVolumes];
      containerId = create(service, String(dev.container_name), image, dev.labels, volumes).id;
    }
    const runServices = Array.isArray(p.override.runServices) ? (p.override.runServices as string[]) : Object.keys(model.services);
    for (const name of runServices) {
      if (name === service) continue;
      const other = ofProject(name);
      if (other) {
        other.state = 'running';
        other.rawState = 'running';
        continue;
      }
      const definition = model.services[name];
      create(name, `${project}-${name}-1`, String(definition.image), definition.labels, volumeNames(definition.volumes));
    }
    const failure = this.lifecycleFailure(image);
    if (failure !== undefined) {
      const result: DevcontainerResult = { outcome: 'error', message: 'Command failed', description: failure, containerId };
      throw new DevcontainerCommandError('devcontainer up', 1, `${JSON.stringify(result)}\n`, 'failed', result);
    }
    return {
      outcome: 'success',
      containerId,
      composeProjectName: this.composeProjectNameResult ?? project,
      remoteUser: this.remoteUser,
      remoteWorkspaceFolder: String(p.override.workspaceFolder),
    };
  }

  async gitSummary(p: { volumeName: string }): Promise<GitSummary> {
    this.mount(p.volumeName);
    this.calls.push('gitSummary');
    if (this.gitSummaryResult instanceof Error) throw this.gitSummaryResult;
    return { ...this.gitSummaryResult };
  }

  async switchBranch(p: { volumeName: string; branch: string; token: string }): Promise<void> {
    this.mount(p.volumeName);
    this.calls.push(`switchBranch ${p.branch}`);
    if (this.switchError) throw this.switchError;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Image check, user interface, progress, logger

/** Digests for all references of a check. */
export function checked(images: Record<string, string>, features: Record<string, string> = {}, extra: Partial<Extract<CheckOutcome, { status: 'checked' }>> = {}): CheckOutcome {
  return { status: 'checked', images, features, authRequired: [], failed: [], ...extra };
}

export class FakeImageChecker {
  outcome: CheckOutcome | ((references: ConfigReferences) => CheckOutcome) = checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
  error: Maybe<Error>;
  readonly calls: ConfigReferences[] = [];

  async check(references: ConfigReferences): Promise<CheckOutcome> {
    this.calls.push(references);
    if (this.error) throw this.error;
    return typeof this.outcome === 'function' ? this.outcome(references) : this.outcome;
  }
}

export class FakeUi implements PipelineUi {
  trust = true;
  configurationChangedAnswer: 'rebuildNow' | 'later' = 'later';
  /** Review round 4 (D4-3): the answer to configurationKindChanged, and its questions. */
  configurationKindChangedAnswer: 'rebuildNow' | 'later' = 'later';
  readonly kindQuestions: string[] = [];
  filesMissingAnswer: 'cloneAgain' | 'deleteEnvironment' | undefined = undefined;
  readonly prompts: string[] = [];
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly signIns: string[] = [];

  async confirmUntrustedRepository(repository: string): Promise<boolean> {
    this.prompts.push(`untrusted ${repository}`);
    return this.trust;
  }

  async configurationChanged(repository: string): Promise<'rebuildNow' | 'later'> {
    this.prompts.push(`configurationChanged ${repository}`);
    return this.configurationChangedAnswer;
  }

  async configurationKindChanged(repository: string, message: string): Promise<'rebuildNow' | 'later'> {
    this.prompts.push(`configurationKindChanged ${repository}`);
    this.kindQuestions.push(message);
    return this.configurationKindChangedAnswer;
  }

  async filesMissing(repository: string): Promise<'cloneAgain' | 'deleteEnvironment' | undefined> {
    this.prompts.push(`filesMissing ${repository}`);
    return this.filesMissingAnswer;
  }

  info(message: string): void {
    this.infos.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  registrySignIn(registry: string): void {
    this.signIns.push(registry);
  }
}

export class RecordingProgress implements ProgressReporter {
  readonly steps: ProgressStep[] = [];
  readonly details: string[] = [];

  step(step: ProgressStep): void {
    this.steps.push(step);
  }

  detail(message: string): void {
    this.details.push(message);
  }
}

export class RecordingLogger implements Logger {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly outputs: string[] = [];

  info(message: string): void {
    this.infos.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  error(message: string, error?: unknown): void {
    this.errors.push(error instanceof Error ? `${message} ${error.message}` : message);
  }

  output(text: string): void {
    this.outputs.push(text);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Harness

export interface Harness {
  root: string;
  paths: StoragePaths;
  registry: EnvironmentRegistry;
  sessionFiles: SessionFiles;
  docker: FakeDocker;
  helper: FakeHelper;
  checker: FakeImageChecker;
  ui: FakeUi;
  logger: RecordingLogger;
  progress: RecordingProgress;
  settings: ExtensionSettings;
  env: NodeJS.ProcessEnv;
  /** The token that getToken returns; `undefined` = not signed in. */
  token: string | undefined;
  /** The account of the session (getAccount); none while `token` is `undefined`. */
  account: GitHubAccount;
  /** Docker is stopped: the starter reports a start and starts it. */
  dockerStopped: boolean;
  dockerStartError: Maybe<Error>;
  dockerStarts: number;
  /** Process IDs that count as alive (besides PID). */
  alivePids: Set<number>;
  sleeps: number[];
  /** Tokens that the service reported as rejected by GitHub (GitHubAuth.reportRejectedToken). */
  rejectedTokens: string[];
  clock: Clock;
  service: EnvironmentService;
  cleanup(): void;
}

export function createHarness(overrides: Partial<EnvironmentServiceDeps> = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  const paths = new StoragePaths(root);
  paths.ensureDirectoriesSync();
  let now = T0;
  const clock: Clock = { now: () => now++ };
  const docker = new FakeDocker();
  const h = {
    root,
    paths,
    registry: new EnvironmentRegistry(paths, clock),
    sessionFiles: new SessionFiles(paths, clock),
    docker,
    helper: new FakeHelper(docker),
    checker: new FakeImageChecker(),
    ui: new FakeUi(),
    logger: new RecordingLogger(),
    progress: new RecordingProgress(),
    settings: { ...DEFAULT_SETTINGS },
    env: { FOO: 'local-foo' } as NodeJS.ProcessEnv,
    token: TOKEN as string | undefined,
    account: { ...ACCOUNT },
    dockerStopped: false,
    dockerStartError: undefined as Maybe<Error>,
    dockerStarts: 0,
    alivePids: new Set<number>(),
    sleeps: [] as number[],
    rejectedTokens: [] as string[],
    clock,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  } as Omit<Harness, 'service'> as Harness;

  const startDocker: DockerStarter = async ({ onStarting, signal }) => {
    h.dockerStarts++;
    if (signal?.aborted) throw abortError();
    if (h.dockerStartError) throw h.dockerStartError;
    if (h.dockerStopped) {
      onStarting();
      h.dockerStopped = false;
      h.docker.running = true;
    }
  };
  h.service = new EnvironmentService({
    docker: h.docker,
    runner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) },
    helper: h.helper,
    registry: h.registry,
    sessionFiles: h.sessionFiles,
    imageChecker: h.checker,
    auth: {
      getToken: async () => h.token,
      getAccount: async () => (h.token === undefined ? undefined : h.account),
      reportRejectedToken: (token: string) => void h.rejectedTokens.push(token),
    },
    ui: h.ui,
    logger: h.logger,
    clock,
    platform: 'linux',
    env: h.env,
    owner: { windowId: WINDOW_ID, pid: PID },
    settings: () => h.settings,
    startDocker,
    isProcessAlive: (pid) => pid === PID || h.alivePids.has(pid),
    busyWaitMs: 2_000,
    sleep: async (ms, signal) => {
      h.sleeps.push(ms);
      if (signal?.aborted) throw abortError();
    },
    ...overrides,
  });
  return h;
}

export interface SeedOptions {
  id?: string;
  repository?: string;
  /** `null`: no build record. */
  record?: Partial<BuildRecord> | null;
  /** `null`: no container. */
  container?: ContainerState | null;
  /** The environment image of the record exists locally. Default true. */
  image?: boolean;
  /** The workspace volume exists. Default true. */
  volume?: boolean;
  /** Labels of the container. Default: the label devenv.container-version of the current setup. */
  containerLabels?: Record<string, string>;
  /** Default: ACCOUNT. `null`: an entry of an older version without owner. */
  owner?: GitHubAccount | null;
  extra?: Partial<Environment>;
}

/** An existing environment that is up to date with the default configuration and the default check outcome. */
export async function seedEnvironment(h: Harness, options: SeedOptions = {}): Promise<Environment> {
  const id = options.id ?? ENV_ID;
  const repository = options.repository ?? REPO;
  const name = resourceName(repository, id);
  const record: BuildRecord | undefined =
    options.record === null
      ? undefined
      : {
          builtAt: '2026-09-20T10:00:00.000Z',
          environmentImage: environmentImageName(id, 1),
          buildNumber: 1,
          configPath: DEFAULT_CONFIG_PATH,
          configHash: configHash(DEFAULT_CONFIG_TEXT),
          images: { [BASE_IMAGE]: DIGEST_NEW },
          features: { [FEATURE]: FEATURE_DIGEST },
          ...options.record,
        };
  const environment: Environment = {
    id,
    repository,
    configPath: DEFAULT_CONFIG_PATH,
    volumeName: name,
    containerName: name,
    createdAt: '2026-09-20T10:00:00.000Z',
    lastUsedAt: '2026-09-20T10:00:00.000Z',
    remoteUser: 'vscode',
    remoteWorkspaceFolder: `/workspaces/${repository.split('/')[1]}`,
    gitSummary: { branch: 'main', uncommittedFiles: 3, unpushedCommits: 4, stashes: 1, recordedAt: '2026-09-20T10:00:00.000Z' },
    lastBuildNumber: record?.buildNumber,
    ...(record ? { buildRecord: record } : {}),
    ...(options.owner === null ? {} : { owner: options.owner ?? ACCOUNT }),
    ...options.extra,
  };
  await h.registry.add(environment);
  if (options.volume !== false) {
    const labels: Record<string, string> = { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository };
    if (environment.owner) labels[LABEL_OWNER_ID] = environment.owner.id;
    h.docker.volumes.set(name, labels);
  }
  if (record && options.image !== false) {
    h.docker.images.add(record.environmentImage);
    h.docker.imageConfigs.set(record.environmentImage, imageConfigWithUser('vscode'));
  }
  const state = options.container === undefined ? 'stopped' : options.container;
  if (state !== null) {
    h.docker.addContainer({ environmentId: id, name, state, image: record?.environmentImage ?? environmentImageName(id, 1), labels: options.containerLabels });
  }
  return environment;
}
