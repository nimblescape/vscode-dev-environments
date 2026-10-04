// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Image of the workspace helper (implementation notes 7): built locally from resources/helper/Dockerfile. With a state
// file, the base image is checked once a week in the background (a changed base image rebuilds the same tag at the next
// ensure), and helper images that no window uses anymore are removed once a day. User decision 2026-09-29: there is no
// previous helper image. When the current tag is missing and cannot be built, the ensure fails (the open then fails with
// helperFailed); the background prebuild after an extension update (HelperPrebuild) builds the new tag early.
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
import { isHelperImageTag, isMonitorImageTag, monitorImageTag, readHelperState, updateHelperState, type HelperImageRecord, type HelperState } from './helperState';

/**
 * Version of `@devcontainers/cli` in the helper image. It comes from the exact devDependency in package.json:
 * esbuild.mjs (and vitest.config.ts for the tests) puts it into the code at build time (scripts/cliVersion.mjs).
 * The version is part of the helper image tag, so after a version bump every user's helper is rebuilt at first use.
 */
export const DEVCONTAINER_CLI_VERSION: string = __DEVCONTAINER_CLI_VERSION__;

/** Repository part of the helper image tag. */
export const HELPER_IMAGE_REPOSITORY = 'devenv-helper';

/**
 * Review round 2 of PR #64 (A-N2): the helper generation of this extension version, recorded per tag in helper.json
 * (`generation`, for diagnosis) at each build and rebuild. Review round 3 of PR #64 (P5): it is part of the helper tag
 * (helperImageTag), so raising it gives a new current tag, which is built: an image of an older generation never stays
 * the current helper (for example after a release that fixes a security problem in the helper image, when neither the
 * Dockerfile nor the CLI version changed).
 */
export const HELPER_GENERATION = 1;

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
/** A check of the base image that got no answer from the registry is tried again after this time. */
export const HELPER_RETRY_INTERVAL_MS = DAY_MS;
/**
 * A helper tag that the cleanup removed and that comes back (another installation of VS Code built it again) stays for
 * this long after the removal. Then the tombstone expires: the tag gets a new grace period, and an unlisted tag is forgotten.
 */
export const HELPER_TOMBSTONE_MS = 90 * DAY_MS;

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
 * `devenv-helper:<first 12 hex characters of sha256(Dockerfile content + CLI version + "\ngeneration " + helper
 * generation)>`. Line endings are normalized, so that a checkout with CRLF line endings gives the same tag. Review round
 * 3 of PR #64 (P5): the helper generation (HELPER_GENERATION) is part of the hash.
 */
export function helperImageTag(
  dockerfileContent: string,
  cliVersion: string = DEVCONTAINER_CLI_VERSION,
  generation: number = HELPER_GENERATION,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(dockerfileContent.replace(/\r\n/g, '\n'))
    .update(cliVersion)
    .update(`\ngeneration ${generation}`)
    .digest('hex');
  return `${HELPER_IMAGE_REPOSITORY}:${hash.slice(0, 12)}`;
}

/**
 * PR #74 review round 2, A-R2-1: the current helper tag (helperImageTag) of the Dockerfile at `dockerfilePath`, the tag
 * that ensureHelperImageUse ensures. Throws when the Dockerfile cannot be read.
 */
export async function currentHelperImageTag(dockerfilePath: string): Promise<string> {
  return helperImageTag(await fs.promises.readFile(dockerfilePath, 'utf8'));
}

/**
 * The helper image that an ensure resolved (ensureHelperImageUse), and the helper image of an open (review round 2 of
 * PR #64, A-N1): the open pipeline resolves it once per open and passes it to every helper run of that open (`image`),
 * so the configuration that the CLI of one helper image read and checked is run with the same CLI, whatever another open
 * in this window resolves meanwhile. Always the current tag (user decision 2026-09-29: no previous helper image).
 */
export interface HelperImageUse {
  /** The helper tag: the key of helper.json, the label of the remote Session Monitor, and the name in log lines. */
  tag: string;
  /**
   * Review round 3 of PR #64 (P2): the ID of the image that the ensure checked: the image that this ensure built (found by
   * its build label, review round 4 of PR #64, R4-2/R4-3) or found for the tag. The runs of an open use it as the image
   * reference, so a tag that moves (a rebuild of another window, a build of another installation) never changes the
   * helper image of an open. `undefined` only when the ID could not be read; its runs then use the tag.
   */
  id?: string;
}

