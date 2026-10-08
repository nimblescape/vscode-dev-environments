// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_CLEANUP_TIMEOUT_MS,
  CHANNEL_KILL_GRACE_MS,
  CHANNEL_PROTOCOL_VERSION,
  CHANNEL_SERVER_IDLE_EXIT_MS,
  CHANNEL_SILENCE_EXIT_MS,
  MAX_CLIENT_LINE,
  MAX_SERVER_LINE,
  OUTPUT_CHUNK_CHARACTERS,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from '../core/helperChannel/protocol';
import { REFRESH_ENVIRONMENTS } from '../core/pipeline/refreshStates.testkit';
import { abortError } from '../core/ports';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { OPERATIONS, refreshOperation } from './operations';
import { ChannelServer, OperationError, MAX_LOG_TEXT, SHUTDOWN_DEADLINE_MS, type OperationHandler } from './server';
import { StreamRedactor, redact } from '../core/helperChannel/protocol';

/** Plan step 11I (PR A): a run of the operation `hold` of the tests. */
interface Held {
  params: unknown;
  /** Whether the signal of the operation aborted (a cancel, its time limit, the end of the script). */
  aborted: boolean;
  /** Output of the operation as it comes (OperationContext.output). */
  output(stream: 'stdout' | 'stderr', text: string): void;
  /** Ends its handler with `value`. */
  end(value?: unknown): void;
}

/**
 * Plan step 11I (PR A): the operation `hold` of the tests, in place of the operation `call` of the tests over the removed
 * OperationContext.docker (a Docker call of the server, which the cases of the server used as the work of an operation
 * that runs until it ends or is ended): it runs until the test ends it, its output as the test gives it, and it records
 * whether its signal aborted. `endsOnAbort`: its handler ends with an AbortError when its signal aborts, as a request to
 * the engine of the port does (before: a Docker call that ended on SIGTERM); without it, only when the test ends it
 * (before: a Docker call that ended only on SIGKILL). Its parameters: null or a name (a string); anything else is
 * invalid.
 */
function holdOperation(options: { endsOnAbort?: boolean } = {}) {
  const runs: Held[] = [];
  const handler: OperationHandler = (params, context) => {
    if (params !== null && typeof params !== 'string') return Promise.reject(new OperationError('invalid', 'The parameters of hold are invalid.'));
    return new Promise((resolve, reject) => {
      const run: Held = { params, aborted: false, output: (stream, text) => context.output(stream, text), end: (value = null) => resolve(value) };
      runs.push(run);
      context.signal.addEventListener(
        'abort',
        () => {
          run.aborted = true;
          if (options.endsOnAbort === true) reject(abortError());
        },
        { once: true },
      );
    });
  };
  return { runs, handler };
}

function setup(options: { operations?: Record<string, OperationHandler>; hold?: ReturnType<typeof holdOperation>; writable?: () => boolean } = {}) {
  // Plan step 11I (PR A): changed setup: the operations of the worker and `hold` (before: `call` and a fake `docker`).
  const held = options.hold ?? holdOperation();
  const messages: ServerMessage[] = [];
  const exits: number[] = [];
  const server = new ChannelServer({
    write: (text) => {
      if (options.writable && !options.writable()) return false;
      for (const line of text.split('\n').filter((part) => part !== '')) messages.push(JSON.parse(line) as ServerMessage);
      return true;
    },
    operations: options.operations ?? { ...OPERATIONS, hold: held.handler },
    exit: (code) => exits.push(code),
  });
  server.start();
  const send = (message: ClientMessage) => server.input(encodeMessage(message));
  const of = (id: number) => messages.filter((message) => 'id' in message && message.id === id);
  const resultOf = (id: number) => of(id).find((message) => message.t === 'result');
  return { server, held, messages, exits, send, of, resultOf };
}

