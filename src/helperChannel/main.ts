// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Entry point of the script of the helper channel (src/core/helperChannel/protocol.ts), bundled to
// dist/helperChannel.js. The pipe loader of the container (src/core/loader/pipeLoader.ts, plan step 3) checks its hash,
// stores it at CHANNEL_SCRIPT_PATH, and calls startChannel (CHANNEL_ENTRY) with the input that it read after the script;
// the rest of the standard input comes as text (the loader set its encoding and paused it). Only Node.js built-ins and small modules of src/core.
// Plan step 11I (PR A): the worker starts no `docker` process (spawnDockerProcess is gone): its operations act on the
// engine through the port over the Engine API (section 0 of the plan).
import * as fs from 'fs';
import { CHANNEL_CLEANUP_TIMEOUT_MS, CHANNEL_KILL_GRACE_MS, CHANNEL_SILENCE_EXIT_MS } from '../core/helperChannel/protocol';

/**
 * Review round 2 (A2): the output that the operations read from the engine (OperationContext.pausable) pauses while more
 * than this many characters wait to be written.
 */
export const CHANNEL_OUTPUT_HIGH_WATER = 1024 * 1024;
import { batchHelperOperations, prepareBatchHelper, runQuietProcess, spawnStepProcess } from './batchHelper';
import { OPERATIONS } from './operations';
import { ChannelServer, type OperationHandler } from './server';

/**
 * The shorter times of the Docker tests: DEVENV_CHANNEL_SILENCE_MS (500..60000 ms) for the silence; the idle time is
 * twice it. Anything else: the times of protocol.ts.
 */
export function timesFromEnv(env: NodeJS.ProcessEnv): { silenceMs?: number; idleMs?: number } {
  const text = env.DEVENV_CHANNEL_SILENCE_MS;
  if (text === undefined || !/^\d{3,5}$/.test(text)) return {};
  const silenceMs = Number(text);
  return silenceMs >= 500 && silenceMs <= CHANNEL_SILENCE_EXIT_MS ? { silenceMs, idleMs: 2 * silenceMs } : {};
}

/**
 * The handler of an uncaught error. A defect of the script must never leave the container running. Review round 1 (P5):
 * it still cancels what runs (the shutdown ends the process by itself, with its own deadline); a timer ends it later in
 * any case, and when the shutdown itself fails, at once.
 */
export function fatalHandler(server: Pick<ChannelServer, 'shutdown'>, exit: (code: number) => void): () => void {
  return () => {
    setTimeout(() => exit(1), CHANNEL_KILL_GRACE_MS + CHANNEL_CLEANUP_TIMEOUT_MS + 10_000);
    try {
      server.shutdown();
    } catch {
      exit(1);
    }
  };
}

/** Runs the channel on the standard input and output of this process. `initial`: input that the loader read already. */
export function startChannel(initial: string): void {
  serve(initial, OPERATIONS);
}

/**
 * Plan step 6, PR B: the entry of the batch helper (BATCH_ENTRY), in the same script as the worker: the same server and
 * the same ways to end, with the step kinds as its operations (batchHelper.ts).
 */
export function startBatchHelper(initial: string): void {
  const unsafe = prepareBatchHelper();
  serve(initial, batchHelperOperations({ spawnStep: spawnStepProcess, runQuiet: runQuietProcess, fs, env: process.env, unsafe }));
}

function serve(initial: string, operations: Readonly<Record<string, OperationHandler>>): void {
  const server = new ChannelServer({
    write: (text) => {
      if (process.stdout.destroyed || !process.stdout.writable) return false;
      process.stdout.write(text);
      return true;
    },
    operations,
    // Review round 2 (A2): `process.stdout.write` to a pipe does not wait; the answers that wait are bounded here.
    congested: () => process.stdout.writableLength > CHANNEL_OUTPUT_HIGH_WATER,
    onDrain: (listener) => process.stdout.once('drain', listener),
    exit: (code) => process.exit(code),
    ...timesFromEnv(process.env),
  });
  // An answer that cannot be written anymore (EPIPE: the connection is gone).
  process.stdout.on('error', () => server.shutdown());
  process.on('SIGTERM', () => server.shutdown());
  process.on('SIGINT', () => server.shutdown());
  process.on('SIGHUP', () => server.shutdown());
  const fatal = fatalHandler(server, (code) => process.exit(code));
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  server.start();
  if (initial !== '') server.input(initial);
  process.stdin.on('data', (chunk: string | Buffer) => server.input(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
  process.stdin.on('end', () => server.inputEnded());
  process.stdin.on('close', () => server.inputEnded());
  process.stdin.on('error', () => server.inputEnded());
  process.stdin.resume();
}
