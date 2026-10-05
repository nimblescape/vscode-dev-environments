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
import { hostAuth, hostBusyMarks, hostOpenRecords, hostSessionFiles, hostStore, hostUi, workerServiceDeps, workerServices, workerSessionMonitor, type WorkerServicesDeps } from './workerServices';
import { EngineError, type DockerEngine } from './dockerEngine';
// Plan step 11D1: the time limit of a monitor command is in monitorFlow.ts (the commands of the monitor in the worker).
import { MONITOR_EXEC_TIMEOUT_MS } from './monitorFlow';
import { RECORDS_RUN_LIMIT_EXIT, REMOTE_MONITOR_CONTAINER, REMOTE_MONITOR_SCRIPT_PATH, forgetCommand } from '../remoteMonitor/protocol';
import { SECRET_TOKEN } from '../helperChannel/protocol';

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
      // Plan step 11C2b.
      confirmDelete: (repository, confirmation) => answer('confirmDelete', repository, confirmation),
      deleteAdditionalVolumes: (volumes) => answer('deleteAdditionalVolumes', volumes),
      deleteServiceData: (volumes, possibly) => answer('deleteServiceData', volumes, possibly),
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
      remove: (id, volumes) => answer('remove', id, volumes),
      forgetKeptVolumes: (names) => answer('forgetKeptVolumes', names),
      sessionFile: (kind, environmentId) => answer('sessionFile', kind, environmentId),
      // Plan step 11C2a.
      markBusy: (environmentId, operation) => answer('markBusy', environmentId, operation),
      clearBusy: (environmentId) => answer('clearBusy', environmentId),
      recordGitSummary: (environmentId, summary) => answer('recordGitSummary', environmentId, summary),
      // Plan step 11C3.
      restore: (entries) => answer('restore', entries.map((entry) => entry.id)),
      // Plan step 11E4b.
      createMark: (environmentId, kind, previous) => answer('createMark', environmentId, kind, previous),
      takeStepMark: (environmentId, operation) => answer('takeStepMark', environmentId, operation),
      releaseStepMark: (environmentId, mark) => answer('releaseStepMark', environmentId, mark),
      ownerLogin: (environmentId) => answer('ownerLogin', environmentId),
      lifecycleMark: (environmentId, change) => answer('lifecycleMark', environmentId, change),
      openFinished: (environmentId, finish) => answer('openFinished', environmentId, finish),
      // Plan step 11E4c.
      createEnvironment: (id, repository, configPath) => answer('createEnvironment', id, repository, configPath),
      dropCreated: (environmentId) => answer('dropCreated', environmentId),
      configuration: (environmentId, change) => answer('configuration', environmentId, change),
      build: (environmentId, change) => answer('build', environmentId, change),
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
    const short = 'abc123def456';
    const full = `${short}${'0'.repeat(52)}`;
    const engine = {
      ...unusedEngine(),
      inspect: async (kind: string, reference: string) => (asked.push(`${kind} ${reference}`), reference === short ? inspect({ Id: full }) : undefined),
    };
    expect((await readOwnHelper(engine, short)).socket).toBe('/run/user/1000/docker.sock');
    expect(asked).toEqual([`container ${short}`]);
    await expect(readOwnHelper(engine, 'fedcba987654')).rejects.toThrow('is not known to the engine');
    await expect(readOwnHelper({ ...unusedEngine(), inspect: async () => inspect({ Id: full, Mounts: [] }) }, short)).rejects.toThrow('cannot be read');
    // Review round 1 of 11B3b (A-R1-1): a container found by a name like the ID is not the worker; a host name that is
    // no container ID is never asked for.
    await expect(readOwnHelper({ ...unusedEngine(), inspect: async () => inspect({ Id: `ffff${'0'.repeat(60)}` }) }, short)).rejects.toThrow('with another container');
    await expect(readOwnHelper({ ...unusedEngine(), inspect: async () => inspect() }, short)).rejects.toThrow('with another container');
    asked.length = 0;
    // Review round 2 of 11B3b (B-R2-5): only 12 to 64 hex characters, the whole host name.
    for (const name of ['devenv-worker', 'abc', 'x0123456789ab', '0123456789abX', 'ABC123DEF456', 'a'.repeat(65)]) {
      await expect(readOwnHelper(engine, name), name).rejects.toThrow('is not the ID of its container');
    }
    expect(asked).toEqual([]);
    // An ID that contains the host name but does not start with it is another container.
    await expect(readOwnHelper({ ...unusedEngine(), inspect: async () => inspect({ Id: `ff${short}${'0'.repeat(50)}` }) }, short)).rejects.toThrow('with another container');
    // Review round 1 of 11B3b (B-R1-9): only the bind mount at the socket's path is the socket; a full image ID and a
    // reference are needed.
    const state = { Type: 'bind', Source: '/srv/state', Destination: '/state' };
    expect(ownHelperOf(inspect({ Mounts: [state, { Type: 'bind', Source: '/var/run/docker.sock', Destination: HELPER_DOCKER_SOCKET }] }))?.socket).toBe('/var/run/docker.sock');
    expect(ownHelperOf(inspect({ Mounts: [state] }))).toBeUndefined();
    expect(ownHelperOf(inspect({ Image: 'sha256:abc' }))).toBeUndefined();
    expect(ownHelperOf(inspect({ Config: { Image: '' } }))).toBeUndefined();
  });
});

