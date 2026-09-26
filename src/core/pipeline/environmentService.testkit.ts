// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// In-memory fakes for the tests of the environment service: Docker, workspace helper, image check, and user interface.
// The registry and the session files are the real ones, in a temporary folder. Only test files import this module.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ContainerInfo, VolumeInfo } from '../docker/containerAdapter';
import { CommandError } from '../errors';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import type { CheckOutcome, ConfigReferences } from '../imageCheck/imageCheck';
import type { ProgressStep } from '../messages';
import {
  CONTAINER_VERSION,
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
  private counter = 0;

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

  async findContainer(environmentId: string): Promise<ContainerInfo | undefined> {
    const matching = [...this.containers.values()].filter((c) => c.labels[LABEL_ENVIRONMENT_ID] === environmentId);
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
  readonly builds: Array<{ imageName: string; configPath: string }> = [];
  readonly ups: Array<{ image: string; removeExistingContainer: boolean; override: Record<string, unknown> }> = [];
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

  async readConfigFiles(p: { volumeName: string; configPath: string }): Promise<FakeFiles | undefined> {
    this.mount(p.volumeName);
    this.calls.push(`readConfigFiles ${p.configPath}`);
    return Object.prototype.hasOwnProperty.call(this.files, p.configPath) ? { ...this.files[p.configPath] } : undefined;
  }

  async listConfigurations(p: { volumeName: string }): Promise<string[]> {
    this.mount(p.volumeName);
    this.calls.push('listConfigurations');
    return this.configurations ?? Object.keys(this.files);
  }

  async readConfiguration(p: { volumeName: string; configPath: string }): Promise<{ config: DevcontainerConfig; merged?: Record<string, unknown> }> {
    this.mount(p.volumeName);
    this.calls.push(`readConfiguration ${p.configPath}`);
    if (this.readConfigurationError) throw this.readConfigurationError;
    const config = JSON.parse(JSON.stringify(this.config)) as DevcontainerConfig;
    return this.merged === undefined ? { config } : { config, merged: { ...config, ...this.merged } };
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

  async build(p: { volumeName: string; configPath: string; imageName: string; signal?: AbortSignal }): Promise<DevcontainerResult> {
    this.mount(p.volumeName);
    this.calls.push(`build ${p.imageName}`);
    this.builds.push({ imageName: p.imageName, configPath: p.configPath });
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
  }): Promise<DevcontainerResult> {
    this.mount(p.volumeName);
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
