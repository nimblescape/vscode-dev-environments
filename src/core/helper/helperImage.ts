// Image of the workspace helper (implementation notes 7): built locally from resources/helper/Dockerfile. With a state
// file, the base image is checked once a week (a changed base image rebuilds the same tag), and helper images that no
// window uses anymore are removed once a day.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ContainerAdapter, ImageInfo } from '../docker/containerAdapter';
import { errorMessage } from '../errors';
import { extractBaseImages } from '../imageCheck/dockerfile';
import { IMAGE_CHECK_TIMEOUT_MS } from '../imageCheck/imageCheck';
import { parseImageReference } from '../imageCheck/reference';
import type { RegistryClient } from '../imageCheck/registryClient';
import { LABEL_HELPER } from '../names';
import { abortError, isAbortError, isoTime, silentLogger, systemClock, type Clock, type Logger } from '../ports';
import { isHelperImageTag, readHelperState, updateHelperState, type HelperImageRecord, type HelperState } from './helperState';

/**
 * Version of `@devcontainers/cli` in the helper image. It comes from the exact devDependency in package.json:
 * esbuild.mjs (and vitest.config.ts for the tests) puts it into the code at build time (scripts/cliVersion.mjs).
 * The version is part of the helper image tag, so after a version bump every user's helper is rebuilt at first use.
 */
export const DEVCONTAINER_CLI_VERSION: string = __DEVCONTAINER_CLI_VERSION__;

/** Repository part of the helper image tag. */
export const HELPER_IMAGE_REPOSITORY = 'devenv-helper';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The digest of the base image of a helper tag is checked at most this often. */
export const HELPER_CHECK_INTERVAL_MS = 7 * DAY_MS;
/** Another helper image that no window used for this long is removed. */
export const HELPER_UNUSED_LIMIT_MS = 7 * DAY_MS;
/** The cleanup of other helper images runs at most this often. */
export const HELPER_CLEANUP_INTERVAL_MS = DAY_MS;
/** `lastUsedAt` of a helper tag is written at most this often. */
export const HELPER_LAST_USED_INTERVAL_MS = HOUR_MS;

/** The part of ContainerAdapter that the helper image needs. */
export type HelperImageDocker = Pick<
  ContainerAdapter,
  'imageExists' | 'imageId' | 'buildImage' | 'listImagesByLabel' | 'removeImage'
>;

/**
 * Current registry digest of an image reference. `'unreachable'`: the registry did not answer (no connection, time
 * limit); `undefined`: the registry answered without a digest (for example sign-in required, not found), or the
 * reference is invalid. Should not throw; a rejection counts as `'unreachable'`.
 */
export type BaseDigestLookup = (reference: string, signal?: AbortSignal) => Promise<string | 'unreachable' | undefined>;

/**
 * A BaseDigestLookup with the registry client of the image check (the same credentials), under the time limit of the
 * image check (5 seconds, NFR-08). A registry that cannot be reached or does not answer in time gives `'unreachable'`.
 */
