// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3 (section 0 of the plan, one concept for commanding Docker): the Docker of the pipeline
// (EnvironmentDocker) over the port of the worker's engine (DockerEngine, the Engine API). It answers as ContainerAdapter
// answers over the Docker CLI, method by method, so that EnvironmentService runs unchanged in the worker (plan steps
// 11B3 and 11E); the inspect JSON is read by the same functions (dockerObjects.ts). Pure over the port; no I/O, no
// `vscode`.
import { mapContainerState, preferred, publicInfo, toLabels, toNetworkInfo, toVolumeInfo, type ContainerInfo, type ImageInfo, type InspectedContainer, type NetworkInfo, type VolumeInfo } from '../docker/dockerObjects';
import type { ImageInspection, ImageNames, VolumeRun } from '../docker/containerAdapter';
import { errorMessage } from '../errors';
import { SECRET_REGISTRY } from '../helperChannel/protocol';
import { LABEL_ENVIRONMENT_ID } from '../names';
import type { EnvironmentDocker } from '../pipeline/environmentService';
import type { PullCredentials } from '../pipeline/pullCredentials';
import { abortError, isAbortError, silentLogger, type Logger, type RunResult } from '../ports';
import type { ContainerState } from '../types';
import { credentialServerName } from '../imageCheck/reference';
import { IDENTITY_TOKEN_USER } from '../imageCheck/credentials';
import { EngineError, isDevContainer, isMissing, type DockerEngine, type EngineContainer } from './dockerEngine';

/** Label that Docker Compose gives each container, network, and volume of a project. */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/** An Engine API answer about the reference itself (400): an invalid reference, as `docker image inspect` reports it. */
const INVALID_REFERENCE = 400;

