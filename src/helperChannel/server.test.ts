// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_KILL_GRACE_MS,
  CHANNEL_PROTOCOL_VERSION,
  CHANNEL_SERVER_IDLE_EXIT_MS,
  CHANNEL_SILENCE_EXIT_MS,
  MAX_CLIENT_LINE,
  OUTPUT_CHUNK_CHARACTERS,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from '../core/helperChannel/protocol';
import { OPERATIONS } from './operations';
import {
  ChannelServer,
  MAX_CONTEXT_STDERR_CHARACTERS,
  MAX_CONTEXT_STDOUT_CHARACTERS,
  StreamRedactor,
  commandLine,
  redact,
  type ContextDockerResult,
  type OperationHandler,
  type ServerChild,
} from './server';

interface FakeChild extends ServerChild {
  args: string[];
  input: string | undefined;
  signals: string[];
  stdout(text: string): void;
  stderr(text: string): void;
  exit(exitCode: number | null): void;
}

/** A Docker CLI that records its calls; each call ends when the test says so, or on SIGKILL (and SIGTERM if `endsOnTerm`). */
/** The answer of the fake to a call that ends by itself (for example the `docker ps` and `docker rm` of a cleanup). */
type FakeAnswer = { stdout?: string; exitCode: number };

/** The answers of the cleanup: `docker ps` names `ids` (one per line), `docker rm` ends with 0. */
function cleanupAnswers(ids: string[]) {
  return (args: readonly string[]): FakeAnswer | undefined => {
    if (args[0] === 'ps') return { stdout: ids.map((id) => `${id}\n`).join(''), exitCode: 0 };
    if (args[0] === 'rm') return { exitCode: 0 };
    return undefined;
  };
}

const LABEL = 'step-0a1b2c3d4e5f';
const PS_OF_LABEL = ['ps', '-aq', '--no-trunc', '--filter', `label=nimblescape.devenv.channel-step=${LABEL}`];
const ID_1 = '0123456789abcdef0123456789abcdef';
const ID_2 = 'fedcba9876543210fedcba9876543210';

function fakeDocker(options: { endsOnTerm?: boolean; respond?: (args: readonly string[]) => FakeAnswer | undefined } = {}) {
  const children: FakeChild[] = [];
  const spawn = (args: readonly string[], onStdout: (text: string) => void, onStderr: (text: string) => void): ServerChild => {
    let resolveExit!: (value: { exitCode: number | null }) => void;
    let ended = false;
    const exited = new Promise<{ exitCode: number | null }>((resolve) => (resolveExit = resolve));
    const child: FakeChild = {
      args: [...args],
      input: undefined,
      signals: [],
      end: (input) => {
        child.input = input;
        const answer = options.respond?.(args);
        if (answer !== undefined) {
          queueMicrotask(() => {
            if (answer.stdout) onStdout(answer.stdout);
            child.exit(answer.exitCode);
          });
        }
      },
      kill: (signal) => {
        child.signals.push(signal);
        if (signal === 'SIGKILL' || options.endsOnTerm === true) child.exit(null);
      },
      exited,
      stdout: onStdout,
      stderr: onStderr,
      exit: (exitCode) => {
        if (ended) return;
        ended = true;
        resolveExit({ exitCode });
      },
    };
    children.push(child);
    return child;
  };
  return { children, spawn };
}

function setup(options: { operations?: Record<string, OperationHandler>; docker?: ReturnType<typeof fakeDocker>; writable?: () => boolean } = {}) {
  const docker = options.docker ?? fakeDocker();
  const messages: ServerMessage[] = [];
  const exits: number[] = [];
  const server = new ChannelServer({
    write: (text) => {
      if (options.writable && !options.writable()) return false;
      for (const line of text.split('\n').filter((part) => part !== '')) messages.push(JSON.parse(line) as ServerMessage);
      return true;
    },
    spawnDocker: docker.spawn,
    operations: options.operations ?? OPERATIONS,
    exit: (code) => exits.push(code),
  });
  server.start();
  const send = (message: ClientMessage) => server.input(encodeMessage(message));
  const of = (id: number) => messages.filter((message) => 'id' in message && message.id === id);
  const resultOf = (id: number) => of(id).find((message) => message.t === 'result');
  return { server, docker, messages, exits, send, of, resultOf };
}

