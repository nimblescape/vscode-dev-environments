// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11A (decision of 2026-10-03, the worker is the deputy): named secrets, and the requests of an operation to the
// extension (`ask` and `answer`), on the side of the script and in the protocol.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_MASKED_SECRETS,
  MAX_OPEN_ASKS,
  MAX_SERVER_LINE,
  MAX_SECRETS,
  StreamRedactor,
  encodeMessage,
  isAskKind,
  isSecretName,
  parseClientMessage,
  parseSecrets,
  parseServerMessage,
  parseTokenRemoveParams,
  parseTokenRemoveValue,
  redact,
  redactValue,
  type ClientMessage,
  type ServerMessage,
} from '../core/helperChannel/protocol';
import { batchChunkOperation, type BatchDeps } from './batch';
import { batchHelperOperations } from './batchHelper';
import { contextSecrets } from './operationContext.testkit';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { flowHost, tokenRemoveOperation } from './flowOperations';
import { hostRegistryCredentials, registryLogins } from '../core/worker/workerServices';
import { silentLogger } from '../core/ports';
import { dockerOperation } from './operations';
import { ChannelServer, OperationError, type OperationContext, type OperationHandler, type ServerChild } from './server';

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
    // Plan step 11E6 (decision A1 of 2026-10-05): changed, `connect` is no request kind any more.
    expect(['question', 'local', 'record', 'secret'].every(isAskKind)).toBe(true);
    expect(isAskKind('connect')).toBe(false);
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

  // Plan step 11E1 (review round 1 of PR #102, A-M1): the values that an operation masks in the output it keeps.
  it('maskedValues gives every secret value the operation ever held, also one an answer replaced, as a copy', async () => {
    let seen: { before: readonly string[]; after: readonly string[] } | undefined;
    const { send } = setup({
      asking: async (_params, context) => {
        const before = context.maskedValues();
        (before as string[]).push('not-a-secret');
        await context.ask('secret', null);
        seen = { before, after: context.maskedValues() };
        return 'done';
      },
    });
    send({ t: 'op', id: 1, op: 'asking', params: null, secrets: { token: 'oldtoken1' } });
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'answer', id: 1, ask: 1, ok: true, value: null, secrets: { token: 'newtoken1', registry: 'reg-5678' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen?.after).toEqual(['oldtoken1', 'newtoken1', 'reg-5678']);
  });

  it('forgetSecret: the operation no longer holds the secret, it stays masked, and a new answer brings it again (plan step 11E3a, decision B1)', async () => {
    const seen: { held: string[]; empty: boolean; again?: string }[] = [];
    const { send, of } = setup({
      asking: async (_params, context) => {
        await context.ask('secret', { name: 'registry' });
        context.forgetSecret('registry');
        context.forgetSecret('unknown');
        seen.push({ held: Object.keys(context.secrets), empty: context.hasNoSecret() });
        context.log('was reg-5678');
        await context.ask('secret', { name: 'registry' });
        seen.push({ held: Object.keys(context.secrets), empty: context.hasNoSecret(), again: context.secrets.registry });
        return context.maskedValues();
      },
    });
    send({ t: 'op', id: 1, op: 'asking', params: null });
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'answer', id: 1, ask: 1, ok: true, value: null, secrets: { registry: 'reg-5678' } });
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'answer', id: 1, ask: 2, ok: true, value: null, secrets: { registry: 'reg-9999' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([
      { held: [], empty: true },
      { held: ['registry'], empty: false, again: 'reg-9999' },
    ]);
    const text = JSON.stringify(of(1));
    expect(text).not.toContain('reg-5678');
    expect(text).not.toContain('reg-9999');
  });

  it('the registry logins of an operation: one asked at a time, each password its own, also when answers would come together (review round 1 of PR #109, A-H1)', async () => {
    const { send, asksOf, resultOf } = setup({
      asking: async (_params, context) => {
        const logins = registryLogins(flowHost(context), () => context.forgetSecret('registry'), silentLogger);
        const provider = hostRegistryCredentials(logins);
        const got = await Promise.all([provider('a.example'), provider('b.example')]);
        // The result is masked: what each provider got is compared here.
        return { own: [got[0]?.password === 'PASS-A1', got[1]?.password === 'PASS-B2'], users: got.map((login) => login?.username), held: Object.keys(context.secrets) };
      },
    });
    send({ t: 'op', id: 1, op: 'asking', params: null });
    await vi.advanceTimersByTimeAsync(0);
    // Only one request is open: the second login waits.
    expect(asksOf(1)).toHaveLength(1);
    expect(asksOf(1)[0]).toMatchObject({ kind: 'secret', payload: { call: 'registry', args: ['a.example'] } });
    send({ t: 'answer', id: 1, ask: 1, ok: true, value: { given: true, username: 'ua', serveraddress: 'a.example' }, secrets: { registry: 'PASS-A1' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(asksOf(1)).toHaveLength(2);
    send({ t: 'answer', id: 1, ask: 2, ok: true, value: { given: true, username: 'ub', serveraddress: 'b.example' }, secrets: { registry: 'PASS-B2' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({
      ok: true,
      value: { own: [true, true], users: ['ua', 'ub'], held: [] },
    });
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

// Review round 2 of plan step 11A (A-R2-1, A-R2-2, A-R2-4, B-R2-1 to B-R2-7).
describe('named secrets and requests: review round 2 (plan step 11A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A server whose Docker calls print `print` and end when `release` is called. */
  function setupWithDocker(operations: Record<string, OperationHandler>, print = '') {
    const messages: ServerMessage[] = [];
    let release: () => void = () => {};
    const server = new ChannelServer({
      write: (text) => {
        for (const line of text.split('\n').filter((part) => part !== '')) messages.push(JSON.parse(line) as ServerMessage);
        return true;
      },
      spawnDocker: (_args, onStdout, onStderr): ServerChild => {
        let resolve!: (value: { exitCode: number | null }) => void;
        const exited = new Promise<{ exitCode: number | null }>((r) => (resolve = r));
        release = () => resolve({ exitCode: 0 });
        return {
          end: () => {
            if (print !== '') {
              onStdout(`${print}\n`);
              onStderr(`${print}\n`);
            }
          },
          kill: () => resolve({ exitCode: null }),
          exited,
        };
      },
      operations,
      exit: () => {},
    });
    server.start();
    const send = (message: ClientMessage) => server.input(encodeMessage(message));
    const of = (id: number) => messages.filter((message) => 'id' in message && message.id === id);
    return { send, of, release: () => release() };
  }

  it('A-R2-1: redactValue sends what JSON sends for an object with toJSON (a Date, a Buffer)', () => {
    const date = new Date('2026-10-03T00:00:00.000Z');
    expect(redactValue({ date, data: Buffer.from('ab') }, ['secret-1'])).toEqual(JSON.parse(JSON.stringify({ date, data: Buffer.from('ab') })));
    expect(redactValue({ hidden: { toJSON: () => 'shown secret-1' } }, ['secret-1'])).toEqual({ hidden: 'shown ***' });
  });

  it('A-R2-2: refuses a value with two keys that are the same once masked', () => {
    expect(() => redactValue({ 'x secret-1': 1, 'x ***': 2 }, ['secret-1'])).toThrow(/same/);
  });

  it('B-R2-1: a shared object that is no cycle is sent intact', async () => {
    const shared = { n: 1 };
    const { send, asksOf, resultOf } = setup({
      shared: async (_params, context) => {
        await context.ask('local', [shared, shared]);
        return { a: shared, b: shared };
      },
    });
    send({ t: 'op', id: 1, op: 'shared', params: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(asksOf(1)[0].payload).toEqual([{ n: 1 }, { n: 1 }]);
    send({ t: 'answer', id: 1, ask: 1, ok: true, value: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: true, value: { a: { n: 1 }, b: { n: 1 } } });
  });

  it('A-R2-4: an answer beyond MAX_MASKED_SECRETS values is refused', async () => {
    const { send, resultOf } = setup({
      many: async (_params, context) => {
        for (let i = 0; i < MAX_MASKED_SECRETS; i++) {
          const outcome = await context.ask('secret', null).then(
            () => undefined,
            (error: unknown) => (error as OperationError).code,
          );
          if (outcome !== undefined) return { refusedAt: i, code: outcome };
        }
        return 'never refused';
      },
    });
    send({ t: 'op', id: 1, op: 'many', params: null, secrets: { token: 'value-0000' } });
    for (let i = 1; i <= MAX_MASKED_SECRETS; i++) {
      await vi.advanceTimersByTimeAsync(0);
      send({ t: 'answer', id: 1, ask: i, ok: true, value: null, secrets: { token: `value-${String(i).padStart(4, '0')}` } });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: true, value: { refusedAt: MAX_MASKED_SECRETS - 1, code: 'invalid' } });
  });

  it('B-R2-4 to B-R2-7: the old value of a redefined name stays masked in output, Docker output and log, and failure messages', async () => {
    const { send, of, release } = setupWithDocker(
      {
        run: async (_params, context) => {
          await context.ask('secret', null);
          context.output('stdout', 'out old-token-1\n');
          const docker = context.docker(['ps'], { stream: true });
          release();
          const result = await docker;
          throw new OperationError('failed', `x old-token-1 ${result.stderr.includes('***') ? 'masked' : 'plain'}`);
        },
        plain: async (_params, context) => {
          await context.ask('secret', null);
          throw new Error('raw old-token-1');
        },
      },
      'docker old-token-1',
    );
    send({ t: 'op', id: 1, op: 'run', params: null, secrets: { token: 'old-token-1' } });
    send({ t: 'op', id: 2, op: 'plain', params: null, secrets: { token: 'old-token-1' } });
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'answer', id: 1, ask: 1, ok: true, value: null, secrets: { token: 'new-token-2' } });
    send({ t: 'answer', id: 2, ask: 1, ok: true, value: null, secrets: { token: 'new-token-2' } });
    await vi.advanceTimersByTimeAsync(10);
    const text = JSON.stringify([...of(1), ...of(2)]);
    expect(text).not.toContain('old-token-1');
    expect(of(1).at(-1)).toMatchObject({ t: 'result', ok: false, error: { message: 'x *** masked' } });
    expect(of(2).at(-1)).toMatchObject({ t: 'result', ok: false, error: { message: 'raw ***' } });
  });

  it('B-R2-2: no request goes out while the operation ends (its Docker call still running)', async () => {
    let late: Promise<unknown> | undefined;
    let ask: ((kind: 'local', payload: unknown) => Promise<unknown>) | undefined;
    const { send, of, release } = setupWithDocker({
      leaves: async (_params, context) => {
        void context.docker(['ps']);
        ask = context.ask;
        return 'done';
      },
    });
    send({ t: 'op', id: 1, op: 'leaves', params: null });
    await vi.advanceTimersByTimeAsync(0);
    late = ask!('local', null).catch((error: unknown) => error);
    expect(((await late) as Error).name).toBe('AbortError');
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(of(1).filter((message) => message.t === 'ask')).toEqual([]);
  });

  it('B-R2-3: a request whose line is longer than MAX_SERVER_LINE is refused, and one just within goes out', async () => {
    const overhead = encodeMessage({ t: 'ask', id: 1, ask: 1, kind: 'local', payload: '' }).length - 1;
    const { send, asksOf, resultOf } = setup({
      sized: async (_params, context) => {
        const tooLong = await context.ask('local', 'x'.repeat(MAX_SERVER_LINE - overhead + 1)).catch((error: unknown) => (error as OperationError).code);
        const fits = context.ask('local', 'y'.repeat(MAX_SERVER_LINE - overhead));
        return { tooLong, fits: await fits };
      },
    });
    send({ t: 'op', id: 1, op: 'sized', params: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(asksOf(1)).toHaveLength(1);
    send({ t: 'answer', id: 1, ask: 2, ok: true, value: 'ok' });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: true, value: { tooLong: 'invalid', fits: 'ok' } });
  });

  // Review round 3 of plan step 11A (A-R3-2, A-R3-3, B-R3-1 to B-R3-7).
  it('toJSON gets the key of its value, a boxed primitive is its value, and the cap is 32', () => {
    const keyOf = { toJSON: (key: string) => `key:${key}` };
    expect(redactValue({ a: keyOf, list: [keyOf, keyOf] }, [])).toEqual({ a: 'key:a', list: ['key:0', 'key:1'] });
    expect(redactValue(keyOf, [])).toBe('key:');
    expect(redactValue({ s: new String('secret-token'), n: new Number(1), b: new Boolean(true) }, ['secret-token'])).toEqual({ s: '***', n: 1, b: true });
    expect(MAX_MASKED_SECRETS).toBe(32);
  });

  it('counts only new values against the cap (once each), and a refused answer changes no secret', async () => {
    const { send, resultOf } = setup({
      many: async (_params, context) => {
        const codes: (string | null)[] = [];
        for (let i = 0; i < 32; i++) {
          codes.push(await context.ask('secret', null).then(() => null, (error: unknown) => (error as OperationError).code));
        }
        return { codes, tokenKept: context.secrets.token === 'value-0000', registryAdded: context.secrets.registry === 'registry-0001' };
      },
    });
    send({ t: 'op', id: 1, op: 'many', params: null, secrets: { token: 'value-0000' } });
    for (let i = 1; i <= 32; i++) {
      await vi.advanceTimersByTimeAsync(0);
      const secrets: Record<string, string> =
        i <= 30
          ? { token: `value-${String(i).padStart(4, '0')}` }
          : i === 31
            ? { token: 'value-0000', registry: 'registry-0001', other: 'registry-0001' }
            : { token: 'value-9999' };
      send({ t: 'answer', id: 1, ask: i, ok: true, value: null, secrets });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: true, value: { codes: [...Array(31).fill(null), 'invalid'], tokenKept: true, registryAdded: true } });
  });
});

// Plan step 11B1: the operation that runs the first flow in the worker, with its requests to the extension.
describe('the tokenRemove operation (plan step 11B1)', () => {
  const ENVIRONMENT_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
  const CONTAINER = 'devenv-acme-api-brave-noether';
  const base = {
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
    output: () => {},
    docker: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  };

  function engineOf(running: boolean): DockerEngine {
    const container = {
      id: 'c'.repeat(64),
      name: CONTAINER,
      state: running ? ('running' as const) : ('stopped' as const),
      rawState: running ? 'running' : 'exited',
      labels: { 'nimblescape.devenv.environment-id': ENVIRONMENT_ID },
      image: 'img:1',
    };
    return {
      ...unusedEngine(),
      container: async () => container,
      containers: async () => (running ? [container] : []),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      stop: async () => {},
      start: async () => {},
    };
  }

  /** A context that records its log lines and progress (review round 1 of plan step 11B1, B-R1-15). */
  function recording(ask: OperationContext['ask']) {
    const logs: string[] = [];
    const progress: unknown[][] = [];
    const context = {
      ...base,
      ...contextSecrets(),
      ask,
      log: (line: string) => logs.push(line),
      progress: (...args: unknown[]) => progress.push(args),
    } as unknown as OperationContext;
    return { context, logs, progress };
  }

  it('asks the extension for the record of the environment when root may not, and answers with what it did', async () => {
    const asks: { kind: string; payload: unknown }[] = [];
    // Review round 1 of plan step 11B1 (A-R1-7): the record names only the user of the second try, so root fails here.
    const engine = { ...engineOf(true), exec: async (_c: string, _cmd: readonly string[], options: { user?: string } = {}) => ({ exitCode: options.user === 'root' ? 1 : 0, stdout: '', stderr: '', timedOut: false }) };
    const { context, logs, progress } = recording(async (kind: string, payload: unknown) => {
      asks.push({ kind, payload });
      return { id: ENVIRONMENT_ID, remoteUser: 'dev' };
    });
    const value = await tokenRemoveOperation(() => engine)({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER }, context);
    expect(value).toEqual({ outcome: 'removed', container: 'c'.repeat(12) });
    expect(asks).toEqual([{ kind: 'record', payload: { call: 'get', args: [ENVIRONMENT_ID] } }]);
    expect(progress).toEqual([['tokenRemove', CONTAINER]]);
    expect(logs).toEqual([`The removal as root failed in the container ${CONTAINER}: exit code 1.`, `The GitHub token was removed from the container ${CONTAINER}.`]);
  });

  it('passes the cancel of the operation to every call to the engine (review round 2, B-R2-5)', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const base_ = engineOf(true);
    const engine = {
      ...base_,
      containers: async (label: string, signal?: AbortSignal) => (signals.push(signal), base_.containers(label)),
      exec: async (c: string, cmd: readonly string[], options: { signal?: AbortSignal } = {}) => (signals.push(options.signal), base_.exec(c, cmd)),
    };
    const { context } = recording(async () => null);
    await tokenRemoveOperation(() => engine)({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER }, context);
    expect(signals).toEqual([context.signal, context.signal]);
  });

  it('builds the port of the engine with the context of the operation', async () => {
    const seen: OperationContext[] = [];
    const { context } = recording(async () => null);
    await tokenRemoveOperation((given) => (seen.push(given), engineOf(true)))({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER }, context);
    expect(seen).toEqual([context]);
  });

  it('answers `notRunning` when no container of the environment runs', async () => {
    const { context, logs } = recording(async () => null);
    expect(await tokenRemoveOperation(() => engineOf(false))({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER }, context)).toEqual({ outcome: 'notRunning' });
    expect(logs).toEqual([`The container ${CONTAINER} does not run: its memory holds no GitHub token.`]);
  });

  it('refuses invalid parameters and any secret', async () => {
    const context = { ...base, ...contextSecrets(), ask: async () => null } as unknown as OperationContext;
    const engine = engineOf(true);
    // 'a b' and '../x' are no storage ID (src/core/storage/paths.ts), '../x' no container name; a key too many is refused too.
    for (const params of [
      {},
      { environmentId: 'a b', containerName: CONTAINER },
      { environmentId: '../x', containerName: CONTAINER },
      { environmentId: ENVIRONMENT_ID },
      { environmentId: ENVIRONMENT_ID, containerName: '../x' },
      { environmentId: ENVIRONMENT_ID, containerName: CONTAINER, user: 'root' },
    ]) {
      await expect(tokenRemoveOperation(() => engine)(params, context)).rejects.toMatchObject({ code: 'invalid' });
    }
    const withSecret = { ...base, ...contextSecrets({ token: 'abcd1234' }), ask: async () => null } as unknown as OperationContext;
    await expect(tokenRemoveOperation(() => engine)({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER }, withSecret)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('fails with the reason when the token could still be there', async () => {
    const engine = { ...engineOf(true), exec: async () => ({ exitCode: 1, stdout: '', stderr: 'root may not', timedOut: false }) };
    const context = { ...base, ...contextSecrets(), ask: async () => null } as unknown as OperationContext;
    await expect(tokenRemoveOperation(() => engine)({ environmentId: ENVIRONMENT_ID, containerName: CONTAINER }, context)).rejects.toMatchObject({
      code: 'failed',
      message: 'root may not',
    });
  });
});

// Review round 1 of plan step 11B1 (B-R1-16): the checks of the parameters and the value of `tokenRemove`, directly.
describe('the checks of tokenRemove (plan step 11B1)', () => {
  it('takes the value of each outcome, and nothing else', () => {
    expect(parseTokenRemoveValue({ outcome: 'notRunning' })).toEqual({ outcome: 'notRunning' });
    expect(parseTokenRemoveValue({ outcome: 'removed', container: 'c0ffeec0ffee' })).toEqual({ outcome: 'removed', container: 'c0ffeec0ffee' });
    expect(parseTokenRemoveValue({ outcome: 'removed' })).toEqual({ outcome: 'removed' });
    for (const value of [
      {},
      null,
      { outcome: 'maybe' },
      { outcome: 'removed', container: 'c0ffee' },
      // Review round 2 of plan step 11B1 (B-R2-20): exactly twelve.
      { outcome: 'removed', container: 'c0ffeec0ffeec' },
      { outcome: 'removed', container: 'C0FFEEC0FFEE' },
      { outcome: 'removed', container: 1 },
      { outcome: 'removed', extra: 1 },
    ]) {
      expect(parseTokenRemoveValue(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('takes an environment ID and a container name, and nothing else', () => {
    const params = { environmentId: '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d', containerName: 'devenv-acme-api-brave-noether' };
    expect(parseTokenRemoveParams(params)).toEqual(params);
    for (const value of [null, [], { ...params, more: 1 }, { ...params, environmentId: 'a.b' }, { ...params, containerName: '-x' }, { ...params, containerName: 1 }]) {
      expect(parseTokenRemoveParams(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});
