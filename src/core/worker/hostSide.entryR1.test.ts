// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #106 (B, mutation probes): the bounds of the entry of a first open, its ID and container clashes,
// the removal of only the created entry, the closed service folders, the sha256 anchors, the references and Compose names
// of a build record, the Compose image prefix (buildRecordFits) and the argument count of `record dropCreated`.
import { describe, expect, it } from 'vitest';
import { composeProjectName, environmentImageName, resourceName } from '../names';
import type { BusyMarkView } from '../pipeline/busyMarks';
import { buildRecordFits } from '../pipeline/imageRecord';
import { silentLogger } from '../ports';
import type { EnvironmentRegistry } from '../storage/registry';
import type { BuildRecord, Environment, GitHubAccount, RegistryFile } from '../types';
import type { HostCall, HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';
import { checkedBuildRecord, checkedConfigurationChange, checkedCreateRequest, checkedRefusedUpdate, requestOpenRecords, type OpenRequestScope } from './openRequests';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NEW = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';
const OTHER = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const REPOSITORY = 'acme/api';
const HOST = 'ssh://box';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const ACCOUNT: GitHubAccount = { id: '42', login: 'octo' };
const DEFAULT = '.devcontainer/devcontainer.json';
const DIGEST = `sha256:${'d'.repeat(64)}`;
const CREATE = { id: NEW, repository: REPOSITORY, configPath: DEFAULT };
const ALLOWED: readonly HostCall[] = ['record createEnvironment', 'record dropCreated'];

const entryOf = (id: string, fields: Partial<Environment> = {}): Environment =>
  ({
    id,
    repository: REPOSITORY,
    configPath: DEFAULT,
    volumeName: resourceName(REPOSITORY, id),
    containerName: resourceName(REPOSITORY, id),
    createdAt: '2020-01-01T00:00:00.000Z',
    lastUsedAt: '2020-01-01T00:00:00.000Z',
    owner: { id: ACCOUNT.id, login: 'octo' },
    dockerHost: HOST,
    ...fields,
  }) as Environment;

const record = (fields: Partial<BuildRecord> = {}): BuildRecord => ({
  builtAt: '2026-10-05T11:00:00.000Z',
  environmentImage: environmentImageName(REPOSITORY, ID, 3),
  imageId: `sha256:${'e'.repeat(64)}`,
  buildNumber: 3,
  configPath: DEFAULT,
  configHash: DIGEST,
  images: { 'node:22': DIGEST },
  features: {},
  ...fields,
});

/** A first open of REPOSITORY on HOST over an in-memory registry file, as hostSide.entryRequests.test.ts sets it up. */
function firstOpen(entries: readonly Environment[]) {
  let file: RegistryFile = { version: 1, environments: structuredClone([...entries]) };
  const update = (async <T>(mutator: (file: RegistryFile) => T | Promise<T>) => {
    const copy = structuredClone(file);
    const result = await mutator(copy);
    file = copy;
    return structuredClone(result);
  }) as EnvironmentRegistry['update'];
  const registry: Pick<EnvironmentRegistry, 'update' | 'updateEnvironment'> = { update, updateEnvironment: async () => undefined };
  const view: BusyMarkView = { owner: { windowId: 'w1', pid: 100 }, clock: { now: () => NOW }, isAlive: () => true, windowStatuses: async () => [], logger: silentLogger };
  const open = (scope: OpenRequestScope | undefined) => requestOpenRecords(registry, view, { account: ACCOUNT, dockerHost: scope?.dockerHost ?? '' });
  const records = {
    createEnvironment: (id: string, repository: string, configPath: string, scope?: OpenRequestScope) => open(scope).createEnvironment({ id, repository, configPath }),
    dropCreated: (id: string, scope?: OpenRequestScope) => open(scope).dropCreated(id),
  };
  const host = { questions: {}, state: {}, records, secrets: {}, connect: {} } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, ALLOWED, { repository: REPOSITORY, dockerHost: HOST });
  const signal = new AbortController().signal;
  const ask = (call: string, ...args: unknown[]) => handler('record', { call, args }, signal).then((answer) => answer.value);
  return { ask, file: () => file };
}

