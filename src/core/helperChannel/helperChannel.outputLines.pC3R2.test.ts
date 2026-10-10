// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #139 (reviewer B): probes of the mutants of OutputLines (review round 1, A-M1) that the tests of
// the round leave alive. The log's pattern (redactSecrets of OutputChannelLogger) matches a GitHub token as a whole run
// of the characters [A-Za-z0-9_]; OutputLines must never write a piece that ends inside such a run before the line or
// the operation ends, also not for a token that holds digits, the letters at the ends of the ranges, or `_`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger, StartedProcess } from '../ports';
import { HELD_OUTPUT_TAIL_CHARACTERS, HelperChannel, MAX_HELD_OUTPUT_CHARACTERS, OutputLines } from './helperChannel';
import { CHANNEL_PROTOCOL_VERSION, encodeMessage, parseClientMessage, type ClientMessage, type ServerMessage } from './protocol';

const HIGH = /[\uD800-\uDBFF]$/;
const LOW = /^[\uDC00-\uDFFF]/;

function lines(): { writes: string[]; output: OutputLines } {
  const writes: string[] = [];
  return { writes, output: new OutputLines((text) => writes.push(text)) };
}

/** No write ends inside a run of token characters that the next write continues (the cut of the 64 K bound). */
function expectNoCutInWord(writes: string[]): void {
  for (let index = 0; index + 1 < writes.length; index++) {
    const ends = /[A-Za-z0-9_]$/.test(writes[index]);
    const continues = /^[A-Za-z0-9_]/.test(writes[index + 1]);
    expect(ends && continues, `write ${index} ends inside a word`).toBe(false);
  }
}

describe('review round 2 of PR #139: OutputLines cuts a long line only where no token can be', () => {
  it('the bound is 64 KiB, and the held tail is longer than a GitHub token (93 characters for github_pat_)', () => {
    expect(MAX_HELD_OUTPUT_CHARACTERS).toBe(64 * 1024);
    expect(HELD_OUTPUT_TAIL_CHARACTERS).toBe(256);
  });

  // The token holds each character at the ends of the ranges of [A-Za-z0-9_]: 0 9 A Z a z _.
  const TOKEN = 'ghp_z9aZ0A_MMMMMMMMMMMMMMMMMMMMMMMMMMMMM';

  it('a token in which the bound falls, for every kind of character that it holds, is written whole', () => {
    expect(TOKEN).toHaveLength(40);
    // Each place in the token where the bound can fall (the character before `limit` = length - HELD_OUTPUT_TAIL_CHARACTERS).
    for (let place = 0; place < TOKEN.length; place++) {
      const head = `${'y'.repeat(MAX_HELD_OUTPUT_CHARACTERS)} `;
      const tail = ' '.concat('t'.repeat(HELD_OUTPUT_TAIL_CHARACTERS - TOKEN.length + place));
      const line = `${head}${TOKEN}${tail}`;
      expect(line.length - HELD_OUTPUT_TAIL_CHARACTERS - 1).toBe(head.length + place);
      const { writes, output } = lines();
      output.push(line);
      // The bound wrote the line before the token (the bound holds), never into it.
      expect(writes.length, `place ${place}`).toBe(1);
      expect(writes[0].includes('ghp_'), `place ${place}`).toBe(false);
      expect(writes[0].length, `place ${place}`).toBeGreaterThanOrEqual(MAX_HELD_OUTPUT_CHARACTERS);
      output.flush();
      expect(writes.join('')).toBe(line);
      expect(writes.filter((write) => write.includes('ghp_')).every((write) => write.includes(TOKEN)), `place ${place}`).toBe(true);
      expectNoCutInWord(writes);
    }
  });

  it('a surrogate pair at the bound: no write ends with the first half of a pair', () => {
    // The first half of the pair is the character just before `limit`; a space before it is the place to cut.
    const line = `${'y'.repeat(MAX_HELD_OUTPUT_CHARACTERS)} \u{1F600}${'w'.repeat(HELD_OUTPUT_TAIL_CHARACTERS - 1)}`;
    const { writes, output } = lines();
    output.push(line);
    expect(writes.length).toBe(1);
    output.flush();
    expect(writes.join('')).toBe(line);
    for (const write of writes) {
      expect(HIGH.test(write)).toBe(false);
      expect(LOW.test(write)).toBe(false);
    }
  });

  it('one word longer than the bound is written before the end, never after the first half of a pair', () => {
    const word = `${'y'.repeat(MAX_HELD_OUTPUT_CHARACTERS)}\u{1F600}${'y'.repeat(HELD_OUTPUT_TAIL_CHARACTERS - 1)}`;
    const { writes, output } = lines();
    output.push(word);
    // Not held unbounded: all but the tail is written at once.
    expect(writes.length).toBe(1);
    expect(word.length - writes[0].length).toBeLessThanOrEqual(HELD_OUTPUT_TAIL_CHARACTERS + 1);
    expect(HIGH.test(writes[0])).toBe(false);
    output.flush();
    expect(writes.join('')).toBe(word);
    expect(LOW.test(writes[1])).toBe(false);
  });

  it('a long word after a line break: nothing is lost or written twice', () => {
    const text = `first\n${'y'.repeat(MAX_HELD_OUTPUT_CHARACTERS + 1_000)}`;
    const { writes, output } = lines();
    output.push(text);
    output.push('z'.repeat(10));
    output.flush();
    expect(writes.join('')).toBe(`${text}${'z'.repeat(10)}`);
    expect(writes[0]).toBe('first\n');
  });

  it('a line that ends with a carriage return (a progress line) is written at once', () => {
    const { writes, output } = lines();
    output.push('Receiving objects:  10% (1/10)\r');
    expect(writes).toEqual(['Receiving objects:  10% (1/10)\r']);
    output.push('Receiving objects: 100% (10/10)\rdone');
    expect(writes).toEqual(['Receiving objects:  10% (1/10)\r', 'Receiving objects: 100% (10/10)\r']);
    output.flush();
    expect(writes[2]).toBe('done');
  });
});

