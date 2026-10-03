// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (review round 1, missing test 6): the HostSide of this computer, which answers the requests of a flow
// in the worker: where the registry logins come from, how a record changes, and what is refused.
import { describe, expect, it, vi } from 'vitest';
import { IDENTITY_TOKEN_USER } from '../core/imageCheck/credentials';
import { silentLogger } from '../core/ports';
import type { Environment } from '../core/types';
import { OP_TOKEN_REMOVE } from '../core/helperChannel/protocol';
import type { OperationOptions } from '../core/helperChannel/helperChannel';
import { extensionFlow, extensionHostSide, type HostSideDeps } from './hostSide';

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
    removeDisconnectRequest: vi.fn(async () => {}),
  };
  const ui = { info: vi.fn(), warn: vi.fn(), registrySignIn: vi.fn() };
  const auth = { getToken: vi.fn(async () => 'ghp_token'), getPackagesCredentials: vi.fn(async () => ({ username: 'octocat', password: 'gho_packages' })) };
  const credentials = { getForPull: vi.fn(async (_registry: string): Promise<{ username: string; password: string } | undefined> => undefined) };
  const all = {
    registry,
    sessionFiles,
    ui,
    auth,
    credentials,
    settings: () => ({ stopAfterMinutes: 10 }) as unknown as ReturnType<HostSideDeps['settings']>,
    windowId: 'w1',
    isProcessAlive: () => true,
    logger: silentLogger,
    ...overrides,
  } as unknown as HostSideDeps;
  return { all, environment, registry, sessionFiles, ui, auth, credentials };
}

describe('the HostSide of this computer (plan step 11B1)', () => {
  it('takes a registry login from the store of Docker first, an identity token without its user', async () => {
    const { all, credentials, auth } = deps();
    credentials.getForPull.mockResolvedValueOnce({ username: 'stored', password: 'stored-password' });
    const host = extensionHostSide(all);
    expect(await host.secrets.registry('ghcr.io')).toEqual({ username: 'stored', serveraddress: 'ghcr.io', password: 'stored-password' });
    expect(auth.getPackagesCredentials).not.toHaveBeenCalled();
    credentials.getForPull.mockResolvedValueOnce({ username: IDENTITY_TOKEN_USER, password: 'refresh-token' });
    expect(await host.secrets.registry('registry.example')).toEqual({ identityToken: true, serveraddress: 'registry.example', password: 'refresh-token' });
  });

  it('uses the GitHub sign-in only for ghcr.io, never with a dialog, and nothing for other registries', async () => {
    const { all, auth } = deps();
    const host = extensionHostSide(all);
    expect(await host.secrets.registry('GHCR.io')).toEqual({ username: 'octocat', serveraddress: 'ghcr.io', password: 'gho_packages' });
    expect(auth.getPackagesCredentials).toHaveBeenCalledWith({ interactive: false });
    expect(await host.secrets.registry('registry.example')).toBeUndefined();
    auth.getPackagesCredentials.mockRejectedValueOnce(new Error('signed out'));
    expect(await host.secrets.registry('ghcr.io')).toBeUndefined();
    expect(await host.secrets.token()).toBe('ghp_token');
    expect(auth.getToken).toHaveBeenCalledWith({ interactive: false });
  });

  it('changes a record through the registry, and writes the pending file of this window', async () => {
    const { all, environment, registry, sessionFiles } = deps();
    const host = extensionHostSide(all);
    await host.records.update('e1', { lastUsedAt: 'new' });
    expect(registry.updateEnvironment).toHaveBeenCalledWith('e1', expect.any(Function));
    expect(environment.lastUsedAt).toBe('new');
    await host.records.sessionFile('writePending', 'e1');
    expect(sessionFiles.writePending).toHaveBeenCalledWith('e1', 'w1');
    await host.records.sessionFile('removeReopen', 'e1');
    expect(sessionFiles.removeReopen).toHaveBeenCalledWith();
  });

  it('shows each kind of message, and refuses to connect a window without a way to', async () => {
    const { all, ui } = deps();
    const host = extensionHostSide(all);
    await host.questions.message('info', 'i');
    await host.questions.message('warn', 'w');
    await host.questions.message('registrySignIn', 'ghcr.io');
    expect([ui.info.mock.calls, ui.warn.mock.calls, ui.registrySignIn.mock.calls]).toEqual([[['i']], [['w']], [['ghcr.io']]]);
    await expect(host.connect.connect({ environmentId: 'e1', container: 'c1', folder: '/workspaces/app' })).rejects.toThrow('connects no environment');
  });

  it('runs a flow in the worker of the current engine, answering only the requests of its operation (review round 2, B-R2-1, B-R2-2)', async () => {
    const { all, auth } = deps();
    // Review round 3 of plan step 11B1 (B-R3-6): a target that no default could be.
    const target = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' } as const;
    const sent: { target: unknown; op: string; params: unknown; options: OperationOptions }[] = [];
    const channels = {
      flow: vi.fn(async (given: unknown, op: string, params: unknown, options: OperationOptions = {}) => (sent.push({ target: given, op, params, options }), { outcome: 'notRunning' })),
    };
    const warnings: string[] = [];
    const flow = extensionFlow(channels as never, async () => target as never, extensionHostSide(all), { ...silentLogger, warn: (text) => warnings.push(text) });
    const signal = new AbortController().signal;
    expect(await flow(OP_TOKEN_REMOVE, { environmentId: 'e1' }, { signal, timeoutMs: 60_000 })).toEqual({ outcome: 'notRunning' });
    expect(sent[0]).toMatchObject({ target, op: OP_TOKEN_REMOVE, params: { environmentId: 'e1' }, options: { signal, timeoutMs: 60_000 } });
    const onAsk = sent[0].options.onAsk!;
    const open = new AbortController().signal;
    await expect(onAsk('secret', { call: 'token', args: [] }, open)).rejects.toMatchObject({ code: 'invalid' });
    await expect(onAsk('record', { call: 'remove', args: ['e1'] }, open)).rejects.toMatchObject({ code: 'invalid' });
    expect(auth.getToken).not.toHaveBeenCalled();
    // Review round 3 of plan step 11B1 (B-R3-7): a refused request is logged in the log of the window.
    expect(warnings).toEqual([
      'The worker sent the request secret token, which its operation may not send.',
      'The worker sent the request record remove, which its operation may not send.',
    ]);
    expect(await onAsk('record', { call: 'get', args: ['e1'] }, open)).toMatchObject({ value: { id: 'e1' } });
    // An operation without requests, also one named like a member of every object.
    for (const op of ['unknownFlow', 'constructor', 'toString']) {
      await flow(op, {}, {});
      await expect(sent.at(-1)!.options.onAsk!('record', { call: 'get', args: ['e1'] }, open)).rejects.toMatchObject({ code: 'invalid' });
    }
  });
});
