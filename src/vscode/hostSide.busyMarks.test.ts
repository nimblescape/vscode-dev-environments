// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11C2a (mutation tests, B-R1): the view of the windows (process, status files) of the busy marks that this computer sets for a flow.

// Plan step 11B1 (review round 1, missing test 6): the HostSide of this computer, which answers the requests of a flow
// in the worker: where the registry logins come from, how a record changes, and what is refused.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import type { Environment } from '../core/types';
import { extensionHostSide, type HostSideDeps } from './hostSide';

function deps(overrides: Partial<HostSideDeps> = {}) {
  const environment = { id: 'e1', repository: 'acme/app', lastUsedAt: 'old' } as unknown as Environment;
  const registry = {
    read: vi.fn(),
    get: vi.fn(async () => environment),
    list: vi.fn(async () => [environment]),
    findForAccount: vi.fn(),
    add: vi.fn(async () => {}),
    updateEnvironment: vi.fn(async (_id: string, change: (environment: Environment) => void) => change(environment)),
    remove: vi.fn(async () => {}),
    forgetKeptVolumes: vi.fn(async () => {}),
  };
  const sessionFiles = {
    readWindowStatuses: vi.fn(async () => []),
    readPendings: vi.fn(async () => []),
    writePending: vi.fn(async () => {}),
    removePending: vi.fn(async () => {}),
    removeOperation: vi.fn(async () => {}),
    removeReopen: vi.fn(async () => {}),
    removeReopenOf: vi.fn(async (_id: string) => {}),
    removeDisconnectRequest: vi.fn(async () => {}),
  };
  const ui = { info: vi.fn(), warn: vi.fn(), registrySignIn: vi.fn() };
  const auth = {
    getToken: vi.fn(async () => 'ghp_token'),
    getPackagesCredentials: vi.fn(async () => ({ username: 'octocat', password: 'gho_packages' })),
    getAccount: vi.fn(async (_options: { interactive: boolean }): Promise<{ id: string; login: string } | undefined> => ({ id: '42', login: 'octo' })),
  };
  const credentials = { getForPull: vi.fn(async (_registry: string): Promise<{ username: string; password: string } | undefined> => undefined) };
  const all = {
    registry,
    sessionFiles,
    ui,
    auth,
    credentials,
    windowId: 'w1',
    // Plan step 11C2a: the busy marks of a flow.
    pid: 100,
    clock: { now: () => Date.parse('2026-10-04T12:00:00.000Z') },
    isProcessAlive: () => true,
    logger: silentLogger,
    ...overrides,
  } as unknown as HostSideDeps;
  return { all, environment, registry, sessionFiles, ui, auth, credentials };
}


// Plan step 11C2a (decision of 2026-10-04): the busy marks of a flow are this window's, set by this computer with its
// clock and its view of the windows; the reopen record goes only with its environment.

describe('the view of the windows of the busy marks of a flow (review round 1 of 11C2a, B-R1 X2, X3)', () => {
  const other = { operation: 'update' as const, since: '2026-10-04T11:59:00.000Z', pid: 200, windowId: 'w2' };
  function withMark(overrides: Record<string, unknown>) {
    const base = deps();
    const environment = base.environment;
    environment.busy = { ...other };
    const registry = { ...base.registry, updateEnvironment: vi.fn(async (_id: string, change: (e: Environment) => void) => (change(environment), environment)) };
    return { host: extensionHostSide(deps({ registry, ...overrides } as never).all), environment };
  }
  it('a mark of a window without a recent status file is taken over (X3)', async () => {
    const { host } = withMark({});
    expect(await host.records.markBusy('e1', 'delete')).toEqual({ environment: expect.objectContaining({ busy: expect.objectContaining({ pid: 100, windowId: 'w1' }) }) });
  });
  it('a mark of an ended process is taken over even with a recent status file (X2)', async () => {
    const base = deps();
    const { host } = withMark({
      isProcessAlive: (pid: number) => pid !== 200,
      sessionFiles: { ...base.sessionFiles, readWindowStatuses: vi.fn(async () => [{ windowId: 'w2', pid: 200, updatedAt: '2026-10-04T11:59:50.000Z' }]) },
    });
    expect(await host.records.markBusy('e1', 'delete')).toEqual({ environment: expect.objectContaining({ busy: expect.objectContaining({ pid: 100 }) }) });
  });
});
