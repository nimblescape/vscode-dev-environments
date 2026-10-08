// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11C2a (mutation tests, B-R1): the worker's `delete`: confirmed volumes, the Docker host of the operation, a failure to read the worker's own helper image.

// Plan step 11C2a (decisions of 2026-10-03 and 2026-10-04): `delete`, run by the worker's own pipeline (workerServices)
// with a small engine in memory, a fake extension (its requests), and a fake flock.
import { describe, expect, it } from 'vitest';
import { LOCK_BUSY_EXIT, LOCK_UNAVAILABLE_CODE, parseDeleteValue, type AskKind } from '../core/helperChannel/protocol';
import { LABEL_ENVIRONMENT_ID } from '../core/names';
import { REMOTE_MONITOR_CONTAINER, forgetCommand } from '../core/remoteMonitor/protocol';
import type { BusyMark, Environment } from '../core/types';
import { EngineError, type DockerEngine, type EngineContainer } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { OwnHelper } from '../core/worker/ownHelper';
import { deleteOperation } from './flowOperations';
import { FLOW_REQUESTS } from '../core/worker/hostSide';
import { OP_DELETE } from '../core/helperChannel/protocol';
import type { FlockProcess } from '../core/helperChannel/lockFile';
import type { LockDeps } from './lock';
import { contextSecrets } from './operationContext.testkit';
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
}

function run(setup: Setup = {}, params: Record<string, unknown> = {}) {
  const asks: { kind: AskKind; call: string; args: unknown[] }[] = [];
  const engineCalls: string[] = [];
  const events: string[] = [];
  const controller = new AbortController();
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets({}, async (kind, payload) => {
      const { call, args } = payload as { call: string; args: unknown[] };
      asks.push({ kind, call, args });
      if (kind === 'record' && call === 'get') return setup.record === undefined ? ENVIRONMENT : setup.record;
      // Probe C1: `record read` (removableVolumes reads the registry file), which FLOW_REQUESTS[OP_DELETE] does not allow.
      if (kind === 'record' && call === 'read') return { version: 1, environments: [setup.record ?? ENVIRONMENT], keptVolumes: [] };
      if (kind === 'record' && call === 'list') return setup.record === null ? [] : [setup.record ?? ENVIRONMENT];
      if (kind === 'local' && call === 'account') return setup.account === undefined ? { id: '42', login: 'octo' } : setup.account;
      if (kind === 'record' && call === 'markBusy') return setup.markBusy ? setup.markBusy() : { environment: { ...ENVIRONMENT, busy: { operation: 'delete', since: 't', pid: 4242, windowId: 'window-1' } } };
      if (kind === 'record' && (call === 'clearBusy' || call === 'remove' || call === 'sessionFile')) return null;
      throw new OperationError('invalid', `The operation may not send the request ${kind} ${call}.`);
    }),
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
    inspect: async (kind, reference) => (kind === 'volume' && reference === 'api-db' ? { Name: 'api-db', Labels: { [LABEL_ENVIRONMENT_ID]: ID, 'nimblescape.devenv.repository': 'acme/api', 'nimblescape.devenv.volume': 'additional', 'nimblescape.devenv.owner-id': '42' } } : kind === 'volume' && reference === NAME && volumeLabels !== null ? { Name: NAME, Labels: volumeLabels } : undefined),
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


describe('the worker\'s delete: review round 1 of 11C2a (mutation tests)', () => {
  it('removes the confirmed additional volumes (F7)', async () => {
    const record = { ...ENVIRONMENT, additionalVolumes: ['api-db'] } as Environment;
    const markBusy = () => ({ environment: { ...record, busy: { operation: 'delete', since: 't', pid: 4242, windowId: 'window-1' } } });
    const { result, engineCalls, asks } = run({ record, markBusy }, { additionalVolumesToRemove: ['api-db'] });
    expect(await result).toEqual({ deleted: true });
    expect(engineCalls).toContain('removeVolume api-db');
    expect(asks.find((ask) => ask.call === 'remove')?.args).toEqual([ID, { kept: [], removed: ['api-db'] }]);
  });

  // A-R1-H1 (fixed): every request of a Delete with confirmed volumes is one that the extension answers.
  it('every request of a Delete with confirmed volumes is one that the extension answers (A-R1-H1)', async () => {
    const record = { ...ENVIRONMENT, additionalVolumes: ['api-db'] } as Environment;
    const markBusy = () => ({ environment: { ...record, busy: { operation: 'delete', since: 't', pid: 4242, windowId: 'window-1' } } });
    const { result, asks } = run({ record, markBusy }, { additionalVolumesToRemove: ['api-db'] });
    await result;
    // Review round 1 (A-R1-L1, A-R1-L4): an allowance may name the kind of the request (`record markBusy.delete`).
    const allowed = (ask: { kind: AskKind; call: string; args: unknown[] }) => {
      const name = `${ask.kind} ${ask.call}`;
      const detail = ask.call === 'sessionFile' ? ask.args[0] : ask.call === 'markBusy' ? ask.args[1] : undefined;
      return FLOW_REQUESTS[OP_DELETE].includes(name as never) || FLOW_REQUESTS[OP_DELETE].includes(`${name}.${String(detail)}` as never);
    };
    expect(asks.filter((ask) => !allowed(ask)).map((ask) => `${ask.kind} ${ask.call}`)).toEqual([]);
    expect(calls(asks)).toContain('record read');
  });

  it('deletes on the Docker host of the operation (F10)', async () => {
    const record = { ...ENVIRONMENT, dockerHost: 'build-box' } as Environment;
    const markBusy = () => ({ environment: { ...record, busy: { operation: 'delete', since: 't', pid: 4242, windowId: 'window-1' } } });
    const { result } = run({ record, markBusy }, { dockerHost: 'build-box' });
    expect(await result).toEqual({ deleted: true });
  });

  it('a helper image that cannot be read is refused as a lock that cannot be taken; cancelled when the operation ended (F12, F4)', async () => {
    const operation = deleteOperation(
      () => unusedEngine(),
      async () => {
        throw new Error('no image');
      },
      async () => {
        throw new Error('no batch');
      },
    );
    const controller = new AbortController();
    const context = { signal: controller.signal, ...contextSecrets({}), progress: () => {}, log: () => {}, output: () => {} } as unknown as OperationContext;
    await expect(operation(PARAMS, context)).rejects.toMatchObject({ code: LOCK_UNAVAILABLE_CODE });
    controller.abort();
    await expect(operation(PARAMS, context)).rejects.toMatchObject({ code: 'cancelled' });
  });
});
