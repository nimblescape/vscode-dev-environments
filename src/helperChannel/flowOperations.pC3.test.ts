// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup after plan step 11 (PR C3, D1, decision of 2026-10-10): the raw output of the tools of a flow in the worker
// (contextLogger(context).output) reaches the Dev Environments log of the extension, through the secret masking of the
// operation (its StreamRedactor). The worker's ChannelServer and the extension's HelperChannel are connected in memory;
// the log is the Logger of the channel (as in the extension, a flow passes no onOutput, so its output goes to the log).
import { afterEach, describe, expect, it } from 'vitest';
import { HelperChannel } from '../core/helperChannel/helperChannel';
import type { Logger, StartedProcess } from '../core/ports';
import { contextLogger } from './flowOperations';
import { ChannelServer, type OperationHandler } from './server';

const TOKEN = 'gho_0123456789abcdefSECRETtoken';
const OP = 'toolOutput';

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

const answerToken = async () => ({ value: null, secrets: { token: TOKEN } });

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

describe('the raw tool output of a flow in the worker reaches the log of the extension (PR C3, D1)', () => {
  it('passes the output on as it is, in its order, before the result', async () => {
    const { output } = await run(["Cloning into 'api'...\n", 'Receiving objects: 100% (12/12), done.\n', '[2 ms] Start: Run: docker build\n']);
    expect(output).toBe("Cloning into 'api'...\nReceiving objects: 100% (12/12), done.\n[2 ms] Start: Run: docker build\n");
  });

  it('masks the token also when two pieces split it, at every split', async () => {
    for (let at = 1; at < TOKEN.length; at += 5) {
      const { output } = await run([`remote: https://x-access-token:${TOKEN.slice(0, at)}`, `${TOKEN.slice(at)}@github.com\n`, 'done\n']);
      expect(output, `split at ${at}`).toBe('remote: https://x-access-token:***@github.com\ndone\n');
      opened?.channel.closeNow();
      opened?.server.shutdown();
    }
  });

  it('masks the token at the very end of the output, also when the operation ends in the middle of it (flushed, masked)', async () => {
    expect((await run(['npm ERR! last line without a line feed ', TOKEN])).output).toBe('npm ERR! last line without a line feed ***');
    opened?.channel.closeNow();
    opened?.server.shutdown();
    // The stream was cut after the start of the token: the held-back start goes on as `***` when the operation ends.
    const cut = await run(['npm ERR! cut ', TOKEN.slice(0, 12)]);
    expect(cut.output).toBe('npm ERR! cut ***');
    expect(cut.output).not.toContain(TOKEN.slice(0, 4));
  });

  it('a trailing partial line goes to the log too', async () => {
    expect((await run(['line\n', 'partial line without a line feed'])).output).toBe('line\npartial line without a line feed');
  });

  it('masks a token that the operation held and no longer holds', async () => {
    const { output } = await run([`token ${TOKEN.slice(0, 7)}`, `${TOKEN.slice(7)} forgotten\n`], { forget: true });
    expect(output).toBe('token *** forgotten\n');
  });
});
