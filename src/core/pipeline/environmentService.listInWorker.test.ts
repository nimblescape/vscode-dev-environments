// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3b (user decision of 2026-10-04): the listing of Select configuration from the extension's side: it sends
// `listConfigurations` to the worker of the Docker host of the operation and gives back its paths, or the refusal of the
// worker's pipeline as the UserFacingError it was before the move. Nothing is listed here.
import type { EnvironmentOperationsDeps } from './environmentOperations';
import type { OperationFlow } from './environmentOperations';
import { describe, expect, it, vi } from 'vitest';
import { BatchHelperUnavailableError, UserFacingError, isBatchHelperUnavailable } from '../errors';
import { HelperChannelError, HelperOperationError } from '../helperChannel/helperChannel';
import { LOCK_BUSY_CODE, OP_DELETE, OP_DELETE_CHECK, OP_LIST_CONFIGURATIONS, OP_WINDOW_STATE } from '../helperChannel/protocol';
import { DELETE_CHECK_FLOW_TIMEOUT_MS, DELETE_FLOW_TIMEOUT_MS, LIST_CONFIGURATIONS_FLOW_TIMEOUT_MS, PipelineTexts, WINDOW_STATE_FLOW_TIMEOUT_MS } from './operationBase';
import { ENV_ID, PID, REPO, WINDOW_ID, createHarness, seedEnvironment } from './environmentService.testkit';
import type { EnvironmentServiceDeps } from './environmentService';

type FlowOptions = Parameters<OperationFlow>[2];

function harness(answer: (op: string, params: unknown, options: FlowOptions) => Promise<unknown>, overrides: Partial<EnvironmentServiceDeps & EnvironmentOperationsDeps> = {}) {
  const sent: { op: string; params: unknown; timeoutMs?: number; signal?: AbortSignal; passive?: boolean }[] = [];
  const h = createHarness({
    ...overrides,
    flow: async (op, params, options) => {
      sent.push({ op, params, timeoutMs: options.timeoutMs, signal: options.signal, passive: options.passive });
      return answer(op, params, options);
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
    expect(await h.operations.listConfigurationsInWorker(ENV_ID, { progress: h.progress, signal: controller.signal })).toEqual(['.devcontainer/devcontainer.json', 'b/devcontainer.json']);
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
    const first = await rejection(h.operations.listConfigurationsInWorker(ENV_ID, { progress: h.progress }));
    expect(first).toBeInstanceOf(UserFacingError);
    expect(first).toMatchObject({ code: 'signInRequired', message: 'Sign in to GitHub.' });
    expect(isBatchHelperUnavailable(first)).toBe(false);
    refused = { code: 'helperFailed', message: 'The helper could not be opened.', detail: 'no image', batchHelperUnavailable: true };
    const second = await rejection(h.operations.listConfigurationsInWorker(ENV_ID, { progress: h.progress }));
    expect(second).toBeInstanceOf(BatchHelperUnavailableError);
    // Review round 2 of 11B3b (B-R2-8): changed expectation, with its message.
    expect(second).toMatchObject({ code: 'helperFailed', message: 'The helper could not be opened.', detail: 'no image' });
    // A refusal that is not one (an unknown code, `cancelled`) is an invalid answer, never a UserFacingError of the worker.
    for (const odd of [{ code: 'rootAccess', message: 'x' }, { code: 'cancelled', message: 'x' }, { code: 'startFailed', message: '' }]) {
      refused = odd;
      const error = await rejection(h.operations.listConfigurationsInWorker(ENV_ID, { progress: h.progress }));
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
    expect(await rejection(h.operations.listConfigurationsInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ code: 'startFailed', message: PipelineTexts.environmentLockBusy(REPO) });
    failure = new HelperChannelError('unavailable', 'no worker');
    expect(await rejection(h.operations.listConfigurationsInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ code: 'helperFailed' });
    expect(await h.operations.listConfigurationsInWorker('6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b', { progress: h.progress })).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('a cancel is cancelled', async () => {
    const controller = new AbortController();
    const { h } = harness(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await seedEnvironment(h, { container: 'stopped' });
    expect(await rejection(h.operations.listConfigurationsInWorker(ENV_ID, { progress: h.progress, signal: controller.signal }))).toMatchObject({ code: 'cancelled' });
  });
});

// Review round 1 of 11B3b (B-R1-7, B-R1-13): the Docker host of the operation, the detail.
describe('the listing in the worker from the extension: review round 1 of 11B3b', () => {
  it('sends the remote Docker host of the operation', async () => {
    const { h, sent } = harness(async () => ({ configPaths: [] }), { dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }) });
    await seedEnvironment(h, { container: 'stopped' });
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      entry.dockerHost = 'build-box';
    });
    await h.operations.listConfigurationsInWorker(ENV_ID, { progress: h.progress });
    expect((sent[0].params as { dockerHost: string }).dockerHost).toBe('build-box');
  });

  // Plan step 11I1, PR B1 (user decision D7 of 2026-10-07): the guard against a lock that this window holds is gone (the
  // extension takes no lock of an environment any more; the worker takes it), so only the refusal with its detail stays.
  it('a refusal keeps its detail', async () => {
    const { h } = harness(async () => ({ refused: { code: 'startFailed', message: 'm', detail: 'd' } }));
    await seedEnvironment(h, { container: 'stopped' });
    expect(await rejection(h.operations.listConfigurationsInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ code: 'startFailed', message: 'm', detail: 'd' });
  });
});

