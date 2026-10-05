// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E4d: the facts of the window that the worker's pipeline asks the extension for: whether a process of the
// computer runs (`local processAlive`), the GitHub profile of the signed-in account (`local viewer`, read with the
// extension's token), and the window's memory of the containers whose lifecycle mark could not be recorded (`local
// unrecordedLifecycle`, `record rememberLifecycle`, `record forgetLifecycle`, each only for the environment of the
// operation). No operation sends them before plan step 11E6.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/ports';
import type { GitHubViewer } from '../core/helper/containerGit';
import { windowLifecycleMemory } from '../core/pipeline/lifecycleMemory';
import { extensionHostSide, type HostSideDeps } from './hostSide';
import { FLOW_REQUESTS, SCOPED_REQUESTS, type HostCall, type HostSide } from '../core/worker/hostSide';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import { parseViewerAnswer, workerHostSide } from '../core/worker/workerHostSide';
import { hostLifecycleMemory, workerServiceDeps } from '../core/worker/workerServices';

/** The deps of the worker's pipeline over `host` (workerServiceDeps), with nothing else that these tests use. */
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

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const OTHER = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const CONTAINER = 'a'.repeat(64);
const CALLS: readonly HostCall[] = ['local viewer', 'local unrecordedLifecycle', 'record rememberLifecycle', 'record forgetLifecycle', 'local processAlive'];

/** The extension's HostSide of a window with `viewer` and its memory, as src/vscode/extension.ts wires it. */
function extension(overrides: Partial<HostSideDeps> = {}, account: { id: string; login: string } | null = { id: '42', login: 'octo' }) {
  const lifecycleMemory = windowLifecycleMemory();
  const viewer = vi.fn(async (_token: string, _signal?: AbortSignal): Promise<GitHubViewer> => ({ databaseId: 42, login: 'octo', name: 'Octo Cat' }));
  const infos: string[] = [];
  const deps = {
    registry: {},
    sessionFiles: { readWindowStatuses: async () => [] },
    ui: {},
    auth: { getAccount: async () => account ?? undefined, getToken: async () => (account ? 'gho_window' : undefined) },
    credentials: {},
    settings: () => ({}),
    windowId: 'w1',
    pid: 100,
    clock: { now: () => 0 },
    isProcessAlive: (pid: number) => pid === 100,
    viewer,
    lifecycleMemory,
    logger: { ...silentLogger, info: (text: string) => infos.push(text) },
    ...overrides,
  } as unknown as HostSideDeps;
  return { host: extensionHostSide(deps), viewer, lifecycleMemory, infos };
}

function handlerOf(host: HostSide, environmentId: string | null = ID) {
  const signal = new AbortController().signal;
  const handler = hostSideHandler(host, silentLogger, CALLS, { ...(environmentId === null ? {} : { environmentId }), dockerHost: 'ssh://box', repository: 'acme/api' });
  return (kind: 'local' | 'record', call: string, ...args: unknown[]) => handler(kind, { call, args }, signal).then((answer) => answer.value);
}

