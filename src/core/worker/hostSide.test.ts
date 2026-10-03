// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B: the two sides of what a flow in the worker needs from the user's computer: workerHostSide sends the
// requests, hostSideHandler answers them. Here they are wired to each other, so one test covers both.
import { describe, expect, it, vi } from 'vitest';
import { HelperOperationError } from '../helperChannel/helperChannel';
import { SECRET_REGISTRY, SECRET_TOKEN } from '../helperChannel/protocol';
import { silentLogger, type Logger } from '../ports';
import type { Environment, RegistryFile, WindowStatus } from '../types';
import { parseHostRequest, type HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';
import { workerHostSide } from './workerHostSide';

const ENVIRONMENT = { id: 'e1', repository: 'acme/app' } as unknown as Environment;
const STATUS = { windowId: 'w1', environmentId: 'e1' } as unknown as WindowStatus;

/** A HostSide of this computer that records its calls and answers from `answers`. */
function fakeHost(answers: Partial<Record<string, unknown>> = {}) {
  const calls: { call: string; args: unknown[] }[] = [];
  const of = <T>(call: string, fallback: T): T => (call in answers ? (answers[call] as T) : fallback);
  const record = (call: string, ...args: unknown[]) => calls.push({ call, args });
  const host: HostSide = {
    questions: {
      confirmUntrustedRepository: async (repository) => (record('confirmUntrustedRepository', repository), of('confirmUntrustedRepository', false)),
      configurationChanged: async (repository) => (record('configurationChanged', repository), of('configurationChanged', 'later' as const)),
      configurationKindChanged: async (repository, message) => (record('configurationKindChanged', repository, message), of('configurationKindChanged', 'later' as const)),
      filesMissing: async (repository) => (record('filesMissing', repository), of('filesMissing', undefined)),
      recreateContainer: async (repository, question) => (record('recreateContainer', repository, question), of('recreateContainer', false)),
      message: async (kind, text) => void record('message', kind, text),
    },
    state: {
      windowStatuses: async () => (record('windowStatuses'), of('windowStatuses', [STATUS] as readonly WindowStatus[])),
      pendings: async () => (record('pendings'), of('pendings', [] as readonly { environmentId: string; windowId: string; createdAt: string }[])),
      settings: async () => (record('settings'), of('settings', { stopAfterMinutes: 10 })),
      processAlive: async (pid) => (record('processAlive', pid), of('processAlive', true)),
    },
    records: {
      read: async () => (record('read'), of('read', { version: 1, environments: [] } as RegistryFile)),
      get: async (id) => (record('get', id), of('get', undefined)),
      list: async () => (record('list'), of('list', [] as Environment[])),
      findForAccount: async (repository, accountId, dockerHost) => (record('findForAccount', repository, accountId, dockerHost), of('findForAccount', undefined)),
      add: async (environment) => void record('add', environment),
      update: async (id, changes) => void record('update', id, changes),
      remove: async (id, volumes) => void record('remove', id, volumes),
      forgetKeptVolumes: async (names) => void record('forgetKeptVolumes', names),
      sessionFile: async (kind, environmentId) => void record('sessionFile', kind, environmentId),
    },
    secrets: {
      token: async () => (record('token'), of('token', undefined)),
      registry: async (registry) => (record('registry', registry), of('registry', undefined)),
    },
    connect: {
      connect: async (data) => void record('connect', data),
    },
  };
  return { host, calls };
}

/**
 * The worker's HostSide wired to the handler of the extension: every call goes through one request, and the secrets of an
 * answer are kept as the operation keeps them (plan step 11A).
 */
function wired(answers: Partial<Record<string, unknown>> = {}, logger: Logger = silentLogger) {
  const { host, calls } = fakeHost(answers);
  const handler = hostSideHandler(host, logger);
  const secrets: Record<string, string> = {};
  const signal = new AbortController().signal;
  const requests: { kind: string; call: string; args: unknown[] }[] = [];
  const worker = workerHostSide(
    async (request) => {
      requests.push({ ...request });
      const answer = await handler(request.kind, { call: request.call, args: request.args }, signal);
      Object.assign(secrets, answer.secrets ?? {});
      return answer.value;
    },
    (name) => secrets[name],
  );
  return { worker, host, calls, requests, secrets, handler, signal };
}

describe('the requests of a flow in the worker (plan step 11B)', () => {
  it('asks the questions of the user interface with their kind and gives their answers back', async () => {
    const { worker, calls, requests } = wired({
      confirmUntrustedRepository: true,
      configurationChanged: 'rebuildNow',
      configurationKindChanged: 'rebuildNow',
      filesMissing: 'cloneAgain',
      recreateContainer: true,
    });
    expect(await worker.questions.confirmUntrustedRepository('acme/app')).toBe(true);
    expect(await worker.questions.configurationChanged('acme/app')).toBe('rebuildNow');
    expect(await worker.questions.configurationKindChanged('acme/app', 'the kind changed')).toBe('rebuildNow');
    expect(await worker.questions.filesMissing('acme/app')).toBe('cloneAgain');
    expect(await worker.questions.recreateContainer('acme/app', { message: 'm', detail: 'd' })).toBe(true);
    await worker.questions.message('warn', 'careful');
    expect(requests.every((request) => request.kind === 'question')).toBe(true);
    expect(calls.map((call) => call.call)).toEqual([
      'confirmUntrustedRepository',
      'configurationChanged',
      'configurationKindChanged',
      'filesMissing',
      'recreateContainer',
      'message',
    ]);
    expect(calls.at(-1)).toEqual({ call: 'message', args: ['warn', 'careful'] });
  });

  it('reads the state of this computer and changes its records', async () => {
    const { worker, calls, requests } = wired({ get: ENVIRONMENT, list: [ENVIRONMENT], findForAccount: ENVIRONMENT, processAlive: false });
    expect(await worker.state.windowStatuses()).toEqual([STATUS]);
    expect(await worker.state.settings()).toEqual({ stopAfterMinutes: 10 });
    expect(await worker.state.processAlive(42)).toBe(false);
    expect(await worker.records.get('e1')).toEqual(ENVIRONMENT);
    expect(await worker.records.list()).toEqual([ENVIRONMENT]);
    expect(await worker.records.findForAccount('acme/app', 'a1', '')).toEqual(ENVIRONMENT);
    await worker.records.add(ENVIRONMENT);
    await worker.records.update('e1', { repository: 'acme/app' });
    await worker.records.remove('e1', { kept: ['v1'] });
    await worker.records.forgetKeptVolumes(['v1']);
    await worker.records.sessionFile('removePending', 'e1');
    expect(requests.map((request) => request.kind)).toEqual(['local', 'local', 'local', 'record', 'record', 'record', 'record', 'record', 'record', 'record', 'record']);
    expect(calls.filter((call) => call.call === 'processAlive')).toEqual([{ call: 'processAlive', args: [42] }]);
    expect(calls.at(-1)).toEqual({ call: 'sessionFile', args: ['removePending', 'e1'] });
  });

  it('gets a secret only through the secrets of the answer, never in its value', async () => {
    const { worker, requests, secrets } = wired({
      token: 'ghp_token_value',
      registry: { username: 'octo', serveraddress: 'ghcr.io', password: 'gho_secret' },
    });
    expect(await worker.secrets.token()).toBe('ghp_token_value');
    expect(await worker.secrets.registry('ghcr.io')).toEqual({ username: 'octo', serveraddress: 'ghcr.io', password: 'gho_secret' });
    expect(secrets).toEqual({ [SECRET_TOKEN]: 'ghp_token_value', [SECRET_REGISTRY]: 'gho_secret' });
    expect(JSON.stringify(requests)).not.toContain('gho_secret');
  });

  it('gives undefined when this computer has no secret', async () => {
    const { worker, secrets } = wired();
    expect(await worker.secrets.token()).toBeUndefined();
    expect(await worker.secrets.registry('ghcr.io')).toBeUndefined();
    expect(secrets).toEqual({});
  });

  it('passes an identity token on without a user', async () => {
    const { worker } = wired({ registry: { identityToken: true, serveraddress: 'reg.example', password: 'refresh-token' } });
    expect(await worker.secrets.registry('reg.example')).toEqual({ identityToken: true, serveraddress: 'reg.example', password: 'refresh-token' });
  });

  it('connects the window at the end of an open', async () => {
    const { worker, calls, requests } = wired();
    await worker.connect.connect({ environmentId: 'e1', container: 'c1', user: 'dev', folder: '/workspaces/app' });
    expect(requests.at(-1)).toMatchObject({ kind: 'connect', call: 'connect' });
    expect(calls.at(-1)).toEqual({ call: 'connect', args: [{ environmentId: 'e1', container: 'c1', user: 'dev', folder: '/workspaces/app' }] });
  });
});

describe('the handler of the requests on the side of the extension (plan step 11B)', () => {
  it('refuses a request that it does not know, or whose arguments do not fit', async () => {
    const { handler, signal, calls } = wired();
    for (const [kind, payload] of [
      ['question', { call: 'unknown', args: [] }],
      ['question', { call: 'confirmUntrustedRepository', args: [] }],
      ['question', { call: 'recreateContainer', args: ['acme/app', { message: 'm' }] }],
      ['question', { call: 'message', args: ['shout', 'x'] }],
      ['local', { call: 'processAlive', args: ['42'] }],
      ['local', { call: 'unknown', args: [] }],
      ['record', { call: 'add', args: ['not an object'] }],
      ['record', { call: 'forgetKeptVolumes', args: [[1]] }],
      ['record', { call: 'sessionFile', args: ['writeEverything', 'e1'] }],
      ['secret', { call: 'unknown', args: [] }],
      ['connect', { call: 'connect', args: ['x'] }],
      ['question', { call: 'Bad-Call', args: [] }],
      ['question', { args: [] }],
      ['question', 'not an object'],
    ] as const) {
      const thrown = await handler(kind, payload, signal).catch((error: unknown) => error);
      expect((thrown as HelperOperationError).code, JSON.stringify(payload)).toBe('invalid');
    }
    expect(calls).toEqual([]);
  });

  it('answers `failed` with the message of a call that throws, and logs it', async () => {
    const lines: string[] = [];
    const { host } = fakeHost();
    host.records.get = async () => {
      throw new Error('the registry file is locked');
    };
    const handler = hostSideHandler(host, { ...silentLogger, warn: (text) => lines.push(text) });
    const thrown = await handler('record', { call: 'get', args: ['e1'] }, new AbortController().signal).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(HelperOperationError);
    expect(thrown).toMatchObject({ code: 'failed', message: 'the registry file is locked' });
    expect(lines).toEqual(['The request record get of the worker failed: the registry file is locked']);
  });

  it('answers `cancelled` once the operation ended', async () => {
    const { handler, calls } = wired();
    const controller = new AbortController();
    controller.abort();
    await expect(handler('local', { call: 'settings', args: [] }, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toEqual([]);
  });

  it('parseHostRequest takes a call name and an argument list, nothing else', () => {
    expect(parseHostRequest({ call: 'settings', args: [1, 'x'] }, 'local')).toEqual({ kind: 'local', call: 'settings', args: [1, 'x'] });
    for (const value of [null, 'x', [], { call: 'settings' }, { call: 1, args: [] }, { call: '', args: [] }, { call: 'a'.repeat(65), args: [] }, { call: 'x', args: {} }]) {
      expect(parseHostRequest(value, 'local'), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('a question that the user dismisses comes back as undefined, not as null', async () => {
    const { worker } = wired({ filesMissing: undefined });
    expect(await worker.questions.filesMissing('acme/app')).toBeUndefined();
  });

  it('every request of a flow is one round trip', async () => {
    const ask = vi.fn(async () => ({ given: false }));
    const worker = workerHostSide(ask, () => undefined);
    await worker.secrets.token();
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
