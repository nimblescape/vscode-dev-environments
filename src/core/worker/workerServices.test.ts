// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3b: the core services as the worker builds them (workerServices), the worker's own helper image
// (ownHelper), and what fails closed until plan steps 11C and 11E bring it.
import { describe, expect, it } from 'vitest';
import { HELPER_DOCKER_SOCKET } from '../names';
import { silentLogger, type Logger } from '../ports';
import type { Environment, RegistryFile, WindowStatus } from '../types';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { ownHelperOf, readOwnHelper } from './ownHelper';
import { hostAuth, hostSessionFiles, hostStore, hostUi, workerServices } from './workerServices';

const IMAGE_ID = `sha256:${'c'.repeat(64)}`;

function inspect(overrides: Record<string, unknown> = {}) {
  return {
    Image: IMAGE_ID,
    Config: { Image: 'devenv-helper:abc' },
    Mounts: [
      { Type: 'volume', Name: 'devenv-monitor', Destination: '/state' },
      { Type: 'bind', Source: '/run/user/1000/docker.sock', Destination: HELPER_DOCKER_SOCKET },
    ],
    ...overrides,
  };
}

/** A HostSide that records its calls; every call answers with `undefined` unless given. */
function fakeHost(answers: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const answer = <T>(call: string, ...args: unknown[]): Promise<T> => {
    calls.push([call, ...args.map((arg) => JSON.stringify(arg))].join(' '));
    if (answers[call] instanceof Error) return Promise.reject(answers[call]);
    return Promise.resolve(answers[call] as T);
  };
  const host: HostSide = {
    questions: {
      confirmUntrustedRepository: (repository) => answer('confirmUntrustedRepository', repository),
      configurationChanged: (repository) => answer('configurationChanged', repository),
      configurationKindChanged: (repository, message) => answer('configurationKindChanged', repository, message),
      filesMissing: (repository) => answer('filesMissing', repository),
      recreateContainer: (repository, question) => answer('recreateContainer', repository, question),
      message: (kind, text) => answer('message', kind, text),
    },
    state: {
      windowStatuses: () => answer<readonly WindowStatus[]>('windowStatuses'),
      pendings: () => answer('pendings').then((value) => (value ?? []) as readonly { environmentId: string; windowId: string; createdAt: string }[]),
      settings: () => answer('settings'),
      processAlive: (pid) => answer('processAlive', pid),
      account: (interactive) => answer('account', interactive),
    },
    records: {
      read: () => answer<RegistryFile>('read'),
      get: (id) => answer<Environment | undefined>('get', id),
      list: () => answer<Environment[]>('list'),
      findForAccount: (repository, accountId, dockerHost) => answer('findForAccount', repository, accountId, dockerHost),
      add: (environment) => answer('add', environment.id),
      update: (id, changes) => answer('update', id, changes),
      remove: (id, volumes) => answer('remove', id, volumes),
      forgetKeptVolumes: (names) => answer('forgetKeptVolumes', names),
      sessionFile: (kind, environmentId) => answer('sessionFile', kind, environmentId),
    },
    secrets: {
      token: () => answer('token'),
      registry: (registry) => answer('registry', registry),
    },
    connect: { connect: (data) => answer('connect', data) },
  };
  return { host, calls };
}

describe("the worker's own helper image (plan step 11B3b)", () => {
  it('reads the image ID, its reference, and the source of the socket mount of the worker', async () => {
    expect(ownHelperOf(inspect())).toEqual({ image: { tag: 'devenv-helper:abc', id: IMAGE_ID }, socket: '/run/user/1000/docker.sock' });
    for (const odd of [
      inspect({ Image: 'devenv-helper:abc' }),
      inspect({ Config: {} }),
      inspect({ Mounts: [{ Type: 'volume', Source: 'x', Destination: HELPER_DOCKER_SOCKET }] }),
      inspect({ Mounts: [{ Type: 'bind', Source: '', Destination: HELPER_DOCKER_SOCKET }] }),
      inspect({ Mounts: undefined }),
      null,
      'text',
    ]) {
      expect(ownHelperOf(odd)).toBeUndefined();
    }
    const asked: string[] = [];
    const engine = { ...unusedEngine(), inspect: async (kind: string, reference: string) => (asked.push(`${kind} ${reference}`), reference === 'abc123' ? inspect() : undefined) };
    expect((await readOwnHelper(engine, 'abc123')).socket).toBe('/run/user/1000/docker.sock');
    expect(asked).toEqual(['container abc123']);
    await expect(readOwnHelper(engine, 'gone')).rejects.toThrow('is not known to the engine');
    await expect(readOwnHelper({ ...unusedEngine(), inspect: async () => inspect({ Mounts: [] }) }, 'abc123')).rejects.toThrow('cannot be read');
  });
});

