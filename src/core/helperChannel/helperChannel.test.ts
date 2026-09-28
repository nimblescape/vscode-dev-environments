// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CAPTURED_OUTPUT_BYTES } from '../helper/analysisLimits';
import { OutputTooLargeError } from '../process';
import type { Logger, StartedProcess } from '../ports';
import { CHANNEL_RESULT_GRACE_MS, HelperChannel, HelperChannelError, HelperOperationError } from './helperChannel';
import {
  CHANNEL_CLEANUP_TIMEOUT_MS,
  CHANNEL_KILL_GRACE_MS,
  CHANNEL_PROTOCOL_VERSION,
  CHANNEL_SLOT_WAIT_MS,
  MAX_CHANNEL_REQUEST_BYTES,
  MAX_CHANNEL_SCRIPT_LENGTH,
  MAX_CLIENT_LINE,
  MAX_CONCURRENT_OPERATIONS,
  MAX_DOCKER_ARGS,
  MAX_DOCKER_INPUT_LENGTH,
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

  // Review round 4 (M2): the AbortError comes when the script confirmed the cancel (it came at once before).
  it('cancels an operation in the helper when its signal aborts: AbortError once the script confirms it, its late messages ignored', async () => {
    const { channel, fake } = await openChannel();
    const controller = new AbortController();
    const result = channel.operation('start', {}, { signal: controller.signal, onProgress: () => expect.unreachable() });
    let settled = false;
    void result.catch(() => (settled = true));
    const { id } = lastOp(fake);
    controller.abort();
    expect(fake.messages()).toContainEqual({ t: 'cancel', id });
    fake.answer({ t: 'progress', id, step: 'late' });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    fake.answer({ t: 'result', id, ok: false, error: { code: 'cancelled', message: 'x' }, cancelled: true, timedOut: false });
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(channel.isOpen).toBe(true);
    expect(channel.busy).toBe(0);
  });

  it('M2 (round 4): a cancel that crossed a successful result is an AbortError on its confirmation; a lost channel before it is `lost`', async () => {
    const { channel, fake } = await openChannel();
    const first = new AbortController();
    const crossed = channel.operation('run', {}, { signal: first.signal });
    const crossedId = lastOp(fake).id;
    first.abort();
    // The script had ended it; it confirms the cancel (and removes its containers).
    fake.answer({ t: 'cancelled', id: crossedId });
    await expect(crossed).rejects.toMatchObject({ name: 'AbortError' });
    const second = new AbortController();
    const unconfirmed = channel.operation('run', {}, { signal: second.signal });
    second.abort();
    fake.exit(1);
    await expect(unconfirmed).rejects.toMatchObject({ code: 'lost' });
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
    // Review round 1 (P3), pinned in review round 2 (C4): lost at the first ping at which no answer came for exactly
    // pongTimeoutMs (the answer at 1 s, the ping at 4 s), not one ping later.
    const running = expect(channel.operation('start', {})).rejects.toMatchObject({ code: 'lost' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(channel.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.isOpen).toBe(false);
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

  // Review round 5 (F2): the wait for a place was unbounded, also for a call with a short time limit.
  it(`waits at most CHANNEL_SLOT_WAIT_MS (or its time limit) for a place; then it is not sent (unsendable)`, async () => {
    const { channel, fake } = await openChannel();
    const held = Array.from({ length: MAX_CONCURRENT_OPERATIONS }, (_, index) => channel.operation('step', { index }));
    const short = channel.operation('step', { index: 'short' }, { timeoutMs: 1_000 });
    const plain = channel.operation('step', { index: 'plain' });
    const shortResult = expect(short).rejects.toMatchObject({ code: 'unsendable' });
    const plainResult = expect(plain).rejects.toMatchObject({ code: 'unsendable' });
    await vi.advanceTimersByTimeAsync(1_000);
    await shortResult;
    await vi.advanceTimersByTimeAsync(CHANNEL_SLOT_WAIT_MS - 1_000);
    await plainResult;
    expect(fake.messages().filter((message) => message.t === 'op')).toHaveLength(MAX_CONCURRENT_OPERATIONS);
    expect(channel.busy).toBe(MAX_CONCURRENT_OPERATIONS);
    // A place that frees later goes to no one who left.
    const sent = fake.messages().filter((message) => message.t === 'op') as Extract<ClientMessage, { t: 'op' }>[];
    fake.answer({ t: 'result', id: sent[0].id, ok: true, value: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(channel.busy).toBe(MAX_CONCURRENT_OPERATIONS - 1);
    const next = channel.operation('step', { index: 'next' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.messages().filter((message) => message.t === 'op')).toHaveLength(MAX_CONCURRENT_OPERATIONS + 1);
    channel.close();
    await Promise.allSettled([...held, next]);
  });

  it('closeNow (the window closes) stops docker run and what it started at once, and rejects what runs as lost (review round 4, M3)', async () => {
    const { channel, fake } = await openChannel();
    let killedNow = 0;
    fake.process.killNow = () => {
      killedNow++;
      fake.exit(null);
    };
    const running = channel.operation('start', {});
    channel.closeNow();
    expect(killedNow).toBe(1);
    await expect(running).rejects.toMatchObject({ code: 'lost' });
    expect(channel.isOpen).toBe(false);
  });

  it('close ends the input of docker run and stops it only when it does not end by itself', async () => {
    const { channel, fake } = await openChannel();
    channel.close();
    expect(fake.state.ended).toBe(true);
    expect(fake.state.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.state.killed).toBe(true);
  });

  describe('review round 1', () => {
    it('L1: an operation that waits for a place and whose signal aborts meanwhile is never sent', async () => {
      const { channel, fake } = await openChannel();
      const controller = new AbortController();
      const calls = Array.from({ length: MAX_CONCURRENT_OPERATIONS + 1 }, () => channel.docker(['ps'], { signal: controller.signal }));
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      // Review round 4 (M2): the script confirms each cancel of the operations that were sent.
      for (const message of fake.messages().filter((item) => item.t === 'cancel')) fake.answer({ t: 'cancelled', id: (message as { id: number }).id });
      const outcomes = await Promise.allSettled(calls);
      expect(outcomes.every((outcome) => outcome.status === 'rejected' && (outcome.reason as Error).name === 'AbortError')).toBe(true);
      const sent = fake.messages().filter((message) => message.t === 'op');
      expect(sent).toHaveLength(MAX_CONCURRENT_OPERATIONS);
      expect(fake.messages().filter((message) => message.t === 'cancel')).toHaveLength(MAX_CONCURRENT_OPERATIONS);
      expect(channel.busy).toBe(0);
    });

    it('L5: a caller that comes while a place goes to a waiting operation does not get past the limit', async () => {
      const { channel, fake } = await openChannel();
      const running = Array.from({ length: MAX_CONCURRENT_OPERATIONS + 1 }, (_, index) => channel.operation('step', { index }));
      await vi.advanceTimersByTimeAsync(0);
      const sent = () => fake.messages().filter((message) => message.t === 'op') as Extract<ClientMessage, { t: 'op' }>[];
      fake.answer({ t: 'result', id: sent()[0].id, ok: true, value: 0 });
      // In the same turn as the result: a new caller.
      const late = channel.operation('step', { index: 'late' });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent()).toHaveLength(MAX_CONCURRENT_OPERATIONS + 1);
      expect(sent()[MAX_CONCURRENT_OPERATIONS].params).toEqual({ index: MAX_CONCURRENT_OPERATIONS });
      channel.close();
      await Promise.allSettled([...running, late]);
    });

    it('L3: an operation whose write fails is `closed` (not sent), and HelperChannels can take the way without it', async () => {
      const { channel, fake } = await openChannel();
      fake.state.ended = true;
      await expect(channel.docker(['ps'])).rejects.toMatchObject({ code: 'closed' });
      expect(channel.isOpen).toBe(false);
    });

    it('L4: a channel whose output ends it right after the answer to hello does not open', async () => {
      const fake = fakeProcess();
      const { logger } = recordingLogger();
      const opening = HelperChannel.open(fake.process, 'SCRIPT', { logger, name: 'build-box' });
      await vi.advanceTimersByTimeAsync(0);
      fake.raw(`${encodeMessage(HELLO)}not a message\n`);
      await expect(opening).rejects.toMatchObject({ code: 'open' });
      expect(fake.state.killed).toBe(true);
    });

    it('P2: a request longer than the script reads, or a Docker call beyond the limits, is not sent (`unsendable`)', async () => {
      const { channel, fake } = await openChannel();
      await expect(channel.operation('step', { data: 'x'.repeat(MAX_CLIENT_LINE) })).rejects.toMatchObject({ code: 'unsendable' });
      await expect(channel.docker(['exec', '-i', 'c', 'cat'], { input: 'x'.repeat(MAX_DOCKER_INPUT_LENGTH + 1) })).rejects.toMatchObject({ code: 'unsendable' });
      // Review round 5 (F3): beyond what reaches the script in time on a slow link (bytes of UTF-8, not characters).
      await expect(channel.docker(['exec', '-i', 'c', 'cat'], { input: 'x'.repeat(MAX_CHANNEL_REQUEST_BYTES) })).rejects.toMatchObject({ code: 'unsendable' });
      await expect(channel.docker(['exec', '-i', 'c', 'cat'], { input: 'ä'.repeat(MAX_CHANNEL_REQUEST_BYTES / 2) })).rejects.toMatchObject({ code: 'unsendable' });
      await expect(channel.docker(Array.from({ length: MAX_DOCKER_ARGS + 1 }, () => 'a'))).rejects.toMatchObject({ code: 'unsendable' });
      await expect(channel.docker(['run', 'img'], { cleanup: 'Not A Label' })).rejects.toMatchObject({ code: 'unsendable' });
      expect(fake.messages().filter((message) => message.t === 'op')).toHaveLength(0);
      expect(channel.isOpen).toBe(true);
      expect(channel.busy).toBe(0);
    });

    it('P6: refuses a script whose JSON line is longer than the loader reads', async () => {
      const fake = fakeProcess();
      const { logger } = recordingLogger();
      // Each line feed doubles in JSON: short enough as text, too long as its line.
      const script = '\n'.repeat(MAX_CHANNEL_SCRIPT_LENGTH / 2 + 1);
      await expect(HelperChannel.open(fake.process, script, { logger, name: 'build-box' })).rejects.toThrow(/too long/);
      expect(fake.lines).toHaveLength(0);
    });

    it('P10: the idle time counts from the end of the last operation', async () => {
      const { channel, fake } = await openChannel({ pingIntervalMs: 60 * 60_000 });
      const result = channel.operation('start', {});
      await vi.advanceTimersByTimeAsync(12 * 60_000);
      const { id } = lastOp(fake);
      fake.answer({ t: 'result', id, ok: true, value: null });
      await result;
      expect(Date.now() - channel.lastUsed).toBe(0);
    });

    it('S4: a secret input travels as the secret of the operation, never as a parameter', async () => {
      const { channel, fake } = await openChannel();
      const result = channel.docker(['exec', '-i', 'c', 'sh', '-c', 'cat > /run/secrets/token'], { secretInput: 'ghp_token_value' });
      const op = lastOp(fake);
      expect(op.secret).toBe('ghp_token_value');
      expect(op.params).toEqual({ args: ['exec', '-i', 'c', 'sh', '-c', 'cat > /run/secrets/token'], inputIsSecret: true });
      expect(JSON.stringify(op.params)).not.toContain('ghp_token_value');
      fake.answer({ t: 'result', id: op.id, ok: true, value: { exitCode: 0 } });
      await expect(result).resolves.toMatchObject({ exitCode: 0 });
      await expect(channel.docker(['exec'], { input: 'a', secretInput: 'ghp_token_value' })).rejects.toThrow(/either/);
    });

    it('S6: a secret too short to be masked is not sent', async () => {
      const { channel, fake } = await openChannel();
      await expect(channel.docker(['exec'], { secretInput: 'abc' })).rejects.toMatchObject({ code: 'unsendable' });
      await expect(channel.operation('start', {}, { secret: '' })).rejects.toMatchObject({ code: 'unsendable' });
      expect(fake.messages().filter((message) => message.t === 'op')).toHaveLength(0);
    });

    it('A5 (round 2): a time limit that the script would refuse is not sent, and a missing params travels as null', async () => {
      const { channel, fake } = await openChannel();
      for (const timeoutMs of [0, -5, 1.5, Number.NaN, 25 * 60 * 60_000]) {
        await expect(channel.docker(['ps'], { timeoutMs })).rejects.toMatchObject({ code: 'unsendable' });
      }
      expect(fake.messages().filter((message) => message.t === 'op')).toHaveLength(0);
      const probe = channel.operation('probe', undefined);
      const op = lastOp(fake);
      expect(op.params).toBeNull();
      expect(parseClientMessage(fake.lines[fake.lines.length - 1])).toMatchObject({ t: 'op', params: null });
      fake.answer({ t: 'result', id: op.id, ok: true, value: {} });
      await probe;
    });

    it('P4: waits for the result of a timed-out operation longer than the kill grace and the cleanup of the script', () => {
      expect(CHANNEL_RESULT_GRACE_MS).toBeGreaterThan(CHANNEL_KILL_GRACE_MS + CHANNEL_CLEANUP_TIMEOUT_MS);
    });
  });

  describe('docker', () => {
    it('returns the result of a Docker call: its output, its exit code, and passes its input', async () => {
      const { channel, fake, lines } = await openChannel();
      const stderrSeen: string[] = [];
      const result = channel.docker(['exec', '-i', 'c', 'cat'], { input: 'text', timeoutMs: 5_000, cleanup: '0a1b2c3d4e5f60718293a4b5', onStderr: (text) => stderrSeen.push(text) });
      const op = lastOp(fake);
      // Review round 1 (S1): the cleanup is a label value, no longer container names (round 2, B4: 24 hex digits).
      expect(op).toMatchObject({ op: 'docker', params: { args: ['exec', '-i', 'c', 'cat'], input: 'text', cleanup: '0a1b2c3d4e5f60718293a4b5' }, timeoutMs: 5_000 });
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
      // Review round 4 (M2): the script confirms the cancel with the result of the ended call.
      fake.answer({ t: 'result', id, ok: false, error: { code: 'cancelled', message: 'x' }, cancelled: true, timedOut: false });
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
