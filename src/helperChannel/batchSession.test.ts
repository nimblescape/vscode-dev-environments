// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3b (review round 1, missing tests): the batch session of a flow in the worker over a started helper
// (sessionOfHelper), with a fake client: the checks of a step, its result as the extension's client collects it, its
// secret masked, `lost` and `close`.
import { describe, expect, it } from 'vitest';
import { MAX_BATCH_INPUT_CHARACTERS } from '../core/helperChannel/batch';
import { HelperChannelError, HelperOperationError, collectBatchStep, type OperationOptions } from '../core/helperChannel/helperChannel';
import { OutputTooLargeError } from '../core/process';
import { sessionOfHelper, workerBatchSession, type BatchHelperClient } from './batch';
import { contextSecrets } from './operationContext.testkit';
import type { ContextDockerOptions, ContextDockerResult, OperationContext } from './server';

const SESSION = 'a'.repeat(24);

function fakeHelper(answer: (op: string, params: unknown, options: OperationOptions) => Promise<unknown>) {
  const calls: { op: string; params: unknown; options: OperationOptions }[] = [];
  let close: (reason: string) => void = () => {};
  let finished = 0;
  const helper: BatchHelperClient = {
    channel: {
      operation: async (op, params, options = {}) => {
        calls.push({ op, params, options });
        return answer(op, params, options);
      },
      onClose: (listener) => {
        close = listener;
        return () => {};
      },
    },
    finish: async () => {
      finished++;
      if (finished > 1) throw new Error('finished twice');
    },
  };
  return { helper, calls, closeChannel: (reason: string) => close(reason), finished: () => finished };
}

