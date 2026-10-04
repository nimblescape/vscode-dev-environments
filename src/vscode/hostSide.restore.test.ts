// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C3 (decision of 2026-10-04): `record restore` in the extension: the operation `reconcile` restores only the
// entries of the Docker host of its parameters (extensionFlow), and the registry gets them with the clock of this window.
import { describe, expect, it, vi } from 'vitest';
import type { OperationOptions } from '../core/helperChannel/helperChannel';
import { OP_RECONCILE } from '../core/helperChannel/protocol';
import { resourceName } from '../core/names';
import { silentLogger } from '../core/ports';
import type { Environment } from '../core/types';
import { extensionFlow, extensionHostSide, type HostSideDeps } from './hostSide';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = resourceName('acme/api', ID);
const ENTRY = {
  id: ID,
  repository: 'acme/api',
  configPath: '.devcontainer/devcontainer.json',
  volumeName: NAME,
  containerName: NAME,
  createdAt: '2020-01-01T00:00:00.000Z',
  lastUsedAt: '2020-01-01T00:00:00.000Z',
  owner: { id: '42', login: '' },
};
const NOW = Date.parse('2026-10-04T15:00:00.000Z');

async function onAskOf(params: Record<string, unknown>) {
  const restored: Environment[][] = [];
  const registry = { restore: vi.fn(async (entries: Environment[]) => (restored.push(entries), { added: entries.length, skipped: [] })) };
  const deps = { registry, sessionFiles: {}, ui: {}, auth: {}, credentials: {}, settings: () => ({}), windowId: 'w1', pid: 1, clock: { now: () => NOW }, isProcessAlive: () => true, logger: silentLogger } as unknown as HostSideDeps;
  const sent: OperationOptions[] = [];
  const channels = { flow: vi.fn(async (_t: unknown, _op: string, _p: unknown, options: OperationOptions = {}) => (sent.push(options), { added: 0 })) };
  await extensionFlow(channels as never, async () => ({ kind: 'remote' }) as never, extensionHostSide(deps), silentLogger)(OP_RECONCILE, params, {});
  const onAsk = sent[0].onAsk!;
  return { restore: (entries: unknown[]) => onAsk('record', { call: 'restore', args: [entries] }, new AbortController().signal), restored };
}

describe('record restore in the extension (plan step 11C3)', () => {
  it('restores the entries of the Docker host of the operation, with the clock of this window', async () => {
    const { restore, restored } = await onAskOf({ dockerHost: 'ssh://box', owner: { windowId: 'w1', pid: 1 } });
    await expect(restore([ENTRY])).rejects.toMatchObject({ code: 'invalid' });
    expect(await restore([{ ...ENTRY, dockerHost: 'ssh://box' }])).toEqual({ value: { added: 1, skipped: [] } });
    const time = new Date(NOW).toISOString();
    expect(restored).toEqual([[{ ...ENTRY, dockerHost: 'ssh://box', createdAt: time, lastUsedAt: time }]]);
  });

  it('parameters without a Docker host restore nothing', async () => {
    const { restore, restored } = await onAskOf({ owner: { windowId: 'w1', pid: 1 } });
    await expect(restore([ENTRY])).rejects.toMatchObject({ code: 'invalid' });
    expect(restored).toEqual([]);
  });
});
