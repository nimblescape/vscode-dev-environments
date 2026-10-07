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

/**
 * The largest build record (as JSON) that the label takes; a larger one is written as an empty label (the next computer
 * builds). Review round 1 of PR #88 (A-R1-3): 8 KiB, so that the labels on the command line of `docker build` stay far
 * below the 32,767 characters of a command line on Windows.
 */
export const MAX_RECORD_LABEL_LENGTH = 8 * 1024;

/**
 * The labels that EnvironmentDocker.labelImage gives the environment image of `env` with the build record `record`
 * (without its pinned image ID, which the labels change). Review round 1 of PR #88 (A-R1-3): the label of the record is
 * always set, empty when the record is longer than MAX_RECORD_LABEL_LENGTH, so that no such label of the base image or of
 * the Dockerfile stays on the image.
 */
export function imageRecordLabels(env: Pick<Environment, 'id' | 'repository' | 'owner'>, record: BuildRecord): Record<string, string> {
  const { imageId: _pinned, ...stored } = record;
  const json = JSON.stringify(stored);
  return {
    [LABEL_ENVIRONMENT_ID]: env.id,
    [LABEL_REPOSITORY]: env.repository,
    [LABEL_OWNER_ID]: env.owner.id,
    [LABEL_BUILD_RECORD]: json.length <= MAX_RECORD_LABEL_LENGTH ? json : '',
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
  if (!isBuildRecord(value) || !buildRecordFits(value, env, tag, buildNumber)) return undefined;
  const { imageId: _ignored, ...record } = value;
  return record;
}

/**
 * The checks of imageBuildRecord on a valid build record (isBuildRecord): it names exactly `tag` and `buildNumber`, has a
 * configuration path of a repository, and names only images of the Compose project of `env`. Plan step 11E4c: also for
 * the build record of a `record build` request of the worker (src/core/worker/openRequests.ts).
 */
export function buildRecordFits(record: BuildRecord, env: Pick<Environment, 'id' | 'repository'>, tag: string, buildNumber: number): boolean {
  if (record.environmentImage !== tag || record.buildNumber !== buildNumber || !isConfigPathLabelValue(record.configPath)) return false;
  if (record.compose !== undefined) {
    const prefix = `${composeProjectName(env.repository, env.id)}-`;
    const compose = record.compose as unknown;
    if (typeof compose !== 'object' || compose === null) return false;
    const images = (compose as { images?: unknown }).images;
    if (!Array.isArray(images) || !images.every((image) => typeof image === 'string' && image.startsWith(prefix))) return false;
  }
  return true;
}
