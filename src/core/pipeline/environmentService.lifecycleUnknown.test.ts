// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E6 (review round 1 of PR #107, A-L2): a worker open that ended without its answer after it began `up` leaves
// the lifecycle of the environment unknown to the window (LIFECYCLE_UNKNOWN in its memory): the next open of the window
// opens no running container of the environment as it is; `up` and its lifecycle commands run, then the window forgets it.
import { afterEach, describe, expect, it } from 'vitest';
import { environmentImageName } from '../names';
import type { RepositoryTarget } from './operationBase';
import { ENV_ID, PID, REPO, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';
import { LIFECYCLE_UNKNOWN, rememberedFor, windowLifecycleMemory } from './lifecycleMemory';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const IMAGE_1 = environmentImageName(REPO, ENV_ID, 1);

let h: Harness | undefined;
afterEach(() => h?.cleanup());

describe('the lifecycle of an environment that the window does not know (plan step 11E6)', () => {
  it('names every container; a forget of any container forgets it', async () => {
    expect(rememberedFor(LIFECYCLE_UNKNOWN, 'a'.repeat(64))).toBe(true);
    expect(rememberedFor('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    const memory = windowLifecycleMemory();
    await memory.remember(ENV_ID, LIFECYCLE_UNKNOWN);
    await memory.forget('other', 'a'.repeat(64));
    expect(await memory.get(ENV_ID)).toBe(LIFECYCLE_UNKNOWN);
    await memory.forget(ENV_ID, 'a'.repeat(64));
    expect(await memory.get(ENV_ID)).toBeUndefined();
  });

  it('the running container is not opened as it is: `up` and its lifecycle commands run, then the window forgets it', async () => {
    const memory = windowLifecycleMemory();
    h = createHarness({ isProcessAlive: (pid) => pid === PID, lifecycleMemory: memory });
    await seedEnvironment(h, { container: 'running' });
    await memory.remember(ENV_ID, LIFECYCLE_UNKNOWN);
    h.settings.updateImagesOnConnect = false;
    await h.service.open(TARGET, { progress: h.progress });
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(await memory.get(ENV_ID)).toBeUndefined();
    // The next open opens it as it is.
    h.helper.calls.length = 0;
    await h.service.open(TARGET, { progress: h.progress });
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
  });

  it('another environment does not count', async () => {
    const memory = windowLifecycleMemory();
    h = createHarness({ isProcessAlive: (pid) => pid === PID, lifecycleMemory: memory });
    await seedEnvironment(h, { container: 'running' });
    await memory.remember('7c1d2e3f-0000-4000-8000-000000000002', LIFECYCLE_UNKNOWN);
    h.settings.updateImagesOnConnect = false;
    await h.service.open(TARGET, { progress: h.progress });
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([]);
  });
});