describe('the facts of the window as requests (plan step 11E4d)', () => {
  it('no operation may send them before plan step 11E6; the memory only for the environment of the operation', () => {
    for (const allowed of Object.values(FLOW_REQUESTS)) {
      expect(allowed.filter((call) => /^(local viewer|local unrecordedLifecycle|record rememberLifecycle|record forgetLifecycle)$/.test(call))).toEqual([]);
    }
    expect(SCOPED_REQUESTS).toMatchObject({ 'local unrecordedLifecycle': 0, 'record rememberLifecycle': 0, 'record forgetLifecycle': 0 });
    expect(SCOPED_REQUESTS).not.toHaveProperty(['local viewer']);
  });

  describe('local viewer', () => {
    it("the profile of the signed-in account, read with the window's own token within 5 seconds", async () => {
      const { host, viewer } = extension();
      expect(await handlerOf(host)('local', 'viewer')).toEqual({ databaseId: 42, login: 'octo', name: 'Octo Cat' });
      expect(viewer).toHaveBeenCalledWith('gho_window', expect.any(AbortSignal));
      await expect(handlerOf(host)('local', 'viewer', 'gho_worker')).rejects.toMatchObject({ code: 'invalid' });
    });

    it('none: without the viewer, without a sign-in, for a profile of another account, or when GitHub fails (logged)', async () => {
      expect(await handlerOf(extension({ viewer: undefined }).host)('local', 'viewer')).toBeNull();
      expect(await handlerOf(extension({}, null).host)('local', 'viewer')).toBeNull();
      const other = extension();
      other.viewer.mockResolvedValue({ databaseId: 7, login: 'mallory', name: null });
      expect(await handlerOf(other.host)('local', 'viewer')).toBeNull();
      const failing = extension();
      failing.viewer.mockRejectedValue(new Error('offline'));
      expect(await handlerOf(failing.host)('local', 'viewer')).toBeNull();
      expect(failing.infos.join('\n')).toContain('offline');
    });

    it('the worker takes only a profile: a database ID, a login, a name of at most 255 characters or none', () => {
      expect(parseViewerAnswer(null)).toBeUndefined();
      expect(parseViewerAnswer({ databaseId: 42, login: 'octo', name: 'Octo' })).toEqual({ databaseId: 42, login: 'octo', name: 'Octo' });
      expect(parseViewerAnswer({ databaseId: '42', login: 'octo' })).toEqual({ databaseId: '42', login: 'octo', name: null });
      for (const odd of [
        'octo',
        [],
        { databaseId: 0, login: 'octo' },
        { databaseId: 1.5, login: 'octo' },
        { databaseId: '042', login: 'octo' },
        { databaseId: 'x', login: 'octo' },
        { databaseId: 42, login: 'octo cat' },
        { databaseId: 42, login: '' },
        { databaseId: 42, login: 'octo', name: 'x'.repeat(256) },
        { databaseId: 42, login: 'octo', name: 7 },
      ]) {
        expect(() => parseViewerAnswer(odd), JSON.stringify(odd)).toThrow('invalid');
      }
    });

    it("the worker's pipeline gets the profile, or an error when there is none (identityOf then uses the session's account)", async () => {
      const answers: Record<string, unknown> = { 'local viewer': { databaseId: 42, login: 'octo', name: null } };
      const host = workerHostSide(async (request) => answers[`${request.kind} ${request.call}`] ?? null, () => undefined);
      const deps = pipelineDeps(host);
      expect(await deps.viewer!('ignored')).toEqual({ databaseId: 42, login: 'octo', name: null });
      answers['local viewer'] = null;
      await expect(deps.viewer!('ignored')).rejects.toThrow('could not read the GitHub profile');
    });
  });

  describe("the window's lifecycle memory", () => {
    it('read, remembered and forgotten for the environment of the operation only', async () => {
      const { host, lifecycleMemory } = extension();
      const ask = handlerOf(host);
      expect(await ask('local', 'unrecordedLifecycle', ID)).toBeNull();
      expect(await ask('record', 'rememberLifecycle', ID, CONTAINER)).toBeNull();
      expect(await lifecycleMemory.get(ID)).toBe(CONTAINER);
      expect(await ask('local', 'unrecordedLifecycle', ID)).toBe(CONTAINER);
      // Another container of the environment is not forgotten; this one is.
      await ask('record', 'forgetLifecycle', ID, 'b'.repeat(64));
      expect(await lifecycleMemory.get(ID)).toBe(CONTAINER);
      await ask('record', 'forgetLifecycle', ID, CONTAINER);
      expect(await lifecycleMemory.get(ID)).toBeUndefined();
      for (const [kind, call, ...args] of [
        ['local', 'unrecordedLifecycle', OTHER],
        ['record', 'rememberLifecycle', OTHER, CONTAINER],
        ['record', 'forgetLifecycle', OTHER, CONTAINER],
      ] as const) {
        await expect(ask(kind, call, ...args), call).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another environment') });
      }
      expect(await lifecycleMemory.get(OTHER)).toBeUndefined();
      // An operation without an environment has none.
      await expect(handlerOf(host, null)('record', 'rememberLifecycle', ID, CONTAINER)).rejects.toMatchObject({ code: 'invalid' });
    });

    it('only a container ID of 12 to 64 hexadecimal digits, and nothing beyond it; nothing is remembered', async () => {
      const { host, lifecycleMemory } = extension();
      const ask = handlerOf(host);
      for (const id of ['', 'abc', 'a'.repeat(11), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}\n`, 'g'.repeat(12), 7, null]) {
        await expect(ask('record', 'rememberLifecycle', ID, id), JSON.stringify(id)).rejects.toMatchObject({ code: 'invalid' });
      }
      await expect(ask('record', 'rememberLifecycle', ID, CONTAINER, 'more')).rejects.toMatchObject({ code: 'invalid' });
      await expect(ask('local', 'unrecordedLifecycle', ID, 'more')).rejects.toMatchObject({ code: 'invalid' });
      expect(await lifecycleMemory.get(ID)).toBeUndefined();
      expect(await ask('record', 'rememberLifecycle', ID, 'c'.repeat(12))).toBeNull();
      expect(await lifecycleMemory.get(ID)).toBe('c'.repeat(12));
    });

    it("the worker's memory sends the requests, and takes only a container ID as the answer", async () => {
      const sent: unknown[][] = [];
      let answer: unknown = CONTAINER;
      const host = workerHostSide(async (request) => (sent.push([request.kind, request.call, ...request.args]), answer), () => undefined);
      const memory = hostLifecycleMemory(host);
      expect(await memory.get(ID)).toBe(CONTAINER);
      await memory.remember(ID, CONTAINER);
      await memory.forget(ID, CONTAINER);
      expect(sent).toEqual([
        ['local', 'unrecordedLifecycle', ID],
        ['record', 'rememberLifecycle', ID, CONTAINER],
        ['record', 'forgetLifecycle', ID, CONTAINER],
      ]);
      answer = null;
      expect(await memory.get(ID)).toBeUndefined();
      for (const odd of ['xyz', 7, { id: CONTAINER }, 'A'.repeat(64)]) {
        answer = odd;
        await expect(memory.get(ID), JSON.stringify(odd)).rejects.toThrow('invalid');
      }
    });
  });

  it("whether a process runs: the extension's answer, asked by the worker's pipeline (never synchronously)", async () => {
    const { host } = extension();
    const ask = handlerOf(host);
    expect(await ask('local', 'processAlive', 100)).toBe(true);
    expect(await ask('local', 'processAlive', 200)).toBe(false);
    const worker = workerHostSide(async (request) => (request.args[0] === 100 ? true : false), () => undefined);
    const deps = pipelineDeps(worker);
    expect(await deps.processAlive!(100)).toBe(true);
    expect(await deps.processAlive!(200)).toBe(false);
    expect(() => deps.isProcessAlive!(100)).toThrow('synchronously');
  });
});
