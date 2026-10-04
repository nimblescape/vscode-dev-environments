// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11C2b (mutation tests, B-R1) (extensionHostSide: the questions of Delete, recordGitSummary).
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import type { Environment, GitSummary } from '../core/types';
import { extensionHostSide, type HostSideDeps } from './hostSide';

function deps() {
  const environment = { id: 'e1', repository: 'acme/app' } as unknown as Environment;
  const registry = { get: vi.fn(async () => environment), updateEnvironment: vi.fn(async (_id: string, change: (environment: Environment) => void) => change(environment)) };
  const ui = {
    info: vi.fn(),
    warn: vi.fn(),
    registrySignIn: vi.fn(),
    confirmDelete: vi.fn(async () => 'open' as const),
    deleteAdditionalVolumes: vi.fn(async () => undefined),
    deleteServiceData: vi.fn(async () => ['api-db']),
  };
  const all = {
    registry,
    sessionFiles: {},
    ui,
    auth: {},
    credentials: {},
    settings: () => ({}),
    windowId: 'w1',
    pid: 100,
    clock: { now: () => 0 },
    isProcessAlive: () => true,
    logger: silentLogger,
  } as unknown as HostSideDeps;
  return { all, environment, registry, ui };
}

describe('review round 1 of 11C2b (mutation tests): the questions of Delete and the Git state on this computer', () => {
  it('VH1-VH3/VH5/VH6: asks the questions of the user interface with their facts and gives back the answers', async () => {
    const { all, ui } = deps();
    const host = extensionHostSide(all);
    // Adapted (A-R1-M2): the changes are counts.
    const confirmation = { changes: { uncommittedFiles: 1, unpushedCommits: 0 }, repositoryData: ['data/db'], otherWindow: true };
    expect(await host.questions.confirmDelete('Acme/API', confirmation)).toBe('open');
    expect(ui.confirmDelete).toHaveBeenCalledWith('Acme/API', confirmation);
    expect(await host.questions.deleteAdditionalVolumes(['api-cache'])).toBeUndefined();
    expect(ui.deleteAdditionalVolumes).toHaveBeenCalledWith(['api-cache']);
    expect(await host.questions.deleteServiceData(['api-db', 'api-x'], ['api-x'])).toEqual(['api-db']);
    expect(ui.deleteServiceData).toHaveBeenCalledWith(['api-db', 'api-x'], ['api-x']);
  });

  it('VH4: records the Git state in the entry', async () => {
    const { all, environment, registry } = deps();
    const summary = { branch: 'main', uncommittedFiles: 1, unpushedCommits: 0, recordedAt: '2026-10-04T10:00:00.000Z' } as GitSummary;
    await extensionHostSide(all).records.recordGitSummary('e1', summary);
    expect(registry.updateEnvironment).toHaveBeenCalledWith('e1', expect.any(Function));
    expect(environment.gitSummary).toEqual(summary);
  });
});
