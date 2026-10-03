// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The labels of an environment image (user decisions 2026-10-03): the environment ID, its repository and owner, and the
// build record of the image, so that another computer (or this one after a lost registry) takes the record over from
// the newest image of the environment. Pure functions, no I/O.
import {
  LABEL_BUILD_RECORD,
  LABEL_ENVIRONMENT_ID,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  composeProjectName,
  isConfigPathLabelValue,
} from '../names';
import { isBuildRecord } from '../storage/registry';
import type { BuildRecord, Environment } from '../types';

/** The largest build record (as JSON) that the label takes; a larger one is left out (the next computer builds). */
export const MAX_RECORD_LABEL_LENGTH = 32 * 1024;

/**
 * The labels that ContainerAdapter.labelImage gives the environment image of `env` with the build record `record`
 * (without its pinned image ID, which the labels change). The record is left out when it is longer than
 * MAX_RECORD_LABEL_LENGTH.
 */
export function imageRecordLabels(env: Pick<Environment, 'id' | 'repository' | 'owner'>, record: BuildRecord): Record<string, string> {
  const { imageId: _pinned, ...stored } = record;
  const json = JSON.stringify(stored);
  return {
    [LABEL_ENVIRONMENT_ID]: env.id,
    [LABEL_REPOSITORY]: env.repository,
    [LABEL_OWNER_ID]: env.owner.id,
    ...(json.length <= MAX_RECORD_LABEL_LENGTH ? { [LABEL_BUILD_RECORD]: json } : {}),
  };
}

/**
 * The build record in the labels `labels` of the image `tag` (build number `buildNumber`) of `env`, or `undefined`
 * when they do not fit: the environment ID, the repository, and the owner must be those of `env`; the record must be
 * valid (isBuildRecord), name exactly `tag` and `buildNumber`, have a configuration path of a repository, and name only
 * images of the Compose project of `env`. The pinned image ID is never taken from the labels.
 */
export function imageBuildRecord(
  labels: Readonly<Record<string, string>>,
  env: Pick<Environment, 'id' | 'repository' | 'owner'>,
  tag: string,
  buildNumber: number,
): BuildRecord | undefined {
  if (labels[LABEL_ENVIRONMENT_ID] !== env.id || labels[LABEL_REPOSITORY] !== env.repository || labels[LABEL_OWNER_ID] !== env.owner.id) return undefined;
  const text = labels[LABEL_BUILD_RECORD];
  if (text === undefined || text.length > MAX_RECORD_LABEL_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isBuildRecord(value)) return undefined;
  if (value.environmentImage !== tag || value.buildNumber !== buildNumber || !isConfigPathLabelValue(value.configPath)) return undefined;
  if (value.compose !== undefined) {
    const prefix = `${composeProjectName(env.repository, env.id)}-`;
    const compose = value.compose as unknown;
    if (typeof compose !== 'object' || compose === null) return undefined;
    const images = (compose as { images?: unknown }).images;
    if (!Array.isArray(images) || !images.every((image) => typeof image === 'string' && image.startsWith(prefix))) return undefined;
  }
  const { imageId: _ignored, ...record } = value;
  return record;
}
