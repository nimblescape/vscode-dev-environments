// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup after plan step 11 (PR #138, B6): one `devenv-` prefix of the names of an environment, for the names, the list
// of the environment images (EngineDocker) and the image-ownership check of the host access policy (policy/images.ts).
import { describe, expect, it } from 'vitest';
import { RESOURCE_NAME_PREFIX, isEnvironmentResourceName, resourceName } from './names';
import { environmentImageNames } from './policy/images';
import { unusedEngine } from './worker/dockerEngine.testkit';
import { EngineDocker } from './worker/engineDocker';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

describe('the resource prefix (PR #138, B6)', () => {
  it('is devenv-, the start of every name of an environment', () => {
    expect(RESOURCE_NAME_PREFIX).toBe('devenv-');
    const name = resourceName('acme/api', ID);
    expect(name.startsWith(RESOURCE_NAME_PREFIX)).toBe(true);
    expect(isEnvironmentResourceName(name)).toBe(true);
  });

  it('is the one of the image-ownership check of the policy: the same name with another start is no environment image', () => {
    const name = resourceName('acme/api', ID);
    expect(environmentImageNames(`${name}:2`)).toEqual([name]);
    expect(environmentImageNames(`${name}-db:latest`)).toEqual([name]);
    const other = `devenx-${name.slice(RESOURCE_NAME_PREFIX.length)}`;
    expect(isEnvironmentResourceName(other)).toBe(false);
    expect(environmentImageNames(`${other}:2`)).toEqual([]);
  });

  it('is the one of the list of the environment images', async () => {
    const filters: unknown[] = [];
    const docker = new EngineDocker({
      ...unusedEngine(),
      images: async (filter) => (filters.push(filter), [{ id: 'sha256:a', repoTags: [`${RESOURCE_NAME_PREFIX}a:1`, 'devenx-a:1'], repoDigests: [], labels: {}, created: 'c' }]),
    });
    expect(await docker.listEnvironmentImages()).toEqual([{ id: 'sha256:a', tags: ['devenv-a:1'], createdAt: 'c' }]);
    expect(filters).toEqual([{ reference: ['devenv-*'] }]);
  });
});
