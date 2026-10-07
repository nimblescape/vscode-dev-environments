// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E6 (decisions of 2026-10-03 and 2026-10-04; A1 and D1 of 2026-10-05): the open from the extension's side:
// it signs in and starts the local Docker here, sends `open` to the worker of the Docker host of the operation with the
// settings, the image maintenance and the image list, shows the steps of the worker, and answers with the entry of the
// environment that the worker opened (A1: the window connects after the lock is released). A worker that ended without
// its answer could not clean up here: this window does (review round 1 of PR #107, A-L2: the lifecycle as unknown).
import type { EnvironmentOperationsDeps } from './environmentOperations';
import type { OperationFlow } from './environmentOperations';
import { describe, expect, it, vi } from 'vitest';
import { UserFacingError } from '../errors';
import { HelperChannelError } from '../helperChannel/helperChannel';
import { OP_OPEN, OPEN_PROGRESS_DETAIL } from '../helperChannel/protocol';
import { OPEN_FLOW_TIMEOUT_MS, type EnvironmentServiceDeps } from './environmentService';
import { ENV_ID, OTHER_ACCOUNT, OTHER_ID, PID, REPO, WINDOW_ID, createHarness, seedEnvironment } from './environmentService.testkit';
import { LIFECYCLE_UNKNOWN, windowLifecycleMemory } from './lifecycleMemory';
import type { BusyMark } from '../types';

type FlowOptions = Parameters<OperationFlow>[2];

const SOURCE = '0123456789abcdef0123456789abcdef';
const IMAGES = { prefixes: ['ghcr.io/acme/base'], schedule: '7 6 * * *', timeZone: 'UTC' };
const OPENED = { environmentId: ENV_ID, containerName: 'devenv-acme-api-c', remoteWorkspaceFolder: '/workspaces/api' };

function harness(answer: (op: string, params: unknown, options: FlowOptions) => Promise<unknown>, overrides: Partial<EnvironmentServiceDeps & EnvironmentOperationsDeps> = {}) {
  const sent: { op: string; params: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal }[] = [];
  const listSent = vi.fn();
  const memory = windowLifecycleMemory();
  const h = createHarness({
    monitorSource: () => SOURCE,
    openMonitor: () => ({ images: IMAGES, repositories: ['ghcr.io/acme/app'], listSent }),
    lifecycleMemory: memory,
    ...overrides,
    flow: async (op, params, options) => {
      sent.push({ op, params: params as Record<string, unknown>, timeoutMs: options.timeoutMs, signal: options.signal });
      return answer(op, params, options);
    },
  });
  return { h, sent, listSent, memory };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => ({ resolved: value }),
    (error: unknown) => error,
  );
}

const own = (operation: BusyMark['operation']): BusyMark => ({ operation, since: new Date().toISOString(), pid: PID, windowId: WINDOW_ID });

