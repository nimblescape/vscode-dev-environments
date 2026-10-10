// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review probe of #139 (review A), adopted as the test of its fixes A-M1 and A-L1: the raw tool output that D1
// forwards, end to end into the extension's OutputChannelLogger (its pattern masking redactSecrets is the last line of
// defence for a GitHub token that the operation does not hold). review round 1 of PR #139 (A-M1): the extension writes
// the output of an operation in whole lines (OutputLines), so the pattern sees a token whole; changed expectations are
// marked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('../vscode/testing/fakeVscode')).fakeVscode);

import { HelperChannel } from '../core/helperChannel/helperChannel';
import { HELD_OUTPUT_TAIL_CHARACTERS, MAX_HELD_OUTPUT_CHARACTERS } from '../core/helperChannel/helperChannel';
import { OUTPUT_CHUNK_CHARACTERS, parseServerMessage } from '../core/helperChannel/protocol';
import type { StartedProcess } from '../core/ports';
import { OutputChannelLogger } from '../vscode/logger';
import { fakeVscode, resetFakeVscode } from '../vscode/testing/fakeVscode';
import { contextLogger } from './flowOperations';
import { ChannelServer, type OperationHandler } from './server';

const OP = 'toolOutput';
// A GitHub token that the operation never got (for example printed by a lifecycle command from the user's own
// configuration, or an older token still in a running dev container).
const UNKNOWN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const KNOWN = 'gho_0123456789abcdefSECRETtoken';

async function connect(operation: OperationHandler) {
  const logger = new OutputChannelLogger();
  // Review round 1 of PR #139 (A-L1): the `out` pieces that the server sends.
  const pieces: string[] = [];
  let toExtension: (text: string) => void = () => {};
  let resolveExit!: (value: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => (resolveExit = resolve));
  const server = new ChannelServer({
    write: (text) => {
      for (const line of text.split('\n')) {
        const message = line === '' ? undefined : parseServerMessage(line);
        if (message?.t === 'out') pieces.push(message.data);
      }
      setImmediate(() => toExtension(text));
      return true;
    },
    operations: { [OP]: operation },
    exit: (code) => resolveExit({ exitCode: code }),
  });
  server.start();
  let scriptLine = true;
  const process: StartedProcess = {
    write: (text) => {
      let rest = text;
      if (scriptLine) {
        const end = rest.indexOf('\n');
        if (end < 0) return true;
        rest = rest.slice(end + 1);
        scriptLine = false;
      }
      setImmediate(() => server.input(rest));
      return true;
    },
    end: () => setImmediate(() => server.inputEnded()),
    kill: () => server.shutdown(),
    onStdout: (listener) => (toExtension = listener),
    onStderr: () => {},
    exited,
  };
  const channel = await HelperChannel.open(process, 'SCRIPT', { logger, name: 'box' });
  return { channel, server, logger, pieces };
}

function writes(pieces: string[]): OperationHandler {
  return async (_params, context) => {
    await context.ask('secret', { name: 'token' });
    const logger = contextLogger(context);
    for (const piece of pieces) logger.output(piece);
    return { done: true };
  };
}

let opened: Awaited<ReturnType<typeof connect>> | undefined;
beforeEach(() => resetFakeVscode());
afterEach(() => {
  opened?.channel.closeNow();
  opened?.server.shutdown();
  opened = undefined;
});

function recordAppends(): string[] {
  const appends: string[] = [];
  const channel = fakeVscode.outputChannels[0];
  const original = channel.append.bind(channel);
  channel.append = (value: string) => {
    appends.push(value);
    original(value);
  };
  return appends;
}

async function logText(pieces: string[]): Promise<{ text: string; appends: string[] }> {
  opened = await connect(writes(pieces));
  const appends = recordAppends();
  const channel = fakeVscode.outputChannels[0];
  expect(await opened.channel.flow(OP, {}, { onAsk: async () => ({ value: null, secrets: { token: KNOWN } }) })).toEqual({ done: true });
  return { text: channel.text, appends };
}

