// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review probe of PR #118 (11I1 B1, round 1): the end of input waits for the results of the cancelled operations before
// it exits. On origin/main the cleanup tests covered this (they waited for `docker rm`); without the cleanup, a shutdown
// that exits at once (Promise.all of the runs dropped) survived the remaining tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_KILL_GRACE_MS, encodeMessage, type ServerMessage } from '../core/helperChannel/protocol';
import { ChannelServer, type OperationHandler, type ServerChild } from './server';

function setup(operations: Record<string, OperationHandler>) {
  const messages: ServerMessage[] = [];
  const exits: number[] = [];
  const children: { signals: string[]; exit: () => void }[] = [];
  const server = new ChannelServer({
    write: (text) => {
      for (const line of text.split('\n').filter((part) => part !== '')) messages.push(JSON.parse(line) as ServerMessage);
      return true;
    },
    spawnDocker: (): ServerChild => {
      let resolveExit!: (value: { exitCode: number | null }) => void;
      const exited = new Promise<{ exitCode: number | null }>((resolve) => (resolveExit = resolve));
      const entry = { signals: [] as string[], exit: () => resolveExit({ exitCode: null }) };
      children.push(entry);
      return {
        end: () => {},
        kill: (signal) => {
          entry.signals.push(signal);
          if (signal === 'SIGKILL') entry.exit();
        },
        exited,
      };
    },
    operations,
    exit: (code) => exits.push(code),
  });
  server.start();
  return { server, messages, exits, children };
}

describe('ChannelServer end of input (11I1 B1 review probe)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exits only after a handler that ends late gave its result', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    const { server, messages, exits } = setup({ hold: async () => (await held, {}) });
    server.input(encodeMessage({ t: 'op', id: 1, op: 'hold', params: null }));
    server.inputEnded();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exits).toEqual([]);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([0]);
    expect(messages.find((message) => message.t === 'result')).toMatchObject({ id: 1, ok: false, error: { code: 'cancelled' } });
  });

  it('exits only after its Docker call ended (SIGKILL after the grace), not before', async () => {
    const { server, exits, children } = setup({ run: async (_params, context) => (await context.docker(['run', 'img']), {}) });
    server.input(encodeMessage({ t: 'op', id: 1, op: 'run', params: null }));
    await vi.advanceTimersByTimeAsync(0);
    server.inputEnded();
    await vi.advanceTimersByTimeAsync(CHANNEL_KILL_GRACE_MS - 1);
    expect(children[0].signals).toEqual(['SIGTERM']);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(children[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(exits).toEqual([0]);
  });
});