describe('the core services in the worker (plan step 11B3b)', () => {
  it('the registry goes through the record requests; a write by a function fails closed until plan step 11C', async () => {
    const { host, calls } = fakeHost({ get: { id: 'e1' } });
    const store = hostStore(host.records);
    expect(await store.get('e1')).toEqual({ id: 'e1' });
    await store.findForAccount('acme/api', '42');
    await store.remove('e1');
    expect(calls).toEqual(['get "e1"', 'findForAccount "acme/api" "42" ""', 'remove "e1" {}']);
    await expect(store.updateEnvironment('e1', () => {})).rejects.toThrow('before plan step 11C');
    await expect(store.update(() => {})).rejects.toThrow('before plan step 11C');
    expect(calls).toHaveLength(3);
  });

  it('the session files and the reads of the window go to the extension; the reopen record fails closed', async () => {
    const { host, calls } = fakeHost({ pendings: [{ environmentId: 'e1', windowId: 'w', createdAt: 't' }] });
    const files = hostSessionFiles(host);
    await files.writePending('e1', 'ignored-window');
    await files.removeDisconnectRequest('e1');
    expect(await files.readPendings()).toEqual([{ environmentId: 'e1', windowId: 'w', createdAt: 't' }]);
    expect(calls).toEqual(['sessionFile "writePending" "e1"', 'sessionFile "removeDisconnectRequest" "e1"', 'pendings']);
    await expect(files.readReopen()).rejects.toThrow('before plan step 11E');
  });

  it('the account and the token of the sign-in come from the extension; a dialog for the token and a rejected token stay here', async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (text) => warnings.push(text) };
    const { host, calls } = fakeHost({ account: { id: '42', login: 'octo' }, token: 'ghp_x' });
    const auth = hostAuth(host, logger);
    expect(await auth.getAccount({ interactive: true })).toEqual({ id: '42', login: 'octo' });
    expect(await auth.getToken({ interactive: false })).toBe('ghp_x');
    await expect(auth.getToken({ interactive: true })).rejects.toThrow('before plan step 11E');
    auth.reportRejectedToken?.('ghp_x');
    expect(calls).toEqual(['account true', 'token']);
    expect(warnings).toEqual(['GitHub rejected the token of the operation.']);
    expect(warnings.join()).not.toContain('ghp_x');
  });

  it('the questions go to the extension; a message that cannot be shown is logged, never thrown', async () => {
    const warnings: string[] = [];
    const { host, calls } = fakeHost({ filesMissing: 'cloneAgain', message: new Error('the window is gone') });
    const ui = hostUi(host.questions, { ...silentLogger, warn: (text) => warnings.push(text) });
    expect(await ui.filesMissing('acme/api')).toBe('cloneAgain');
    ui.warn('careful');
    ui.registrySignIn('ghcr.io');
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(['filesMissing "acme/api"', 'message "warn" "careful"', 'message "registrySignIn" "ghcr.io"']);
    expect(warnings).toEqual(['A message for the user could not be shown: the window is gone', 'A message for the user could not be shown: the window is gone']);
  });

  it("the helper runs from the worker's own image, builds nothing, and the open-only parts fail closed", async () => {
    const { host } = fakeHost();
    const { helper } = workerServices({
      host,
      engine: unusedEngine(),
      secretOf: () => undefined,
      logger: silentLogger,
      ownHelper: { image: { tag: 'devenv-helper:abc', id: IMAGE_ID }, socket: '/s.sock' },
      dockerHost: 'build-box',
      owner: { windowId: 'w', pid: 1 },
      environmentLock: async () => {
        throw new Error('no lock in this test');
      },
    });
    expect(await helper.ensureImagePresent()).toEqual({ tag: 'devenv-helper:abc', id: IMAGE_ID });
    expect(await helper.ensureImageUse()).toEqual({ tag: 'devenv-helper:abc', id: IMAGE_ID });
    expect(await helper.presentImage()).toEqual({ tag: 'devenv-helper:abc', id: IMAGE_ID });
    const controller = new AbortController();
    controller.abort();
    await expect(helper.ensureImagePresent({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
