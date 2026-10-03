// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// User decisions 2026-10-03: the environment image carries the labels of its environment and its build record
// (labelImage after the build), the registry record pins the ID of the image after the labels, an image under the name
// with another ID is not used, an entry without a build record takes the record over from its newest image, and the
// workspace volume of a restored entry must have the name of its labels (resourceName). The pure functions:
// imageRecord.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import { Messages } from '../messages';
import { LABEL_BUILD_RECORD, LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, environmentImageName, resourceName } from '../names';
import type { BuildRecord } from '../types';
import type { RepositoryTarget } from './environmentService';
import {
  ACCOUNT,
  BASE_IMAGE,
  DEFAULT_CONFIG_TEXT,
  DIGEST_NEW,
  DIGEST_OLD,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  OTHER_ACCOUNT,
  OTHER_ID,
  REPO,
  createHarness,
  imageConfigWithUser,
  seedEnvironment,
  type Harness,
} from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH, configHash } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const NAME = resourceName(REPO, ENV_ID);
const IMAGE_1 = environmentImageName(REPO, ENV_ID, 1);
const IMAGE_2 = environmentImageName(REPO, ENV_ID, 2);
const IMAGE_3 = environmentImageName(REPO, ENV_ID, 3);
/** The ID of an image after labelImage (the real `docker build` of the labels gives the image a new ID). */
const LABELLED_ID = `sha256:${'5'.repeat(64)}`;

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

function options() {
  return { progress: h.progress };
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

/** labelImage of the fake, and then the image has the ID LABELLED_ID, as after the `docker build` of the labels. */
function labelsChangeTheId(): void {
  const labelImage = h.docker.labelImage.bind(h.docker);
  h.docker.labelImage = async (image: string, labels: Record<string, string>) => {
    await labelImage(image, labels);
    h.docker.imageIds.set(image, LABELLED_ID);
  };
}

/** A build record of the image `tag` with the build number `n`, up to date with the default configuration and check. */
function recordOf(tag: string, n: number): BuildRecord {
  return {
    builtAt: '2026-09-30T10:00:00.000Z',
    environmentImage: tag,
    buildNumber: n,
    configPath: DEFAULT_CONFIG_PATH,
    configHash: configHash(DEFAULT_CONFIG_TEXT),
    images: { [BASE_IMAGE]: DIGEST_NEW },
    features: { [FEATURE]: FEATURE_DIGEST },
  };
}

/** The labels that the extension gives the image of ENV_ID (as imageRecordLabels), with `changes`. */
function labelsOf(record: BuildRecord, changes: Record<string, string> = {}): Record<string, string> {
  return {
    [LABEL_ENVIRONMENT_ID]: ENV_ID,
    [LABEL_REPOSITORY]: REPO,
    [LABEL_OWNER_ID]: ACCOUNT.id,
    [LABEL_BUILD_RECORD]: JSON.stringify(record),
    ...changes,
  };
}

/** A local environment image `tag` with the labels `labels`. */
function addImage(tag: string, labels: Record<string, string>): void {
  h.docker.images.add(tag);
  const config = imageConfigWithUser('vscode');
  h.docker.imageConfigs.set(tag, { ...config, Labels: { ...config.Labels, ...labels } });
}

function stored(record: BuildRecord | undefined): Omit<BuildRecord, 'imageId'> | undefined {
  if (record === undefined) return undefined;
  const { imageId: _imageId, ...rest } = record;
  return rest;
}

describe('the labels of a new environment image, and its pinned ID', () => {
  it('labels the image after the build with the environment and its build record, and pins the ID after the labels', async () => {
    labelsChangeTheId();
    const result = await h.service.open(TARGET, options());
    const env = (await h.registry.get(result.environment.id))!;
    const image = environmentImageName(REPO, env.id, 1);
    expect(env.buildRecord?.environmentImage).toBe(image);
    const labels = h.docker.labelled.get(image);
    expect(labels).toBeDefined();
    expect(Object.keys(labels!).sort()).toEqual([LABEL_BUILD_RECORD, LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID, LABEL_REPOSITORY].sort());
    expect(labels![LABEL_ENVIRONMENT_ID]).toBe(env.id);
    expect(labels![LABEL_REPOSITORY]).toBe(REPO);
    expect(labels![LABEL_OWNER_ID]).toBe(ACCOUNT.id);
    // The record of the registry without its pinned ID.
    expect(JSON.parse(labels![LABEL_BUILD_RECORD])).toEqual(stored(env.buildRecord));
    expect(JSON.parse(labels![LABEL_BUILD_RECORD])).not.toHaveProperty('imageId');
    expect(env.buildRecord?.imageId).toBe(LABELLED_ID);
    // The container is made from the labelled image.
    expect(h.helper.ups.map((up) => up.image)).toEqual([image]);
  });

  it('labels the image of an update and pins its new ID', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    labelsChangeTheId();
    await h.service.open(TARGET, options());
    const record = (await h.registry.get(ENV_ID))?.buildRecord;
    expect(record?.environmentImage).toBe(IMAGE_2);
    expect(record?.imageId).toBe(LABELLED_ID);
    expect(JSON.parse(h.docker.labelled.get(IMAGE_2)![LABEL_BUILD_RECORD])).toEqual(stored(record));
  });

  it('fails a first open whose labels cannot be set like a failed build, and removes the image', async () => {
    h.docker.labelImageError = new DevcontainerCommandError('docker build', 1, '', 'no space left on device');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(h.helper.builds).toHaveLength(1);
    expect(h.helper.ups).toEqual([]);
    expect(await h.registry.list()).toEqual([]);
    expect([...h.docker.images].filter((image) => image.startsWith('devenv-'))).toEqual([]);
  });

  it('keeps the old container when the labels of an update cannot be set, and removes the new image', async () => {
    await seedEnvironment(h, { record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    h.docker.labelImageError = new Error('Cannot connect to the Docker daemon');
    await h.service.open(TARGET, options());
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
    expect(h.ui.warnings).toEqual([Messages.buildFailed]);
    expect(h.helper.ups).toEqual([expect.objectContaining({ image: IMAGE_1, removeExistingContainer: false })]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(h.docker.images.has(IMAGE_1)).toBe(true);
    const record = (await h.registry.get(ENV_ID))?.buildRecord;
    expect(record?.environmentImage).toBe(IMAGE_1);
    expect(record?.imageId).toBe(`sha256:image-of-${IMAGE_1}`);
  });
});

describe('the pinned ID of the environment image at the open', () => {
  it('starts the image whose ID the record pins without a build', async () => {
    await seedEnvironment(h);
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_1]);
  });

  it('builds again when the image under the name of the record has another ID, and warns in the log', async () => {
    await seedEnvironment(h);
    // For example an image of that name that another computer built on a shared host.
    h.docker.imageIds.set(IMAGE_1, `sha256:${'7'.repeat(64)}`);
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
    expect(h.logger.warnings.some((line) => line.includes(IMAGE_1) && line.includes('not the ID of its build record'))).toBe(true);
    const record = (await h.registry.get(ENV_ID))?.buildRecord;
    expect(record?.environmentImage).not.toBe(IMAGE_1);
    expect(record?.imageId).toBe(`sha256:image-of-${record?.environmentImage}`);
    expect(h.helper.ups.map((up) => up.image)).toEqual([record?.environmentImage]);
  });

  it('builds again when the record pins no image ID', async () => {
    await seedEnvironment(h, { record: { imageId: undefined } });
    expect((await h.registry.get(ENV_ID))?.buildRecord).not.toHaveProperty('imageId');
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
    expect(h.logger.warnings.some((line) => line.includes(IMAGE_1) && line.includes('(none)'))).toBe(true);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.imageId).toBeDefined();
  });
});

