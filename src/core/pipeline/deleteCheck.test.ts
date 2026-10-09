// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C2b: the check of Delete and its questions (deleteCheck.ts), as the worker runs them: the facts that go to
// the user, and the decision that comes back.
import { describe, expect, it, vi } from 'vitest';
import type { Environment, GitSummary } from '../types';
import { deleteCheck, type DeleteCheckDeps, type RemovableVolumes } from './deleteCheck';

const ENVIRONMENT = { id: 'e1', repository: 'acme/api', lastUsedAt: '2026-10-04T09:00:00.000Z' } as unknown as Environment;
const SUMMARY: GitSummary = { branch: 'main', uncommittedFiles: 2, unpushedCommits: 1, recordedAt: '2026-10-04T10:00:00.000Z' } as GitSummary;

/** Plan step 11I (D3): the one answer of the removable volumes (removableVolumes), empty lists unless given. */
const volumes = (lists: Partial<RemovableVolumes> = {}): RemovableVolumes => ({ additional: [], serviceData: [], possibly: [], ...lists });

function deps(overrides: Partial<DeleteCheckDeps> = {}, ui: Partial<DeleteCheckDeps['ui']> = {}) {
  const asked = {
    confirmDelete: vi.fn(async () => 'delete' as 'delete' | 'open' | undefined),
    deleteAdditionalVolumes: vi.fn(async () => 'remove' as 'remove' | 'keep' | undefined),
    deleteServiceData: vi.fn(async (volumes: readonly string[]) => [...volumes] as string[] | undefined),
    ...ui,
  };
  const all: DeleteCheckDeps = {
    summary: async () => SUMMARY,
    environment: async () => ENVIRONMENT,
    repositoryServiceData: async () => [],
    // Plan step 11I (D3): changed dep, the one read of the removable volumes (before: one dep per question).
    removableVolumes: async () => volumes(),
    ui: asked,
    ...overrides,
  };
  return { all, asked };
}