describe('ChannelServer (user request 2026-09-28: the helper channel)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers hello with its protocol, its Node.js version, and its operations; ping with pong', () => {
    const { send, messages } = setup({ operations: OPERATIONS });
    send({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION });
    send({ t: 'ping', n: 7 });
    expect(messages).toEqual([
      // Review round 4 (M1): with the sweep of never-started channel containers.
      // Plan step 5, PR B: changed expectation: `lock` too.
      // Plan step 11I1, PR B1: changed expectation: the relay operations `batch`, `batchChunk`, `batchStep`, `docker`, `lock`,
      // `pull` and `startContainers` are gone.
      { t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: process.version, ops: ['delete', 'deleteCheck', 'heartbeat', 'listConfigurations', 'monitorEnsure', 'open', 'probe', 'reconcile', 'recordGitState', 'refresh', 'stop', 'sweep', 'tokenRemove', 'windowState'] }, // plan step 5, PR C: `refresh`; plan step 6, PR B: changed expectation, the batch operations; plan step 10A: changed expectation, `pull` and `startContainers`; plan step 11B2: changed expectation, `stop`; plan step 11B3b: changed expectation, `listConfigurations`; plan step 11C1: changed expectation, `windowState`; plan step 11C2a: changed expectation, `delete`; plan step 11C2b: changed expectation, `deleteCheck`; plan step 11C3: changed expectation, `reconcile`; plan step 11D1: changed expectation, `heartbeat`, `monitorSettings`, `recordGitState`; plan step 11D2: changed expectation, `monitorEnsure`; plan step 11E6: changed expectation, `open`, and `monitorSettings` removed (decision D1)
      { t: 'pong', n: 7 },
    ]);
  });

  // Plan step 11I (PR A): changed test: the output of the operation `hold` (before: of a Docker call of the operation
  // `call`, with its input and a log line per call, which are gone with OperationContext.docker).
  it('sends the output of an operation as it comes, then its result', async () => {
    const { send, held, of } = setup();
    send({ t: 'op', id: 1, op: 'hold', params: 'out' });
    const [run] = held.runs;
    expect(run.params).toBe('out');
    run.output('stdout', 'line 1\n');
    run.output('stderr', 'warning\n');
    run.end({ exitCode: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(of(1)).toEqual([
      { t: 'out', id: 1, stream: 'stdout', data: 'line 1\n' },
      { t: 'out', id: 1, stream: 'stderr', data: 'warning\n' },
      { t: 'result', id: 1, ok: true, value: { exitCode: 0 } },
    ]);
  });

  // Plan step 11I (PR A): 'names the last line of the error output in the log line of a failed call' is deleted with the
  // log lines of the Docker calls of the server (`$ docker …`, then the exit code with the last error line), which are gone
  // with OperationContext.docker.

  // Plan step 11I (PR A): changed test: the output of the operation `hold` (before: of a Docker call of the operation `call`).
  it('splits long output into pieces of OUTPUT_CHUNK_CHARACTERS', async () => {
    const { send, held, of } = setup();
    send({ t: 'op', id: 1, op: 'hold', params: null });
    held.runs[0].output('stdout', 'a'.repeat(OUTPUT_CHUNK_CHARACTERS + 5));
    held.runs[0].end();
    await vi.advanceTimersByTimeAsync(0);
    const pieces = of(1).filter((message) => message.t === 'out') as { data: string }[];
    expect(pieces.map((piece) => piece.data.length)).toEqual([OUTPUT_CHUNK_CHARACTERS, 5]);
  });

  // Plan step 11I (PR A): changed test: the output of the operation `hold` (before: of a Docker call whose input was the
  // secret; the input of a Docker call is gone with OperationContext.docker).
  it('masks the secret in the output of an operation, also when a chunk splits it', async () => {
    const { send, held, of } = setup();
    const secret = 'ghp_secretTOKEN123';
    send({ t: 'op', id: 1, op: 'hold', params: null, secrets: { token: secret } });
    const [run] = held.runs;
    run.output('stdout', `echo ${secret.slice(0, 6)}`);
    run.output('stdout', `${secret.slice(6)} done\n`);
    run.output('stderr', secret);
    run.end();
    await vi.advanceTimersByTimeAsync(0);
    const text = JSON.stringify(of(1));
    expect(text).not.toContain(secret);
    const stdout = of(1)
      .filter((message) => message.t === 'out' && message.stream === 'stdout')
      .map((message) => (message as { data: string }).data)
      .join('');
    expect(stdout).toBe('echo *** done\n');
  });

  // Review round 1 of PR #89 (A-R1-4): the message of a failed operation can carry text of the engine or a registry.
  it('masks the secret in the error message of a failed operation', async () => {
    const secret = 'registry-PASSWORD-9';
    const { send, of } = setup({
      operations: {
        fails: async () => {
          throw new OperationError('failed', `the registry said: bad credentials ${secret}`);
        },
        throws: async () => {
          throw new Error(`raw ${secret}`);
        },
      },
    });
    send({ t: 'op', id: 1, op: 'fails', params: null, secrets: { token: secret } });
    send({ t: 'op', id: 2, op: 'throws', params: null, secrets: { token: secret } });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify([...of(1), ...of(2)])).not.toContain(secret);
    expect(of(1).at(-1)).toMatchObject({ t: 'result', ok: false, error: { code: 'failed', message: 'the registry said: bad credentials ***' } });
    expect(of(2).at(-1)).toMatchObject({ t: 'result', ok: false, error: { code: 'failed', message: 'raw ***' } });
  });

  // Plan step 11I (PR A): changed test: through the operation `hold` (before: `call`, whose Docker call was the one start).
  it('answers an unknown operation, invalid parameters, an invalid request with an id, and a second use of an id', async () => {
    const { send, server, held, resultOf, messages } = setup();
    send({ t: 'op', id: 1, op: 'nothing', params: {} });
    send({ t: 'op', id: 2, op: 'hold', params: { args: [] } });
    server.input(`${JSON.stringify({ t: 'op', id: 3, op: 'hold', params: null, extra: 1 })}\n`);
    send({ t: 'op', id: 4, op: 'hold', params: 'first' });
    send({ t: 'op', id: 4, op: 'hold', params: 'second' });
    // A line without an id of an operation is ignored.
    server.input('{"t":"what"}\nnot json\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: false, error: { code: 'unknown' } });
    expect(resultOf(2)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(resultOf(3)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(messages.filter((message) => message.t === 'result' && message.id === 4)).toMatchObject([{ ok: false, error: { code: 'invalid' } }]);
    expect(held.runs.map((run) => run.params)).toEqual(['first']);
  });

  it('does not run an operation of the prototype chain of the operations', async () => {
    const { send, resultOf } = setup();
    send({ t: 'op', id: 1, op: 'constructor', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: false, error: { code: 'unknown' } });
  });

  // Plan step 11I1, PR B1: changed expectation: no removal of the containers of a cleanup label any more (it came between
  // the end of the call and the result). Plan step 11I (PR A): changed expectation: the signal of the operation `hold`
  // aborts, and its result follows when its handler ended (before: SIGTERM, then SIGKILL after the grace time, to the
  // Docker call of the operation `call`; the Docker calls of the server are gone).
  it('cancels an operation: its signal aborts, then its result when its handler ended', async () => {
    const { send, held, resultOf } = setup();
    send({ t: 'op', id: 1, op: 'hold', params: null });
    expect(held.runs[0].aborted).toBe(false);
    send({ t: 'cancel', id: 1 });
    expect(held.runs[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(CHANNEL_KILL_GRACE_MS);
    expect(resultOf(1)).toBeUndefined();
    held.runs[0].end({ late: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(held.runs).toHaveLength(1);
    expect(resultOf(1)).toEqual({ t: 'result', id: 1, ok: false, error: { code: 'cancelled', message: 'The operation was cancelled.' }, cancelled: true, timedOut: false });
  });

  // Plan step 11I1, PR B1: changed expectation: no removal of the containers of a cleanup label any more. Plan step 11I
  // (PR A): changed expectation: the signal of the operation `hold` aborts at the limit, not before (before: SIGTERM to a
  // Docker call of the operation `call`).
  it('ends an operation at its time limit (timedOut)', async () => {
    const { send, held, resultOf } = setup({ hold: holdOperation({ endsOnAbort: true }) });
    send({ t: 'op', id: 1, op: 'hold', params: null, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(held.runs[0].aborted).toBe(false);
    expect(resultOf(1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(held.runs[0].aborted).toBe(true);
    expect(held.runs).toHaveLength(1);
    expect(resultOf(1)).toMatchObject({ ok: false, error: { code: 'timeout' }, cancelled: false, timedOut: true });
  });

  // Plan step 11I (PR A): 'sweep prunes only stopped channel containers older than 10 minutes (review round 4, M1)' moved
  // to operations.test.ts (the sweep over the port of the engine, the same two filters) and engineClient.probe.test.ts
  // (its request); before: the arguments of `docker container prune -f` through OperationContext.docker.

  // Plan step 11I1, PR B1: changed test (before: also the removal of the containers of its cleanup label within
  // LATE_CANCEL_WINDOW_MS, review round 2, A1, which is gone): the confirmation of the cancel alone. Plan step 11I (PR A):
  // changed test: through the operation `hold` (before: `call`), whose signal the late cancel does not reach.
  it('confirms the cancel of an operation that crossed its result, and starts nothing for it (review round 4, M2)', async () => {
    const { send, held, messages } = setup();
    send({ t: 'op', id: 1, op: 'hold', params: null });
    held.runs[0].end();
    await vi.advanceTimersByTimeAsync(0);
    // The cancel of 1 comes after its result was sent.
    send({ t: 'cancel', id: 1 });
    await vi.advanceTimersByTimeAsync(0);
    // Review round 4 (M2): the script confirms the cancel of an operation that had ended.
    expect(messages.filter((message) => message.t === 'cancelled')).toEqual([{ t: 'cancelled', id: 1 }]);
    expect(held.runs).toHaveLength(1);
    expect(held.runs[0].aborted).toBe(false);
  });

  // Plan step 11I (PR A): 'pauses the output of the calls while the answers wait to be written, and resumes it when they
  // are (review round 2, A2)' is deleted: its subject, the pause and resume of the Docker calls of the server
  // (ServerChild.pause and resume), is gone with them. The same rule for the only output that the server still pauses,
  // the output that an operation reads from the engine itself (pausable: paused while congested, a target that comes
  // meanwhile starts paused, all resumed by the drain), is the next test.

  // Plan step 11I (PR A): changed setup: the output that makes the connection congested comes from the operation `hold`
  // (before: from a Docker call of the operation `call`, which was paused with the targets).
  it('plan step 11G3: pauses and resumes the output that an operation reads from the engine itself, until it is removed or the operation ends', async () => {
    let congested = false;
    let drain: (() => void) | undefined;
    const held = holdOperation();
    const events: string[] = [];
    let remove: (() => void) | undefined;
    const endHolder: Record<string, () => void> = {};
    const holders: Record<string, OperationHandler> = {
      // As the batch helper of the worker: its output comes over the Engine API, not from a Docker call of the script.
      holder: (params, context) => {
        const name = String(params);
        remove = context.pausable?.({ pause: () => events.push(`pause ${name}`), resume: () => events.push(`resume ${name}`) });
        return new Promise((resolve) => (endHolder[name] = () => resolve({})));
      },
    };
    const server = new ChannelServer({
      write: () => true,
      operations: { ...OPERATIONS, hold: held.handler, ...holders },
      exit: () => {},
      congested: () => congested,
      onDrain: (listener) => (drain = listener),
    });
    server.start();
    server.input(encodeMessage({ t: 'op', id: 1, op: 'holder', params: 'a' }));
    server.input(encodeMessage({ t: 'op', id: 2, op: 'hold', params: null }));
    congested = true;
    held.runs[0].output('stdout', 'lots of output');
    expect(events).toEqual(['pause a']);
    // One that registers while the output is paused starts paused; its removal resumes it, so it never stays paused.
    server.input(encodeMessage({ t: 'op', id: 3, op: 'holder', params: 'b' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['pause a', 'pause b']);
    remove?.();
    expect(events).toEqual(['pause a', 'pause b', 'resume b']);
    congested = false;
    drain?.();
    expect(events).toEqual(['pause a', 'pause b', 'resume b', 'resume a']);
    // The end of its operation removes it: a later congestion no longer pauses it.
    endHolder.a();
    endHolder.b();
    await vi.advanceTimersByTimeAsync(0);
    congested = true;
    held.runs[0].output('stdout', 'more output');
    expect(events).toEqual(['pause a', 'pause b', 'resume b', 'resume a']);
    server.shutdown();
  });

  // Plan step 11I (PR A): changed setup: the long log line and progress come from the operation (before: the log line of a
  // Docker call with long arguments, gone with OperationContext.docker).
  it('cuts a log line that would be longer than the extension reads, and fails a result that is too large (review round 2, C1)', async () => {
    const huge = '\\'.repeat(2_000_000);
    const operations: Record<string, OperationHandler> = {
      big: async () => 'x'.repeat(MAX_SERVER_LINE),
      long: async (_params, context) => {
        context.log(huge);
        context.progress(huge, huge);
        return null;
      },
    };
    const { send, of } = setup({ operations });
    send({ t: 'op', id: 1, op: 'long', params: null });
    send({ t: 'op', id: 2, op: 'big', params: null });
    await vi.advanceTimersByTimeAsync(0);
    const lines = of(1).filter((message) => message.t === 'log') as { text: string }[];
    expect(lines[0].text.length).toBeLessThanOrEqual(MAX_LOG_TEXT + 1);
    expect(lines[0].text.endsWith('…')).toBe(true);
    const progress = of(1).find((message) => message.t === 'progress') as { step: string; detail: string };
    expect([progress.step.length, progress.detail.length]).toEqual([MAX_LOG_TEXT + 1, MAX_LOG_TEXT + 1]);
    for (const message of [...of(1), ...of(2)]) expect(encodeMessage(message).length).toBeLessThanOrEqual(MAX_SERVER_LINE);
    expect(of(2)).toEqual([
      { t: 'result', id: 2, ok: false, error: { code: 'tooLarge', message: 'The result of the operation is too large for the helper channel.' }, cancelled: false, timedOut: false },
    ]);
  });

  // Plan step 11I (PR A): changed test (before: 'masks the secret before it cuts the last error line of the log (review
  // round 1, S2)', the last error line of a Docker call of the server, cut at 500 characters in its log line, which is gone
  // with OperationContext.docker): the same rule for the texts that the server still cuts, a log line and the step and
  // detail of a progress message (MAX_LOG_TEXT, review round 2, C1): masked before the cut, so that a cut cannot leave a
  // part of the secret that the mask no longer finds.
  it('masks the secret before it cuts a log or progress text (review round 1, S2)', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    // The secret spans the cut at MAX_LOG_TEXT characters; masked, the text is still longer than that.
    const head = 'x'.repeat(MAX_LOG_TEXT - 12);
    const text = `${head}${secret} failed ${'y'.repeat(100)}`;
    const operations: Record<string, OperationHandler> = {
      fails: async (_params, context) => {
        context.log(text, 'warn');
        context.progress(text);
        context.progress(text, text);
        return null;
      },
    };
    const { send, of } = setup({ operations });
    send({ t: 'op', id: 1, op: 'fails', params: null, secrets: { token: secret } });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(of(1))).not.toContain(secret.slice(0, 12));
    const masked = `${head}*** failed ${'y'.repeat(100)}`;
    const expected = `${masked.slice(0, MAX_LOG_TEXT)}…`;
    expect(of(1).filter((message) => message.t !== 'result')).toEqual([
      { t: 'log', id: 1, level: 'warn', text: expected },
      { t: 'progress', id: 1, step: expected },
      { t: 'progress', id: 1, step: expected, detail: expected },
    ]);
  });

  // Plan step 11I (PR A): changed test (before: 'masks the secret per streamed call, so the end of one call does not give
  // out a part of the secret of another (review round 2, B1)', two streamed Docker calls of one operation, each with
  // redactors of its own, which are gone with OperationContext.docker): the same rule for the output that remains, each
  // operation with redactors of its own, so the end of one operation does not give out a part of the secret that another
  // one holds back.
  it('masks the secret per operation, so the end of one does not give out a part of the secret of another (review round 2, B1)', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz';
    const { send, held, of } = setup();
    send({ t: 'op', id: 1, op: 'hold', params: 'a', secrets: { token: secret } });
    send({ t: 'op', id: 2, op: 'hold', params: 'b', secrets: { token: secret } });
    const [a, b] = held.runs;
    a.output('stdout', `token ${secret.slice(0, 10)}`);
    b.end();
    await vi.advanceTimersByTimeAsync(0);
    a.output('stdout', `${secret.slice(10)} end\n`);
    a.end();
    await vi.advanceTimersByTimeAsync(0);
    const out = of(1)
      .filter((message) => message.t === 'out')
      .map((message) => (message as { data: string }).data)
      .join('');
    expect(out).toBe('token *** end\n');
    expect(of(2).filter((message) => message.t === 'out')).toEqual([]);
  });

  // Plan step 11I (PR A): deleted with OperationContext.docker, whose masking and limits they checked (the error output that
  // a Docker call of the server kept for its operation): 'masks the kept error output before it is cut, so a cut cannot
  // leave a part of the secret (review round 2, B2)', 'keeps at most MAX_CONTEXT_STDOUT_CHARACTERS of standard output and
  // ends a call beyond (review round 1, S5)' and 'keeps only the end of the error output of a call (review round 1, S5)'.
  // The masking of the output, the log and the failures of an operation stays covered above and in asks.test.ts; the rules
  // of S2 (masked before the cut) and B1 (redactors per source) are the two tests above.

  it('reports the progress and the log lines of an operation and its failure', async () => {
    const operations: Record<string, OperationHandler> = {
      steps: async (_params, context) => {
        context.progress('Cloning', 'acme/api');
        context.log('a step with the secret s3cr3t-value', 'warn');
        throw new Error('it failed');
      },
    };
    const { send, of } = setup({ operations });
    send({ t: 'op', id: 1, op: 'steps', params: null, secrets: { token: 's3cr3t-value' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(of(1)).toEqual([
      { t: 'progress', id: 1, step: 'Cloning', detail: 'acme/api' },
      { t: 'log', id: 1, level: 'warn', text: 'a step with the secret ***' },
      { t: 'result', id: 1, ok: false, error: { code: 'failed', message: 'it failed' }, cancelled: false, timedOut: false },
    ]);
  });

  // Plan step 11I (PR A): 'ends the Docker calls that an operation left running when it ended' is deleted with the Docker
  // calls of the server (their end after the handler, endChildren). What an operation leaves behind when it ends is still
  // ended: its open requests (asks.test.ts, B-R1-7) and its pausable output (server.11G3R1.test.ts).

  describe('ends by itself when the connection is lost (user request 2026-09-28)', () => {
    // Plan step 11I1, PR B1: changed expectation: no removal of the containers of a cleanup label before the exit. Plan
    // step 11I (PR A): changed expectation: the signal of the operation `hold` aborts, its handler ends as a request to the
    // engine does, and the script exits after its result (before: SIGTERM, then SIGKILL after the grace time, to a Docker
    // call of the operation `call`).
    it('at the end of its input: cancels what runs, then exits', async () => {
      const { server, send, held, exits, resultOf } = setup({ hold: holdOperation({ endsOnAbort: true }) });
      send({ t: 'op', id: 1, op: 'hold', params: null });
      server.inputEnded();
      expect(server.active).toBe(false);
      expect(held.runs[0].aborted).toBe(true);
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(resultOf(1)).toMatchObject({ ok: false, error: { code: 'cancelled' }, cancelled: true });
      expect(held.runs).toHaveLength(1);
      expect(exits).toEqual([0]);
    });

    it('after CHANNEL_SILENCE_EXIT_MS without a message; each message starts the time again', async () => {
      const { send, exits } = setup();
      await vi.advanceTimersByTimeAsync(CHANNEL_SILENCE_EXIT_MS - 1_000);
      send({ t: 'ping', n: 1 });
      await vi.advanceTimersByTimeAsync(CHANNEL_SILENCE_EXIT_MS - 1_000);
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(exits).toEqual([0]);
    });

    // Review round 5 (F3): a long request on a slow link: its pieces arrive, the pings wait behind it.
    it('not while the pieces of a long request arrive; after CHANNEL_SILENCE_EXIT_MS without any', async () => {
      const { server, send, exits, resultOf } = setup();
      const line = encodeMessage({ t: 'op', id: 1, op: 'probe', params: { pad: 'x'.repeat(4_000) } });
      for (let start = 0; start < line.length - 1; start += 100) {
        server.input(line.slice(start, Math.min(start + 100, line.length - 1)));
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(exits).toEqual([]);
      server.input('\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(resultOf(1)).toBeDefined();
      send({ t: 'ping', n: 1 });
      server.input('{"t":"pi');
      await vi.advanceTimersByTimeAsync(CHANNEL_SILENCE_EXIT_MS);
      expect(exits).toEqual([0]);
    });

    // Plan step 11I (PR A): changed test: the running operation is `hold` (before: `call`, with its Docker call).
    it('after CHANNEL_SERVER_IDLE_EXIT_MS without an operation, even while pings come; not while one runs', async () => {
      const { send, held, exits } = setup();
      send({ t: 'op', id: 1, op: 'hold', params: null });
      for (let elapsed = 0; elapsed < CHANNEL_SERVER_IDLE_EXIT_MS + 60_000; elapsed += 15_000) {
        send({ t: 'ping', n: elapsed });
        await vi.advanceTimersByTimeAsync(15_000);
      }
      expect(exits).toEqual([]);
      held.runs[0].end();
      for (let elapsed = 0; elapsed < CHANNEL_SERVER_IDLE_EXIT_MS; elapsed += 15_000) {
        send({ t: 'ping', n: elapsed });
        await vi.advanceTimersByTimeAsync(15_000);
      }
      expect(exits).toEqual([0]);
    });

    it('when its answers cannot be written anymore', async () => {
      let writable = true;
      const { send, exits } = setup({ writable: () => writable });
      writable = false;
      send({ t: 'ping', n: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(exits).toEqual([0]);
    });

    it('on a line that is too long', async () => {
      const { server, exits } = setup();
      server.input('x'.repeat(MAX_CLIENT_LINE + 1));
      await vi.advanceTimersByTimeAsync(0);
      expect(exits).toEqual([0]);
    });

    // Plan step 11I (PR A): changed test: an operation whose handler never ends (before: a Docker call that ignored every
    // signal); the deadline is SHUTDOWN_DEADLINE_MS, the same time as before (the kill grace, the cleanup, and 5 s).
    it('at a hard deadline even when an operation does not end', async () => {
      const { server, send, held, exits } = setup();
      send({ t: 'op', id: 1, op: 'hold', params: null });
      server.shutdown();
      expect(held.runs[0].aborted).toBe(true);
      expect(SHUTDOWN_DEADLINE_MS).toBe(CHANNEL_KILL_GRACE_MS + CHANNEL_CLEANUP_TIMEOUT_MS + 5_000);
      await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(exits).toEqual([0]);
    });
  });
});

describe('the helpers of the server', () => {
  it('redact masks a secret of at least 4 characters', () => {
    expect(redact('a abcd b abcd', 'abcd')).toBe('a *** b ***');
    expect(redact('a abc', 'abc')).toBe('a abc');
    expect(redact('text', undefined)).toBe('text');
  });

  it('StreamRedactor holds back only a tail that can start the secret', () => {
    const out: string[] = [];
    const redactor = new StreamRedactor('secret', (text) => out.push(text));
    redactor.push('hello se');
    redactor.push('cret and s');
    redactor.push('omething');
    redactor.flush();
    expect(out.join('')).toBe('hello *** and something');
    expect(out[0]).toBe('hello ');
  });

  // Plan step 11I (PR A): 'commandLine quotes arguments with spaces or quotes' and 'commandLine shows a script of more
  // than one line or more than MAX_LOGGED_SCRIPT_LENGTH characters as <script>' are deleted with commandLine (the log line
  // of a Docker call of the server, which is gone).
});

// Plan step 11I (PR A): changed setup: the refresh of the port with an engine that counts whether it was asked (before:
// over the fake Docker CLI of these tests, which is gone with OperationContext.docker; the refresh runs over the port
// since plan step 11C1).
describe('the refresh operation through the server (plan step 5, PR C)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function refresh(params: unknown, secret?: string) {
    let asked = 0;
    const ctx = setup({ operations: { refresh: refreshOperation(() => (asked++, unusedEngine())) } });
    ctx.send(secret === undefined ? { t: 'op', id: 1, op: 'refresh', params } : { t: 'op', id: 1, op: 'refresh', params, secrets: { token: secret } });
    for (let round = 0; round < 200 && ctx.resultOf(1) === undefined; round++) await vi.advanceTimersByTimeAsync(0);
    return { result: ctx.resultOf(1), asked, messages: ctx.messages };
  }

  // Plan step 11I (PR A): 'ends one call when its own signal aborts (the time limit of a call of the refresh)' is deleted
  // with the signal of a Docker call of the server (ContextDockerOptions.signal); the requests of the refresh to the port
  // have the time limits of EngineDocker (engineDocker.test.ts).

  // Plan step 11I (PR A): changed expectation: the engine of the port is never asked (before: no Docker call started).
  it('refuses invalid parameters and a secret, and asks no engine', async () => {
    const env = REFRESH_ENVIRONMENTS[0];
    for (const params of [
      null,
      {},
      { environments: [{ ...env, extra: 1 }] },
      { environments: [env, env] },
      { environments: [{ ...env, containerName: '-e' }] },
    ]) {
      const { result, asked } = await refresh(params);
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
      expect(asked).toBe(0);
    }
    const { result, asked, messages } = await refresh({ environments: [env] }, 'ghp_secret_value');
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(asked).toBe(0);
    expect(JSON.stringify(messages)).not.toContain('ghp_secret_value');
  });
});
