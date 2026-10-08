// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C2a (decisions of 2026-10-03 and 2026-10-04): `delete`, run by the worker's own pipeline (workerServices)
// with a small engine in memory, a fake extension (its requests), and a fake flock.
import { describe, expect, it } from 'vitest';
import { LOCK_BUSY_EXIT, OP_DELETE, parseDeleteValue, type AskKind } from '../core/helperChannel/protocol';
import { LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID } from '../core/names';
import { silentLogger } from '../core/ports';
import { FLOW_REQUESTS } from '../core/worker/hostSide';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import { REMOTE_MONITOR_CONTAINER } from '../core/remoteMonitor/protocol';
import { scriptCommand } from '../core/worker/containerScripts';
import type { BusyMark, Environment } from '../core/types';
import { EngineError, type DockerEngine, type EngineContainer } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { OwnHelper } from '../core/worker/ownHelper';
import { deleteOperation } from './flowOperations';
import type { FlockProcess } from '../core/helperChannel/lockFile';
import type { LockDeps } from './lock';
import { contextSecrets } from './operationContext.testkit';
import type { HostSide } from '../core/worker/hostSide';
import { OperationError, type OperationContext } from './server';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = 'devenv-acme-api-brave-noether';
const SOURCE = '0123456789abcdef0123456789abcdef';
const ENVIRONMENT = {
  id: ID,
  repository: 'acme/api',
  owner: { id: '42', login: 'octo' },
  volumeName: NAME,
  containerName: NAME,
  configPath: '.devcontainer/devcontainer.json',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: '2026-10-01T00:00:00.000Z',
} as unknown as Environment;
const OWN: OwnHelper = { image: { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const PARAMS = { environmentId: ID, dockerHost: '', owner: { windowId: 'window-1', pid: 4242 }, additionalVolumesToRemove: [] as string[], monitorSource: SOURCE };
const OTHER_MARK: BusyMark = { operation: 'update', since: '2026-10-04T10:00:00.000Z', pid: 7, windowId: 'window-2' };

interface Setup {
  /** The record that `record get` answers (null: none). */
  record?: Environment | null;
  /** The account that `local account` answers (null: no one signed in). */
  account?: { id: string; login: string } | null;
  /** What `record markBusy` answers each time (default: the entry with the mark). */
  markBusy?: () => unknown;
  /** The exit code of flock. */
  flockExit?: number;
  /** The dev container runs (default) or is missing. */
  container?: 'running' | 'missing';
  /** The labels of the workspace volume (null: missing). */
  volumeLabels?: Record<string, string> | null;
  /** The removal of the workspace volume fails. */
  volumeRemoveFails?: boolean;
  /** The Session Monitor command fails with this error. */
  forgetFails?: Error;
  /** Review round 1 (A-R1-H1): an additional volume of the environment, its own by its labels. */
  additional?: string;
}

function run(setup: Setup = {}, params: Record<string, unknown> = {}) {
  const asks: { kind: AskKind; call: string; args: unknown[] }[] = [];
  const engineCalls: string[] = [];
  const events: string[] = [];
  const controller = new AbortController();
  const record = setup.record === undefined ? (setup.additional ? { ...ENVIRONMENT, additionalVolumes: [setup.additional] } : ENVIRONMENT) : setup.record;
  // Review round 1 (A-R1-H1): the requests go through the handler of the extension with the requests of Delete and its
  // environment, as they do in the extension.
  const answer = (kind: AskKind, call: string, args: unknown[]): unknown => {
    asks.push({ kind, call, args });
    if (call === 'get') return record ?? undefined;
    if (call === 'list') return record === null ? [] : [record];
    if (call === 'read') return { version: 1, environments: record === null ? [] : [record] };
    if (call === 'account') return setup.account === undefined ? { id: '42', login: 'octo' } : (setup.account ?? undefined);
    if (call === 'markBusy') return setup.markBusy ? setup.markBusy() : { environment: { ...record, busy: { operation: 'delete', since: 't', pid: 4242, windowId: 'window-1' } } };
    return undefined;
  };
  const host = {
    records: Object.fromEntries(['get', 'list', 'read', 'markBusy', 'clearBusy', 'remove', 'sessionFile'].map((call) => [call, async (...args: unknown[]) => answer('record', call, args)])),
    state: { account: async (...args: unknown[]) => answer('local', 'account', args) },
  } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_DELETE], { environmentId: (params.environmentId as string | undefined) ?? ID });
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets({}, async (kind, payload) => (await handler(kind, payload, new AbortController().signal)).value),
    progress: (step) => events.push(`progress ${step}`),
    log: () => {},
    output: () => {},
  };
  const containers: EngineContainer[] =
    setup.container === 'missing' ? [] : [{ id: 'c'.repeat(64), name: NAME, state: 'running', rawState: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ID }, image: `${NAME}:1` }];
  const volumeLabels = setup.volumeLabels === undefined ? { [LABEL_ENVIRONMENT_ID]: ID } : setup.volumeLabels;
  const engine: DockerEngine = {
    ...unusedEngine(),
    version: async () => ({ apiVersion: '1.48', version: '29.0.0' }),
    containers: async (label) => (engineCalls.push(`containers ${label}`), containers.filter((c) => label === LABEL_ENVIRONMENT_ID || label === `${LABEL_ENVIRONMENT_ID}=${ID}`)),
    container: async (reference) => containers.find((c) => c.name === reference || c.id === reference),
    containerIds: async () => [],
    stop: async (container) => void engineCalls.push(`stop ${container}`),
    removeContainer: async (container) => {
      engineCalls.push(`removeContainer ${container}`);
      const at = containers.findIndex((c) => c.name === container || c.id === container);
      if (at >= 0) containers.splice(at, 1);
    },
    images: async () => [],
    removeImage: async (reference) => (engineCalls.push(`removeImage ${reference}`), 'missing'),
    volumeNames: async () => [],
    networkNames: async () => [],
    inspect: async (kind, reference) => {
      if (kind !== 'volume') return undefined;
      if (reference === NAME && volumeLabels !== null) return { Name: NAME, Labels: volumeLabels };
      return reference === setup.additional ? { Name: reference, Labels: { [LABEL_ENVIRONMENT_ID]: ID, [LABEL_OWNER_ID]: '42' } } : undefined;
    },
    removeVolume: async (name) => {
      engineCalls.push(`removeVolume ${name}`);
      if (setup.volumeRemoveFails) throw new EngineError('volume is in use', 409);
    },
    exec: async (container, command) => {
      engineCalls.push(`exec ${container} ${command.join(' ')}`);
      if (setup.forgetFails) throw setup.forgetFails;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
  };
  const lockDeps: LockDeps = {
    stateDir: '/state',
    openLockFile: (_dir, id) => (events.push(`lock ${id}`), 7),
    closeFile: () => events.push('unlock'),
    startFlock: (): FlockProcess => ({ exited: Promise.resolve({ exitCode: setup.flockExit ?? 0 }), kill: () => {} }),
  };
  const operation = deleteOperation(
    () => engine,
    async () => OWN,
    async () => {
      throw new Error('Delete opens no batch helper.');
    },
    lockDeps,
  );
  return { result: operation({ ...PARAMS, ...params }, context), asks, engineCalls, events, controller };
}

