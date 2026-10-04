// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C3 (decision of 2026-10-04): `record restore`, the entries that the worker rebuilt from the labels of the
// volumes, as the extension checks them (hostSideHandler): only for the operation `reconcile`, only for its Docker host,
// only the fields of a rebuild, each entry rebuilt from its checked fields.
import { describe, expect, it } from 'vitest';
import { MAX_RESTORE_ENTRIES, OP_DELETE, OP_RECONCILE } from '../helperChannel/protocol';
import { MAX_SERVICE_FOLDERS } from '../git/gitSummary';
import { resourceName } from '../names';
import { silentLogger } from '../ports';
import type { Environment } from '../types';
import { FLOW_REQUESTS, type HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = resourceName('acme/api', ID);
const ENTRY = {
  id: ID,
  repository: 'acme/api',
  configPath: '.devcontainer/devcontainer.json',
  volumeName: NAME,
  containerName: NAME,
  createdAt: '2026-10-04T12:00:00.000Z',
  lastUsedAt: '2026-10-04T12:00:00.000Z',
  owner: { id: '42', login: '' },
};

function handlerOf(scope: { dockerHost?: string } = { dockerHost: '' }, op = OP_RECONCILE) {
  const restored: Environment[][] = [];
  const records = {
    restore: async (entries: Environment[]) => (restored.push(entries), { added: entries.length, skipped: ['devenv-x'] }),
  };
  const host = { questions: {}, records, state: {}, secrets: {}, connect: {} } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[op], scope);
  return { restore: (entries: unknown) => handler('record', { call: 'restore', args: [entries] }, new AbortController().signal), restored };
}

describe('record restore (plan step 11C3)', () => {
  it('adds the entries of the operation, each rebuilt from its checked fields, and answers what was added and left out', async () => {
    const { restore, restored } = handlerOf();
    const services = {
      ...ENTRY,
      configPath: '.devcontainer/web/devcontainer.json',
      additionalVolumes: ['api-db', 'api-cache'],
      serviceVolumes: ['api-db'],
      serviceFolders: ['/workspaces/api/data/db'],
      serviceFoldersOverflow: true,
    };
    expect(await restore([services])).toEqual({ value: { added: 1, skipped: ['devenv-x'] } });
    expect(restored).toEqual([[services]]);
    // The volume name as Docker gives it (another case) is the one of the environment.
    expect(await restore([{ ...ENTRY, volumeName: NAME.toUpperCase(), containerName: NAME.toUpperCase() }])).toEqual({ value: { added: 1, skipped: ['devenv-x'] } });
  });

  it('only the operation reconcile may send it', async () => {
    const { restore, restored } = handlerOf({ dockerHost: '' }, OP_DELETE);
    await expect(restore([ENTRY])).rejects.toMatchObject({ code: 'invalid' });
    expect(restored).toEqual([]);
  });

  it('only the entries of the Docker host of the operation; an operation without one restores nothing', async () => {
    await expect(handlerOf({}).restore([ENTRY])).rejects.toMatchObject({ code: 'invalid' });
    const remote = handlerOf({ dockerHost: 'ssh://box' });
    await expect(remote.restore([ENTRY])).rejects.toMatchObject({ code: 'invalid' });
    expect(await remote.restore([{ ...ENTRY, dockerHost: 'ssh://box' }])).toEqual({ value: { added: 1, skipped: ['devenv-x'] } });
    expect(remote.restored).toEqual([[{ ...ENTRY, dockerHost: 'ssh://box' }]]);
    const local = handlerOf({ dockerHost: '' });
    // The local Docker is a missing field, never an empty one.
    for (const dockerHost of ['ssh://box', '']) await expect(local.restore([{ ...ENTRY, dockerHost }])).rejects.toMatchObject({ code: 'invalid' });
    expect(local.restored).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['not a list', { ...ENTRY }],
    ['too many entries', Array.from({ length: MAX_RESTORE_ENTRIES + 1 }, () => ENTRY)],
    ['an entry that is not an object', [null]],
    ['a field beyond a rebuild: a build record', [{ ...ENTRY, buildRecord: {} }]],
    ['a field beyond a rebuild: a busy mark', [{ ...ENTRY, busy: { operation: 'delete' } }]],
    ['a field beyond a rebuild: a Git state', [{ ...ENTRY, gitSummary: {} }]],
    ['an ID that is no storage ID', [{ ...ENTRY, id: '../x' }]],
    ['no repository name', [{ ...ENTRY, repository: 'acme' }]],
    ['a volume of another name', [{ ...ENTRY, volumeName: 'devenv-acme-api-other', containerName: 'devenv-acme-api-other' }]],
    ['a container of another name', [{ ...ENTRY, containerName: 'other' }]],
    ['a volume of another environment', [{ ...ENTRY, id: '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b' }]],
    ['a configuration path outside .devcontainer', [{ ...ENTRY, configPath: '../x/devcontainer.json' }]],
    ['a time that is none', [{ ...ENTRY, createdAt: 'yesterday' }]],
    ['an owner with a login', [{ ...ENTRY, owner: { id: '42', login: 'octo' } }]],
    ['an owner with more fields', [{ ...ENTRY, owner: { id: '42', login: '', admin: true } }]],
    ['an owner without a storage ID', [{ ...ENTRY, owner: { id: '', login: '' } }]],
    ['additional volumes that are no names', [{ ...ENTRY, additionalVolumes: ['a b'] }]],
    ['an empty list of additional volumes', [{ ...ENTRY, additionalVolumes: [] }]],
    ['the workspace volume as an additional volume', [{ ...ENTRY, additionalVolumes: [NAME] }]],
    ['an additional volume twice', [{ ...ENTRY, additionalVolumes: ['api-db', 'api-db'] }]],
    ['a volume of the services that is no additional volume', [{ ...ENTRY, additionalVolumes: ['api-db'], serviceVolumes: ['api-cache'] }]],
    ['an empty list of volumes of the services', [{ ...ENTRY, additionalVolumes: ['api-db'], serviceVolumes: [] }]],
    ['an overflow that is not true', [{ ...ENTRY, serviceFoldersOverflow: false }]],
    ['service folders that are no list', [{ ...ENTRY, serviceFolders: '/workspaces/api' }]],
    ['too many service folders', [{ ...ENTRY, serviceFolders: Array.from({ length: MAX_SERVICE_FOLDERS + 1 }, (_, i) => `/workspaces/api/${i}`) }]],
    ['a service folder with a line break', [{ ...ENTRY, serviceFolders: ['/workspaces/api/a\nb'] }]],
  ])('refuses %s', async (_name, entries) => {
    const { restore, restored } = handlerOf();
    await expect(restore(entries)).rejects.toMatchObject({ code: 'invalid' });
    expect(restored).toEqual([]);
  });

  it('keeps only the service folders of the repository, as the pipeline records them', async () => {
    const { restore, restored } = handlerOf();
    await restore([{ ...ENTRY, serviceFolders: ['/workspaces/api/data', '/etc', '/workspaces/other/x'] }]);
    expect(restored[0][0].serviceFolders).toEqual(['/workspaces/api/data']);
    // None of the repository: the field is left out.
    await restore([{ ...ENTRY, serviceFolders: ['/etc'] }]);
    expect(restored[1][0]).not.toHaveProperty('serviceFolders');
  });
});