describe('the open in the worker, from the extension (plan step 11E6)', () => {
  it('sends the environment with the settings and the image maintenance, and answers with its entry', async () => {
    const { h, sent, listSent } = harness(async () => ({ opened: OPENED, imageListSent: true }));
    const seeded = await seedEnvironment(h, { container: 'stopped' });
    const controller = new AbortController();
    const result = await h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress, signal: controller.signal, forceRebuild: true, configPath: 'b/devcontainer.json' });
    expect(result).toEqual({ environment: await h.registry.get(ENV_ID), containerName: OPENED.containerName, remoteWorkspaceFolder: OPENED.remoteWorkspaceFolder });
    expect(result.environment.id).toBe(seeded.id);
    expect(sent).toEqual([
      {
        op: OP_OPEN,
        params: {
          dockerHost: '',
          owner: { windowId: WINDOW_ID, pid: PID },
          monitorSource: SOURCE,
          settings: { updateImagesOnConnect: true, hostAccessChecks: 'on', waitingTimeSeconds: 30, stopOnClose: true, respectShutdownActionNone: false },
          images: IMAGES,
          repositories: ['ghcr.io/acme/app'],
          repository: REPO,
          environmentId: ENV_ID,
          forceRebuild: true,
          configPath: 'b/devcontainer.json',
        },
        timeoutMs: OPEN_FLOW_TIMEOUT_MS,
        signal: controller.signal,
      },
    ]);
    // The monitor took the list; nothing of the pipeline ran here.
    expect(listSent).toHaveBeenCalledTimes(1);
    expect(h.helper.calls).toEqual([]);
    expect(h.lock.acquired).toEqual([]);
  });

  it('the open of a repository: its target, and the environment that the worker found or created for the account', async () => {
    let answer: unknown = { opened: OPENED };
    const { h, sent, listSent } = harness(async () => answer);
    await seedEnvironment(h, { container: 'stopped' });
    const target = { repository: REPO, defaultBranch: null, configPaths: ['.devcontainer/devcontainer.json'], trusted: true };
    expect((await h.operations.openInWorker(target, { progress: h.progress })).environment.id).toBe(ENV_ID);
    expect(sent[0].params).toMatchObject({ repository: REPO, target: { defaultBranch: null, configPaths: ['.devcontainer/devcontainer.json'], trusted: true } });
    expect(sent[0].params).not.toHaveProperty('environmentId');
    expect(listSent).not.toHaveBeenCalled();
    // An answer that names an environment that is not the one of the repository of the account is refused.
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', container: 'stopped' });
    answer = { opened: { ...OPENED, environmentId: OTHER_ID } };
    expect(((await rejection(h.operations.openInWorker(target, { progress: h.progress }))) as Error).message).toContain('not the one of the open');
  });

  it('never answers with an environment of another account or Docker host', async () => {
    const { h } = harness(async () => ({ opened: OPENED }));
    await seedEnvironment(h, { container: 'stopped', owner: OTHER_ACCOUNT });
    expect(await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }))).toBeInstanceOf(Error);
    const elsewhere = harness(async () => ({ opened: OPENED }));
    await seedEnvironment(elsewhere.h, { container: 'stopped', extra: { dockerHost: 'ssh://box' } });
    // The entry of another Docker host is refused before anything is sent.
    expect(await rejection(elsewhere.h.operations.openEnvironmentInWorker(ENV_ID, { progress: elsewhere.h.progress }))).toBeInstanceOf(UserFacingError);
    expect(elsewhere.sent).toEqual([]);
  });

  it('the host access checks of the repository only, and the time limit of the heartbeats', async () => {
    const { h, sent } = harness(async () => ({ opened: OPENED }));
    await seedEnvironment(h, { container: 'stopped' });
    h.settings = { ...h.settings, hostAccessChecksOff: ['acme/other', REPO.toUpperCase()], stopAfterMinutes: 30, stopOnClose: false, respectShutdownActionNone: true, waitingTimeSeconds: 12 };
    await h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress });
    expect(sent[0].params.settings).toEqual({ updateImagesOnConnect: true, hostAccessChecks: 'off', waitingTimeSeconds: 12, stopOnClose: false, respectShutdownActionNone: true, stopAfterMinutes: 30 });
  });

  it('shows the steps of the worker and their details; other steps of the operation are not shown', async () => {
    const { h } = harness(async (_op, _params, options) => {
      options.onProgress?.('open', ENV_ID);
      options.onProgress?.('checkingImage');
      options.onProgress?.(OPEN_PROGRESS_DETAIL, 'A newer image is available.');
      options.onProgress?.(OPEN_PROGRESS_DETAIL, 'x'.repeat(5000));
      options.onProgress?.('starting');
      options.onProgress?.('notAStep');
      return { opened: OPENED };
    });
    await seedEnvironment(h, { container: 'stopped' });
    await h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress });
    expect(h.progress.steps).toEqual(['checkingImage', 'starting']);
    expect(h.progress.details[0]).toBe('A newer image is available.');
    expect(h.progress.details[1]).toHaveLength(1000);
  });

  it('signs in and starts Docker here first; without a sign-in nothing is sent', async () => {
    const { h, sent } = harness(async () => ({ opened: OPENED }));
    await seedEnvironment(h, { container: 'stopped' });
    h.dockerStopped = true;
    await h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress });
    expect(h.dockerStarts).toBe(1);
    expect(h.progress.steps[0]).toBe('startingDocker');
    h.token = undefined;
    expect(await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ code: 'signInRequired' });
    expect(sent).toHaveLength(1);
  });

  it('without the computer or the image maintenance nothing is sent (review round 1 of PR #108, A-L2)', async () => {
    for (const overrides of [{ monitorSource: undefined }, { openMonitor: undefined }] as Partial<EnvironmentServiceDeps & EnvironmentOperationsDeps>[]) {
      const { h, sent } = harness(async () => ({ opened: OPENED }), overrides);
      await seedEnvironment(h, { container: 'stopped' });
      expect(((await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }))) as Error).message).toContain('cannot be sent to the worker');
      expect(sent).toEqual([]);
    }
  });

  it('throws the refusal of the worker as the UserFacingError it was; the list that it gave counts', async () => {
    const { h, listSent } = harness(async () => ({ refused: { code: 'buildFailed', message: 'The environment could not be prepared.', detail: 'log' }, imageListSent: true }));
    const mark = own('update');
    await seedEnvironment(h, { container: 'stopped', extra: { busy: mark } });
    await h.sessionFiles.writePending(ENV_ID, WINDOW_ID);
    const error = await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }));
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).toMatchObject({ code: 'buildFailed', detail: 'log' });
    expect(listSent).toHaveBeenCalledTimes(1);
    // The worker cleaned up itself (its requests were answered): nothing is changed here.
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(mark);
    expect(await h.sessionFiles.readPendings()).toHaveLength(1);
  });
});