// Review round 2 of 11B3b (B-R2-8): parameters that the worker would refuse are never sent.
describe('the listing in the worker from the extension: review round 2 of 11B3b', () => {
  it('a window without a valid owner sends nothing', async () => {
    const { h, sent } = harness(async () => ({ configPaths: [] }), { owner: { windowId: 'window-1', pid: 0 } });
    await seedEnvironment(h, { container: 'stopped' });
    expect(await rejection(h.operations.listConfigurationsInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ message: expect.stringContaining('cannot be sent to the worker') });
    expect(sent).toEqual([]);
  });
});

// Plan step 11C1 (decisions of 2026-10-04): the reads of an attached window through the worker.
describe('the reads of an attached window through the worker, from the extension (plan step 11C1)', () => {
  it('sends the container, the host access checks of the repository, and with `branch` the Git user and folder', async () => {
    const { h, sent } = harness(async () => ({ state: 'running', branch: 'main' }));
    const env = await seedEnvironment(h, { container: 'running' });
    expect(await h.operations.windowStateInWorker(env, 'devenv-x', { branch: true })).toEqual({ state: 'running', branch: 'main' });
    expect(sent[0]).toMatchObject({
      op: OP_WINDOW_STATE,
      params: { environmentId: ENV_ID, containerName: 'devenv-x', checks: 'on', branch: { folder: '/workspaces/api', user: 'vscode' } },
      timeoutMs: WINDOW_STATE_FLOW_TIMEOUT_MS,
    });
    await h.operations.windowStateInWorker(env, 'devenv-x');
    expect(sent[1].params).toEqual({ environmentId: ENV_ID, containerName: 'devenv-x', checks: 'on' });
  });

  it('is unknown (undefined) when the worker cannot be reached, fails, or answers an invalid value; it never throws', async () => {
    let answer: () => Promise<unknown> = async () => {
      throw new HelperChannelError('unavailable', 'no worker');
    };
    const { h } = harness(() => answer());
    const env = await seedEnvironment(h, { container: 'running' });
    expect(await h.operations.windowStateInWorker(env, 'devenv-x')).toBeUndefined();
    answer = async () => ({ state: 'paused' });
    expect(await h.operations.windowStateInWorker(env, 'devenv-x')).toBeUndefined();
    expect(h.logger.infos.some((line) => line.includes('The state of the container devenv-x could not be read'))).toBe(true);
  });

  // Review round 1 of 11C1 (A-R1-1): a read makes the worker ready passively and within its time limit. Review round 2
  // (A-R2-M1, A-R2-M2): changed expectation (before: a read of a command of the user made it ready in full): every read.
  // Review round 3 of 11C1 (A-R3-M1): a read with the signal of an operation of the user makes the worker ready in full.
  it('a read with the signal of an operation is not passive and ends with that signal', async () => {
    const { h, sent } = harness(async () => ({ state: 'running' }));
    const env = await seedEnvironment(h, { container: 'running' });
    const signal = new AbortController().signal;
    await h.operations.windowStateInWorker(env, 'devenv-x', { signal });
    expect(sent[0]).toMatchObject({ timeoutMs: WINDOW_STATE_FLOW_TIMEOUT_MS });
    // Review round 4 of 11C1 (B-R4 W3, W6): that very signal, not one bounded by a time limit.
    expect(sent[0].signal).toBe(signal);
    expect(sent[0].passive).toBeUndefined();
  });

  it('a read is passive and bounded by its time limit, with and without the branch', async () => {
    const { h, sent } = harness(async () => ({ state: 'running' }));
    const env = await seedEnvironment(h, { container: 'running' });
    await h.operations.windowStateInWorker(env, 'devenv-x', { branch: true });
    await h.operations.windowStateInWorker(env, 'devenv-x');
    for (const each of sent) {
      expect(each).toMatchObject({ passive: true, timeoutMs: WINDOW_STATE_FLOW_TIMEOUT_MS });
      expect(each.signal).toBeInstanceOf(AbortSignal);
    }
  });

  // Review round 2 of 11C1 (B-R2 E5): the wait for the worker is bounded by the time limit of the read.
  it('the signal of a read ends at the time limit of the read', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { h } = harness(async () => ({ state: 'running' }));
      const env = await seedEnvironment(h, { container: 'running' });
      const { h: h2, sent } = harness(async () => ({ state: 'running' }));
      await seedEnvironment(h2, { container: 'running' });
      await h.operations.windowStateInWorker(env, 'devenv-x');
      await h2.operations.windowStateInWorker(env, 'devenv-x');
      expect(timeout).toHaveBeenCalledWith(WINDOW_STATE_FLOW_TIMEOUT_MS);
      // Review round 3 of 11C1 (B-R3 E5b): that signal is the one sent.
      expect(sent[0].signal).toBe(timeout.mock.results[1].value);
    } finally {
      timeout.mockRestore();
    }
  });

  // Review round 1 of 11C1 (missing test): an environment of another Docker host is unknown, and no flow is sent.
  it('an environment of another Docker host than the current one is unknown, and nothing is sent', async () => {
    const { h, sent } = harness(async () => ({ state: 'running' }), { dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }) });
    await seedEnvironment(h, { container: 'running' });
    const env = await h.registry.updateEnvironment(ENV_ID, (entry) => {
      entry.dockerHost = 'other-box';
    });
    expect(await h.operations.windowStateInWorker(env ?? (await h.registry.get(ENV_ID))!, 'devenv-x')).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

