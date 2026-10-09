// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H3 (reviewer B, mutation testing): probe of the wiring of the shared extension cache into the
// pipeline of the worker that no test held: the user's default extensions of the open (WorkerServicesDeps
// .defaultExtensions) are the defaults that the record of the open stores, in the store at VSCODE_STORE_DIR. The store
// functions are a fake here (vi.mock), so nothing is written to VSCODE_STORE_DIR.
import { describe, expect, it, vi } from 'vitest';
import { VSCODE_STORE_DIR } from '../names';
import { LOCK_STATE_DIR } from '../helperChannel/protocol';
import { silentLogger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { workerServiceDeps } from './workerServices';

const seen = vi.hoisted(() => ({ records: [] as unknown[][] }));
vi.mock('./vscodeExtensionStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('./vscodeExtensionStore')>();
  return {
    ...original,
    recordExtensions: async (...args: unknown[]) => {
      seen.records.push(args);
      return [];
    },
  };
});

const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };

describe('the shared extension cache of the pipeline in the worker, probe (review round 1 of 11H3, reviewer B)', () => {
  it('records the user\'s defaults of the open in the store at VSCODE_STORE_DIR', async () => {
    const deps = workerServiceDeps({
      host: { questions: {}, state: {}, records: {}, secrets: {} } as unknown as HostSide,
      engine: unusedEngine(),
      secretOf: () => undefined,
      forgetSecret: () => undefined,
      logger: silentLogger,
      ownHelper: { image: { tag: 'devenv-helper:abc', id: IMAGE_ID }, socket: '/s.sock', vscodeStore: 'devenv-vscode' },
      dockerHost: '',
      owner: { windowId: 'w', pid: 1 },
      environmentLock: async () => {
        throw new Error('no lock in this test');
      },
      vscodeServer: SERVER,
      defaultExtensions: ['a.b', 'c.d@1.2.3'],
    });
    await deps.vscodeServer?.extensions?.record('a1b2c3d4e5', [{ id: 'e.f' }]);
    expect(seen.records).toHaveLength(1);
    const [root, environmentId, configuration, defaults] = seen.records[0];
    // Review round 1 of 11H3 (A-L5, B-D4): changed expectation, the record goes into the volume of the Session Monitor at
    // LOCK_STATE_DIR (no dev container mounts it), not into the store at VSCODE_STORE_DIR.
    expect(root).not.toBe(VSCODE_STORE_DIR);
    expect([root, environmentId, configuration, defaults]).toEqual([LOCK_STATE_DIR, 'a1b2c3d4e5', [{ id: 'e.f' }], [{ id: 'a.b' }, { id: 'c.d', version: '1.2.3' }]]);
  });
});
