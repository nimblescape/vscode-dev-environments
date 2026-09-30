// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Pure decisions and helpers of the open pipeline (concept 7.6, 7.7, 7.12). No I/O.
import * as crypto from 'crypto';
import * as path from 'path';
import type { ContainerInfo, MountTarget } from '../docker/containerAdapter';
import { CommandError, errorMessage } from '../errors';
import type { CheckedOutcome } from '../imageCheck/imageCheck';
import { serviceFolderPaths } from '../git/gitSummary';
import { composeMountVolumeName } from '../helper/compose';
import { isAnonymousVolumeName, runArgsUser, truncated, type HostAccessChecks } from '../policy';
import { HELPER_KNOWN_ENV, mayBeSetInHelper, resolveCliVariables, type CliVariables } from '../helper/cliVariables';
import { isDockerHub, parseImageReference } from '../imageCheck/reference';
import {
  CONTAINER_CONFIG_UNKNOWN,
  CONTAINER_VERSION,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_CONFIG,
  LABEL_CONTAINER_VERSION,
  LABEL_ENVIRONMENT_ID,
  LABEL_HOST_ACCESS,
  WORKSPACES_ROOT,
  repositoryFolder,
} from '../names';
import type { BuildRecord, ComposeBuildRecord, DevcontainerResult, Environment, RefusedUpdate } from '../types';

export type { RefusedUpdate };

/** Configuration path of an environment whose configuration is not known yet (the pipeline falls back to the first one found). */
export const DEFAULT_CONFIG_PATH = '.devcontainer/devcontainer.json';

/**
 * True for a container of the current setup: its label nimblescape.devenv.container-version is CONTAINER_VERSION or
 * newer. The pipeline creates a container without the label, or with an older value, again from its environment image;
 * the volume stays. `configKnown`: the configuration of the repository can be read now. Then a container that was
 * created without it (label nimblescape.devenv.container-config=unknown) is not current either: it lacks the runArgs
 * and appPort of the configuration. While the configuration cannot be read, such a container is current, so it is only
 * started and not created again at every open. `hostAccessChecks`: the switch of the repository now (hostAccessChecks
 * in ../policy/hostAccessChecks.ts). While the checks are on, a container that was created while they were off (label
 * nimblescape.devenv.host-access=unrestricted, isUnrestrictedContainer) is not current: the pipeline creates it again
 * once the checks pass, and never starts it as it is. While they are off, the label does not matter: a container
 * created with the checks on has less access.
 */
export function containerIsCurrent(
  labels: Readonly<Record<string, string>>,
  configKnown = true,
  hostAccessChecks: HostAccessChecks = 'on',
): boolean {
  const text = labels[LABEL_CONTAINER_VERSION];
  const version = text !== undefined && /^\d{1,6}$/.test(text) ? Number(text) : 0;
  if (version < CONTAINER_VERSION) return false;
  if (hostAccessChecks === 'on' && isUnrestrictedContainer(labels)) return false;
  return !configKnown || labels[LABEL_CONTAINER_CONFIG] !== CONTAINER_CONFIG_UNKNOWN;
}

/**
 * True for a container that was created while the host access checks were off (label
 * nimblescape.devenv.host-access=unrestricted).
 */
export function isUnrestrictedContainer(labels: Readonly<Record<string, string>>): boolean {
  return labels[LABEL_HOST_ACCESS] === HOST_ACCESS_UNRESTRICTED;
}

/**
 * The most characters of the text `items` of a refused update (hotfix review 3, C3-2): it is kept in the registry, and
 * an error message that is no HostAccessError has no bound of its own. The middle is `…` (truncated).
 */
export const MAX_REFUSED_ITEMS_LENGTH = 4096;

/**
 * The field `refusedUpdate` of a registry entry, when it is valid. Its items at most MAX_REFUSED_ITEMS_LENGTH
 * characters (hotfix review 4, Q3): a registry changed by hand may hold more, and they are logged and shown.
 */
export function refusedUpdateOf(entry: object): RefusedUpdate | undefined {
  const value: unknown = (entry as { refusedUpdate?: unknown }).refusedUpdate;
  if (
    !isRecord(value) ||
    typeof value.configPath !== 'string' ||
    typeof value.configHash !== 'string' ||
    !isStringRecord(value.images) ||
    !isStringRecord(value.features) ||
    typeof value.items !== 'string' ||
    (value.hostAccessChecks !== undefined && value.hostAccessChecks !== 'off')
  ) {
    return undefined;
  }
  const refused: RefusedUpdate = {
    configPath: value.configPath,
    configHash: value.configHash,
    images: value.images,
    features: value.features,
    items: truncated(value.items, MAX_REFUSED_ITEMS_LENGTH),
  };
  if (value.hostAccessChecks === 'off') refused.hostAccessChecks = 'off';
  // Review round 10 (P10-3).
  if (value.reason === 'size') refused.reason = 'size';
  return refused;
}

/**
 * True if `update` is the refused update `refused`: same configuration, same digests (ignoring the case), and the same
 * state of the host access checks (absent: on). A refusal while the checks were on does not block the update once they
 * are off for the repository, and a refusal while they were off does not block it once they are on again.
 */
export function isRefusedUpdate(refused: RefusedUpdate | undefined, update: Omit<RefusedUpdate, 'items'>): boolean {
  return (
    refused !== undefined &&
    (refused.hostAccessChecks ?? 'on') === (update.hostAccessChecks ?? 'on') &&
    refused.configPath === update.configPath &&
    refused.configHash === update.configHash &&
    sameDigests(refused.images, update.images) &&
    sameDigests(refused.features, update.features)
  );
}

