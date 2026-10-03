// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// User decisions 2026-10-03: the labels of an environment image, with its build record, and the record that another
// computer takes over from them.
import { describe, expect, it } from 'vitest';
import { LABEL_BUILD_RECORD, LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, composeProjectName, environmentImageName } from '../names';
import type { BuildRecord } from '../types';
import { MAX_RECORD_LABEL_LENGTH, imageBuildRecord, imageRecordLabels } from './imageRecord';

const ENV = { id: '3f2a9c1e-0000-4000-8000-000000000000', repository: 'acme/api', owner: { id: '1001', login: 'alice' } };
const TAG = environmentImageName(ENV.repository, ENV.id, 3);
const PROJECT = composeProjectName(ENV.repository, ENV.id);

function record(overrides: Partial<BuildRecord> = {}): BuildRecord {
  return {
    builtAt: '2026-10-03T10:00:00.000Z',
    environmentImage: TAG,
    imageId: `sha256:${'c'.repeat(64)}`,
    buildNumber: 3,
    configPath: '.devcontainer/devcontainer.json',
    configHash: `sha256:${'d'.repeat(64)}`,
    images: { 'mcr.microsoft.com/devcontainers/base:bookworm': `sha256:${'e'.repeat(64)}` },
    features: {},
    ...overrides,
  };
}

/** The record without its pinned image ID, as the label holds it. */
function stored(value: BuildRecord): Omit<BuildRecord, 'imageId'> {
  const { imageId: _pinned, ...rest } = value;
  return rest;
}

/** The labels of `value`, as imageRecordLabels writes them, with the record as `text` when given. */
function labels(value: BuildRecord = record(), text?: string): Record<string, string> {
  const result = imageRecordLabels(ENV, value);
  return text === undefined ? result : { ...result, [LABEL_BUILD_RECORD]: text };
}

describe('imageRecordLabels', () => {
  it('gives the environment ID, the repository, the owner, and the record without its image ID', () => {
    const value = record();
    const result = imageRecordLabels(ENV, value);
    expect(result).toEqual({
      [LABEL_ENVIRONMENT_ID]: ENV.id,
      [LABEL_REPOSITORY]: ENV.repository,
      [LABEL_OWNER_ID]: ENV.owner.id,
      [LABEL_BUILD_RECORD]: JSON.stringify(stored(value)),
    });
    expect(JSON.parse(result[LABEL_BUILD_RECORD])).not.toHaveProperty('imageId');
  });

  it('takes a record without an image ID as it is', () => {
    const value = stored(record()) as BuildRecord;
    expect(imageRecordLabels(ENV, value)[LABEL_BUILD_RECORD]).toBe(JSON.stringify(value));
  });

  it('writes an empty record when it is longer than MAX_RECORD_LABEL_LENGTH, and keeps the other labels', () => {
    const images = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`registry.example.com/image-${i}:1`, `sha256:${'f'.repeat(64)}`]));
    const big = record({ images });
    expect(JSON.stringify(stored(big)).length).toBeGreaterThan(MAX_RECORD_LABEL_LENGTH);
    // Review round 1 of PR #88 (A-R1-3): the label is always set (empty), so that no such label of the base image stays.
    expect(imageRecordLabels(ENV, big)).toEqual({
      [LABEL_ENVIRONMENT_ID]: ENV.id,
      [LABEL_REPOSITORY]: ENV.repository,
      [LABEL_OWNER_ID]: ENV.owner.id,
      [LABEL_BUILD_RECORD]: '',
    });
    // An empty record is never taken over.
    expect(imageBuildRecord(imageRecordLabels(ENV, big), ENV, TAG, 3)).toBeUndefined();
  });

  it('keeps a record of exactly MAX_RECORD_LABEL_LENGTH characters', () => {
    const base = JSON.stringify(stored(record({ configHash: '' }))).length;
    const exact = record({ configHash: 'x'.repeat(MAX_RECORD_LABEL_LENGTH - base) });
    expect(JSON.stringify(stored(exact)).length).toBe(MAX_RECORD_LABEL_LENGTH);
    expect(imageRecordLabels(ENV, exact)).toHaveProperty([LABEL_BUILD_RECORD]);
  });
});