/** A `docker run` process of a channel (as in helperChannel.test.ts): the test answers as the script. */
function fakeProcess() {
  let stdout: ((text: string) => void) | undefined;
  let resolveExit!: (value: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => (resolveExit = resolve));
  const written: string[] = [];
  const process: StartedProcess = {
    write: (text) => {
      written.push(...text.split('\n').filter((line) => line !== ''));
      return true;
    },
    end: () => {},
    kill: () => resolveExit({ exitCode: null }),
    onStdout: (listener) => (stdout = listener),
    onStderr: () => {},
    exited,
  };
  const messages = (): ClientMessage[] => written.slice(1).map((line) => parseClientMessage(line)!);
  return { process, messages, answer: (message: ServerMessage) => stdout?.(encodeMessage(message)) };
}

async function openChannel() {
  const fake = fakeProcess();
  const outputs: string[] = [];
  const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, output: (text) => outputs.push(text) };
  const opening = HelperChannel.open(fake.process, 'SCRIPT', { logger, name: 'box' });
  await vi.advanceTimersByTimeAsync(0);
  fake.answer({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24.0.0', ops: ['probe'] });
  const channel = await opening;
  const lastId = () => {
    const ops = fake.messages().filter((message) => message.t === 'op');
    return (ops[ops.length - 1] as Extract<ClientMessage, { t: 'op' }>).id;
  };
  return { channel, fake, outputs, lastId };
}

describe('review round 2 of PR #139: HelperChannel holds the output of each stream of an operation on its own', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const UNKNOWN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  it('a token split on stderr around a line of stdout reaches the log whole', async () => {
    const { channel, fake, outputs, lastId } = await openChannel();
    const result = channel.operation('probe', {});
    const id = lastId();
    fake.answer({ t: 'out', id, stream: 'stderr', data: `x ${UNKNOWN.slice(0, 12)}` });
    fake.answer({ t: 'out', id, stream: 'stdout', data: 'a line\n' });
    fake.answer({ t: 'out', id, stream: 'stderr', data: `${UNKNOWN.slice(12)}\n` });
    fake.answer({ t: 'result', id, ok: true, value: null });
    await expect(result).resolves.toBeNull();
    expect(outputs).toEqual(['a line\n', `x ${UNKNOWN}\n`]);
    channel.closeNow();
  });

  it('the held stderr of an operation is written when it ends', async () => {
    const { channel, fake, outputs, lastId } = await openChannel();
    const result = channel.operation('probe', {});
    const id = lastId();
    fake.answer({ t: 'out', id, stream: 'stderr', data: 'last words' });
    fake.answer({ t: 'result', id, ok: true, value: null });
    await expect(result).resolves.toBeNull();
    expect(outputs).toEqual(['last words']);
    channel.closeNow();
  });

  it('an operation with onOutput: its output goes only there, never to the log', async () => {
    const { channel, fake, outputs, lastId } = await openChannel();
    const seen: string[] = [];
    const result = channel.operation('probe', {}, { onOutput: (stream, text) => seen.push(`${stream}:${text}`) });
    const id = lastId();
    fake.answer({ t: 'out', id, stream: 'stdout', data: 'one\n' });
    fake.answer({ t: 'out', id, stream: 'stderr', data: 'two' });
    fake.answer({ t: 'result', id, ok: true, value: null });
    await expect(result).resolves.toBeNull();
    expect(seen).toEqual(['stdout:one\n', 'stderr:two']);
    expect(outputs).toEqual([]);
    channel.closeNow();
  });
});
