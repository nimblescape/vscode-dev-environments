// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the client of the batch helper (HelperChannel.batch and its session) against a fake worker: the
// batch holds no place of the operations and has its own cap; a step masks the secret in its output itself (also when a
// piece splits it), sends a long input in pieces, maps the time limit of the step to `timedOut`, and refuses an unknown
// kind before sending; HeldEnvironmentLock.batch goes through the worker that holds the lock.
import { describe, expect, it } from 'vitest';
import { MAX_CAPTURED_STDERR_CHARACTERS } from '../helper/analysisLimits';
import type { StartedProcess } from '../ports';
import { OutputTooLargeError } from '../process';
import { BATCH_READY_STEP, MAX_CONCURRENT_BATCHES, OP_BATCH, OP_BATCH_CHUNK, OP_BATCH_STEP } from './batch';
import { HelperChannel, HelperChannelError, OutputTail, type HelperChannelOptions } from './helperChannel';
import {
  CHANNEL_PROTOCOL_VERSION,
  LOCK_HELD_STEP,
  MAX_CHANNEL_REQUEST_BYTES,
  MAX_CONCURRENT_OPERATIONS,
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol';

const TOKEN = 'ghp_client_side_token_value';
const BATCH = { volume: 'devenv-v', image: `sha256:${'c'.repeat(64)}`, socket: '/var/run/docker.sock' };

function fakeWorker() {
  let stdout: ((text: string) => void) | undefined;
  const lines: string[] = [];
  // Review round 1 of PR #80 (B-R1-5): a write that fails (the channel is lost).
  const state = { failWrites: false };
  const process: StartedProcess = {
    write: (text) => {
      if (state.failWrites) return false;
      lines.push(...text.split('\n').filter((line) => line !== ''));
      return true;
    },
    end: () => {},
    kill: () => {},
    onStdout: (listener) => (stdout = listener),
    onStderr: () => {},
    exited: new Promise(() => {}),
  };
  const ops = () => lines.slice(1).map((line) => parseClientMessage(line)!).filter((message): message is Extract<ClientMessage, { t: 'op' }> => message?.t === 'op');
  return { process, lines, ops, state, answer: (message: ServerMessage) => stdout?.(encodeMessage(message)) };
}

async function opened(options: Partial<HelperChannelOptions> = {}) {
  const worker = fakeWorker();
  const logs: string[] = [];
  const opening = HelperChannel.open(worker.process, 'SCRIPT', {
    logger: { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l), output: (l) => logs.push(l) },
    name: 'host',
    ...options,
  });
  await Promise.resolve();
  worker.answer({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['batch', 'batchChunk', 'batchStep', 'docker', 'lock'] });
  const channel = await opening;
  return { channel, worker, logs };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function session(options: Partial<HelperChannelOptions> = {}) {
  const t = await opened(options);
  const starting = t.channel.batch(BATCH);
  await tick();
  const op = t.worker.ops().at(-1)!;
  expect(op).toMatchObject({ op: OP_BATCH, params: BATCH });
  t.worker.answer({ t: 'progress', id: op.id, step: BATCH_READY_STEP, detail: (op.params as { session: string }).session });
  return { ...t, batchOp: op, session: await starting };
}

describe('HelperChannel.batch (plan step 6, PR B)', () => {
  it('holds a batch without a place of the operations, up to its own cap, without a secret', async () => {
    const { channel, worker, batchOp, session: first } = await session();
    expect(batchOp.secret).toBeUndefined();
    expect(first.session).toMatch(/^[0-9a-f]{24}$/);
    // The places of the operations stay free.
    for (let i = 0; i < MAX_CONCURRENT_OPERATIONS; i++) channel.operation('docker', { args: ['ps'] }).catch(() => {});
    const more = [];
    for (let i = 1; i < MAX_CONCURRENT_BATCHES; i++) more.push(channel.batch(BATCH).catch(() => undefined));
    await tick();
    await expect(channel.batch(BATCH)).rejects.toMatchObject({ name: 'HelperChannelError', code: 'unsendable' });
    expect(worker.ops().filter((op) => op.op === OP_BATCH)).toHaveLength(MAX_CONCURRENT_BATCHES);
    // Close: the worker confirms the cancel.
    const closing = first.close();
    await tick();
    expect(worker.lines.map((line) => parseClientMessage(line))).toContainEqual({ t: 'cancel', id: batchOp.id });
    worker.answer({ t: 'result', id: batchOp.id, ok: false, error: { code: 'cancelled', message: 'x' }, cancelled: true, timedOut: false });
    await closing;
    channel.close();
  });

  it('masks the secret in the output of a step itself, also across pieces, and sends it only as the secret', async () => {
    const { channel, worker, session: s } = await session();
    const seen: string[] = [];
    const running = s.step('up', { repository: 'o/r' }, { secret: TOKEN, onOutput: (_stream, text) => seen.push(text) });
    await tick();
    const op = worker.ops().at(-1)!;
    expect(op).toMatchObject({ op: OP_BATCH_STEP, secret: TOKEN, params: { session: s.session, kind: 'up', params: { repository: 'o/r' } } });
    worker.answer({ t: 'out', id: op.id, stream: 'stdout', data: `a ${TOKEN.slice(0, 7)}` });
    worker.answer({ t: 'out', id: op.id, stream: 'stdout', data: `${TOKEN.slice(7)} b` });
    worker.answer({ t: 'out', id: op.id, stream: 'stderr', data: TOKEN });
    worker.answer({ t: 'result', id: op.id, ok: true, value: { exitCode: 0 } });
    expect(await running).toEqual({ exitCode: 0, stdout: 'a *** b', stderr: '***', timedOut: false });
    expect(seen.join('')).not.toContain(TOKEN);
    channel.close();
  });

  it('maps the time limit of a step to timedOut, and sends the time limit to the helper', async () => {
    const { channel, worker, session: s } = await session();
    const running = s.step('listConfigs', { repository: 'o/r' }, { timeoutMs: 1_000 });
    await tick();
    const op = worker.ops().at(-1)!;
    expect(op.params).toMatchObject({ timeoutMs: 1_000 });
    expect(op.timeoutMs).toBeGreaterThan(1_000);
    worker.answer({ t: 'result', id: op.id, ok: false, error: { code: 'timeout', message: 'x' }, cancelled: false, timedOut: false });
    expect(await running).toMatchObject({ exitCode: null, timedOut: true });
    channel.close();
  });

  it('sends a long input in pieces first and refuses an unknown kind before sending', async () => {
    const { channel, worker, session: s } = await session();
    const text = 'ä'.repeat(200_000);
    const running = s.step('up', { repository: 'o/r', text });
    for (let i = 0; i < 20; i++) {
      await tick();
      const op = worker.ops().at(-1)!;
      if (op.op === OP_BATCH_STEP) break;
      worker.answer({ t: 'result', id: op.id, ok: true, value: {} });
    }
    const chunks = worker.ops().filter((op) => op.op === OP_BATCH_CHUNK);
    const step = worker.ops().at(-1)!;
    expect(chunks.length).toBeGreaterThan(1);
    const input = (chunks[0].params as { input: string }).input;
    expect(chunks.every((op) => (op.params as { input: string; session: string }).input === input && (op.params as { session: string }).session === s.session)).toBe(true);
    expect(JSON.parse(chunks.map((op) => (op.params as { data: string }).data).join(''))).toEqual({ repository: 'o/r', text });
    expect(step.params).toEqual({ session: s.session, kind: 'up', input });
    for (const line of worker.lines.slice(1)) expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(256 * 1024);
    worker.answer({ t: 'result', id: step.id, ok: true, value: { exitCode: 0 } });
    expect((await running).exitCode).toBe(0);
    const sent = worker.ops().length;
    await expect(s.step('docker' as never, { args: ['ps'] })).rejects.toBeInstanceOf(HelperChannelError);
    expect(worker.ops()).toHaveLength(sent);
    channel.close();
  });

  it('HeldEnvironmentLock.batch takes the batch through the worker that holds the lock', async () => {
    const { channel, worker } = await opened();
    const locking = channel.lock('env-1', 5);
    await tick();
    worker.answer({ t: 'progress', id: worker.ops().at(-1)!.id, step: LOCK_HELD_STEP });
    const lock = await locking;
    const starting = lock.batch!(BATCH);
    await tick();
    const op = worker.ops().at(-1)!;
    expect(op.op).toBe(OP_BATCH);
    worker.answer({ t: 'progress', id: op.id, step: BATCH_READY_STEP });
    expect((await starting).session).toBe((op.params as { session: string }).session);
    channel.close();
  });
  it('review round 3 of PR #80, B-R3-3: HeldEnvironmentLock.batch passes the signal of its caller, and a cancel while it starts reaches the worker', async () => {
    const { channel, worker } = await opened();
    const locking = channel.lock('env-1', 5);
    await tick();
    worker.answer({ t: 'progress', id: worker.ops().at(-1)!.id, step: LOCK_HELD_STEP });
    const lock = await locking;
    const controller = new AbortController();
    const starting = lock.batch!(BATCH, controller.signal).catch((error: unknown) => error);
    await tick();
    const op = worker.ops().at(-1)!;
    expect(op.op).toBe(OP_BATCH);
    // Before the worker reports the batch ready.
    controller.abort();
    await tick();
    // A batch that ignored the signal would send no cancel.
    expect(worker.lines.map((line) => parseClientMessage(line))).toContainEqual({ t: 'cancel', id: op.id });
    worker.answer({ t: 'result', id: op.id, ok: false, error: { code: 'cancelled', message: 'x' }, cancelled: true, timedOut: false });
    expect(await starting).toMatchObject({ name: 'AbortError' });
    channel.close();
  });

  for (const what of ['batch', 'lock'] as const) {
    it(`review round 3 of PR #80, B-R3-4: ${what} with a signal that is already aborted rejects as AbortError and sends nothing`, async () => {
      const { channel, worker } = await opened();
      const outcome = (what === 'batch' ? channel.batch(BATCH, AbortSignal.abort()) : channel.lock('env-1', 5, AbortSignal.abort())).catch((error: unknown) => error);
      await tick();
      expect(worker.ops()).toEqual([]);
      expect(await outcome).toMatchObject({ name: 'AbortError' });
      channel.close();
    });
  }
});

/** Review round 1 of PR #80: starts a batch on an open channel (the fake worker reports it ready). */
async function startBatch(t: Awaited<ReturnType<typeof opened>>) {
  const starting = t.channel.batch(BATCH);
  await tick();
  const op = t.worker.ops().at(-1)!;
  expect(op.op).toBe(OP_BATCH);
  t.worker.answer({ t: 'progress', id: op.id, step: BATCH_READY_STEP, detail: (op.params as { session: string }).session });
  return { op, session: await starting };
}

/** Review round 1 of PR #80: closes a batch (the fake worker confirms the cancel). */
async function closeBatch(t: Awaited<ReturnType<typeof opened>>, started: Awaited<ReturnType<typeof startBatch>>) {
  const closing = started.session.close();
  await tick();
  expect(t.worker.lines.map((line) => parseClientMessage(line))).toContainEqual({ t: 'cancel', id: started.op.id });
  t.worker.answer({ t: 'result', id: started.op.id, ok: false, error: { code: 'cancelled', message: 'x' }, cancelled: true, timedOut: false });
  await closing;
}

/** Review round 1 of PR #80: answers the input pieces of a step until the step itself is sent; returns it. */
async function answerPieces(worker: ReturnType<typeof fakeWorker>, from: number) {
  const answered = new Set<number>();
  let step: Extract<ClientMessage, { t: 'op' }> | undefined;
  for (let i = 0; i < 60 && step === undefined; i++) {
    await tick();
    for (const op of worker.ops().slice(from)) {
      if (answered.has(op.id)) continue;
      answered.add(op.id);
      if (op.op === OP_BATCH_STEP) step = op;
      else {
        expect(op.op).toBe(OP_BATCH_CHUNK);
        worker.answer({ t: 'result', id: op.id, ok: true, value: {} });
      }
    }
  }
  return { step, chunks: worker.ops().slice(from).filter((op) => op.op === OP_BATCH_CHUNK) };
}

describe('the places and the limits of a batch on the client (review round 1 of PR #80)', () => {
  it('review round 1 of PR #80, B-R1-5: batches that ended free their places, never a place of the operations (HC3)', async () => {
    const t = await opened();
    // One after the other, more than the cap: each that ended gave its place back.
    for (let i = 0; i < MAX_CONCURRENT_BATCHES + 1; i++) await closeBatch(t, await startBatch(t));
    // One that the worker refuses before it is ready.
    const refused = t.channel.batch(BATCH);
    await tick();
    const op = t.worker.ops().at(-1)!;
    expect(op.op).toBe(OP_BATCH);
    t.worker.answer({ t: 'result', id: op.id, ok: false, error: { code: 'failed', message: 'no helper' }, cancelled: false, timedOut: false });
    await expect(refused).rejects.toMatchObject({ code: 'failed' });
    // The whole cap is still there, and not more.
    for (let i = 0; i < MAX_CONCURRENT_BATCHES; i++) await startBatch(t);
    await expect(t.channel.batch(BATCH)).rejects.toMatchObject({ name: 'HelperChannelError', code: 'unsendable' });
    // The operations still have exactly MAX_CONCURRENT_OPERATIONS places: one more waits.
    const before = t.worker.ops().length;
    for (let i = 0; i < MAX_CONCURRENT_OPERATIONS + 1; i++) t.channel.operation('docker', { args: ['ps'] }).catch(() => {});
    await tick();
    expect(t.worker.ops().length - before).toBe(MAX_CONCURRENT_OPERATIONS);
    t.channel.close();
  });

  it('review round 1 of PR #80, B-R1-5: a batch whose request cannot be written gives its own place back (HC4)', async () => {
    const t = await opened();
    t.worker.state.failWrites = true;
    await expect(t.channel.batch(BATCH)).rejects.toMatchObject({ name: 'HelperChannelError', code: 'closed' });
    // The failed write lost the channel, so nothing can be sent on it any more: the places are read directly.
    const places = t.channel as unknown as { batches: number; slots: number };
    expect(places.batches).toBe(0);
    expect(places.slots).toBe(0);
  });

  it('review round 1 of PR #80, B-R1-6: a step and the pieces of its input are sent while every place of the operations is taken (HC14, HC15)', async () => {
    const { channel, worker, session: s } = await session();
    for (let i = 0; i < MAX_CONCURRENT_OPERATIONS; i++) channel.operation('docker', { args: ['ps'] }).catch(() => {});
    await tick();
    expect(worker.ops().filter((op) => op.op === 'docker')).toHaveLength(MAX_CONCURRENT_OPERATIONS);
    const plain = s.step('listConfigs', { repository: 'o/r' });
    await tick();
    const op = worker.ops().at(-1)!;
    expect(op.op).toBe(OP_BATCH_STEP);
    worker.answer({ t: 'result', id: op.id, ok: true, value: { exitCode: 0 } });
    expect((await plain).exitCode).toBe(0);
    const before = worker.ops().length;
    const chunked = s.step('up', { repository: 'o/r', text: 'ä'.repeat(200_000) });
    const { step, chunks } = await answerPieces(worker, before);
    expect(chunks.length).toBeGreaterThan(1);
    expect(step).toBeDefined();
    worker.answer({ t: 'result', id: step!.id, ok: true, value: { exitCode: 0 } });
    expect((await chunked).exitCode).toBe(0);
    channel.close();
  });

  it('review round 1 of PR #80, B-R1-7: stdout beyond the cap cancels the step and rejects with OutputTooLargeError (HC13, HC22)', async () => {
    const { channel, worker, session: s } = await session({ maxCapturedOutputBytes: 1_000 });
    const running = s.step('listConfigs', { repository: 'o/r' });
    await tick();
    const op = worker.ops().at(-1)!;
    worker.answer({ t: 'out', id: op.id, stream: 'stdout', data: 'x'.repeat(600) });
    worker.answer({ t: 'out', id: op.id, stream: 'stdout', data: 'x'.repeat(600) });
    await tick();
    expect(worker.lines.map((line) => parseClientMessage(line))).toContainEqual({ t: 'cancel', id: op.id });
    worker.answer({ t: 'result', id: op.id, ok: false, error: { code: 'cancelled', message: 'x' }, cancelled: true, timedOut: false });
    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutputTooLargeError);
    channel.close();
  });

  it('review round 2 of PR #80, B-R2-1: with a caller signal, stdout beyond the cap still cancels the step and the step rejects with OutputTooLargeError (O9)', async () => {
    const { channel, worker, session: s } = await session({ maxCapturedOutputBytes: 1_000 });
    const caller = new AbortController();
    const running = s.step('listConfigs', { repository: 'o/r' }, { signal: caller.signal });
    await tick();
    const op = worker.ops().at(-1)!;
    worker.answer({ t: 'out', id: op.id, stream: 'stdout', data: 'x'.repeat(600) });
    worker.answer({ t: 'out', id: op.id, stream: 'stdout', data: 'x'.repeat(600) });
    await tick();
    // The cap aborts the operation also when the caller passed its own signal (AbortSignal.any).
    expect(worker.lines.map((line) => parseClientMessage(line))).toContainEqual({ t: 'cancel', id: op.id });
    expect(caller.signal.aborted).toBe(false);
    // A result after the cancel still rejects (review round 3 of PR #80, A-R3-1: the cancel decides here; the success
    // path's own check is held by the test of an overflow found only at the flush).
    worker.answer({ t: 'result', id: op.id, ok: true, value: { exitCode: 0 } });
    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutputTooLargeError);
    channel.close();
  });

  it('review round 2 of PR #80, B-R2-1: an overflow that only the flush after a success finds (a held-back tail that could start the secret) rejects with OutputTooLargeError', async () => {
    const { channel, worker, session: s } = await session({ maxCapturedOutputBytes: 1_000 });
    const running = s.step('listConfigs', { repository: 'o/r' }, { secret: TOKEN });
    await tick();
    const op = worker.ops().at(-1)!;
    // 999 characters pass; the masker holds back 'ghp_cl' (it could start the token), so no cancel goes out yet.
    worker.answer({ t: 'out', id: op.id, stream: 'stdout', data: 'x'.repeat(999) + TOKEN.slice(0, 6) });
    await tick();
    expect(worker.lines.map((line) => parseClientMessage(line))).not.toContainEqual({ t: 'cancel', id: op.id });
    worker.answer({ t: 'result', id: op.id, ok: true, value: { exitCode: 0 } });
    // Before: { exitCode: 0, stdout: '' } (the output was lost without a word).
    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutputTooLargeError);
    channel.close();
  });

  it('review round 1 of PR #80, B-R1-7: the stderr of a step keeps its end, at most MAX_CAPTURED_STDERR_CHARACTERS (HC21b)', async () => {
    const { channel, worker, session: s } = await session();
    const running = s.step('listConfigs', { repository: 'o/r' });
    await tick();
    const op = worker.ops().at(-1)!;
    const piece = 64 * 1024;
    for (let sent = 0; sent < 3 * MAX_CAPTURED_STDERR_CHARACTERS; sent += piece) worker.answer({ t: 'out', id: op.id, stream: 'stderr', data: 'e'.repeat(piece) });
    worker.answer({ t: 'out', id: op.id, stream: 'stderr', data: 'the end' });
    worker.answer({ t: 'result', id: op.id, ok: true, value: { exitCode: 0 } });
    const result = await running;
    expect(result.stderr).toHaveLength(MAX_CAPTURED_STDERR_CHARACTERS);
    expect(result.stderr.endsWith('ethe end')).toBe(true);
    channel.close();
  });

  it('review round 1 of PR #80, B-R1-7: OutputTail holds at most twice its cap while it grows, and gives its end (HC21)', () => {
    const tail = new OutputTail(10);
    let most = 0;
    for (let i = 0; i < 100; i++) {
      tail.push(String(i % 10));
      most = Math.max(most, tail.held);
    }
    tail.push('x'.repeat(25));
    most = Math.max(most, tail.held);
    expect(most).toBeLessThanOrEqual(20);
    tail.push('0123456789abc');
    expect(tail.text).toBe('3456789abc');
    expect(tail.held).toBe(10);
  });

  it('review round 1 of PR #80, B-R1-8: the end of the stdout of a masked step that could start the secret is kept (HC23)', async () => {
    const { channel, worker, session: s } = await session();
    const running = s.step('up', { repository: 'o/r' }, { secret: TOKEN });
    await tick();
    const op = worker.ops().at(-1)!;
    // TOKEN starts with `g`: the redactor holds the last `g` back until the end.
    worker.answer({ t: 'out', id: op.id, stream: 'stdout', data: 'building' });
    worker.answer({ t: 'result', id: op.id, ok: true, value: { exitCode: 0 } });
    expect(await running).toEqual({ exitCode: 0, stdout: 'building', stderr: '', timedOut: false });
    channel.close();
  });

  it('review round 1 of PR #80, B-R1-16: a step with a long secret and parameters just below the request limit goes in pieces (HC8)', async () => {
    const { channel, worker, session: s } = await session();
    const secret = 'x'.repeat(200);
    const base = JSON.stringify({ repository: 'o/r', text: '' }).length;
    const params = { repository: 'o/r', text: 'a'.repeat(MAX_CHANNEL_REQUEST_BYTES - 100 - base) };
    expect(Buffer.byteLength(JSON.stringify(params), 'utf8')).toBe(MAX_CHANNEL_REQUEST_BYTES - 100);
    const before = worker.ops().length;
    const running = s.step('up', params, { secret });
    const { step, chunks } = await answerPieces(worker, before);
    expect(chunks.length).toBeGreaterThan(1);
    expect(step).toMatchObject({ secret, params: { session: s.session, kind: 'up', input: (chunks[0].params as { input: string }).input } });
    worker.answer({ t: 'result', id: step!.id, ok: true, value: { exitCode: 0 } });
    expect((await running).exitCode).toBe(0);
    channel.close();
  });
});
