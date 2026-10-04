// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of plan step 11C2b (mutation tests, B-R2): extensionFlow wires the repository and the observers of deleteCheck.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import { OP_DELETE_CHECK } from '../core/helperChannel/protocol';
import type { OperationOptions } from '../core/helperChannel/helperChannel';
import { extensionFlow, extensionHostSide, type HostSideDeps } from './hostSide';

describe('review round 2 of 11C2b (mutation tests): extensionFlow for the check of Delete', () => {
  it('R1/R3/R4/R5: binds the questions to the repository of the operation and passes the answers and the open questions on', async () => {
    const ui = { info: vi.fn(), warn: vi.fn(), registrySignIn: vi.fn(), confirmDelete: vi.fn(async () => 'delete' as const) };
    const all = { registry: {}, sessionFiles: {}, ui, auth: {}, credentials: {}, settings: () => ({}), windowId: 'w1', pid: 1, clock: { now: () => 0 }, isProcessAlive: () => true, logger: silentLogger } as unknown as HostSideDeps;
    const sent: OperationOptions[] = [];
    const channels = { flow: vi.fn(async (_t: unknown, _op: string, _p: unknown, options: OperationOptions = {}) => (sent.push(options), { decision: 'cancel' })) };
    const flow = extensionFlow(channels as never, async () => ({ kind: 'local' }) as never, extensionHostSide(all), silentLogger);
    const answers: unknown[] = [];
    const states: string[] = [];
    await flow(OP_DELETE_CHECK, { environmentId: 'e1', dockerHost: '', owner: 'o', repository: 'Acme/API', otherWindow: false }, {
      onAnswer: (call, _args, value) => answers.push([call, value]),
      onQuestion: (state) => states.push(state),
    });
    const onAsk = sent[0].onAsk!;
    const signal = new AbortController().signal;
    const confirmation = { repositoryData: [], otherWindow: false };
    await expect(onAsk('question', { call: 'confirmDelete', args: ['acme/other', confirmation] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    expect(ui.confirmDelete).not.toHaveBeenCalled();
    await expect(onAsk('question', { call: 'confirmDelete', args: ['Acme/API', confirmation] }, signal)).resolves.toEqual({ value: 'delete' });
    expect(answers).toEqual([['confirmDelete', 'delete']]);
    expect(states).toEqual(['asked', 'settled']);
  });
});
