// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E4c (decision of 2026-10-04, one operations interface in both directions): the entry of a first open, its
// removal, the configuration and the build records as the worker sends them (`record createEnvironment`, `record
// dropCreated`, `record configuration`, `record build`), as the extension checks them (hostSideHandler) and applies them
// under its registry lock (requestOpenRecords), with its owner, clock and account; the binding of a first open to the
// environment that it created; and the removal of the generic `record update` and the loose `record add`. No operation
// sends them before plan step 11E6, so the handler runs here with an explicit allowance.
import { describe, expect, it } from 'vitest';
import { OP_DELETE } from '../helperChannel/protocol';
import { composeProjectName, environmentImageName, resourceName } from '../names';
import { registryBusyMarks, type BusyMarkView } from '../pipeline/busyMarks';
import type { BuildChange, ConfigurationChange } from '../pipeline/openRecords';
import { silentLogger, type Logger } from '../ports';
import type { EnvironmentRegistry } from '../storage/registry';
import type { BuildRecord, BusyMark, Environment, GitHubAccount, KeptVolume, RefusedUpdate, RegistryFile } from '../types';
import { DETAILED_REQUESTS, FLOW_REQUESTS, SCOPED_REQUESTS, type HostCall, type HostSide } from './hostSide';
import { hostSideHandler } from './hostSideHandler';
import { MAX_BUILD_NUMBER, requestOpenRecords, type OpenRequestScope } from './openRequests';
import { workerHostSide } from './workerHostSide';
import { hostOpenRecords } from './workerServices';

/** The environment of an operation of an existing environment. */
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
/** The ID that the worker picks for a first open. */
const NEW = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';
const OTHER = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const REPOSITORY = 'acme/api';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const HOST = 'ssh://box';
const OWNER = { windowId: 'w1', pid: 100 };
/** The account signed in in the extension. */
const ACCOUNT: GitHubAccount = { id: '42', login: 'octo' };
const DEFAULT = '.devcontainer/devcontainer.json';
const DIGEST = `sha256:${'d'.repeat(64)}`;
const IMAGE_ID = `sha256:${'e'.repeat(64)}`;
const CREATE = { id: NEW, repository: REPOSITORY, configPath: DEFAULT };
const ALLOWED: readonly HostCall[] = ['record markBusy', 'record createEnvironment', 'record dropCreated', 'record configuration', 'record build', 'record ownerLogin'];

const ownCreate = (fields: Partial<BusyMark> = {}): BusyMark => ({ operation: 'create', since: new Date(NOW).toISOString(), pid: OWNER.pid, windowId: OWNER.windowId, ...fields });
const name = (id: string) => resourceName(REPOSITORY, id);
const entryOf = (id: string, fields: Partial<Environment> = {}): Environment =>
  ({
    id,
    repository: REPOSITORY,
    configPath: DEFAULT,
    volumeName: name(id),
    containerName: name(id),
    createdAt: '2020-01-01T00:00:00.000Z',
    lastUsedAt: '2020-01-01T00:00:00.000Z',
    owner: { id: ACCOUNT.id, login: 'old' },
    dockerHost: HOST,
    ...fields,
  }) as Environment;

/** A build record of the environment `id` for its build `buildNumber`, as the pipeline records it. */
function buildRecord(id: string, buildNumber: number, fields: Partial<BuildRecord> = {}): BuildRecord {
  return {
    builtAt: '2026-10-05T11:00:00.000Z',
    environmentImage: environmentImageName(REPOSITORY, id, buildNumber),
    imageId: IMAGE_ID,
    buildNumber,
    configPath: DEFAULT,
    configHash: DIGEST,
    images: { 'mcr.microsoft.com/devcontainers/base:ubuntu': DIGEST },
    features: { 'ghcr.io/devcontainers/features/node:1': DIGEST },
    ...fields,
  };
}

const REFUSED: RefusedUpdate = { configPath: DEFAULT, configHash: DIGEST, images: { 'node:22': DIGEST }, features: {}, items: 'the mount of /var/run/docker.sock' };

/**
 * The extension's side over an in-memory registry file (as EnvironmentRegistry: a mutator that throws writes nothing),
 * with the writes of the open as the extension wires them (src/vscode/hostSide.ts) and the handler of one operation.
 */