describe('the core services in the worker (plan step 11B3b)', () => {
  it('the registry goes through the record requests; a write by a function fails closed until plan steps 11D and 11E', async () => {
    const { host, calls } = fakeHost({ get: { id: 'e1' }, restore: { added: 1, skipped: [] } });
    const store = hostStore(host.records);
    expect(await store.get('e1')).toEqual({ id: 'e1' });
    await store.findForAccount('acme/api', '42');
    await store.remove('e1');
    // Plan step 11C3: the entries rebuilt from the volumes go as `record restore`.
    expect(await store.restore([{ id: 'e2' } as Environment])).toEqual({ added: 1, skipped: [] });
    expect(calls).toEqual(['get "e1"', 'findForAccount "acme/api" "42" ""', 'remove "e1" {}', 'restore ["e2"]']);
    // Plan step 11C3: changed, the changes of an entry by a function come with the flows of plan steps 11D and 11E
    // (EnvironmentStore.update, the change of the whole registry by a function, is removed with its test).
    await expect(store.updateEnvironment('e1', () => {})).rejects.toThrow('before plan step 11D or 11E');
    // Plan step 11E4c: changed (before: `record add`, which is removed): the entry of a first open is `record createEnvironment`.
    await expect(store.add({ id: 'e3' } as Environment)).rejects.toThrow('record createEnvironment');
    expect(calls).toHaveLength(4);
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

// Review round 1 of 11B3b (B-R1-7, B-R1-8): the deps of the pipeline in the worker, one by one.
describe('the deps of the pipeline in the worker (review round 1 of 11B3b)', () => {
  function deps(overrides: Partial<WorkerServicesDeps> = {}) {
    const { host, calls } = fakeHost({ windowStatuses: [{ windowId: 'w' }], confirmUntrustedRepository: false, recreateContainer: true });
    const all = workerServiceDeps({
      host,
      engine: { ...unusedEngine(), version: async () => ({ apiVersion: '1.48', version: '29.0.0' }) },
      secretOf: (name) => (name === SECRET_TOKEN ? 'ghp_x' : undefined),
      logger: silentLogger,
      ownHelper: { image: { tag: 'devenv-helper:abc', id: IMAGE_ID }, socket: '/s.sock' },
      dockerHost: 'build-box',
      owner: { windowId: 'w', pid: 1 },
      environmentLock: async () => {
        throw new Error('no lock in this test');
      },
      ...overrides,
    });
    return { all, calls };
  }

  it('fails closed where the worker has nothing yet: the analysis, the image check, a process, a flow, a helper container or build', async () => {
    const { all } = deps();
    await expect(all.analyzer.analyze({} as never)).rejects.toThrow('before plan step 11E');
    await expect(all.imageChecker.check({} as never)).rejects.toThrow('before plan step 11E');
    await expect(all.runner.run('docker', [])).rejects.toThrow('runs no process');
    await expect(all.flow('stop', {}, {})).rejects.toThrow('sends no flow');
    expect(() => all.settings()).toThrow('before plan step 11E');
    const settings = { stopAfterMinutes: 5 } as never;
    expect(deps({ settings }).all.settings()).toBe(settings);
  });

  // Plan step 11E4c: changed (before: createEnvironment, dropCreated, configuration and build failed closed until 11E4c).
  it('plan steps 11E4b and 11E4c: the registry writes of the open go to the extension as their requests', async () => {
    const { all, calls } = deps();
    const records = all.openRecords!;
    const mark = { operation: 'update' as const, since: '2026-10-04T12:00:00.000Z', pid: 1, windowId: 'w' };
    await records.createMark('e1', 'previous', mark);
    await records.takeStepMark('e1', 'update');
    await records.releaseStepMark('e1', mark);
    // The worker sends no account, no time of the last use and no liveness: the extension takes its own.
    await records.ownerLogin('e1', { id: '42', login: 'mallory' });
    await records.lifecycleMark('e1', 'clear');
    await records.openFinished('e1', { lastUsedAt: '2030-01-01T00:00:00.000Z', remoteWorkspaceFolder: '/workspaces/api', remoteUser: 'node', liveness: { now: 0, windowStatuses: [] } });
    expect(calls).toEqual([
      `createMark "e1" "previous" ${JSON.stringify(mark)}`,
      'takeStepMark "e1" "update"',
      `releaseStepMark "e1" ${JSON.stringify(mark)}`,
      'ownerLogin "e1"',
      'lifecycleMark "e1" "clear"',
      'openFinished "e1" {"remoteUser":"node","remoteWorkspaceFolder":"/workspaces/api"}',
    ]);
    // Plan step 11E4c: the four writes that failed closed until now are requests too, and none names plan step 11E4c.
    expect(calls).toHaveLength(6);
    // hostOpenRecords over the HostSide alone.
    const alone = fakeHost();
    await hostOpenRecords(alone.host).lifecycleMark('e2', { set: 'a'.repeat(12) });
    expect(alone.calls).toEqual([`lifecycleMark "e2" {"set":"${'a'.repeat(12)}"}`]);
  });

  it('plan step 11E4c: hostOpenRecords sends the entry of a first open, its removal, the configuration and the build records', async () => {
    const entry = { id: 'e1', repository: 'acme/api', configPath: '.devcontainer/devcontainer.json', owner: { id: 'w', login: 'w' }, createdAt: 'worker clock' } as Environment;
    const { host, calls } = fakeHost({ createEnvironment: entry });
    const records = hostOpenRecords(host);
    await records.createEnvironment(entry);
    await records.dropCreated('e1');
    await records.configuration('e1', { addVolumes: ['v1'], cloned: true });
    await records.build('e1', { kind: 'number', buildNumber: 3 });
    // The worker sends the ID, the repository and the configuration of the entry; the owner and the times are the extension's.
    expect(calls).toEqual([
      'createEnvironment "e1" "acme/api" ".devcontainer/devcontainer.json"',
      'dropCreated "e1"',
      'configuration "e1" {"addVolumes":["v1"],"cloned":true}',
      'build "e1" {"kind":"number","buildNumber":3}',
    ]);
    // The entry of the repository that another window created meanwhile: the open finds and uses it (openFirst).
    const other = fakeHost({ createEnvironment: { ...entry, id: 'e9' } });
    await expect(hostOpenRecords(other.host).createEnvironment(entry)).rejects.toThrow('exists already');
    // Nothing of the open fails closed for plan step 11E4c any more.
    for (const write of [() => records.createEnvironment(entry), () => records.dropCreated('e1'), () => records.configuration('e1', {}), () => records.build('e1', { kind: 'number', buildNumber: 1 })]) {
      await expect(write()).resolves.toBeUndefined();
    }
    expect(calls).toHaveLength(8);
  });

  it('plan step 11E2: the analysis of the operation, when it brings one (the analysis thread of the worker)', () => {
    const analyzer = { analyze: async () => ({}) as never };
    expect(deps({ analyzer }).all.analyzer).toBe(analyzer);
  });

  it('the Docker host of the operation, the engine check, the window reads, the questions, and the secret of the operation', async () => {
    const { all, calls } = deps();
    expect(await all.dockerTarget!()).toEqual({ kind: 'remote', host: 'build-box', endpoint: '' });
    expect(await deps({ dockerHost: '' }).all.dockerTarget!()).toEqual({ kind: 'local', host: '', endpoint: '' });
    await all.startDocker!({ onStarting: () => {} });
    const down = deps({ engine: { ...unusedEngine(), version: async () => Promise.reject(new Error('connect ENOENT')) } }).all;
    await expect(down.startDocker!({ onStarting: () => {} })).rejects.toMatchObject({ code: 'dockerEngineNotRunning' });
    // Every other process counts as alive: a busy mark of another window is never taken over here.
    expect(all.isProcessAlive!(1)).toBe(true);
    expect(await all.windowStatuses!()).toEqual([{ windowId: 'w' }]);
    expect(await all.ui.confirmUntrustedRepository('acme/api')).toBe(false);
    expect(await all.ui.recreateContainer('acme/api', { message: 'm', detail: 'd' })).toBe(true);
    expect(calls).toEqual(['windowStatuses', 'confirmUntrustedRepository "acme/api"', 'recreateContainer "acme/api" {"message":"m","detail":"d"}']);
    // The secret input of an exec must be the token of the operation (EngineDocker over secretOf).
    await expect(all.docker.exec('c', ['cat'], { secretInput: 'other' })).rejects.toThrow('token secret of the operation');
    const execs: unknown[] = [];
    const withExec = deps({ engine: { ...unusedEngine(), exec: async (_c, _command, options) => (execs.push(options), { exitCode: 0, stdout: '', stderr: '', timedOut: false }) } }).all;
    await withExec.docker.exec('c', ['cat'], { secretInput: 'ghp_x' });
    expect(execs).toEqual([{ secretInputName: SECRET_TOKEN }]);
    await expect(all.helper.ensureImage()).resolves.toBe('devenv-helper:abc');
  });
});

// Plan step 11C2a (decision of 2026-10-04: Delete's `forget` is the worker's). Ported from the test of the removed
// RemoteSessionMonitor.forget ("forgets a record; a failure is logged, a missing container is not").
describe("the worker's Session Monitor for Delete (plan step 11C2a)", () => {
  const SOURCE = '0123456789abcdef0123456789abcdef';
  const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
  const TARGET = { kind: 'local', host: '', endpoint: '' } as const;

  function engineWith(answer: () => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>) {
    const execs: { container: string; command: readonly string[]; timeoutMs?: number }[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      exec: async (container, command, options = {}) => (execs.push({ container, command, timeoutMs: options.timeoutMs }), answer()),
    };
    return { engine, execs };
  }

  function log() {
    const lines: string[] = [];
    return { lines, logger: { ...silentLogger, warn: (text: string) => lines.push(`warn ${text}`) } as Logger };
  }

  it('forgets the record of the computer by the command of the monitor script, under the lock of its records, within its limit', async () => {
    const { engine, execs } = engineWith(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const { lines, logger } = log();
    await workerSessionMonitor(engine, SOURCE, logger).forget!(TARGET, ID);
    expect(execs).toEqual([{ container: REMOTE_MONITOR_CONTAINER, command: forgetCommand(SOURCE, ID), timeoutMs: MONITOR_EXEC_TIMEOUT_MS }]);
    expect(forgetCommand(SOURCE, ID).slice(-5)).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', SOURCE, ID]);
    expect(lines).toEqual([]);
  });

  it('a missing monitor container is not logged; a failure, a kill and no end in time are', async () => {
    const { lines, logger } = log();
    await workerSessionMonitor(engineWith(async () => Promise.reject(new EngineError('No such container', 404))).engine, SOURCE, logger).forget!(TARGET, ID);
    expect(lines).toEqual([]);
    await workerSessionMonitor(engineWith(async () => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false })).engine, SOURCE, logger).forget!(TARGET, ID);
    await workerSessionMonitor(engineWith(async () => ({ exitCode: RECORDS_RUN_LIMIT_EXIT, stdout: '', stderr: '', timedOut: false })).engine, SOURCE, logger).forget!(TARGET, ID);
    await workerSessionMonitor(engineWith(async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })).engine, SOURCE, logger).forget!(TARGET, ID);
    // Review round 1 of 11C2a (A-R1-L3): changed expectation, a monitor that does not run (idle) is not logged either.
    await workerSessionMonitor(engineWith(async () => Promise.reject(new EngineError('Container abc is not running', 409))).engine, SOURCE, logger).forget!(TARGET, ID);
    await workerSessionMonitor(engineWith(async () => Promise.reject(new EngineError('conflict', 409))).engine, SOURCE, logger).forget!(TARGET, ID);
    expect(lines).toEqual([
      `warn The heartbeat record of ${ID} could not be removed from the Session Monitor: boom`,
      `warn The heartbeat record of ${ID} could not be removed from the Session Monitor: the command was killed (its limit of 10 s, or a kill from outside)`,
      `warn The heartbeat record of ${ID} could not be removed from the Session Monitor: docker exec did not end within ${MONITOR_EXEC_TIMEOUT_MS / 1000} seconds.`,
      `warn The heartbeat record of ${ID} could not be removed from the Session Monitor: conflict`,
    ]);
  });

  it('without the computer of the operation, it refuses; the rest of the monitor fails closed before plan step 11D', async () => {
    const { engine, execs } = engineWith(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const monitor = workerSessionMonitor(engine, undefined, silentLogger);
    await expect(monitor.forget!(TARGET, ID)).rejects.toThrow('names no computer');
    // Plan step 11D1: changed, the ensure comes with 11D2, the first heartbeat of the open with the open (11E); the
    // heartbeats of a window are the operation `heartbeat` (before: both named 11D).
    await expect(monitor.ensure(TARGET, 'tag', undefined, undefined)).rejects.toThrow('before plan step 11D2');
    await expect(monitor.heartbeat(TARGET, ID, false, 1)).rejects.toThrow('before plan step 11E');
    expect(execs).toEqual([]);
  });

  it('the busy marks and the reopen record of the environment go to the extension as their requests', async () => {
    const calls: { call: string; args: unknown[] }[] = [];
    const records = {
      markBusy: async (...args: unknown[]) => (calls.push({ call: 'markBusy', args }), undefined),
      clearBusy: async (...args: unknown[]) => void calls.push({ call: 'clearBusy', args }),
      sessionFile: async (...args: unknown[]) => void calls.push({ call: 'sessionFile', args }),
    } as unknown as HostSide['records'];
    const marks = hostBusyMarks(records);
    expect(await marks.mark(ID, 'delete')).toBeUndefined();
    await marks.clear(ID);
    await hostSessionFiles({ records } as unknown as HostSide).removeReopenOf(ID);
    expect(calls).toEqual([
      { call: 'markBusy', args: [ID, 'delete'] },
      { call: 'clearBusy', args: [ID] },
      { call: 'sessionFile', args: ['removeReopenOf', ID] },
    ]);
  });
});
