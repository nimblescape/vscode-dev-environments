// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3 (section 0 of the plan, one concept for commanding Docker): the Docker of the pipeline
// (EnvironmentDocker) over the port of the worker's engine (DockerEngine, the Engine API). It answers as the Docker CLI
// answers (as the CLI adapter ContainerAdapter answered, method by method, until plan step 11I2 removed it; it is the one
// implementation of EnvironmentDocker now), so that EnvironmentService runs in the worker (plan steps 11B3 and 11E); the
// inspect JSON is read by the same functions as `docker inspect` (dockerObjects.ts). Pure over the port; no I/O, no
// `vscode`.
import { mapContainerState, preferred, publicInfo, toLabels, toNetworkInfo, toVolumeInfo, type ContainerInfo, type ImageInfo, type ImageInspection, type ImageNames, type InspectedContainer, type NetworkInfo, type VolumeInfo } from '../docker/dockerObjects';
import { DOCKER_INFO_TIMEOUT_MS, DOCKER_QUERY_TIMEOUT_MS } from '../docker/dockerTimeouts';
import { passwdUserIds, type UserIds } from '../docker/passwdUsers';
import { errorMessage } from '../errors';
import { SECRET_REGISTRY, SECRET_TOKEN, pullReference } from '../helperChannel/protocol';
import { COMPOSE_PROJECT_LABEL, LABEL_ENVIRONMENT_ID } from '../names';
import type { EnvironmentDocker } from '../pipeline/environmentService';
import { abortError, isAbortError, silentLogger, type Credentials, type Logger, type RunResult } from '../ports';
import type { ContainerState } from '../types';
import { credentialServerName, parseImageReference } from '../imageCheck/reference';
import { IDENTITY_TOKEN_USER } from '../imageCheck/credentials';
import { EngineError, isDevContainer, isMissing, type DockerEngine, type EngineContainer } from './dockerEngine';

/**
 * Registry credentials for one pull (pullImage). Plan step 11I (PR D): moved here from pipeline/pullCredentials.ts, whose
 * GitHub session for ghcr.io was never given to the worker's pipeline (the extension sends that login: vscode/hostSide.ts).
 */
interface PullCredentials extends Credentials {
  /** Registry host, for example `ghcr.io`. */
  registry: string;
}

/** An Engine API answer about the reference itself (400): an invalid reference, as `docker image inspect` reports it. */
const INVALID_REFERENCE = 400;

