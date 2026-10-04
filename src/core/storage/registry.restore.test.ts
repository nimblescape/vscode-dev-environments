// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C3 (decision of 2026-10-04, `record restore`): the entries rebuilt from the labels of the volumes, added by
// the registry under its lock (concept 7.5 "registry lost"; before: a function of reconcileFromVolumes run by `update`).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Environment } from '../types';
import { StoragePaths } from './paths';
import { EnvironmentRegistry } from './registry';

const ID_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ID_B = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';
const ID_C = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

function entry(id: string, repository: string, fields: Partial<Environment> = {}): Environment {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `volume-${id}`,
    containerName: `volume-${id}`,
    createdAt: '2026-10-04T12:00:00.000Z',
    lastUsedAt: '2026-10-04T12:00:00.000Z',
    owner: { id: '42', login: '' },
    ...fields,
  };
}

let root: string;
let registry: EnvironmentRegistry;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-restore-'));
  registry = new EnvironmentRegistry(new StoragePaths(root));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the restore of the registry from the volumes (plan step 11C3)', () => {
  it('adds the entries that the registry lacks, in a file that was missing', async () => {
    expect(await registry.restore([entry(ID_A, 'acme/api'), entry(ID_B, 'acme/web')])).toEqual({ added: 2, skipped: [] });
    expect((await registry.list()).map((e) => e.id)).toEqual([ID_A, ID_B]);
  });

  it('leaves out an entry whose ID or volume the registry has, without naming it (it was never lost)', async () => {
    await registry.add(entry(ID_A, 'acme/api'));
    const sameVolume = entry(ID_B, 'acme/web', { volumeName: `volume-${ID_A}` });
    expect(await registry.restore([entry(ID_A, 'acme/other'), sameVolume])).toEqual({ added: 0, skipped: [] });
    expect((await registry.list()).map((e) => e.repository)).toEqual(['acme/api']);
  });

  it('leaves out and names one of a repository whose owner has an environment on its Docker host (concept D-3)', async () => {
    await registry.add(entry(ID_A, 'acme/api'));
    const sameKey = entry(ID_B, 'Acme/API');
    // Another account, and another Docker host, are other keys.
    const otherAccount = entry(ID_C, 'acme/api', { owner: { id: '43', login: '' } });
    expect(await registry.restore([sameKey, otherAccount])).toEqual({ added: 1, skipped: [sameKey.volumeName] });
    const otherHost = entry(ID_B, 'acme/api', { dockerHost: 'ssh://box' });
    expect(await registry.restore([otherHost])).toEqual({ added: 1, skipped: [] });
    expect((await registry.list()).map((e) => e.id)).toEqual([ID_A, ID_C, ID_B]);
  });

  it('two entries of one key in one restore: the first is added, the second named', async () => {
    const first = entry(ID_A, 'acme/api');
    const second = entry(ID_B, 'acme/api');
    expect(await registry.restore([first, second])).toEqual({ added: 1, skipped: [second.volumeName] });
  });

  it('an empty restore writes nothing', async () => {
    expect(await registry.restore([])).toEqual({ added: 0, skipped: [] });
    expect(await registry.exists()).toBe(false);
  });

  it('a volume or container of the same name in another case is the same one (review round 1 of 11C3, A-R1-L3)', async () => {
    await registry.add(entry(ID_A, 'acme/api', { volumeName: 'devenv-acme-api-x', containerName: 'devenv-acme-api-x' }));
    const volume = entry(ID_B, 'acme/web', { volumeName: 'DEVENV-ACME-API-X', containerName: 'other' });
    const container = entry(ID_C, 'acme/web', { volumeName: 'another', containerName: 'Devenv-Acme-Api-X' });
    expect(await registry.restore([volume, container])).toEqual({ added: 0, skipped: [] });
    expect(await registry.list()).toHaveLength(1);
  });
});
