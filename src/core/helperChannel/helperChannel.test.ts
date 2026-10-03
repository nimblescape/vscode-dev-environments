// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CAPTURED_OUTPUT_BYTES } from '../helper/analysisLimits';
import { MAX_BUNDLE_LINE_LENGTH } from '../loader/pipeLoader';
import { OutputTooLargeError } from '../process';
import type { Logger, StartedProcess } from '../ports';
import { BUSY_MARK_MAX_AGE_MS } from '../busy';
import { CHANNEL_RESULT_GRACE_MS, HelperChannel, HelperChannelError, HelperOperationError } from './helperChannel';
import {
  CHANNEL_CLEANUP_TIMEOUT_MS,
  CHANNEL_KILL_GRACE_MS,
  CHANNEL_PROTOCOL_VERSION,
  CHANNEL_SLOT_WAIT_MS,
  LOCK_BUSY_CODE,
  LOCK_HELD_STEP,
  LOCK_HOLD_LIMIT_MS,
  MAX_CHANNEL_REQUEST_BYTES,
  MAX_CLIENT_LINE,
  MAX_CONCURRENT_LOCKED_OPERATIONS,
  MAX_CONCURRENT_LOCKS,
  MAX_CONCURRENT_OPERATIONS,
  MAX_DOCKER_ARGS,
  MAX_DOCKER_INPUT_LENGTH,
  MAX_LOCK_WAIT_SECONDS,
  MAX_OPERATION_TIMEOUT_MS,
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

  it('review round 1 of PR #69 (A-R1-3): a long line of stderr (the source line of an uncaught error) is not in the reason, the loader line is', async () => {
    const crashed = fakeProcess();
    const { logger, lines } = recordingLogger();
    const opening = HelperChannel.open(crashed.process, 'SCRIPT', { logger, name: 'build-box' });
    crashed.stderr(`${'y'.repeat(4_000)}\n`);
    crashed.stderr('devenv loader: x\n');
    crashed.exit(3);
    const failure = await opening.then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toBe('The helper channel to build-box could not be opened: the helper ended (devenv loader: x)');
    expect(JSON.stringify(lines)).not.toContain('yyyyyyyyyy');
  });

  it('B-R2-1: at the cap of the stderr tail its first line (the cut end of a longer one) is not in the reason, even when it is short', async () => {
    const crashed = fakeProcess();
    const { logger, lines } = recordingLogger();
    const opening = HelperChannel.open(crashed.process, 'SCRIPT', { logger, name: 'build-box' });
    const rest = `${'short line\n'.repeat(300)}devenv loader: x\n`;
    const cut = 4_000 - rest.length - 1;
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThanOrEqual(1_000);
    crashed.stderr(`${'z'.repeat(10_000)}\n${rest}`);
    crashed.exit(3);
    const failure = await opening.then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toContain('short line\ndevenv loader: x)');
    expect(failure?.message).not.toContain('z');
    expect(JSON.stringify(lines)).not.toContain('zzz');
  });

  it('review round 1 of PR #69 (B-R1-5): a script whose line is exactly MAX_BUNDLE_LINE_LENGTH is written', async () => {
    const fake = fakeProcess();
    const { logger } = recordingLogger();
    const opening = HelperChannel.open(fake.process, 'a'.repeat(MAX_BUNDLE_LINE_LENGTH - 2), { logger, name: 'build-box' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.lines[0]).toHaveLength(MAX_BUNDLE_LINE_LENGTH);
    fake.answer(HELLO);
    expect((await opening).isOpen).toBe(true);
  });

  it('closes a channel whose script speaks another protocol', async () => {
    const fake = fakeProcess();
    const { logger } = recordingLogger();
    const opening = HelperChannel.open(fake.process, 'SCRIPT', { logger, name: 'build-box' });
    fake.answer({ ...HELLO, protocol: CHANNEL_PROTOCOL_VERSION + 1 } as ServerMessage);
    // Plan step 6, PR B: changed expectation (the protocol is version 2 now, so another one is 3).
    // Plan step 11A: changed expectation (the protocol is 3 now; the test sends the next one).
    await expect(opening).rejects.toThrow(/speaks version 4, not 3/);
    expect(fake.state.ended).toBe(true);
  });

  it('resolves an operation with its value; logs its start, its progress, its log lines, and its end; its output goes to the log', async () => {
    const { channel, fake, lines } = await openChannel();
    const progress: string[] = [];
    const result = channel.operation('start', { repository: 'acme/api' }, { secrets: { token: 'ghp_token' }, onProgress: (step) => progress.push(step) });
    const op = lastOp(fake);
    // Plan step 11A: changed expectation (before: one `secret`): named secrets.
    expect(op).toEqual({ t: 'op', id: op.id, op: 'start', params: { repository: 'acme/api' }, secrets: { token: 'ghp_token' } });
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
  // Review round 6 (R6-2): the time limit counts from the call, so the wait for a place is taken from it; a call can
  // wait less (slotWaitMs).
  it('takes the wait for a place from the time limit that it sends, and waits no longer than its slotWaitMs', async () => {
    const { channel, fake } = await openChannel();
    const held = Array.from({ length: MAX_CONCURRENT_OPERATIONS }, (_, index) => channel.operation('step', { index }));
    const waiting = channel.operation('step', { index: 'waiting' }, { timeoutMs: 10_000 });
    const short = channel.operation('step', { index: 'short' }, { slotWaitMs: 500 });
    const shortResult = expect(short).rejects.toMatchObject({ code: 'unsendable' });
    await vi.advanceTimersByTimeAsync(500);
    await shortResult;
    await vi.advanceTimersByTimeAsync(1_500);
    const sent = () => fake.messages().filter((message) => message.t === 'op') as Extract<ClientMessage, { t: 'op' }>[];
    fake.answer({ t: 'result', id: sent()[0].id, ok: true, value: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()[MAX_CONCURRENT_OPERATIONS]).toMatchObject({ params: { index: 'waiting' }, timeoutMs: 8_000 });
    channel.close();
    await Promise.allSettled([...held, waiting]);
  });

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
      // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: MAX_CHANNEL_SCRIPT_LENGTH of the
      // channel; now MAX_BUNDLE_LINE_LENGTH of the pipe loader, the same 8 MiB).
      const script = '\n'.repeat(MAX_BUNDLE_LINE_LENGTH / 2 + 1);
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
      expect(op.secrets?.token).toBe('ghp_token_value');
      expect(op.params).toEqual({ args: ['exec', '-i', 'c', 'sh', '-c', 'cat > /run/secrets/token'], inputIsSecret: true });
      expect(JSON.stringify(op.params)).not.toContain('ghp_token_value');
      fake.answer({ t: 'result', id: op.id, ok: true, value: { exitCode: 0 } });
      await expect(result).resolves.toMatchObject({ exitCode: 0 });
      await expect(channel.docker(['exec'], { input: 'a', secretInput: 'ghp_token_value' })).rejects.toThrow(/either/);
    });

    it('S6: a secret too short to be masked is not sent', async () => {
      const { channel, fake } = await openChannel();
      await expect(channel.docker(['exec'], { secretInput: 'abc' })).rejects.toMatchObject({ code: 'unsendable' });
      await expect(channel.operation('start', {}, { secrets: { token: '' } })).rejects.toMatchObject({ code: 'unsendable' });
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

  // Plan step 10A (decision of 2026-10-03): the operations over the Engine API of the worker.
  describe('pull and startContainers', () => {
    async function openWithEngineOps() {
      const fake = fakeProcess();
      const { logger, lines } = recordingLogger();
      const opening = HelperChannel.open(fake.process, 'SCRIPT', { logger, name: 'build-box' });
      await vi.advanceTimersByTimeAsync(0);
      fake.answer({ ...HELLO, ops: ['docker', 'pull', 'startContainers'] } as ServerMessage);
      return { channel: await opening, fake, lines };
    }

    it('sends the pull with the user and server as parameters and the password only as the secret; passes its output on', async () => {
      const { channel, fake } = await openWithEngineOps();
      const output: string[] = [];
      const pulling = channel.pull('ghcr.io/o/i:1', { credentials: { username: 'octo', password: 'gho_secret', serveraddress: 'ghcr.io' }, onOutput: (text) => output.push(text) });
      await vi.advanceTimersByTimeAsync(0);
      const op = lastOp(fake);
      expect(op).toMatchObject({ op: 'pull', params: { reference: 'ghcr.io/o/i:1', username: 'octo', serveraddress: 'ghcr.io' }, secrets: { registry: 'gho_secret' } });
      expect(JSON.stringify(op.params)).not.toContain('gho_secret');
      fake.answer({ t: 'out', id: op.id, stream: 'stdout', data: '1: Pulling from o/i\n' });
      fake.answer({ t: 'result', id: op.id, ok: true, value: {} });
      await pulling;
      expect(output).toEqual(['1: Pulling from o/i\n']);
    });

    // Review round 1 of PR #89 (A-R1-3): an identity token travels as the secret, flagged in the parameters.
    it('sends an identity token as the secret with identityToken and the server, without a user', async () => {
      const { channel, fake } = await openWithEngineOps();
      const pulling = channel.pull('r.example/o/i:1', { credentials: { identityToken: 'refresh-token', serveraddress: 'r.example' } });
      await vi.advanceTimersByTimeAsync(0);
      const op = lastOp(fake);
      expect(op).toMatchObject({ op: 'pull', params: { reference: 'r.example/o/i:1', identityToken: true, serveraddress: 'r.example' }, secrets: { registry: 'refresh-token' } });
      expect(op.params).not.toHaveProperty('username');
      fake.answer({ t: 'result', id: op.id, ok: true, value: {} });
      await pulling;
      await expect(channel.pull('node:')).rejects.toMatchObject({ code: 'unsendable' });
    });

    it('refuses a reference without a tag, a short password, and a worker without the operation, sending nothing', async () => {
      const { channel, fake } = await openWithEngineOps();
      const before = fake.messages().length;
      await expect(channel.pull('alpine')).rejects.toMatchObject({ code: 'unsendable' });
      await expect(channel.pull('alpine:1', { credentials: { username: 'u', password: 'x', serveraddress: 's' } })).rejects.toMatchObject({ code: 'unsendable' });
      await expect(channel.startContainers(['c1'])).rejects.toMatchObject({ code: 'unsendable' });
      expect(fake.messages()).toHaveLength(before);
      const { channel: old } = await openChannel();
      await expect(old.pull('alpine:1')).rejects.toMatchObject({ code: 'unsendable' });
      await expect(old.startContainers(['a'.repeat(64)])).rejects.toMatchObject({ code: 'unsendable' });
    });

    it('sends startContainers with the IDs and its time limit; a failure rejects as HelperOperationError', async () => {
      const { channel, fake } = await openWithEngineOps();
      const starting = channel.startContainers(['a'.repeat(64)], { timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(0);
      const op = lastOp(fake);
      expect(op).toMatchObject({ op: 'startContainers', params: { ids: ['a'.repeat(64)] }, timeoutMs: 60_000 });
      expect(op.secrets?.token).toBeUndefined();
      fake.answer({ t: 'result', id: op.id, ok: false, error: { code: 'failed', message: 'port is already allocated' }, cancelled: false, timedOut: false });
      await expect(starting).rejects.toMatchObject({ name: 'HelperOperationError', message: 'port is already allocated' });
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

// Plan step 5, PR B: the lock of an environment through the worker (the operation `lock`).
describe('HelperChannel.lock (plan step 5, PR B)', () => {
  const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function openWithLock() {
    const fake = fakeProcess();
    const { logger } = recordingLogger();
    const opening = HelperChannel.open(fake.process, 'SCRIPT', { logger, name: 'build-box' });
    await vi.advanceTimersByTimeAsync(0);
    fake.answer({ ...HELLO, ops: ['docker', 'lock', 'probe'] } as ServerMessage);
    return { channel: await opening, fake };
  }

  /** Sends the lock and answers it as held. */
  async function held() {
    const opened = await openWithLock();
    const locking = opened.channel.lock(ID, 10);
    await vi.advanceTimersByTimeAsync(0);
    const op = lastOp(opened.fake);
    opened.fake.answer({ t: 'progress', id: op.id, step: LOCK_HELD_STEP });
    const lock = await locking;
    return { ...opened, op, lock };
  }

  it('sends the lock with its parameters and no secret, and resolves when the worker holds it', async () => {
    const { op, lock } = await held();
    expect(op).toMatchObject({ t: 'op', op: 'lock', params: { environmentId: ID, waitSeconds: 10 } });
    expect(op.secrets?.token).toBeUndefined();
    expect(lock.environmentId).toBe(ID);
  });

  it('rejects with the busy code of the worker, and when the worker does not know the operation', async () => {
    const { channel, fake } = await openWithLock();
    const locking = channel.lock(ID, 10);
    await vi.advanceTimersByTimeAsync(0);
    fake.answer({ t: 'result', id: lastOp(fake).id, ok: false, error: { code: LOCK_BUSY_CODE, message: 'held' }, cancelled: false, timedOut: false });
    await expect(locking).rejects.toMatchObject({ name: 'HelperOperationError', code: LOCK_BUSY_CODE });
    const { channel: old } = await openChannel();
    await expect(old.lock(ID, 10)).rejects.toMatchObject({ name: 'HelperChannelError', code: 'unsendable' });
  });

  it('refuses an invalid id or wait without sending anything', async () => {
    const { channel, fake } = await openWithLock();
    const before = fake.messages().length;
    for (const [id, wait] of [['../x', 10], [ID, 0], [ID, 61], [ID, 2.5]] as const) {
      await expect(channel.lock(id, wait)).rejects.toMatchObject({ code: 'unsendable' });
    }
    expect(fake.messages()).toHaveLength(before);
  });

  // Plan step 10A: the operations over the Engine API under the lock go through the same worker.
  it('pull and startContainers of a held lock go through its worker', async () => {
    const fake = fakeProcess();
    const { logger } = recordingLogger();
    const opening = HelperChannel.open(fake.process, 'SCRIPT', { logger, name: 'build-box' });
    await vi.advanceTimersByTimeAsync(0);
    fake.answer({ ...HELLO, ops: ['docker', 'lock', 'pull', 'startContainers'] } as ServerMessage);
    const channel = await opening;
    const locking = channel.lock(ID, 10);
    await vi.advanceTimersByTimeAsync(0);
    fake.answer({ t: 'progress', id: lastOp(fake).id, step: LOCK_HELD_STEP });
    const lock = await locking;
    const pulling = lock.pull!('alpine:1', {});
    await vi.advanceTimersByTimeAsync(0);
    const pull = lastOp(fake);
    expect(pull).toMatchObject({ op: 'pull', params: { reference: 'alpine:1' } });
    fake.answer({ t: 'result', id: pull.id, ok: true, value: {} });
    await pulling;
    const starting = lock.startContainers!(['b'.repeat(64)], {});
    await vi.advanceTimersByTimeAsync(0);
    const start = lastOp(fake);
    expect(start).toMatchObject({ op: 'startContainers', params: { ids: ['b'.repeat(64)] } });
    fake.answer({ t: 'result', id: start.id, ok: true, value: {} });
    await starting;
    // Review round 1 of PR #89 (B-R1-8): they take the places of the calls under locks, not the shared ones.
    const ops = () => fake.messages().filter((message): message is Extract<ClientMessage, { t: 'op' }> => message.t === 'op');
    const before = ops().length;
    const pulls = Array.from({ length: MAX_CONCURRENT_LOCKED_OPERATIONS }, (_, index) => lock.pull!(`img${index}:1`, {}).catch(() => undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(ops()).toHaveLength(before + MAX_CONCURRENT_LOCKED_OPERATIONS);
    await expect(lock.startContainers!(['c'.repeat(64)], {})).rejects.toMatchObject({ code: 'unsendable' });
    channel.close();
    await Promise.all(pulls);
  });

  it('release waits until the worker let go of the lock', async () => {
    const { fake, op, lock } = await held();
    let released = false;
    const releasing = lock.release().then(() => (released = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.messages().at(-1)).toEqual({ t: 'cancel', id: op.id });
    // The worker has not confirmed yet: the lock may still be held.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(released).toBe(false);
    fake.answer({ t: 'result', id: op.id, ok: false, error: { code: 'cancelled', message: 'cancelled' }, cancelled: true, timedOut: false });
    await releasing;
    expect(released).toBe(true);
  });

  // Live check of 2026-10-03: changed log line (before: `warn … lock#n: failed: cancelled after … s.` at each release).
  it('logs the release of a held lock as info `released`; a cancel by the caller before it is held stays a warning', async () => {
    const fake = fakeProcess();
    const { logger, lines } = recordingLogger();
    const opening = HelperChannel.open(fake.process, 'SCRIPT', { logger, name: 'build-box' });
    await vi.advanceTimersByTimeAsync(0);
    fake.answer({ ...HELLO, ops: ['docker', 'lock', 'probe'] } as ServerMessage);
    const channel = await opening;
    const locking = channel.lock(ID, 10);
    await vi.advanceTimersByTimeAsync(0);
    const op = lastOp(fake);
    fake.answer({ t: 'progress', id: op.id, step: LOCK_HELD_STEP });
    const lock = await locking;
    const releasing = lock.release();
    await vi.advanceTimersByTimeAsync(0);
    fake.answer({ t: 'result', id: op.id, ok: false, error: { code: 'cancelled', message: 'cancelled' }, cancelled: true, timedOut: false });
    await releasing;
    expect(lines.filter((line) => line.text.includes(`lock#${op.id}:`) && /after/.test(line.text))).toEqual([
      { level: 'info', text: `[build-box] lock#${op.id}: released after 0.0 s.` },
    ]);
    // A cancel of the caller while the lock is still awaited is no release.
    const controller = new AbortController();
    const waiting = channel.lock(ID, 10, controller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const second = lastOp(fake);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    fake.answer({ t: 'result', id: second.id, ok: false, error: { code: 'cancelled', message: 'cancelled' }, cancelled: true, timedOut: false });
    await waiting;
    expect(lines.filter((line) => line.text.includes(`lock#${second.id}:`) && /after/.test(line.text))).toEqual([
      { level: 'warn', text: `[build-box] lock#${second.id}: failed: cancelled after 0.0 s.` },
    ]);
  });

  it('lost resolves when the worker is lost while the lock is held, and not after a release', async () => {
    const first = await held();
    let reason: string | undefined;
    void first.lock.lost.then((text) => (reason = text));
    first.fake.exit(137);
    await vi.advanceTimersByTimeAsync(0);
    expect(reason).toMatch(/lost|ended/);

    const second = await held();
    let lostAfterRelease = false;
    void second.lock.lost.then(() => (lostAfterRelease = true));
    const releasing = second.lock.release();
    await vi.advanceTimersByTimeAsync(0);
    second.fake.answer({ t: 'result', id: second.op.id, ok: false, error: { code: 'cancelled', message: 'cancelled' }, cancelled: true, timedOut: false });
    await releasing;
    await vi.advanceTimersByTimeAsync(0);
    expect(lostAfterRelease).toBe(false);
  });

  it('a held lock takes none of the places of the operations', async () => {
    const { channel, fake } = await openWithLock();
    const locks = [];
    for (let index = 0; index < MAX_CONCURRENT_OPERATIONS; index++) {
      const locking = channel.lock(`env-${index}`, 10);
      await vi.advanceTimersByTimeAsync(0);
      fake.answer({ t: 'progress', id: lastOp(fake).id, step: LOCK_HELD_STEP });
      locks.push(await locking);
    }
    // All places of the operations are still free: MAX_CONCURRENT_OPERATIONS Docker calls go out at once.
    const sentBefore = fake.messages().filter((message) => message.t === 'op').length;
    for (let index = 0; index < MAX_CONCURRENT_OPERATIONS; index++) void channel.docker(['ps']).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.messages().filter((message) => message.t === 'op').length - sentBefore).toBe(MAX_CONCURRENT_OPERATIONS);
    // And with every place taken, a lock still goes out (its own cap).
    const extra = channel.lock('env-extra', 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastOp(fake)).toMatchObject({ op: 'lock', params: { environmentId: 'env-extra' } });
    fake.answer({ t: 'progress', id: lastOp(fake).id, step: LOCK_HELD_STEP });
    await extra;
    channel.close();
  });

  // PR #74 review round 1, B-R1-1: the worker reports the step `lock` before flock runs; only LOCK_HELD_STEP means held.
  it('B-R1-1: the progress `lock` (flock still waits) does not resolve the lock; only `locked` does', async () => {
    const { channel, fake } = await openWithLock();
    let settled = false;
    const locking = channel.lock(ID, 10).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    const op = lastOp(fake);
    fake.answer({ t: 'progress', id: op.id, step: 'lock', detail: ID });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    fake.answer({ t: 'progress', id: op.id, step: LOCK_HELD_STEP });
    await expect(locking).resolves.toMatchObject({ environmentId: ID });
  });

  // PR #74 review round 1, B-R1-3: the worker cancels the lock at the sent time limit, so it must cover the hold limit.
  it('B-R1-3: sends the time limit of the wait plus the hold limit plus the grace', async () => {
    const { op } = await held();
    expect(op.timeoutMs).toBe(10 * 1000 + LOCK_HOLD_LIMIT_MS + CHANNEL_RESULT_GRACE_MS);
  });

  // Plan step 6, PR A: Start, Rebuild, Select configuration and Clone again hold the lock through the build, `up`, the
  // lifecycle commands and the questions to the user, so the backstop is as long as the life of a busy mark (6 h), and
  // the time limit of the longest wait still fits into the limit of one operation.
  it('plan step 6, PR A: the backstop covers the life of a busy mark and fits into the limit of one operation', () => {
    expect(LOCK_HOLD_LIMIT_MS).toBe(6 * 60 * 60_000);
    expect(LOCK_HOLD_LIMIT_MS).toBeGreaterThanOrEqual(BUSY_MARK_MAX_AGE_MS);
    expect(MAX_LOCK_WAIT_SECONDS * 1000 + LOCK_HOLD_LIMIT_MS + CHANNEL_RESULT_GRACE_MS).toBeLessThanOrEqual(MAX_OPERATION_TIMEOUT_MS);
  });

  // PR #74 review round 1, B-R1-5: a worker that ends the lock operation without `locked` never gives a held lock.
  it('B-R1-5: a lock answered without `locked` rejects as protocol, not as a held lock', async () => {
    const { channel, fake } = await openWithLock();
    const locking = channel.lock(ID, 10);
    await vi.advanceTimersByTimeAsync(0);
    fake.answer({ t: 'result', id: lastOp(fake).id, ok: true, value: {} });
    await expect(locking).rejects.toMatchObject({ name: 'HelperChannelError', code: 'protocol' });
    expect(channel.busy).toBe(0);
  });

  // PR #74 review round 1, B-R1-4: the locks have their own bound, which a release frees again; they never touch the
  // places of the operations (nor the places of the calls under locks, A-R1-2).
  it(`B-R1-4: at most ${MAX_CONCURRENT_LOCKS} locks; a release frees a place; the other places stay exact after many cycles`, async () => {
    const { channel, fake } = await openWithLock();
    const ops = () => fake.messages().filter((message): message is Extract<ClientMessage, { t: 'op' }> => message.t === 'op');
    const take = async (environmentId: string) => {
      const locking = channel.lock(environmentId, 10);
      await vi.advanceTimersByTimeAsync(0);
      const op = lastOp(fake);
      expect(op).toMatchObject({ op: 'lock', params: { environmentId } });
      fake.answer({ t: 'progress', id: op.id, step: LOCK_HELD_STEP });
      return { lock: await locking, op };
    };
    const release = async (taken: Awaited<ReturnType<typeof take>>) => {
      const releasing = taken.lock.release();
      await vi.advanceTimersByTimeAsync(0);
      fake.answer({ t: 'result', id: taken.op.id, ok: false, error: { code: 'cancelled', message: 'cancelled' }, cancelled: true, timedOut: false });
      await releasing;
    };
    const locks = [];
    for (let index = 0; index < MAX_CONCURRENT_LOCKS; index++) locks.push(await take(`env-${index}`));
    const before = ops().length;
    await expect(channel.lock('env-extra', 10)).rejects.toMatchObject({ name: 'HelperChannelError', code: 'unsendable' });
    expect(ops()).toHaveLength(before);
    await release(locks.shift()!);
    locks.push(await take('env-next'));
    for (const taken of locks.splice(0)) await release(taken);
    // Many take, call, release cycles.
    for (let index = 0; index < 3 * MAX_CONCURRENT_LOCKS; index++) {
      const taken = await take(`env-cycle-${index}`);
      const call = taken.lock.docker(['stop', 'c1'], {});
      await vi.advanceTimersByTimeAsync(0);
      fake.answer({ t: 'result', id: lastOp(fake).id, ok: true, value: { exitCode: 0 } });
      await call;
      await release(taken);
    }
    expect(channel.busy).toBe(0);
    // Exactly MAX_CONCURRENT_OPERATIONS plain calls go out at once; the next one waits.
    const sentBefore = ops().length;
    const plain = Array.from({ length: MAX_CONCURRENT_OPERATIONS + 1 }, () => channel.docker(['ps']).catch(() => undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(ops().length - sentBefore).toBe(MAX_CONCURRENT_OPERATIONS);
    expect(channel.busy).toBe(MAX_CONCURRENT_OPERATIONS + 1);
    // And MAX_CONCURRENT_LOCKS locks still go out.
    for (let index = 0; index < MAX_CONCURRENT_LOCKS; index++) locks.push(await take(`env-again-${index}`));
    await expect(channel.lock('env-extra', 10)).rejects.toMatchObject({ code: 'unsendable' });
    channel.close();
    await Promise.all(plain);
  });

  // PR #74 review round 1, A-R1-2: the Docker calls under a held lock have their own places, so the other operations of
  // the window cannot make them `unsendable` halfway through a Stop or Delete.
  it('A-R1-2: with every place of the operations taken, a call under the lock is sent at once and does not time out', async () => {
    const { channel, fake, lock } = await held();
    const ops = () => fake.messages().filter((message): message is Extract<ClientMessage, { t: 'op' }> => message.t === 'op');
    const busy = Array.from({ length: MAX_CONCURRENT_OPERATIONS }, (_, index) => channel.operation('step', { index }).catch(() => undefined));
    await vi.advanceTimersByTimeAsync(0);
    const waiting = channel.docker(['ps']).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const before = ops().length;
    const call = lock.docker(['rm', '-f', 'c1'], { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(ops()).toHaveLength(before + 1);
    const op = lastOp(fake);
    expect(op).toMatchObject({ op: 'docker', params: { args: ['rm', '-f', 'c1'] }, timeoutMs: 60_000 });
    // The shared places stay full: the plain call still waits, and is `unsendable` after its slot wait.
    await vi.advanceTimersByTimeAsync(CHANNEL_SLOT_WAIT_MS + 1);
    expect(await waiting).toMatchObject({ name: 'HelperChannelError', code: 'unsendable' });
    fake.answer({ t: 'result', id: op.id, ok: true, value: { exitCode: 0 } });
    await expect(call).resolves.toEqual({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    channel.close();
    await Promise.all(busy);
  });

  it(`A-R1-2: at most ${MAX_CONCURRENT_LOCKED_OPERATIONS} calls under locks run at once; beyond, one is not sent, without a wait`, async () => {
    const { channel, fake, lock } = await held();
    const ops = () => fake.messages().filter((message): message is Extract<ClientMessage, { t: 'op' }> => message.t === 'op');
    const before = ops().length;
    const calls = Array.from({ length: MAX_CONCURRENT_LOCKED_OPERATIONS }, (_, index) => lock.docker(['stop', `c${index}`], {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(ops()).toHaveLength(before + MAX_CONCURRENT_LOCKED_OPERATIONS);
    await expect(lock.docker(['stop', 'extra'], {})).rejects.toMatchObject({ name: 'HelperChannelError', code: 'unsendable' });
    expect(ops()).toHaveLength(before + MAX_CONCURRENT_LOCKED_OPERATIONS);
    // They take none of the shared places: plain calls still go out at once.
    void channel.docker(['ps']).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(ops()).toHaveLength(before + MAX_CONCURRENT_LOCKED_OPERATIONS + 1);
    // A call that ends frees its place for the next call under a lock.
    fake.answer({ t: 'result', id: ops()[before].id, ok: true, value: { exitCode: 0 } });
    await expect(calls[0]).resolves.toMatchObject({ exitCode: 0 });
    const next = lock.docker(['stop', 'next'], {});
    await vi.advanceTimersByTimeAsync(0);
    expect(lastOp(fake)).toMatchObject({ op: 'docker', params: { args: ['stop', 'next'] } });
    channel.close();
    await Promise.allSettled([...calls, next]);
  });

  it('a cancel of the caller while it waits sends the cancel and rejects with an AbortError', async () => {
    const { channel, fake } = await openWithLock();
    const controller = new AbortController();
    const locking = channel.lock(ID, 10, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    const op = lastOp(fake);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.messages().at(-1)).toEqual({ t: 'cancel', id: op.id });
    fake.answer({ t: 'result', id: op.id, ok: false, error: { code: 'cancelled', message: 'cancelled' }, cancelled: true, timedOut: false });
    await expect(locking).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// Plan step 11A (decision of 2026-10-03, the worker is the deputy): the extension answers the requests of an operation.
describe('HelperChannel: the requests of an operation (plan step 11A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const answers = (fake: ReturnType<typeof fakeProcess>) => fake.messages().filter((message) => message.t === 'answer');

  it('answers with the value and the secrets of onAsk', async () => {
    const { channel, fake } = await openChannel();
    const seen: unknown[] = [];
    const running = channel.operation('open', {}, {
      onAsk: async (kind, payload) => {
        seen.push([kind, payload]);
        return kind === 'secret' ? { value: 'ok', secrets: { registry: 'reg-pass' } } : { value: { recreate: true } };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const op = lastOp(fake);
    fake.answer({ t: 'ask', id: op.id, ask: 1, kind: 'question', payload: { text: 'Recreate?' } });
    fake.answer({ t: 'ask', id: op.id, ask: 2, kind: 'secret', payload: { name: 'registry' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([
      ['question', { text: 'Recreate?' }],
      ['secret', { name: 'registry' }],
    ]);
    expect(answers(fake)).toEqual([
      { t: 'answer', id: op.id, ask: 1, ok: true, value: { recreate: true } },
      { t: 'answer', id: op.id, ask: 2, ok: true, value: 'ok', secrets: { registry: 'reg-pass' } },
    ]);
    fake.answer({ t: 'result', id: op.id, ok: true, value: 1 });
    await expect(running).resolves.toBe(1);
  });

  it('answers `unsupported` without onAsk, the code of a HelperOperationError, `failed` otherwise, and `invalid` for secrets it cannot send', async () => {
    const { channel, fake } = await openChannel();
    const plain = channel.operation('open', {});
    await vi.advanceTimersByTimeAsync(0);
    const first = lastOp(fake);
    fake.answer({ t: 'ask', id: first.id, ask: 1, kind: 'local', payload: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(answers(fake).at(-1)).toMatchObject({ id: first.id, ask: 1, ok: false, error: { code: 'unsupported' } });
    fake.answer({ t: 'result', id: first.id, ok: true, value: null });
    await plain;

    let call = 0;
    const failing = channel.operation('open', {}, {
      onAsk: async () => {
        call++;
        if (call === 1) throw new HelperOperationError('declined', 'The user declined.', false);
        if (call === 2) throw new Error('boom');
        return { value: null, secrets: { token: 'ab' } };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const second = lastOp(fake);
    for (const ask of [1, 2, 3]) fake.answer({ t: 'ask', id: second.id, ask, kind: 'question', payload: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(answers(fake).slice(-3)).toEqual([
      { t: 'answer', id: second.id, ask: 1, ok: false, error: { code: 'declined', message: 'The user declined.' } },
      { t: 'answer', id: second.id, ask: 2, ok: false, error: { code: 'failed', message: 'boom' } },
      { t: 'answer', id: second.id, ask: 3, ok: false, error: { code: 'invalid', message: 'The secrets of the answer cannot be sent.' } },
    ]);
    fake.answer({ t: 'result', id: second.id, ok: true, value: null });
    await failing;
  });

  it('aborts the handler when the operation ends, and sends no answer after the end; a request of an unknown operation is ignored', async () => {
    const { channel, fake } = await openChannel();
    let handlerSignal: AbortSignal | undefined;
    let release!: () => void;
    const running = channel.operation('open', {}, {
      onAsk: (_kind, _payload, signal) => {
        handlerSignal = signal;
        return new Promise((resolve) => (release = () => resolve({ value: 'late' })));
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const op = lastOp(fake);
    fake.answer({ t: 'ask', id: op.id, ask: 1, kind: 'question', payload: null });
    fake.answer({ t: 'ask', id: 999, ask: 1, kind: 'question', payload: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(handlerSignal?.aborted).toBe(false);
    fake.answer({ t: 'result', id: op.id, ok: true, value: 'done' });
    await expect(running).resolves.toBe('done');
    expect(handlerSignal?.aborted).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(answers(fake)).toEqual([]);
  });

  it('sends named secrets, and refuses secrets that it cannot send', async () => {
    const { channel, fake } = await openChannel();
    const sending = channel.operation('open', {}, { secrets: { token: 'tok-1234', registry: 'reg-5678' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastOp(fake).secrets).toEqual({ token: 'tok-1234', registry: 'reg-5678' });
    fake.answer({ t: 'result', id: lastOp(fake).id, ok: true, value: null });
    await sending;
    await expect(channel.operation('open', {}, { secrets: { 'Bad-Name': 'abcd' } })).rejects.toMatchObject({ code: 'unsendable' });
    await expect(channel.operation('open', {}, { secrets: { token: 'ab' } })).rejects.toMatchObject({ code: 'unsendable' });
  });
});