describe("the batch session of a flow in the worker (plan step 11B3b)", () => {
  it('runs a step in the helper and gives its output and exit code, masked with the secret of the step', async () => {
    const { helper, calls } = fakeHelper(async (_op, _params, options) => {
      options.onOutput?.('stdout', '["a"]\n');
      options.onOutput?.('stderr', 'cloned with ghp_secret\n');
      return { exitCode: 0 };
    });
    const session = sessionOfHelper(SESSION, helper);
    const outputs: string[] = [];
    const result = await session.step('listConfigs', { repository: 'acme/api' }, { secrets: { token: 'ghp_secret' }, timeoutMs: 5000, onOutput: (_stream, text) => outputs.push(text) });
    expect(result).toEqual({ exitCode: 0, stdout: '["a"]\n', stderr: 'cloned with ***\n', timedOut: false });
    expect(outputs.join('')).not.toContain('ghp_secret');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: 'listConfigs', params: { repository: 'acme/api' }, options: { secrets: { token: 'ghp_secret' }, timeoutMs: 5000 } });
    // The time limit of the step: its result, not a failure.
    const timed = sessionOfHelper(SESSION, fakeHelper(async () => {
      throw new HelperOperationError('timeout', 'The step ended at its time limit.', true);
    }).helper);
    expect(await timed.step('listConfigs', { repository: 'acme/api' })).toMatchObject({ exitCode: null, timedOut: true });
  });

  it('refuses a step that the checks refuse, an input over the limit, and an aborted signal, before the helper sees it', async () => {
    const { helper, calls } = fakeHelper(async () => ({ exitCode: 0 }));
    const session = sessionOfHelper(SESSION, helper);
    await expect(session.step('exec' as never, {})).rejects.toBeInstanceOf(HelperChannelError);
    await expect(session.step('listConfigs', { repository: 'x'.repeat(MAX_BATCH_INPUT_CHARACTERS) })).rejects.toThrow('too large');
    // Review round 2 of 11B3b (B-R2-6): a time limit beyond the checks is refused; an input of exactly the limit goes.
    await expect(session.step('listConfigs', { repository: 'acme/api' }, { timeoutMs: -1 })).rejects.toBeInstanceOf(HelperChannelError);
    await expect(session.step('listConfigs', { repository: 'acme/api' }, { timeoutMs: Number.MAX_SAFE_INTEGER })).rejects.toBeInstanceOf(HelperChannelError);
    expect(calls).toEqual([]);
    const exact = 'x'.repeat(MAX_BATCH_INPUT_CHARACTERS - JSON.stringify({ repository: '' }).length);
    await session.step('listConfigs', { repository: exact }).catch(() => undefined);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    // A step without parameters goes with null (as the extension's client sends it).
    await session.step('listConfigs', undefined).catch(() => undefined);
    expect(calls.map((call) => call.params)).toEqual([null]);
    calls.length = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(session.step('listConfigs', { repository: 'acme/api' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });

  it('is lost when the helper ends without close, never after close; close ends it once and never rejects', async () => {
    const first = fakeHelper(async () => ({ exitCode: 0 }));
    const lostSession = sessionOfHelper(SESSION, first.helper);
    first.closeChannel('the helper ended');
    expect(await lostSession.lost).toBe('the helper ended');
    const second = fakeHelper(async () => ({ exitCode: 0 }));
    const closed = sessionOfHelper(SESSION, second.helper);
    await closed.close();
    second.closeChannel('closed');
    await closed.close();
    expect(second.finished()).toBe(1);
    const outcome = await Promise.race([closed.lost, new Promise((resolve) => setTimeout(() => resolve('not lost'), 20))]);
    expect(outcome).toBe('not lost');
    // A finish that fails does not reject close.
    const failing = sessionOfHelper(SESSION, { channel: second.helper.channel, finish: async () => Promise.reject(new Error('gone')) });
    await expect(failing.close()).resolves.toBeUndefined();
  });
});

// Review round 1 of 11B3b (B-R1-1, B-R1-3): the signal of a step, the cap of its output, and the collector itself.
describe('the step of a batch session: its signal, its output cap, and the collector (review round 1 of 11B3b)', () => {
  it('a cancel of the step reaches the helper and ends it with an AbortError', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const { helper } = fakeHelper((_op, _params, options) => {
      seen.push(options.signal);
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    });
    const controller = new AbortController();
    const step = sessionOfHelper(SESSION, helper).step('listConfigs', { repository: 'acme/api' }, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(step).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen[0]?.aborted).toBe(true);
  });

  it('a standard output over the cap ends the step with OutputTooLargeError', async () => {
    const piece = 'x'.repeat(1024 * 1024);
    const { helper } = fakeHelper(async (_op, _params, options) => {
      for (let index = 0; index < 65 && !options.signal?.aborted; index++) options.onOutput?.('stdout', piece);
      return { exitCode: 0 };
    });
    await expect(sessionOfHelper(SESSION, helper).step('listConfigs', { repository: 'acme/api' })).rejects.toBeInstanceOf(OutputTooLargeError);
  });

  it('collectBatchStep: passes the pieces on as they come, follows the signal of the step, refuses an invalid value', async () => {
    const pieces: string[] = [];
    const controller = new AbortController();
    let given: AbortSignal | undefined;
    const result = await collectBatchStep('listConfigs', { signal: controller.signal, onOutput: (stream, text) => pieces.push(`${stream} ${text}`) }, 1000, async (signal, onOutput) => {
      given = signal;
      onOutput('stdout', 'one ');
      onOutput('stderr', 'two');
      onOutput('stdout', 'three');
      return { exitCode: 3 };
    });
    expect(result).toEqual({ exitCode: 3, stdout: 'one three', stderr: 'two', timedOut: false });
    expect(pieces).toEqual(['stdout one ', 'stderr two', 'stdout three']);
    controller.abort();
    expect(given?.aborted).toBe(true);
    await expect(collectBatchStep('listConfigs', {}, 1000, async () => ({ value: 'x' }))).rejects.toMatchObject({ code: 'protocol' });
    await expect(collectBatchStep('listConfigs', {}, 3, async (_signal, onOutput) => (onOutput('stdout', 'four'), { exitCode: 0 }))).rejects.toBeInstanceOf(OutputTooLargeError);
  });
});