describe('the check of Delete and its questions (plan step 11C2b)', () => {
  it('asks with the facts: the changes, when the state was recorded, the last use, the data in the repository, the other window', async () => {
    const withServices = { ...ENVIRONMENT, serviceFolders: { db: ['data/db'] } } as unknown as Environment;
    const { all, asked } = deps({ environment: async () => withServices, repositoryServiceData: async () => ['/workspaces/api/data/db', 'data/cache'] });
    expect(await deleteCheck(all, ENVIRONMENT, 'Acme/API', true)).toEqual({ decision: 'delete', additionalVolumesToRemove: [] });
    expect(asked.confirmDelete).toHaveBeenCalledWith('Acme/API', {
      // Review round 1 of 11C2b (A-R1-M2): changed, the counts (the extension words them).
      changes: { uncommittedFiles: 2, unpushedCommits: 1 },
      recordedAt: SUMMARY.recordedAt,
      lastSeenInUse: ENVIRONMENT.lastUsedAt,
      repositoryData: expect.arrayContaining(['data/cache']),
      otherWindow: true,
    });
    expect(asked.deleteAdditionalVolumes).not.toHaveBeenCalled();
  });

  it('without a refreshed state: no changes, and the recorded one names the time; a failed read of the data names none', async () => {
    const recorded = { ...ENVIRONMENT, gitSummary: SUMMARY } as Environment;
    const { all, asked } = deps({ summary: async () => undefined, environment: async () => recorded, repositoryServiceData: async () => Promise.reject(new Error('no engine')) });
    await deleteCheck(all, ENVIRONMENT, 'acme/api', false);
    // Review round 1 of 11C2b (A-R1-M2): changed, no changes are absent (before: an empty text).
    expect(asked.confirmDelete).toHaveBeenCalledWith('acme/api', { recordedAt: SUMMARY.recordedAt, lastSeenInUse: ENVIRONMENT.lastUsedAt, repositoryData: [], otherWindow: false });
    // Nothing recorded and no time of use: only the plain facts.
    const bare = deps({ summary: async () => undefined, environment: async () => ({ id: 'e1', repository: 'acme/api' }) as Environment });
    await deleteCheck(bare.all, ENVIRONMENT, 'acme/api', false);
    expect(bare.asked.confirmDelete).toHaveBeenCalledWith('acme/api', { repositoryData: [], otherWindow: false });
  });

  it('Open environment and a dismissed confirmation ask nothing more', async () => {
    for (const [answer, decision] of [['open', 'open'], [undefined, 'cancel']] as const) {
      // Plan step 11I (D3): changed dep, the one read of the removable volumes.
      const { all, asked } = deps({ removableVolumes: async () => volumes({ additional: ['api-cache'] }) }, { confirmDelete: vi.fn(async () => answer) });
      expect(await deleteCheck(all, { ...ENVIRONMENT, additionalVolumes: ['api-cache'] } as Environment, 'acme/api', false)).toEqual({ decision });
      expect(asked.deleteAdditionalVolumes).not.toHaveBeenCalled();
    }
  });

  it('the additional volumes: Remove removes them, Keep keeps them, a dismissed question cancels', async () => {
    const additional = { ...ENVIRONMENT, additionalVolumes: ['api-cache'] } as Environment;
    // Plan step 11I (D3): changed dep, the one read of the removable volumes.
    const removable = { environment: async () => additional, removableVolumes: async () => volumes({ additional: ['api-cache'] }) };
    expect(await deleteCheck(deps(removable).all, additional, 'acme/api', false)).toEqual({ decision: 'delete', additionalVolumesToRemove: ['api-cache'] });
    expect(await deleteCheck(deps(removable, { deleteAdditionalVolumes: vi.fn(async () => 'keep' as const) }).all, additional, 'acme/api', false)).toEqual({
      decision: 'delete',
      additionalVolumesToRemove: [],
    });
    expect(await deleteCheck(deps(removable, { deleteAdditionalVolumes: vi.fn(async () => undefined) }).all, additional, 'acme/api', false)).toEqual({ decision: 'cancel' });
    // An entry without additional volumes asks nothing about them.
    const { all, asked } = deps({ removableVolumes: async () => volumes({ additional: ['api-cache'] }) });
    await deleteCheck(all, ENVIRONMENT, 'acme/api', false);
    expect(asked.deleteAdditionalVolumes).not.toHaveBeenCalled();
  });

  it('the data of the services: the ticked ones only, among those offered, with the possible ones named; Escape cancels', async () => {
    const additional = { ...ENVIRONMENT, additionalVolumes: ['api-db', 'api-cache'] } as Environment;
    // Plan step 11I (D3): changed dep, the one read of the removable volumes.
    const services = { environment: async () => additional, removableVolumes: async () => volumes({ serviceData: ['api-db'], possibly: ['api-db'] }) };
    const { all, asked } = deps(services, { deleteServiceData: vi.fn(async () => ['api-db', 'not-offered']) });
    expect(await deleteCheck(all, additional, 'acme/api', false)).toEqual({ decision: 'delete', additionalVolumesToRemove: ['api-db'] });
    expect(asked.deleteServiceData).toHaveBeenCalledWith(['api-db'], ['api-db']);
    expect(await deleteCheck(deps(services, { deleteServiceData: vi.fn(async () => undefined) }).all, additional, 'acme/api', false)).toEqual({ decision: 'cancel' });
  });

  it('plan step 11I (D3): reads the removable volumes once for both questions, after the confirmation', async () => {
    const additional = { ...ENVIRONMENT, additionalVolumes: ['api-cache', 'api-db', 'api-maybe'] } as Environment;
    const removableVolumes = vi.fn(async () => volumes({ additional: ['api-cache'], serviceData: ['api-db', 'api-maybe'], possibly: ['api-maybe'] }));
    const order: string[] = [];
    const { all, asked } = deps(
      { environment: async () => additional, removableVolumes: async () => (order.push('volumes'), removableVolumes()) },
      { confirmDelete: vi.fn(async () => (order.push('confirm'), 'delete' as const)), deleteServiceData: vi.fn(async () => ['api-db']) },
    );
    expect(await deleteCheck(all, additional, 'acme/api', false)).toEqual({ decision: 'delete', additionalVolumesToRemove: ['api-cache', 'api-db'] });
    expect(removableVolumes).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['confirm', 'volumes']);
    expect(asked.deleteAdditionalVolumes).toHaveBeenCalledWith(['api-cache']);
    expect(asked.deleteServiceData).toHaveBeenCalledWith(['api-db', 'api-maybe'], ['api-maybe']);
  });
});
