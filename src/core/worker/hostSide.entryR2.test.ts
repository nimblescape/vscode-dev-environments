// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #106 (B, mutation probes): the bound of the build number as a literal, the dedupe of the volume
// names of a request, the cap of the additional volumes for a request that repeats a name, the count line of the log of
// the left-out volumes at exactly MAX_LEFT_OUT_LINES lines, and the case-insensitive clash with a volume that a Delete
// of another account kept.
import { describe, expect, it } from 'vitest';
import { resourceName } from '../names';
import type { BusyMarkView } from '../pipeline/busyMarks';
import { silentLogger, type Logger } from '../ports';
import type { EnvironmentRegistry } from '../storage/registry';
import type { Environment, GitHubAccount, KeptVolume, RegistryFile } from '../types';
import { checkedBuildChange, checkedConfigurationChange, requestOpenRecords } from './openRequests';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NEW = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';
const REPOSITORY = 'acme/api';
const HOST = 'ssh://box';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const ACCOUNT: GitHubAccount = { id: '42', login: 'octo' };
const THEIRS: GitHubAccount = { id: '7', login: 'other' };
const DEFAULT = '.devcontainer/devcontainer.json';

const entryOf = (id: string, fields: Partial<Environment> = {}): Environment =>
  ({
    id,
    repository: REPOSITORY,
    configPath: DEFAULT,
    volumeName: resourceName(REPOSITORY, id),
    containerName: resourceName(REPOSITORY, id),
    createdAt: '2020-01-01T00:00:00.000Z',
    lastUsedAt: '2020-01-01T00:00:00.000Z',
    owner: ACCOUNT,
    dockerHost: HOST,
    ...fields,
  }) as Environment;

/** requestOpenRecords of ACCOUNT on HOST over an in-memory registry file, with the warnings that it logs. */
function setup(entries: readonly Environment[], kept: readonly KeptVolume[] = []) {
  let file: RegistryFile = { version: 1, environments: structuredClone([...entries]), ...(kept.length > 0 ? { keptVolumes: structuredClone([...kept]) } : {}) };
  const update = (async <T>(mutator: (file: RegistryFile) => T | Promise<T>) => {
    const copy = structuredClone(file);
    const result = await mutator(copy);
    file = copy;
    return structuredClone(result);
  }) as EnvironmentRegistry['update'];
  const registry: Pick<EnvironmentRegistry, 'update' | 'updateEnvironment'> = {
    update,
    updateEnvironment: (id, mutator) =>
      update(async (f) => {
        const found = f.environments.find((candidate) => candidate.id === id);
        if (!found) return undefined;
        await mutator(found);
        return found;
      }),
  };
  const warnings: string[] = [];
  const logger: Logger = { ...silentLogger, warn: (text) => warnings.push(text) };
  const view: BusyMarkView = { owner: { windowId: 'w1', pid: 100 }, clock: { now: () => NOW }, isAlive: () => true, windowStatuses: async () => [], logger };
  const records = requestOpenRecords(registry, view, { account: ACCOUNT, dockerHost: HOST });
  return { records, warnings, file: () => file };
}

describe('review round 2 of PR #106 (B): mutation probes of the registry writes of plan step 11E4c', () => {
  it('a build number of 1000000000 is taken, one above it is refused (MAX_BUILD_NUMBER, A-L3)', () => {
    expect(checkedBuildChange('number', [1_000_000_000])).toEqual({ kind: 'number', buildNumber: 1_000_000_000 });
    expect(() => checkedBuildChange('number', [1_000_000_001])).toThrow();
  });

  it('a request names each volume once: the checked change drops the repeats (A3-M1)', () => {
    expect(checkedConfigurationChange({ addVolumes: ['a', 'b', 'a', 'a'], addServiceVolumes: ['b', 'b', 'a'] })).toEqual({ addVolumes: ['a', 'b'], addServiceVolumes: ['b', 'a'] });
  });

  it('a refused name that a request repeats is logged once, without a count line', async () => {
    const { records, warnings } = setup([entryOf(ID)]);
    const workspace = resourceName(REPOSITORY, ID);
    await records.configuration(ID, checkedConfigurationChange({ addVolumes: Array.from({ length: 20 }, () => workspace) }));
    expect(warnings).toEqual([`The worker recorded the volume ${workspace} for ${REPOSITORY}, which is left out: it is the workspace volume of the environment.`]);
  });

  it('the cap counts a name that the request repeats once (A2-M1)', async () => {
    const recorded = Array.from({ length: 999 }, (_, i) => `v${i}`);
    const { records, warnings } = setup([entryOf(ID, { additionalVolumes: recorded })]);
    const updated = await records.configuration(ID, { addVolumes: ['n', 'n'] });
    expect(updated?.additionalVolumes).toEqual([...recorded, 'n']);
    expect(warnings).toEqual([]);
  });

  it('exactly MAX_LEFT_OUT_LINES left-out volumes: ten lines, no count line (A4-L1)', async () => {
    const { records, warnings } = setup([entryOf(ID)]);
    await records.configuration(ID, { addServiceVolumes: Array.from({ length: 10 }, (_, i) => `s${i}`) });
    expect(warnings).toHaveLength(10);
    expect(warnings.some((text) => text.includes('more volumes'))).toBe(false);
  });

  it('a volume that a Delete of another account kept is a clash in any case (A4-L2)', async () => {
    const name = resourceName(REPOSITORY, NEW);
    const { records, file } = setup([], [{ name: name.toUpperCase(), owner: THEIRS, keptAt: '2026-10-01T00:00:00.000Z' }]);
    await expect(records.createEnvironment({ id: NEW, repository: REPOSITORY, configPath: DEFAULT })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another account') });
    expect(file().environments).toEqual([]);
  });
});
