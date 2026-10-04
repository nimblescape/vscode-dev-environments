// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11C3 (reviewer B, mutation probes): the bounds of `record restore` (hostSideHandler.restoredEntry).
import { describe, expect, it } from 'vitest';
import { MAX_SERVICE_FOLDERS, MAX_SERVICE_PATH_DEPTH } from '../git/gitSummary';
import { OP_RECONCILE } from '../helperChannel/protocol';
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

async function restore(entries: unknown[]): Promise<Environment[]> {
  const restored: Environment[][] = [];
  const records = { restore: async (list: Environment[]) => (restored.push(list), { added: list.length, skipped: [] }) };
  const host = { questions: {}, records, state: {}, secrets: {}, connect: {} } as unknown as HostSide;
  await hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_RECONCILE], { dockerHost: '' })('record', { call: 'restore', args: [entries] }, new AbortController().signal);
  return restored[0];
}

function named(repository: string) {
  const name = resourceName(repository, ID);
  return { ...ENTRY, repository, volumeName: name, containerName: name };
}

describe('record restore, the bounds (review round 2 of 11C3, reviewer B)', () => {
  it('takes a repository of 256 characters, leaves out one of 257', async () => {
    expect(await restore([named(`acme/${'a'.repeat(251)}`)])).toHaveLength(1);
    expect(await restore([named(`acme/${'a'.repeat(252)}`)])).toEqual([]);
  });

  it('takes a time of 64 characters, leaves out one of 65', async () => {
    const time = (length: number) => `Sun Oct 04 2026 12:00:00 GMT+0000 (${'x'.repeat(length - 36)})`;
    expect(Number.isFinite(Date.parse(time(65)))).toBe(true);
    expect(await restore([{ ...ENTRY, createdAt: time(64) }])).toHaveLength(1);
    expect(await restore([{ ...ENTRY, createdAt: time(65) }])).toEqual([]);
    expect(await restore([{ ...ENTRY, lastUsedAt: time(65) }])).toEqual([]);
  });

  it('reads only the first MAX_SERVICE_FOLDERS service folders (one beyond them is not recorded)', async () => {
    const folders = Array.from({ length: MAX_SERVICE_FOLDERS }, (_, i) => `/workspaces/api/data/${i}`);
    // The one beyond the bound would cover all others.
    const [entry] = await restore([{ ...ENTRY, serviceFolders: [...folders, '/workspaces/api/data'] }]);
    expect(entry.serviceFoldersOverflow).toBe(true);
    expect(entry.serviceFolders).not.toContain('/workspaces/api/data');
    expect(entry.serviceFolders).toHaveLength(MAX_SERVICE_FOLDERS);
  });

  it('a service folder deeper than the bounds of the pipeline is overflow', async () => {
    const deep = `/workspaces/api/${Array.from({ length: MAX_SERVICE_PATH_DEPTH + 1 }, () => 'd').join('/')}`;
    const [entry] = await restore([{ ...ENTRY, serviceFolders: ['/workspaces/api/data', deep] }]);
    expect(entry.serviceFolders).toEqual(['/workspaces/api/data']);
    expect(entry.serviceFoldersOverflow).toBe(true);
  });
});
