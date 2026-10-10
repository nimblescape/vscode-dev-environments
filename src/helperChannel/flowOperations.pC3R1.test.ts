// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup PR #139 (B, mutation probes): the raw tool output of a flow in the worker
// (contextLogger(context).output, D1) reaches the log of the extension in full (also beyond one piece of the channel),
// and every secret of the operation is masked in it (also one that a later answer gave, split across pieces). The
// harness is the one of flowOperations.pC3.test.ts: the worker's ChannelServer and the extension's HelperChannel in
// memory.
import { afterEach, describe, expect, it } from 'vitest';
import { HelperChannel } from '../core/helperChannel/helperChannel';
import type { Logger, StartedProcess } from '../core/ports';
import { OUTPUT_CHUNK_CHARACTERS } from '../core/helperChannel/protocol';
import { contextLogger } from './flowOperations';
import { ChannelServer, type OperationHandler } from './server';

const TOKEN = 'gho_0123456789abcdefSECRETtoken';
const OP = 'toolOutput';
const REGISTRY = 'registry-password-PROBE-0123';

/**
 * The extension's HelperChannel on a ChannelServer of the worker in this process (the first line, the script, dropped).
 * Each side gets the text of the other one in a later turn of the event loop, in order, as from a pipe.
 */
async function connect(operation: OperationHandler) {
  const log: { output: string[]; lines: string[] } = { output: [], lines: [] };
  const logger: Logger = {
    info: (line) => log.lines.push(line),
    warn: (line) => log.lines.push(line),
    error: (line) => log.lines.push(line),
    output: (text) => log.output.push(text),
  };
  let toExtension: (text: string) => void = () => {};
  let resolveExit!: (value: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => (resolveExit = resolve));
  const server = new ChannelServer({
    write: (text) => {
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
  const channel = await HelperChannel.open(process, 'SCRIPT', { logger, name: 'build-box' });
  return { channel, log, server };
}

/**
 * A flow that gets the token from the extension (as the open does, through a request whose answer gives it as the
 * secret `token`), then writes `pieces` as the raw output of its tools.
 */
function writesOutput(pieces: string[], options: { forget?: boolean } = {}): OperationHandler {
  return async (_params, context) => {
    await context.ask('secret', { name: 'token' });
    // A secret that the operation no longer holds stays masked (OperationContext.maskedValues).
    if (options.forget === true) context.forgetSecret('token');
    const logger = contextLogger(context);
    for (const piece of pieces) logger.output(piece);
    return { done: true };
  };
}

const answerToken = async (_kind: unknown, payload: unknown): Promise<{ value: unknown; secrets: Record<string, string> }> =>
  (payload as { name?: string }).name === 'registry' ? { value: null, secrets: { registry: REGISTRY } } : { value: null, secrets: { token: TOKEN } };

let opened: Awaited<ReturnType<typeof connect>> | undefined;

afterEach(() => {
  opened?.channel.closeNow();
  opened?.server.shutdown();
  opened = undefined;
});

async function run(pieces: string[], options: { forget?: boolean } = {}): Promise<{ output: string; pieces: string[] }> {
  opened = await connect(writesOutput(pieces, options));
  expect(await opened.channel.flow(OP, {}, { onAsk: answerToken })).toEqual({ done: true });
  return { output: opened.log.output.join(''), pieces: opened.log.output };
}

describe('the raw tool output of a flow in the worker (review round 1 of PR #139, B)', () => {
  it('reaches the log in full and in order, also a piece longer than OUTPUT_CHUNK_CHARACTERS', async () => {
    const long = Array.from({ length: 3 * 1024 }, (_, index) => `line ${String(index).padStart(5, '0')}\n`).join('');
    expect(long.length).toBeGreaterThan(2 * OUTPUT_CHUNK_CHARACTERS);
    const { output, pieces } = await run(['start\n', long, 'end\n']);
    expect(output).toBe(`start\n${long}end\n`);
    expect(pieces.every((piece) => piece.length <= OUTPUT_CHUNK_CHARACTERS)).toBe(true);
  });

  it('masks a secret that a later answer gave (a registry login), also split across pieces', async () => {
    opened = await connect(async (_params, context) => {
      await context.ask('secret', { name: 'token' });
      const logger = contextLogger(context);
      logger.output(`token ${TOKEN}\n`);
      await context.ask('secret', { name: 'registry' });
      logger.output(`login ${REGISTRY.slice(0, 10)}`);
      logger.output(`${REGISTRY.slice(10)} ok\n`);
      logger.output(`cut ${REGISTRY.slice(0, 6)}`);
      return { done: true };
    });
    expect(await opened.channel.flow(OP, {}, { onAsk: answerToken })).toEqual({ done: true });
    expect(opened.log.output.join('')).toBe('token ***\nlogin *** ok\ncut ***');
  });

  it('the stderr of an operation is flushed (masked) at its end too, after the stdout of the flow', async () => {
    opened = await connect(async (_params, context) => {
      await context.ask('secret', { name: 'token' });
      contextLogger(context).output('tool line\n');
      context.output('stderr', `cut ${TOKEN.slice(0, 9)}`);
      return { done: true };
    });
    expect(await opened.channel.flow(OP, {}, { onAsk: answerToken })).toEqual({ done: true });
    expect(opened.log.output.join('')).toBe('tool line\ncut ***');
  });
});
