// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// PR H, a follow-up of plan step 11I (decision of 2026-10-09, docs/plan-remote-worker.md section 2): extensionFlow
// passes the helper image maintenance of an operation `open` on to the worker channels (their preparation of the
// worker), and adds none to another flow.
import { describe, expect, it, vi } from 'vitest';
import type { HelperMaintenance } from '../core/helper/helperImages';
import { OP_OPEN, OP_STOP } from '../core/helperChannel/protocol';
import { silentLogger } from '../core/ports';
import { extensionFlow, extensionHostSide, type HostSideDeps } from './hostSide';

describe('extensionFlow and the helper image maintenance (PR H)', () => {
  it('passes the maintenance of an open to the channels, and none for another flow', async () => {
    const all = { registry: {}, sessionFiles: {}, ui: {}, auth: {}, credentials: {}, windowId: 'w1', pid: 1, clock: { now: () => 0 }, isProcessAlive: () => true, logger: silentLogger } as unknown as HostSideDeps;
    const sent: Record<string, unknown>[] = [];
    const channels = { flow: vi.fn(async (_target: unknown, _op: string, _params: unknown, options: Record<string, unknown> = {}) => (sent.push(options), { ok: true })) };
    const flow = extensionFlow(channels as never, async () => ({ kind: 'local' }) as never, extensionHostSide(all), silentLogger);
    const maintenance: HelperMaintenance = { checkBaseImage: false };
    await flow(OP_OPEN, { repository: 'acme/api', dockerHost: '' }, { helperMaintenance: maintenance });
    await flow(OP_STOP, { environmentId: 'e1' }, {});
    expect(sent[0].helperMaintenance).toBe(maintenance);
    expect(sent[1]).not.toHaveProperty('helperMaintenance');
  });
});
