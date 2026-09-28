// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CAPTURED_OUTPUT_BYTES } from '../helper/analysisLimits';
import { OutputTooLargeError } from '../process';
import type { Logger, StartedProcess } from '../ports';
import { CHANNEL_RESULT_GRACE_MS, HelperChannel, HelperChannelError, HelperOperationError } from './helperChannel';
import {
  CHANNEL_PROTOCOL_VERSION,
  MAX_CONCURRENT_OPERATIONS,
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol';

/** A `docker run` process of a channel: records what the extension writes; the test answers as the script. */
function fakeProcess() {
  let stdout: ((text: string) => void) | undefined;
  let stderr: ((text: string) => void) | undefined;
  let resolveExit!: (value: { exitCode: number | null; error?: Error }) => void;
  const exited = new Promise<{ exitCode: number | null; error?: Error }>((resolve) => (resolveExit = resolve));
  const lines: string[] = [];
  const state = { ended: false, killed: false, exited: false };
  const process: StartedProcess = {
    write: (text) => {
      if (state.ended || state.exited) return false;
      lines.push(...text.split('\n').filter((line) => line !== ''));
      return true;
    },
    end: () => {
      state.ended = true;
    },
    kill: () => {
      state.killed = true;
      exit(null);
    },
    onStdout: (listener) => (stdout = listener),
    onStderr: (listener) => (stderr = listener),
    exited,
  };
  const exit = (exitCode: number | null) => {
    if (state.exited) return;
    state.exited = true;
    resolveExit({ exitCode });
  };
  const messages = (): ClientMessage[] => lines.slice(1).map((line) => parseClientMessage(line)!);
  return {
    process,
    state,
    lines,
    messages,
    answer: (message: ServerMessage) => stdout?.(encodeMessage(message)),
    raw: (text: string) => stdout?.(text),
    stderr: (text: string) => stderr?.(text),
    exit,
  };
}

function recordingLogger() {
  const lines: { level: string; text: string }[] = [];
  const logger: Logger = {
    info: (text) => lines.push({ level: 'info', text }),
    warn: (text) => lines.push({ level: 'warn', text }),
    error: (text) => lines.push({ level: 'error', text }),
    output: (text) => lines.push({ level: 'output', text }),
  };
  return { logger, lines };
}

const HELLO: ServerMessage = { t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24.0.0', ops: ['docker', 'probe'] };

async function openChannel(options: { pingIntervalMs?: number; pongTimeoutMs?: number } = {}) {
  const fake = fakeProcess();
  const { logger, lines } = recordingLogger();
  const opening = HelperChannel.open(fake.process, 'SCRIPT', { logger, name: 'build-box', ...options });
  await vi.advanceTimersByTimeAsync(0);
  fake.answer(HELLO);
  const channel = await opening;
  return { channel, fake, lines };
}

/** The last operation that the extension sent. */
function lastOp(fake: ReturnType<typeof fakeProcess>) {
  const ops = fake.messages().filter((message) => message.t === 'op');
  return ops[ops.length - 1] as Extract<ClientMessage, { t: 'op' }>;
}

describe('HelperChannel (user request 2026-09-28: the helper channel)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the script as the first line, then hello; opens with the answer', async () => {
    const { channel, fake, lines } = await openChannel();
    expect(fake.lines[0]).toBe(JSON.stringify('SCRIPT'));
    expect(fake.messages()[0]).toEqual({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION });
    expect(channel.isOpen).toBe(true);
    expect(channel.operations).toEqual(['docker', 'probe']);
    expect(lines).toContainEqual({ level: 'info', text: 'Helper channel to build-box is open (Node.js v24.0.0; operations: docker, probe).' });
  });

  it('fails to open when the process ends before hello, naming its error output, and when no answer comes in time', async () => {
    const early = fakeProcess();
    const { logger } = recordingLogger();
    const opening = HelperChannel.open(early.process, 'SCRIPT', { logger, name: 'build-box' });
    early.stderr('Unable to find image devenv-helper:abc locally\n');
    early.exit(125);
    await expect(opening).rejects.toThrow(/could not be opened: the helper ended \(Unable to find image/);

    const silent = fakeProcess();
    const waiting = HelperChannel.open(silent.process, 'SCRIPT', { logger, name: 'build-box', openTimeoutMs: 1_000 });
    const check = expect(waiting).rejects.toMatchObject({ code: 'open' });
    await vi.advanceTimersByTimeAsync(1_000);
    await check;
    expect(silent.state.killed).toBe(true);
  });

  it('closes a channel whose script speaks another protocol', async () => {
    const fake = fakeProcess();
    const { logger } = recordingLogger();
    const opening = HelperChannel.open(fake.process, 'SCRIPT', { logger, name: 'build-box' });
    fake.answer({ ...HELLO, protocol: CHANNEL_PROTOCOL_VERSION + 1 } as ServerMessage);
    await expect(opening).rejects.toThrow(/speaks version 2/);
    expect(fake.state.ended).toBe(true);
  });

  it('resolves an operation with its value; logs its start, its progress, its log lines, and its end; its output goes to the log', async () => {
    const { channel, fake, lines } = await openChannel();
    const progress: string[] = [];
    const result = channel.operation('start', { repository: 'acme/api' }, { secret: 'ghp_token', onProgress: (step) => progress.push(step) });
    const op = lastOp(fake);
    expect(op).toEqual({ t: 'op', id: op.id, op: 'start', params: { repository: 'acme/api' }, secret: 'ghp_token' });
    fake.answer({ t: 'progress', id: op.id, step: 'Cloning', detail: 'acme/api' });
    fake.answer({ t: 'log', id: op.id, level: 'info', text: '$ docker run …' });
    fake.answer({ t: 'log', id: op.id, level: 'warn', text: 'exit code 1 after 0.2 s' });
    fake.answer({ t: 'out', id: op.id, stream: 'stderr', data: 'Cloning into …\n' });
    fake.answer({ t: 'result', id: op.id, ok: true, value: { branch: 'main' } });
    await expect(result).resolves.toEqual({ branch: 'main' });
    expect(progress).toEqual(['Cloning']);
    const id = op.id;
    expect(lines.slice(1)).toEqual([
      { level: 'info', text: `[build-box] start#${id}: started.` },
      { level: 'info', text: `[build-box] start#${id}: Cloning – acme/api` },
      { level: 'info', text: `[build-box] start#${id}: $ docker run …` },
      { level: 'warn', text: `[build-box] start#${id}: exit code 1 after 0.2 s` },
      { level: 'output', text: 'Cloning into …\n' },
      { level: 'info', text: `[build-box] start#${id}: done after 0.0 s.` },
    ]);
    expect(JSON.stringify(lines)).not.toContain('ghp_token');
  });

  it('rejects a failed operation with HelperOperationError and logs the failure', async () => {
    const { channel, fake, lines } = await openChannel();
    const result = channel.operation('start', {});
    const { id } = lastOp(fake);
    fake.answer({ t: 'result', id, ok: false, error: { code: 'failed', message: 'git clone failed' }, cancelled: false, timedOut: false });
    await expect(result).rejects.toEqual(new HelperOperationError('failed', 'git clone failed', false));
    expect(lines[lines.length - 1]).toEqual({ level: 'warn', text: `[build-box] start#${id}: failed: git clone failed after 0.0 s.` });
  });

  it('cancels an operation in the helper when its signal aborts, and ignores its late messages', async () => {
    const { channel, fake } = await openChannel();
    const controller = new AbortController();
    const result = channel.operation('start', {}, { signal: controller.signal, onProgress: () => expect.unreachable() });
    const { id } = lastOp(fake);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.messages()).toContainEqual({ t: 'cancel', id });
    fake.answer({ t: 'progress', id, step: 'late' });
    fake.answer({ t: 'result', id, ok: false, error: { code: 'cancelled', message: 'x' }, cancelled: true, timedOut: false });
    expect(channel.isOpen).toBe(true);
    expect(channel.busy).toBe(0);
  });

  it('gives up on a helper that does not answer after the time limit and the grace time', async () => {
    const { channel, fake } = await openChannel({ pingIntervalMs: 10 * 60_000 });
    const result = channel.operation('start', {}, { timeoutMs: 1_000 });
    const check = expect(result).rejects.toMatchObject({ code: 'timeout', timedOut: true });
    await vi.advanceTimersByTimeAsync(1_000 + CHANNEL_RESULT_GRACE_MS);
    await check;
    expect(fake.messages()).toContainEqual({ t: 'cancel', id: lastOp(fake).id });
  });

  it('distinguishes a closed channel (not sent) from one lost while the operation ran', async () => {
    const { channel, fake } = await openChannel();
    const running = channel.operation('start', {});
    fake.exit(1);
    await expect(running).rejects.toEqual(expect.objectContaining({ code: 'lost' }));
    await expect(channel.operation('start', {})).rejects.toEqual(expect.objectContaining({ code: 'closed' }));
    expect(fake.messages().filter((message) => message.t === 'op')).toHaveLength(1);
  });

  it('pings while open and takes the channel as lost without an answer: stops docker run and logs it', async () => {
    const { channel, fake, lines } = await openChannel({ pingIntervalMs: 1_000, pongTimeoutMs: 3_000 });
    const closed: string[] = [];
    channel.onClose((reason) => closed.push(reason));
    await vi.advanceTimersByTimeAsync(1_000);
    const ping = fake.messages().find((message) => message.t === 'ping') as { n: number };
    fake.answer({ t: 'pong', n: ping.n });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(channel.isOpen).toBe(true);
    const running = expect(channel.operation('start', {})).rejects.toMatchObject({ code: 'lost' });
    await vi.advanceTimersByTimeAsync(2_000);
    await running;
    expect(channel.isOpen).toBe(false);
    expect(fake.state.killed).toBe(true);
    expect(closed).toEqual(['the helper does not answer']);
    expect(lines).toContainEqual({ level: 'warn', text: 'The helper channel to build-box was lost: the helper does not answer.' });
  });

  it('takes an invalid message of the helper as a lost channel', async () => {
    const { channel, fake } = await openChannel();
    fake.raw('{"t":"result","id":1}\n');
    expect(channel.isOpen).toBe(false);
    expect(fake.state.killed).toBe(true);
  });

  it(`runs at most ${MAX_CONCURRENT_OPERATIONS} operations at the same time; the next one waits`, async () => {
    const { channel, fake } = await openChannel();
    const results = Array.from({ length: MAX_CONCURRENT_OPERATIONS + 1 }, (_, index) => channel.operation('step', { index }));
    await vi.advanceTimersByTimeAsync(0);
    const sent = () => fake.messages().filter((message) => message.t === 'op') as Extract<ClientMessage, { t: 'op' }>[];
    expect(sent()).toHaveLength(MAX_CONCURRENT_OPERATIONS);
    expect(channel.busy).toBe(MAX_CONCURRENT_OPERATIONS + 1);
    fake.answer({ t: 'result', id: sent()[0].id, ok: true, value: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toHaveLength(MAX_CONCURRENT_OPERATIONS + 1);
    expect(sent()[MAX_CONCURRENT_OPERATIONS].params).toEqual({ index: MAX_CONCURRENT_OPERATIONS });
    channel.close();
    await Promise.allSettled(results);
  });

  it('close ends the input of docker run and stops it only when it does not end by itself', async () => {
    const { channel, fake } = await openChannel();
    channel.close();
    expect(fake.state.ended).toBe(true);
    expect(fake.state.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.state.killed).toBe(true);
  });

  describe('docker', () => {
    it('returns the result of a Docker call: its output, its exit code, and passes its input', async () => {
      const { channel, fake, lines } = await openChannel();
      const stderrSeen: string[] = [];
      const result = channel.docker(['exec', '-i', 'c', 'cat'], { input: 'text', timeoutMs: 5_000, cleanup: ['x'], onStderr: (text) => stderrSeen.push(text) });
      const op = lastOp(fake);
      expect(op).toMatchObject({ op: 'docker', params: { args: ['exec', '-i', 'c', 'cat'], input: 'text', cleanup: ['x'] }, timeoutMs: 5_000 });
      fake.answer({ t: 'out', id: op.id, stream: 'stdout', data: 'te' });
      fake.answer({ t: 'out', id: op.id, stream: 'stdout', data: 'xt' });
      fake.answer({ t: 'out', id: op.id, stream: 'stderr', data: 'note' });
      fake.answer({ t: 'result', id: op.id, ok: true, value: { exitCode: 3 } });
      await expect(result).resolves.toEqual({ exitCode: 3, stdout: 'text', stderr: 'note', timedOut: false });
      expect(stderrSeen).toEqual(['note']);
      // Its output is its result, not a log; the docker operation gets no start and end lines.
      expect(lines.filter((line) => line.level === 'output')).toEqual([]);
      expect(lines.some((line) => line.text.includes('docker#') && line.text.includes('started'))).toBe(false);
    });

    it('returns timedOut after its time limit, as ProcessRunner.run does', async () => {
      const { channel, fake } = await openChannel();
      const result = channel.docker(['build', '.'], { timeoutMs: 1_000 });
      const { id } = lastOp(fake);
      fake.answer({ t: 'result', id, ok: false, error: { code: 'timeout', message: 'x' }, cancelled: false, timedOut: true });
      await expect(result).resolves.toEqual({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    });

    it('cancels a call whose output is larger than the limit and throws OutputTooLargeError', async () => {
      const { channel, fake } = await openChannel();
      const result = channel.docker(['logs', 'c']);
      const { id } = lastOp(fake);
      const piece = 'x'.repeat(1024 * 1024);
      for (let sent = 0; sent <= MAX_CAPTURED_OUTPUT_BYTES; sent += piece.length) fake.answer({ t: 'out', id, stream: 'stdout', data: piece });
      await expect(result).rejects.toBeInstanceOf(OutputTooLargeError);
      expect(fake.messages()).toContainEqual({ t: 'cancel', id });
    });

    it('refuses an invalid value of the helper', async () => {
      const { channel, fake } = await openChannel();
      const result = channel.docker(['ps']);
      fake.answer({ t: 'result', id: lastOp(fake).id, ok: true, value: { exitCode: 'zero' } });
      await expect(result).rejects.toBeInstanceOf(HelperChannelError);
    });
  });
});
