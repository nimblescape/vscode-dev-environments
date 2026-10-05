// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #107 (plan step 11E4d), reviewer B: the probes of the mutation testing of the requests for the
// facts of the window (`local viewer`, `local unrecordedLifecycle`, `record rememberLifecycle`, `record forgetLifecycle`)
// on both sides, and of the deps of the worker's pipeline over them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import type { GitHubViewer } from '../core/helper/containerGit';
import { windowLifecycleMemory } from '../core/pipeline/lifecycleMemory';
import { extensionHostSide, type HostSideDeps } from './hostSide';
import type { HostCall, HostSide } from '../core/worker/hostSide';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import { parseViewerAnswer, workerHostSide } from '../core/worker/workerHostSide';
import { workerServiceDeps } from '../core/worker/workerServices';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const CONTAINER = 'a'.repeat(64);
const CALLS: readonly HostCall[] = ['local viewer', 'local unrecordedLifecycle', 'record rememberLifecycle', 'record forgetLifecycle'];

afterEach(() => {
  vi.restoreAllMocks();
});

function pipelineDeps(host: HostSide) {
  return workerServiceDeps({
    host,
    engine: {} as never,
    secretOf: () => undefined,
    logger: silentLogger,
    ownHelper: { image: { tag: 'devenv-helper:abc', id: `sha256:${'e'.repeat(64)}` }, socket: '/s.sock' },
    dockerHost: '',
    owner: { windowId: 'w1', pid: 100 },
    environmentLock: async () => {
      throw new Error('no lock in this test');
    },
  });
}

/** The extension's HostSide; `account` and `token` are what the sign-in of the window gives. */
function extension(options: { account?: { id: string; login: string }; token?: string; viewer?: HostSideDeps['viewer'] | null } = {}) {
  const lifecycleMemory = windowLifecycleMemory();
  const viewer = vi.fn(async (_token: string, _signal?: AbortSignal): Promise<GitHubViewer> => ({ databaseId: 42, login: 'octo', name: 'Octo Cat' }));
  const infos: string[] = [];
  const getAccount = vi.fn(async (_options: { interactive: boolean }) => ('account' in options ? options.account : { id: '42', login: 'octo' }));
  const getToken = vi.fn(async (_options: { interactive: boolean }) => ('token' in options ? options.token : 'gho_window'));
  const deps = {
    registry: {},
    sessionFiles: { readWindowStatuses: async () => [] },
    ui: {},
    auth: { getAccount, getToken },
    credentials: {},
    settings: () => ({}),
    windowId: 'w1',
    pid: 100,
    clock: { now: () => 0 },
    isProcessAlive: (pid: number) => pid === 100,
    viewer: options.viewer === null ? undefined : (options.viewer ?? viewer),
    lifecycleMemory,
    logger: { ...silentLogger, info: (text: string) => infos.push(text) },
  } as unknown as HostSideDeps;
  return { host: extensionHostSide(deps), viewer, lifecycleMemory, infos, getAccount, getToken };
}

function handlerOf(host: HostSide) {
  const signal = new AbortController().signal;
  const handler = hostSideHandler(host, silentLogger, CALLS, { environmentId: ID, dockerHost: 'ssh://box', repository: 'acme/api' });
  return (kind: 'local' | 'record', call: string, ...args: unknown[]) => handler(kind, { call, args }, signal).then((answer) => answer.value);
}

describe('review round 1 of PR #107 (B): local viewer on the side of the extension', () => {
  it('the answer has exactly the three fields, the name null when GitHub gives none', async () => {
    const { host, viewer } = extension();
    viewer.mockResolvedValue({ databaseId: 42, login: 'octo', email: 'octo@example.com' } as GitHubViewer);
    expect(await handlerOf(host)('local', 'viewer')).toStrictEqual({ databaseId: 42, login: 'octo', name: null });
  });

  it('without the viewer, the sign-in is not asked and nothing is logged', async () => {
    const window = extension({ viewer: null });
    expect(await handlerOf(window.host)('local', 'viewer')).toBeNull();
    expect(window.getAccount).not.toHaveBeenCalled();
    expect(window.getToken).not.toHaveBeenCalled();
    expect(window.infos).toEqual([]);
  });

  it('without an account, or without a token, GitHub is never asked', async () => {
    for (const options of [{ account: undefined }, { token: undefined }]) {
      const window = extension(options);
      expect(await handlerOf(window.host)('local', 'viewer')).toBeNull();
      expect(window.viewer).not.toHaveBeenCalled();
      expect(window.infos).toEqual([]);
    }
  });

  it('the account and the token are asked without asking the user to sign in', async () => {
    const window = extension();
    await handlerOf(window.host)('local', 'viewer');
    expect(window.getAccount.mock.calls).toEqual([[{ interactive: false }]]);
    expect(window.getToken.mock.calls).toEqual([[{ interactive: false }]]);
  });

  it('the question to GitHub has a time limit of 5 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const window = extension();
    await handlerOf(window.host)('local', 'viewer');
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(window.viewer.mock.calls[0][1]).toBe(timeout.mock.results[0].value);
  });

  it('a profile of another account by its database ID is none, also with the same login', async () => {
    const window = extension();
    window.viewer.mockResolvedValue({ databaseId: 7, login: 'octo', name: null });
    expect(await handlerOf(window.host)('local', 'viewer')).toBeNull();
  });
});