const calls = (asks: { kind: AskKind; call: string; args: unknown[] }[]) => asks.map((ask) => `${ask.kind} ${ask.call}`);

describe('delete in the worker (plan step 11C2a)', () => {
  it('marks the environment busy through the extension, removes it under the lock, removes its entry and files, and forgets its record', async () => {
    const { result, asks, engineCalls, events } = run();
    expect(parseDeleteValue(await result)).toEqual({ deleted: true });
    // The busy mark is the extension's (decision of 2026-10-04); the entry and the session files of this environment only.
    // Plan step 11E4b: changed, the handler of the extension passes the listener of the mark that the busy mark replaced
    // (for `record createMark` `previous`) to its HostSide (before: the two arguments of the request only).
    expect(asks.find((ask) => ask.call === 'markBusy')).toEqual({ kind: 'record', call: 'markBusy', args: [ID, 'delete', expect.any(Function)] });
    expect(asks.find((ask) => ask.call === 'remove')).toEqual({ kind: 'record', call: 'remove', args: [ID, { kept: [], removed: [] }] });
    expect(asks.filter((ask) => ask.call === 'sessionFile').map((ask) => ask.args)).toEqual([
      ['removePending', ID],
      ['removeOperation', ID],
      ['removeDisconnectRequest', ID],
      ['removeReopenOf', ID],
    ]);
    // A Delete that removed the entry clears no mark (the entry is gone).
    expect(calls(asks)).not.toContain('record clearBusy');
    // Every request is one that Delete may send.
    expect(new Set(calls(asks))).toEqual(new Set(['record get', 'local account', 'record markBusy', 'record remove', 'record sessionFile']));
    // Under the lock: the dev container stopped and removed, the volume removed; then the record of the computer forgotten
    // in the Session Monitor of the engine.
    expect(events[0]).toBe('progress delete');
    expect(events).toContain(`lock ${ID}`);
    expect(events.at(-1)).toBe('unlock');
    expect(engineCalls).toContain(`stop ${'c'.repeat(64)}`);
    expect(engineCalls).toContain(`removeVolume ${NAME}`);
    // Plan step 11I (U2, decision of 2026-10-08): the command of the entry monitorForget (forgetCommand before).
    expect(engineCalls.at(-1)).toBe(`exec ${REMOTE_MONITOR_CONTAINER} ${scriptCommand('monitorForget', [SOURCE, ID]).join(' ')}`);
  });

  it('waits while another window holds a live mark, and refuses when it keeps it; nothing is removed then', async () => {
    let answers = 0;
    const holder: { controller?: AbortController } = {};
    // The wait of the pipeline is long (busyWaitMs); a cancel during it ends the Delete before anything is removed.
    const busy = run({ markBusy: () => (answers++, holder.controller?.abort(), { conflict: OTHER_MARK }) });
    holder.controller = busy.controller;
    await expect(busy.result).rejects.toMatchObject({ code: 'cancelled' });
    expect(answers).toBe(1);
    expect(busy.engineCalls.filter((call) => call.startsWith('remove') || call.startsWith('stop'))).toEqual([]);
    expect(calls(busy.asks)).not.toContain('record remove');
  });

  it('answers the refusals of the pipeline with their code; a refusal after the mark clears it', async () => {
    const cases: [Setup, string][] = [
      [{ account: null }, 'signInRequired'],
      [{ account: { id: '7', login: 'other' } }, 'otherAccount'],
      [{ flockExit: LOCK_BUSY_EXIT }, 'startFailed'],
      [{ flockExit: 1 }, 'helperFailed'],
    ];
    for (const [setup, code] of cases) {
      const { result, engineCalls } = run(setup);
      expect(parseDeleteValue(await result), JSON.stringify(setup)).toMatchObject({ refused: { code } });
      expect(engineCalls.filter((call) => call.startsWith('remove')), JSON.stringify(setup)).toEqual([]);
    }
    const locked = run({ flockExit: LOCK_BUSY_EXIT });
    await locked.result;
    expect(locked.asks.filter((ask) => ask.call === 'clearBusy')).toEqual([{ kind: 'record', call: 'clearBusy', args: [ID] }]);
    // A record of another Docker host is refused (the host of the operation is a parameter).
    expect(await run({ record: { ...ENVIRONMENT, dockerHost: 'build-box' } as Environment }).result).toMatchObject({ refused: { code: 'otherDockerHost' } });
    // A volume that belongs to another environment: nothing of its name is removed.
    const foreign = run({ volumeLabels: { [LABEL_ENVIRONMENT_ID]: 'another-environment' }, container: 'missing' });
    expect(await foreign.result).toEqual({ deleted: true });
    expect(foreign.engineCalls.filter((call) => call.startsWith('remove'))).toEqual([]);
  });

  it('a failed removal fails the operation, clears the mark, and keeps the entry', async () => {
    const failing = run({ volumeRemoveFails: true });
    await expect(failing.result).rejects.toMatchObject({ code: 'failed' });
    expect(calls(failing.asks)).toContain('record clearBusy');
    expect(calls(failing.asks)).not.toContain('record remove');
    expect(failing.events.at(-1)).toBe('unlock');
  });

  // Review round 1 of 11C2a (A-R1-H1): the additional volumes that the user confirmed are removed and the entry records
  // them as removed; the registry is read for the volumes of the other environments.
  it('removes a confirmed additional volume of the environment, with the requests that Delete may send', async () => {
    const { result, asks, engineCalls } = run({ additional: 'api-cache' }, { additionalVolumesToRemove: ['api-cache'] });
    expect(await result).toEqual({ deleted: true });
    expect(engineCalls).toContain('removeVolume api-cache');
    expect(asks.find((ask) => ask.call === 'remove')).toEqual({ kind: 'record', call: 'remove', args: [ID, { kept: [], removed: ['api-cache'] }] });
    expect(calls(asks)).toContain('record read');
  });

  it('a Session Monitor that cannot forget does not fail the Delete', async () => {
    expect(await run({ forgetFails: new EngineError('No such container: devenv-session-monitor', 404) }).result).toEqual({ deleted: true });
    expect(await run({ forgetFails: new Error('the socket closed') }).result).toEqual({ deleted: true });
  });

  it('an environment that does not exist only loses its session files', async () => {
    const { result, asks, engineCalls } = run({ record: null });
    expect(await result).toEqual({ deleted: true });
    expect(calls(asks).filter((call) => call !== 'record get' && call !== 'record sessionFile')).toEqual([]);
    expect(engineCalls).toEqual([]);
  });

  it('refuses parameters that do not fit, and any secret, before anything runs', async () => {
    for (const odd of [
      { monitorSource: 'not-a-computer' },
      { additionalVolumesToRemove: ['../x'] },
      { additionalVolumesToRemove: 'v1' },
      { owner: { windowId: 'window-1', pid: 0 } },
      { extra: 1 },
    ]) {
      const { result, asks } = run({}, odd);
      await expect(result, JSON.stringify(odd)).rejects.toMatchObject({ code: 'invalid' });
      expect(asks).toEqual([]);
    }
    const operation = deleteOperation(
      () => unusedEngine(),
      async () => OWN,
      async () => {
        throw new Error('no batch');
      },
    );
    const context = { signal: new AbortController().signal, ...contextSecrets({ token: 'ghs_x' }), progress: () => {}, log: () => {}, output: () => {} } as unknown as OperationContext;
    await expect(operation(PARAMS, context)).rejects.toMatchObject({ code: 'invalid', message: 'The delete operation takes no secret.' });
  });
});
