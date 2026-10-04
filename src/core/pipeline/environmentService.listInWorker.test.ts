// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3b (user decision of 2026-10-04): the listing of Select configuration from the extension's side: it sends
// `listConfigurations` to the worker of the Docker host of the operation and gives back its paths, or the refusal of the
// worker's pipeline as the UserFacingError it was before the move. Nothing is listed here.
import { describe, expect, it } from 'vitest';
import { BatchHelperUnavailableError, UserFacingError, isBatchHelperUnavailable } from '../errors';
import { HelperChannelError, HelperOperationError } from '../helperChannel/helperChannel';
import { LOCK_BUSY_CODE, OP_LIST_CONFIGURATIONS, OP_WINDOW_STATE } from '../helperChannel/protocol';
import { LIST_CONFIGURATIONS_FLOW_TIMEOUT_MS, PipelineTexts, WINDOW_STATE_FLOW_TIMEOUT_MS } from './environmentService';
import { ENV_ID, PID, REPO, WINDOW_ID, createHarness, seedEnvironment } from './environmentService.testkit';
import { runWithEnvironmentLock } from '../docker/environmentLock';
import type { EnvironmentServiceDeps } from './environmentService';

function harness(answer: (op: string, params: unknown) => Promise<unknown>, overrides: Partial<EnvironmentServiceDeps> = {}) {
  const sent: { op: string; params: unknown; timeoutMs?: number; signal?: AbortSignal }[] = [];
  const h = createHarness({
    ...overrides,
    flow: async (op, params, options) => {
      sent.push({ op, params, timeoutMs: options.timeoutMs, signal: options.signal });
      return answer(op, params);
    },
  });
  return { h, sent };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => ({ resolved: value }),
    (error: unknown) => error,
  );
}

describe('the listing of Select configuration in the worker, from the extension (plan step 11B3b)', () => {
  it('sends the environment, the Docker host and this window, and gives back the paths of the worker', async () => {
    const { h, sent } = harness(async () => ({ configPaths: ['.devcontainer/devcontainer.json', 'b/devcontainer.json'] }));
    await seedEnvironment(h, { container: 'stopped' });
    const controller = new AbortController();
    expect(await h.service.listConfigurationsInWorker(ENV_ID, { progress: h.progress, signal: controller.signal })).toEqual(['.devcontainer/devcontainer.json', 'b/devcontainer.json']);
    expect(sent).toEqual([
      { op: OP_LIST_CONFIGURATIONS, params: { environmentId: ENV_ID, dockerHost: '', owner: { windowId: WINDOW_ID, pid: PID } }, timeoutMs: LIST_CONFIGURATIONS_FLOW_TIMEOUT_MS, signal: controller.signal },
    ]);
    // Nothing runs here: no helper step, no lock of this window.
    expect(h.helper.calls).toEqual([]);
    expect(h.lock.acquired).toEqual([]);
  });

  it('throws the refusal of the worker as the UserFacingError it was, the refusal of the batch scope with its kind', async () => {
    let refused: unknown = { code: 'signInRequired', message: 'Sign in to GitHub.' };
    const { h } = harness(async () => ({ refused }));
    await seedEnvironment(h, { container: 'stopped' });
    const first = await rejection(h.service.listConfigurationsInWorker(ENV_ID, { progress: h.progress }));
    expect(first).toBeInstanceOf(UserFacingError);
    expect(first).toMatchObject({ code: 'signInRequired', message: 'Sign in to GitHub.' });
    expect(isBatchHelperUnavailable(first)).toBe(false);
    refused = { code: 'helperFailed', message: 'The helper could not be opened.', detail: 'no image', batchHelperUnavailable: true };
    const second = await rejection(h.service.listConfigurationsInWorker(ENV_ID, { progress: h.progress }));
    expect(second).toBeInstanceOf(BatchHelperUnavailableError);
    // Review round 2 of 11B3b (B-R2-8): changed expectation, with its message.
    expect(second).toMatchObject({ code: 'helperFailed', message: 'The helper could not be opened.', detail: 'no image' });
    // A refusal that is not one (an unknown code, `cancelled`) is an invalid answer, never a UserFacingError of the worker.
    for (const odd of [{ code: 'rootAccess', message: 'x' }, { code: 'cancelled', message: 'x' }, { code: 'startFailed', message: '' }]) {
      refused = odd;
      const error = await rejection(h.service.listConfigurationsInWorker(ENV_ID, { progress: h.progress }));
      expect(error).not.toBeInstanceOf(UserFacingError);
      expect((error as Error).message).toContain('with an invalid value');
    }
  });

  it('a lock held elsewhere, or a worker that cannot be reached, is refused as for Stop; an environment that does not exist lists nothing', async () => {
    let failure: Error = new HelperOperationError(LOCK_BUSY_CODE, 'held', false);
    const { h, sent } = harness(async () => {
      throw failure;
    });
    await seedEnvironment(h, { container: 'stopped' });
    expect(await rejection(h.service.listConfigurationsInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ code: 'startFailed', message: PipelineTexts.environmentLockBusy(REPO) });
    failure = new HelperChannelError('unavailable', 'no worker');
    expect(await rejection(h.service.listConfigurationsInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ code: 'helperFailed' });
    expect(await h.service.listConfigurationsInWorker('6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b', { progress: h.progress })).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('a cancel is cancelled', async () => {
    const controller = new AbortController();
    const { h } = harness(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await seedEnvironment(h, { container: 'stopped' });
    expect(await rejection(h.service.listConfigurationsInWorker(ENV_ID, { progress: h.progress, signal: controller.signal }))).toMatchObject({ code: 'cancelled' });
  });
});

// Review round 1 of 11B3b (B-R1-7, B-R1-13): the Docker host of the operation, a lock that this window holds, the detail.
describe('the listing in the worker from the extension: review round 1 of 11B3b', () => {
  it('sends the remote Docker host of the operation', async () => {
    const { h, sent } = harness(async () => ({ configPaths: [] }), { dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }) });
    await seedEnvironment(h, { container: 'stopped' });
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      entry.dockerHost = 'build-box';
    });
    await h.service.listConfigurationsInWorker(ENV_ID, { progress: h.progress });
    expect((sent[0].params as { dockerHost: string }).dockerHost).toBe('build-box');
  });

  it('never sends the listing under a lock of the environment that this window holds; a refusal keeps its detail', async () => {
    const { h, sent } = harness(async () => ({ refused: { code: 'startFailed', message: 'm', detail: 'd' } }));
    await seedEnvironment(h, { container: 'stopped' });
    const held = await h.lock.take(ENV_ID);
    const error = await rejection(runWithEnvironmentLock(held, () => h.service.listConfigurationsInWorker(ENV_ID, { progress: h.progress })));
    expect((error as Error).message).toContain('under a lock of the environment that this window holds');
    expect(sent).toEqual([]);
    await held.release();
    expect(await rejection(h.service.listConfigurationsInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ code: 'startFailed', message: 'm', detail: 'd' });
  });
});

