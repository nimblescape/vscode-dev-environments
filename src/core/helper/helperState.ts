// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// State of the workspace helper images (implementation notes 4 and 7): `helper.json` in the global storage folder.
// Per helper tag, it records the digest of the base image of the last build and when the tag was built, checked, and
// last used, so that the base image is checked once a week and helper images that no window uses are removed; for tags
// of other installations and removed tags, the marks of the cleanup; the ID of the image that this installation built
// for a tag and its helper generation (for diagnosis only). User decision 2026-09-29: no previous helper image.
// The state is advisory: two windows may read and write it at the same time. Each write is atomic, and each update
// reads the file again right before it writes, so a lost update costs at most a second check or a second build.
import { writeJsonAtomic } from '../storage/atomicJson';
import { readJsonTolerant, retryTransient } from '../storage/paths';

/** What the state knows about one helper tag. Times are ISO 8601. */
export interface HelperImageRecord {
  /** Base image reference of the Dockerfile at the last build, for example `node:24-trixie-slim`. */
  baseImage?: string;
  /** Registry digest of `baseImage`, read right before the last build (or at the first check of an older image). */
  baseDigest?: string;
  builtAt?: string;
  /**
   * ID of the image that this installation built for the tag (`sha256:…`, written after each build of this installation,
   * never taken from an image that it did not build: review round 2 of PR #64, A-N3), for diagnosis. Only a full
   * `sha256:<64 hex characters>` ID is kept (review round 1 of PR #64, S5).
   */
  imageId?: string;
  /**
   * Review round 2 of PR #64 (A-N2): the helper generation (HELPER_GENERATION) of the extension that built the tag,
   * written with each build and rebuild, for diagnosis. A positive safe integer.
   */
  generation?: number;
  /**
   * The last build ran without `--pull` (the registry did not answer, or the build with `--pull` failed), so it may have
   * used an old local base image: the next check that gets a digest makes the next ensure build the tag again.
   */
  builtWithoutPull?: string;
  /** Last check of the base image digest that got an answer from the registry. */
  checkedAt?: string;
  /** Last check of the base image digest that got no answer (it is tried again after a day). */
  attemptedAt?: string;
  /** Registry digest of `baseImage` found by a check that asks for a rebuild: the next ensure builds the tag again. */
  latestBaseDigest?: string;
  lastUsedAt?: string;
  /**
   * The cleanup first saw this tag, and it never was the tag of this installation: a helper of another extension version,
   * possibly of another installation of VS Code (for example Insiders, with its own helper.json).
   */
  foreignSince?: string;
  /** The cleanup removed the tag (a tombstone): if the tag comes back, another installation uses it, and it stays. */
  removedAt?: string;
}

export interface HelperState {
  version: 1;
  /** Helper tag (`devenv-helper:<12 hex characters>`) → record. */
  images: Record<string, HelperImageRecord>;
  /** Last cleanup of other helper images. */
  lastCleanupAt?: string;
}

const HELPER_TAG = /^devenv-helper:[0-9a-f]{12}$/;
/** A full image ID (review round 1 of PR #64, S5). */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/**
 * True for a tag that `helperImageTag` returns: `devenv-helper:<12 hex characters>`. The state keeps only such keys (so a
 * key is never `__proto__`), and the cleanup removes only such tags.
 */
export function isHelperImageTag(tag: string): boolean {
  return HELPER_TAG.test(tag);
}

const RECORD_FIELDS = [
  'baseImage',
  'baseDigest',
  'builtAt',
  'imageId',
  'builtWithoutPull',
  'checkedAt',
  'attemptedAt',
  'latestBaseDigest',
  'lastUsedAt',
  'foreignSince',
  'removedAt',
] as const;
const TIME_FIELDS: ReadonlySet<string> = new Set([
  'builtAt',
  'builtWithoutPull',
  'checkedAt',
  'attemptedAt',
  'lastUsedAt',
  'foreignSince',
  'removedAt',
]);

export function emptyHelperState(): HelperState {
  return { version: 1, images: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * The valid part of the file content: another version, or a value that is not an object, gives an empty state; entries
 * with an invalid tag, and fields with an invalid value (a time that does not parse, a value that is not a string, an
 * `imageId` that is not a full `sha256:` ID, a `generation` that is not a positive safe integer), are dropped.
 */
export function parseHelperState(value: unknown): HelperState {
  const state = emptyHelperState();
  if (!isRecord(value) || value.version !== 1) return state;
  if (isTime(value.lastCleanupAt)) state.lastCleanupAt = value.lastCleanupAt;
  if (!isRecord(value.images)) return state;
  for (const [tag, entry] of Object.entries(value.images)) {
    if (!isHelperImageTag(tag) || !isRecord(entry)) continue;
    const record: HelperImageRecord = {};
    for (const field of RECORD_FIELDS) {
      const fieldValue = entry[field];
      if (typeof fieldValue !== 'string' || fieldValue === '') continue;
      if (TIME_FIELDS.has(field) && !isTime(fieldValue)) continue;
      // Review round 1 of PR #64 (S5): only a full image ID.
      if (field === 'imageId' && !IMAGE_ID.test(fieldValue)) continue;
      record[field] = fieldValue;
    }
    // Review round 2 of PR #64 (A-N2): the helper generation, a positive safe integer.
    if (typeof entry.generation === 'number' && Number.isSafeInteger(entry.generation) && entry.generation > 0) record.generation = entry.generation;
    state.images[tag] = record;
  }
  return state;
}

/** Reads the state. A missing, unreadable, or invalid file gives an empty state. Never throws. */
export async function readHelperState(file: string): Promise<HelperState> {
  return parseHelperState(await readJsonTolerant(file));
}

/**
 * Reads the state again, applies `update`, and writes it atomically. Returns the written state. Throws when the file
 * cannot be written.
 */
export async function updateHelperState(file: string, update: (state: HelperState) => void): Promise<HelperState> {
  const state = await readHelperState(file);
  update(state);
  await retryTransient(() => writeJsonAtomic(file, state));
  return state;
}
