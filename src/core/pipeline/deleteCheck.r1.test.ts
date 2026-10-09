// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11C2b (mutation tests, B-R1) (deleteCheck.ts, parseDeleteCheckValue).
import { describe, expect, it, vi } from 'vitest';
import { parseDeleteCheckValue } from '../helperChannel/protocol';
import type { Environment, GitSummary } from '../types';
import { deleteCheck, type DeleteCheckDeps, type RemovableVolumes } from './deleteCheck';

const ENVIRONMENT = { id: 'e1', repository: 'acme/api', lastUsedAt: '2026-10-04T09:00:00.000Z' } as unknown as Environment;
const SUMMARY = { branch: 'main', uncommittedFiles: 2, unpushedCommits: 1, recordedAt: '2026-10-04T10:00:00.000Z' } as GitSummary;

/** Plan step 11I (D3): the one answer of the removable volumes (removableVolumes), empty lists unless given. */
const volumes = (lists: Partial<RemovableVolumes> = {}): RemovableVolumes => ({ additional: [], serviceData: [], possibly: [], ...lists });

function deps(overrides: Partial<DeleteCheckDeps> = {}) {
  const ui = {
    confirmDelete: vi.fn(async () => 'delete' as 'delete' | 'open' | undefined),
    deleteAdditionalVolumes: vi.fn(async () => 'remove' as 'remove' | 'keep' | undefined),
    deleteServiceData: vi.fn(async (volumes: readonly string[]) => [...volumes] as string[] | undefined),
  };
  const all: DeleteCheckDeps = {
    summary: async () => SUMMARY,
    environment: async () => ENVIRONMENT,
    repositoryServiceData: async () => [],
    // Plan step 11I (D3): changed dep, the one read of the removable volumes (before: one dep per question).
    removableVolumes: async () => volumes(),
    ui,
    ...overrides,
  };
  return { all, ui };
}

describe('review round 1 of 11C2b (mutation tests): deleteCheck', () => {
  it('DC2: a failed read of the registry before the confirmation names the entry of the start', async () => {
    let reads = 0;
    const { all, ui } = deps({ environment: async () => (++reads === 1 ? Promise.reject(new Error('locked')) : ENVIRONMENT) });
    expect(await deleteCheck(all, ENVIRONMENT, 'acme/api', false)).toEqual({ decision: 'delete', additionalVolumesToRemove: [] });
    expect(ui.confirmDelete).toHaveBeenCalledWith('acme/api', expect.objectContaining({ lastSeenInUse: ENVIRONMENT.lastUsedAt }));
  });

  it('DC17: the volumes of the entry as it is after the confirmation are asked about', async () => {
    const later = { ...ENVIRONMENT, additionalVolumes: ['api-cache'] } as Environment;
    let reads = 0;
    // Plan step 11I (D3): changed dep, the one read of the removable volumes.
    const { all, ui } = deps({ environment: async () => (++reads === 1 ? ENVIRONMENT : later), removableVolumes: async () => volumes({ additional: ['api-cache'] }) });
    expect(await deleteCheck(all, ENVIRONMENT, 'acme/api', false)).toEqual({ decision: 'delete', additionalVolumesToRemove: ['api-cache'] });
    expect(ui.deleteAdditionalVolumes).toHaveBeenCalledWith(['api-cache']);
  });

  it('DC24: an entry without additional volumes asks nothing about data of services', async () => {
    // Plan step 11I (D3): changed dep, the one read of the removable volumes (before: removableServiceDataVolumes), which
    // is not asked either.
    const removableVolumes = vi.fn(async () => volumes({ serviceData: ['api-db'] }));
    const { all, ui } = deps({ removableVolumes });
    expect(await deleteCheck(all, ENVIRONMENT, 'acme/api', false)).toEqual({ decision: 'delete', additionalVolumesToRemove: [] });
    expect(ui.deleteServiceData).not.toHaveBeenCalled();
    expect(removableVolumes).not.toHaveBeenCalled();
  });
});

describe('review round 1 of 11C2b (mutation tests): parseDeleteCheckValue', () => {
  it('PR14: a refusal with other keys is invalid', () => {
    expect(parseDeleteCheckValue({ refused: { code: 'otherAccount', message: 'x' } })).toBeDefined();
    expect(parseDeleteCheckValue({ refused: { code: 'otherAccount', message: 'x' }, decision: 'delete' })).toBeUndefined();
  });
});
