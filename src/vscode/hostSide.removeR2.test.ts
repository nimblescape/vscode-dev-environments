// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11C2a (B-R2, mutant R6): a removal from a flow answers only after the registry changed,
// and a registry that fails fails the request.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import type { Environment } from '../core/types';
import { extensionHostSide, type HostSideDeps } from './hostSide';

function host(remove: (id: string, volumes: unknown) => Promise<void>) {
  const environment = { id: 'e1', repository: 'acme/app', additionalVolumes: ['api-cache'] } as unknown as Environment;
  const registry = { get: vi.fn(async () => environment), remove: vi.fn(remove) };
  return { registry, host: extensionHostSide({ registry, sessionFiles: {}, windowId: 'w1', pid: 1, clock: { now: () => 0 }, isProcessAlive: () => true, logger: silentLogger } as unknown as HostSideDeps) };
}

describe('the removal of a flow waits for the registry (B-R2 R6)', () => {
  it('fails when the registry fails, and resolves only after the registry is done', async () => {
    const failing = host(async () => { throw new Error('registry write failed'); });
    await expect(failing.host.records.remove('e1', { removed: ['api-cache'] })).rejects.toThrow('registry write failed');
    let done = false;
    const slow = host(async () => { await new Promise((r) => setTimeout(r, 20)); done = true; });
    await slow.host.records.remove('e1', { removed: ['api-cache'] });
    expect(done).toBe(true);
  });
});