describe('review round 1 of PR #107 (B): the worker takes only a profile', () => {
  it('the database ID as a string: at most 20 digits, nothing after them', () => {
    expect(parseViewerAnswer({ databaseId: '9'.repeat(20), login: 'octo' })).toEqual({ databaseId: '9'.repeat(20), login: 'octo', name: null });
    for (const databaseId of ['1'.repeat(21), '42x', '42\n']) {
      expect(() => parseViewerAnswer({ databaseId, login: 'octo' }), databaseId).toThrow('invalid');
    }
  });

  it('a login that is not a string is refused, also one whose text would be a login', () => {
    for (const login of [7, ['octo'], null]) {
      expect(() => parseViewerAnswer({ databaseId: 42, login }), JSON.stringify(login)).toThrow('invalid');
    }
  });

  it('a name of exactly 255 characters is taken', () => {
    expect(parseViewerAnswer({ databaseId: 42, login: 'octo', name: 'x'.repeat(255) })).toEqual({ databaseId: 42, login: 'octo', name: 'x'.repeat(255) });
  });

  it("the worker's HostSide parses the answer of `local viewer`", async () => {
    let answer: unknown = { databaseId: 42, login: 'octo', name: 'Octo', token: 'gho_x' };
    const host = workerHostSide(async () => answer, () => undefined);
    expect(await host.state.viewer()).toStrictEqual({ databaseId: 42, login: 'octo', name: 'Octo' });
    for (const odd of [{ databaseId: 0, login: 'octo' }, { login: 'octo' }, 'octo', 7]) {
      answer = odd;
      await expect(host.state.viewer(), JSON.stringify(odd)).rejects.toThrow('invalid');
    }
  });
});

describe('review round 1 of PR #107 (B): the lifecycle memory as requests', () => {
  it('the container ID of remember and forget is a string, never a list or another value whose text would pass', async () => {
    const { host, lifecycleMemory } = extension();
    const ask = handlerOf(host);
    for (const call of ['rememberLifecycle', 'forgetLifecycle']) {
      for (const odd of [[CONTAINER], { toString: () => CONTAINER }]) {
        await expect(ask('record', call, ID, odd), `${call} ${JSON.stringify(odd)}`).rejects.toMatchObject({ code: 'invalid' });
      }
    }
    expect(await lifecycleMemory.get(ID)).toBeUndefined();
  });

  it("the worker takes only a container ID of 12 to 64 hexadecimal digits as the remembered one", async () => {
    let answer: unknown = 'c'.repeat(12);
    const host = workerHostSide(async () => answer, () => undefined);
    expect(await host.state.unrecordedLifecycle(ID)).toBe('c'.repeat(12));
    for (const odd of ['abc', 'a'.repeat(11), 'a'.repeat(65), `${CONTAINER}x`, `x${CONTAINER}`, `${CONTAINER}\n`]) {
      answer = odd;
      await expect(host.state.unrecordedLifecycle(ID), JSON.stringify(odd)).rejects.toThrow('invalid');
    }
  });

  it("the worker's pipeline uses the window's memory through the requests (never one of its own)", async () => {
    const sent: unknown[][] = [];
    const host = workerHostSide(async (request) => (sent.push([request.kind, request.call, ...request.args]), request.call === 'unrecordedLifecycle' ? CONTAINER : null), () => undefined);
    const deps = pipelineDeps(host);
    expect(deps.lifecycleMemory).toBeDefined();
    expect(await deps.lifecycleMemory!.get(ID)).toBe(CONTAINER);
    await deps.lifecycleMemory!.remember(ID, CONTAINER);
    await deps.lifecycleMemory!.forget(ID, CONTAINER);
    expect(sent).toEqual([
      ['local', 'unrecordedLifecycle', ID],
      ['record', 'rememberLifecycle', ID, CONTAINER],
      ['record', 'forgetLifecycle', ID, CONTAINER],
    ]);
  });
});
