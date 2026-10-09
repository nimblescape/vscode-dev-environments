// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decisions of 2026-10-03, "Shared VS Code server store" and "The VS Code caches are worker operations"):
// the worker reads the name of its store from the inspect of its own container (the read-write volume at /vscode, as
// channelRunArgs mounts it), and the pipeline of an open gets the store and the server only when it has both.
import { describe, expect, it } from 'vitest';
import { HELPER_DOCKER_SOCKET, VSCODE_STORE_DIR } from '../names';
import { silentLogger, type Logger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import type { HostSide } from './hostSide';
import { ownHelperOf } from './ownHelper';
import { workerServiceDeps, workerVscodeStore, type WorkerServicesDeps } from './workerServices';

const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };
const SOCKET = { Type: 'bind', Source: '/var/run/docker.sock', Destination: HELPER_DOCKER_SOCKET };

function inspect(mounts: unknown[]) {
  return { Image: IMAGE_ID, Config: { Image: 'devenv-helper:abc' }, Mounts: [SOCKET, ...mounts] };
}

describe("the store of the worker's own container (plan step 11H1)", () => {
  it('is the name of the read-write volume at /vscode', () => {
    expect(VSCODE_STORE_DIR).toBe('/vscode');
    expect(ownHelperOf(inspect([{ Type: 'volume', Name: 'devenv-vscode', Destination: '/vscode', RW: true }]))).toEqual({
      image: { tag: 'devenv-helper:abc', id: IMAGE_ID },
      socket: '/var/run/docker.sock',
      vscodeStore: 'devenv-vscode',
    });
    expect(ownHelperOf(inspect([{ Type: 'volume', Name: 'devenv-test-vscode-x', Destination: '/vscode', RW: true }]))?.vscodeStore).toBe('devenv-test-vscode-x');
  });

  it.each([
    ['no such mount (the worker of an older argument list)', []],
    ['a read-only volume', [{ Type: 'volume', Name: 'devenv-vscode', Destination: '/vscode', RW: false }]],
    ['a volume whose RW is not known', [{ Type: 'volume', Name: 'devenv-vscode', Destination: '/vscode' }]],
    ['a bind mount', [{ Type: 'bind', Source: '/srv/vscode', Destination: '/vscode', RW: true }]],
    ['another target', [{ Type: 'volume', Name: 'devenv-vscode', Destination: '/vscode2', RW: true }]],
    ['a volume without a name', [{ Type: 'volume', Name: '', Destination: '/vscode', RW: true }]],
  ])('is none for %s; the rest of the own helper is read as before', (_name, mounts) => {
    const own = ownHelperOf(inspect(mounts));
    expect(own).toEqual({ image: { tag: 'devenv-helper:abc', id: IMAGE_ID }, socket: '/var/run/docker.sock' });
  });
});

describe('the shared VS Code server of the pipeline in the worker (plan step 11H1)', () => {
  function deps(overrides: Partial<WorkerServicesDeps>, log: string[] = []) {
    const logger: Logger = { ...silentLogger, info: (message) => log.push(message) };
    return workerServiceDeps({
      host: { questions: {}, state: {}, records: {}, secrets: {} } as unknown as HostSide,
      engine: unusedEngine(),
      secretOf: () => undefined,
      forgetSecret: () => undefined,
      logger,
      ownHelper: { image: { tag: 'devenv-helper:abc', id: IMAGE_ID }, socket: '/s.sock' },
      dockerHost: '',
      owner: { windowId: 'w', pid: 1 },
      environmentLock: async () => {
        throw new Error('no lock in this test');
      },
      ...overrides,
    });
  }

  it('with the store and a server: the name of the store, and the server with its fetch', () => {
    const all = deps({ ownHelper: { image: { tag: 't', id: IMAGE_ID }, socket: '/s', vscodeStore: 'devenv-vscode' }, vscodeServer: SERVER });
    expect(all.vscodeStoreVolume).toBe('devenv-vscode');
    expect(all.vscodeServer?.server).toEqual(SERVER);
    expect(typeof all.vscodeServer?.fetch).toBe('function');
  });

  it('with the store and no server: only the name of the store (the exemption of the policy, the exclusions)', () => {
    const all = deps({ ownHelper: { image: { tag: 't', id: IMAGE_ID }, socket: '/s', vscodeStore: 'devenv-vscode' } });
    expect(all.vscodeStoreVolume).toBe('devenv-vscode');
    expect(all).not.toHaveProperty('vscodeServer');
  });

  it('without the store: neither, and a line in the log for an open that carries a server', () => {
    const log: string[] = [];
    const all = deps({ vscodeServer: SERVER }, log);
    expect(all).not.toHaveProperty('vscodeStoreVolume');
    expect(all).not.toHaveProperty('vscodeServer');
    expect(log).toEqual(['The worker mounts no shared VS Code server store, so the open runs without it.']);
    expect(deps({})).not.toHaveProperty('vscodeServer');
  });

  it('the fetch of the open asks the architecture of the engine: one without a server fetches nothing (ensureEngineServer)', async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const engine = { ...unusedEngine(), architecture: async () => (asked.push('architecture'), 's390x') };
    const all = deps({ engine, ownHelper: { image: { tag: 't', id: IMAGE_ID }, socket: '/s', vscodeStore: 'devenv-vscode' }, vscodeServer: SERVER }, log);
    expect(await all.vscodeServer!.fetch(new AbortController().signal)).toBeUndefined();
    expect(asked).toEqual(['architecture']);
    expect(log).toEqual([`The VS Code server ${SERVER.commit} (stable) is not fetched into the shared store: the engine's architecture "s390x" has no server there.`]);
  });

  it('the store of the worker: VSCODE_STORE_DIR, the architecture of its engine, its HTTPS', async () => {
    const asked: string[] = [];
    const store = workerVscodeStore({ engine: { ...unusedEngine(), architecture: async () => (asked.push('architecture'), 'aarch64') }, logger: silentLogger });
    expect(store.root).toBe('/vscode');
    expect(await store.architecture(new AbortController().signal)).toBe('aarch64');
    expect(asked).toEqual(['architecture']);
    expect(typeof store.transport.request).toBe('function');
    expect(typeof store.transport.stream).toBe('function');
  });
});
