// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11C3 (reviewer B, mutation probes): `record restore` as the extension checks it (hostSideHandler).
import { describe, expect, it } from 'vitest';
import { OP_RECONCILE, parseReconcileValue } from '../helperChannel/protocol';
import { resourceName } from '../names';
import { silentLogger } from '../ports';
import type { Environment } from '../types';
import { FLOW_REQUESTS, type HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = resourceName('acme/api', ID);
const ENTRY = {
  id: ID,
  repository: 'acme/api',
  configPath: '.devcontainer/devcontainer.json',
  volumeName: NAME,
  containerName: NAME,
  createdAt: '2026-10-04T12:00:00.000Z',
  lastUsedAt: '2026-10-04T12:00:00.000Z',
  owner: { id: '42', login: '' },
};

function handlerOf() {
  const restored: Environment[][] = [];
  const records = {
    read: async () => ({ version: 1, environments: [] }),
    restore: async (entries: Environment[]) => (restored.push(entries), { added: entries.length, skipped: [] }),
  };
  const host = { questions: {}, records, state: {}, secrets: {}, connect: {} } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_RECONCILE], { dockerHost: '' });
  const signal = new AbortController().signal;
  return { handler, restore: (entries: unknown) => handler('record', { call: 'restore', args: [entries] }, signal), restored, signal };
}

/** An entry of an environment ID / repository whose volume has the name of its environment. */
function named(id: string, repository: string) {
  const name = resourceName(repository, id);
  return { ...ENTRY, id, repository, volumeName: name, containerName: name };
}

describe('record restore, the checks (review round 1 of 11C3, reviewer B)', () => {
  it.each<[string, unknown]>([
    ['an ID that is no storage ID, with the volume of its name', [named('../x', 'acme/api')]],
    ['a repository with a control character, with the volume of its name', [named(ID, 'acme/a\u0000pi')]],
    ['a repository that is too long, with the volume of its name', [named(ID, `acme/${'a'.repeat(300)}`)]],
    ['a time that is too long', [{ ...ENTRY, createdAt: `Sun Oct 04 2026 12:00:00 GMT+0000 (${'x'.repeat(60)})` }]],
    ['a last use that is no time', [{ ...ENTRY, lastUsedAt: 'yesterday' }]],
    ['an entry that is a list', [Object.assign([], ENTRY)]],
    ['an owner that is a list', [{ ...ENTRY, owner: Object.assign([], { id: '42', login: '' }) }]],
    ['too many additional volumes', [{ ...ENTRY, additionalVolumes: Array.from({ length: 1001 }, (_, i) => `api-${i}`) }]],
  ])('leaves out %s', async (_name, entries) => {
    const { restore, restored } = handlerOf();
    // Review round 1 of 11C3 (A-R1-M1): an entry that does not fit is left out (the request is not refused).
    await restore(entries);
    expect(restored).toEqual([[]]);
  });

  it('takes 1000 entries, the most of one restore, and the extension may answer 1000 added', async () => {
    const { restore, restored } = handlerOf();
    await restore(Array.from({ length: 1000 }, () => ENTRY));
    expect(restored[0]).toHaveLength(1000);
    expect(parseReconcileValue({ added: 1000 })).toEqual({ added: 1000 });
  });

  it('the operation reconcile reads no record', async () => {
    const { handler, signal } = handlerOf();
    await expect(handler('record', { call: 'read', args: [] }, signal)).rejects.toMatchObject({ code: 'invalid' });
  });
});