function setup(
  entries: readonly Environment[] = [entryOf(ID)],
  options: { kept?: KeptVolume[]; scope?: { environmentId?: string; repository?: string; dockerHost?: string }; allowed?: readonly HostCall[] } = {},
) {
  let file: RegistryFile = { version: 1, environments: structuredClone([...entries]), ...(options.kept ? { keptVolumes: structuredClone(options.kept) } : {}) };
  const update = (async <T>(mutator: (file: RegistryFile) => T | Promise<T>) => {
    const copy = structuredClone(file);
    const result = await mutator(copy);
    file = copy;
    return structuredClone(result);
  }) as EnvironmentRegistry['update'];
  const registry: Pick<EnvironmentRegistry, 'update' | 'updateEnvironment'> = {
    update,
    updateEnvironment: (id, mutator) =>
      update(async (f) => {
        const found = f.environments.find((candidate) => candidate.id === id);
        if (!found) return undefined;
        await mutator(found);
        return found;
      }),
  };
  const warnings: string[] = [];
  const logger: Logger = { ...silentLogger, warn: (text) => warnings.push(text) };
  const view: BusyMarkView = { owner: OWNER, clock: { now: () => NOW }, isAlive: () => true, windowStatuses: async () => [], logger };
  const busyMarks = registryBusyMarks(registry, view);
  const open = (scope: OpenRequestScope | undefined) => {
    if (scope === undefined) throw new Error('no scope');
    return requestOpenRecords(registry, view, { account: ACCOUNT, dockerHost: scope.dockerHost });
  };
  const records = {
    markBusy: (id: string, operation: BusyMark['operation'], onReplaced?: (mark: BusyMark) => void) => busyMarks.mark(id, operation, onReplaced),
    ownerLogin: (id: string, scope?: OpenRequestScope) => open(scope).ownerLogin(id),
    createEnvironment: (id: string, repository: string, configPath: string, scope?: OpenRequestScope) => open(scope).createEnvironment({ id, repository, configPath }),
    dropCreated: (id: string, scope?: OpenRequestScope) => open(scope).dropCreated(id),
    configuration: (id: string, change: ConfigurationChange, scope?: OpenRequestScope) => open(scope).configuration(id, change),
    build: (id: string, change: BuildChange, scope?: OpenRequestScope) => open(scope).build(id, change),
  };
  const host = { questions: {}, state: {}, records, secrets: {}, connect: {} } as unknown as HostSide;
  const handler = hostSideHandler(host, logger, options.allowed ?? ALLOWED, options.scope ?? { environmentId: ID, repository: REPOSITORY, dockerHost: HOST });
  const signal = new AbortController().signal;
  const ask = (call: string, ...args: unknown[]) => handler('record', { call, args }, signal).then((answer) => answer.value);
  const entry = (id = ID) => file.environments.find((candidate) => candidate.id === id);
  const setFile = (change: (file: RegistryFile) => void) => change(file);
  return { ask, entry, file: () => file, setFile, warnings, handler, signal };
}

/** The handler of a first open of REPOSITORY on HOST: no environment until its create. */
const firstOpen = (entries: readonly Environment[] = [], options: { kept?: KeptVolume[] } = {}) => setup(entries, { ...options, scope: { repository: REPOSITORY, dockerHost: HOST } });

