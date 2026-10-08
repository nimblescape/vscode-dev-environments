// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E6 (review round 5 of PR #106, A5-L1): the ID of a first open is none whose volume name an entry records as
// an additional volume, or that the registry keeps for an account after a Delete: the extension refuses an entry of such
// a name (`record createEnvironment`), so the first open in the worker picks another one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceName } from '../names';
import { namePair } from '../namePairs';
import type { RepositoryTarget } from './operationBase';
import { ENV_ID, OTHER_ACCOUNT, OTHER_ID, REPO, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const RECORDED = '4d4d4d4d-0000-4000-8000-000000000004';
const FREE = '5e5e5e5e-0000-4000-8000-000000000005';

let h: Harness | undefined;
afterEach(() => h?.cleanup());

describe('the ID of a first open past the recorded volumes (plan step 11E6, A5-L1)', () => {
  it('uses IDs of other name pairs than the seeded ones', () => {
    expect(new Set([namePair(RECORDED), namePair(FREE), namePair(ENV_ID), namePair(OTHER_ID)]).size).toBe(4);
  });

  it('is not one whose volume name another entry records as an additional volume (in any case)', async () => {
    const ids = vi.fn().mockReturnValueOnce(RECORDED).mockReturnValue(FREE);
    h = createHarness({ newEnvironmentId: ids });
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', owner: OTHER_ACCOUNT, extra: { additionalVolumes: [resourceName(REPO, RECORDED).toUpperCase()] } });
    const result = await h.service.open(TARGET, { progress: h.progress });
    expect(result.environment.id).toBe(FREE);
    expect(ids).toHaveBeenCalledTimes(2);
  });

  it('is not one whose volume name the registry keeps for an account after a Delete', async () => {
    const ids = vi.fn().mockReturnValueOnce(RECORDED).mockReturnValue(FREE);
    h = createHarness({ newEnvironmentId: ids });
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', owner: OTHER_ACCOUNT, extra: { additionalVolumes: [resourceName(REPO, RECORDED)] } });
    // Delete of that entry keeps its volume for its account (EnvironmentRegistry.remove with `kept`).
    await h.registry.remove(OTHER_ID, { kept: [resourceName(REPO, RECORDED)] });
    expect((await h.registry.read()).keptVolumes?.map((kept) => kept.name)).toEqual([resourceName(REPO, RECORDED)]);
    const result = await h.service.open(TARGET, { progress: h.progress });
    expect(result.environment.id).toBe(FREE);
  });
});
