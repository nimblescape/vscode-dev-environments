// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3b (user decision of 2026-10-04): `listConfigurations`, run by the worker's own pipeline (workerServices)
// with a fake engine, a fake extension (its requests), a fake flock, and a fake batch session; the extension's side
// (EnvironmentService.listConfigurationsInWorker) with a fake flow.
import { describe, expect, it } from 'vitest';
import type { HelperBatchSession } from '../core/helperChannel/helperChannel';
import { LOCK_BUSY_EXIT, LOCK_UNAVAILABLE_CODE, parseListConfigurationsValue, type AskKind } from '../core/helperChannel/protocol';
import { LABEL_ENVIRONMENT_ID } from '../core/names';
import type { RunResult } from '../core/ports';
import type { Environment } from '../core/types';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { OwnHelper } from '../core/worker/ownHelper';
import { listConfigurationsOperation, type OpenWorkerBatch } from './flowOperations';
import type { FlockProcess, LockDeps } from './lock';
import { contextSecrets } from './operationContext.testkit';
import { OperationError, type OperationContext } from './server';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const VOLUME = 'devenv-acme-api-brave-noether';
const ENVIRONMENT = {
  id: ID,
  repository: 'acme/api',
  owner: { id: '42', login: 'octo' },
  volumeName: VOLUME,
  containerName: VOLUME,
  configPath: '.devcontainer/devcontainer.json',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: '2026-10-01T00:00:00.000Z',
} as unknown as Environment;
const OWN: OwnHelper = { image: { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const PARAMS = { environmentId: ID, dockerHost: '', owner: { windowId: 'window-1', pid: 4242 } };
const PATHS = ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'];

interface Setup {
  /** The record that `record get` answers (null: none). */
  record?: Environment | null;
  /** The account that `local account` answers (null: no one signed in). */
  account?: { id: string; login: string } | null;
  /** The labels of the volume (null: the volume is missing). */
  volumeLabels?: Record<string, string> | null;
  /** The exit code of flock. */
  flockExit?: number;
  /** The result of the step listConfigs, or the failure of the session's open. */
  step?: RunResult;
  openFails?: Error;
  /** Called when the step runs (before its result). */
  onStep?: (controller: AbortController) => void;
}

function run(setup: Setup = {}) {
  const asks: { kind: AskKind; payload: unknown }[] = [];
  const events: string[] = [];
  const opened: { volume: string; image: string; socket: string }[] = [];
  const steps: { kind: string; params: unknown }[] = [];
  const controller = new AbortController();
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets({}, async (kind, payload) => {
      asks.push({ kind, payload });
      const call = (payload as { call: string }).call;
      if (kind === 'record' && call === 'get') return setup.record === undefined ? ENVIRONMENT : setup.record;
      if (kind === 'local' && call === 'account') return setup.account === undefined ? { id: '42', login: 'octo' } : setup.account;
      throw new OperationError('invalid', `The operation may not send the request ${kind} ${call}.`);
    }),
    progress: (step) => events.push(`progress ${step}`),
    log: () => {},
    output: () => {},
    docker: async () => {
      throw new Error('The listing runs no Docker CLI call.');
    },
  };
  const volumeLabels = setup.volumeLabels === undefined ? { [LABEL_ENVIRONMENT_ID]: ID } : setup.volumeLabels;
  const engine: DockerEngine = {
    ...unusedEngine(),
    version: async () => ({ apiVersion: '1.48', version: '29.0.0' }),
    inspect: async (kind, reference) => (kind === 'volume' && reference === VOLUME && volumeLabels !== null ? { Name: VOLUME, Labels: volumeLabels } : undefined),
  };
  const lockDeps: LockDeps = {
    stateDir: '/state',
    openLockFile: (_dir, id) => (events.push(`lock ${id}`), 7),
    closeFile: () => events.push('unlock'),
    startFlock: (): FlockProcess => ({ exited: Promise.resolve({ exitCode: setup.flockExit ?? 0 }), kill: () => {} }),
  };
  const openBatch: OpenWorkerBatch = async (_context, p) => {
    opened.push(p);
    if (setup.openFails !== undefined) throw setup.openFails;
    const session: HelperBatchSession = {
      session: 'b'.repeat(24),
      lost: new Promise(() => {}),
      step: async (kind, params, options) => {
        steps.push({ kind, params });
        events.push(`step ${kind}`);
        setup.onStep?.(controller);
        // As the session: a cancel of the operation ends the step with an AbortError.
        if (options?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return setup.step ?? { exitCode: 0, stdout: `${JSON.stringify(PATHS)}\n`, stderr: '', timedOut: false };
      },
      close: async () => void events.push('close batch'),
    };
    return session;
  };
  const operation = listConfigurationsOperation(
    () => engine,
    async () => OWN,
    openBatch,
    lockDeps,
  );
  return { result: operation(PARAMS, context), asks, events, opened, steps, controller };
}

describe('listConfigurations in the worker (plan step 11B3b)', () => {
  it('lists the configurations in the batch helper of the worker under the lock, from the record and the account of the extension', async () => {
    const { result, asks, events, opened, steps } = run();
    const value = await result;
    expect(value).toEqual({ configPaths: PATHS });
    expect(parseListConfigurationsValue(value)).toEqual({ configPaths: PATHS });
    expect(asks).toEqual([
      { kind: 'record', payload: { call: 'get', args: [ID] } },
      { kind: 'local', payload: { call: 'account', args: [true] } },
    ]);
    // The helper of the batch is the worker's own image (its ID) with its socket; nothing was built.
    expect(opened).toEqual([{ volume: VOLUME, image: OWN.image.id, socket: OWN.socket }]);
    expect(steps).toEqual([{ kind: 'listConfigs', params: { repository: 'acme/api' } }]);
    // The session closes before the lock is let go.
    expect(events).toEqual(['progress listConfigurations', `lock ${ID}`, 'step listConfigs', 'close batch', 'unlock']);
  });

  it('answers the refusals of the pipeline with their code, and changes nothing', async () => {
    const cases: [Setup, string][] = [
      [{ account: null }, 'signInRequired'],
      [{ account: { id: '7', login: 'other' } }, 'otherAccount'],
      [{ volumeLabels: null }, 'filesMissing'],
      [{ volumeLabels: { [LABEL_ENVIRONMENT_ID]: 'another-environment' } }, 'startFailed'],
      [{ flockExit: LOCK_BUSY_EXIT }, 'startFailed'],
      [{ flockExit: 1 }, 'helperFailed'],
      [{ openFails: new Error('the helper did not start') }, 'helperFailed'],
    ];
    for (const [setup, code] of cases) {
      const { result, steps, events } = run(setup);
      const value = await result;
      expect(parseListConfigurationsValue(value), JSON.stringify(setup)).toMatchObject({ refused: { code } });
      expect(steps).toEqual([]);
      // Review round 1 of 11B3b (missing test): a lock that was taken is let go at the end of a refusal too.
      if (events.includes(`lock ${ID}`) && setup.flockExit === undefined) expect(events.at(-1)).toBe('unlock');
    }
    // The refusal of the batch scope keeps its kind.
    expect(await run({ openFails: new Error('the helper did not start') }).result).toMatchObject({ refused: { code: 'helperFailed', batchHelperUnavailable: true } });
    // A record of another Docker host is refused (the host of the operation is a parameter).
    expect(await run({ record: { ...ENVIRONMENT, dockerHost: 'build-box' } as Environment }).result).toMatchObject({ refused: { code: 'otherDockerHost' } });
  });

  it('an environment that does not exist lists nothing; a failed step fails the operation; a cancel is cancelled', async () => {
    expect(await run({ record: null }).result).toEqual({ configPaths: [] });
    const failing = run({ step: { exitCode: 2, stdout: '', stderr: 'jq: error', timedOut: false } });
    await expect(failing.result).rejects.toMatchObject({ code: 'failed' });
    expect(failing.events.slice(-2)).toEqual(['close batch', 'unlock']);
    const cancelled = run();
    cancelled.controller.abort();
    await expect(cancelled.result).rejects.toMatchObject({ code: 'cancelled' });
    // Review round 1 of 11B3b (missing test): a cancel during the step closes the batch helper, then lets go of the lock.
    const during = run({ onStep: (controller) => controller.abort() });
    await expect(during.result).rejects.toMatchObject({ code: 'cancelled' });
    // (Closed when the lock is lost with the operation, and again at the end of the scope: close is idempotent.)
    const afterStep = during.events.slice(during.events.indexOf('step listConfigs') + 1);
    expect(afterStep.at(-1)).toBe('unlock');
    expect(new Set(afterStep.slice(0, -1))).toEqual(new Set(['close batch']));
  });

  it('refuses parameters that do not fit, and any secret, before anything runs', async () => {
    const operation = listConfigurationsOperation(
      () => unusedEngine(),
      async () => OWN,
      async () => {
        throw new Error('no batch');
      },
    );
    const context = { signal: new AbortController().signal, ...contextSecrets({}), progress: () => {}, log: () => {}, output: () => {}, docker: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } as unknown as OperationContext;
    for (const params of [{}, { ...PARAMS, environmentId: 'x/y' }, { ...PARAMS, owner: { windowId: 'w', pid: 0 } }, { ...PARAMS, dockerHost: 'a\nb' }, { ...PARAMS, extra: 1 }]) {
      await expect(operation(params, context)).rejects.toMatchObject({ code: 'invalid' });
    }
    const withSecret = { ...context, ...contextSecrets({ token: 'ghp_x' }) } as OperationContext;
    await expect(operation(PARAMS, withSecret)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a helper image of the worker that cannot be read changes nothing (lockUnavailable)', async () => {
    const operation = listConfigurationsOperation(
      () => unusedEngine(),
      async () => {
        throw new Error('no socket mount');
      },
      async () => {
        throw new Error('no batch');
      },
    );
    const context = { signal: new AbortController().signal, ...contextSecrets({}), progress: () => {}, log: () => {}, output: () => {}, docker: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } as unknown as OperationContext;
    await expect(operation(PARAMS, context)).rejects.toMatchObject({ code: LOCK_UNAVAILABLE_CODE, message: expect.stringContaining('no socket mount') });
  });
});
