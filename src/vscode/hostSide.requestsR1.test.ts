// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #105 (B, mutation probes): the end of the open in the extension asks this computer whether the
// process of another window's mark runs (its own view of the windows, never "every process is alive").
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../core/ports';
import type { BusyMark, Environment, WindowStatus } from '../core/types';
import { extensionHostSide, type HostSideDeps } from './hostSide';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const other: BusyMark = { operation: 'update', since: '2026-10-04T11:59:00.000Z', pid: 200, windowId: 'w2' };

describe('review round 1 of PR #105 (B): the liveness of the extension', () => {
  it('a mark of another window whose process has ended goes at the end of the open', async () => {
    let entry = { id: ID, repository: 'acme/api', owner: { id: '42', login: 'o' }, dockerHost: 'ssh://box', lastUsedAt: '2020-01-01T00:00:00.000Z', busy: other } as Environment;
    const registry = {
      updateEnvironment: async (id: string, mutator: (e: Environment) => void | Promise<void>) => {
        if (id !== ID) return undefined;
        const copy = structuredClone(entry);
        await mutator(copy);
        entry = copy;
        return structuredClone(copy);
      },
    };
    const statuses = [{ windowId: 'w2', pid: 200, updatedAt: new Date(NOW - 5_000).toISOString() } as WindowStatus];
    const deps = {
      registry,
      sessionFiles: { readWindowStatuses: async () => statuses },
      ui: {},
      auth: { getAccount: async () => ({ id: '42', login: 'octo' }) },
      credentials: {},
      settings: () => ({}),
      windowId: 'w1',
      pid: 100,
      clock: { now: () => NOW },
      isProcessAlive: (pid: number) => pid !== 200,
      logger: silentLogger,
    } as unknown as HostSideDeps;
    expect(await extensionHostSide(deps).records.openFinished(ID, { remoteWorkspaceFolder: '/workspaces/api' }, { dockerHost: 'ssh://box' })).not.toHaveProperty('busy');
  });
});