// Review round 1 of plan step 11C1 (B-R1-5, B-R1-6, B-R1-11): the parameters of the window reads.
describe('the reads of an attached window through the worker: review round 1 of 11C1', () => {
  it('sends the host access checks of the repository when they are off', async () => {
    const { h, sent } = harness(async () => ({ state: 'running' }));
    const env = await seedEnvironment(h, { container: 'running' });
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    await h.operations.windowStateInWorker(env, 'devenv-x');
    expect((sent[0].params as { checks: string }).checks).toBe('off');
  });

  it('parameters that the worker would refuse are unknown, and nothing is sent', async () => {
    const { h, sent } = harness(async () => ({ state: 'running' }));
    const env = await seedEnvironment(h, { container: 'running' });
    expect(await h.operations.windowStateInWorker(env, '-x')).toBeUndefined();
    expect(sent).toEqual([]);
    expect(h.logger.infos.some((line) => line.includes('The state of the container -x could not be read'))).toBe(true);
  });

  it('an empty remote user is not sent: the branch is read as the default user', async () => {
    const { h, sent } = harness(async () => ({ state: 'missing' }));
    const env = await seedEnvironment(h, { container: 'running' });
    expect(await h.operations.windowStateInWorker({ ...env, remoteUser: '' }, 'devenv-x', { branch: true })).toEqual({ state: 'missing' });
    expect((sent[0].params as { branch: unknown }).branch).toEqual({ folder: '/workspaces/api' });
  });
});