export function registryBaseDigest(
  client: Pick<RegistryClient, 'getDigest'>,
  timeoutMs: number = IMAGE_CHECK_TIMEOUT_MS,
): BaseDigestLookup {
  return async (reference, signal) => {
    const parsed = parseImageReference(reference);
    if (!parsed) return undefined;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // getDigest never throws; an aborted signal gives `unreachable`.
      const result = await client.getDigest(parsed, controller.signal);
      if (result.kind === 'digest') return result.digest;
      return result.kind === 'unreachable' ? 'unreachable' : undefined;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * `devenv-helper:<first 12 hex characters of sha256(Dockerfile content + CLI version)>`.
 * Line endings are normalized, so that a checkout with CRLF line endings gives the same tag.
 */
export function helperImageTag(dockerfileContent: string, cliVersion: string = DEVCONTAINER_CLI_VERSION): string {
  const hash = crypto
    .createHash('sha256')
    .update(dockerfileContent.replace(/\r\n/g, '\n'))
    .update(cliVersion)
    .digest('hex');
  return `${HELPER_IMAGE_REPOSITORY}:${hash.slice(0, 12)}`;
}

export interface EnsureHelperImageOptions {
  onOutput?: (text: string) => void;
  signal?: AbortSignal;
  /**
   * `helper.json` in the global storage folder (StoragePaths.helperState). Without it, the image is only built when its
   * tag is missing: no check of the base image, no cleanup.
   */
  statePath?: string;
  /** Current digest of the base image (registryBaseDigest). Without it, the base image is not checked. */
  baseDigest?: BaseDigestLookup;
  /** Time limit of `baseDigest`; after it, the registry counts as unreachable. Default IMAGE_CHECK_TIMEOUT_MS. */
  baseDigestTimeoutMs?: number;
  clock?: Clock;
  logger?: Logger;
}

type BuildFlags = { pull?: boolean; noCache?: boolean };

interface Maintenance {
  docker: HelperImageDocker;
  tag: string;
  statePath: string;
  /** First FROM image of the Dockerfile (with the ARG defaults), `undefined` if there is none. */
  baseImage: string | undefined;
  options: EnsureHelperImageOptions;
  clock: Clock;
  logger: Logger;
  build(flags: BuildFlags): Promise<void>;
}

/**
 * Builds the helper image if its tag is missing (first use, and after an extension update that changed the Dockerfile
 * or the CLI version). The build context is the folder of the Dockerfile. Returns the tag. Throws CommandError when
 * the image is missing and cannot be built.
 *
 * With `statePath` (implementation notes 7):
 * - A missing tag is built with `--pull`, so a new helper starts from the current base image (without `--pull` when the
 *   registry cannot be reached: the local base image and the build cache may still build it).
 * - An existing tag whose base image was not checked for 7 days: the registry digest of the base image is compared
 *   with the recorded one. A changed base image rebuilds the same tag with `--pull --no-cache`; the previous image is
 *   then removed if it has no tag anymore. No connection, or a failed rebuild, keeps the existing image.
 * - `lastUsedAt` of the tag is written (at most once per hour), then the cleanup runs (at most once per day).
 * Problems of the check, the state file, and the cleanup are logged and never make this function fail.
 */
export async function ensureHelperImage(
  docker: HelperImageDocker,
  dockerfilePath: string,
  options: EnsureHelperImageOptions = {},
): Promise<string> {
  const content = await fs.promises.readFile(dockerfilePath, 'utf8');
  const tag = helperImageTag(content);
  const build = (flags: BuildFlags): Promise<void> =>
    docker.buildImage({
      tag,
      dockerfile: dockerfilePath,
      context: path.dirname(dockerfilePath),
      labels: { [LABEL_HELPER]: 'true' },
      buildArgs: { DEVCONTAINER_CLI_VERSION },
      ...flags,
      onOutput: options.onOutput,
      signal: options.signal,
    });
  if (options.statePath === undefined) {
    if (await docker.imageExists(tag)) return tag;
    await build({});
    return tag;
  }
  return ensureWithState({
    docker,
    tag,
    statePath: options.statePath,
    baseImage: baseImageOf(content),
    options,
    clock: options.clock ?? systemClock,
    logger: options.logger ?? silentLogger,
    build,
  });
}

/**
 * Records that a window uses the helper tag: `lastUsedAt = now`, unless it is less than an hour old. For helper runs
 * of a window that ensured the image earlier. Never throws.
 */
export async function recordHelperImageUse(
  statePath: string,
  tag: string,
  options: { clock?: Clock; logger?: Logger } = {},
): Promise<void> {
  const clock = options.clock ?? systemClock;
  try {
    const state = await readHelperState(statePath);
    if (!isDue(state.images[tag]?.lastUsedAt, clock.now(), HELPER_LAST_USED_INTERVAL_MS)) return;
    await updateHelperState(statePath, (fresh) => {
      fresh.images[tag] = { ...fresh.images[tag], lastUsedAt: isoTime(clock) };
    });
  } catch (error) {
    (options.logger ?? silentLogger).warn(`The state of the workspace helper image could not be written: ${errorMessage(error)}`);
  }
}

function baseImageOf(dockerfileContent: string): string | undefined {
  try {
    return extractBaseImages(dockerfileContent)[0];
  } catch {
    return undefined;
  }
}

/** Age of an ISO time in ms, or `undefined` if the time is missing or invalid. Negative for a time in the future. */
function ageMs(time: string | undefined, now: number): number | undefined {
  if (time === undefined) return undefined;
  const parsed = Date.parse(time);
  return Number.isNaN(parsed) ? undefined : now - parsed;
}

/** True if `time` is missing, invalid, in the future (the clock was set back), or at least `intervalMs` ago. */
function isDue(time: string | undefined, now: number, intervalMs: number): boolean {
  const age = ageMs(time, now);
  return age === undefined || age < 0 || age >= intervalMs;
}

async function ensureWithState(m: Maintenance): Promise<string> {
  const { docker, tag } = m;
  const recorded = (await readHelperState(m.statePath)).images[tag];
  let currentId = await docker.imageId(tag);
  // `replace`: the record of a new build replaces the old record of the tag (for example after an image prune).
  let change: { record: HelperImageRecord; replace: boolean } | undefined;

  if (currentId === undefined) {
    const digest = await lookUpBaseDigest(m);
    await m.build({ pull: digest !== 'unreachable' });
    const now = isoTime(m.clock);
    const record: HelperImageRecord = { builtAt: now };
    if (m.baseImage !== undefined) record.baseImage = m.baseImage;
    // Without an answer of the registry, checkedAt stays empty: the next job reads the digest.
    if (digest !== undefined && digest !== 'unreachable') {
      record.baseDigest = digest;
      record.checkedAt = now;
    }
    change = { record, replace: true };
    currentId = await imageIdQuietly(m);
  } else if (
    m.baseImage !== undefined &&
    m.options.baseDigest &&
    isDue(recorded?.checkedAt, m.clock.now(), HELPER_CHECK_INTERVAL_MS)
  ) {
    const refreshed = await refresh(m, m.baseImage, recorded, currentId);
    if (refreshed.record) change = { record: refreshed.record, replace: false };
    currentId = refreshed.currentId;
  }

  if (change || isDue(recorded?.lastUsedAt, m.clock.now(), HELPER_LAST_USED_INTERVAL_MS)) {
    const record = change?.record ?? {};
    const replace = change?.replace === true;
    await writeState(m, (state) => {
      state.images[tag] = { ...(replace ? {} : state.images[tag]), ...record, lastUsedAt: isoTime(m.clock) };
    });
  }
  // Without the ID of the current image, nothing is removed.
  if (currentId !== undefined) await cleanUpIfDue(m, currentId);
  return tag;
}

/**
 * Step 3 of the refresh (implementation notes 7): compares the registry digest of the base image with the recorded one.
 * Returns the fields to record (none when the registry could not be reached, so the next job checks again) and the ID
 * of the current image of the tag.
 */
async function refresh(
  m: Maintenance,
  baseImage: string,
  recorded: HelperImageRecord | undefined,
  currentId: string,
): Promise<{ record?: HelperImageRecord; currentId: string | undefined }> {
  const { tag, logger } = m;
  const digest = await lookUpBaseDigest(m);
  const now = isoTime(m.clock);
  if (digest === 'unreachable') {
    logger.info(`The base image ${baseImage} of the workspace helper could not be checked: the registry did not answer. The existing image is used.`);
    return { currentId };
  }
  if (digest === undefined) {
    logger.warn(`The registry returned no digest for the base image ${baseImage} of the workspace helper. It is checked again in a week.`);
    return { record: { checkedAt: now }, currentId };
  }
  const known = recorded?.baseImage === undefined || recorded.baseImage === baseImage ? recorded?.baseDigest : undefined;
  if (known === undefined) {
    // An image built before the digest was recorded: the current digest is the reference from now on, without a rebuild.
    return { record: { baseImage, baseDigest: digest, checkedAt: now }, currentId };
  }
  if (known.toLowerCase() === digest.toLowerCase()) return { record: { checkedAt: now }, currentId };

  logger.info(`The base image ${baseImage} of the workspace helper has changed. The image ${tag} is built again.`);
  try {
    // A fresh base image, and no cache: the Debian packages and the Docker CLI are installed again, too.
    await m.build({ pull: true, noCache: true });
  } catch (error) {
    if (isAbortError(error)) throw error;
    // Docker moves the tag only after a successful build: the existing image stays. The next check is in a week.
    logger.warn(`The workspace helper image ${tag} could not be built again. The existing image is used: ${errorMessage(error)}`);
    return { record: { checkedAt: now }, currentId };
  }
  const builtAt = isoTime(m.clock);
  const newId = await imageIdQuietly(m);
  if (newId !== undefined && newId !== currentId) await removePreviousImage(m, currentId, newId);
  return { record: { baseImage, baseDigest: digest, builtAt, checkedAt: builtAt }, currentId: newId };
}

/**
 * `baseDigest` for the base image, under its time limit: a lookup that does not answer in time counts as
 * `'unreachable'`, so an offline registry never blocks the helper. Rejects with an AbortError when the signal aborts.
 */
async function lookUpBaseDigest(m: Maintenance): Promise<string | 'unreachable' | undefined> {
  const lookup = m.options.baseDigest;
  const baseImage = m.baseImage;
  if (!lookup || baseImage === undefined) return undefined;
  const signal = m.options.signal;
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const result = await new Promise<string | 'unreachable' | undefined>((resolve) => {
    const finish = (value: string | 'unreachable' | undefined): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
      resolve(value);
    };
    const onAbort = (): void => finish('unreachable');
    const timer = setTimeout(() => finish('unreachable'), m.options.baseDigestTimeoutMs ?? IMAGE_CHECK_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Through a promise chain, so that a lookup that throws at once counts as unreachable, too.
    Promise.resolve()
      .then(() => lookup(baseImage, controller.signal))
      .then(
        (value) => finish(value === 'unreachable' || (typeof value === 'string' && value !== '') ? value : undefined),
        (error: unknown) => {
          m.logger.warn(`The digest of the base image ${baseImage} could not be read: ${errorMessage(error)}`);
          finish('unreachable');
        },
      );
  });
  if (signal?.aborted) throw abortError();
  return result;
}

async function imageIdQuietly(m: Maintenance): Promise<string | undefined> {
  try {
    return await m.docker.imageId(m.tag);
  } catch (error) {
    m.logger.warn(`The ID of the workspace helper image ${m.tag} could not be read: ${errorMessage(error)}`);
    return undefined;
  }
}

async function writeState(m: Maintenance, update: (state: HelperState) => void): Promise<void> {
  try {
    await updateHelperState(m.statePath, update);
  } catch (error) {
    m.logger.warn(`The state of the workspace helper image could not be written: ${errorMessage(error)}`);
  }
}

async function listHelperImages(m: Maintenance): Promise<ImageInfo[] | undefined> {
  try {
    return await m.docker.listImagesByLabel(`${LABEL_HELPER}=true`);
  } catch (error) {
    m.logger.warn(`The workspace helper images could not be listed: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * Removes the image of the previous build after a rebuild, if it has no tag anymore. A running helper of another
 * window may still use it: then Docker refuses, and the cleanup removes it later.
 */
async function removePreviousImage(m: Maintenance, previousId: string, currentId: string): Promise<void> {
  const images = await listHelperImages(m);
  const previous = images?.find((image) => image.id === previousId);
  if (previous && previous.tags.length === 0) await removeHelperImage(m, previous, previous.id, currentId);
}

/**
 * `docker image rm` (never with force) of an image of the helper listing, by its ID or one of its tags. Never the
 * image that the current tag points to. Failures are logged. Returns true if the image or tag was removed.
 */
async function removeHelperImage(m: Maintenance, image: ImageInfo, reference: string, currentId: string): Promise<boolean> {
  if (image.id === currentId || reference === m.tag || reference === currentId) return false;
  try {
    return await m.docker.removeImage(reference);
  } catch (error) {
    m.logger.warn(`The workspace helper image ${reference} could not be removed: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * Step 5 (implementation notes 7), at most once per day: of the images with the label devenv.helper=true, except the
 * image of the current tag, it removes dangling images, and helper tags that the state knows and that no window used
 * for 7 days. A helper tag that the state does not know gets `lastUsedAt = now`: a helper of another extension version
 * that is still used (old windows during an update) is not removed at once. Tags of other repositories are never
 * removed.
 */
async function cleanUpIfDue(m: Maintenance, currentId: string): Promise<void> {
  const nowMs = m.clock.now();
  const state = await readHelperState(m.statePath);
  if (!isDue(state.lastCleanupAt, nowMs, HELPER_CLEANUP_INTERVAL_MS)) return;
  const images = await listHelperImages(m);
  if (!images) return;

  const now = isoTime(m.clock);
  const listed = new Set<string>();
  const graced: string[] = [];
  const removed: string[] = [];
  for (const image of images) {
    for (const tag of image.tags) listed.add(tag);
    if (image.id === currentId) continue;
    if (image.tags.length === 0) {
      await removeHelperImage(m, image, image.id, currentId);
      continue;
    }
    for (const tag of image.tags.filter(isHelperImageTag)) {
      if (tag === m.tag) continue;
      const age = ageMs(state.images[tag]?.lastUsedAt, nowMs);
      if (age === undefined || age < 0) {
        graced.push(tag);
      } else if (age >= HELPER_UNUSED_LIMIT_MS) {
        m.logger.info(`The workspace helper image ${tag} was not used for ${Math.floor(age / DAY_MS)} days. It is removed.`);
        if (await removeHelperImage(m, image, tag, currentId)) removed.push(tag);
      }
    }
  }

  await writeState(m, (fresh) => {
    fresh.lastCleanupAt = now;
    for (const tag of graced) {
      const age = ageMs(fresh.images[tag]?.lastUsedAt, nowMs);
      if (age === undefined || age < 0) fresh.images[tag] = { ...fresh.images[tag], lastUsedAt: now };
    }
    for (const tag of removed) delete fresh.images[tag];
    // Records of tags that do not exist anymore (for example removed by the user) are dropped when they are old.
    for (const [tag, record] of Object.entries(fresh.images)) {
      if (tag === m.tag || listed.has(tag)) continue;
      if (!isRecent(record.lastUsedAt, nowMs) && !isRecent(record.builtAt, nowMs)) delete fresh.images[tag];
    }
  });
}

function isRecent(time: string | undefined, now: number): boolean {
  const age = ageMs(time, now);
  return age !== undefined && age < HELPER_UNUSED_LIMIT_MS;
}
