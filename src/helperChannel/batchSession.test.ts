// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3b (review round 1, missing tests): the batch session of a flow in the worker over a started helper
// (sessionOfHelper), with a fake client: the checks of a step, its result as the extension's client collects it, its
// secret masked, `lost` and `close`.
import { describe, expect, it } from 'vitest';
import { MAX_BATCH_INPUT_CHARACTERS } from '../core/helperChannel/batch';
import { HelperChannelError, HelperOperationError, type OperationOptions } from '../core/helperChannel/helperChannel';
import { sessionOfHelper, type BatchHelperClient } from './batch';

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