describe('an entry without a build record takes the record over from its newest image', () => {
  beforeEach(async () => {
    // For example restored by reconcileFromVolumes on a computer that did not build the image.
    await seedEnvironment(h, { record: null, container: null });
  });

  it('takes the record of the newest image with fitting labels, pins its ID, and does not build when up to date', async () => {
    addImage(IMAGE_1, labelsOf(recordOf(IMAGE_1, 1)));
    addImage(IMAGE_3, labelsOf(recordOf(IMAGE_3, 3)));
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_3]);
    const env = await h.registry.get(ENV_ID);
    expect(env?.buildRecord).toEqual({ ...recordOf(IMAGE_3, 3), imageId: `sha256:image-of-${IMAGE_3}` });
    expect(env?.lastBuildNumber).toBe(3);
  });

  it('pins the ID that Docker gives the image, never one of the labels', async () => {
    h.docker.imageIds.set(IMAGE_3, `sha256:${'8'.repeat(64)}`);
    addImage(IMAGE_3, labelsOf({ ...recordOf(IMAGE_3, 3), imageId: `sha256:${'9'.repeat(64)}` }));
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.imageId).toBe(`sha256:${'8'.repeat(64)}`);
  });

  it('builds when the newest image has no labels of the extension', async () => {
    addImage(IMAGE_3, {});
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it.each<[string, Record<string, string>, BuildRecord?]>([
    ['the ID of another environment', { [LABEL_ENVIRONMENT_ID]: OTHER_ID }],
    ['another owner', { [LABEL_OWNER_ID]: OTHER_ACCOUNT.id }],
    ['another repository', { [LABEL_REPOSITORY]: 'acme/web' }],
    ['a record that names another tag', {}, recordOf(IMAGE_1, 3)],
    ['a record with another build number', {}, recordOf(IMAGE_3, 1)],
  ])('does not take the record over from labels with %s, and builds', async (_name, changes, record = recordOf(IMAGE_3, 3)) => {
    addImage(IMAGE_3, labelsOf(record, changes));
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
    const env = await h.registry.get(ENV_ID);
    expect(env?.buildRecord?.environmentImage).not.toBe(IMAGE_3);
    expect(env?.buildRecord?.imageId).toBe(`sha256:image-of-${env?.buildRecord?.environmentImage}`);
    expect(h.logger.warnings.some((line) => line.includes(IMAGE_3) && line.includes('its labels do not fit'))).toBe(true);
  });
});

describe('reconcileFromVolumes and the names of the environments', () => {
  it('restores a volume with the name of its labels, with the container of the same name', async () => {
    h.docker.volumes.set(NAME, { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    const env = await h.registry.get(ENV_ID);
    expect(env?.volumeName).toBe(resourceName(REPO, ENV_ID));
    expect(env?.containerName).toBe(env?.volumeName);
  });

  it.each([
    ['the name of the short ID', 'devenv-acme-api-3f2a9c1e'],
    ['the name of another ID', resourceName(REPO, OTHER_ID)],
    ['the name of another repository', resourceName('acme/web', ENV_ID)],
    ['a name of its own', 'my-volume'],
  ])('skips a volume with the labels of an environment and %s', async (_name, volume) => {
    h.docker.volumes.set(volume, { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    expect(await h.service.reconcileFromVolumes()).toBe(0);
    expect(await h.registry.list()).toEqual([]);
    expect(h.logger.warnings).toContain(`The volume ${volume} has the labels of an environment but not its name. It is skipped.`);
  });
});
