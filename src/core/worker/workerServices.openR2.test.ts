// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 2 of PR #111 (mutation probes): in the worker, a failed read of whether a container runs counts as
// `false` (the lifecycle error stands), it does not escape the helper's catch (B2-13).
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { workerServiceDeps } from './workerServices';

describe('whether a container runs, in the worker (review B, round 2 of PR #111)', () => {
  it('B2-13: a failed read of the engine counts as not running', async () => {
    const all = workerServiceDeps({
      host: { questions: {}, state: {}, records: {}, secrets: {} } as unknown as HostSide,
      engine: {
        ...unusedEngine(),
        container: async () => {
          throw new Error('the engine is gone');
        },
      },
      secretOf: () => undefined,
      forgetSecret: () => undefined,
      logger: silentLogger,
      ownHelper: { image: { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/s.sock' },
      dockerHost: '',
      owner: { windowId: 'w', pid: 1 },
      environmentLock: async () => {
        throw new Error('no lock in this test');
      },
    });
    const helper = all.helper as unknown as { containerRuns(id: string): Promise<boolean> };
    await expect(helper.containerRuns('c'.repeat(64))).resolves.toBe(false);
  });
});