// Review round 1 of 11B3b (B-R1-2): the start of the worker's own batch helper when it fails: what it started is ended
// and removed by its label; a cancel is cancelled; a removal that fails is logged, never thrown.
describe('the start of the batch helper of a flow when it fails (review round 1 of 11B3b)', () => {
  function context(options: { psFails?: boolean; abortOnInspect?: boolean } = {}) {
    const calls: string[][] = [];
    const order: string[] = [];
    const logs: string[] = [];
    const runSignals: AbortSignal[] = [];
    const controller = new AbortController();
    const docker = async (args: readonly string[], callOptions: ContextDockerOptions = {}): Promise<ContextDockerResult> => {
      calls.push([...args]);
      if (args[0] === 'volume') {
        if (options.abortOnInspect) controller.abort();
        return { exitCode: 0, stdout: `${args[args.length - 1]}\n`, stderr: '' };
      }
      if (args[0] === 'run') {
        // A helper that never says hello: it ends only when its call is ended.
        callOptions.onInput?.({ write: () => true, end: () => {} });
        if (callOptions.signal) runSignals.push(callOptions.signal);
        return new Promise((resolve) =>
          callOptions.signal?.addEventListener('abort', () => setTimeout(() => (order.push('run ended'), resolve({ exitCode: null, stdout: '', stderr: '', error: 'ended' })), 10)),
        );
      }
      if (args[0] === 'ps') {
        order.push('ps');
        if (options.psFails) throw new Error('the engine is gone');
        return { exitCode: 0, stdout: `${'f'.repeat(64)}\n`, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const progress: string[] = [];
    const ctx = {
      signal: controller.signal,
      ...contextSecrets({}),
      progress: (step: string, detail?: string) => progress.push(`${step} ${detail ?? ''}`),
      log: (text: string, level?: string) => logs.push(`${level ?? 'info'} ${text}`),
      output: () => {},
      docker,
    } as unknown as OperationContext;
    return { ctx, calls, logs, runSignals, controller, order, progress };
  }
  const deps = () => ({ sessions: new Map(), readScript: () => 'script', openTimeoutMs: 100 });
  const target = { volume: 'devenv-v', image: `sha256:${'b'.repeat(64)}`, socket: '/var/run/docker.sock' };

  it('a helper that never answers is ended and removed by its label, and the start fails', async () => {
    const { ctx, calls, runSignals } = context();
    await expect(workerBatchSession(deps(), ctx, target)).rejects.toMatchObject({ code: 'failed' });
    expect(runSignals[0]?.aborted).toBe(true);
    expect(calls.map((call) => call[0])).toEqual(['volume', 'run', 'ps', 'rm']);
    expect(calls[3]).toEqual(['rm', '-f', 'f'.repeat(64)]);
    // The helper runs from the image and with the socket of the request; the removal waits for the end of its call.
    expect(calls[1]).toContain(target.image);
    expect(calls[1].join(' ')).toContain(`source=${target.socket}`);
  });

  it('removes only after the call of the helper ended; refuses a request beyond the checks; a cancel during the volume check is cancelled', async () => {
    const ordered = context();
    await expect(workerBatchSession(deps(), ordered.ctx, target)).rejects.toMatchObject({ code: 'failed' });
    expect(ordered.order).toEqual(['run ended', 'ps']);
    const invalid = context();
    await expect(workerBatchSession(deps(), invalid.ctx, { ...target, socket: '/var/run/a,b.sock' })).rejects.toMatchObject({ code: 'unsendable' });
    expect(invalid.calls).toEqual([]);
    const cancelled = context({ abortOnInspect: true });
    await expect(workerBatchSession(deps(), cancelled.ctx, target)).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancelled.calls.map((call) => call[0])).toEqual(['volume']);
  });

  it('a cancel during the start is cancelled; a removal that fails is logged and the start still fails as it did', async () => {
    const cancelled = context();
    const starting = workerBatchSession(deps(), cancelled.ctx, target);
    await new Promise((resolve) => setTimeout(resolve, 20));
    cancelled.controller.abort();
    await expect(starting).rejects.toMatchObject({ code: 'cancelled' });
    const failing = context({ psFails: true });
    await expect(workerBatchSession(deps(), failing.ctx, target)).rejects.toMatchObject({ code: 'failed' });
    // Review round 2 of 11B3b (B-R2-9): as a warning, and the start is reported as the progress step `batch`.
    expect(failing.logs.some((line) => line.startsWith('warn ') && line.includes('could not be removed: the engine is gone'))).toBe(true);
    expect(failing.progress).toEqual([`batch ${target.volume}`]);
  });
});
