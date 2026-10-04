// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C2b (decisions of 2026-10-03 and 2026-10-04): `deleteCheck`, run by the worker's own pipeline
// (workerServices) with a small engine in memory and a fake extension behind its handler (the requests of the check of
// Delete and its environment, as in the extension).
import { describe, expect, it } from 'vitest';
import { OP_DELETE_CHECK, parseDeleteCheckValue, type AskKind } from '../core/helperChannel/protocol';
import { LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID } from '../core/names';
import { silentLogger } from '../core/ports';
import type { Environment } from '../core/types';
import type { DockerEngine, EngineContainer } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { FLOW_REQUESTS, type HostSide } from '../core/worker/hostSide';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import type { OwnHelper } from '../core/worker/ownHelper';
import { deleteCheckOperation } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = 'devenv-acme-api-brave-noether';
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
const PARAMS = { environmentId: ID, dockerHost: '', owner: { windowId: 'window-1', pid: 4242 }, repository: 'Acme/API', otherWindow: true };

interface Setup {
  record?: Environment | null;
  /** The dev container runs (its Git state is read) or is missing. */
  container?: 'running' | 'missing';
  /** What the questions answer. */
  confirm?: unknown;
  volumes?: unknown;
  serviceData?: unknown;
}

function run(setup: Setup = {}, params: Record<string, unknown> = {}) {
  const asks: { kind: AskKind; call: string; args: unknown[] }[] = [];
  const execs: string[] = [];
  const record = setup.record === undefined ? ENVIRONMENT : setup.record;
  const answers: Record<string, unknown> = {
    get: record ?? undefined,
    read: { version: 1, environments: record === null ? [] : [record] },
    account: { id: '42', login: 'octo' },
    confirmDelete: setup.confirm === undefined ? 'delete' : setup.confirm,
    deleteAdditionalVolumes: setup.volumes === undefined ? 'remove' : setup.volumes,
    deleteServiceData: setup.serviceData === undefined ? [] : setup.serviceData,
  };
  const answer = (kind: AskKind) => (call: string) => async (...args: unknown[]) => (asks.push({ kind, call, args }), answers[call]);
  const of = (kind: AskKind, calls: string[]) => Object.fromEntries(calls.map((call) => [call, answer(kind)(call)]));
  const host = {
    records: of('record', ['get', 'read', 'recordGitSummary']),
    state: of('local', ['account']),
    questions: of('question', ['confirmDelete', 'deleteAdditionalVolumes', 'deleteServiceData']),
  } as unknown as HostSide;
  const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_DELETE_CHECK], { environmentId: ID });
  const controller = new AbortController();
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets({}, async (kind, payload) => (await handler(kind, payload, new AbortController().signal)).value),
    progress: () => {},
    log: () => {},
    output: () => {},
    docker: async () => {
      throw new Error('The check of Delete runs no Docker CLI call.');
    },
  };
  const containers: EngineContainer[] =
    setup.container === 'running' ? [{ id: 'c'.repeat(64), name: NAME, state: 'running', rawState: 'running', labels: { [LABEL_ENVIRONMENT_ID]: ID }, image: `${NAME}:1` }] : [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    version: async () => ({ apiVersion: '1.48', version: '29.0.0' }),
    containers: async () => containers,
    container: async (reference) => containers.find((c) => c.name === reference || c.id === reference),
    inspect: async (kind, reference) => {
      if (kind !== 'volume') return undefined;
      if (reference === NAME) return { Name: NAME, Labels: { [LABEL_ENVIRONMENT_ID]: ID } };
      return reference === 'api-cache' ? { Name: reference, Labels: { [LABEL_ENVIRONMENT_ID]: ID, [LABEL_OWNER_ID]: '42' } } : undefined;
    },
    exec: async (container, command) => (execs.push(`${container} ${command.join(' ')}`), { exitCode: 0, stdout: 'main\n2\n1\n0\n', stderr: '', timedOut: false }),
  };
  const operation = deleteCheckOperation(
    () => engine,
    async () => OWN,
    async () => {
      throw new Error('The check of Delete opens no batch helper.');
    },
  );
  return { result: operation({ ...PARAMS, ...params }, context), asks, execs, controller };
}

