// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// In-memory fakes for the tests of the environment service: Docker, workspace helper, image check, and user interface.
// The registry and the session files are the real ones, in a temporary folder. Only test files import this module.
import type { DeleteConfirmation } from './deleteCheck';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EXISTING_PATHS_SCRIPT } from '../git/gitSummary';
import { TOKEN_WRITE_SCRIPT } from '../helper/containerToken';
import { isDevContainer, volumeRunArgs, type VolumeRun, type ContainerInfo, type ImageInfo, type ImageInspection, type MountTarget, type NetworkInfo, type VolumeInfo } from '../docker/containerAdapter';
import { CommandError, UserFacingError } from '../errors';
import { COMPOSE_MODEL_PATH, WORKSPACE_VOLUME_KEY, type ComposeModel, type ComposeModelOutput } from '../helper/compose';
import { checkConfiguration } from '../helper/configChecks';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import type { HelperImageUse } from '../helper/workspaceHelper';
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
  TOKEN_TMPFS,
  VOLUME_KIND_ADDITIONAL,
  environmentImageName,
  resourceName,
} from '../names';
import { EnvironmentLockError, type HeldEnvironmentLock } from '../docker/environmentLock';
import { HelperChannelError, HelperOperationError } from '../helperChannel/helperChannel';
import { LOCK_BUSY_CODE, LOCK_UNAVAILABLE_CODE, OP_STOP, OP_WINDOW_STATE, parseStopParams, parseWindowStateParams } from '../helperChannel/protocol';
import { EngineDocker } from '../worker/engineDocker';
import { windowStateFlow } from '../worker/windowStateFlow';
import { readEnvironmentStates } from './refreshStates';
import type { DockerEngine, EngineContainer } from '../worker/dockerEngine';
import { unusedEngine } from '../worker/dockerEngine.testkit';
import { stopFlow } from '../worker/stopFlow';
import { abortError, type Clock, type Logger, type PipelineUi, type ProgressReporter, type RunOptions, type RunResult } from '../ports';
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
import { inProcessAnalyzer } from '../helper/configurationAnalysis';

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
/**
 * Review round 4 (D4-2): the label nimblescape.devenv.config-path of the override configuration, for the default
 * configuration.
 */
