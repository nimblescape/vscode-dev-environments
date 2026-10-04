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
const OTHER_ID = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';
const OTHER_NAME = resourceName('acme/web', OTHER_ID);
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
  const warnings: string[] = [];
  const records = {
    restore: async (entries: Environment[]) => (restored.push(entries), { added: entries.length, skipped: ['devenv-x'] }),
  };
  const host = { questions: {}, records, state: {}, secrets: {}, connect: {} } as unknown as HostSide;
  const logger = { ...silentLogger, warn: (text: string) => warnings.push(text) };
  // Review round 1 of 11C3 (A-R1-L1): an operation sends `record restore` once, so each call is a handler of its own.
  const restore = (entries: unknown) => hostSideHandler(host, logger, FLOW_REQUESTS[op], scope)('record', { call: 'restore', args: [entries] }, new AbortController().signal);
  return { restore, restored, warnings };
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
    // Review round 1 of 11C3 (A-R1-M1): changed, an entry of another host is left out (before: the request was refused).
    expect(await remote.restore([ENTRY, { ...ENTRY, dockerHost: 'ssh://box' }])).toEqual({ value: { added: 1, skipped: ['devenv-x'] } });
    expect(remote.restored).toEqual([[{ ...ENTRY, dockerHost: 'ssh://box' }]]);
    const local = handlerOf({ dockerHost: '' });
    // The local Docker is a missing field, never an empty one.
    await local.restore([{ ...ENTRY, dockerHost: 'ssh://box' }, { ...ENTRY, dockerHost: '' }]);
    expect(local.restored).toEqual([[]]);
  });

  it('an operation sends it once (review round 1 of 11C3, A-R1-L1)', async () => {
    const { restored, warnings } = handlerOf();
    const host = { questions: {}, records: { restore: async (entries: Environment[]) => (restored.push(entries), { added: 1, skipped: [] }) }, state: {}, secrets: {}, connect: {} } as unknown as HostSide;
    const handler = hostSideHandler(host, { ...silentLogger, warn: (text: string) => warnings.push(text) }, FLOW_REQUESTS[OP_RECONCILE], { dockerHost: '' });
    const signal = new AbortController().signal;
    await handler('record', { call: 'restore', args: [[ENTRY]] }, signal);
    await expect(handler('record', { call: 'restore', args: [[ENTRY]] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    expect(restored).toHaveLength(1);
    expect(warnings).toEqual(['The worker sent the request record restore again, which its operation sends once.']);
  });

  it.each<[string, unknown]>([
    ['not a list', { ...ENTRY }],
    ['too many entries', Array.from({ length: MAX_RESTORE_ENTRIES + 1 }, () => ENTRY)],
  ])('refuses %s', async (_name, entries) => {
    const { restore, restored } = handlerOf();
    await expect(restore(entries)).rejects.toMatchObject({ code: 'invalid' });
    expect(restored).toEqual([]);
  });

  // Review round 1 of 11C3 (A-R1-M1): changed, an entry that does not fit is left out and logged; the valid ones beside it
  // are restored (before: the whole request was refused).
  it.each<[string, unknown]>([
    ['an entry that is not an object', null],
    ['a field beyond a rebuild: a build record', { ...ENTRY, buildRecord: {} }],
    ['a field beyond a rebuild: a busy mark', { ...ENTRY, busy: { operation: 'delete' } }],
    ['a field beyond a rebuild: a Git state', { ...ENTRY, gitSummary: {} }],
    ['an ID that is no storage ID', { ...ENTRY, id: '../x' }],
    ['no repository name', { ...ENTRY, repository: 'acme' }],
    ['a repository with a control character', { ...ENTRY, repository: 'acme/a\u0001pi' }],
    ['a volume of another name', { ...ENTRY, volumeName: 'devenv-acme-api-other', containerName: 'devenv-acme-api-other' }],
    ['a container of another name', { ...ENTRY, containerName: 'other' }],
    ['a volume of another environment', { ...ENTRY, id: '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b' }],
    ['a configuration path outside .devcontainer', { ...ENTRY, configPath: '../x/devcontainer.json' }],
    ['a time that is none', { ...ENTRY, createdAt: 'yesterday' }],
    ['an owner with a login', { ...ENTRY, owner: { id: '42', login: 'octo' } }],
    ['an owner with more fields', { ...ENTRY, owner: { id: '42', login: '', admin: true } }],
    ['an owner without a storage ID', { ...ENTRY, owner: { id: '', login: '' } }],
    ['additional volumes that are no names', { ...ENTRY, additionalVolumes: ['a b'] }],
    ['an empty list of additional volumes', { ...ENTRY, additionalVolumes: [] }],
    ['the workspace volume as an additional volume', { ...ENTRY, additionalVolumes: [NAME] }],
    ['an additional volume twice', { ...ENTRY, additionalVolumes: ['api-db', 'api-db'] }],
    ['a volume of the services that is no additional volume', { ...ENTRY, additionalVolumes: ['api-db'], serviceVolumes: ['api-cache'] }],
    ['an empty list of volumes of the services', { ...ENTRY, additionalVolumes: ['api-db'], serviceVolumes: [] }],
    ['an overflow that is not true', { ...ENTRY, serviceFoldersOverflow: false }],
  ])('leaves out %s, and restores the others', async (_name, odd) => {
    const other = { ...ENTRY, id: OTHER_ID, repository: 'acme/web', volumeName: OTHER_NAME, containerName: OTHER_NAME };
    const { restore, restored, warnings } = handlerOf();
    expect(await restore([odd, other])).toEqual({ value: { added: 1, skipped: ['devenv-x'] } });
    expect(restored).toEqual([[other]]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^The worker restored an entry (of the volume [A-Za-z0-9_.-]+ )?that is left out: /);
  });

  it('names the volume of an entry left out only when it is a volume name', async () => {
    const { restore, warnings } = handlerOf();
    await restore([{ ...ENTRY, createdAt: 'x' }, { ...ENTRY, volumeName: 'a\nb' }]);
    expect(warnings).toEqual([
      `The worker restored an entry of the volume ${NAME} that is left out: a time.`,
      'The worker restored an entry that is left out: its volume has not the name of its environment.',
    ]);
  });

  // Review round 1 of 11C3 (A-R1-M1): changed, service folders that do not fit count as overflow (before: refused), so the
  // whole repository is left to the services and their data never loses its owner.
  it.each<[string, unknown]>([
    ['service folders that are no list', '/workspaces/api'],
    ['too many service folders', Array.from({ length: MAX_SERVICE_FOLDERS + 1 }, (_, i) => `/workspaces/api/${i}`)],
    ['a service folder with a line break', ['/workspaces/api/data', '/workspaces/api/a\nb']],
    ['a service folder that is no text', ['/workspaces/api/data', 7]],
  ])('counts %s as overflow', async (_name, serviceFolders) => {
    const { restore, restored } = handlerOf();
    await restore([{ ...ENTRY, serviceFolders }]);
    expect(restored[0][0].serviceFoldersOverflow).toBe(true);
    expect((restored[0][0].serviceFolders ?? []).length).toBeLessThanOrEqual(MAX_SERVICE_FOLDERS);
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