const calls = (asks: { kind: AskKind; call: string }[]) => asks.map((ask) => `${ask.kind} ${ask.call}`);

describe('deleteCheck in the worker (plan step 11C2b)', () => {
  it('reads the Git state in the running dev container, records it through the extension, and asks with the facts', async () => {
    const { result, asks, execs } = run({ container: 'running' });
    expect(parseDeleteCheckValue(await result)).toEqual({ decision: 'delete', additionalVolumesToRemove: [] });
    expect(execs).toHaveLength(1);
    const recorded = asks.find((ask) => ask.call === 'recordGitSummary');
    expect(recorded?.args[0]).toBe(ID);
    expect(recorded?.args[1]).toMatchObject({ branch: 'main', uncommittedFiles: 2, unpushedCommits: 1 });
    const confirm = asks.find((ask) => ask.call === 'confirmDelete');
    // Review round 1 of 11C2b (A-R1-M2): changed, the counts.
    expect(confirm?.args).toEqual(['Acme/API', expect.objectContaining({ changes: { uncommittedFiles: 2, unpushedCommits: 1, stashes: 0 }, otherWindow: true, repositoryData: [] })]);
    // Every request is one that the check of Delete may send.
    expect(new Set(calls(asks))).toEqual(new Set(['record get', 'local account', 'record recordGitSummary', 'question confirmDelete']));
  });

  it('answers the decision of the user: open, cancel, and the volumes to remove too', async () => {
    expect(await run({ confirm: 'open' }).result).toEqual({ decision: 'open' });
    expect(await run({ confirm: null }).result).toEqual({ decision: 'cancel' });
    // Its services are known (none), so its volume is an additional volume, not possibly data of a service (P3-4).
    const additional = { ...ENVIRONMENT, additionalVolumes: ['api-cache'], serviceVolumes: [] } as unknown as Environment;
    const removal = run({ record: additional });
    expect(await removal.result).toEqual({ decision: 'delete', additionalVolumesToRemove: ['api-cache'] });
    expect(removal.asks.find((ask) => ask.call === 'deleteAdditionalVolumes')?.args).toEqual([['api-cache']]);
    expect(calls(removal.asks)).toContain('record read');
    expect(await run({ record: additional, volumes: 'keep' }).result).toEqual({ decision: 'delete', additionalVolumesToRemove: [] });
    expect(await run({ record: additional, volumes: 'odd' }).result).toEqual({ decision: 'cancel' });
  });

  it('an environment that does not exist is not deleted, and nothing is asked', async () => {
    const { result, asks } = run({ record: null });
    expect(await result).toEqual({ decision: 'cancel' });
    expect(calls(asks)).toEqual(['record get']);
  });

  it('refuses parameters that do not fit before anything runs', async () => {
    for (const odd of [{ repository: '' }, { repository: 'a\nb' }, { otherWindow: 'yes' }, { extra: 1 }]) {
      const { result, asks } = run({}, odd);
      await expect(result, JSON.stringify(odd)).rejects.toMatchObject({ code: 'invalid' });
      expect(asks).toEqual([]);
    }
  });

  // Review: an environment whose services are not known offers its volumes as possible data of services (P3-4).
  it('offers the volumes of an environment whose services are not known as possible data of services', async () => {
    const unknown = { ...ENVIRONMENT, additionalVolumes: ['api-cache'] } as Environment;
    const check = run({ record: unknown, serviceData: ['api-cache'] });
    expect(await check.result).toEqual({ decision: 'delete', additionalVolumesToRemove: ['api-cache'] });
    expect(check.asks.find((ask) => ask.call === 'deleteServiceData')?.args).toEqual([['api-cache'], ['api-cache']]);
  });
});
