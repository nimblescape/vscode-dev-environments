// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the client of the batch helper (HelperChannel.batch and its session) against a fake worker: the
// batch holds no place of the operations and has its own cap; a step masks the secret in its output itself (also when a
// piece splits it), sends a long input in pieces, maps the time limit of the step to `timedOut`, and refuses an unknown
// kind before sending; HeldEnvironmentLock.batch goes through the worker that holds the lock.
import { describe, expect, it } from 'vitest';
import type { StartedProcess } from '../ports';
import { BATCH_READY_STEP, MAX_CONCURRENT_BATCHES, OP_BATCH, OP_BATCH_CHUNK, OP_BATCH_STEP } from './batch';
import { HelperChannel, HelperChannelError } from './helperChannel';
import { CHANNEL_PROTOCOL_VERSION, LOCK_HELD_STEP, MAX_CONCURRENT_OPERATIONS, encodeMessage, parseClientMessage, type ClientMessage, type ServerMessage } from './protocol';

const TOKEN = 'ghp_client_side_token_value';
const BATCH = { volume: 'devenv-v', image: `sha256:${'c'.repeat(64)}`, socket: '/var/run/docker.sock' };

function fakeWorker() {
  let stdout: ((text: string) => void) | undefined;
  const lines: string[] = [];
  const process: StartedProcess = {
    write: (text) => {
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
  return { process, lines, ops, answer: (message: ServerMessage) => stdout?.(encodeMessage(message)) };
}

async function opened() {
  const worker = fakeWorker();
  const logs: string[] = [];
  const opening = HelperChannel.open(worker.process, 'SCRIPT', { logger: { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l), output: (l) => logs.push(l) }, name: 'host' });
  await Promise.resolve();
  worker.answer({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['batch', 'batchChunk', 'batchStep', 'docker', 'lock'] });
  const channel = await opening;
  return { channel, worker, logs };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function session() {
  const t = await opened();
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
});
