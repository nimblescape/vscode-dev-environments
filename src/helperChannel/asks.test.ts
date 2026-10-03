// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11A (decision of 2026-10-03, the worker is the deputy): named secrets, and the requests of an operation to the
// extension (`ask` and `answer`), on the side of the script and in the protocol.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_OPEN_ASKS,
  MAX_SECRETS,
  StreamRedactor,
  encodeMessage,
  isAskKind,
  parseClientMessage,
  parseSecrets,
  parseServerMessage,
  redact,
  type ClientMessage,
  type ServerMessage,
} from '../core/helperChannel/protocol';
import { ChannelServer, OperationError, type OperationHandler, type ServerChild } from './server';

function setup(operations: Record<string, OperationHandler>) {
  const messages: ServerMessage[] = [];
  const server = new ChannelServer({
    write: (text) => {
      for (const line of text.split('\n').filter((part) => part !== '')) messages.push(JSON.parse(line) as ServerMessage);
      return true;
    },
    spawnDocker: (): ServerChild => {
      throw new Error('no Docker call in these tests');
    },
    operations,
    exit: () => {},
  });
  server.start();
  const send = (message: ClientMessage) => server.input(encodeMessage(message));
  const of = (id: number) => messages.filter((message) => 'id' in message && message.id === id);
  const asksOf = (id: number) => of(id).filter((message): message is Extract<ServerMessage, { t: 'ask' }> => message.t === 'ask');
  const resultOf = (id: number) => of(id).find((message) => message.t === 'result');
  return { send, of, asksOf, resultOf };
}