export const CONFIG_PATH_LABEL: readonly string[] = ['--label', 'nimblescape.devenv.config-path=.devcontainer/devcontainer.json'];
/** Unit 15: the tmpfs of the token at the end of the runArgs of the override configuration. */
export const TOKEN_TMPFS_ARGS: readonly string[] = ['--tmpfs', TOKEN_TMPFS];

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
  /** Each `docker exec`; unit 15: with its standard input (the token of TOKEN_WRITE_SCRIPT). */
  readonly execs: Array<{ container: string; command: readonly string[]; user?: string; signal?: AbortSignal; input?: string; secret?: true }> = [];
  /** Each `docker pull`, with the credentials that it got instead of those of Docker. */
  readonly pulls: Array<{ reference: string; credentials?: PullCredentials }> = [];
  pullError: (reference: string, credentials?: PullCredentials) => Error | undefined = () => undefined;
  execHandler: (container: string, command: readonly string[], user?: string) => Partial<RunResult> = () => ({});
  /**
   * Review round 14 (P14-1): links in the volumes (subpath → the subpath it leads to), which Docker follows when it mounts
   * a subpath; `cat /proc/self/mountinfo` in a container shows the real folder as the root of such a mount.
   */
  readonly volumeLinks = new Map<string, string>();
  /** Review round 11 (G3): paths of the workspace volume that do not exist (EXISTING_PATHS_SCRIPT leaves them out). */
  readonly missingPaths = new Set<string>();
  /** Volumes that `docker volume rm` refuses to remove. */
  readonly volumesInUse = new Set<string>();
  /** The names of each `docker volume inspect` (inspectVolumes). */
  readonly volumeInspections: string[][] = [];
  /** `Config` of `docker image inspect` per image. Default: no labels, no user. */
  readonly imageConfigs = new Map<string, { User?: string; Env?: string[]; Labels?: Record<string, string> }>();
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

  /**
   * As ContainerAdapter.listProjectImages. User decisions 2026-10-03: with `environmentId`, only the images whose label
   * nimblescape.devenv.environment-id is that ID (an unlabelled `<project>-*` image is left out too).
   */
  async listProjectImages(project: string, environmentId?: string): Promise<string[]> {
    const owner = (image: string): string | undefined => this.imageConfigs.get(image)?.Labels?.[LABEL_ENVIRONMENT_ID];
    return [...this.images]
      .filter((image) => image.startsWith(`${project}-`))
      .filter((image) => environmentId === undefined || owner(image) === environmentId)
      .sort();
  }

  async engineApiVersion(): Promise<string | undefined> {
    return this.apiVersion;
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  async runChecked(args: readonly string[], _options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
    if (args[0] === 'image' && args[1] === 'inspect') {
      const reference = args[args.length - 1];
      // Review round 1 of PR #88 (A-R1-1): also by the ID of an image, as Docker resolves it.
      const name = this.imageNamed(reference);
      if (name === undefined) throw new CommandError(`docker ${args.join(' ')}`, 1, '', `Error: No such image: ${reference}`);
      return `${JSON.stringify(this.imageConfigs.get(name) ?? { User: '', Labels: {} })}\n`;
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

  /**
   * Review round 2 of 11B3a (B-R2-12): the options of the typed calls of the ownership fix (imageConfig, runOnVolume,
   * containerIdsWithLabel), in order; they also reach runChecked, as they reach the Docker CLI in ContainerAdapter.
   */
  readonly typedCalls: { method: 'imageConfig' | 'runOnVolume' | 'containerIdsWithLabel'; options: { signal?: AbortSignal; timeoutMs?: number } }[] = [];

  /** Plan step 11B3: like ContainerAdapter.imageConfig (the `image inspect` of runChecked). */
  async imageConfig(reference: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    this.typedCalls.push({ method: 'imageConfig', options });
    return JSON.parse((await this.runChecked(['image', 'inspect', '--format', '{{json .Config}}', reference], options)).trim()) as unknown;
  }

  /** Plan step 11B3: like ContainerAdapter.runOnVolume (the `run` of runChecked, with the same arguments). */
  async runOnVolume(p: VolumeRun, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    this.typedCalls.push({ method: 'runOnVolume', options });
    await this.runChecked(volumeRunArgs(p), options);
  }

  /** Plan step 11B3: like ContainerAdapter.containerIdsWithLabel. */
  async containerIdsWithLabel(label: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string[]> {
    this.typedCalls.push({ method: 'containerIdsWithLabel', options });
    // As ContainerAdapter: the `ps` of runChecked, so that the tests that answer it keep doing so.
    const listed = await this.runChecked(['ps', '-aq', '--no-trunc', '--filter', `label=${label}`], options);
    return listed.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  }

  /** Plan step 10A: like ContainerAdapter.startContainer (recorded as the `start` of runChecked). */
  async startContainer(id: string, _options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
    await this.runChecked(['start', id]);
  }

  /**
   * Like ContainerAdapter.findContainer: the other services of a Docker Compose environment are skipped; the container
   * with the name of the environment first (final review, FC-1), then a running one, then the newest (the order of
   * insertion is the order of creation).
   */
  async findContainer(environmentId: string, containerName: string): Promise<ContainerInfo | undefined> {
    const matching = [...this.containers.values()].filter(
      (c) => c.labels[LABEL_ENVIRONMENT_ID] === environmentId && isDevContainer(c, containerName),
    );
    const newestFirst = [...matching].reverse();
    const found = matching.find((c) => c.name === containerName) ?? newestFirst.find((c) => c.state === 'running') ?? newestFirst[0];
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

  /** Review round 22 (D22-1): `docker rename`; fails with renameError, when the name is taken, or when it is the current name (FF-1). */
  renameError: Error | undefined = undefined;

  async renameContainer(nameOrId: string, newName: string): Promise<void> {
    this.log.push(`rename ${nameOrId} ${newName}`);
    if (this.renameError) throw this.renameError;
    const container = this.containerByRef(nameOrId);
    if (!container) throw new CommandError(`docker rename ${nameOrId}`, 1, '', `Error: No such container: ${nameOrId}`);
    // Final review (FF-1): as Docker (verified on 29.3.1), a rename to the current name is refused.
    if (container.name === newName) {
      throw new CommandError(`docker rename ${nameOrId}`, 1, '', 'Error response from daemon: Renaming a container with the same name as its current name');
    }
    if ([...this.containers.values()].some((c) => c.name === newName && c.id !== container.id)) {
      throw new CommandError(`docker rename ${nameOrId}`, 1, '', `Error response from daemon: Conflict. The container name "/${newName}" is already in use`);
    }
    container.name = newName;
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
    options: { user?: string; signal?: AbortSignal; timeoutMs?: number; input?: string; secretInput?: string } = {},
  ): Promise<RunResult> {
    // Plan step 6, PR C (Q4): a secret input (the token) is recorded as the input, marked `secret`.
    const input = options.secretInput ?? options.input;
    this.execs.push({ container, command, user: options.user, signal: options.signal, ...(input !== undefined ? { input } : {}), ...(options.secretInput !== undefined ? { secret: true as const } : {}) });
    // Review round 11 (G3): the check of the recorded paths of the services prints those that exist.
    const existing =
      command[2] === EXISTING_PATHS_SCRIPT
        ? command.slice(4).filter((folder) => !this.missingPaths.has(folder)).map((folder) => `${folder}\0`).join('')
        : command.length === 2 && command[0] === 'cat' && command[1] === '/proc/self/mountinfo'
          ? this.mountInfo(container)
          : // Review round 15 (K3): the numeric IDs of the remote user for the fix of the internal folder.
            command.length === 3 && command[0] === 'id' && (command[1] === '-u' || command[1] === '-g')
            ? '1000\n'
            : '';
    const result: RunResult = { exitCode: 0, stdout: existing, stderr: '', timedOut: false, ...this.execHandler(container, command, options.user) };
    // Like the process runner: an abort during the call kills the process and rejects.
    if (options.signal?.aborted) throw abortError();
    return result;
  }

  /**
   * Unit 15: each write of the token into the tmpfs of a dev container (TOKEN_WRITE_SCRIPT with `docker exec`): the
   * container, the user of the exec, the remote user and the login that the script gets, and the token on its stdin.
   */
  tokenWrites(): Array<{ container: string; user?: string; remoteUser: string; login: string; token?: string }> {
    return this.execs
      .filter((exec) => exec.command[2] === TOKEN_WRITE_SCRIPT)
      .map((exec) => ({ container: exec.container, user: exec.user, remoteUser: exec.command[4], login: exec.command[5], token: exec.input }));
  }

  /**
   * Review round 14 (P14-1): `/proc/self/mountinfo` of a container from its mountTargets: a volume on the device 8:1 with
   * the root `/var/lib/docker/volumes/<name>/_data`, a subpath below it after volumeLinks; others on other devices.
   */
  private mountInfo(ref: string): string {
    const container = [...this.containers.values()].find((c) => c.id === ref || c.name === ref);
    const lines = ['1 0 0:30 / / rw - overlay overlay rw'];
    (container?.mountTargets ?? []).forEach((mount, index) => {
      const escaped = (text: string) => text.replace(/[ \t\n\\]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);
      if (mount.type === 'volume' && mount.volume !== undefined) {
        let subpath = mount.subpath ?? '';
        for (const [link, real] of this.volumeLinks) if (subpath === link || subpath.startsWith(`${link}/`)) subpath = real + subpath.slice(link.length);
        const root = `/var/lib/docker/volumes/${mount.volume}/_data${subpath === '' ? '' : `/${subpath}`}`;
        lines.push(`${index + 2} 1 8:1 ${escaped(root)} ${escaped(mount.target)} rw - ext4 /dev/sda1 rw`);
      } else {
        lines.push(`${index + 2} 1 0:${index + 40} / ${escaped(mount.target)} rw - ${mount.type} ${mount.type} rw`);
      }
    });
    return `${lines.join('\n')}\n`;
  }

  async volumeExists(name: string): Promise<boolean> {
    return this.volumes.has(name);
  }

  async containerState(nameOrId: string): Promise<ContainerState> {
    const container = this.containers.get(nameOrId) ?? [...this.containers.values()].find((c) => c.name === nameOrId);
    return container?.state ?? 'missing';
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

  /** Review round 9 (S9-3): the references of each inspectImageNames. */
  readonly imageInspections: string[][] = [];

  /**
   * As `docker image inspect` of several references: the images that exist, in their order. An image of a reference that
   * imageRepoNames does not name has the reference as its tag (or digest); its ID is imageIds, a hexadecimal reference
   * padded to an ID, or `sha256:image-of-<reference>`.
   */
  /**
   * Review round 10 (P10-1): references that Docker cannot inspect (for example "invalid reference format"). Review round
   * 11 (G1): with the reason `invalid`.
   */
  readonly uninspectableImages = new Set<string>();
  /**
   * Review round 11 (G1): references whose inspect fails without an answer about them (a timeout, a daemon that cannot
   * be reached): the reason `transient`. `'all'`: every reference.
   */
  transientImages: Set<string> | 'all' = new Set<string>();

  async inspectImageNames(references: readonly string[]): Promise<ImageInspection> {
    this.imageInspections.push([...references]);
    if (this.transientImages === 'all') return { images: [], unchecked: references.map((reference) => ({ reference, reason: 'transient' })) };
    // Review round 13 (P13-1): like ContainerAdapter.inspectImageNames one by one, the first transient reference and all
    // after it are transient; the ones before it are answered.
    const first = references.findIndex((reference) => (this.transientImages as Set<string>).has(reference));
    if (first >= 0) {
      const answered = await this.inspectImageNames(references.slice(0, first));
      this.imageInspections.pop();
      return { images: answered.images, unchecked: [...answered.unchecked, ...references.slice(first).map((reference) => ({ reference, reason: 'transient' as const }))] };
    }
    const images = references
      .filter((reference) => this.images.has(reference) && !this.uninspectableImages.has(reference))
      .map((reference) => ({
        id: this.imageIds.get(reference) ?? (/^[0-9a-f]+$/.test(reference) ? `sha256:${reference.padEnd(64, '0')}` : `sha256:image-of-${reference}`),
        ...(this.imageRepoNames.get(reference) ?? (reference.includes('@') ? { repoTags: [], repoDigests: [reference] } : { repoTags: [reference], repoDigests: [] })),
      }));
    return { images, unchecked: references.filter((reference) => this.uninspectableImages.has(reference)).map((reference) => ({ reference, reason: 'invalid' })) };
  }

  async imageExists(reference: string): Promise<boolean> {
    // Review round 2 of PR #88 (B-R2-4): also by the ID of an image, as `docker image inspect` resolves it (imageId).
    return this.imageNamed(reference) !== undefined;
  }

  async imageId(reference: string): Promise<string | undefined> {
    // Review round 1 of PR #88 (A-R1-1): also by the ID of an image, as Docker resolves it.
    const name = this.imageNamed(reference);
    if (name === undefined) return undefined;
    return this.imageIds.get(name) ?? `sha256:image-of-${name}`;
  }

  /** The name of the image `reference` (a name, or the ID of one), undefined when none. */
  private imageNamed(reference: string): string | undefined {
    if (this.images.has(reference)) return reference;
    return [...this.images].find((name) => (this.imageIds.get(name) ?? `sha256:image-of-${name}`) === reference);
  }

  async imageLabels(reference: string): Promise<Record<string, string> | undefined> {
    const name = this.imageNamed(reference);
    return name === undefined ? undefined : { ...(this.imageConfigs.get(name)?.Labels ?? {}) };
  }

  async imageLabelsOf(references: readonly string[]): Promise<Map<string, Record<string, string>>> {
    const labels = new Map<string, Record<string, string>>();
    for (const reference of references) {
      const name = this.imageNamed(reference);
      if (name !== undefined) labels.set((this.imageIds.get(name) ?? `sha256:image-of-${name}`).toLowerCase(), { ...(this.imageConfigs.get(name)?.Labels ?? {}) });
    }
    return labels;
  }

  /** The labels that labelImage gave each image, by name (the fake keeps the ID of the image). */
  readonly labelled = new Map<string, Record<string, string>>();
  /** labelImage fails with this error, when set. */
  labelImageError: Error | undefined;

  async labelImage(image: string, labels: Record<string, string>): Promise<void> {
    if (this.labelImageError) throw this.labelImageError;
    if (!this.images.has(image)) throw new Error(`The image ${image} does not exist.`);
    this.labelled.set(image, { ...labels });
    const config = this.imageConfigs.get(image) ?? { User: '' };
    this.imageConfigs.set(image, { ...config, Labels: { ...(config.Labels ?? {}), ...labels } });
  }

  async removeImage(reference: string): Promise<boolean> {
    this.log.push(`rmi ${reference}`);
    return this.images.delete(reference);
  }

  /** User decision 2026-09-28: the number of listEnvironmentImages calls. */
  environmentImageLists = 0;

  /**
   * User decision 2026-09-28: as `docker image ls --filter reference=devenv-*`: the images whose repository starts with
   * `devenv-`, each ID once with its references (the ID as inspectImageNames gives it).
   */
  async listEnvironmentImages(): Promise<ImageInfo[]> {
    this.environmentImageLists++;
    const byId = new Map<string, ImageInfo>();
    for (const reference of this.images) {
      if (reference.includes('@')) continue;
      // Docker stores and lists a name of Docker Hub without its registry and `library/`; `*` of the filter does not
      // match `/`.
      const name = reference.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '').replace(/^library\//, '');
      if (!/^devenv-[^/]*$/.test(name)) continue;
      const tagged = name.includes(':') ? name : `${name}:latest`;
      const id = this.imageIds.get(reference) ?? `sha256:image-of-${reference}`;
      const image = byId.get(id) ?? { id, tags: [], createdAt: '' };
      if (!image.tags.includes(tagged)) image.tags.push(tagged);
      byId.set(id, image);
    }
    return [...byId.values()];
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

  /** `labels` default: the label nimblescape.devenv.container-version of the current setup. */
  addContainer(p: {
    environmentId: string;
    name: string;
    state: ContainerState;
    image: string;
    labels?: Record<string, string>;
    /** Review round 11 (G4): as `docker inspect` reads them (HostConfig.Mounts). */
    volumeSubpaths?: ContainerInfo['volumeSubpaths'];
  }): ContainerInfo {
    const id = `container-${++this.counter}`;
    const container: ContainerInfo = {
      id,
      name: p.name,
      state: p.state,
      rawState: p.state === 'running' ? 'running' : 'exited',
      labels: { ...(p.labels ?? { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION) }), [LABEL_ENVIRONMENT_ID]: p.environmentId },
      image: p.image,
      // Review round 1 of PR #88 (A-R1-1): as Docker records it, the ID of the image at the creation of the container.
      ...(this.images.has(p.image) ? { imageId: this.imageIds.get(p.image) ?? `sha256:image-of-${p.image}` } : {}),
      ...(p.volumeSubpaths !== undefined ? { volumeSubpaths: p.volumeSubpaths } : {}),
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
 * these make a volume the environment's own. `owner` null: a volume without the label nimblescape.devenv.owner-id (made
 * by hand).
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

/** Recreate offer, review round 2: the configuration hash of a service in the fakes (Compose computes its own). */
export function fakeServiceHash(service: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(service ?? null)).digest('hex');
}

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
  /**
   * Plan step 6, PR A: the tag of the helper image exists, so ensureImagePresent (the D1 step before the lock, which
   * only builds a missing tag) succeeds while `ensureImageError` fails the maintaining ensureImageUse of the open (for
   * example a failed rebuild of the tag). Default false: `ensureImageError` fails both.
   */
  tagPresent = false;
  /** Review round 3 of PR #64 (P2): the ID of the image of the current tag `devenv-helper:test`, which the open pins. */
  currentHelperImageId = `sha256:${'4'.repeat(64)}`;
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
   * Review round 3 of PR #68 (test gap of A-R2-3): like Compose, `up` creates the dev container again when its name is not
   * the `container_name` of its service (the configuration hash of Compose covers the name). Off by default: the tests
   * of the final review (FF-1, FC-1) expect the renamed previous dev container to be started as it is.
   */
  composeRecreatesRenamedDevContainer = false;
  /**
   * A lifecycle command fails after `up` created or started the container, which keeps running: the description of the
   * CLI, for example `postStartCommand from devcontainer.json failed.` (lifecycle token, user decision 2026-09-27: in
   * runUserCommands).
   */
  lifecycleFailure: (image: string) => Maybe<string> = () => undefined;
  /**
   * How runUserCommands reports a lifecycle failure: `error` as the CLI does (DevcontainerCommandError with the JSON
   * result), or `result` as WorkspaceHelper.runUserCommands does for a running container (outcome success with
   * `lifecycleCommandFailure`).
   */
  lifecycleFailureReport: 'error' | 'result' = 'error';
  /** Named volumes that a container created by `up` mounts besides the workspace volume. */
  containerVolumes: string[] = [];
  /**
   * Review round 12 (D12-2): the mounts of the dev container that `up` creates, as `docker inspect` reads them
   * (ContainerInfo.mountTargets). For Docker Compose, the volumes of the dev service of the model come first.
   */
  containerMounts: MountTarget[] = [];
  prepareGitError: Maybe<Error>;
  /** More entries of the label devcontainer.metadata of a built image (for example of a Feature). */
  buildMetadata: Array<Record<string, unknown>> = [];
  /** More labels of a built image (for example of its base image). */
  buildLabels: Record<string, string> = {};
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
  /**
   * Lifecycle token (user decision 2026-09-27): each runUserCommands, with the inputs it got, the number of `up` calls
   * before it, and the token writes into its container before it (FakeDocker.tokenWrites).
   */
  readonly userCommandRuns: Array<{
    containerId: string;
    environmentId: string;
    override: Record<string, unknown>;
    files?: Readonly<Record<string, string>>;
    env?: Record<string, string>;
    upsBefore: number;
    tokenWritesBefore: number;
  }> = [];
  /**
   * Review PL-1/PL-2: for each runUserCommands, the number of FakeDocker execs before it (to order the execs in the
   * container, such as HOME_GIT_CONFIG_SCRIPT, against it) and the token it got for the redaction of its output.
   */
  readonly userCommandContext: Array<{ execsBefore: number; token?: string }> = [];
  /** Review PL-1: the token that each `up` got for the redaction of its output. */
  readonly upTokens: Array<string | undefined> = [];
  /** runUserCommands fails with this error (not a lifecycle failure: that is lifecycleFailure). */
  userCommandsError: Maybe<Error>;
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
  /** Each write of the Git configuration into the volume (unit 15: without the token, FakeDocker.tokenWrites has it). */
  readonly gitPreparations: Array<{
    volumeName: string;
    repository: string;
    identity: { name: string; email: string };
  }> = [];
  /**
   * Review round 2 of PR #64 (A-N1): the helper image (`image`) that each helper run of the pipeline got, by the name of
   * the call.
   */
  readonly helperImages: Array<{ call: string; image?: HelperImageUse }> = [];

  private usedImage(call: string, image: HelperImageUse | undefined): void {
    this.helperImages.push(image === undefined ? { call } : { call, image: { ...image } });
  }

  /** Volumes that a helper run created silently (the real helper does this for a missing volume). Must stay empty. */
  readonly silentlyCreatedVolumes: string[] = [];

  constructor(private readonly docker: FakeDocker) {}

  private mount(volumeName: string): void {
    if (!this.docker.volumes.has(volumeName)) {
      this.docker.volumes.set(volumeName, {});
      this.silentlyCreatedVolumes.push(volumeName);
    }
  }

  /** Recorded in `calls` as `ensureImage` (review round 3 of PR #64, P1: the variant that returns the HelperImageUse). */
  async ensureImageUse(_options: { onOutput?: (text: string) => void } = {}): Promise<HelperImageUse> {
    this.calls.push('ensureImage');
    if (this.ensureImageError) throw this.ensureImageError;
    return { tag: 'devenv-helper:test', id: this.currentHelperImageId };
  }

  /**
   * PR #74 review round 1 (A-R1-1): the non-maintaining ensure before the environment lock, recorded in `calls` as
   * `ensureImagePresent`; fails with `ensureImageError` like ensureImageUse.
   */
  async ensureImagePresent(_options: { onOutput?: (text: string) => void; signal?: AbortSignal } = {}): Promise<HelperImageUse> {
    this.calls.push('ensureImagePresent');
    if (this.ensureImageError && !this.tagPresent) throw this.ensureImageError;
    return { tag: 'devenv-helper:test', id: this.currentHelperImageId };
  }

  async clone(p: { volumeName: string; repository: string; branch?: string; token: string; image?: HelperImageUse; signal?: AbortSignal }): Promise<void> {
    this.usedImage('clone', p.image);
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

  async readConfigFiles(p: { volumeName: string; configPath: string; dockerfile?: string; image?: HelperImageUse }): Promise<FakeFiles | undefined> {
    this.usedImage('readConfigFiles', p.image);
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

  async listConfigurations(p: { volumeName: string; image?: HelperImageUse }): Promise<string[]> {
    this.usedImage('listConfigurations', p.image);
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
    image?: HelperImageUse;
  }): Promise<{ config: DevcontainerConfig; merged?: Record<string, unknown> }> {
    this.usedImage('readConfiguration', p.image);
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

  async composeModel(p: { volumeName: string; files: readonly string[]; project: string; image?: HelperImageUse }): Promise<ComposeModelOutput | { error: string }> {
    this.usedImage('composeModel', p.image);
    this.mount(p.volumeName);
    this.calls.push(`composeModel ${p.project}`);
    this.composeModels.push({ files: [...p.files], project: p.project });
    if (this.composeOutput instanceof Error) throw this.composeOutput;
    return JSON.parse(JSON.stringify(this.composeOutput)) as ComposeModelOutput | { error: string };
  }

  /** Review round 8 (P8-2): the folders of each createRepositoryFolders. */
  readonly createdFolders: string[][] = [];
  createFoldersError: Maybe<Error>;

  async createRepositoryFolders(p: { volumeName: string; repository: string; folders: readonly string[]; image?: HelperImageUse }): Promise<void> {
    this.usedImage('createRepositoryFolders', p.image);
    this.mount(p.volumeName);
    this.calls.push(`createRepositoryFolders ${p.folders.join(' ')}`);
    this.createdFolders.push([...p.folders]);
    if (this.createFoldersError) throw this.createFoldersError;
  }

  async prepareGit(p: { volumeName: string; repository: string; identity: { name: string; email: string }; image?: HelperImageUse }): Promise<void> {
    this.usedImage('prepareGit', p.image);
    this.mount(p.volumeName);
    this.calls.push('prepareGit');
    this.gitPreparations.push({ volumeName: p.volumeName, repository: p.repository, identity: { ...p.identity } });
    if (this.prepareGitError) throw this.prepareGitError;
  }

  async build(p: {
    volumeName: string;
    configPath: string;
    imageName: string;
    override?: Record<string, unknown>;
    files?: Readonly<Record<string, string>>;
    env?: Record<string, string>;
    image?: HelperImageUse;
    signal?: AbortSignal;
  }): Promise<DevcontainerResult> {
    this.usedImage('build', p.image);
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
    const config = imageConfigWithUser(this.remoteUser, this.buildMetadata);
    this.docker.imageConfigs.set(p.imageName, { ...config, Labels: { ...this.buildLabels, ...config.Labels } });
    return { outcome: 'success', imageName: p.imageName };
  }

  async up(p: {
    volumeName: string;
    override: Record<string, unknown>;
    environmentId: string;
    removeExistingContainer: boolean;
    files?: Readonly<Record<string, string>>;
    env?: Record<string, string>;
    token?: string;
    image?: HelperImageUse;
  }): Promise<DevcontainerResult> {
    this.usedImage('up', p.image);
    this.mount(p.volumeName);
    this.upTokens.push(p.token);
    if (p.override.dockerComposeFile !== undefined) return this.composeUp(p);
    const image = String(p.override.image);
    this.calls.push(`up ${image}${p.removeExistingContainer ? ' --remove-existing-container' : ''}`);
    this.ups.push({ image, removeExistingContainer: p.removeExistingContainer, override: p.override });
    const existing = this.docker.containersOf(p.environmentId)[0];
    const error = this.upError(image, p.removeExistingContainer);
    // Review round 14 of PR #64 (R14-4): a helperFailed of `up` means that its helper container never started, so the CLI
    // removed nothing (R13-2).
    if (error && (this.upFailsBeforeRemoval || (error instanceof UserFacingError && error.code === 'helperFailed'))) throw error;
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
      if (this.containerMounts.length > 0) {
        this.docker.containers.set(created.id, { ...(this.docker.containers.get(created.id) ?? created), mountTargets: [...this.containerMounts] });
      }
      containerId = created.id;
    }
    // Lifecycle token (user decision 2026-09-27): `up --skip-post-create` runs no lifecycle command; lifecycleFailure
    // fails in runUserCommands.
    return { outcome: 'success', containerId, remoteUser: this.remoteUser, remoteWorkspaceFolder: workspaceFolder };
  }

  /**
   * Lifecycle token (user decision 2026-09-27): `devcontainer run-user-commands` in the container of `up`. A lifecycle
   * failure (lifecycleFailure of the image of the container) as the CLI reports it: an error whose result names the
   * container (WorkspaceHelper.runUserCommands adds it), or with lifecycleFailureReport `result`, the kept container.
   */
  /**
   * Recreate offer, review round 2: the configuration hashes of composeServiceHashes by service, or an error. Default:
   * fakeServiceHash of each service of the model, which the containers that composeUp creates carry too.
   */
  serviceHashes: Record<string, string> | Error | undefined;
  readonly hashModels: string[] = [];

  async composeServiceHashes(p: { model: string; project: string; image?: HelperImageUse }): Promise<Map<string, string>> {
    this.usedImage('composeServiceHashes', p.image);
    this.calls.push(`composeServiceHashes ${p.project}`);
    this.hashModels.push(p.model);
    if (this.serviceHashes instanceof Error) throw this.serviceHashes;
    if (this.serviceHashes !== undefined) return new Map(Object.entries(this.serviceHashes));
    const model = JSON.parse(p.model) as ComposeModel;
    return new Map(Object.entries(model.services).map(([name, service]) => [name, fakeServiceHash(service)]));
  }

  async runUserCommands(p: {
    volumeName: string;
    override: Record<string, unknown>;
    environmentId: string;
    containerId: string;
    files?: Readonly<Record<string, string>>;
    env?: Record<string, string>;
    token?: string;
    image?: HelperImageUse;
  }): Promise<DevcontainerResult> {
    this.usedImage('runUserCommands', p.image);
    this.mount(p.volumeName);
    this.userCommandContext.push({ execsBefore: this.docker.execs.length, token: p.token });
    this.userCommandRuns.push({
      containerId: p.containerId,
      environmentId: p.environmentId,
      override: p.override,
      ...(p.files !== undefined ? { files: p.files } : {}),
      ...(p.env !== undefined ? { env: p.env } : {}),
      upsBefore: this.ups.length,
      tokenWritesBefore: this.docker.tokenWrites().filter((write) => write.container === p.containerId).length,
    });
    if (this.userCommandsError) throw this.userCommandsError;
    const container = this.docker.containers.get(p.containerId);
    const failure = container !== undefined ? this.lifecycleFailure(container.image) : undefined;
    if (failure !== undefined) {
      if (this.lifecycleFailureReport === 'result') return { outcome: 'success', containerId: p.containerId, lifecycleCommandFailure: failure } as DevcontainerResult;
      const result: DevcontainerResult = { outcome: 'error', message: 'Command failed: /bin/sh -c npm run db:migrate', description: failure, containerId: p.containerId };
      throw new DevcontainerCommandError('devcontainer run-user-commands', 1, `${JSON.stringify(result)}\n`, 'npm ERR! code 1', result);
    }
    return { outcome: 'success', containerId: p.containerId };
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
    // Review round 14 of PR #64 (R14-4): a helperFailed of `up` means that its helper container never started, so the CLI
    // removed nothing (R13-2).
    if (error && (this.upFailsBeforeRemoval || (error instanceof UserFacingError && error.code === 'helperFailed'))) throw error;
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
    const subpathMounts = (entries: unknown): NonNullable<ContainerInfo['volumeSubpaths']> =>
      (Array.isArray(entries) ? entries : []).flatMap((entry: { type?: string; source?: string; read_only?: boolean; volume?: { subpath?: string } }) =>
        entry.type === 'volume' && entry.source === WORKSPACE_VOLUME_KEY && typeof entry.volume?.subpath === 'string'
          ? [{ volume: p.volumeName, subpath: entry.volume.subpath, readOnly: entry.read_only === true }]
          : [],
      );
    const create = (name: string, containerName: string, serviceImage: string, labels: unknown, volumes: string[]): ContainerInfo => {
      if (!this.docker.images.has(serviceImage)) throw new DevcontainerCommandError('devcontainer up', 1, '', `Error: No such image: ${serviceImage}`);
      // Review round 22 (D22-1): like Docker, a name that another container has already is a conflict.
      if ([...this.docker.containers.values()].some((c) => c.name === containerName)) {
        throw new DevcontainerCommandError('devcontainer up', 1, '', `Error response from daemon: Conflict. The container name "/${containerName}" is already in use`);
      }
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
          // Recreate offer, review round 2: as Compose, the hash of the service in the model and the ID of its image.
          'com.docker.compose.config-hash': fakeServiceHash(model.services[name]),
          'com.docker.compose.image': this.docker.imageIds.get(serviceImage) ?? `sha256:image-of-${serviceImage}`,
        },
      });
      if (volumes.length > 0) this.docker.containers.set(created.id, { ...created, volumes });
      // Review round 11 (G3, G4): the subpaths of the workspace volume that the service mounts, as Docker inspects them.
      if (name !== service) {
        const volumeSubpaths = subpathMounts(model.services[name]?.volumes);
        if (volumeSubpaths.length > 0) this.docker.containers.set(created.id, { ...(this.docker.containers.get(created.id) ?? created), volumeSubpaths });
      }
      return this.docker.containers.get(created.id) ?? created;
    };
    let containerId: string;
    const renamed =
      this.composeRecreatesRenamedDevContainer && existing !== undefined && typeof dev.container_name === 'string' && existing.name !== dev.container_name;
    if (existing && renamed && !p.removeExistingContainer) {
      this.docker.log.push(`compose recreate ${existing.id}`);
      this.docker.containers.delete(existing.id);
    }
    if (existing && !renamed && !p.removeExistingContainer) {
      existing.state = 'running';
      existing.rawState = 'running';
      containerId = existing.id;
    } else {
      const volumes = [...volumeNames(dev.volumes), ...this.containerVolumes];
      containerId = create(service, String(dev.container_name), image, dev.labels, volumes).id;
      // Review round 12 (D12-2): the mounts of the dev service, as `docker inspect` reads them.
      const mountTargets: MountTarget[] = [
        ...(Array.isArray(dev.volumes) ? dev.volumes : []).flatMap((entry: { type?: string; source?: string; target?: string; volume?: { subpath?: unknown } }) => {
          if (typeof entry.target !== 'string' || typeof entry.type !== 'string') return [];
          const name = entry.type === 'volume' && entry.source ? (entry.source === WORKSPACE_VOLUME_KEY ? p.volumeName : model.volumes?.[entry.source]?.name) : undefined;
          // Review round 14 (P14-1): the subpath, as `HostConfig.Mounts` has it.
          const subpath = typeof name === 'string' && typeof entry.volume?.subpath === 'string' && entry.volume.subpath !== '' ? entry.volume.subpath : undefined;
          return [{ type: entry.type, ...(typeof name === 'string' ? { volume: name } : {}), target: entry.target, ...(subpath !== undefined ? { subpath } : {}) }];
        }),
        ...this.containerMounts,
      ];
      if (mountTargets.length > 0) this.docker.containers.set(containerId, { ...this.docker.containers.get(containerId)!, mountTargets });
    }
    const runServices = Array.isArray(p.override.runServices) ? (p.override.runServices as string[]) : Object.keys(model.services);
    for (const name of runServices) {
      if (name === service) continue;
      const other = ofProject(name);
      const definition = model.services[name];
      // Review round 22 (D22-1): Compose creates a container again when its configuration changed (here: the label of the
      // service, for example the previous dev container, which becomes another service).
      const labelsOf = (value: unknown): Record<string, string> => (value !== null && typeof value === 'object' ? (value as Record<string, string>) : {});
      if (other && other.labels[LABEL_COMPOSE_SERVICE] !== labelsOf(definition.labels)[LABEL_COMPOSE_SERVICE]) {
        this.docker.log.push(`compose recreate ${other.id}`);
        this.docker.containers.delete(other.id);
      } else if (other) {
        other.state = 'running';
        other.rawState = 'running';
        continue;
      }
      create(name, `${project}-${name}-1`, String(definition.image), definition.labels, volumeNames(definition.volumes));
    }
    // Lifecycle token (user decision 2026-09-27): lifecycleFailure fails in runUserCommands.
    return {
      outcome: 'success',
      containerId,
      composeProjectName: this.composeProjectNameResult ?? project,
      remoteUser: this.remoteUser,
      remoteWorkspaceFolder: String(p.override.workspaceFolder),
    };
  }

  /** Review round 15 (K3): each fixConfigOwnership (the fix of the internal folder in a helper container). */
  readonly configOwnershipFixes: Array<{ volumeName: string; folder: string; uid: string; gid: string }> = [];
  /** Result of fixConfigOwnership (an Error is thrown). */
  configOwnershipResult: Partial<RunResult> | Error = {};

  async fixConfigOwnership(p: { volumeName: string; folder: string; uid: string; gid: string; image?: HelperImageUse }): Promise<RunResult> {
    this.usedImage('fixConfigOwnership', p.image);
    this.mount(p.volumeName);
    this.configOwnershipFixes.push({ volumeName: p.volumeName, folder: p.folder, uid: p.uid, gid: p.gid });
    if (this.configOwnershipResult instanceof Error) throw this.configOwnershipResult;
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...this.configOwnershipResult };
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
  /** Recreate offer (user request 2026-09-26): the answer to recreateContainer, and its questions. */
  recreateAnswer = false;
  readonly recreateQuestions: Array<{ message: string; detail: string }> = [];
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

  async recreateContainer(repository: string, question: { message: string; detail: string }): Promise<boolean> {
    this.prompts.push(`recreateContainer ${repository}`);
    this.recreateQuestions.push(question);
    return this.recreateAnswer;
  }

  // Plan step 11C2b: the questions of Delete; by default Delete, Keep, nothing ticked.
  deleteAnswer: 'delete' | 'open' | undefined = 'delete';
  additionalVolumesAnswer: 'remove' | 'keep' | undefined = 'keep';
  serviceDataAnswer: string[] | undefined = [];

  async confirmDelete(_repository: string, _confirmation?: DeleteConfirmation): Promise<'delete' | 'open' | undefined> {
    return this.deleteAnswer;
  }

  async deleteAdditionalVolumes(): Promise<'remove' | 'keep' | undefined> {
    return this.additionalVolumesAnswer;
  }

  async deleteServiceData(): Promise<string[] | undefined> {
    return this.serviceDataAnswer;
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
  /** Plan step 5, PR B (D1: no unlocked path): the default lock of the service. */
  lock: FakeEnvironmentLock;
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

/**
 * Plan step 5, PR B (D1: no unlocked path): the lock of the environments for the tests that are not about the lock
 * (EnvironmentServiceDeps.environmentLock is required). It grants every lock and records each acquire and release.
 * `docker`: the plain Docker calls under the lock (a ContainerAdapter sends them to the lock); without it they fail.
 */
export class FakeEnvironmentLock {
  readonly acquired: string[] = [];
  readonly released: string[] = [];

  constructor(private readonly docker?: (args: readonly string[], options: Pick<RunOptions, 'timeoutMs' | 'signal'>) => Promise<RunResult>) {}

  readonly take = async (environmentId: string): Promise<HeldEnvironmentLock> => {
    this.acquired.push(environmentId);
    return {
      environmentId,
      lost: new Promise<string>(() => {}),
      docker: async (args, options) => {
        if (this.docker === undefined) throw new Error('The fake lock runs no Docker call.');
        return this.docker(args, options);
      },
      release: async () => {
        this.released.push(environmentId);
      },
    };
  };
}

/**
 * Plan step 11B2: the port of the engine of the flows over the FakeDocker of the tests, so that a flow of the worker runs
 * against the same state as the rest of the pipeline. The order of insertion is the order of creation.
 */
export function fakeDockerEngine(docker: FakeDocker): DockerEngine {
  const engineContainer = (container: ContainerInfo, index: number): EngineContainer => ({
    id: container.id,
    name: container.name,
    state: container.state === 'running' ? 'running' : 'stopped',
    rawState: container.rawState ?? container.state,
    labels: { ...container.labels },
    image: container.image ?? '',
    created: new Date(T0 + index * 1000).toISOString(),
  });
  const all = () => [...docker.containers.values()];
  return {
    ...unusedEngine(),
    container: async (reference) => {
      const index = all().findIndex((c) => c.id === reference || c.name === reference);
      return index < 0 ? undefined : engineContainer(all()[index], index);
    },
    containers: async (label) => {
      const [key, value] = label.split('=', 2);
      return all()
        .map((container, index) => ({ container, index }))
        .filter(({ container }) => (value === undefined ? key in container.labels : container.labels[key] === value))
        .map(({ container, index }) => engineContainer(container, index));
    },
    exec: async (container, command, options = {}) => {
      const result = await docker.exec(container, command, { user: options.user, signal: options.signal, timeoutMs: options.timeoutMs, input: options.input });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut ?? false };
    },
    stop: async (container) => docker.stopContainer(container),
    start: async (container) => docker.startContainer(container),
  };
}

/**
 * Plan step 11B2: EnvironmentServiceDeps.flow as the worker serves it, for the unit tests: the helper image of the
 * worker first (as HelperChannels opens it), the lock of the environment through `lock` (as the operation takes it
 * itself), then the flow over fakeDockerEngine. The refusals are those of the channel and the worker.
 */
export function fakeWorkerFlow(h: Pick<Harness, 'docker' | 'helper' | 'logger' | 'clock'>, lock: EnvironmentServiceDeps['environmentLock']): EnvironmentServiceDeps['flow'] {
  return async (op, params, options) => {
    // Plan step 11C1: the reads of an attached window, over the same FakeDocker (no lock, no helper image).
    if (op === OP_WINDOW_STATE) {
      const checked = parseWindowStateParams(params);
      if (checked === undefined) throw new HelperOperationError('invalid', 'The parameters of the windowState operation are invalid.', false);
      return windowStateFlow({ ...checked, docker: new EngineDocker(fakeDockerEngine(h.docker), h.logger), signal: options.signal });
    }
    if (op !== OP_STOP) throw new HelperChannelError('unsendable', `The worker of the tests does not know the operation ${op}.`);
    try {
      await h.helper.ensureImagePresent({ signal: options.signal });
    } catch (error) {
      const cause = error instanceof UserFacingError && error.detail ? `${error.message} ${error.detail}` : (error as Error).message;
      throw new HelperChannelError('unavailable', cause);
    }
    const checked = parseStopParams(params);
    if (checked === undefined) throw new HelperOperationError('invalid', 'The parameters of the stop operation are invalid.', false);
    let held: HeldEnvironmentLock;
    try {
      held = await lock(checked.environmentId, checked.waitSeconds, options.signal);
    } catch (error) {
      if (error instanceof EnvironmentLockError) {
        if (error.kind === 'busy') throw new HelperOperationError(LOCK_BUSY_CODE, error.message, false);
        // As the worker (review round 1 of 11B2, A-R1-3): a lock that could not be taken otherwise.
        throw new HelperOperationError(LOCK_UNAVAILABLE_CODE, error.message, false);
      }
      throw error;
    }
    try {
      return await stopFlow({
        environmentId: checked.environmentId,
        containerName: checked.containerName,
        folder: checked.folder,
        ...(checked.user !== undefined ? { user: checked.user } : {}),
        engine: fakeDockerEngine(h.docker),
        log: (line) => h.logger.info(line),
        now: () => new Date(h.clock.now()).toISOString(),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new HelperOperationError('failed', (error as Error).message, false);
    } finally {
      await held.release();
    }
  };
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
    lock: new FakeEnvironmentLock(),
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
    // Review round 8: the analysis in this thread (the worker is tested in configurationAnalysisRunner.test.ts).
    analyzer: inProcessAnalyzer,
    // Plan step 5, PR B (D1: no unlocked path): a lock that is always granted, for the tests that are not about it.
    environmentLock: h.lock.take,
    // Plan step 11B2: the flows of the worker against the same FakeDocker, under the lock of the service.
    flow: fakeWorkerFlow(h, overrides.environmentLock ?? h.lock.take),
    // Plan step 11C1: the refresh of the worker, which reads the same FakeDocker.
    workerRefresh: (environments) => readEnvironmentStates(h.docker, environments),
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
  /** Labels of the container. Default: the label nimblescape.devenv.container-version of the current setup. */
  containerLabels?: Record<string, string>;
  /** Default: ACCOUNT. */
  owner?: GitHubAccount;
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
          environmentImage: environmentImageName(repository, id, 1),
          imageId: `sha256:image-of-${environmentImageName(repository, id, 1)}`,
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
    owner: options.owner ?? ACCOUNT,
    ...options.extra,
  };
  await h.registry.add(environment);
  if (options.volume !== false) {
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [LABEL_OWNER_ID]: environment.owner.id });
  }
  if (record && options.image !== false) {
    h.docker.images.add(record.environmentImage);
    h.docker.imageConfigs.set(record.environmentImage, imageConfigWithUser('vscode'));
  }
  const state = options.container === undefined ? 'stopped' : options.container;
  if (state !== null) {
    h.docker.addContainer({ environmentId: id, name, state, image: record?.environmentImage ?? environmentImageName(repository, id, 1), labels: options.containerLabels });
  }
  return environment;
}
