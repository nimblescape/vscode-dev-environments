// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11C3 (reviewer B, mutation probe): reconcileInWorker with parameters that cannot be sent.
import { describe, expect, it } from 'vitest';
import { RECONCILE_FLOW_TIMEOUT_MS } from './environmentService';
import { createHarness } from './environmentService.testkit';

describe('reconcileInWorker (review round 1 of 11C3, reviewer B)', () => {
  it('fails, and sends nothing, when the window of the operation does not fit the parameters', async () => {
    const calls: unknown[] = [];
    const h = createHarness({ owner: { windowId: 'window-1', pid: 0 }, flow: async (...args) => (calls.push(args), { added: 1 }) });
    await expect(h.service.reconcileInWorker({ passive: true })).rejects.toThrow('cannot be sent to the worker');
    expect(calls).toEqual([]);
  });

  it('waits at most two minutes for the worker', () => {
    expect(RECONCILE_FLOW_TIMEOUT_MS).toBe(2 * 60_000);
  });
});