describe('imageBuildRecord', () => {
  it('takes the record of the labels of a matching image, without an image ID', () => {
    const value = record();
    expect(imageBuildRecord(labels(value), ENV, TAG, 3)).toEqual(stored(value));
  });

  it('never takes the image ID from the labels', () => {
    const forged = JSON.stringify({ ...stored(record()), imageId: `sha256:${'0'.repeat(64)}` });
    const result = imageBuildRecord(labels(record(), forged), ENV, TAG, 3);
    expect(result).toEqual(stored(record()));
    expect(result).not.toHaveProperty('imageId');
  });

  it('takes a record of Docker Compose whose images are of the project of the environment', () => {
    const compose = { service: 'app', images: [`${PROJECT}-app`, `${PROJECT}-worker`], serviceImages: ['postgres:16'] };
    const value = record({ compose } as Partial<BuildRecord>);
    expect(imageBuildRecord(labels(value), ENV, TAG, 3)).toEqual(stored(value));
  });

  it.each<[string, Partial<typeof ENV>]>([
    ['another environment ID', { id: '11111111-2222-4333-8444-555555555555' }],
    ['another repository', { repository: 'acme/web' }],
    ['another owner', { owner: { id: '2002', login: 'bob' } }],
  ])('refuses the labels of %s', (_name, other) => {
    expect(imageBuildRecord(labels(), { ...ENV, ...other }, TAG, 3)).toBeUndefined();
  });

  it.each<[string, string]>([
    ['the environment ID', LABEL_ENVIRONMENT_ID],
    ['the repository', LABEL_REPOSITORY],
    ['the owner', LABEL_OWNER_ID],
    ['the record', LABEL_BUILD_RECORD],
  ])('refuses labels without %s', (_name, key) => {
    const { [key]: _removed, ...rest } = labels();
    expect(imageBuildRecord(rest, ENV, TAG, 3)).toBeUndefined();
  });

  it('refuses a record of another tag or build number', () => {
    expect(imageBuildRecord(labels(), ENV, environmentImageName(ENV.repository, ENV.id, 4), 3)).toBeUndefined();
    expect(imageBuildRecord(labels(), ENV, TAG, 4)).toBeUndefined();
    expect(imageBuildRecord(labels(record({ environmentImage: environmentImageName('acme/web', ENV.id, 3) })), ENV, TAG, 3)).toBeUndefined();
    expect(imageBuildRecord(labels(record({ buildNumber: 2 })), ENV, TAG, 3)).toBeUndefined();
  });

  it.each(['not json', '', '{', 'null', '[]', '"text"'])('refuses the record %j that is no JSON object', (text) => {
    expect(imageBuildRecord(labels(record(), text), ENV, TAG, 3)).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>]>([
    ['without builtAt', { builtAt: undefined }],
    ['without configHash', { configHash: undefined }],
    ['with images that are no strings', { images: { a: 1 } }],
    ['with features that are no record', { features: [] }],
    ['with a build number that is no count', { buildNumber: -1 }],
    ['with an empty image ID', { imageId: '' }],
  ])('refuses an invalid record: %s', (_name, change) => {
    const text = JSON.stringify({ ...stored(record()), ...change });
    expect(imageBuildRecord(labels(record(), text), ENV, TAG, 3)).toBeUndefined();
  });

  it.each(['devcontainer.json', '../.devcontainer/devcontainer.json', '/workspaces/api/.devcontainer/devcontainer.json', '.devcontainer/../devcontainer.json', '.devcontainer/a/b/devcontainer.json', ''])(
    'refuses the configuration path %j',
    (configPath) => {
      expect(imageBuildRecord(labels(record({ configPath })), ENV, TAG, 3)).toBeUndefined();
    },
  );

  it.each(['.devcontainer.json', '.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'])('takes the configuration path %j', (configPath) => {
    expect(imageBuildRecord(labels(record({ configPath })), ENV, TAG, 3)).toMatchObject({ configPath });
  });

  it.each<[string, unknown]>([
    ['an image of another project', { service: 'app', images: [`${composeProjectName('acme/web', ENV.id)}-app`], serviceImages: [] }],
    ['an image of no project', { service: 'app', images: ['postgres:16'], serviceImages: [] }],
    ['the project itself without a service', { service: 'app', images: [PROJECT], serviceImages: [] }],
    ['an image that is no string', { service: 'app', images: [1], serviceImages: [] }],
    ['no list of images', { service: 'app', serviceImages: [] }],
    ['no object', 'app'],
    ['null', null],
  ])('refuses a record of Docker Compose with %s', (_name, compose) => {
    const text = JSON.stringify({ ...stored(record()), compose });
    expect(imageBuildRecord(labels(record(), text), ENV, TAG, 3)).toBeUndefined();
  });

  it('refuses a record longer than MAX_RECORD_LABEL_LENGTH', () => {
    const text = JSON.stringify({ ...stored(record()), configHash: 'x'.repeat(MAX_RECORD_LABEL_LENGTH) });
    expect(imageBuildRecord(labels(record(), text), ENV, TAG, 3)).toBeUndefined();
  });
});
