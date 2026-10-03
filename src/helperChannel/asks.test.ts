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
  isSecretName,
  parseClientMessage,
  parseSecrets,
  parseServerMessage,
  redact,
  type ClientMessage,
  type ServerMessage,
} from '../core/helperChannel/protocol';
import { batchChunkOperation, type BatchDeps } from './batch';
import { batchHelperOperations } from './batchHelper';
import { contextSecrets } from './operationContext.testkit';
import { dockerOperation } from './operations';
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

  // Review round 1 of plan step 11A (A-R1-1, A-R1-4): masked value by value, so a secret with `"` or `\` is masked too,
  // and a secret that looks like JSON cannot break the payload.
  it('masks a secret with quotes and backslashes in the payload and its keys, and a JSON-like secret breaks nothing', async () => {
    const secret = 'pa"ss\\word';
    const { send, asksOf } = setup({
      asking: async (_params, context) => context.ask('local', { text: `x ${secret} y`, [secret]: 1, list: [secret], n: 123456 }),
    });
    send({ t: 'op', id: 1, op: 'asking', params: null, secrets: { registry: secret, other: '2345' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(asksOf(1)[0].payload).toEqual({ text: 'x *** y', '***': 1, list: ['***'], n: 123456 });
    expect(JSON.stringify(asksOf(1))).not.toContain('pa\\"ss');
  });

  // Review round 1 of plan step 11A (A-R1-2): an answer that gives a name a new value keeps the old value masked.
  it('keeps masking the old value when an answer redefines a secret name', async () => {
    const { send, of } = setup({
      asking: async (_params, context) => {
        await context.ask('secret', null);
        context.log('old oldtoken1 new newtoken1');
        return 'done';
      },
    });
    send({ t: 'op', id: 1, op: 'asking', params: null, secrets: { token: 'oldtoken1' } });
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'answer', id: 1, ask: 1, ok: true, value: null, secrets: { token: 'newtoken1' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(of(1).find((message) => message.t === 'log')).toMatchObject({ text: 'old *** new ***' });
  });

  // Review round 1 of plan step 11A (pre-existing gap): the value of a result is masked too.
  it('masks the secrets in the value of a result, and fails a result that cannot be sent', async () => {
    const { send, resultOf } = setup({
      echo: async (_params, context) => ({ said: `token ${context.secrets.token}` }),
      cyclic: async () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
    });
    send({ t: 'op', id: 1, op: 'echo', params: null, secrets: { token: 'tok-1234' } });
    send({ t: 'op', id: 2, op: 'cyclic', params: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toEqual({ t: 'result', id: 1, ok: true, value: { said: 'token ***' } });
    expect(resultOf(2)).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('refuses a request whose payload cannot be sent (a cycle, a BigInt)', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { send, resultOf } = setup({
      asking: async (_params, context) => {
        const codes: string[] = [];
        for (const payload of [cyclic, { n: BigInt(1) }]) {
          await context.ask('local', payload).catch((error: unknown) => codes.push((error as OperationError).code));
        }
        return codes;
      },
    });
    send({ t: 'op', id: 1, op: 'asking', params: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: true, value: ['invalid', 'invalid'] });
  });
});

// Review round 1 of plan step 11A, mutation review (B-R1-1 to B-R1-10).
describe('named secrets and requests: the gaps of the mutation review (plan step 11A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('B-R1-1, B-R1-2: with several secrets, the longest one split across pieces and the start of a shorter one wait for the next piece', () => {
    const run = (pieces: string[]) => {
      const out: string[] = [];
      const redactor = new StreamRedactor(['abcdefghij', 'wxyz'], (text) => out.push(text));
      for (const piece of pieces) redactor.push(piece);
      redactor.flush();
      return out;
    };
    const long = run(['x abcdef', 'ghij y']);
    expect(long.join('')).toBe('x *** y');
    expect(long.some((piece) => piece.includes('abcdef'))).toBe(false);
    const short = run(['a wx', 'yz b']);
    expect(short.join('')).toBe('a *** b');
    expect(short.some((piece) => piece.endsWith('wx'))).toBe(false);
  });

  it('B-R1-3: a secret name has at most 32 characters', () => {
    expect(isSecretName('a'.repeat(32))).toBe(true);
    expect(isSecretName('a'.repeat(33))).toBe(false);
  });

  it('B-R1-4, B-R1-5: an answer with an unknown key, or a failure without `ok: false`, is refused', () => {
    for (const line of [
      '{"t":"answer","id":1,"ask":1,"ok":true,"value":1,"extra":1}',
      '{"t":"answer","id":1,"ask":1,"ok":"no","error":{"code":"x","message":"y"}}',
      '{"t":"answer","id":1,"ask":1,"error":{"code":"x","message":"y"}}',
    ]) {
      expect(parseClientMessage(line), line).toBeUndefined();
    }
  });

  it('B-R1-6: an answered request frees its place, so more than MAX_OPEN_ASKS requests one after another all get answers', async () => {
    const { send, asksOf, resultOf } = setup({
      many: async (_params, context) => {
        let sum = 0;
        for (let i = 0; i <= MAX_OPEN_ASKS; i++) sum += (await context.ask('local', i)) as number;
        return sum;
      },
    });
    send({ t: 'op', id: 1, op: 'many', params: null });
    for (let i = 1; i <= MAX_OPEN_ASKS + 1; i++) {
      await vi.advanceTimersByTimeAsync(0);
      send({ t: 'answer', id: 1, ask: i, ok: true, value: 1 });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(asksOf(1)).toHaveLength(MAX_OPEN_ASKS + 1);
    expect(resultOf(1)).toMatchObject({ ok: true, value: MAX_OPEN_ASKS + 1 });
  });

  it('B-R1-7: a request that the operation did not wait for ends with an AbortError at the end of the operation', async () => {
    let open: Promise<unknown> | undefined;
    const { send, resultOf } = setup({
      leaves: async (_params, context) => {
        open = context.ask('local', null).catch((error: unknown) => error);
        return 'done';
      },
    });
    send({ t: 'op', id: 1, op: 'leaves', params: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: true, value: 'done' });
    expect(((await open) as Error).name).toBe('AbortError');
  });

  it('B-R1-8: a request of an unknown kind is refused and not sent', async () => {
    const { send, asksOf, resultOf } = setup({
      bogus: async (_params, context) => context.ask('bogus' as never, null).catch((error: unknown) => (error as OperationError).code),
    });
    send({ t: 'op', id: 1, op: 'bogus', params: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: true, value: 'invalid' });
    expect(asksOf(1)).toEqual([]);
  });

  it('B-R1-9, B-R1-10: the secrets of an answer count, and a handler cannot change the secrets or their masking', async () => {
    const { send, of, resultOf } = setup({
      asking: async (_params, context) => {
        const before = context.hasNoSecret();
        await context.ask('secret', null);
        const after = { none: context.hasNoSecret(), registry: context.secrets.registry };
        delete (context.secrets as Record<string, string>).registry;
        context.log('x abcd1234 y');
        return { before, after, still: context.secrets.registry };
      },
    });
    send({ t: 'op', id: 1, op: 'asking', params: null });
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'answer', id: 1, ask: 1, ok: true, value: null, secrets: { registry: 'abcd1234' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: true, value: { before: true, after: { none: false, registry: '***' }, still: '***' } });
    expect(of(1).find((message) => message.t === 'log')).toMatchObject({ text: 'x *** y' });
  });
});

// Review round 1 of plan step 11A, mutation review (B-R1-16 to B-R1-18): each operation takes only its own secret.
describe('the secrets of the worker operations (plan step 11A)', () => {
  const base = {
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
    output: () => {},
    docker: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  };

  it('B-R1-16: a step that takes the token refuses another secret beside it', async () => {
    const operations = batchHelperOperations({ spawnStep: () => { throw new Error('never'); }, runQuiet: async () => {}, fs: {} as never, env: {} });
    const context = { ...base, ...contextSecrets({ token: 'abcd1234', registry: 'wxyz1234' }) };
    await expect(operations.clone({ repository: 'octo/hello' }, context)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('but the token') });
  });

  it('B-R1-17: a batch input takes no secret', async () => {
    const handler = batchChunkOperation({} as BatchDeps);
    const context = { ...base, ...contextSecrets({ token: 'abcd1234' }) };
    await expect(handler({ session: '0123456789abcdef01234567', input: 'fedcba9876543210fedcba98', data: 'x' }, context)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('B-R1-18: the secret input of a Docker call is only the token, never another secret', async () => {
    const calls: unknown[] = [];
    const context = { ...base, docker: async (...args: unknown[]) => (calls.push(args), { exitCode: 0, stdout: '', stderr: '' }), ...contextSecrets({ registry: 'abcd1234' }) };
    await expect(dockerOperation({ args: ['exec', '-i', 'c', 'cat'], inputIsSecret: true }, context)).rejects.toThrow('expects a secret');
    expect(calls).toEqual([]);
  });
});