describe('ChannelServer (user request 2026-09-28: the helper channel)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers hello with its protocol, its Node.js version, and its operations; ping with pong', () => {
    const { send, messages } = setup();
    send({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION });
    send({ t: 'ping', n: 7 });
    expect(messages).toEqual([
      { t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: process.version, ops: ['docker', 'probe'] },
      { t: 'pong', n: 7 },
    ]);
  });

  it('runs the docker operation: its output as it comes, a log line per call, then its exit code', async () => {
    const { send, docker, of } = setup();
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['ps', '-a', '--format', '{{json .}}'], input: 'in' } });
    const [child] = docker.children;
    expect(child.args).toEqual(['ps', '-a', '--format', '{{json .}}']);
    expect(child.input).toBe('in');
    child.stdout('line 1\n');
    child.stderr('warning\n');
    child.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(of(1)).toEqual([
      { t: 'log', id: 1, level: 'info', text: '$ docker ps -a --format "{{json .}}"' },
      { t: 'out', id: 1, stream: 'stdout', data: 'line 1\n' },
      { t: 'out', id: 1, stream: 'stderr', data: 'warning\n' },
      { t: 'log', id: 1, level: 'info', text: 'exit code 0 after 0.0 s' },
      { t: 'result', id: 1, ok: true, value: { exitCode: 0 } },
    ]);
  });

  it('names the last line of the error output in the log line of a failed call', async () => {
    const { send, docker, of } = setup();
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['inspect', 'x'] } });
    docker.children[0].stderr('Error: No such object: x\n');
    docker.children[0].exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(of(1).filter((message) => message.t === 'log').map((message) => (message as { text: string }).text)).toEqual([
      '$ docker inspect x',
      'exit code 1 after 0.0 s: Error: No such object: x',
    ]);
  });

  it('splits long output into pieces of OUTPUT_CHUNK_CHARACTERS', async () => {
    const { send, docker, of } = setup();
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['logs', 'x'] } });
    docker.children[0].stdout('a'.repeat(OUTPUT_CHUNK_CHARACTERS + 5));
    docker.children[0].exit(0);
    await vi.advanceTimersByTimeAsync(0);
    const pieces = of(1).filter((message) => message.t === 'out') as { data: string }[];
    expect(pieces.map((piece) => piece.data.length)).toEqual([OUTPUT_CHUNK_CHARACTERS, 5]);
  });

  it('gives the secret only as input of a call and masks it in the output, also when a chunk splits it', async () => {
    const { send, docker, of } = setup();
    const secret = 'ghp_secretTOKEN123';
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['exec', '-i', 'c', 'cat'], inputIsSecret: true }, secret });
    const [child] = docker.children;
    expect(child.args.join(' ')).not.toContain(secret);
    expect(child.input).toBe(secret);
    child.stdout(`echo ${secret.slice(0, 6)}`);
    child.stdout(`${secret.slice(6)} done\n`);
    child.stderr(secret);
    child.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    const text = JSON.stringify(of(1));
    expect(text).not.toContain(secret);
    const stdout = of(1)
      .filter((message) => message.t === 'out' && message.stream === 'stdout')
      .map((message) => (message as { data: string }).data)
      .join('');
    expect(stdout).toBe('echo *** done\n');
  });

  it('refuses a docker operation that expects a secret without one', async () => {
    const { send, docker, resultOf } = setup();
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['exec'], inputIsSecret: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(docker.children).toHaveLength(0);
    expect(resultOf(1)).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('answers an unknown operation, invalid parameters, an invalid request with an id, and a second use of an id', async () => {
    const { send, server, docker, resultOf, messages } = setup();
    send({ t: 'op', id: 1, op: 'nothing', params: {} });
    send({ t: 'op', id: 2, op: 'docker', params: { args: [] } });
    server.input(`${JSON.stringify({ t: 'op', id: 3, op: 'docker', params: {}, extra: 1 })}\n`);
    send({ t: 'op', id: 4, op: 'docker', params: { args: ['ps'] } });
    send({ t: 'op', id: 4, op: 'docker', params: { args: ['ps'] } });
    // A line without an id of an operation is ignored.
    server.input('{"t":"what"}\nnot json\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: false, error: { code: 'unknown' } });
    expect(resultOf(2)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(resultOf(3)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(messages.filter((message) => message.t === 'result' && message.id === 4)).toMatchObject([{ ok: false, error: { code: 'invalid' } }]);
    expect(docker.children).toHaveLength(1);
  });

  it('does not run an operation of the prototype chain of the operations', async () => {
    const { send, resultOf } = setup();
    send({ t: 'op', id: 1, op: 'constructor', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: false, error: { code: 'unknown' } });
  });

  it('cancels an operation: SIGTERM, SIGKILL after the grace time, then the removal of the containers of its cleanup label, then its result', async () => {
    const { send, docker, resultOf } = setup({ docker: fakeDocker({ respond: (args) => (args[0] === 'ps' ? { stdout: `${ID_1}\n`, exitCode: 0 } : undefined) }) });
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', '--label', `nimblescape.devenv.channel-step=${LABEL}`, 'img'], cleanup: LABEL } });
    send({ t: 'cancel', id: 1 });
    const [run] = docker.children;
    expect(run.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(CHANNEL_KILL_GRACE_MS);
    expect(run.signals).toEqual(['SIGTERM', 'SIGKILL']);
    // Review round 1 (S1): the containers of the label, then exactly those IDs; never a name.
    expect(docker.children[1].args).toEqual(PS_OF_LABEL);
    const remove = docker.children[2];
    expect(remove.args).toEqual(['rm', '-f', ID_1]);
    expect(resultOf(1)).toBeUndefined();
    remove.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toEqual({ t: 'result', id: 1, ok: false, error: { code: 'cancelled', message: 'The operation was cancelled.' }, cancelled: true, timedOut: false });
  });

  it('ends an operation at its time limit (timedOut) and removes its containers', async () => {
    const { send, docker, resultOf } = setup({ docker: fakeDocker({ endsOnTerm: true, respond: cleanupAnswers([ID_1, ID_2]) }) });
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', 'img'], cleanup: LABEL }, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(docker.children[0].signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(0);
    expect(docker.children.slice(1).map((child) => child.args)).toEqual([PS_OF_LABEL, ['rm', '-f', ID_1, ID_2]]);
    expect(resultOf(1)).toMatchObject({ ok: false, error: { code: 'timeout' }, cancelled: false, timedOut: true });
  });

  it('removes nothing when no container carries the cleanup label, and takes only container IDs from docker ps (review round 1, S1)', async () => {
    const { send, docker, resultOf } = setup({
      docker: fakeDocker({ endsOnTerm: true, respond: (args) => (args[0] === 'ps' ? { stdout: 'WARNING: something\n\n', exitCode: 0 } : undefined) }),
    });
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', '--name', 'abc123', 'img'], cleanup: LABEL } });
    send({ t: 'cancel', id: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(docker.children.slice(1).map((child) => child.args)).toEqual([PS_OF_LABEL]);
    expect(resultOf(1)).toMatchObject({ ok: false, cancelled: true });
  });

  it('refuses a cleanup that is a name instead of a label value', async () => {
    const { send, docker, resultOf } = setup();
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', 'img'], cleanup: ['n'] } });
    send({ t: 'op', id: 2, op: 'docker', params: { args: ['run', 'img'], cleanup: 'abc' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(docker.children).toHaveLength(0);
    expect(resultOf(1)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(resultOf(2)).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('removes no container when the operation ended by itself', async () => {
    const { send, docker, resultOf } = setup();
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', 'img'], cleanup: LABEL } });
    docker.children[0].exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toMatchObject({ ok: true });
    expect(docker.children).toHaveLength(1);
  });

  it('masks the secret before it cuts the last error line of the log (review round 1, S2)', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const { send, docker, of } = setup();
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['exec', '-i', 'c', 'cat'], inputIsSecret: true }, secret });
    // The secret spans the cut at 500 characters of the last line.
    docker.children[0].stderr(`${'x'.repeat(480)}${secret} failed\n`);
    docker.children[0].exit(1);
    await vi.advanceTimersByTimeAsync(0);
    const texts = of(1).filter((message) => message.t === 'log').map((message) => (message as { text: string }).text);
    expect(texts.join('\n')).not.toContain(secret.slice(0, 12));
    expect(texts[1]).toContain('***');
  });

  it('keeps at most MAX_CONTEXT_STDOUT_CHARACTERS of standard output and ends a call beyond (review round 1, S5)', async () => {
    let result: ContextDockerResult | undefined;
    const operations: Record<string, OperationHandler> = {
      read: async (_params, context) => {
        result = await context.docker(['logs', 'c']);
        return 'done';
      },
    };
    const { send, docker } = setup({ operations, docker: fakeDocker({ endsOnTerm: true }) });
    send({ t: 'op', id: 1, op: 'read', params: null });
    const [child] = docker.children;
    const piece = 'y'.repeat(1024 * 1024);
    for (let sent = 0; sent <= MAX_CONTEXT_STDOUT_CHARACTERS; sent += piece.length) child.stdout(piece);
    await vi.advanceTimersByTimeAsync(0);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(result?.stdout).toBe('');
    expect(result?.error).toMatch(/larger than 64 M characters/);
  });

  it('keeps only the end of the error output of a call (review round 1, S5)', async () => {
    let result: ContextDockerResult | undefined;
    const operations: Record<string, OperationHandler> = {
      build: async (_params, context) => {
        result = await context.docker(['build', '.']);
        return 'done';
      },
    };
    const { send, docker } = setup({ operations });
    send({ t: 'op', id: 1, op: 'build', params: null });
    const [child] = docker.children;
    for (let index = 0; index < 5; index++) child.stderr('z'.repeat(MAX_CONTEXT_STDERR_CHARACTERS / 2));
    child.stderr('the end');
    child.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(result?.stderr.length).toBe(MAX_CONTEXT_STDERR_CHARACTERS);
    expect(result?.stderr.endsWith('the end')).toBe(true);
  });

  it('reports the progress and the log lines of an operation and its failure', async () => {
    const operations: Record<string, OperationHandler> = {
      steps: async (_params, context) => {
        context.progress('Cloning', 'acme/api');
        context.log('a step with the secret s3cr3t-value', 'warn');
        throw new Error('it failed');
      },
    };
    const { send, of } = setup({ operations });
    send({ t: 'op', id: 1, op: 'steps', params: null, secret: 's3cr3t-value' });
    await vi.advanceTimersByTimeAsync(0);
    expect(of(1)).toEqual([
      { t: 'progress', id: 1, step: 'Cloning', detail: 'acme/api' },
      { t: 'log', id: 1, level: 'warn', text: 'a step with the secret ***' },
      { t: 'result', id: 1, ok: false, error: { code: 'failed', message: 'it failed' }, cancelled: false, timedOut: false },
    ]);
  });

  it('ends the Docker calls that an operation left running when it ended', async () => {
    const operations: Record<string, OperationHandler> = {
      leave: async (_params, context) => {
        void context.docker(['events']);
        return 'ok';
      },
    };
    const { send, docker, resultOf } = setup({ operations, docker: fakeDocker({ endsOnTerm: true }) });
    send({ t: 'op', id: 1, op: 'leave', params: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(docker.children[0].signals).toEqual(['SIGTERM']);
    expect(resultOf(1)).toEqual({ t: 'result', id: 1, ok: true, value: 'ok' });
  });

  describe('ends by itself when the connection is lost (user request 2026-09-28)', () => {
    it('at the end of its input: cancels what runs, removes its containers, then exits', async () => {
      const { server, send, docker, exits } = setup({ docker: fakeDocker({ respond: (args) => (args[0] === 'ps' ? { stdout: `${ID_1}\n`, exitCode: 0 } : undefined) }) });
      send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', 'img'], cleanup: LABEL } });
      server.inputEnded();
      expect(server.active).toBe(false);
      expect(docker.children[0].signals).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(CHANNEL_KILL_GRACE_MS);
      expect(docker.children[2].args).toEqual(['rm', '-f', ID_1]);
      expect(exits).toEqual([]);
      docker.children[2].exit(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(exits).toEqual([0]);
    });

    it('after CHANNEL_SILENCE_EXIT_MS without a message; each message starts the time again', async () => {
      const { send, exits } = setup();
      await vi.advanceTimersByTimeAsync(CHANNEL_SILENCE_EXIT_MS - 1_000);
      send({ t: 'ping', n: 1 });
      await vi.advanceTimersByTimeAsync(CHANNEL_SILENCE_EXIT_MS - 1_000);
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(exits).toEqual([0]);
    });

    it('after CHANNEL_SERVER_IDLE_EXIT_MS without an operation, even while pings come; not while one runs', async () => {
      const { send, docker, exits } = setup();
      send({ t: 'op', id: 1, op: 'docker', params: { args: ['build', '.'] } });
      for (let elapsed = 0; elapsed < CHANNEL_SERVER_IDLE_EXIT_MS + 60_000; elapsed += 15_000) {
        send({ t: 'ping', n: elapsed });
        await vi.advanceTimersByTimeAsync(15_000);
      }
      expect(exits).toEqual([]);
      docker.children[0].exit(0);
      for (let elapsed = 0; elapsed < CHANNEL_SERVER_IDLE_EXIT_MS; elapsed += 15_000) {
        send({ t: 'ping', n: elapsed });
        await vi.advanceTimersByTimeAsync(15_000);
      }
      expect(exits).toEqual([0]);
    });

    it('when its answers cannot be written anymore', async () => {
      let writable = true;
      const { send, exits } = setup({ writable: () => writable });
      writable = false;
      send({ t: 'ping', n: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(exits).toEqual([0]);
    });

    it('on a line that is too long', async () => {
      const { server, exits } = setup();
      server.input('x'.repeat(MAX_CLIENT_LINE + 1));
      await vi.advanceTimersByTimeAsync(0);
      expect(exits).toEqual([0]);
    });

    it('at a hard deadline even when a call does not end on SIGKILL', async () => {
      const docker = fakeDocker();
      const { server, send, exits } = setup({ docker });
      send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', 'img'] } });
      // This call ignores every signal.
      docker.children[0].kill = (signal) => docker.children[0].signals.push(signal);
      server.shutdown();
      await vi.advanceTimersByTimeAsync(CHANNEL_KILL_GRACE_MS + 60_000);
      expect(exits).toEqual([0]);
    });
  });
});

describe('the helpers of the server', () => {
  it('redact masks a secret of at least 4 characters', () => {
    expect(redact('a abcd b abcd', 'abcd')).toBe('a *** b ***');
    expect(redact('a abc', 'abc')).toBe('a abc');
    expect(redact('text', undefined)).toBe('text');
  });

  it('StreamRedactor holds back only a tail that can start the secret', () => {
    const out: string[] = [];
    const redactor = new StreamRedactor('secret', (text) => out.push(text));
    redactor.push('hello se');
    redactor.push('cret and s');
    redactor.push('omething');
    redactor.flush();
    expect(out.join('')).toBe('hello *** and something');
    expect(out[0]).toBe('hello ');
  });

  it('commandLine quotes arguments with spaces or quotes', () => {
    expect(commandLine(['ps', '--format', '{{json .}}', '', 'a"b'])).toBe('docker ps --format "{{json .}}" "" "a\\"b"');
  });
});