describe('a worker open that ended without its answer (plan step 11E6)', () => {
  it('this window removes its pending file and its busy mark; a create mark stays as ended', async () => {
    for (const operation of ['update', 'rebuild', 'create'] as const) {
      const { h } = harness(async () => {
        throw new HelperChannelError('closed', 'The worker ended.');
      });
      await seedEnvironment(h, { container: 'stopped', extra: { busy: own(operation) } });
      await h.sessionFiles.writePending(ENV_ID, WINDOW_ID);
      const error = await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }));
      expect(error, operation).toBeInstanceOf(UserFacingError);
      expect(await h.sessionFiles.readPendings(), operation).toEqual([]);
      const busy = (await h.registry.get(ENV_ID))?.busy;
      if (operation === 'create') expect(busy).toMatchObject({ operation: 'create', since: new Date(0).toISOString(), pid: PID, windowId: WINDOW_ID });
      else expect(busy, operation).toBeUndefined();
    }
  });

  it('never the mark of another window', async () => {
    const { h } = harness(async () => {
      throw new HelperChannelError('closed', 'The worker ended.');
    });
    const other: BusyMark = { operation: 'update', since: new Date().toISOString(), pid: PID + 1, windowId: 'window-2' };
    await seedEnvironment(h, { container: 'stopped', extra: { busy: other } });
    await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }));
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(other);
  });

  it('review round 1 of PR #107 (A-L2): after the worker began `up`, the lifecycle of the environment is unknown to this window', async () => {
    const before = harness(async (_op, _params, options) => {
      options.onProgress?.('checkingImage');
      throw new HelperChannelError('closed', 'The worker ended.');
    });
    await seedEnvironment(before.h, { container: 'stopped' });
    await rejection(before.h.operations.openEnvironmentInWorker(ENV_ID, { progress: before.h.progress }));
    expect(await before.memory.get(ENV_ID)).toBeUndefined();
    const after = harness(async (_op, _params, options) => {
      options.onProgress?.('starting');
      throw new HelperChannelError('closed', 'The worker ended.');
    });
    await seedEnvironment(after.h, { container: 'stopped' });
    await rejection(after.h.operations.openEnvironmentInWorker(ENV_ID, { progress: after.h.progress }));
    expect(await after.memory.get(ENV_ID)).toBe(LIFECYCLE_UNKNOWN);
    expect(after.h.logger.warnings.join('\n')).toContain('the next open of this window runs its lifecycle commands again');
  });

  it('the same for a cancel, and for an answer that does not fit; the open of a repository cleans up its environment', async () => {
    const controller = new AbortController();
    const cancelled = harness(async (_op, _params, options) => {
      options.onProgress?.('starting');
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await seedEnvironment(cancelled.h, { container: 'stopped', extra: { busy: own('update') } });
    await rejection(cancelled.h.operations.openInWorker({ repository: REPO, configPaths: [], trusted: true }, { progress: cancelled.h.progress, signal: controller.signal }));
    expect((await cancelled.h.registry.get(ENV_ID))?.busy).toBeUndefined();
    expect(await cancelled.memory.get(ENV_ID)).toBe(LIFECYCLE_UNKNOWN);
    const odd = harness(async () => ({ opened: { ...OPENED, containerName: '-' } }));
    await seedEnvironment(odd.h, { container: 'stopped', extra: { busy: own('update') } });
    expect(((await rejection(odd.h.operations.openEnvironmentInWorker(ENV_ID, { progress: odd.h.progress }))) as Error).message).toContain('with an invalid value');
    expect((await odd.h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('an open of a repository without an environment cleans up nothing', async () => {
    const { h } = harness(async () => {
      throw new HelperChannelError('closed', 'The worker ended.');
    });
    expect(await rejection(h.operations.openInWorker({ repository: REPO, configPaths: [], trusted: true }, { progress: h.progress }))).toBeInstanceOf(UserFacingError);
    expect(await h.registry.list()).toEqual([]);
  });
});