describe('the entry of a first open, the configuration and the build records as requests (plan step 11E4c)', () => {
  it('no operation may send them before plan step 11E6; `record update` and `record add` are gone', async () => {
    for (const allowed of Object.values(FLOW_REQUESTS)) {
      expect(allowed.filter((call) => /^record (createEnvironment|dropCreated|configuration|build|update|add)\b/.test(call))).toEqual([]);
    }
    expect(SCOPED_REQUESTS).not.toHaveProperty(['record update']);
    expect(SCOPED_REQUESTS).toMatchObject({ 'record dropCreated': 0, 'record configuration': 0, 'record build': 0 });
    expect(SCOPED_REQUESTS).not.toHaveProperty(['record createEnvironment']);
    expect(DETAILED_REQUESTS).toMatchObject({ 'record build': 1 });
    const handler = hostSideHandler({ records: {} } as unknown as HostSide, silentLogger, FLOW_REQUESTS[OP_DELETE], { environmentId: ID, dockerHost: HOST });
    await expect(handler('record', { call: 'configuration', args: [ID, { cloned: true }] }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid' });
    for (const call of ['update', 'add']) {
      await expect(setup([], { allowed: [`record ${call}` as HostCall] }).ask(call, ID, {})).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('unknown') });
    }
  });

  describe('createEnvironment', () => {
    it("the extension builds the entry: its account, the operation's Docker host, its clock, the create mark of its window, the names", async () => {
      const { ask, entry } = firstOpen();
      const created = await ask('createEnvironment', CREATE);
      const expected = {
        id: NEW,
        repository: REPOSITORY,
        configPath: DEFAULT,
        volumeName: name(NEW),
        containerName: name(NEW),
        createdAt: new Date(NOW).toISOString(),
        lastUsedAt: new Date(NOW).toISOString(),
        busy: ownCreate(),
        owner: ACCOUNT,
        dockerHost: HOST,
      };
      expect(created).toEqual(expected);
      expect(entry(NEW)).toEqual(expected);
      // A configuration of a repository, and the local Docker without a dockerHost field.
      const local = setup([], { scope: { repository: REPOSITORY, dockerHost: '' } });
      expect(await local.ask('createEnvironment', { ...CREATE, configPath: '.devcontainer/python/devcontainer.json' })).not.toHaveProperty('dockerHost');
      expect(local.entry(NEW)).toMatchObject({ configPath: '.devcontainer/python/devcontainer.json' });
    });

    it('refuses an invalid ID, repository or configuration path, any other field, and a repository that is not the one of the operation; nothing is written', async () => {
      for (const request of [
        { ...CREATE, id: '../x' },
        { ...CREATE, id: '' },
        { ...CREATE, id: 'x'.repeat(129) },
        { ...CREATE, repository: 'acme' },
        { ...CREATE, repository: 'acme/api/x' },
        { ...CREATE, repository: `acme/${'a'.repeat(256)}` },
        { ...CREATE, repository: 'acme/other' },
        { ...CREATE, repository: 'ACME/api' },
        { ...CREATE, configPath: '../devcontainer.json' },
        { ...CREATE, configPath: '.devcontainer/../x/devcontainer.json' },
        { ...CREATE, configPath: 'devcontainer.json' },
        { ...CREATE, configPath: 7 },
        { id: NEW, repository: REPOSITORY },
        { ...CREATE, owner: { id: '7', login: 'mallory' } },
        { ...CREATE, createdAt: '2030-01-01T00:00:00.000Z' },
        { ...CREATE, busy: null },
        { ...CREATE, volumeName: 'devenv-other' },
        { ...CREATE, dockerHost: 'ssh://elsewhere' },
        null,
        [CREATE],
      ]) {
        const { ask, file } = firstOpen();
        await expect(ask('createEnvironment', request), JSON.stringify(request)).rejects.toMatchObject({ code: 'invalid' });
        expect(file().environments).toEqual([]);
      }
      await expect(firstOpen().ask('createEnvironment', CREATE, 'more')).rejects.toMatchObject({ code: 'invalid' });
      await expect(firstOpen().ask('createEnvironment')).rejects.toMatchObject({ code: 'invalid' });
    });

    it('refuses an ID or a volume that the registry has; nothing is written', async () => {
      // An entry of another repository with the ID, and one whose volume has the name of the new entry.
      // Review round 1 of PR #106 (A-L2): and the ID in other case.
      const otherCase = entryOf(NEW.toUpperCase(), { repository: 'acme/web', volumeName: name(OTHER), containerName: name(OTHER) });
      for (const existing of [entryOf(NEW, { repository: 'acme/web' }), entryOf(OTHER, { repository: 'acme/web', volumeName: name(NEW).toUpperCase() }), otherCase]) {
        const { ask, file } = firstOpen([existing]);
        await expect(ask('createEnvironment', CREATE)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('already') });
        expect(file().environments).toEqual([existing]);
      }
    });

    it('answers the entry of the repository that another window of the account created meanwhile, and binds the operation to it', async () => {
      const theirs = entryOf(OTHER, { repository: 'Acme/API', busy: ownCreate({ windowId: 'w2', pid: 200 }) });
      const { ask, file } = firstOpen([theirs]);
      expect(await ask('createEnvironment', CREATE)).toEqual(theirs);
      expect(file().environments).toEqual([theirs]);
      // The open uses it: its requests are for that environment, never for the ID of the request.
      expect(await ask('ownerLogin', OTHER)).toMatchObject({ id: OTHER, owner: ACCOUNT });
      await expect(ask('configuration', NEW, { cloned: true })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another environment') });
      // This operation did not create it: it never removes it.
      await expect(ask('dropCreated', OTHER)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('not the one that the operation created') });
      expect(file().environments).toEqual([{ ...theirs, owner: ACCOUNT }]);
    });

    it('refuses the ID of the entry of the repository: it is never answered as the created one, which dropCreated would remove (review round 1 of PR #106, A-M1)', async () => {
      for (const existing of [entryOf(NEW), entryOf(NEW, { busy: ownCreate() }), entryOf(NEW.toUpperCase(), { repository: 'Acme/API' })]) {
        const { ask, file } = firstOpen([existing]);
        await expect(ask('createEnvironment', CREATE)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('already') });
        // The operation is bound to no environment: no mark, no removal.
        await expect(ask('markBusy', existing.id, 'create')).rejects.toMatchObject({ code: 'invalid' });
        await expect(ask('dropCreated', existing.id)).rejects.toMatchObject({ code: 'invalid' });
        expect(file().environments).toEqual([existing]);
      }
    });

    it('never for an operation without a repository (review round 1 of PR #106, A-L1)', async () => {
      const { ask, file } = setup([], { scope: { dockerHost: HOST } });
      await expect(ask('createEnvironment', CREATE)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another repository') });
      expect(file().environments).toEqual([]);
    });

    it('an entry of the repository of another account or on another Docker host is no clash', async () => {
      for (const existing of [entryOf(OTHER, { owner: { id: '7', login: 'other' } }), entryOf(OTHER, { dockerHost: 'ssh://other' }), entryOf(OTHER, { dockerHost: undefined })]) {
        const { ask, file } = firstOpen([existing]);
        expect(await ask('createEnvironment', CREATE)).toMatchObject({ id: NEW });
        expect(file().environments.map((entry) => entry.id)).toEqual([OTHER, NEW]);
      }
    });

    it('once per operation; never for an operation of an existing environment, or without a Docker host', async () => {
      const { ask, file } = firstOpen();
      await ask('createEnvironment', CREATE);
      await expect(ask('createEnvironment', { ...CREATE, id: OTHER })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('only once') });
      expect(file().environments.map((entry) => entry.id)).toEqual([NEW]);
      // A refused create counts too.
      const refused = firstOpen();
      await expect(refused.ask('createEnvironment', { ...CREATE, id: '..' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(refused.ask('createEnvironment', CREATE)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('only once') });
      // The operation of an existing environment has its environment.
      const existing = setup();
      await expect(existing.ask('createEnvironment', CREATE)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('has an environment already') });
      expect(existing.file().environments.map((entry) => entry.id)).toEqual([ID]);
      const hostless = setup([], { scope: { repository: REPOSITORY } });
      await expect(hostless.ask('createEnvironment', CREATE)).rejects.toMatchObject({ code: 'invalid' });
      expect(hostless.file().environments).toEqual([]);
    });
  });

  describe('the binding of a first open to the environment that it created', () => {
    it('before the create, no scoped request is answered; after it, those for the created environment only', async () => {
      const { ask, entry, file } = firstOpen([entryOf(OTHER, { repository: 'acme/web' })]);
      const before = structuredClone(file());
      for (const [call, ...args] of [
        ['configuration', NEW, { cloned: true }],
        ['build', NEW, 'number', 2],
        ['dropCreated', NEW],
        ['ownerLogin', NEW],
        ['configuration', OTHER, { cloned: true }],
      ] as const) {
        await expect(ask(call, ...args), call).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another environment') });
      }
      expect(file()).toEqual(before);
      await ask('createEnvironment', CREATE);
      expect(await ask('build', NEW, 'number', 2)).toMatchObject({ id: NEW, lastBuildNumber: 2 });
      expect(await ask('configuration', NEW, { shutdownActionNone: true })).toMatchObject({ id: NEW, shutdownActionNone: true });
      await expect(ask('configuration', OTHER, { shutdownActionNone: true })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another environment') });
      expect(entry(OTHER)).not.toHaveProperty('shutdownActionNone');
    });

    it('the binding is of the handler of that operation: the handler of another first open has none', async () => {
      const { ask, handler, signal } = firstOpen();
      await ask('createEnvironment', CREATE);
      const other = setup([], { scope: { repository: REPOSITORY, dockerHost: HOST } });
      await expect(other.ask('configuration', NEW, { cloned: true })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another environment') });
      expect(await handler('record', { call: 'configuration', args: [NEW, { cloned: true }] }, signal)).toMatchObject({ value: { id: NEW } });
    });
  });

  describe('dropCreated', () => {
    it('removes the entry that the operation created, with the create mark of this window, once', async () => {
      const { ask, file } = firstOpen([entryOf(OTHER, { repository: 'acme/web' })]);
      await ask('createEnvironment', CREATE);
      expect(await ask('dropCreated', NEW)).toBeNull();
      expect(file().environments.map((entry) => entry.id)).toEqual([OTHER]);
      await expect(ask('dropCreated', NEW)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('not the one that the operation created') });
    });

    it('never an entry that the operation did not create', async () => {
      // The entry of the operation of an existing environment, even with a create mark of this window.
      const { ask, file } = setup([entryOf(ID, { busy: ownCreate() })]);
      await expect(ask('dropCreated', ID)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('not the one that the operation created') });
      expect(file().environments.map((entry) => entry.id)).toEqual([ID]);
      await expect(ask('dropCreated', ID, 'more')).rejects.toMatchObject({ code: 'invalid' });
    });

    it('never once the entry has no create mark of this window, or belongs to another account or host; nothing is written', async () => {
      for (const change of [
        (entry: Environment) => void (entry.busy = ownCreate({ operation: 'update' })),
        (entry: Environment) => void (entry.busy = ownCreate({ windowId: 'w2' })),
        (entry: Environment) => void (entry.busy = ownCreate({ pid: 101 })),
        (entry: Environment) => void delete entry.busy,
        (entry: Environment) => void (entry.owner = { id: '7', login: 'other' }),
        (entry: Environment) => void (entry.dockerHost = 'ssh://other'),
        (entry: Environment) => void delete entry.dockerHost,
      ]) {
        const { ask, file, setFile } = firstOpen();
        await ask('createEnvironment', CREATE);
        setFile((f) => change(f.environments[0]));
        const before = structuredClone(file());
        await expect(ask('dropCreated', NEW)).rejects.toMatchObject({ code: 'invalid' });
        expect(file()).toEqual(before);
      }
    });

    it('a missing entry is no error, as EnvironmentRegistry.remove', async () => {
      const { ask, setFile, file } = firstOpen();
      await ask('createEnvironment', CREATE);
      setFile((f) => void (f.environments = []));
      expect(await ask('dropCreated', NEW)).toBeNull();
      expect(file().environments).toEqual([]);
    });
  });

  /** One request of each kind for the entry ID, as the worker sends it. */
  const SCOPED: readonly [string, ...unknown[]][] = [
    ['configuration', ID, { cloned: true }],
    ['build', ID, 'number', 3],
    ['build', ID, 'record', buildRecord(ID, 3), false],
    ['build', ID, 'rebaseline', environmentImageName(REPOSITORY, ID, 2), DIGEST, '2.40.0'],
    ['build', ID, 'refused', REFUSED],
  ];
  const COMPOSE_RECORD = buildRecord(ID, 2, { compose: { service: 'app', images: [`${composeProjectName(REPOSITORY, ID)}-app`], serviceImages: ['postgres:16'], version: '2.39.0', inputsHash: DIGEST } });

  it.each(SCOPED)('%s: refused for another environment, Docker host or owner, and without a Docker host; nothing is written', async (call, ...args) => {
    const fields = { buildRecord: COMPOSE_RECORD, gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-05T11:00:00.000Z' } };
    const elsewhere = setup([entryOf(ID, fields)], { scope: { environmentId: OTHER, dockerHost: HOST } });
    await expect(elsewhere.ask(call, ...args)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another environment') });
    expect(elsewhere.entry()).toEqual(entryOf(ID, fields));
    for (const dockerHost of ['ssh://other', undefined]) {
      const { ask, entry } = setup([entryOf(ID, { ...fields, dockerHost })]);
      await expect(ask(call, ...args)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another Docker host') });
      expect(entry()).toEqual(entryOf(ID, { ...fields, dockerHost }));
    }
    const foreign = setup([entryOf(ID, { ...fields, owner: { id: '7', login: 'other' } })]);
    await expect(foreign.ask(call, ...args)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('another account') });
    expect(foreign.entry()).toEqual(entryOf(ID, { ...fields, owner: { id: '7', login: 'other' } }));
    const hostless = setup([entryOf(ID, fields)], { scope: { environmentId: ID } });
    await expect(hostless.ask(call, ...args)).rejects.toMatchObject({ code: 'invalid' });
    expect(hostless.entry()).toEqual(entryOf(ID, fields));
    // And each one passes for the environment of the operation (the probe of the refusals above).
    expect(await setup([entryOf(ID, fields)]).ask(call, ...args)).toMatchObject({ id: ID });
  });

  it('dropCreated, configuration and build: a missing entry is null, as in OpenRecords', async () => {
    const { ask } = setup([], { scope: { environmentId: ID, dockerHost: HOST } });
    expect(await ask('configuration', ID, { cloned: true })).toBeNull();
    expect(await ask('build', ID, 'number', 2)).toBeNull();
  });

  describe('configuration', () => {
    it('applies its closed list of fields as registryOpenRecords does', async () => {
      const { ask } = setup([entryOf(ID, { refusedUpdate: REFUSED, gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-05T11:00:00.000Z' } })]);
      const updated = (await ask('configuration', ID, {
        select: '.devcontainer/python/devcontainer.json',
        shutdownActionNone: true,
        addVolumes: ['devenv-cache', 'devenv-db'],
        addServiceVolumes: ['devenv-db'],
        keepRefusedFor: { configPath: DEFAULT, configHash: `sha256:${'f'.repeat(64)}` },
        serviceFolders: { folders: ['/workspaces/api/db'], overflow: false },
        cloned: true,
      })) as Environment;
      expect(updated).toMatchObject({
        configPath: '.devcontainer/python/devcontainer.json',
        shutdownActionNone: true,
        additionalVolumes: ['devenv-cache', 'devenv-db'],
        serviceVolumes: ['devenv-db'],
        serviceFolders: ['/workspaces/api/db'],
      });
      // Another configuration hash: the refused update goes; the clone forgets the Git state.
      expect(updated).not.toHaveProperty('refusedUpdate');
      expect(updated).not.toHaveProperty('gitSummary');
    });

    it('the bounds: each field checked, no field beyond the list; nothing is written', async () => {
      const refused: unknown[] = [
        { select: '../x/devcontainer.json' },
        { select: '' },
        { shutdownActionNone: 'yes' },
        { addVolumes: ['-bad'] },
        { addVolumes: ['a b'] },
        { addVolumes: [`v${'x'.repeat(255)}`] },
        { addVolumes: Array.from({ length: 1001 }, (_, i) => `v${i}`) },
        { addVolumes: 'devenv-cache' },
        { addServiceVolumes: ['/etc'] },
        { keepRefusedFor: { configPath: DEFAULT } },
        { keepRefusedFor: { configPath: DEFAULT, configHash: 'h'.repeat(257) } },
        { keepRefusedFor: { configPath: 'x.json', configHash: DIGEST } },
        { keepRefusedFor: { configPath: DEFAULT, configHash: DIGEST, items: 'x' } },
        { serviceFolders: { folders: Array.from({ length: 1001 }, (_, i) => `/workspaces/api/${i}`), overflow: false } },
        { serviceFolders: { folders: [`/workspaces/api/${'a'.repeat(4096)}`], overflow: false } },
        { serviceFolders: { folders: ['/workspaces/api/db\n'], overflow: false } },
        { serviceFolders: { folders: ['/workspaces/api/db'] } },
        { serviceFolders: { folders: ['/workspaces/api/db'], overflow: 'no' } },
        { cloned: false },
        { lastBuildNumber: 9 },
        { owner: { id: '7', login: 'mallory' } },
        { ['__proto__']: { busy: null } },
        null,
        [],
      ];
      for (const change of refused) {
        const { ask, entry } = setup();
        await expect(ask('configuration', ID, change), JSON.stringify(change)).rejects.toMatchObject({ code: 'invalid' });
        expect(entry()).toEqual(entryOf(ID));
      }
      await expect(setup().ask('configuration', ID, { cloned: true }, 'more')).rejects.toMatchObject({ code: 'invalid' });
      // The longest of each bound passes.
      const longest = { addVolumes: Array.from({ length: 1000 }, (_, i) => `v${i}`), keepRefusedFor: { configPath: DEFAULT, configHash: 'h'.repeat(256) } };
      expect(((await setup().ask('configuration', ID, longest)) as Environment).additionalVolumes).toHaveLength(1000);
    });

    it('leaves out and logs the own workspace volume, the workspace volume of another entry, a volume of another account and a volume that another account kept', async () => {
      const others = [
        entryOf(OTHER, { repository: 'acme/web', volumeName: 'devenv-web', additionalVolumes: ['devenv-shared'] }),
        entryOf('e-foreign', { repository: 'acme/api', owner: { id: '7', login: 'other' }, volumeName: 'devenv-foreign', additionalVolumes: ['devenv-theirs'] }),
      ];
      const kept: KeptVolume[] = [
        { name: 'devenv-kept-theirs', owner: { id: '7', login: 'other' }, keptAt: '2026-10-01T00:00:00.000Z' },
        { name: 'devenv-kept-own', owner: { id: ACCOUNT.id, login: 'octo' }, keptAt: '2026-10-01T00:00:00.000Z' },
      ];
      const { ask, warnings } = setup([entryOf(ID), ...others], { kept });
      const addVolumes = [name(ID), name(ID).toUpperCase(), 'devenv-web', 'devenv-foreign', 'devenv-theirs', 'DEVENV-THEIRS', 'devenv-kept-theirs', 'devenv-cache', 'devenv-shared', 'devenv-kept-own'];
      const updated = (await ask('configuration', ID, { addVolumes, addServiceVolumes: ['devenv-cache', 'devenv-theirs', 'devenv-other'] })) as Environment;
      // An additional volume of another entry of the same account is shared (recordedVolumes), and so is one that a Delete
      // of the same account kept.
      expect(updated.additionalVolumes).toEqual(['devenv-cache', 'devenv-shared', 'devenv-kept-own']);
      // The volumes of the services are additional volumes of the entry after the change, and no other.
      expect(updated.serviceVolumes).toEqual(['devenv-cache']);
      expect(warnings).toEqual([
        `The worker recorded the volume ${name(ID)} for acme/api, which is left out: it is the workspace volume of the environment.`,
        `The worker recorded the volume ${name(ID).toUpperCase()} for acme/api, which is left out: it is the workspace volume of the environment.`,
        'The worker recorded the volume devenv-web for acme/api, which is left out: it is the workspace volume of another environment.',
        'The worker recorded the volume devenv-foreign for acme/api, which is left out: it is the workspace volume of another environment.',
        'The worker recorded the volume devenv-theirs for acme/api, which is left out: an environment of another account uses it.',
        'The worker recorded the volume DEVENV-THEIRS for acme/api, which is left out: an environment of another account uses it.',
        'The worker recorded the volume devenv-kept-theirs for acme/api, which is left out: a Delete of another account kept it.',
        'The worker recorded the volume devenv-theirs of a service for acme/api, which is left out: it is no additional volume of the environment.',
        'The worker recorded the volume devenv-other of a service for acme/api, which is left out: it is no additional volume of the environment.',
      ]);
    });

    it('a volume of a service that the entry recorded before stays a volume of a service', async () => {
      const { ask } = setup([entryOf(ID, { additionalVolumes: ['devenv-db'] })]);
      expect(await ask('configuration', ID, { addServiceVolumes: ['devenv-db'] })).toMatchObject({ serviceVolumes: ['devenv-db'] });
    });

    it('the service folders as the pipeline records them: paths of the repository, within the bounds', async () => {
      const { ask } = setup();
      const folders = ['/workspaces/api/db', '/workspaces/api/db/data', '/etc/passwd', '/workspaces/web/x', '/workspaces/api/.git/hooks', '/workspaces/api/../x', '/workspaces/api/cache'];
      expect(await ask('configuration', ID, { serviceFolders: { folders, overflow: false } })).toMatchObject({ serviceFolders: ['/workspaces/api/db', '/workspaces/api/cache'] });
      const overflow = (await ask('configuration', ID, { serviceFolders: { folders: [], overflow: true } })) as Environment;
      expect(overflow).toMatchObject({ serviceFoldersOverflow: true });
      expect(overflow).not.toHaveProperty('serviceFolders');
    });
  });

  describe('build', () => {
    it('number: a whole number above zero; the last build number never goes back', async () => {
      const { ask, entry } = setup([entryOf(ID, { lastBuildNumber: 5 })]);
      for (const value of [0, -1, 1.5, '6', Number.MAX_SAFE_INTEGER + 1, null]) {
        await expect(ask('build', ID, 'number', value), String(value)).rejects.toMatchObject({ code: 'invalid' });
      }
      await expect(ask('build', ID, 'number', 6, 'more')).rejects.toMatchObject({ code: 'invalid' });
      await expect(ask('build', ID, 'number')).rejects.toMatchObject({ code: 'invalid' });
      expect(entry()?.lastBuildNumber).toBe(5);
      expect(await ask('build', ID, 'number', 3)).toMatchObject({ lastBuildNumber: 5 });
      expect(await ask('build', ID, 'number', 7)).toMatchObject({ lastBuildNumber: 7 });
    });

    it('record: a build record of an image of the environment, under its own build number; the last build number never goes back', async () => {
      const { ask, entry } = setup([entryOf(ID, { lastBuildNumber: 9, refusedUpdate: REFUSED })]);
      const record = buildRecord(ID, 7);
      const kept = (await ask('build', ID, 'record', record, false)) as Environment;
      expect(kept).toMatchObject({ buildRecord: record, lastBuildNumber: 9, refusedUpdate: REFUSED });
      const next = buildRecord(ID, 10, { compose: { service: 'app', images: [`${composeProjectName(REPOSITORY, ID)}-app`], serviceImages: ['postgres:16'], version: '2.39.0', inputsHash: DIGEST } });
      const updated = (await ask('build', ID, 'record', next, true)) as Environment;
      expect(updated).toMatchObject({ buildRecord: next, lastBuildNumber: 10 });
      expect(updated).not.toHaveProperty('refusedUpdate');
      // A record without its pinned image ID passes too (an existing image).
      const { imageId: _pinned, ...unpinned } = buildRecord(ID, 11);
      expect(await ask('build', ID, 'record', unpinned, false)).toMatchObject({ buildRecord: unpinned, lastBuildNumber: 11 });
      expect(entry()?.buildRecord).toEqual(unpinned);
    });

    it('record: the name rule, the sha256 IDs and digests, the configuration, the bounded lists, no other field; nothing is written', async () => {
      const prefix = composeProjectName(REPOSITORY, ID);
      const compose = { service: 'app', images: [`${prefix}-app`], serviceImages: ['postgres:16'], version: '2.39.0', inputsHash: DIGEST };
      const refused: [string, unknown, unknown?][] = [
        ['the image of another build number', buildRecord(ID, 7, { environmentImage: environmentImageName(REPOSITORY, ID, 8) })],
        ['the image of another environment', buildRecord(ID, 7, { environmentImage: environmentImageName(REPOSITORY, OTHER, 7) })],
        ['the image of another repository', buildRecord(ID, 7, { environmentImage: environmentImageName('acme/web', ID, 7) })],
        ['a build number 0', buildRecord(ID, 0)],
        ['a build number that is no whole number', { ...buildRecord(ID, 7), buildNumber: 7.5 }],
        // Review round 1 of PR #106 (A-L3).
        ['a build number above the bound', buildRecord(ID, MAX_BUILD_NUMBER + 1)],
        ['an image ID that is no sha256', buildRecord(ID, 7, { imageId: 'abc' })],
        ['an image ID of another algorithm', buildRecord(ID, 7, { imageId: `sha512:${'e'.repeat(64)}` })],
        ['a digest that is no sha256', buildRecord(ID, 7, { images: { 'node:22': 'latest' } })],
        ['a feature digest that is no sha256', buildRecord(ID, 7, { features: { 'ghcr.io/f:1': `sha256:${'D'.repeat(64)}` } })],
        ['too many images', buildRecord(ID, 7, { images: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`img${i}`, DIGEST])) })],
        ['an overlong reference', buildRecord(ID, 7, { images: { [`r${'x'.repeat(1024)}`]: DIGEST } })],
        ['a configuration path out of the repository', buildRecord(ID, 7, { configPath: '../devcontainer.json' })],
        ['an overlong configuration hash', buildRecord(ID, 7, { configHash: 'h'.repeat(257) })],
        ['a time that is none', buildRecord(ID, 7, { builtAt: 'yesterday' })],
        ['a field beyond the list', { ...buildRecord(ID, 7), lastBuildNumber: 99 }],
        ['a Compose image of another project', buildRecord(ID, 7, { compose: { ...compose, images: ['devenv-other-app'] } })],
        ['too many Compose images', buildRecord(ID, 7, { compose: { ...compose, images: Array.from({ length: 1001 }, (_, i) => `${prefix}-${i}`) } })],
        ['too many Compose service images', buildRecord(ID, 7, { compose: { ...compose, serviceImages: Array.from({ length: 1001 }, (_, i) => `img${i}`) } })],
        ['a Compose part without its service', buildRecord(ID, 7, { compose: { ...compose, service: '' } })],
        ['a field beyond the Compose part', buildRecord(ID, 7, { compose: { ...compose, extra: 1 } as never })],
        ['a dropRefused that is no boolean', buildRecord(ID, 7), 'yes'],
      ];
      for (const [why, record, dropRefused = false] of refused) {
        const { ask, entry } = setup();
        await expect(ask('build', ID, 'record', record, dropRefused), why).rejects.toMatchObject({ code: 'invalid' });
        expect(entry(), why).toEqual(entryOf(ID));
      }
      await expect(setup().ask('build', ID, 'record', buildRecord(ID, 7))).rejects.toMatchObject({ code: 'invalid' });
      // The longest of the lists passes.
      const many = buildRecord(ID, 7, { images: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`img${i}`, DIGEST])) });
      expect(await setup().ask('build', ID, 'record', many, false)).toMatchObject({ buildRecord: { buildNumber: 7 } });
    });

    it('rebaseline: only the image of the build record of the entry; bounded hash and version', async () => {
      const { ask, entry } = setup([entryOf(ID, { buildRecord: COMPOSE_RECORD })]);
      // Another image than the one of the build record (another window's rebuild won the race) changes nothing, as in the
      // extension's own open; it is not refused.
      expect(await ask('build', ID, 'rebaseline', environmentImageName(REPOSITORY, ID, 3), DIGEST, '2.40.0')).toMatchObject({ buildRecord: COMPOSE_RECORD });
      expect(entry()?.buildRecord).toEqual(COMPOSE_RECORD);
      for (const args of [
        ['', DIGEST, '2.40.0'],
        [COMPOSE_RECORD.environmentImage, 'h'.repeat(257), '2.40.0'],
        [COMPOSE_RECORD.environmentImage, DIGEST, 'v'.repeat(257)],
        [COMPOSE_RECORD.environmentImage, DIGEST, 2],
        [COMPOSE_RECORD.environmentImage, DIGEST],
        [COMPOSE_RECORD.environmentImage, DIGEST, '2.40.0', 'more'],
      ]) {
        await expect(ask('build', ID, 'rebaseline', ...args), JSON.stringify(args)).rejects.toMatchObject({ code: 'invalid' });
        expect(entry()?.buildRecord).toEqual(COMPOSE_RECORD);
      }
      const hash = `sha256:${'a'.repeat(64)}`;
      expect(await ask('build', ID, 'rebaseline', COMPOSE_RECORD.environmentImage, hash, '2.40.0')).toMatchObject({ buildRecord: { configHash: hash, compose: { version: '2.40.0' } } });
      // An entry without a build record has no image to rebaseline: nothing changes.
      const bare = setup();
      expect(await bare.ask('build', ID, 'rebaseline', COMPOSE_RECORD.environmentImage, hash, '2.40.0')).not.toHaveProperty('buildRecord');
      expect(bare.entry()?.buildRecord).toBeUndefined();
    });

    it('refused: the refused update as the pipeline records it; nothing else', async () => {
      const { ask, entry } = setup();
      for (const refusedUpdate of [
        { ...REFUSED, items: 'x'.repeat(4098) },
        { ...REFUSED, hostAccessChecks: 'on' },
        { ...REFUSED, reason: 'policy' },
        { ...REFUSED, images: { 'node:22': 'sha256:abc' } },
        { ...REFUSED, configPath: 'Dockerfile' },
        { ...REFUSED, configHash: 'h'.repeat(257) },
        { ...REFUSED, extra: 1 },
        { configPath: DEFAULT, configHash: DIGEST, images: {}, features: {} },
        'refused',
      ]) {
        await expect(ask('build', ID, 'refused', refusedUpdate), JSON.stringify(refusedUpdate).slice(0, 80)).rejects.toMatchObject({ code: 'invalid' });
        expect(entry()).toEqual(entryOf(ID));
      }
      await expect(ask('build', ID, 'refused', REFUSED, 'more')).rejects.toMatchObject({ code: 'invalid' });
      // The longest items of the pipeline (MAX_REFUSED_ITEMS_LENGTH and the `…` of their middle), off and size.
      const longest = { ...REFUSED, items: 'x'.repeat(4097), hostAccessChecks: 'off', reason: 'size' };
      expect(await ask('build', ID, 'refused', longest)).toMatchObject({ refusedUpdate: longest });
    });

    it('an unknown kind is refused', async () => {
      const { ask, entry } = setup();
      for (const kind of ['numbers', 'Record', '']) {
        await expect(ask('build', ID, kind, 2)).rejects.toMatchObject({ code: 'invalid' });
      }
      await expect(ask('build', ID)).rejects.toMatchObject({ code: 'invalid' });
      expect(entry()).toEqual(entryOf(ID));
    });

    it('the allowance of the open can name the kinds of build (DETAILED_REQUESTS)', async () => {
      const { ask } = setup([entryOf(ID)], { allowed: ['record build.number'] });
      expect(await ask('build', ID, 'number', 2)).toMatchObject({ lastBuildNumber: 2 });
      await expect(ask('build', ID, 'refused', REFUSED)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('may not send') });
    });
  });

  it('the worker and the extension, wired over JSON: what the pipeline sends is what the extension takes', async () => {
    const { handler, signal, file } = firstOpen();
    const records = hostOpenRecords(
      workerHostSide(async (request) => {
        const sent = JSON.parse(JSON.stringify(request)) as typeof request;
        const answer = await handler(sent.kind, { call: sent.call, args: sent.args }, signal);
        return (JSON.parse(JSON.stringify({ value: answer.value })) as { value?: unknown }).value;
      }, () => undefined),
    );
    // As openFirst builds it in the worker: its clock, owner and mark are not sent.
    const built = { ...entryOf(NEW), createdAt: '1999-01-01T00:00:00.000Z', busy: ownCreate({ windowId: 'worker' }) };
    await records.createEnvironment(built);
    expect(file().environments[0]).toMatchObject({ id: NEW, createdAt: new Date(NOW).toISOString(), owner: ACCOUNT, busy: ownCreate() });
    // Review round 1 of PR #106 (A-L6): the open goes on with the entry as the extension recorded it.
    expect(built).toEqual(file().environments[0]);
    await records.configuration(NEW, { select: DEFAULT, shutdownActionNone: false, addVolumes: ['devenv-cache'], addServiceVolumes: ['devenv-cache'], keepRefusedFor: { configPath: DEFAULT, configHash: DIGEST }, serviceFolders: { folders: [], overflow: false }, cloned: true });
    await records.build(NEW, { kind: 'number', buildNumber: 1 });
    const record = buildRecord(NEW, 1, { compose: { service: 'app', images: [`${composeProjectName(REPOSITORY, NEW)}-app`], serviceImages: [], version: '2.39.0', inputsHash: DIGEST } });
    await records.build(NEW, { kind: 'record', record, dropRefused: true });
    await records.build(NEW, { kind: 'rebaseline', environmentImage: record.environmentImage, configHash: DIGEST, version: '2.40.0' });
    await records.build(NEW, { kind: 'refused', refusedUpdate: REFUSED });
    expect(file().environments[0]).toMatchObject({ additionalVolumes: ['devenv-cache'], serviceVolumes: ['devenv-cache'], lastBuildNumber: 1, buildRecord: { compose: { version: '2.40.0' } }, refusedUpdate: REFUSED });
    await records.dropCreated(NEW);
    expect(file().environments).toEqual([]);
  });
});