/** As listImageTags sorts them (as the Docker CLI adapter did): by tag, numbers numerically. */
function sortedTags(repository: string, tags: Iterable<string>): string[] {
  return [...new Set(tags)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((tag) => `${repository}:${tag}`);
}

function inspected(container: EngineContainer): InspectedContainer {
  return { ...container, created: container.created ?? '' };
}

/**
 * Plan step 11E3b (decision B1 of 2026-10-05): the logins of the registries of the operation, one at a time
 * (workerServices.registryLogins): `use` runs while the operation holds the login of `registry` as its registry secret,
 * which it forgets when `use` ends.
 */
export type PullLogins = <T>(
  registry: string,
  use: (login: { username?: string; identityToken?: boolean; password: string } | undefined) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

/**
 * Plan step 11B3: EnvironmentDocker over the port. `secretOf` gives the secrets of the operation (the registry login of a
 * pull is one of them, SECRET_REGISTRY). Plan step 11E3b: `logins`, the login of the registry of each pull.
 */
export class EngineDocker implements EnvironmentDocker {
  constructor(
    private readonly engine: DockerEngine,
    private readonly logger: Logger = silentLogger,
    private readonly secretOf: (name: string) => string | undefined = () => undefined,
    private readonly logins?: PullLogins,
  ) {}

  /**
   * Review round 1 of 11B3a (A-R1-2): every request has a time limit, as each `docker` call of ContainerAdapter had
   * (DOCKER_QUERY_TIMEOUT_MS unless the caller gives one); a request that the engine does not answer in time fails with an
   * EngineError, and a cancel of `signal` stays its AbortError.
   */
  private async call<T>(what: string, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>, timeoutMs = DOCKER_QUERY_TIMEOUT_MS): Promise<T> {
    const limit = AbortSignal.timeout(timeoutMs);
    try {
      return await run(signal ? AbortSignal.any([signal, limit]) : limit);
    } catch (error) {
      if (limit.aborted && !signal?.aborted) throw new EngineError(`The engine did not answer ${what} within ${timeoutMs / 1000} s.`, 0);
      throw error;
    }
  }

  /** As `docker info` (within DOCKER_INFO_TIMEOUT_MS): the engine answers. Rejects only with an AbortError. */
  async isRunning(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.call('the version', signal, (limited) => this.engine.version(limited), DOCKER_INFO_TIMEOUT_MS);
      return true;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      return false;
    }
  }

  async engineApiVersion(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { apiVersion } = await this.call('the version', signal, (limited) => this.engine.version(limited));
      if (/^\d+\.\d+$/.test(apiVersion)) return apiVersion;
      this.logger.warn(`The API version of the Docker Engine could not be read: ${apiVersion || 'none'}`);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      this.logger.warn(`The API version of the Docker Engine could not be read: ${errorMessage(error)}`);
    }
    return undefined;
  }

  async imageConfig(reference: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const value = (await this.call(`the inspect of ${reference}`, options.signal, (limited) => this.engine.inspect('image', reference, limited), options.timeoutMs)) as
      | { Config?: unknown }
      | undefined;
    if (value === undefined) throw new EngineError(`No such image: ${reference}`, 404);
    return value.Config ?? null;
  }

  /**
   * Plan step 11G1 ("No extra containers"): the numeric user and group IDs of `user` in the image `image`, as `id -u` and
   * `id -g` print them in a container of it, read from its `/etc/passwd` (DockerEngine.imageFile, which runs nothing)
   * and resolved by passwdUserIds. Undefined when the file is missing, is no regular file, is too large, or names no
   * such user. Within `timeoutMs` (DOCKER_QUERY_TIMEOUT_MS by default); a cancel of `signal` stays its AbortError.
   */
  async imageUserIds(image: string, user: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<UserIds | undefined> {
    const passwd = await this.call(`the read of /etc/passwd of ${image}`, options.signal, (limited) => this.engine.imageFile(image, '/etc/passwd', limited), options.timeoutMs);
    return passwd === undefined ? undefined : passwdUserIds(passwd, user);
  }

  private containersWithLabel(label: string, signal?: AbortSignal): Promise<EngineContainer[]> {
    return this.call('the list of the containers', signal, (limited) => this.engine.containers(label, limited));
  }

  private inspect(kind: 'container' | 'image' | 'volume' | 'network', reference: string, signal?: AbortSignal): Promise<unknown> {
    return this.call(`the inspect of ${reference}`, signal, (limited) => this.engine.inspect(kind, reference, limited));
  }

  /** EnvironmentDocker.findContainer: the dev container (isDevContainer), the named one first, else running, else newest. */
  async findContainer(environmentId: string, containerName: string): Promise<ContainerInfo | undefined> {
    const containers = (await this.containersWithLabel(`${LABEL_ENVIRONMENT_ID}=${environmentId}`)).filter((container) => isDevContainer(container, containerName));
    if (containers.length === 0) return undefined;
    if (containers.length > 1) {
      this.logger.warn(`${containers.length} containers have the label ${LABEL_ENVIRONMENT_ID}=${environmentId}: ${containers.map((c) => c.name).join(', ')}`);
    }
    const named = containers.find((container) => container.name === containerName);
    return publicInfo(named !== undefined ? inspected(named) : [...containers.map(inspected)].sort(preferred)[0]);
  }

  async listEnvironmentContainers(): Promise<ContainerInfo[]> {
    return (await this.containersWithLabel(LABEL_ENVIRONMENT_ID)).map((container) => publicInfo(inspected(container)));
  }

  async listProjectContainers(project: string): Promise<ContainerInfo[]> {
    return (await this.containersWithLabel(`${COMPOSE_PROJECT_LABEL}=${project}`)).map((container) => publicInfo(inspected(container)));
  }

  listProjectNetworks(project: string): Promise<string[]> {
    return this.call('the list of the networks', undefined, (limited) => this.engine.networkNames({ label: [`${COMPOSE_PROJECT_LABEL}=${project}`] }, limited));
  }

  async removeNetwork(name: string): Promise<void> {
    this.logger.info(`Removing network ${name}.`);
    await this.call(`the removal of ${name}`, undefined, (limited) => this.engine.removeNetwork(name, limited));
  }

  /** EnvironmentDocker.listProjectImages: `<project>-*` images with a tag; with `environmentId`, only its own. */
  async listProjectImages(project: string, environmentId?: string): Promise<string[]> {
    const images = await this.call('the list of the images', undefined, (limited) => this.engine.images({ reference: [`${project}-*`] }, limited));
    const tags = new Set<string>();
    const foreign = new Set<string>();
    for (const image of images) {
      const own = image.repoTags.filter((tag) => tag.startsWith(`${project}-`) && !tag.endsWith(':<none>'));
      for (const tag of own) tags.add(tag);
      if (environmentId !== undefined && image.labels[LABEL_ENVIRONMENT_ID] !== environmentId) for (const tag of image.repoTags) foreign.add(tag);
    }
    return [...tags].sort().filter((tag) => !foreign.has(tag));
  }

  async containerState(nameOrId: string, signal?: AbortSignal): Promise<ContainerState> {
    const container = await this.call(`the inspect of ${nameOrId}`, signal, (limited) => this.engine.container(nameOrId, limited));
    return container === undefined ? 'missing' : mapContainerState(container.rawState);
  }

  async stopContainer(nameOrId: string): Promise<void> {
    this.logger.info(`Stopping container ${nameOrId}.`);
    try {
      await this.call(`the stop of ${nameOrId}`, undefined, (limited) => this.engine.stop(nameOrId, undefined, limited));
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.logger.info(`Container ${nameOrId} does not exist.`);
    }
  }

  async renameContainer(nameOrId: string, newName: string): Promise<void> {
    this.logger.info(`Renaming container ${nameOrId} to ${newName}.`);
    await this.call(`the rename of ${nameOrId}`, undefined, (limited) => this.engine.renameContainer(nameOrId, newName, limited));
  }

  async removeContainer(nameOrId: string): Promise<void> {
    this.logger.info(`Removing container ${nameOrId}.`);
    await this.call(`the removal of ${nameOrId}`, undefined, (limited) => this.engine.removeContainer(nameOrId, limited));
  }

  /**
   * `docker exec` over the Engine API (review round 1 of PR #119, A-L1: the CLI adapter refuses a secret input since plan
   * step 11I1, PR B2; the token is written only here). `secretInputName` names a secret that the operation holds (the
   * worker got it through its request, plan step 11A); it is the standard input of the process, never an argument. Plan
   * step 11I (PR B): by its name, as the port takes it (before, the value, which had to be the token of the operation).
   */
  async exec(
    container: string,
    command: readonly string[],
    options: { user?: string; workdir?: string; input?: string; secretInputName?: typeof SECRET_TOKEN; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    if (options.input !== undefined && options.secretInputName !== undefined) throw new Error('A docker exec has either an input or a secret input.');
    // Review round 1 of 11B3a (A-R1-9): a secret input is the token that the operation holds, passed on by its name.
    // Plan step 11I (PR B): no other secret of the operation (a registry login) ever goes into a container, and a token
    // that the operation does not hold is refused before anything is sent. Review round 1 of PR #124 (A, L-1): the token
    // that is sent is checked here, where it is sent (not only the token of the pipeline's session): a value that is
    // empty or holds white space is refused too.
    const token = options.secretInputName !== undefined ? this.secretOf(SECRET_TOKEN) : undefined;
    if (options.secretInputName !== undefined && (options.secretInputName !== SECRET_TOKEN || !token || /\s/.test(token))) {
      throw new EngineError('A docker exec with a secret input needs it as the token secret of the operation.', 0);
    }
    try {
      return await this.engine.exec(container, command, {
        ...(options.user ? { user: options.user } : {}),
        ...(options.workdir ? { workdir: options.workdir } : {}),
        ...(options.input !== undefined ? { input: options.input } : {}),
        ...(options.secretInputName !== undefined ? { secretInputName: SECRET_TOKEN } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // Review round 1 of 11B3a (A-R1-3): a refusal of the engine (an unknown user, a container that does not run or
      // does not exist) is a result, as `docker exec` reports it (exit code 1, the message on stderr), so that the
      // pipeline sees it (for example isContainerFault).
      if (error instanceof EngineError && error.status >= 400 && !options.signal?.aborted) {
        return { exitCode: 1, stdout: '', stderr: `Error response from daemon: ${error.message}\n`, timedOut: false };
      }
      throw error;
    }
  }

  async volumeExists(name: string): Promise<boolean> {
    return (await this.inspect('volume', name)) !== undefined;
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    this.logger.info(`Creating volume ${name}.`);
    await this.call(`the create of ${name}`, undefined, (limited) => this.engine.createVolume(name, labels, limited));
  }

  async removeVolume(name: string): Promise<void> {
    this.logger.info(`Removing volume ${name}.`);
    await this.call(`the removal of ${name}`, undefined, (limited) => this.engine.removeVolume(name, limited));
  }

  async listEnvironmentVolumes(signal?: AbortSignal): Promise<VolumeInfo[]> {
    const names = await this.call('the list of the volumes', signal, (limited) => this.engine.volumeNames({ label: [LABEL_ENVIRONMENT_ID] }, limited));
    // User decision 2026-09-28: a cancellation of the check of the images of the environments ends before the inspect.
    if (signal?.aborted) throw abortError();
    return this.inspectVolumes(names);
  }

  async inspectVolumes(names: readonly string[]): Promise<VolumeInfo[]> {
    const volumes: VolumeInfo[] = [];
    for (const name of new Set(names)) {
      const volume = toVolumeInfo(await this.inspect('volume', name));
      if (volume !== undefined) volumes.push(volume);
    }
    return volumes;
  }

  async inspectNetworks(names: readonly string[]): Promise<NetworkInfo[]> {
    const networks: NetworkInfo[] = [];
    for (const name of new Set(names)) {
      const network = toNetworkInfo(await this.inspect('network', name));
      if (network !== undefined) networks.push(network);
    }
    return networks;
  }

  async imageExists(reference: string): Promise<boolean> {
    return (await this.inspect('image', reference)) !== undefined;
  }

  async imageId(reference: string): Promise<string | undefined> {
    const value = (await this.inspect('image', reference)) as { Id?: unknown } | undefined;
    if (value === undefined) return undefined;
    if (typeof value.Id !== 'string' || value.Id === '') throw new EngineError(`The engine answered the inspect of the image ${reference} without an ID.`, 200);
    return value.Id;
  }

  async imageLabels(reference: string): Promise<Record<string, string> | undefined> {
    const value = (await this.inspect('image', reference)) as { Config?: { Labels?: unknown } } | undefined;
    return value === undefined ? undefined : toLabels(value.Config?.Labels);
  }

  /** EnvironmentDocker.imageLabelsOf: the labels by full image ID; a missing image is left out. */
  async imageLabelsOf(references: readonly string[], signal?: AbortSignal): Promise<Map<string, Record<string, string>>> {
    const labels = new Map<string, Record<string, string>>();
    for (const reference of references) {
      const value = (await this.inspect('image', reference, signal)) as { Id?: unknown; Config?: { Labels?: unknown } } | undefined;
      if (signal?.aborted) throw abortError();
      if (value === undefined || typeof value.Id !== 'string' || value.Id === '') continue;
      labels.set(value.Id.toLowerCase(), toLabels(value.Config?.Labels));
    }
    return labels;
  }

  /**
   * EnvironmentDocker.labelImage (user decisions 2026-10-03), without a build (decision of 2026-10-03, no extra
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

  /** The tags and digests of an image (`RepoTags`, `RepoDigests`), undefined for a missing image. */
  async imageNames(reference: string): Promise<{ repoTags: string[]; repoDigests: string[] } | undefined> {
    const value = (await this.inspect('image', reference)) as { RepoTags?: unknown; RepoDigests?: unknown } | undefined;
    if (value === undefined) return undefined;
    const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []);
    return { repoTags: texts(value.RepoTags), repoDigests: texts(value.RepoDigests) };
  }

  /**
   * EnvironmentDocker.inspectImageNames (review rounds 9 to 11 of PR #64): the images that the references find; a
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
        const value = (await this.inspect('image', reference, signal)) as { Id?: unknown; RepoTags?: unknown; RepoDigests?: unknown } | undefined;
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
    const outcome = await this.call(`the removal of ${reference}`, undefined, (limited) => this.engine.removeImage(reference, limited));
    if (outcome === 'removed') this.logger.info(`Removed image ${reference}.`);
    if (outcome === 'inUse') this.logger.info(`Image ${reference} is in use and was not removed.`);
    return outcome === 'removed';
  }

  /** EnvironmentDocker.listEnvironmentImages: the named images `devenv-*`, each once with its references. */
  async listEnvironmentImages(signal?: AbortSignal): Promise<ImageInfo[]> {
    const images = await this.call('the list of the images', signal, (limited) => this.engine.images({ reference: ['devenv-*'] }, limited));
    if (signal?.aborted) throw abortError();
    return images
      .map((image) => ({ id: image.id, tags: image.repoTags.filter((tag) => tag.startsWith('devenv-') && !tag.endsWith(':<none>')), createdAt: image.created }))
      .filter((image) => image.tags.length > 0);
  }

  async listImageTags(repository: string): Promise<string[]> {
    const images = await this.call('the list of the images', undefined, (limited) => this.engine.images({ reference: [repository] }, limited));
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
    await this.call(`the start of ${id}`, options.signal, (limited) => this.engine.start(id, limited), options.timeoutMs);
  }

  /**
   * EnvironmentDocker.pullImage over the API. With `credentials`, their password must be the registry secret that the
   * operation holds (SECRET_REGISTRY: the worker got it through its request); it goes only into the header of the pull.
   * Without `credentials` it pulls anonymously: the logins that the Docker CLI of the host would read are not here (review
   * round 1 of 11B3a, A-R1-4; plan step 11B3b hands them in as the registry secret).
   */
  async pullImage(reference: string, options: { onOutput?: (text: string) => void; signal?: AbortSignal; credentials?: PullCredentials } = {}): Promise<void> {
    // Plan step 11E3b (decision B1 of 2026-10-05): without credentials of the caller, the pull asks for the login of the
    // registry of the reference (Docker Hub for a reference without a registry) and holds it only for its own turn (the
    // operation forgets it when the pull ends); a reference that the parser refuses, or whose registry the daemon would
    // read otherwise (review round 1 of PR #110, A-L2), is pulled anonymously, as is one without a login.
    const registry = options.credentials === undefined && this.logins !== undefined ? loginRegistryOf(reference) : undefined;
    if (registry === undefined || this.logins === undefined) return this.pullWith(reference, options);
    return this.logins(
      registry,
      async (login) => {
        if (login === undefined) return this.pullWith(reference, options);
        const credentials = { registry, username: login.identityToken === true ? IDENTITY_TOKEN_USER : (login.username ?? ''), password: login.password };
        try {
          return await this.pullWith(reference, { ...options, credentials });
        } catch (error) {
          // Review round 1 of PR #110 (A-M1): a login that the registry refuses (an expired token of the credential store)
          // never keeps a public image from downloading: once more without it, as the image check does.
          if (options.signal?.aborted || !isLoginRefusal(error)) throw error;
          this.logger.warn(`The registry ${registry} refused the login of this computer for ${reference}; it is downloaded without it: ${errorMessage(error)}`);
          return this.pullWith(reference, options);
        }
      },
      options.signal,
    );
  }

  private async pullWith(reference: string, options: { onOutput?: (text: string) => void; signal?: AbortSignal; credentials?: PullCredentials }): Promise<void> {
    const onOutput = options.onOutput ?? ((text: string) => this.logger.output(text));
    const login = options.credentials;
    if (login !== undefined && this.secretOf(SECRET_REGISTRY) !== login.password) {
      throw new EngineError(`The pull of ${reference} with the credentials for ${login.registry} needs them as the registry secret of the operation.`, 0);
    }
    this.logger.info(login === undefined ? `Pulling image ${reference}.` : `Pulling image ${reference} with the credentials for ${login.registry}.`);
    // Review round 2 of 11B3a (A-R2-1): a reference without a tag is pulled as `:latest` (pullReference), never as every
    // tag of the repository.
    await this.engine.pull(pullReference(reference), {
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

/**
 * Review round 1 of PR #110 (A-L2): the registry whose login a pull of `reference` sends, only when the daemon reads the
 * same registry from it: no space around it, and a registry part (before the first `/`, when it names a host) in lower
 * case, as Docker compares `docker.io` and `index.docker.io`. `undefined`: no login.
 */
function loginRegistryOf(reference: string): string | undefined {
  if (reference !== reference.trim()) return undefined;
  const slash = reference.indexOf('/');
  const first = slash < 0 ? '' : reference.slice(0, slash);
  // Review round 2 of PR #110 (A2-L-2): Docker reads a first part with an upper-case letter as a host too (`MyHost/img`).
  if (first !== first.toLowerCase()) return undefined;
  return parseImageReference(reference)?.registry;
}

/** Review round 1 of PR #110 (A-M1): a refusal of the login by the registry (HTTP 401 or 403, or Docker's words for it). */
function isLoginRefusal(error: unknown): boolean {
  if (error instanceof EngineError && (error.status === 401 || error.status === 403)) return true;
  // Review round 2 of PR #110 (A2-L-3): also the words of the containerd image store and of ghcr.io and ECR.
  return /unauthori[sz]ed|forbidden|failed to authorize|authentication required|incorrect username or password|(^|: )denied(:|$)|authorization token has expired|invalid username\/password/i.test(
    errorMessage(error),
  );
}