/** As ContainerAdapter.listImageTags: sorted by tag, numbers numerically. */
function sortedTags(repository: string, tags: Iterable<string>): string[] {
  return [...new Set(tags)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((tag) => `${repository}:${tag}`);
}

function inspected(container: EngineContainer): InspectedContainer {
  return { ...container, created: container.created ?? '' };
}

/**
 * Plan step 11B3: EnvironmentDocker over the port. `secretOf` gives the secrets of the operation (the registry login of a
 * pull is one of them, SECRET_REGISTRY).
 */
export class EngineDocker implements EnvironmentDocker {
  constructor(
    private readonly engine: DockerEngine,
    private readonly logger: Logger = silentLogger,
    private readonly secretOf: (name: string) => string | undefined = () => undefined,
  ) {}

  /** As `docker info`: the engine answers. Rejects only with an AbortError. */
  async isRunning(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.engine.version(signal);
      return true;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      return false;
    }
  }

  async engineApiVersion(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { apiVersion } = await this.engine.version(signal);
      if (/^\d+\.\d+$/.test(apiVersion)) return apiVersion;
      this.logger.warn(`The API version of the Docker Engine could not be read: ${apiVersion || 'none'}`);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      this.logger.warn(`The API version of the Docker Engine could not be read: ${errorMessage(error)}`);
    }
    return undefined;
  }

  async imageConfig(reference: string, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    const value = (await this.engine.inspect('image', reference, options.signal)) as { Config?: unknown } | undefined;
    if (value === undefined) throw new EngineError(`No such image: ${reference}`, 404);
    return value.Config ?? null;
  }

  async runOnVolume(p: VolumeRun, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const result = await this.engine.runContainer(
      { image: p.image, entrypoint: p.entrypoint, args: p.args, user: p.user, labels: p.labels, volumes: [{ name: p.volume, target: p.target }] },
      options,
    );
    if (result.timedOut) throw new EngineError(`The container of ${p.image} on ${p.volume} did not end in time.`, 0);
    if (result.exitCode !== 0) throw new EngineError(`The container of ${p.image} on ${p.volume} failed with exit code ${result.exitCode ?? 'none'}: ${result.output.trim().slice(-2000)}`, 0);
  }

  containerIdsWithLabel(label: string, options: { signal?: AbortSignal } = {}): Promise<string[]> {
    return this.engine.containerIds({ label: [label] }, options.signal);
  }

  /** As ContainerAdapter.findContainer: the dev container (isDevContainer), the named one first, else running, else newest. */
  async findContainer(environmentId: string, containerName: string): Promise<ContainerInfo | undefined> {
    const containers = (await this.engine.containers(`${LABEL_ENVIRONMENT_ID}=${environmentId}`)).filter((container) => isDevContainer(container, containerName));
    if (containers.length === 0) return undefined;
    if (containers.length > 1) {
      this.logger.warn(`${containers.length} containers have the label ${LABEL_ENVIRONMENT_ID}=${environmentId}: ${containers.map((c) => c.name).join(', ')}`);
    }
    const named = containers.find((container) => container.name === containerName);
    return publicInfo(named !== undefined ? inspected(named) : [...containers.map(inspected)].sort(preferred)[0]);
  }

  async listEnvironmentContainers(): Promise<ContainerInfo[]> {
    return (await this.engine.containers(LABEL_ENVIRONMENT_ID)).map((container) => publicInfo(inspected(container)));
  }

  async listProjectContainers(project: string): Promise<ContainerInfo[]> {
    return (await this.engine.containers(`${COMPOSE_PROJECT_LABEL}=${project}`)).map((container) => publicInfo(inspected(container)));
  }

  listProjectNetworks(project: string): Promise<string[]> {
    return this.engine.networkNames({ label: [`${COMPOSE_PROJECT_LABEL}=${project}`] });
  }

  async removeNetwork(name: string): Promise<void> {
    this.logger.info(`Removing network ${name}.`);
    await this.engine.removeNetwork(name);
  }

  /** As ContainerAdapter.listProjectImages: `<project>-*` images with a tag; with `environmentId`, only its own. */
  async listProjectImages(project: string, environmentId?: string): Promise<string[]> {
    const images = await this.engine.images({ reference: [`${project}-*`] });
    const tags = new Set<string>();
    const foreign = new Set<string>();
    for (const image of images) {
      const own = image.repoTags.filter((tag) => tag.startsWith(`${project}-`) && !tag.endsWith(':<none>'));
      for (const tag of own) tags.add(tag);
      if (environmentId !== undefined && image.labels[LABEL_ENVIRONMENT_ID] !== environmentId) for (const tag of image.repoTags) foreign.add(tag);
    }
    return [...tags].sort().filter((tag) => !foreign.has(tag));
  }

  async containerState(nameOrId: string): Promise<ContainerState> {
    const container = await this.engine.container(nameOrId);
    return container === undefined ? 'missing' : mapContainerState(container.rawState);
  }

  async stopContainer(nameOrId: string): Promise<void> {
    this.logger.info(`Stopping container ${nameOrId}.`);
    try {
      await this.engine.stop(nameOrId);
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.logger.info(`Container ${nameOrId} does not exist.`);
    }
  }

  async renameContainer(nameOrId: string, newName: string): Promise<void> {
    this.logger.info(`Renaming container ${nameOrId} to ${newName}.`);
    await this.engine.renameContainer(nameOrId, newName);
  }

  async removeContainer(nameOrId: string): Promise<void> {
    this.logger.info(`Removing container ${nameOrId}.`);
    await this.engine.removeContainer(nameOrId);
  }

  /**
   * As ContainerAdapter.exec. `secretInput` is a secret that the operation holds (the worker got it through its request,
   * plan step 11A); it is the standard input of the process, never an argument.
   */
  async exec(
    container: string,
    command: readonly string[],
    options: { user?: string; workdir?: string; input?: string; secretInput?: string; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    if (options.input !== undefined && options.secretInput !== undefined) throw new Error('A docker exec has either an input or a secret input.');
    const input = options.secretInput ?? options.input;
    return this.engine.exec(container, command, {
      ...(options.user ? { user: options.user } : {}),
      ...(options.workdir ? { workdir: options.workdir } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  async volumeExists(name: string): Promise<boolean> {
    return (await this.engine.inspect('volume', name)) !== undefined;
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    this.logger.info(`Creating volume ${name}.`);
    await this.engine.createVolume(name, labels);
  }

  async removeVolume(name: string): Promise<void> {
    this.logger.info(`Removing volume ${name}.`);
    await this.engine.removeVolume(name);
  }

  async listEnvironmentVolumes(signal?: AbortSignal): Promise<VolumeInfo[]> {
    const names = await this.engine.volumeNames({ label: [LABEL_ENVIRONMENT_ID] }, signal);
    // User decision 2026-09-28: a cancellation of the check of the images of the environments ends before the inspect.
    if (signal?.aborted) throw abortError();
    return this.inspectVolumes(names);
  }

  async inspectVolumes(names: readonly string[]): Promise<VolumeInfo[]> {
    const volumes: VolumeInfo[] = [];
    for (const name of new Set(names)) {
      const volume = toVolumeInfo(await this.engine.inspect('volume', name));
      if (volume !== undefined) volumes.push(volume);
    }
    return volumes;
  }

  async inspectNetworks(names: readonly string[]): Promise<NetworkInfo[]> {
    const networks: NetworkInfo[] = [];
    for (const name of new Set(names)) {
      const network = toNetworkInfo(await this.engine.inspect('network', name));
      if (network !== undefined) networks.push(network);
    }
    return networks;
  }

  async imageExists(reference: string): Promise<boolean> {
    return (await this.engine.inspect('image', reference)) !== undefined;
  }

  async imageId(reference: string): Promise<string | undefined> {
    const value = (await this.engine.inspect('image', reference)) as { Id?: unknown } | undefined;
    if (value === undefined) return undefined;
    if (typeof value.Id !== 'string' || value.Id === '') throw new EngineError(`The engine answered the inspect of the image ${reference} without an ID.`, 200);
    return value.Id;
  }

  async imageLabels(reference: string): Promise<Record<string, string> | undefined> {
    const value = (await this.engine.inspect('image', reference)) as { Config?: { Labels?: unknown } } | undefined;
    return value === undefined ? undefined : toLabels(value.Config?.Labels);
  }

  /** As ContainerAdapter.imageLabelsOf: the labels by full image ID; a missing image is left out. */
  async imageLabelsOf(references: readonly string[], signal?: AbortSignal): Promise<Map<string, Record<string, string>>> {
    const labels = new Map<string, Record<string, string>>();
    for (const reference of references) {
      const value = (await this.engine.inspect('image', reference, signal)) as { Id?: unknown; Config?: { Labels?: unknown } } | undefined;
      if (signal?.aborted) throw abortError();
      if (value === undefined || typeof value.Id !== 'string' || value.Id === '') continue;
      labels.set(value.Id.toLowerCase(), toLabels(value.Config?.Labels));
    }
    return labels;
  }

  /**
   * As ContainerAdapter.labelImage (user decisions 2026-10-03), without a build (decision of 2026-10-03, no extra
   * containers where the API suffices: DockerEngine.labelImage). The previous image is removed only when nothing names it.
   */
  async labelImage(image: string, labels: Record<string, string>, signal?: AbortSignal): Promise<void> {
    const previous = await this.imageId(image);
    if (previous === undefined) throw new EngineError(`The image ${image} does not exist.`, 404);
    const now = await this.engine.labelImage(image, labels, signal);
    if (now === previous) return;
    try {
      const names = await this.imageNames(previous);
      if (names === undefined || names.repoTags.length > 0 || names.repoDigests.length > 0) return;
      await this.removeImage(previous);
    } catch (error) {
      this.logger.info(`The image ${previous} before the labels of ${image} was not removed: ${errorMessage(error)}`);
    }
  }

  /** As ContainerAdapter.imageNames. */
  async imageNames(reference: string): Promise<{ repoTags: string[]; repoDigests: string[] } | undefined> {
    const value = (await this.engine.inspect('image', reference)) as { RepoTags?: unknown; RepoDigests?: unknown } | undefined;
    if (value === undefined) return undefined;
    const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []);
    return { repoTags: texts(value.RepoTags), repoDigests: texts(value.RepoDigests) };
  }

  /**
   * As ContainerAdapter.inspectImageNames (review rounds 9 to 11 of PR #64): the images that the references find; a
   * reference that the engine refuses as such (400) is `invalid`; after the first other failure it asks no more, and
   * that reference and the rest are `transient`. Over the API each reference is one request (there is no batch).
   */
  async inspectImageNames(references: readonly string[], signal?: AbortSignal): Promise<ImageInspection> {
    const images: ImageNames[] = [];
    const unchecked: ImageInspection['unchecked'] = [];
    for (let index = 0; index < references.length; index++) {
      if (signal?.aborted) throw abortError();
      const reference = references[index];
      try {
        const value = (await this.engine.inspect('image', reference, signal)) as { Id?: unknown; RepoTags?: unknown; RepoDigests?: unknown } | undefined;
        if (value === undefined) continue;
        if (typeof value.Id !== 'string') throw new Error('an answer without an ID');
        const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []);
        images.push({ id: value.Id, repoTags: texts(value.RepoTags), repoDigests: texts(value.RepoDigests) });
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        if (error instanceof EngineError && error.status === INVALID_REFERENCE) {
          unchecked.push({ reference, reason: 'invalid' });
          continue;
        }
        this.logger.warn(`The inspect of the image ${reference} failed: ${errorMessage(error)}`);
        unchecked.push(...references.slice(index).map((rest) => ({ reference: rest, reason: 'transient' as const })));
        break;
      }
    }
    return { images, unchecked };
  }

  async removeImage(reference: string): Promise<boolean> {
    const outcome = await this.engine.removeImage(reference);
    if (outcome === 'removed') this.logger.info(`Removed image ${reference}.`);
    if (outcome === 'inUse') this.logger.info(`Image ${reference} is in use and was not removed.`);
    return outcome === 'removed';
  }

  /** As ContainerAdapter.listEnvironmentImages: the named images `devenv-*`, each once with its references. */
  async listEnvironmentImages(signal?: AbortSignal): Promise<ImageInfo[]> {
    const images = await this.engine.images({ reference: ['devenv-*'] }, signal);
    if (signal?.aborted) throw abortError();
    return images
      .map((image) => ({ id: image.id, tags: image.repoTags.filter((tag) => tag.startsWith('devenv-') && !tag.endsWith(':<none>')), createdAt: image.created }))
      .filter((image) => image.tags.length > 0);
  }

  async listImageTags(repository: string): Promise<string[]> {
    const images = await this.engine.images({ reference: [repository] });
    const tags: string[] = [];
    for (const image of images) {
      for (const tag of image.repoTags) {
        if (!tag.startsWith(`${repository}:`)) continue;
        const name = tag.slice(repository.length + 1);
        if (name !== '' && name !== '<none>') tags.push(name);
      }
    }
    return sortedTags(repository, tags);
  }

  async startContainer(id: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    await this.engine.start(id, options.signal);
  }

  /**
   * As ContainerAdapter.pullImage over the API. With `credentials`, their password must be the registry secret that the
   * operation holds (SECRET_REGISTRY: the worker got it through its request); it goes only into the header of the pull.
   */
  async pullImage(reference: string, options: { onOutput?: (text: string) => void; signal?: AbortSignal; credentials?: PullCredentials } = {}): Promise<void> {
    const onOutput = options.onOutput ?? ((text: string) => this.logger.output(text));
    const login = options.credentials;
    if (login !== undefined && this.secretOf(SECRET_REGISTRY) !== login.password) {
      throw new EngineError(`The pull of ${reference} with the credentials for ${login.registry} needs them as the registry secret of the operation.`, 0);
    }
    this.logger.info(login === undefined ? `Pulling image ${reference}.` : `Pulling image ${reference} with the credentials for ${login.registry}.`);
    await this.engine.pull(reference, {
      ...(login !== undefined
        ? {
            login:
              login.username === IDENTITY_TOKEN_USER
                ? { serveraddress: credentialServerName(login.registry), identityToken: true, secretName: SECRET_REGISTRY }
                : { serveraddress: credentialServerName(login.registry), username: login.username, secretName: SECRET_REGISTRY },
          }
        : {}),
      onLine: (line) => onOutput(`${line}\n`),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }
}

