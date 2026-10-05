// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F2: the rules of the registry records that the window checks too (openRecords.ts, the host side of the
// worker's requests), apart from the rules of the pipeline (pipelineRules.ts), which only the worker runs. No `vscode`.
import { truncated } from '../policy/report';
import type { BuildRecord, ComposeBuildRecord, RefusedUpdate } from '../types';
import { sameContainer } from './containerIds';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

/** Configuration path of an environment whose configuration is not known yet (the pipeline falls back to the first one found). */
export const DEFAULT_CONFIG_PATH = '.devcontainer/devcontainer.json';

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

/** `owner/name`, as the registry accepts it. */
export function isRepositoryName(value: unknown): value is string {
  return typeof value === 'string' && /^[^/\s]+\/[^/\s]+$/.test(value);
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
 * Review round 4 of PR #68 (A-R4-1): whether finish clears the mark Environment.lifecycleIncomplete (`mark`, as the
 * registry holds it under the lock): only when it is the value this run decided with (`read`), or when it names the
 * container whose `up` and run-user-commands this run completed (`ranFor`). A mark that another window set after this run
 * read the entry (for example for the container that this run opened as it is) stays.
 */
export function lifecycleMarkClears(mark: string | undefined, read: string | undefined, ranFor: string | undefined): boolean {
  if (mark === undefined) return false;
  if (read !== undefined && sameContainer(mark, read)) return true;
  return ranFor !== undefined && sameContainer(mark, ranFor);
}