describe('named secrets and requests in the protocol (plan step 11A)', () => {
  it('parseSecrets takes 1 to MAX_SECRETS names with maskable values', () => {
    expect(parseSecrets({ token: 'abcd', registry: 'efgh' })).toEqual({ token: 'abcd', registry: 'efgh' });
    for (const value of [
      {},
      { token: 'abc' },
      { Token: 'abcd' },
      { 'to-ken': 'abcd' },
      { token: 5 },
      Object.fromEntries(Array.from({ length: MAX_SECRETS + 1 }, (_, i) => [`s${i}`, 'abcd'])),
      'abcd',
      null,
    ]) {
      expect(parseSecrets(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('parses `ask` and `answer` strictly', () => {
    expect(parseServerMessage('{"t":"ask","id":1,"ask":2,"kind":"question","payload":{"q":1}}')).toEqual({ t: 'ask', id: 1, ask: 2, kind: 'question', payload: { q: 1 } });
    expect(parseServerMessage('{"t":"ask","id":1,"ask":2,"kind":"other","payload":null}')).toBeUndefined();
    expect(parseServerMessage('{"t":"ask","id":1,"ask":2,"kind":"local","payload":null,"x":1}')).toBeUndefined();
    expect(parseClientMessage('{"t":"answer","id":1,"ask":2,"ok":true,"value":3,"secrets":{"token":"abcd"}}')).toEqual({
      t: 'answer',
      id: 1,
      ask: 2,
      ok: true,
      value: 3,
      secrets: { token: 'abcd' },
    });
    expect(parseClientMessage('{"t":"answer","id":1,"ask":2,"ok":false,"error":{"code":"no","message":"m"}}')).toEqual({
      t: 'answer',
      id: 1,
      ask: 2,
      ok: false,
      error: { code: 'no', message: 'm' },
    });
    for (const line of [
      '{"t":"answer","id":1,"ask":2,"ok":true,"secrets":{"token":"ab"}}',
      '{"t":"answer","id":1,"ask":-1,"ok":true}',
      '{"t":"answer","id":1,"ask":2,"ok":false}',
      '{"t":"answer","id":1,"ask":2,"ok":false,"error":{"code":"x","message":"m"},"secrets":{"token":"abcd"}}',
      '{"t":"op","id":1,"op":"x","params":null,"secret":"abcd"}',
      '{"t":"op","id":1,"op":"x","params":null,"secrets":{}}',
    ]) {
      expect(parseClientMessage(line), line).toBeUndefined();
    }
    expect(['question', 'local', 'record', 'secret', 'connect'].every(isAskKind)).toBe(true);
    expect(isAskKind('docker')).toBe(false);
  });

  it('redact masks every secret, the longer one first when one holds another', () => {
    expect(redact('a token1 b reg-pass c token1x', ['token1', 'reg-pass'])).toBe('a *** b *** c ***x');
    expect(redact('abcdef-123', ['abcdef-123', 'abcdef'])).toBe('***');
    expect(redact('abc', ['abc'])).toBe('abc');
    expect(redact('x abcd y', 'abcd')).toBe('x *** y');
  });

  it('StreamRedactor masks several secrets across pieces, and one that is added later', () => {
    const secrets = ['token-1'];
    const out: string[] = [];
    const redactor = new StreamRedactor(() => secrets, (text) => out.push(text));
    redactor.push('a tok');
    redactor.push('en-1 b ');
    // A secret added later is masked from then on (text sent before it cannot be).
    secrets.push('reg-pass');
    redactor.push('reg');
    redactor.push('-pass c');
    redactor.flush();
    expect(out.join('')).toBe('a *** b *** c');
    const plain: string[] = [];
    const none = new StreamRedactor(undefined, (text) => plain.push(text));
    none.push('x');
    expect(plain).toEqual(['x']);
  });
});

describe('requests of an operation to the extension, in the script (plan step 11A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the request, waits for the answer, and gets its value', async () => {
    const { send, asksOf, resultOf } = setup({
      asking: async (_params, context) => ({ answer: await context.ask('question', { text: 'Recreate?' }) }),
    });
    send({ t: 'op', id: 1, op: 'asking', params: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(asksOf(1)).toEqual([{ t: 'ask', id: 1, ask: 1, kind: 'question', payload: { text: 'Recreate?' } }]);
    send({ t: 'answer', id: 1, ask: 1, ok: true, value: 'recreate' });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toEqual({ t: 'result', id: 1, ok: true, value: { answer: 'recreate' } });
  });

  it('adds the secrets of an answer and masks them from then on, also in the payload of the next request', async () => {
    const { send, of, asksOf, resultOf } = setup({
      asking: async (_params, context) => {
        await context.ask('secret', { name: 'registry' });
        context.output('stdout', `pw=${context.secrets.registry} token=${context.secrets.token}\n`);
        context.log(`using ${context.secrets.registry}`);
        await context.ask('local', { echo: context.secrets.registry });
        return Object.keys(context.secrets).sort();
      },
    });
    send({ t: 'op', id: 1, op: 'asking', params: null, secrets: { token: 'tok-1234' } });
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'answer', id: 1, ask: 1, ok: true, value: null, secrets: { registry: 'reg-5678' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(asksOf(1)[1]).toMatchObject({ kind: 'local', payload: { echo: '***' } });
    send({ t: 'answer', id: 1, ask: 2, ok: true, value: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toEqual({ t: 'result', id: 1, ok: true, value: ['registry', 'token'] });
    const text = JSON.stringify(of(1));
    expect(text).not.toContain('reg-5678');
    expect(text).not.toContain('tok-1234');
  });

  it('rejects with the failure of the answer, as an OperationError with its code', async () => {
    const { send, resultOf } = setup({
      asking: async (_params, context) => {
        try {
          await context.ask('record', { write: 1 });
        } catch (error) {
          return { code: (error as OperationError).code, message: (error as Error).message, isOperationError: error instanceof OperationError };
        }
        return 'no error';
      },
    });
    send({ t: 'op', id: 1, op: 'asking', params: null });
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'answer', id: 1, ask: 1, ok: false, error: { code: 'unsupported', message: 'no handler' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: true, value: { code: 'unsupported', message: 'no handler', isOperationError: true } });
  });

  it('a cancel ends the wait with an AbortError, and an answer afterwards is ignored', async () => {
    let seen: unknown;
    const { send, resultOf } = setup({
      asking: async (_params, context) => {
        try {
          await context.ask('question', null);
        } catch (error) {
          seen = error;
          throw error;
        }
      },
    });
    send({ t: 'op', id: 1, op: 'asking', params: null });
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'cancel', id: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect((seen as Error).name).toBe('AbortError');
    expect(resultOf(1)).toMatchObject({ ok: false, cancelled: true });
    send({ t: 'answer', id: 1, ask: 1, ok: true, value: 1 });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a request after the end of its operation and an unknown answer change nothing', async () => {
    let late: Promise<unknown> | undefined;
    const { send, asksOf, resultOf } = setup({
      quick: async (_params, context) => {
        setTimeout(() => (late = context.ask('question', null).catch((error: unknown) => error)), 10);
        return 1;
      },
    });
    send({ t: 'op', id: 1, op: 'quick', params: null });
    send({ t: 'answer', id: 1, ask: 9, ok: true, value: 1 });
    await vi.advanceTimersByTimeAsync(20);
    expect(resultOf(1)).toMatchObject({ ok: true, value: 1 });
    expect(asksOf(1)).toEqual([]);
    expect(((await late) as Error).name).toBe('AbortError');
  });

  it('refuses more than MAX_OPEN_ASKS open requests, and an answer that brings more than MAX_SECRETS secrets', async () => {
    const { send, resultOf } = setup({
      many: async (_params, context) => {
        const open = Array.from({ length: MAX_OPEN_ASKS }, () => context.ask('local', null).catch(() => undefined));
        const extra = await context.ask('local', null).then(
          () => 'answered',
          (error: unknown) => (error as Error).message,
        );
        void open;
        return extra;
      },
      secrets: async (_params, context) =>
        context.ask('secret', null).then(
          () => 'answered',
          (error: unknown) => (error as OperationError).code,
        ),
    });
    send({ t: 'op', id: 1, op: 'many', params: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: true, value: 'Too many open requests to the extension.' });
    const seven = Object.fromEntries(Array.from({ length: MAX_SECRETS - 1 }, (_, i) => [`s${i}`, `secret-${i}`]));
    send({ t: 'op', id: 2, op: 'secrets', params: null, secrets: seven });
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'answer', id: 2, ask: 1, ok: true, value: null, secrets: { a1: 'abcd', a2: 'efgh' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(2)).toMatchObject({ ok: true, value: 'invalid' });
  });
});