function sameDigests(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => ownValue(b, key)?.toLowerCase() === a[key].toLowerCase());
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

/** Result of the image check of one open pipeline. */
export type ImageCheckState =
  /** No check this time (setting off, or the user chose "Later" for a changed configuration). */
  | { kind: 'skipped' }
  /** A registry could not be reached: the update step is skipped (FR-13). */
  | { kind: 'unreachable' }
  | {
      kind: 'checked';
      outcome: CheckedOutcome;
      /** All current digests equal the build record. */
      upToDate: boolean;
      changedImages: string[];
      changedFeatures: string[];
    };

/** `configHash` of the build record (implementation notes 8): sha256 of the devcontainer.json text plus the Dockerfile text. */
export function configHash(configText: string, dockerfileText?: string): string {
  return `sha256:${crypto.createHash('sha256').update(configText + (dockerfileText ?? '')).digest('hex')}`;
}

export interface UpdateInput {
  /** The environment has a build record. */
  hasRecord: boolean;
  /** The environment image of the build record exists locally. */
  imagePresent: boolean;
  /** Manual rebuild, a selected configuration, or "Rebuild now" after a configuration change. */
  forced: boolean;
  /** The user chose "Later" for a changed configuration: no update this time. */
  skipUpdate: boolean;
}

/** Step 7 of the pipeline: the image check runs unless it is skipped, when the setting asks for it or a build is due anyway. */
export function shouldCheckImages(input: UpdateInput & { updateImagesOnConnect: boolean }): boolean {
  if (input.skipUpdate) return false;
  return input.updateImagesOnConnect || !input.hasRecord || input.forced || !input.imagePresent;
}

/**
 * Step 8: a new environment image is built when it is forced or missing, or when the check found newer digests.
 * Without a registry, an existing container starts instead (concept 7.7 "Without internet access"); a missing build
 * record or environment image is built at the next connection with internet access (concept 7.5, 7.12).
 */
export function needsBuild(input: UpdateInput & { check: ImageCheckState; containerExists: boolean }): boolean {
  if (input.forced) return true;
  if (input.check.kind === 'unreachable' && input.containerExists) return false;
  if (!input.hasRecord || !input.imagePresent) return true;
  return input.check.kind === 'checked' && !input.check.upToDate && !input.skipUpdate;
}

/**
 * Image references to pull before a build. Features are never pulled: the Dev Container CLI downloads them.
 * - Registry unreachable: none; the build uses the local images.
 * - No record, forced, or environment image missing: all images, because the workspace helper has no registry
 *   credentials and can build private base images only when they are local.
 * - Update: the images whose digest changed.
 */
export function imagesToPull(input: {
  images: readonly string[];
  check: ImageCheckState;
  hasRecord: boolean;
  imagePresent: boolean;
  forced: boolean;
}): string[] {
  if (input.check.kind === 'unreachable') return [];
  if (!input.hasRecord || input.forced || !input.imagePresent) return [...input.images];
  if (input.check.kind !== 'checked') return [];
  const changed = new Set(input.check.changedImages);
  return input.images.filter((image) => changed.has(image));
}

function ownValue(record: Record<string, string> | undefined, key: string): string | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Digests for the new build record (concept 7.7, implementation notes 9): the digest read right before the build.
 * A reference without a current digest, or whose pull failed so that the build used an older local image (`stale`),
 * keeps the digest of the previous record; without one it is left out, so the next check sees it as changed.
 */
export function recordDigests(
  references: readonly string[],
  current: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
  stale: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const reference of references) {
    const digest = (stale.has(reference) ? undefined : ownValue(current, reference)) ?? ownValue(previous, reference);
    if (digest !== undefined) digests[reference] = digest;
  }
  return digests;
}

/**
 * Next build number: one more than the highest number used so far, in the registry or as a local tag of the environment
 * image repository. The tags count too, because a lost registry (concept 7.5) forgets the numbers, and a reused tag
 * would move away from the image of the existing container.
 */
export function nextBuildNumber(input: {
  lastBuildNumber?: number;
  recordBuildNumber?: number;
  /** Local tags such as `devenv-3f2a9c1e:2`. */
  tags: readonly string[];
  /** For example `devenv-3f2a9c1e`. */
  repository: string;
}): number {
  let highest = Math.max(0, input.lastBuildNumber ?? 0, input.recordBuildNumber ?? 0);
  const prefix = `${input.repository}:`;
  for (const tag of input.tags) {
    if (!tag.startsWith(prefix)) continue;
    const text = tag.slice(prefix.length);
    if (!/^\d{1,9}$/.test(text)) continue;
    highest = Math.max(highest, Number(text));
  }
  return highest + 1;
}

// Messages of Git (curl), Docker, BuildKit, and Node.js when the network or the name resolution fails.
const NETWORK_PATTERNS: readonly RegExp[] = [
  /could not resolve (host|proxy)/i,
  /failed to connect/i,
  /couldn't connect to server|could not connect to server/i,
  /connection (timed out|refused|reset)/i,
  /network is unreachable|no route to host/i,
  /temporary failure in name resolution/i,
  /name or service not known/i,
  /no such host/i,
  /\bdial tcp\b/i,
  /i\/o timeout/i,
  /tls handshake timeout/i,
  /operation timed out/i,
  /gnutls_handshake\(\) failed|ssl_error_syscall|ssl_connect/i,
  /getaddrinfo/i,
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/,
];

