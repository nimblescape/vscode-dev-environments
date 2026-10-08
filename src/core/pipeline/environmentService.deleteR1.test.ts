// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11C2a (mutation tests, B-R1): Delete's wait for the busy mark of another window (markBusyWaiting), its quiet clear, and deleteInWorker (a missing environment, the Docker host and signal it sends, one Delete per repository at a time, a cancel answered by the worker).
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { HelperOperationError } from '../helperChannel/helperChannel';
import { OP_DELETE } from '../helperChannel/protocol';
import type { BusyMark, Environment } from '../types';
import type { BusyMarkResult, EnvironmentBusyMarks } from './busyMarks';
import { PipelineTexts } from './operationBase';
import { BASE_IMAGE, DIGEST_OLD, ENV_ID, REPO, createHarness, seedEnvironment, type Harness, type HarnessOverrides } from './environmentService.testkit';

const OTHER: BusyMark = { operation: 'update', since: '2026-09-24T15:39:00.000Z', pid: 999, windowId: 'window-2' };
const SOURCE = '0123456789abcdef0123456789abcdef';

/** A service whose busy marks answer from `script` (per call), then the real entry. */
function scripted(script: ('conflict' | 'missing')[], overrides: HarnessOverrides = {}) {
  const holder: { h?: Harness } = {};
  const calls: string[] = [];
  const busyMarks: EnvironmentBusyMarks = {
    mark: async (id, op): Promise<BusyMarkResult> => {
      calls.push(`mark ${op}`);
      const next = script.shift();
      if (next === 'conflict') return { conflict: OTHER };
      if (next === 'missing') return undefined;
      const env = (await holder.h!.registry.get(id)) as Environment;
      return { environment: { ...env, busy: { operation: op, since: 'x', pid: 1, windowId: 'w' } } };
    },
    clear: async () => void calls.push('clear'),
  };
  const h = createHarness({ busyMarks, ...overrides });
  holder.h = h;
  return { h, calls };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then((v) => ({ resolved: v }), (e: unknown) => e);
}

describe('the wait of Delete for the busy mark of another window (review round 1 of 11C2a, B-R1)', () => {
  it('waits while another window keeps the mark, then deletes (E6, E15)', async () => {
    const { h, calls } = scripted(['conflict', 'conflict']);
    await seedEnvironment(h, { container: 'running' });
    await h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(calls.filter((c) => c.startsWith('mark'))).toEqual(['mark delete', 'mark delete', 'mark delete']);
    expect(h.sleeps).toEqual([500, 500]);
    expect(await h.registry.get(ENV_ID)).toBeUndefined();
    h.cleanup();
  });

  it('gives up after busyWaitMs / 500 waits (E7, E8)', async () => {
    const { h, calls } = scripted(Array(20).fill('conflict'));
    await seedEnvironment(h, { container: 'running' });
    const error = await caught(h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }));
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as Error).message).toBe(PipelineTexts.environmentBusy(REPO));
    expect(calls.filter((c) => c.startsWith('mark')).length).toBe(5);
    expect(h.sleeps.length).toBe(4);
    expect(await h.registry.get(ENV_ID)).toBeDefined();
    h.cleanup();
  });

  it('an entry that disappears during the wait fails the Delete (E11)', async () => {
    const { h } = scripted(['conflict', 'missing']);
    await seedEnvironment(h, { container: 'running' });
    const error = await caught(h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }));
    expect(error).toBeInstanceOf(UserFacingError);
    expect(h.docker.containers.size).toBe(1);
    h.cleanup();
  });

  it('a cancel during the wait ends it, even when the sleep itself does not notice (E9)', async () => {
    const controller = new AbortController();
    const { h } = scripted(['conflict', 'conflict'], { sleep: async () => void controller.abort() });
    await seedEnvironment(h, { container: 'running' });
    const error = await caught(h.service.delete(ENV_ID, { progress: h.progress, signal: controller.signal, additionalVolumesToRemove: [] }));
    expect(error).toMatchObject({ code: 'cancelled' });
    h.cleanup();
  });

  it('the wait gets the signal of the operation (E10)', async () => {
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const { h } = scripted(['conflict'], { sleep: async (_ms, signal) => void signals.push(signal) });
    await seedEnvironment(h, { container: 'running' });
    await h.service.delete(ENV_ID, { progress: h.progress, signal: controller.signal, additionalVolumesToRemove: [] });
    expect(signals).toEqual([controller.signal]);
    h.cleanup();
  });
});

