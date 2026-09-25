// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Pure decisions and helpers of the open pipeline (concept 7.6, 7.7, 7.12). No I/O.
import * as crypto from 'crypto';
import { CommandError, errorMessage } from '../errors';
import type { CheckedOutcome } from '../imageCheck/imageCheck';
import { isDockerHub, parseImageReference } from '../imageCheck/reference';
import { CONTAINER_CONFIG_UNKNOWN, CONTAINER_VERSION, LABEL_CONTAINER_CONFIG, LABEL_CONTAINER_VERSION } from '../names';
import type { DevcontainerResult, RefusedUpdate } from '../types';

export type { RefusedUpdate };

/** Configuration path of an environment whose configuration is not known yet (the pipeline falls back to the first one found). */
export const DEFAULT_CONFIG_PATH = '.devcontainer/devcontainer.json';

/**
 * True for a container of the current setup: its label devenv.container-version is CONTAINER_VERSION or newer. The
 * pipeline creates an older container (without the variables of container-only Git, concept section 9) again from its
 * environment image; the volume stays.
 * `configKnown`: the configuration of the repository can be read now. Then a container that was created without it
 * (label devenv.container-config=unknown) is not current either: it lacks the runArgs and appPort of the configuration.
 * While the configuration cannot be read, such a container is current, so it is only started and not created again at
 * every open.
 */
export function containerIsCurrent(labels: Readonly<Record<string, string>>, configKnown = true): boolean {
  const text = labels[LABEL_CONTAINER_VERSION];
  const version = text !== undefined && /^\d{1,6}$/.test(text) ? Number(text) : 0;
  if (version < CONTAINER_VERSION) return false;
  return !configKnown || labels[LABEL_CONTAINER_CONFIG] !== CONTAINER_CONFIG_UNKNOWN;
}

/** The field `refusedUpdate` of a registry entry, when it is valid. */
export function refusedUpdateOf(entry: object): RefusedUpdate | undefined {
  const value: unknown = (entry as { refusedUpdate?: unknown }).refusedUpdate;
  if (
    !isRecord(value) ||
    typeof value.configPath !== 'string' ||
    typeof value.configHash !== 'string' ||
    !isStringRecord(value.images) ||
    !isStringRecord(value.features) ||
    typeof value.items !== 'string'
  ) {
    return undefined;
  }
  return { configPath: value.configPath, configHash: value.configHash, images: value.images, features: value.features, items: value.items };
}

/** True if `update` is the refused update `refused`: same configuration, same digests (ignoring the case). */
export function isRefusedUpdate(refused: RefusedUpdate | undefined, update: Omit<RefusedUpdate, 'items'>): boolean {
  return (
    refused !== undefined &&
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
 * The user that `devcontainer up` gives a container of an environment image, by the rule of the Dev Container CLI:
 * the last `remoteUser` of the label devcontainer.metadata, else its last `containerUser`, else the user of the image,
 * else root. `imageConfig` is `Config` of `docker image inspect`.
 */
export function imageRemoteUser(imageConfig: unknown): string {
  const config = isRecord(imageConfig) ? imageConfig : {};
  const labels = isRecord(config.Labels) ? config.Labels : {};
  let remoteUser: string | undefined;
  let containerUser: string | undefined;
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
      remoteUser = nonEmptyString(entry.remoteUser) ?? remoteUser;
      containerUser = nonEmptyString(entry.containerUser) ?? containerUser;
    }
  }
  const imageUser = typeof config.User === 'string' ? nonEmptyString(config.User.split(':')[0]) : undefined;
  return remoteUser ?? containerUser ?? imageUser ?? 'root';
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