// Plan step 11C2a (decisions of 2026-10-03 and 2026-10-04): Delete from the extension's side: it sends `delete` to the
// worker of the Docker host of the operation and throws its refusal as before the move. Nothing is removed here.
describe('the Delete in the worker, from the extension (plan step 11C2a)', () => {
  const SOURCE = '0123456789abcdef0123456789abcdef';

  it('sends the environment, the Docker host, this window, the confirmed volumes and this computer; removes nothing here', async () => {
    const { h, sent } = harness(async () => ({ deleted: true }), { monitorSource: () => SOURCE });
    await seedEnvironment(h, { container: 'running' });
    const changes = h.docker.log.length;
    await h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: ['api-db'] });
    expect(sent).toEqual([
      {
        op: OP_DELETE,
        params: { environmentId: ENV_ID, dockerHost: '', owner: { windowId: WINDOW_ID, pid: PID }, additionalVolumesToRemove: ['api-db'], monitorSource: SOURCE },
        timeoutMs: DELETE_FLOW_TIMEOUT_MS,
        signal: undefined,
        passive: undefined,
      },
    ]);
    expect(h.docker.log.length).toBe(changes);
    expect(h.helper.calls).toEqual([]);
    expect(await h.registry.get(ENV_ID)).toBeDefined();
  });

  it('throws the refusal of the worker as the UserFacingError it was; a lock held elsewhere or no worker is refused as for Stop', async () => {
    let answer: () => Promise<unknown> = async () => ({ refused: { code: 'otherAccount', message: 'Another account.' } });
    const { h } = harness(() => answer(), { monitorSource: () => SOURCE });
    await seedEnvironment(h, { container: 'stopped' });
    const remove = () => rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }));
    expect(await remove()).toMatchObject({ code: 'otherAccount', message: 'Another account.' });
    answer = async () => {
      throw new HelperOperationError(LOCK_BUSY_CODE, 'held', false);
    };
    expect(await remove()).toMatchObject({ code: 'startFailed', message: PipelineTexts.environmentLockBusy(REPO) });
    answer = async () => {
      throw new HelperChannelError('unavailable', 'no worker');
    };
    expect(await remove()).toMatchObject({ code: 'helperFailed' });
    answer = async () => ({ deleted: false });
    expect(((await remove()) as Error).message).toContain('with an invalid value');
  });

  it('an environment that is not in the registry only loses its session files here; nothing is sent', async () => {
    const { h, sent } = harness(async () => ({ deleted: true }), { monitorSource: () => SOURCE });
    await h.operations.deleteInWorker('6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b', { progress: h.progress, additionalVolumesToRemove: [] });
    expect(sent).toEqual([]);
  });

  // Plan step 11I1, PR B1 (user decision D7 of 2026-10-07): the case under a lock that this window holds is gone with its
  // guard (the extension takes no lock of an environment any more).
  it('never sends without this computer, or for another Docker host', async () => {
    const { h, sent } = harness(async () => ({ deleted: true }));
    await seedEnvironment(h, { container: 'stopped' });
    expect(((await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }))) as Error).message).toContain('cannot be sent to the worker');
    const other = harness(async () => ({ deleted: true }), { monitorSource: () => SOURCE, dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }) });
    await seedEnvironment(other.h, { container: 'stopped' });
    expect(await rejection(other.h.operations.deleteInWorker(ENV_ID, { progress: other.h.progress, additionalVolumesToRemove: [] }))).toMatchObject({ code: 'otherDockerHost' });
    expect([...sent, ...other.sent]).toEqual([]);
  });
});

// Review round 1 of 11C2a (A-R1-M1): a worker that ended without an answer may have left the busy mark of this window.
describe('the Delete in the worker: review round 1 of 11C2a', () => {
  const SOURCE = '0123456789abcdef0123456789abcdef';
  const OWN_MARK = { operation: 'delete' as const, since: '2026-10-04T10:00:00.000Z', pid: PID, windowId: WINDOW_ID };
  const OTHER_MARK = { operation: 'update' as const, since: '2026-10-04T10:00:00.000Z', pid: PID + 1, windowId: 'window-2' };

  it('clears the busy mark of this window when the worker ended without an answer, never the mark of another window', async () => {
    let mark = OWN_MARK as typeof OWN_MARK | typeof OTHER_MARK;
    let failure: Error = new HelperChannelError('lost', 'the channel was lost while the operation ran');
    const { h } = harness(
      async () => {
        // As the worker: it marked the environment, then its channel ended.
        await h.registry.updateEnvironment(ENV_ID, (entry) => {
          entry.busy = mark;
        });
        throw failure;
      },
      { monitorSource: () => SOURCE },
    );
    await seedEnvironment(h, { container: 'stopped' });
    expect(await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }))).toBeInstanceOf(Error);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    mark = OTHER_MARK;
    failure = new HelperChannelError('lost', 'lost again');
    await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }));
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(OTHER_MARK);
  });

  // Review round 2 of 11C2a (A-R2, missing test 1): a cancel and the time limit of the worker clear it too.
  it('clears the busy mark of this window after a cancel and after the time limit of the worker', async () => {
    const controller = new AbortController();
    let failure: () => Error = () => (controller.abort(), Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const { h } = harness(
      async () => {
        await h.registry.updateEnvironment(ENV_ID, (entry) => {
          entry.busy = OWN_MARK;
        });
        throw failure();
      },
      { monitorSource: () => SOURCE },
    );
    await seedEnvironment(h, { container: 'stopped' });
    expect(await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, signal: controller.signal, additionalVolumesToRemove: [] }))).toMatchObject({ code: 'cancelled' });
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    failure = () => new HelperOperationError('timeout', 'The operation did not end in time.', false);
    await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }));
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('leaves the mark to the worker when it answered with a refusal', async () => {
    const { h } = harness(
      async () => {
        await h.registry.updateEnvironment(ENV_ID, (entry) => {
          entry.busy = OWN_MARK;
        });
        return { refused: { code: 'startFailed', message: 'm' } };
      },
      { monitorSource: () => SOURCE },
    );
    await seedEnvironment(h, { container: 'stopped' });
    expect(await rejection(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }))).toMatchObject({ code: 'startFailed' });
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(OWN_MARK);
  });
});