/**
 * True if an error text describes a network failure, for example `fatal: unable to access '…': Could not resolve host`.
 * Git's "unable to access" counts only without an HTTP error status, because "returned error: 403" is an access problem.
 */
export function isNetworkFailure(text: string): boolean {
  if (NETWORK_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return /unable to access/i.test(text) && !/returned error:\s*\d{3}/i.test(text);
}

/**
 * True if Git says that github.com rejected the token of the helper run: HTTP 401 over HTTPS, for example
 * `remote: Invalid username or token. Password authentication is not supported for Git operations.` followed by
 * `fatal: Authentication failed for 'https://github.com/acme/api.git/'`. A repository without access gives
 * `Repository not found` (404) instead, which is not a rejected token.
 */
export function isGitHubTokenRejected(text: string): boolean {
  return (
    /authentication failed for '?https:\/\/([^/@\s']*@)?github\.com[/']/i.test(text) ||
    /^remote: invalid username or (token|password)/im.test(text) ||
    /'?https:\/\/([^/@\s']*@)?github\.com\/[^\s']*'?: the requested url returned error: 401\b/i.test(text)
  );
}

// Description of the Dev Container CLI when a lifecycle command fails in a container that it created or started:
// `postStartCommand from devcontainer.json failed.`, or `<name> of postStartCommand from … failed.` for a command object.
const LIFECYCLE_HOOK_FAILURE =
  /(?:^|\s)(onCreateCommand|updateContentCommand|postCreateCommand|postStartCommand|postAttachCommand)(?: from .+)? failed\.$/;

/** The lifecycle command (for example `postStartCommand`) that a description of the Dev Container CLI names as failed. */
export function lifecycleHookName(description: unknown): string | undefined {
  return typeof description === 'string' ? LIFECYCLE_HOOK_FAILURE.exec(description.trim())?.[1] : undefined;
}

/**
 * The lifecycle command whose failure an error result of `devcontainer up` reports, or `undefined`. The CLI then leaves
 * the container running and names it in `containerId`. Other errors after the creation of the container carry a
 * `containerId` too, so the description decides.
 */
export function lifecycleHookFailure(result: DevcontainerResult | undefined): string | undefined {
  if (result?.outcome !== 'error' || nonEmptyString(result.containerId) === undefined) return undefined;
  return lifecycleHookName(result.description);
}

// Messages of Docker (verified on 29.3.1 with runc 1.3) when the existing container itself is damaged, so that it cannot
// be started or used, while Docker works: its /etc/passwd or /etc/group lacks the user (`docker exec -u`, also when the
// file is gone), the shell that the Dev Container CLI starts it with is missing or not executable (`docker start` and
// `docker exec`), or the container is marked for removal (state `dead`). Only an allowlist: a failure that another
// container of the same image would have as well (a published port in use, a missing bind mount source or device, a
// missing network, an image of another platform) names none of them.
const CONTAINER_FAULT_PATTERNS: readonly RegExp[] = [
  /unable to find (?:user|group) [^\n]*?: no matching entries in (?:passwd|group) file/i,
  /unable to start container process: [^\n]*?exec: "\/[^"\n]*": (?:stat [^\n]*?: no such file or directory|permission denied)/i,
  /is marked for removal and cannot be started/i,
];

// Messages of Docker when its engine does not answer (local, or on a remote host over SSH): never the container's fault.
const DOCKER_UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /cannot connect to the docker daemon/i,
  /error during connect/i,
  /is the docker daemon running/i,
  /\bssh: /i,
  /connection (?:closed|lost)|broken pipe|unexpected eof/i,
];

/**
 * Recreate offer (user request 2026-09-26): whether the text of a failed start of an existing container (the output of
 * `devcontainer up` or `run-user-commands`, or of a `docker exec` in the running container) says that the container
 * itself is damaged (CONTAINER_FAULT_PATTERNS), so that a new container of the same environment image would work. A
 * text that also names a failure of the connection to Docker or of the network is never one: when unsure, the pipeline
 * does not offer to recreate the container.
 */