describe('review probe: a GitHub token that the operation does not hold', () => {
  it('control: in one piece, the pattern of the extension masks it', async () => {
    const { text } = await logText([`echo ${UNKNOWN}\n`]);
    expect(text).not.toContain(UNKNOWN);
  });

  // Review round 1 of PR #139 (A-M1): changed expectation: masked (the probe showed it whole and unmasked).
  it('split across two tool chunks: it never reaches the output channel', async () => {
    const { text, appends } = await logText([`echo ${UNKNOWN.slice(0, 10)}`, `${UNKNOWN.slice(10)}\n`]);
    expect(text).not.toContain(UNKNOWN);
    expect(text).not.toContain(UNKNOWN.slice(0, 10));
    expect(appends).toEqual(['echo ***\n']);
  });

  // Review round 1 of PR #139 (A-M1): changed expectation: masked, and written once as the whole line (the probe: two
  // appends, the token unmasked).
  it('in one tool chunk, but across the 16 K piece boundary of the channel: masked', async () => {
    const before = 'x'.repeat(OUTPUT_CHUNK_CHARACTERS - 12) + ' ';
    const { text, appends } = await logText([`${before}${UNKNOWN}\n`]);
    expect(opened?.pieces.length).toBe(2);
    expect(appends).toEqual([`${before}***\n`]);
    expect(text).not.toContain(UNKNOWN);
  });

  it('the rest without a line break is written, masked, when the operation ends', async () => {
    const { text, appends } = await logText(['first line\n', `last ${UNKNOWN.slice(0, 12)}`, UNKNOWN.slice(12)]);
    expect(appends).toEqual(['first line\n', 'last ***']);
    expect(text).not.toContain(UNKNOWN);
    // The rest comes before the line of the result.
    expect(text.indexOf('last ***')).toBeLessThan(text.indexOf(`${OP}#1: done`));
  });

  it('a long line without a line break is not held beyond its limit, and no token is cut by what is written', async () => {
    // The token starts just before the place where the held tail begins (HELD_OUTPUT_TAIL_CHARACTERS from the end).
    const head = 'y'.repeat(MAX_HELD_OUTPUT_CHARACTERS - 20) + ' ';
    const tail = 'z'.repeat(HELD_OUTPUT_TAIL_CHARACTERS - 20);
    const line = `${head}${UNKNOWN} ${tail}`;
    opened = await connect(async (_params, context) => {
      const logger = contextLogger(context);
      for (let start = 0; start < line.length; start += 1000) logger.output(line.slice(start, start + 1000));
      await new Promise((resolve) => setTimeout(resolve, 50));
      written = [...appends];
      return { done: true };
    });
    let written: string[] = [];
    const appends = recordAppends();
    expect(await opened.channel.flow(OP, {})).toEqual({ done: true });
    // Before the end of the operation, all but the tail was written: cut before the token, never in it.
    expect(written).toEqual([head]);
    expect(appends).toEqual([head, `*** ${tail}`]);
    expect(fakeVscode.outputChannels[0].text).not.toContain(UNKNOWN.slice(0, 8));
  });
});

describe('review round 1 of PR #139 (A-M1): the held output is written however the operation ends', () => {
  async function held(operation: OperationHandler, end: (channel: HelperChannel, controller: AbortController) => void): Promise<string> {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    opened = await connect(async (params, context) => {
      contextLogger(context).output(`partial ${UNKNOWN.slice(0, 15)}`);
      contextLogger(context).output(UNKNOWN.slice(15));
      started();
      return operation(params, context);
    });
    const controller = new AbortController();
    const result = opened.channel.operation(OP, {}, { signal: controller.signal }).catch((error: unknown) => error);
    await begun;
    await new Promise((resolve) => setTimeout(resolve, 20));
    end(opened.channel, controller);
    await result;
    return fakeVscode.outputChannels[0].text;
  }

  it('its failure', async () => {
    const text = await held(async () => {
      throw new Error('failed');
    }, () => {});
    expect(text).toContain('partial ***');
    expect(text).not.toContain(UNKNOWN);
  });

  it('its cancel', async () => {
    const text = await held(
      (_params, context) => new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('cancelled')))),
      (_channel, controller) => controller.abort(),
    );
    expect(text).toContain('partial ***');
    expect(text).not.toContain(UNKNOWN);
  });

  it('the loss of the channel', async () => {
    const text = await held(
      () => new Promise(() => {}),
      (channel) => channel.closeNow(),
    );
    expect(text).toContain('partial ***');
    expect(text).not.toContain(UNKNOWN);
  });
});

describe('review probe: a surrogate pair at the 16 K piece boundary', () => {
  // Review round 1 of PR #139 (A-L1, and A-M1 for the appends): changed expectation: no piece holds a lone surrogate
  // (the first one ends one character earlier), and the output channel gets the whole line once.
  it('no piece holds a lone surrogate', async () => {
    const before = 'a'.repeat(OUTPUT_CHUNK_CHARACTERS - 1);
    const { text, appends } = await logText([`${before}\u{1F600} after\n`]);
    expect(appends).toEqual([`${before}\u{1F600} after\n`]);
    expect(text).toContain(`${before}\u{1F600} after\n`);
    expect(opened?.pieces).toEqual([before, `\u{1F600} after\n`]);
    for (const piece of opened?.pieces ?? []) {
      expect(/[\uD800-\uDBFF]$/.test(piece)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(piece)).toBe(false);
    }
  });
});

describe('review probe: output after the operation ended', () => {
  it('is dropped by the extension and does not end the channel', async () => {
    let late!: () => void;
    opened = await connect(async (_params, context) => {
      const logger = contextLogger(context);
      late = () => logger.output('late output\n');
      return { done: true };
    });
    expect(await opened.channel.flow(OP, {})).toEqual({ done: true });
    late();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fakeVscode.outputChannels[0].text).not.toContain('late output');
    expect(await opened.channel.flow(OP, {})).toEqual({ done: true });
  });
});