/** `create`: a missing tag is built; `refresh`: an existing tag is built again from a new base image. */
export type HelperBuildKind = 'create' | 'refresh';

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
  /**
   * `false` for the helper runs (default `true`): only a missing tag is built and the use is recorded; the check of the
   * base image, a rebuild that a check asked for, and the cleanup are left to the open pipeline.
   */
  maintain?: boolean;
  /**
   * `false` when the setting updateImagesOnConnect is off (default `true`): the base image is not checked, and a rebuild
   * that an earlier check asked for waits. A missing tag is still built with `--pull`.
   */
  checkBaseImage?: boolean;
  /** Called right before a build of the helper image. */
  onBuild?: (kind: HelperBuildKind) => void;
  /**
   * Called with the check of the base image when it starts. It runs in the background, after this function returned; the
   * promise never rejects (for tests, and for callers that want to wait for it).
   */
  onBaseImageCheck?: (check: Promise<void>) => void;
  clock?: Clock;
  logger?: Logger;
}

type BuildFlags = { pull?: boolean; noCache?: boolean };

/** How a build or a check changes the record of the tag: a function of the current record. */
type RecordChange = (record: HelperImageRecord | undefined) => HelperImageRecord;

interface Maintenance {
  docker: HelperImageDocker;
  tag: string;
  statePath: string;
  /** First FROM image of the Dockerfile (with the ARG defaults), `undefined` if there is none. */
  baseImage: string | undefined;
  options: EnsureHelperImageOptions;
  clock: Clock;
  logger: Logger;
  /** The build; resolves with the ID of the built image (by its build label), `undefined` when it could not be found. */
  build(flags: BuildFlags): Promise<string | undefined>;
}

/**
 * Builds the helper image if its tag is missing (first use, and after an extension update that changed the Dockerfile
 * or the CLI version). The build context is the folder of the Dockerfile. Returns the tag. Throws CommandError when
 * the image is missing and cannot be built.
 *
 * With `statePath` (implementation notes 7):
 * - A missing tag is built with `--pull`, so a new helper starts from the current base image. Without `--pull` when the
 *   registry cannot be reached, or when the build with `--pull` fails (for example the pull limit of Docker Hub): the
 *   local base image and the build cache may still build it, and the next check that reaches the registry asks for a
 *   rebuild from the current base image.
 * - `maintain` (not for the helper runs): a rebuild that an earlier check asked for runs now, with `--pull --no-cache`;
 *   the previous image is then removed if it has no tag anymore. A failed rebuild keeps the existing image. When the
 *   check of the base image is due (7 days after the last answer of the registry, a day after an attempt without an
 *   answer), it starts in the background, under its own time limit: this function does not wait for it. It compares the
 *   registry digest of the base image with the recorded one; a change asks the next ensure for a rebuild.
 * - `lastUsedAt` of the tag is written (at most once per hour); with `maintain`, the cleanup runs (at most once per day).
 * - User decision 2026-09-29: when the missing tag cannot be built, the error of the build is thrown; no other helper
 *   image is used in its place.
 * Problems of the check, the state file, and the cleanup are logged and never make this function fail.
 */
export async function ensureHelperImage(
  docker: HelperImageDocker,
  dockerfilePath: string,
  options: EnsureHelperImageOptions = {},
): Promise<string> {
  return (await ensureHelperImageUse(docker, dockerfilePath, options)).tag;
}

/**
 * ensureHelperImage, with the image that it resolved (HelperImageUse): the tag and the ID of its image (review round 3 of
 * PR #64, P1/P2). The ID of an image that this call built comes from the build
 * (its build label: review round 3 of PR #64, P4; review round 4 of PR #64, R4-2/R4-3), not from the tag.
 */
export async function ensureHelperImageUse(
  docker: HelperImageDocker,
  dockerfilePath: string,
  options: EnsureHelperImageOptions = {},
): Promise<HelperImageUse> {
  const content = await fs.promises.readFile(dockerfilePath, 'utf8');
  const tag = helperImageTag(content);
  const logger = options.logger ?? silentLogger;
  const build = (flags: BuildFlags): Promise<string | undefined> =>
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
    if (await docker.imageExists(tag)) return withId(tag, await imageIdOf(docker, tag, logger));
    options.onBuild?.('create');
    const builtId = await build({});
    return withId(tag, builtId ?? (await imageIdOf(docker, tag, logger)));
  }
  return ensureWithState({
    docker,
    tag,
    statePath: options.statePath,
    baseImage: baseImageOf(content),
    options,
    clock: options.clock ?? systemClock,
    logger,
    build,
  });
}