describe('setBusyMark of a pipeline run (E5) and its quiet clear (E14) (review round 1 of 11C2a, B-R1)', () => {
  it('a mark of another window that appears after the wait refuses the run', async () => {
    const { h } = scripted(['conflict']);
    await seedEnvironment(h, { container: 'running', record: { images: { [BASE_IMAGE]: DIGEST_OLD } } });
    const error = await caught(h.service.open({ repository: REPO, defaultBranch: 'main', configPaths: ['.devcontainer/devcontainer.json'], trusted: true }, { progress: h.progress }));
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as Error).message).toBe(PipelineTexts.environmentBusy(REPO));
    h.cleanup();
  });

  it('a busy mark that cannot be cleared does not change the outcome of the Delete (logged)', async () => {
    const holder: { h?: Harness } = {};
    const busyMarks: EnvironmentBusyMarks = {
      mark: async (id, op) => ({ environment: { ...((await holder.h!.registry.get(id)) as Environment), busy: { operation: op, since: 'x', pid: 1, windowId: 'w' } } }),
      clear: async () => {
        throw new Error('registry locked');
      },
    };
    const h = createHarness({ busyMarks });
    holder.h = h;
    await seedEnvironment(h, { container: 'running' });
    h.docker.removeVolume = async () => {
      throw new Error('volume is in use');
    };
    const error = await caught(h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }));
    expect((error as Error).message).not.toContain('registry locked');
    expect(h.logger.warnings.some((l) => l.includes('Could not clear the busy mark: registry locked'))).toBe(true);
    h.cleanup();
  });
});

describe('deleteInWorker (review round 1 of 11C2a, B-R1)', () => {
  function harness(answer: (op: string, params: unknown) => Promise<unknown>, overrides: HarnessOverrides = {}) {
    const sent: { op: string; params: unknown; signal?: AbortSignal }[] = [];
    const h = createHarness({
      monitorSource: () => SOURCE,
      ...overrides,
      flow: async (op, params, options) => {
        sent.push({ op, params, signal: options.signal });
        return answer(op, params);
      },
    });
    return { h, sent };
  }

  it('removes the session files of an environment that is not in the registry (E19)', async () => {
    const { h, sent } = harness(async () => ({ deleted: true }));
    const id = '6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b';
    await h.sessionFiles.writePending(id, 'window-1');
    h.sessionFiles.writeReopenSync({ environmentId: id, closedAt: new Date(0).toISOString() });
    await h.operations.deleteInWorker(id, { progress: h.progress, additionalVolumesToRemove: [] });
    expect(sent).toEqual([]);
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(await h.sessionFiles.readReopen()).toBeUndefined();
    h.cleanup();
  });

  it('sends the Docker host of the operation and the signal (E23, E28)', async () => {
    const { h, sent } = harness(async () => ({ deleted: true }), { dockerTarget: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }) });
    await seedEnvironment(h, { container: 'stopped', extra: { dockerHost: 'build-box' } as Partial<Environment> });
    const controller = new AbortController();
    await h.operations.deleteInWorker(ENV_ID, { progress: h.progress, signal: controller.signal, additionalVolumesToRemove: [] });
    expect(sent.map((s) => [s.op, (s.params as { dockerHost: string }).dockerHost, s.signal])).toEqual([[OP_DELETE, 'build-box', controller.signal]]);
    h.cleanup();
  });

  it('runs one operation of a repository at a time (E21)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { h, sent } = harness(async () => (await gate, { deleted: true }));
    await seedEnvironment(h, { container: 'stopped' });
    const first = h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    const second = h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.length).toBe(1);
    release();
    await Promise.all([first, second]);
    h.cleanup();
  });

  it('a cancel answered by the worker is the cancelled UserFacingError (E33)', async () => {
    const controller = new AbortController();
    const { h } = harness(async () => {
      controller.abort();
      throw new HelperOperationError('cancelled', 'The operation ended.', false);
    });
    await seedEnvironment(h, { container: 'stopped' });
    const error = await caught(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, signal: controller.signal, additionalVolumesToRemove: [] }));
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).toMatchObject({ code: 'cancelled' });
    h.cleanup();
  });
});
