// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Entry point of the script of the helper channel (src/core/helperChannel/protocol.ts), bundled to
// dist/helperChannel.js. The loader of the container (CHANNEL_LOADER) writes it to CHANNEL_SCRIPT_PATH and calls
// startChannel with the input that it read after the script; the rest of the standard input comes as text (the loader
// set its encoding). Only Node.js built-ins and small modules of src/core.
import { spawn } from 'child_process';
import { CHANNEL_CLEANUP_TIMEOUT_MS, CHANNEL_KILL_GRACE_MS, CHANNEL_SILENCE_EXIT_MS } from '../core/helperChannel/protocol';

/** Review round 2 (A2): the output of the calls pauses while more than this many characters wait to be written. */
export const CHANNEL_OUTPUT_HIGH_WATER = 1024 * 1024;
import { OPERATIONS } from './operations';
import { ChannelServer, type ServerChild } from './server';

/** SpawnDocker with child_process.spawn: the Docker CLI of the image, its socket; no shell. */
export function spawnDockerProcess(args: readonly string[], onStdout: (text: string) => void, onStderr: (text: string) => void): ServerChild {
  const child = spawn('docker', [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdoutDecoder = new TextDecoder('utf-8');
  const stderrDecoder = new TextDecoder('utf-8');
  child.stdout.on('data', (chunk: Buffer) => onStdout(stdoutDecoder.decode(chunk, { stream: true })));
  child.stderr.on('data', (chunk: Buffer) => onStderr(stderrDecoder.decode(chunk, { stream: true })));
  // EPIPE when the process ends before it reads its input.
  child.stdin.on('error', () => {});
  const exited = new Promise<{ exitCode: number | null; error?: string }>((resolve) => {
    let done = false;
    child.on('error', (error) => {
      if (done) return;
      done = true;
      resolve({ exitCode: null, error: error.message });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      const restOut = stdoutDecoder.decode();
      const restErr = stderrDecoder.decode();
      if (restOut !== '') onStdout(restOut);
      if (restErr !== '') onStderr(restErr);
      resolve({ exitCode: code });
    });
  });
  return {
    end: (input) => (input === undefined ? child.stdin.end() : child.stdin.end(input)),
    // Review round 2 (A2): with the reading paused, the pipe fills and the Docker CLI waits.
    pause: () => {
      child.stdout.pause();
      child.stderr.pause();
    },
    resume: () => {
      child.stdout.resume();
      child.stderr.resume();
    },
    kill: (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
    exited,
  };
}

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
 * it still cancels what runs and removes the containers of their cleanup (the shutdown ends the process by itself, with
 * its own deadline); a timer ends it later in any case, and when the shutdown itself fails, at once.
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
  const server = new ChannelServer({
    write: (text) => {
      if (process.stdout.destroyed || !process.stdout.writable) return false;
      process.stdout.write(text);
      return true;
    },
    spawnDocker: spawnDockerProcess,
    operations: OPERATIONS,
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
