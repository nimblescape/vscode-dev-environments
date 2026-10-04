// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11C3 (reviewer B, mutation probe): reconcileFromVolumes skips a repository label that `record restore`
// would leave out (more than 256 characters, a control character including NUL and DEL).
import { describe, expect, it } from 'vitest';
import { LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, resourceName } from '../names';
import { ACCOUNT, createHarness } from './environmentService.testkit';

describe('reconcileFromVolumes, the repository label (review round 2 of 11C3, reviewer B)', () => {
  it('restores a repository of 256 characters; skips one of 257, and one with NUL or DEL', async () => {
    const h = createHarness();
    try {
      const volume = (id: string, repository: string) => {
        h.docker.volumes.set(resourceName(repository, id), { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [LABEL_OWNER_ID]: ACCOUNT.id });
        return resourceName(repository, id);
      };
      const ok = `acme/${'a'.repeat(251)}`;
      expect(ok).toHaveLength(256);
      volume('a0000001-0000-4000-8000-000000000001', ok);
      const skipped = [
        volume('a0000002-0000-4000-8000-000000000002', `acme/${'b'.repeat(252)}`),
        volume('a0000003-0000-4000-8000-000000000003', 'acme/w\u007feb'),
        volume('a0000004-0000-4000-8000-000000000004', 'acme/w\u0000eb'),
      ];
      expect(await h.service.reconcileFromVolumes()).toBe(1);
      expect((await h.registry.list()).map((e) => e.repository)).toEqual([ok]);
      for (const name of skipped) expect(h.logger.warnings).toContain(`The volume ${name} has invalid labels and is skipped.`);
    } finally {
      h.cleanup();
    }
  });
});