/** The HelperImageUse of the current tag `tag`, with the ID of its image when it is known. */
function withId(tag: string, id: string | undefined): HelperImageUse {
  return id !== undefined ? { tag, id } : { tag };
}

/** The ID of the image of `reference`, `undefined` (with a warning) when it cannot be read. */
async function imageIdOf(docker: HelperImageDocker, reference: string, logger: Logger): Promise<string | undefined> {
  try {
    return await docker.imageId(reference);
  } catch (error) {
    logger.warn(`The ID of the workspace helper image ${reference} could not be read: ${errorMessage(error)}`);
    return undefined;
  }
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
    const record = state.images[tag];
    if (!isDue(record?.lastUsedAt, clock.now(), HELPER_LAST_USED_INTERVAL_MS) && !isForeign(record)) return;
    await updateHelperState(statePath, (fresh) => {
      fresh.images[tag] = { ...owned(fresh.images[tag]), lastUsedAt: isoTime(clock) };
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

/** True if the record marks the tag as one of another installation, or as removed. */
function isForeign(record: HelperImageRecord | undefined): boolean {
  return record?.foreignSince !== undefined || record?.removedAt !== undefined;
}

/** The record of a tag that this installation uses: without the marks of the cleanup for foreign and removed tags. */
function owned(record: HelperImageRecord | undefined): HelperImageRecord {
  const { foreignSince: _foreign, removedAt: _removed, ...rest } = record ?? {};
  return rest;
}

async function ensureWithState(m: Maintenance): Promise<HelperImageUse> {
  const { docker, tag, options } = m;
  const maintain = options.maintain !== false;
  const checkBaseImage = options.checkBaseImage !== false;
  const recorded = (await readHelperState(m.statePath)).images[tag];
  let currentId = await docker.imageId(tag);
  let change: RecordChange | undefined;

  if (currentId === undefined) {
    // User decision 2026-09-29: a tag that cannot be built fails the ensure (no previous helper image).
    const created = await create(m, checkBaseImage);
    // Review round 3 of PR #64 (P4): helper.json records the ID of the image that this build made (by its build label), never
    // one read back by the tag, which another build may have moved meanwhile. The tag is read only for the cleanup
    // (which keeps the current image) and the ID of the open, when the build gave no ID.
    const builtId = created.id;
    currentId = builtId ?? (await imageIdQuietly(m));
    change = builtId === undefined ? created.change : (record) => ({ ...created.change(record), imageId: builtId });
  } else if (maintain && checkBaseImage && m.baseImage !== undefined && recorded?.latestBaseDigest !== undefined) {
    const rebuilt = await rebuild(m, m.baseImage, recorded, recorded.latestBaseDigest, currentId);
    change = rebuilt.change;
    currentId = rebuilt.currentId;
  }
  // Review round 2 of PR #64 (A-N3): `imageId` comes only from a build or rebuild of this installation. A tag that it
  // built before the field existed gets none (another installation may have built the image that the tag has now).

  // The check starts now, so its request runs while the open pipeline goes on; its result is written after the writes
  // of this function.
  const record = change ? change(recorded) : recorded;
  const check = maintain && checkBaseImage && isCheckDue(m, record) ? lookUpBaseDigest(m, undefined) : undefined;

  if (change || isForeign(recorded) || isDue(recorded?.lastUsedAt, m.clock.now(), HELPER_LAST_USED_INTERVAL_MS)) {
    await writeState(m, (state) => {
      const fresh = state.images[tag];
      state.images[tag] = { ...owned(change ? change(fresh) : fresh), lastUsedAt: isoTime(m.clock) };
    });
  }
  // Without the ID of the current image, nothing is removed.
  if (maintain && currentId !== undefined) await cleanUpIfDue(m, currentId);
  if (check && m.baseImage !== undefined) {
    const baseImage = m.baseImage;
    const done = check
      .then((digest) => recordCheck(m, baseImage, digest))
      .catch((error: unknown) => {
        m.logger.warn(`The check of the base image ${baseImage} of the workspace helper failed: ${errorMessage(error)}`);
      });
    options.onBaseImageCheck?.(done);
  }
  return withId(tag, currentId);
}

/** The weekly check of the base image is due: 7 days after the last answer of the registry, a day after an attempt. */
function isCheckDue(m: Maintenance, record: HelperImageRecord | undefined): boolean {
  if (!m.options.baseDigest || m.baseImage === undefined) return false;
  const now = m.clock.now();
  return isDue(record?.checkedAt, now, HELPER_CHECK_INTERVAL_MS) && isDue(record?.attemptedAt, now, HELPER_RETRY_INTERVAL_MS);
}

/**
 * Step 2 (implementation notes 7): builds a missing tag. The registry digest of the base image is read first (the build
 * takes much longer than this read), to decide about `--pull` and to record the digest. Returns the new record: it
 * replaces an old record of the tag (for example after an image prune).
 */
async function create(m: Maintenance, checkBaseImage: boolean): Promise<{ change: RecordChange; id: string | undefined }> {
  const lookedUp = checkBaseImage && m.options.baseDigest !== undefined && m.baseImage !== undefined;
  const digest = lookedUp ? await lookUpBaseDigest(m, m.options.signal) : undefined;
  const { pulled, id } = await buildMissing(m, digest !== 'unreachable');
  const now = isoTime(m.clock);
  // Review round 2 of PR #64 (A-N2): the helper generation of this build.
  const record: HelperImageRecord = { builtAt: now, generation: HELPER_GENERATION };
  if (m.baseImage !== undefined) record.baseImage = m.baseImage;
  if (!pulled) {
    // Maybe built from an old local base image: the next check that gets a digest asks for a rebuild.
    record.builtWithoutPull = now;
  } else if (digest !== undefined && digest !== 'unreachable') {
    record.baseDigest = digest;
    record.checkedAt = now;
  }
  // No digest yet: the check runs again in a day. Without a lookup (no check of the base image), at the next ensure.
  if (lookedUp && record.checkedAt === undefined) record.attemptedAt = now;
  return { change: () => record, id };
}

/**
 * Builds a missing tag, with `--pull` unless `pull` is false. A build with `--pull` that fails (the pull of the daemon
 * can fail where the request of the extension host worked: the pull limit, stored credentials that the registry
 * refuses, a proxy) is tried again without it. Returns whether the build pulled the base image, and the ID of the built
 * image (by its build label). Throws when the tag cannot be built.
 */
async function buildMissing(m: Maintenance, pull: boolean): Promise<{ pulled: boolean; id: string | undefined }> {
  m.options.onBuild?.('create');
  try {
    return { pulled: pull, id: await m.build({ pull }) };
  } catch (error) {
    if (!pull || isAbortError(error) || m.options.signal?.aborted) throw error;
    m.logger.warn(
      `The workspace helper image ${m.tag} could not be built with a fresh base image. It is built from the local base image: ${errorMessage(error)}`,
    );
  }
  return { pulled: false, id: await m.build({ pull: false }) };
}

/**
 * Step 3 (implementation notes 7), the rebuild that a check asked for: the same tag with `--pull --no-cache`, then the
 * removal of the previous image if it has no tag anymore. A failed rebuild keeps the existing image, and the next check
 * is in a week. An abort passes through and changes nothing, so the next ensure builds again.
 */
async function rebuild(
  m: Maintenance,
  baseImage: string,
  recorded: HelperImageRecord,
  digest: string,
  currentId: string,
): Promise<{ change: RecordChange; currentId: string | undefined }> {
  const { tag, logger } = m;
  logger.info(
    recorded.builtWithoutPull !== undefined
      ? `The workspace helper image ${tag} was built from the local base image. It is built again from the current base image ${baseImage}.`
      : `The base image ${baseImage} of the workspace helper has changed. The image ${tag} is built again.`,
  );
  m.options.onBuild?.('refresh');
  let builtId: string | undefined;
  try {
    // A fresh base image, and no cache: the Debian packages and the Docker CLI are installed again, too.
    builtId = await m.build({ pull: true, noCache: true });
  } catch (error) {
    if (isAbortError(error) || m.options.signal?.aborted) throw error;
    // Docker moves the tag only after a successful build: the existing image stays. The next check is in a week.
    logger.warn(`The workspace helper image ${tag} could not be built again. The existing image is used: ${errorMessage(error)}`);
    const checkedAt = isoTime(m.clock);
    return {
      change: (record) => {
        const { latestBaseDigest: _latest, ...rest } = record ?? {};
        return { ...rest, checkedAt };
      },
      currentId,
    };
  }
  const builtAt = isoTime(m.clock);
  // Review round 3 of PR #64 (P4): the ID of the rebuilt image comes from the build (its build label); the tag is read only
  // when the build gave none, and such an ID is not recorded.
  const newId = builtId ?? (await imageIdQuietly(m));
  if (newId !== undefined && newId !== currentId) await removePreviousImage(m, currentId, newId);
  return {
    change: (record) => {
      const { latestBaseDigest: _latest, builtWithoutPull: _unpulled, attemptedAt: _attempted, imageId: _id, ...rest } = record ?? {};
      // Review round 2 of PR #64 (A-N2): the helper generation of this rebuild.
      return {
        ...rest,
        baseImage,
        baseDigest: digest,
        builtAt,
        checkedAt: builtAt,
        generation: HELPER_GENERATION,
        ...(builtId !== undefined ? { imageId: builtId } : {}),
      };
    },
    currentId: newId,
  };
}

/**
 * Step 3 (implementation notes 7), the result of the check of the base image, in the background. No answer: the check
 * runs again in a day. No digest: in a week. A digest that differs from the recorded one, or any digest for an image
 * built without `--pull`, asks the next ensure for a rebuild. An image without a recorded digest (built before the
 * state existed, or by a build whose lookup got no digest) gets the digest, without a rebuild.
 */
async function recordCheck(m: Maintenance, baseImage: string, digest: string | 'unreachable' | undefined): Promise<void> {
  const { tag, logger } = m;
  const now = isoTime(m.clock);
  if (digest === 'unreachable') {
    logger.info(`The base image ${baseImage} of the workspace helper could not be checked: the registry did not answer. It is checked again in a day.`);
    await writeState(m, (state) => {
      state.images[tag] = { ...state.images[tag], attemptedAt: now };
    });
    return;
  }
  if (digest === undefined) {
    logger.warn(`The registry returned no digest for the base image ${baseImage} of the workspace helper. It is checked again in a week.`);
  }
  let rebuildReason: 'changed' | 'unpulled' | undefined;
  await writeState(m, (state) => {
    const { attemptedAt: _attempted, ...current } = state.images[tag] ?? {};
    if (digest === undefined) {
      state.images[tag] = { ...current, checkedAt: now };
      return;
    }
    // A rebuild that another window asked for is decided again with this digest.
    const { latestBaseDigest: _latest, ...record } = current;
    const known = record.baseImage === undefined || record.baseImage === baseImage ? record.baseDigest : undefined;
    rebuildReason =
      record.builtWithoutPull !== undefined
        ? 'unpulled'
        : known !== undefined && known.toLowerCase() !== digest.toLowerCase()
          ? 'changed'
          : undefined;
    if (rebuildReason) state.images[tag] = { ...record, latestBaseDigest: digest, checkedAt: now };
    else if (known === undefined) state.images[tag] = { ...record, baseImage, baseDigest: digest, checkedAt: now };
    else state.images[tag] = { ...record, checkedAt: now };
  });
  if (rebuildReason === 'changed') {
    logger.info(`The base image ${baseImage} of the workspace helper has changed. The image ${tag} is built again at the next open.`);
  } else if (rebuildReason === 'unpulled') {
    logger.info(`The workspace helper image ${tag} was built from the local base image. It is built again from the current base image at the next open.`);
  }
}

/**
 * `baseDigest` for the base image, under its time limit: a lookup that does not answer in time counts as
 * `'unreachable'`. Rejects with an AbortError when `signal` aborts; without a signal, it never rejects.
 */
async function lookUpBaseDigest(m: Maintenance, signal: AbortSignal | undefined): Promise<string | 'unreachable' | undefined> {
  const lookup = m.options.baseDigest;
  const baseImage = m.baseImage;
  if (!lookup || baseImage === undefined) return undefined;
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
 * window may still use it: then Docker refuses, and the cleanup removes it later. An open that pinned it and waits
 * between its helper runs (in this window or another) does not keep it: its next helper run fails with helperFailed
 * (accepted, review round 21 of PR #64, A-R21-1).
 */
async function removePreviousImage(m: Maintenance, previousId: string, currentId: string): Promise<void> {
  const images = await listHelperImages(m);
  const previous = images?.find((image) => image.id === previousId);
  if (previous === undefined) return;
  // Plan step 11D3: the monitor tag of the rebuilt tag can stay on the previous image (the monitor runs from it); it
  // does not keep the image. Its removal removes the image with its last tag (Docker refuses while the monitor runs).
  if (previous.tags.length > 0 && previous.tags.every(isMonitorImageTag)) {
    for (const tag of previous.tags) await removeHelperImage(m, previous, tag, currentId);
    return;
  }
  if (previous.tags.length === 0) await removeHelperImage(m, previous, previous.id, currentId);
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
 * Step 5 (implementation notes 7), at most once per day: of the images with the label nimblescape.devenv.helper=true,
 * except the image of the current tag, it removes dangling images, and helper tags that no window of this installation
 * used for 7 days. A helper tag that the state does not know is foreign (another extension version, possibly of another
 * installation of VS Code with its own helper.json, which never writes `lastUsedAt` here): it gets a grace period of 7
 * days, so old windows during an update keep their helper. A removed tag gets a tombstone: when it comes back, another
 * installation built it again and uses it, so it stays (for HELPER_TOMBSTONE_MS), and two installations do not remove
 * each other's helper in a loop. Tags of other repositories are never removed.
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
      const record = state.images[tag];
      if (hasTombstone(record, nowMs)) {
        m.logger.info(`The workspace helper image ${tag} was built again after its removal: another installation uses it. It is kept.`);
        continue;
      }
      const age = ageMs(record?.lastUsedAt, nowMs);
      if (record === undefined || record.removedAt !== undefined || age === undefined || age < 0) {
        graced.push(tag);
      } else if (age >= HELPER_UNUSED_LIMIT_MS) {
        m.logger.info(`The workspace helper image ${tag} was not used for ${Math.floor(age / DAY_MS)} days. It is removed.`);
        // Plan step 11D3: its monitor tag goes with it, first (review round 1 of PR #101, A-M1): Docker refuses only the
        // removal of the last reference of an image that a container uses, so the helper tag, removed last, stays while a
        // helper or a monitor runs from its image; the monitor tag is only its name, and the next ensure tags it again.
        const monitorTag = monitorImageTag(tag);
        if (monitorTag !== undefined && image.tags.includes(monitorTag)) await removeHelperImage(m, image, monitorTag, currentId);
        if (await removeHelperImage(m, image, tag, currentId)) removed.push(tag);
      }
    }
    // Plan step 11D3: a monitor tag whose helper tag is not on its image (removed, or moved by a rebuild) is removed.
    for (const tag of image.tags.filter(isMonitorImageTag)) {
      const helperTag = `devenv-helper:${tag.slice('devenv-monitor:'.length)}`;
      if (image.tags.includes(helperTag)) continue;
      m.logger.info(`The tag ${tag} of the Session Monitor is no longer on its workspace helper image. It is removed.`);
      await removeHelperImage(m, image, tag, currentId);
    }
  }

  await writeState(m, (fresh) => {
    fresh.lastCleanupAt = now;
    for (const tag of graced) {
      const record = fresh.images[tag];
      if (hasTombstone(record, nowMs)) continue;
      if (record === undefined || record.removedAt !== undefined) {
        fresh.images[tag] = { foreignSince: now, lastUsedAt: now };
      } else {
        const age = ageMs(record.lastUsedAt, nowMs);
        if (age === undefined || age < 0) fresh.images[tag] = { ...record, lastUsedAt: now };
      }
    }
    for (const tag of removed) fresh.images[tag] = { removedAt: now };
    // Records of tags that do not exist anymore (for example removed by the user) are dropped when they are old; a
    // tombstone when it expires.
    for (const [tag, record] of Object.entries(fresh.images)) {
      if (tag === m.tag || listed.has(tag)) continue;
      if (record.removedAt !== undefined) {
        if (!hasTombstone(record, nowMs)) delete fresh.images[tag];
      } else if (!isRecent(record.lastUsedAt, nowMs) && !isRecent(record.builtAt, nowMs)) {
        delete fresh.images[tag];
      }
    }
  });
}

/** True if the cleanup removed the tag less than HELPER_TOMBSTONE_MS ago. */
function hasTombstone(record: HelperImageRecord | undefined, now: number): boolean {
  const age = ageMs(record?.removedAt, now);
  return age !== undefined && age >= 0 && age < HELPER_TOMBSTONE_MS;
}

function isRecent(time: string | undefined, now: number): boolean {
  const age = ageMs(time, now);
  return age !== undefined && age < HELPER_UNUSED_LIMIT_MS;
}