// Plan step 11C2b (decisions of 2026-10-03 and 2026-10-04): the check of Delete and its questions from the extension's
// side: it sends `deleteCheck` to the worker and gives back the decision of the user, or throws the refusal.
describe('the check of Delete in the worker, from the extension (plan step 11C2b)', () => {
  it('sends the environment, the Docker host, this window, the name that the user sees and the other window; gives back the decision', async () => {
    // Review round 1 of 11C2b (A-R1-M1): changed, the fake worker asks the user (onAnswer) before its decision.
    const { h, sent } = harness(async (_op, _params, options) => {
      options.onAnswer?.('confirmDelete', ['Acme/API', {}], 'delete');
      options.onAnswer?.('deleteAdditionalVolumes', [['api-cache']], 'remove');
      return { decision: 'delete', additionalVolumesToRemove: ['api-cache'] };
    });
    await seedEnvironment(h, { container: 'running' });
    const controller = new AbortController();
    expect(await h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, signal: controller.signal, repository: 'Acme/API', otherWindow: true })).toEqual({
      decision: 'delete',
      additionalVolumesToRemove: ['api-cache'],
    });
    expect(sent).toEqual([
      {
        op: OP_DELETE_CHECK,
        params: { environmentId: ENV_ID, dockerHost: '', owner: { windowId: WINDOW_ID, pid: PID }, repository: 'Acme/API', otherWindow: true },
        timeoutMs: DELETE_CHECK_FLOW_TIMEOUT_MS,
        signal: controller.signal,
        passive: undefined,
      },
    ]);
  });

  // Review round 1 of 11C2b (A-R1-M1): the decision of the worker counts only as far as the user gave it.
  it('refuses a decision that the user did not give, and volumes that the user did not choose', async () => {
    let answer: (options: FlowOptions) => unknown = () => ({ decision: 'delete', additionalVolumesToRemove: [] });
    const { h } = harness(async (_op, _params, options) => answer(options));
    await seedEnvironment(h, { container: 'stopped' });
    const check = () => rejection(h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false }));
    // Never asked.
    expect(((await check()) as Error).message).toContain('a decision that the user did not give');
    // Asked, the user chose Open: Delete is not the answer.
    answer = (options) => (options.onAnswer?.('confirmDelete', ['acme/api', {}], 'open'), { decision: 'delete', additionalVolumesToRemove: [] });
    expect(((await check()) as Error).message).toContain('a decision that the user did not give');
    answer = (options) => (options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete'), { decision: 'open' });
    expect(((await check()) as Error).message).toContain('a decision that the user did not give');
    // Volumes: Keep, or not offered, or not picked.
    answer = (options) => {
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onAnswer?.('deleteAdditionalVolumes', [['api-cache']], 'keep');
      options.onAnswer?.('deleteServiceData', [['api-db', 'api-logs']], ['api-db']);
      return { decision: 'delete', additionalVolumesToRemove: ['api-db', 'api-cache'] };
    };
    expect(((await check()) as Error).message).toContain('volumes that the user did not choose: api-cache');
    answer = (options) => {
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onAnswer?.('deleteServiceData', [['api-db', 'api-logs']], ['api-db']);
      return { decision: 'delete', additionalVolumesToRemove: ['api-logs'] };
    };
    expect(((await check()) as Error).message).toContain('volumes that the user did not choose: api-logs');
    // Review round 2 of 11C2b (A-R2-M1): Escape at a later question cancels, so a Delete is refused then.
    for (const [call, args] of [
      ['deleteAdditionalVolumes', [['api-cache']]],
      ['deleteServiceData', [['api-db']]],
    ] as const) {
      answer = (options) => {
        options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
        options.onAnswer?.(call, [...args], null);
        return { decision: 'delete', additionalVolumesToRemove: [] };
      };
      expect(((await check()) as Error).message, call).toContain('a decision that the user did not give');
    }
    // Review round 3 of 11C2b (A-R3, missing tests 1–4): the cancel stays, the last confirmation counts, the last
    // answer about the volumes counts.
    const gate = [
      [['confirmDelete', 'delete'], ['deleteAdditionalVolumes', null], ['confirmDelete', 'delete']],
      [['confirmDelete', 'delete'], ['deleteAdditionalVolumes', null], ['deleteAdditionalVolumes', 'remove']],
      [['confirmDelete', 'delete'], ['confirmDelete', null]],
    ] as const;
    for (const steps of gate) {
      answer = (options) => {
        for (const [call, value] of steps) options.onAnswer?.(call, call === 'confirmDelete' ? ['acme/api', {}] : [['api-cache']], value);
        return { decision: 'delete', additionalVolumesToRemove: [] };
      };
      expect(((await check()) as Error).message, JSON.stringify(steps)).toContain('a decision that the user did not give');
    }
    answer = (options) => {
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onAnswer?.('deleteAdditionalVolumes', [['api-cache']], 'remove');
      options.onAnswer?.('deleteAdditionalVolumes', [['api-other']], 'keep');
      return { decision: 'delete', additionalVolumesToRemove: ['api-cache'] };
    };
    expect(((await check()) as Error).message).toContain('volumes that the user did not choose: api-cache');
    // Review round 3 of 11C2b (A-R3-L1): a decision while a question is still open is refused.
    answer = (options) => {
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onQuestion?.('asked');
      return { decision: 'delete', additionalVolumesToRemove: [] };
    };
    expect(((await check()) as Error).message).toContain('a decision that the user did not give');
    // What the user gave passes; a cancel always does.
    answer = (options) => {
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onAnswer?.('deleteAdditionalVolumes', [['api-cache']], 'remove');
      options.onAnswer?.('deleteServiceData', [['api-db', 'api-logs']], ['api-db']);
      return { decision: 'delete', additionalVolumesToRemove: ['api-cache', 'api-db'] };
    };
    expect(await h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false })).toEqual({
      decision: 'delete',
      additionalVolumesToRemove: ['api-cache', 'api-db'],
    });
    answer = () => ({ decision: 'cancel' });
    expect(await h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false })).toEqual({ decision: 'cancel' });
    answer = (options) => (options.onAnswer?.('confirmDelete', ['acme/api', {}], 'open'), { decision: 'open' });
    expect(await h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false })).toEqual({ decision: 'open' });
    // Nothing is read here: no helper step, no Docker call.
    expect(h.helper.calls).toEqual([]);
  });

  it('throws the refusal of the worker, refuses as for Stop without a worker, and an answer that is not a decision', async () => {
    let answer: () => Promise<unknown> = async () => ({ refused: { code: 'otherAccount', message: 'Another account.' } });
    const { h } = harness(() => answer());
    await seedEnvironment(h, { container: 'stopped' });
    const check = () => rejection(h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false }));
    expect(await check()).toMatchObject({ code: 'otherAccount', message: 'Another account.' });
    answer = async () => {
      throw new HelperChannelError('unavailable', 'no worker');
    };
    expect(await check()).toMatchObject({ code: 'helperFailed' });
    answer = async () => ({ decision: 'maybe' });
    expect(((await check()) as Error).message).toContain('with an invalid value');
  });

  it('an environment that is not in the registry, or of another Docker host, sends nothing', async () => {
    const { h, sent } = harness(async () => ({ decision: 'delete', additionalVolumesToRemove: [] }));
    expect(await h.operations.deleteCheckInWorker('6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b', { progress: h.progress, repository: 'acme/api', otherWindow: false })).toEqual({ decision: 'cancel' });
    const other = harness(async () => ({ decision: 'delete', additionalVolumesToRemove: [] }), { dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }) });
    await seedEnvironment(other.h, { container: 'stopped' });
    expect(await rejection(other.h.operations.deleteCheckInWorker(ENV_ID, { progress: other.h.progress, repository: 'acme/api', otherWindow: false }))).toMatchObject({ code: 'otherDockerHost' });
    expect([...sent, ...other.sent]).toEqual([]);
  });
});
