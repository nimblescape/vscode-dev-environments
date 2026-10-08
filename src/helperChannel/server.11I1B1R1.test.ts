// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review probe of PR #118 (11I1 B1, round 1): the end of input waits for the results of the cancelled operations before
// it exits. On origin/main the cleanup tests covered this (they waited for `docker rm`); without the cleanup, a shutdown
// that exits at once (Promise.all of the runs dropped) survived the remaining tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeMessage, type ServerMessage } from '../core/helperChannel/protocol';
import { ChannelServer, type OperationHandler } from './server';

function setup(operations: Record<string, OperationHandler>) {
  const messages: ServerMessage[] = [];
  const exits: number[] = [];
  // Plan step 11I (PR A): changed setup: no `spawnDocker` (the server starts no Docker call any more).
  const server = new ChannelServer({
    write: (text) => {
      for (const line of text.split('\n').filter((part) => part !== '')) messages.push(JSON.parse(line) as ServerMessage);
      return true;
    },
    operations,
    exit: (code) => exits.push(code),
  });
  server.start();
  return { server, messages, exits };
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

  // Plan step 11I (PR A): 'exits only after its Docker call ended (SIGKILL after the grace), not before' is deleted with
  // the Docker calls of the server (OperationContext.docker); the wait for the result of a handler that ends late, the
  // rule that it checked through such a call, is the test above.
});
