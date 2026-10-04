// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C3 (decisions of 2026-10-03 and 2026-10-04): `reconcile`, the registry rebuilt from the labels of the volumes,
// run by the worker's own pipeline (workerServices) with a small engine in memory; the entries go as `record restore` to
// the HostSide of the extension (extensionHostSide behind its handler), which adds them to a registry on disk.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OP_RECONCILE, parseReconcileValue, type AskKind } from '../core/helperChannel/protocol';
import { LABEL_COMPOSE_SERVICE, LABEL_CONFIG_PATH, LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, LABEL_SERVICE_DATA, LABEL_VOLUME, SERVICE_DATA, resourceName } from '../core/names';
import { silentLogger } from '../core/ports';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import type { DockerEngine, EngineContainer } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { FLOW_REQUESTS } from '../core/worker/hostSide';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import type { OwnHelper } from '../core/worker/ownHelper';
import { extensionHostSide, type HostSideDeps } from '../vscode/hostSide';
import { reconcileOperation } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const OTHER_ID = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';
const NAME = resourceName('acme/api', ID);
const OWN: OwnHelper = { image: { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const OWNER = { windowId: 'window-1', pid: 4242 };
/** The clock of the extension (the worker's clock is another one). */
const NOW = Date.parse('2026-10-04T15:00:00.000Z');

interface Volume {
  name: string;
  labels: Record<string, string>;
}

const workspace = (id = ID, repository = 'acme/api', owner = '42'): Volume => ({
  name: resourceName(repository, id),
  labels: { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [LABEL_OWNER_ID]: owner },
});

let root: string;
let registry: EnvironmentRegistry;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-reconcile-'));
  registry = new EnvironmentRegistry(new StoragePaths(root));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function run(volumes: Volume[], options: { containers?: EngineContainer[]; params?: Record<string, unknown>; running?: boolean } = {}) {
  const asks: { kind: AskKind; call: string }[] = [];
  const deps = {
    registry,
    sessionFiles: {},
    ui: {},
    auth: {},
    credentials: {},
    settings: () => ({}),
    windowId: OWNER.windowId,
    pid: OWNER.pid,
    clock: { now: () => NOW },
    isProcessAlive: () => true,
    logger: silentLogger,
  } as unknown as HostSideDeps;
  const params = { dockerHost: '', owner: OWNER, ...options.params };
  const handler = hostSideHandler(extensionHostSide(deps), silentLogger, FLOW_REQUESTS[OP_RECONCILE], { dockerHost: typeof params.dockerHost === 'string' ? params.dockerHost : undefined });
  const lines: string[] = [];
  const context: OperationContext = {
    signal: new AbortController().signal,
    ...contextSecrets({}, async (kind, payload) => {
      asks.push({ kind, call: (payload as { call: string }).call });
      return (await handler(kind, payload, new AbortController().signal)).value;
    }),
    progress: () => {},
    log: (text) => lines.push(text),
    output: () => {},
    docker: async () => {
      throw new Error('The rebuild of the registry runs no Docker CLI call.');
    },
  };
  const containers = options.containers ?? [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    version: async () => {
      if (options.running === false) throw new Error('connect ENOENT');
      return { apiVersion: '1.48', version: '29.0.0' };
    },
    volumeNames: async () => volumes.map((volume) => volume.name),
    containers: async () => containers,
    inspect: async (kind, reference) => {
      if (kind !== 'volume') return undefined;
      const volume = volumes.find((v) => v.name === reference);
      return volume === undefined ? undefined : { Name: volume.name, Labels: volume.labels };
    },
  };
  const operation = reconcileOperation(
    () => engine,
    async () => OWN,
    async () => {
      throw new Error('The rebuild of the registry opens no batch helper.');
    },
  );
  return { result: operation(params, context), asks, lines };
}

describe('reconcile in the worker (plan step 11C3)', () => {
  it('rebuilds the entries from the labels of the volumes; the extension adds them with its clock', async () => {
    const cache: Volume = { name: 'api-cache', labels: { [LABEL_ENVIRONMENT_ID]: ID, [LABEL_OWNER_ID]: '42', [LABEL_VOLUME]: 'cache' } };
    const db: Volume = { name: 'api-db', labels: { [LABEL_ENVIRONMENT_ID]: ID, [LABEL_OWNER_ID]: '42', [LABEL_VOLUME]: 'db', [LABEL_SERVICE_DATA]: SERVICE_DATA } };
    const devContainer: EngineContainer = {
      id: 'c'.repeat(64),
      name: NAME,
      state: 'stopped',
      rawState: 'exited',
      labels: { [LABEL_ENVIRONMENT_ID]: ID, [LABEL_CONFIG_PATH]: '.devcontainer/web/devcontainer.json' },
      image: `${NAME}:1`,
    };
    const { result, asks } = run([workspace(), cache, db], { containers: [devContainer] });
    expect(parseReconcileValue(await result)).toEqual({ added: 1 });
    // The rebuild sends no other request: it reads nothing of this computer.
    expect(asks).toEqual([{ kind: 'record', call: 'restore' }]);
    const time = new Date(NOW).toISOString();
    expect(await registry.list()).toEqual([
      {
        id: ID,
        repository: 'acme/api',
        configPath: '.devcontainer/web/devcontainer.json',
        volumeName: NAME,
        containerName: NAME,
        createdAt: time,
        lastUsedAt: time,
        owner: { id: '42', login: '' },
        additionalVolumes: ['api-cache', 'api-db'],
        serviceVolumes: ['api-db'],
      },
    ]);
  });

  it('the configuration path of a container of another service does not count (S6-2)', async () => {
    const service: EngineContainer = {
      id: 'd'.repeat(64),
      name: `${NAME}-db-1`,
      state: 'running',
      rawState: 'running',
      labels: { [LABEL_ENVIRONMENT_ID]: ID, [LABEL_COMPOSE_SERVICE]: 'db', [LABEL_CONFIG_PATH]: '.devcontainer/web/devcontainer.json' },
      image: 'postgres:16',
    };
    await run([workspace()], { containers: [service] }).result;
    expect((await registry.get(ID))?.configPath).toBe('.devcontainer/devcontainer.json');
  });

  it('adds only what the registry lacks; one of a repository whose owner has an environment is left out', async () => {
    await registry.restore([{ id: ID, repository: 'acme/api', configPath: '.devcontainer/devcontainer.json', volumeName: NAME, containerName: NAME, createdAt: 't', lastUsedAt: 't', owner: { id: '42', login: 'octo' } }]);
    const second = workspace(OTHER_ID);
    const { result, lines } = run([workspace(), second]);
    expect(await result).toEqual({ added: 0 });
    expect(lines.some((line) => line.includes(`The volume ${second.name} belongs to a repository that has another environment of the same owner`))).toBe(true);
    // The entry that the registry had is unchanged.
    expect((await registry.list()).map((e) => [e.id, e.owner.login])).toEqual([[ID, 'octo']]);
  });

  it('skips a volume whose labels are invalid or whose name is not the one of its environment', async () => {
    const renamed = { ...workspace(OTHER_ID, 'acme/web'), name: 'devenv-acme-web-other' };
    const noOwner = { ...workspace(OTHER_ID, 'acme/web'), labels: { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/web' } };
    expect(await run([renamed, noOwner]).result).toEqual({ added: 0 });
    expect(await registry.exists()).toBe(false);
  });

  it('on a remote Docker host, the entries record it', async () => {
    expect(await run([workspace()], { params: { dockerHost: 'ssh://box' } }).result).toEqual({ added: 1 });
    expect((await registry.get(ID))?.dockerHost).toBe('ssh://box');
  });

  it('a Docker that does not run restores nothing and asks nothing', async () => {
    const { result, asks } = run([workspace()], { running: false });
    expect(await result).toEqual({ added: 0 });
    expect(asks).toEqual([]);
  });

  it('refuses parameters that do not fit before anything runs', async () => {
    for (const odd of [{ dockerHost: 1 }, { dockerHost: 'a\nb' }, { owner: { windowId: 'window-1', pid: 0 } }, { environmentId: ID }]) {
      const { result, asks } = run([workspace()], { params: odd });
      await expect(result, JSON.stringify(odd)).rejects.toMatchObject({ code: 'invalid' });
      expect(asks).toEqual([]);
    }
  });
});