export function isContainerFault(text: string): boolean {
  if (DOCKER_UNREACHABLE_PATTERNS.some((pattern) => pattern.test(text)) || isNetworkFailure(text)) return false;
  return CONTAINER_FAULT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Recreate offer, review round 2 (V1): the folders of `container` that are volumes without a name (Docker names such a
 * volume with 64 hexadecimal digits: `- /workspaces/api/node_modules` of a compose file, `VOLUME /data` of the image, a
 * mount without a source). The recreation does not carry them over: the question and the progress name them.
 */
export function unnamedVolumeFolders(container: Pick<ContainerInfo, 'mountTargets'>): string[] {
  const folders = (container.mountTargets ?? [])
    .filter((mount) => mount.type === 'volume' && mount.volume !== undefined && /^[0-9a-f]{64}$/.test(mount.volume))
    .map((mount) => mount.target);
  return [...new Set(folders)].sort();
}

/** Technical details of an error for the log and for `UserFacingError.detail`: the message and the end of stderr. */
export function errorDetail(error: unknown): string {
  const message = errorMessage(error);
  if (!(error instanceof CommandError)) return message;
  const output = (error.stderr.trim() || error.stdout.trim()).slice(-4000);
  if (!output || message.includes(output)) return message;
  return `${message}\n${output}`;
}

/** Key of a base image for the comparison between build records: registry, repository, and digest. */
export function baseImageKey(reference: string, digest: string): string {
  const parsed = parseImageReference(reference);
  const name = parsed ? `${parsed.registry}/${parsed.repository}` : reference.trim();
  return `${name}@${digest.toLowerCase()}`;
}

/**
 * Local reference of the base image that a build record names, for `docker image rm`: `<repository>@<digest>`, fully
 * qualified (Docker Hub as `docker.io/…`). `undefined` for an invalid reference or digest.
 */
export function digestReference(reference: string, digest: string): string | undefined {
  const parsed = parseImageReference(reference);
  if (!parsed || parsed.digest !== undefined || !/^sha256:[0-9a-f]{64}$/i.test(digest)) return undefined;
  const registry = isDockerHub(parsed.registry) ? 'docker.io' : parsed.registry;
  return `${registry}/${parsed.repository}@${digest.toLowerCase()}`;
}

/** The user of a container is root (the ownership fix is not needed). */
export function isRootUser(user: string): boolean {
  return user === 'root' || user === '0';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The user part of `user[:group]`, as the Dev Container CLI 0.89.0 reads the user of a container
 * (`/([^:]*)(:(.*))?/`), with `0` as `root`. An empty user part (`:1000`) counts as root here: the CLI would ask the
 * container (`id -un`), and root only skips the ownership fix.
 */
export function containerUserName(user: string): string {
  const name = /^([^:]*)/.exec(user)?.[1] ?? '';
  return name === '' || name === '0' ? 'root' : name;
}

/**
 * The user that `devcontainer up` gives a container of an environment image, by the rule of the Dev Container CLI
 * 0.89.0 (image metadata merged last-wins; `docker run -u <containerUser> …runArgs`; then the user of the container):
 * the container runs as the last `--user`/`-u` of `runArgs` (Docker takes the last one, and the CLI puts the runArgs
 * after its own `-u <containerUser>`), else the last `containerUser` of the label devcontainer.metadata, else the user
 * of the image. The remote user is the last `remoteUser` of the metadata, else that container user, else root; of
 * `user:group` only the user part counts, and `0` is root (containerUserName). `imageConfig` is `Config` of `docker
 * image inspect`; `runArgs` are those that `up` passes to Docker (the override configuration).
 * The CLI substitutes each entry of the label at `up` before it reads the users (hotfix review 2, P3), so they are read
 * substituted with `variables` (helperCliVariables in the pipeline; by default the variables of the process of the
 * workspace helper, HELPER_KNOWN_ENV and mayBeSetInHelper). `undefined` when the user that decides holds a variable
 * whose value is not known (a variable of the helper process that may be set, `${containerEnv:…}`): the caller then
 * relies on the remote user that `up` reports.
 */
export function imageRemoteUser(imageConfig: unknown, runArgs?: readonly unknown[], variables?: CliVariables): string | undefined {
  const config = isRecord(imageConfig) ? imageConfig : {};
  const labels = isRecord(config.Labels) ? config.Labels : {};
  const cliVariables: CliVariables = { env: HELPER_KNOWN_ENV, mayBeSet: mayBeSetInHelper, ...variables };
  // A user of an entry as the CLI substitutes it; `unknown` when a leftover of the substitution is in it.
  type LabelUser = { user: string; unknown: boolean };
  const labelUser = (value: unknown): LabelUser | undefined => {
    if (typeof value !== 'string') return undefined;
    const { value: user, leftovers } = resolveCliVariables(value, cliVariables);
    return nonEmptyString(user) === undefined ? undefined : { user, unknown: leftovers.length > 0 };
  };
  let remoteUser: LabelUser | undefined;
  let containerUser: LabelUser | undefined;
  const metadata = labels['devcontainer.metadata'];
  if (typeof metadata === 'string') {
    let entries: unknown;
    try {
      entries = JSON.parse(metadata);
    } catch {
      entries = undefined;
    }
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (!isRecord(entry)) continue;
      remoteUser = labelUser(entry.remoteUser) ?? remoteUser;
      containerUser = labelUser(entry.containerUser) ?? containerUser;
    }
  }
  if (remoteUser !== undefined) return remoteUser.unknown ? undefined : containerUserName(remoteUser.user);
  const argsUser = runArgsUser(runArgs);
  if (argsUser !== undefined) return containerUserName(argsUser);
  if (containerUser !== undefined) return containerUser.unknown ? undefined : containerUserName(containerUser.user);
  const imageUser = typeof config.User === 'string' ? nonEmptyString(config.User) : undefined;
  return containerUserName(imageUser ?? 'root');
}

/**
 * Recreate offer, review round 3 (F1): the remote user of a container by its own label devcontainer.metadata (which the
 * Dev Container CLI puts on the container it creates, and by which the Dev Containers extension attaches), substituted
 * as imageRemoteUser does: its `remoteUser`, else its `containerUser`. `undefined` when the label names neither, or the
 * user holds a variable whose value is not known.
 */
export function containerMetadataUser(labels: Readonly<Record<string, string>>, variables?: CliVariables): string | undefined {
  let entries: unknown;
  try {
    entries = JSON.parse(labels['devcontainer.metadata'] ?? 'null');
  } catch {
    return undefined;
  }
  const named = (Array.isArray(entries) ? entries : [entries]).some(
    (entry) => isRecord(entry) && (nonEmptyString(entry.remoteUser) !== undefined || nonEmptyString(entry.containerUser) !== undefined),
  );
  return named ? imageRemoteUser({ Labels: labels }, undefined, variables) : undefined;
}

/**
 * Recreate offer, review round 3 (G2): the other services of a Docker Compose model (not `devService`) that share a
 * namespace or the volumes of another service (`network_mode`, `ipc`, or `pid` of the form `service:<name>`, or
 * `volumes_from`), as `<service>: <setting>`. Compose hashes such a reference in its resolved form (`container:<id>`),
 * so the hash of the model never equals the label of the container, and a new dev container could make Compose create
 * them again.
 */
export function sharedNamespaceServices(model: { services: Record<string, unknown> }, devService: string): string[] {
  const found: string[] = [];
  for (const [name, service] of Object.entries(model.services)) {
    if (name === devService || !isRecord(service)) continue;
    for (const key of ['network_mode', 'ipc', 'pid']) {
      const value = service[key];
      if (typeof value === 'string' && value.startsWith('service:')) found.push(`${name}: ${key} ${value}`);
    }
    if (Array.isArray(service.volumes_from) && service.volumes_from.length > 0) found.push(`${name}: volumes_from ${service.volumes_from.join(', ')}`);
  }
  return found;
}

/**
 * Recreate offer, review round 4 (H1): the other services (not `devService`) with a `build:` section that the `up` of
 * the Dev Container CLI builds when the dev container does not exist (CLI 0.89.0: `docker compose build` of every
 * service, or of `runServices` and the dev service, before `up -d` without `--no-recreate`): all of them without
 * `runServices`, else those that `runServices` names. A new image of such a service, for example of a changed build
 * context or a pruned build cache, makes Compose create its container again, after the direct check.
 */
export function builtOtherServices(model: { services: Record<string, unknown> }, devService: string, runServices?: readonly string[]): string[] {
  return Object.entries(model.services)
    .filter(([name, service]) => name !== devService && isRecord(service) && service.build !== undefined && service.build !== null)
    .map(([name]) => name)
    .filter((name) => runServices === undefined || runServices.length === 0 || runServices.includes(name));
}

/**
 * The remote user by the configuration alone, when neither `up` nor the image named it: its `remoteUser`, else the last
 * `--user`/`-u` of `runArgs`, else its `containerUser` (the order of imageRemoteUser, without the image). `undefined`
 * when the configuration names none.
 */
export function configRemoteUser(config: { remoteUser?: unknown; containerUser?: unknown } | undefined, runArgs?: readonly unknown[]): string | undefined {
  const user = nonEmptyString(config?.remoteUser) ?? runArgsUser(runArgs) ?? nonEmptyString(config?.containerUser);
  return user === undefined ? undefined : containerUserName(user);
}

/** `owner/name`, as the registry accepts it. */
export function isRepositoryName(value: unknown): value is string {
  return typeof value === 'string' && /^[^/\s]+\/[^/\s]+$/.test(value);
}

/** Only the strings of a list (for values of a configuration that may have any JSON type). */
export function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** A non-empty string, otherwise `undefined`. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Docker Compose (implementation notes, section "Docker Compose")

/** Label that Docker Compose gives each container, network, and volume of a project. */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
/** Review round 22 (D22-1): label that Docker Compose gives each container of a project: the name of its service. */
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
/**
 * Recreate offer, review round 1 (D2): label that Docker Compose gives each container: the ID of the image that it was
 * created from (verified with Compose 5.1.1). Compose creates a container again when it differs from the ID of the image
 * of the service now.
 */
export const COMPOSE_IMAGE_LABEL = 'com.docker.compose.image';

/**
 * Review round 22 (D22-1): the name that Docker Compose gives a container that it creates in place of another one while
 * it recreates a service (`<first 12 characters of the ID>_<name>`), which stays behind when that fails.
 */
export function isComposeRecreateLeftoverName(name: string): boolean {
  return /^[0-9a-f]{12}_/.test(name);
}

/**
 * Review round 4 of PR #68 (A-R4-2): whether the build record is one of a Docker Compose environment, for its kind only:
 * the key `compose` holds an object. A part that composeRecordOf rejects (for example one that lacks a field added in a
 * later version) still makes the environment a Docker Compose environment; its fields are read with composeRecordOf.
 */
export function hasComposeRecord(record: BuildRecord | undefined): boolean {
  return record !== undefined && isRecord(record.compose);
}

/**
 * Review round 5 of PR #68 (A-R5-3): the dev service of the build record of Docker Compose, read by its key
 * (BuildRecord.compose.service), also from a part that composeRecordOf rejects (for example an older record without
 * `inputsHash`). `undefined`: no such key, or no service name.
 */
export function recordedComposeService(record: BuildRecord | undefined): string | undefined {
  const value: unknown = record?.compose;
  if (!isRecord(value)) return undefined;
  return typeof value.service === 'string' && value.service !== '' ? value.service : undefined;
}

/** BuildRecord.compose, when it is valid: the build record of a Docker Compose configuration. */
export function composeRecordOf(record: BuildRecord | undefined): ComposeBuildRecord | undefined {
  const value: unknown = record?.compose;
  if (!isRecord(value) || typeof value.service !== 'string' || value.service === '') return undefined;
  if (!Array.isArray(value.images) || !value.images.every((image) => typeof image === 'string')) return undefined;
  if (!Array.isArray(value.serviceImages) || !value.serviceImages.every((image) => typeof image === 'string')) return undefined;
  if (typeof value.version !== 'string' || typeof value.inputsHash !== 'string') return undefined;
  return {
    service: value.service,
    images: [...value.images],
    serviceImages: [...value.serviceImages],
    version: value.version,
    inputsHash: value.inputsHash,
  };
}

/**
 * Review round 9 (D9-1, D9-2), round 10 (D10-1): the paths of the repository that the containers of the other services
 * of the Docker Compose environment may mount (Environment.serviceFolders); empty for an entry without them.
 */
export function serviceFoldersOf(env: Pick<Environment, 'serviceFolders'>): string[] {
  const own = Array.isArray(env.serviceFolders) ? env.serviceFolders.filter((folder) => typeof folder === 'string') : [];
  return [...new Set(own)];
}

/**
 * Review round 11 (G3, G4): the paths of the repository that the existing containers of the other services of the
 * Docker Compose environment mount (not the dev container: the container with the name of the environment, or with the
 * label of the environment and without nimblescape.devenv.compose-service; a container of the project without the
 * labels of the environment, for example of `docker compose run`, counts as another service), from their mounts of
 * subpaths of the workspace volume `volumeName` (ContainerInfo.volumeSubpaths): the subpath joined to WORKSPACES_ROOT,
 * where the dev container and the helper mount the volume. As composeUpModel records them: not a read-only mount, and
 * only a path below the repository folder, never the folder itself or `.git` (serviceFolderPaths filters them). Only
 * the path as Docker has it, not the real path behind a link of the repository: review round 12 (P12-2), the ownership
 * fixes resolve the paths in the volume themselves (SERVICE_OWNER_FIX).
 */
export function liveServiceFolders(
  containers: ReadonlyArray<Pick<ContainerInfo, 'name' | 'labels' | 'volumeSubpaths'>>,
  env: Pick<Environment, 'repository' | 'volumeName' | 'containerName'>,
): string[] {
  const paths = containers
    .filter((container) => container.name !== env.containerName && !(LABEL_ENVIRONMENT_ID in container.labels && container.labels[LABEL_COMPOSE_SERVICE] === undefined))
    .flatMap((container) => container.volumeSubpaths ?? [])
    .filter((mount) => mount.volume === env.volumeName && !mount.readOnly)
    .map((mount) => path.posix.join(WORKSPACES_ROOT, mount.subpath));
  return serviceFolderPaths(repositoryFolder(env.repository), paths);
}

/**
 * Review round 12 (D12-2): the paths of the repository at which the dev container `container` mounts something else than
 * the workspace volume (a named volume, such as a `node_modules` volume or one that another service shares, a tmpfs, or
 * a bind mount; of the Docker Compose model, of the `mounts` of devcontainer.json, or of runArgs), as `docker inspect`
 * reads them (ContainerInfo.mountTargets). `find -xdev` stays only out of other file systems, and a local named volume
 * lies on the file system of the workspace volume: the ownership fix in the dev container leaves these paths to their
 * owners (only the files of root change: the folder of a new volume that Docker created as root still gets the remote
 * user). Only paths below the repository folder (serviceFolderPaths filters them, and so the repository folder itself).
 * Review round 13 (D13-1): a mount of the workspace volume (whole, or a subpath of it) below the repository folder is
 * protected too: it is an alias of files of the volume (for example `./data:/workspaces/api/pgview` of the dev service,
 * rewritten to a subpath of the workspace volume, with db mounting `./data`, or `..` mounted below the repository), which
 * `find -xdev` walks. Only the mount at WORKSPACES_ROOT is left out. The same files are still fixed in full under their
 * canonical path (unless that path is protected itself).
 * Review round 13 (D13-3): an anonymous volume of the dev container (a mount of Type volume whose name is 64 hexadecimal
 * characters, isAnonymousVolumeName) is not protected when the host access checks are on: it is always the dev
 * container's own (fresh per container, or inherited by Docker Compose from the previous dev container), because the
 * policy refuses a configuration that names such a volume; so its content (for example a `node_modules` that the image
 * populated as uid 1000) gets the remote user in full. With the checks off, a configuration may mount the anonymous
 * volume of another container by its name, so it stays protected. Named volumes and bind mounts stay protected, since
 * they can be shared with another container or environment; a tmpfs needs nothing (`-xdev` does not go into it).
 * Review round 14 (P14-1): a mount of the workspace volume whose target is `identities` (workspaceIdentityMounts, checked
 * in the container with verifiedIdentityTargets) is not protected: it shows the folder of the volume at its own canonical
 * path (for example `../src:/workspaces/api/src`), no alias; its files get the full fix like the rest of the repository.
 * Review round 15 (K4 = D15-2): a target in `.git` stays in the list (for example a volume that db shares at
 * `/workspaces/api/.git/pg`, or with the checks off a bind of the computer at `.git/hooks`): serviceFolderPaths with
 * `gitPaths`. The rest of `.git` still gets the full fix.
 */
export function devMountFolders(
  container: Pick<ContainerInfo, 'mountTargets'> | undefined,
  env: Pick<Environment, 'repository' | 'volumeName'>,
  hostAccessChecks: HostAccessChecks,
  identities: ReadonlySet<string> = new Set(),
): string[] {
  const targets = (container?.mountTargets ?? [])
    .filter((mount) => mount.target.startsWith('/'))
    .map((mount) => ({ ...mount, target: path.posix.normalize(mount.target).replace(/(.)\/+$/, '$1') }))
    .filter((mount) => !(mount.type === 'volume' && mount.volume === env.volumeName && mount.target === WORKSPACES_ROOT))
    // Review round 14 (P14-1): a mount of the workspace volume at its own canonical path, checked in the container.
    .filter((mount) => !(identities.has(mount.target) && identityMountTarget(mount, env) === mount.target))
    .filter((mount) => !(hostAccessChecks === 'on' && mount.type === 'volume' && mount.volume !== undefined && isAnonymousVolumeName(mount.volume)))
    .map((mount) => mount.target);
  // Review round 15 (K4 = D15-2): also a target in `.git` (the filter of `.git` is for the records of the services).
  return serviceFolderPaths(repositoryFolder(env.repository), targets, true);
}

/** Review round 14 (P14-1): a mount of a subpath of the workspace volume at the path of that subpath (workspaceIdentityMounts). */
export interface WorkspaceIdentityMount {
  /** The normalized target, below the repository folder, for example `/workspaces/api/src`. */
  target: string;
  /** The subpath, normalized, for example `api/src`. */
  subpath: string;
}

/**
 * Review round 14 (P14-1): the mounts of the workspace volume of the dev container below the repository folder whose
 * target is the path of their subpath in the volume (`/workspaces/<subpath>` equals the target), for example
 * `../src:/workspaces/api/src` of a dev service (rewritten to the subpath `api/src`). Only lexically: a link in the
 * volume can make the mounted folder another one, so verifiedIdentityTargets checks them in the container. A mount
 * without a known subpath (MountTarget.subpath) is never one.
 */
export function workspaceIdentityMounts(container: Pick<ContainerInfo, 'mountTargets'> | undefined, env: Pick<Environment, 'repository' | 'volumeName'>): WorkspaceIdentityMount[] {
  const result: WorkspaceIdentityMount[] = [];
  for (const mount of container?.mountTargets ?? []) {
    const target = identityMountTarget(mount, env);
    if (target !== undefined && !result.some((known) => known.target === target)) result.push({ target, subpath: target.slice(WORKSPACES_ROOT.length + 1) });
  }
  return result;
}

/** The normalized target of a mount of the workspace volume below the repository folder at `/workspaces/<subpath>`. */
function identityMountTarget(mount: MountTarget, env: Pick<Environment, 'repository' | 'volumeName'>): string | undefined {
  if (mount.type !== 'volume' || mount.volume !== env.volumeName || mount.subpath === undefined || mount.subpath === '' || !mount.target.startsWith('/')) return undefined;
  if (mount.subpath.startsWith('/') || mount.subpath.includes('\0')) return undefined;
  const target = path.posix.normalize(mount.target).replace(/(.)\/+$/, '$1');
  const canonical = path.posix.join(WORKSPACES_ROOT, mount.subpath).replace(/(.)\/+$/, '$1');
  return canonical === target && target.startsWith(`${repositoryFolder(env.repository)}/`) ? target : undefined;
}

/** The kernel's escapes of `/proc/self/mountinfo` (`\040` for a space, `\011`, `\012`, `\134`). */
function mountInfoPath(text: string): string {
  return text.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * Review round 14 (P14-1): of `candidates` (workspaceIdentityMounts), the targets whose mount shows the folder of the
 * volume at its canonical path, from `/proc/self/mountinfo` of the dev container (`mountInfo`): the mount at the target
 * lies on the same file system (`major:minor`) as the mount at WORKSPACES_ROOT (the whole workspace volume), and its root
 * in that file system is the root of the mount at WORKSPACES_ROOT joined with the subpath. The kernel records the real
 * folder: a link in the volume (Docker follows links in a subpath within the volume) gives another root, and the mount
 * stays protected. The topmost mount of a path counts (the last line). Without a clear answer, none.
 */
export function verifiedIdentityTargets(candidates: readonly WorkspaceIdentityMount[], mountInfo: string): Set<string> {
  const mounts = new Map<string, { device: string; root: string }>();
  for (const line of mountInfo.split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 5 || !/^\d+:\d+$/.test(fields[2])) continue;
    mounts.set(mountInfoPath(fields[4]), { device: fields[2], root: mountInfoPath(fields[3]) });
  }
  const verified = new Set<string>();
  const workspaces = mounts.get(WORKSPACES_ROOT);
  if (workspaces === undefined || !workspaces.root.startsWith('/')) return verified;
  const base = workspaces.root === '/' ? '' : workspaces.root.replace(/\/+$/, '');
  for (const candidate of candidates) {
    const mount = mounts.get(candidate.target);
    if (mount !== undefined && mount.device === workspaces.device && mount.root === `${base}/${candidate.subpath}`) verified.add(candidate.target);
  }
  return verified;
}

/**
 * Review round 9 (D9-2): serviceFoldersOf relative to the repository folder, as the user knows them (`./data/postgres`),
 * for the confirmation of Delete. Only the paths below the repository folder.
 */
export function repositoryServiceDataFolders(env: Pick<Environment, 'repository' | 'serviceFolders'>): string[] {
  const folder = repositoryFolder(env.repository);
  return serviceFoldersOf(env)
    .filter((path) => path.startsWith(`${folder}/`) && path.length > folder.length + 1)
    .map((path) => `./${path.slice(folder.length + 1)}`);
}

/**
 * Whether the Docker Compose configuration changed since the build of `record` (review round 1, P-4), from the model
 * hash (composeConfigHash, `configHash`), the hash of the files as written (composeInputsHash), and the version of the
 * Compose plugin that printed the model:
 * - `changed`: the files differ, or they are equal and the same Compose version printed another model (for example a
 *   value of the environment of the helper that the model uses);
 * - `rebaseline`: only the Compose version and with it the printed model differ: no change for the user; the record
 *   takes the new model hash and version;
 * - `unchanged`: otherwise.
 * A record that is no valid Docker Compose record (composeRecordOf) compares the model hash alone.
 */
export function composeConfigurationChange(
  record: Pick<BuildRecord, 'configHash' | 'compose'>,
  current: { configHash: string; inputsHash: string; version: string },
): 'changed' | 'unchanged' | 'rebaseline' {
  const compose = composeRecordOf(record as BuildRecord);
  if (compose === undefined) return record.configHash === current.configHash ? 'unchanged' : 'changed';
  if (compose.inputsHash !== current.inputsHash) return 'changed';
  if (record.configHash === current.configHash) return compose.version === current.version ? 'unchanged' : 'rebaseline';
  return compose.version === current.version ? 'changed' : 'rebaseline';
}

/**
 * A container that Docker Compose created for the project `project` (the dev container or another service): the label
 * of the project together with a label that Compose puts only on containers, never on images (the number of the
 * container, or the hash of its configuration). Review round 2 (D2-4): the label of the project alone can come from the
 * image (a single container created from an image that Compose built for the project).
 */
export function isComposeContainer(labels: Readonly<Record<string, string>>, project: string): boolean {
  return labels[COMPOSE_PROJECT_LABEL] === project && (labels[COMPOSE_CONTAINER_NUMBER_LABEL] !== undefined || labels[COMPOSE_CONFIG_HASH_LABEL] !== undefined);
}

/** Labels that Docker Compose puts on the containers that it creates (not on images): isComposeContainer. */
export const COMPOSE_CONTAINER_NUMBER_LABEL = 'com.docker.compose.container-number';
export const COMPOSE_CONFIG_HASH_LABEL = 'com.docker.compose.config-hash';
/** Recreate offer, review round 2: label of a one-off container of `docker compose run` (`True`); `up` leaves it. */
export const COMPOSE_ONEOFF_LABEL = 'com.docker.compose.oneoff';

/**
 * The containers of a Docker Compose environment in the order of `docker start` or `docker stop`: `start` puts the
 * other services (label nimblescape.devenv.compose-service) first and the dev container last, so that a database runs
 * before the lifecycle commands of the dev container need it; `stop` the reverse (the dev container first, D-20).
 */
export function composeContainerOrder<T extends { labels: Readonly<Record<string, string>> }>(containers: readonly T[], order: 'start' | 'stop'): T[] {
  const services = containers.filter((container) => container.labels[LABEL_COMPOSE_SERVICE] !== undefined);
  const dev = containers.filter((container) => container.labels[LABEL_COMPOSE_SERVICE] === undefined);
  return order === 'start' ? [...services, ...dev] : [...dev, ...services];
}

/**
 * What Docker Compose accepts as the key of a top-level volume (compose-go schema, `volumes` patternProperties; Compose
 * does not interpolate keys). Review round 17 (D17-1).
 */
export const COMPOSE_VOLUME_KEY = /^[a-zA-Z0-9._-]+$/;

/**
 * The named volumes of the `mounts` of devcontainer.json, of the merged configuration, and of the image metadata in a
 * Docker Compose configuration (each argument is one `mounts` value: a list, or a single mount). The Dev Container CLI
 * puts them into the project (`<project>_<source>`, composeMountVolumeName), unless the mount says `external`:
 * - `names`: their Docker names, which the pipeline creates before `up` with the labels of the environment;
 * - `sources`: the sources of the project volumes, which our model declares as external volumes (mountVolumeSources).
 * Review round 17 (D17-1): each mount is first substituted with `variables` as the CLI substitutes it at `up`
 * (helperCliVariables with the real `${devcontainerId}` of the environment, environmentDevcontainerId; never
 * DEVCONTAINER_ID_PLACEHOLDER), so that the names are those that the CLI writes. A source (or the name of an external
 * mount) that is still no valid key of a Compose volume (COMPOSE_VOLUME_KEY: for example a `${localEnv:…}` whose value
 * is not known) is left out of both lists and returned in `skipped`: our model does not name it, the pipeline does not
 * create it, and it never reaches a command; the CLI writes it into its compose file as it is.
 */
export function composeMountVolumes(
  project: string,
  mounts: readonly unknown[],
  variables?: CliVariables,
): { names: string[]; sources: string[]; skipped: string[] } {
  const names = new Set<string>();
  const sources = new Set<string>();
  const skipped = new Set<string>();
  for (const value of mounts) {
    for (const written of Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]) {
      const mount = variables !== undefined ? resolveCliVariables(written, variables).value : written;
      const name = composeMountVolumeName(project, mount);
      if (name === undefined) continue;
      const external = isRecord(mount) && mount.external === true;
      const source = external ? name : name.slice(project.length + 1);
      if (!COMPOSE_VOLUME_KEY.test(source)) {
        skipped.add(source);
        continue;
      }
      names.add(name);
      if (!external) sources.add(source);
    }
  }
  return { names: [...names], sources: [...sources], skipped: [...skipped] };
}