describe('review round 1 of PR #106 (B): mutation probes of the registry writes of plan step 11E4c', () => {
  it('the entry of a first open: a repository name, at most 256 characters, checked without the repository of the operation', () => {
    for (const repository of ['acme', 'acme/api/x', `acme/${'a'.repeat(252)}`, 'acme/a\u0000']) {
      expect(() => checkedCreateRequest({ ...CREATE, repository }), repository.slice(0, 20)).toThrow('repository');
    }
    expect(checkedCreateRequest({ ...CREATE, repository: `acme/${'a'.repeat(251)}` }).repository).toHaveLength(256);
  });

  it('an ID or a container name that the registry has is a clash, even under other names', async () => {
    const other = { repository: 'acme/web', volumeName: 'devenv-elsewhere', containerName: 'devenv-elsewhere' };
    for (const existing of [entryOf(NEW, other), entryOf(OTHER, { ...other, containerName: resourceName(REPOSITORY, NEW) })]) {
      const { ask, file } = firstOpen([existing]);
      await expect(ask('createEnvironment', CREATE)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('already') });
      expect(file().environments).toEqual([existing]);
    }
  });

  it('dropCreated removes the created entry only, never another of its repository; one argument only', async () => {
    const foreign = entryOf(OTHER, { owner: { id: '7', login: 'other' } });
    const { ask, file } = firstOpen([foreign]);
    await ask('createEnvironment', CREATE);
    await expect(ask('dropCreated', NEW, 'more')).rejects.toMatchObject({ code: 'invalid' });
    expect(file().environments.map((entry) => entry.id)).toEqual([OTHER, NEW]);
    expect(await ask('dropCreated', NEW)).toBeNull();
    expect(file().environments).toEqual([foreign]);
  });

  it('the service folders: their two fields only', () => {
    expect(() => checkedConfigurationChange({ serviceFolders: { folders: [], overflow: false, extra: 1 } })).toThrow('service folders');
    expect(checkedConfigurationChange({ serviceFolders: { folders: [], overflow: false } })).toEqual({ serviceFolders: { folders: [], overflow: false } });
  });

  it('a sha256 is exactly one: anchored at both ends', () => {
    for (const imageId of [`${DIGEST}x`, `x${DIGEST}`]) {
      expect(() => checkedBuildRecord(record({ imageId })), imageId).toThrow('invalid');
      expect(() => checkedBuildRecord(record({ images: { 'node:22': imageId } })), imageId).toThrow('invalid');
      expect(() => checkedRefusedUpdate({ configPath: DEFAULT, configHash: DIGEST, images: { 'node:22': imageId }, features: {}, items: 'x' }), imageId).toThrow('invalid');
    }
  });

  it('the references of a build record: none empty, no __proto__', () => {
    expect(() => checkedBuildRecord(record({ images: { '': DIGEST } }))).toThrow('invalid');
    expect(() => checkedBuildRecord(record({ features: JSON.parse(`{"__proto__":"${DIGEST}"}`) as Record<string, string> }))).toThrow('invalid');
  });

  it('the Compose service images: none empty, plain text', () => {
    const compose = { service: 'app', images: [`${composeProjectName(REPOSITORY, ID)}-app`], serviceImages: ['postgres:16'], version: '2.39.0', inputsHash: DIGEST };
    expect(checkedBuildRecord(record({ compose })).compose).toEqual(compose);
    for (const serviceImages of [[''], ['postgres:16\n']]) {
      expect(() => checkedBuildRecord(record({ compose: { ...compose, serviceImages } })), JSON.stringify(serviceImages)).toThrow('invalid');
    }
  });

  it('buildRecordFits: a Compose image starts with the project of the environment', () => {
    const prefix = composeProjectName(REPOSITORY, ID);
    const compose = { service: 'app', images: [`${prefix}-app`], serviceImages: [], version: '2.39.0', inputsHash: DIGEST };
    const env = { id: ID, repository: REPOSITORY };
    const tag = environmentImageName(REPOSITORY, ID, 3);
    expect(buildRecordFits(record({ compose }), env, tag, 3)).toBe(true);
    expect(buildRecordFits(record({ compose: { ...compose, images: [`evil-${prefix}-app`] } }), env, tag, 3)).toBe(false);
  });
});