// Review round 2 of 11B3b (B-R2-8): parameters that the worker would refuse are never sent.
describe('the listing in the worker from the extension: review round 2 of 11B3b', () => {
  it('a window without a valid owner sends nothing', async () => {
    const { h, sent } = harness(async () => ({ configPaths: [] }), { owner: { windowId: 'window-1', pid: 0 } });
    await seedEnvironment(h, { container: 'stopped' });
    expect(await rejection(h.service.listConfigurationsInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ message: expect.stringContaining('cannot be sent to the worker') });
    expect(sent).toEqual([]);
  });
});

// Plan step 11C1 (decisions of 2026-10-04): the reads of an attached window through the worker.
describe('the reads of an attached window through the worker, from the extension (plan step 11C1)', () => {
  it('sends the container, the host access checks of the repository, and with `branch` the Git user and folder', async () => {
    const { h, sent } = harness(async () => ({ state: 'running', branch: 'main' }));
    const env = await seedEnvironment(h, { container: 'running' });
    expect(await h.service.windowStateInWorker(env, 'devenv-x', { branch: true })).toEqual({ state: 'running', branch: 'main' });
    expect(sent[0]).toMatchObject({
      op: OP_WINDOW_STATE,
      params: { environmentId: ENV_ID, containerName: 'devenv-x', checks: 'on', branch: { folder: '/workspaces/api', user: 'vscode' } },
      timeoutMs: WINDOW_STATE_FLOW_TIMEOUT_MS,
    });
    await h.service.windowStateInWorker(env, 'devenv-x');
    expect(sent[1].params).toEqual({ environmentId: ENV_ID, containerName: 'devenv-x', checks: 'on' });
  });

  it('is unknown (undefined) when the worker cannot be reached, fails, or answers an invalid value; it never throws', async () => {
    let answer: () => Promise<unknown> = async () => {
      throw new HelperChannelError('unavailable', 'no worker');
    };
    const { h } = harness(() => answer());
    const env = await seedEnvironment(h, { container: 'running' });
    expect(await h.service.windowStateInWorker(env, 'devenv-x')).toBeUndefined();
    answer = async () => ({ state: 'paused' });
    expect(await h.service.windowStateInWorker(env, 'devenv-x')).toBeUndefined();
    expect(h.logger.infos.some((line) => line.includes('The state of the container devenv-x could not be read'))).toBe(true);
  });
});
