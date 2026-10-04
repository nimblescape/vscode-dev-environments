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
  MAX_SERVER_LINE,
  OUTPUT_CHUNK_CHARACTERS,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from '../core/helperChannel/protocol';
import { REFRESH_ENVIRONMENTS, refreshFixture } from '../core/pipeline/refreshStates.testkit';
import { OPERATIONS } from './operations';
import {
  CLEANUP_SECOND_PASS_MS,
  ChannelServer,
  LATE_CANCEL_WINDOW_MS,
  OperationError,
  MAX_LOG_TEXT,
  MAX_CONTEXT_STDERR_CHARACTERS,
  MAX_CONTEXT_STDOUT_CHARACTERS,
  StreamRedactor,
  commandLine,
  MAX_LOGGED_SCRIPT_LENGTH,
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
type FakeAnswer = { stdout?: string; exitCode: number; /** Plan step 5, PR C. */ stderr?: string };

/** The answers of the cleanup: `docker ps` names `ids` (one per line), `docker rm` ends with 0. */
function cleanupAnswers(ids: string[]) {
  return (args: readonly string[]): FakeAnswer | undefined => {
    if (args[0] === 'ps') return { stdout: ids.map((id) => `${id}\n`).join(''), exitCode: 0 };
    if (args[0] === 'rm') return { exitCode: 0 };
    return undefined;
  };
}

// Review round 2 (B4): cleanup label values are 24 hex digits (newCleanupLabel).
const LABEL = '0a1b2c3d4e5f60718293a4b5';
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
            if (answer.stderr) onStderr(answer.stderr);
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
      // Review round 4 (M1): with the sweep of never-started channel containers.
      // Plan step 5, PR B: changed expectation: `lock` too.
      { t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: process.version, ops: ['batch', 'batchChunk', 'batchStep', 'delete', 'deleteCheck', 'docker', 'listConfigurations', 'lock', 'probe', 'pull', 'refresh', 'startContainers', 'stop', 'sweep', 'tokenRemove', 'windowState'] }, // plan step 5, PR C: `refresh`; plan step 6, PR B: changed expectation, the batch operations; plan step 10A: changed expectation, `pull` and `startContainers`; plan step 11B2: changed expectation, `stop`; plan step 11B3b: changed expectation, `listConfigurations`; plan step 11C1: changed expectation, `windowState`; plan step 11C2a: changed expectation, `delete`; plan step 11C2b: changed expectation, `deleteCheck`
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
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['exec', '-i', 'c', 'cat'], inputIsSecret: true }, secrets: { token: secret } });
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

  // Review round 1 of PR #89 (A-R1-4): the message of a failed operation can carry text of the engine or a registry.
  it('masks the secret in the error message of a failed operation', async () => {
    const secret = 'registry-PASSWORD-9';
    const { send, of } = setup({
      operations: {
        fails: async () => {
          throw new OperationError('failed', `the registry said: bad credentials ${secret}`);
        },
        throws: async () => {
          throw new Error(`raw ${secret}`);
        },
      },
    });
    send({ t: 'op', id: 1, op: 'fails', params: null, secrets: { token: secret } });
    send({ t: 'op', id: 2, op: 'throws', params: null, secrets: { token: secret } });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify([...of(1), ...of(2)])).not.toContain(secret);
    expect(of(1).at(-1)).toMatchObject({ t: 'result', ok: false, error: { code: 'failed', message: 'the registry said: bad credentials ***' } });
    expect(of(2).at(-1)).toMatchObject({ t: 'result', ok: false, error: { code: 'failed', message: 'raw ***' } });
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
    // Review round 2 (C3): a second look after CLEANUP_SECOND_PASS_MS, then the result.
    expect(resultOf(1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(CLEANUP_SECOND_PASS_MS);
    expect(docker.children[3].args).toEqual(PS_OF_LABEL);
    docker.children[4].exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(1)).toEqual({ t: 'result', id: 1, ok: false, error: { code: 'cancelled', message: 'The operation was cancelled.' }, cancelled: true, timedOut: false });
  });

  it('ends an operation at its time limit (timedOut) and removes its containers', async () => {
    const { send, docker, resultOf } = setup({ docker: fakeDocker({ endsOnTerm: true, respond: cleanupAnswers([ID_1, ID_2]) }) });
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', 'img'], cleanup: LABEL }, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(docker.children[0].signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(CLEANUP_SECOND_PASS_MS);
    // Review round 2 (C3): two passes.
    expect(docker.children.slice(1).map((child) => child.args)).toEqual([PS_OF_LABEL, ['rm', '-f', ID_1, ID_2], PS_OF_LABEL, ['rm', '-f', ID_1, ID_2]]);
    expect(resultOf(1)).toMatchObject({ ok: false, error: { code: 'timeout' }, cancelled: false, timedOut: true });
  });

  it('removes nothing when no container carries the cleanup label, and takes only container IDs from docker ps (review round 1, S1)', async () => {
    const { send, docker, resultOf } = setup({
      docker: fakeDocker({ endsOnTerm: true, respond: (args) => (args[0] === 'ps' ? { stdout: 'WARNING: something\n\n', exitCode: 0 } : undefined) }),
    });
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', '--name', 'abc123', 'img'], cleanup: LABEL } });
    send({ t: 'cancel', id: 1 });
    await vi.advanceTimersByTimeAsync(CLEANUP_SECOND_PASS_MS);
    expect(docker.children.slice(1).map((child) => child.args)).toEqual([PS_OF_LABEL, PS_OF_LABEL]);
    expect(resultOf(1)).toMatchObject({ ok: false, cancelled: true });
  });

  it('sweep prunes only stopped channel containers older than 10 minutes (review round 4, M1)', async () => {
    const { send, docker, resultOf } = setup({ docker: fakeDocker({ respond: () => ({ stdout: 'Deleted Containers:\nabc\n', exitCode: 0 }) }) });
    send({ t: 'op', id: 1, op: 'sweep', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(docker.children[0].args).toEqual(['container', 'prune', '-f', '--filter', 'label=nimblescape.devenv.helper-channel', '--filter', 'until=10m']);
    expect(resultOf(1)).toMatchObject({ ok: true, value: { output: 'Deleted Containers:\nabc' } });
  });

  it('refuses a cleanup that is a name instead of a label value', async () => {
    const { send, docker, resultOf } = setup();
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', 'img'], cleanup: ['n'] } });
    send({ t: 'op', id: 2, op: 'docker', params: { args: ['run', 'img'], cleanup: 'step-0a1b2c3d4e5f' } });
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

  it('removes the containers of an operation whose cancel crossed its result, within LATE_CANCEL_WINDOW_MS (review round 2, A1)', async () => {
    const { send, docker, messages } = setup({ docker: fakeDocker({ respond: cleanupAnswers([ID_1]) }) });
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', '-d', 'img'], cleanup: LABEL } });
    send({ t: 'op', id: 2, op: 'docker', params: { args: ['run', '-d', 'img'], cleanup: LABEL } });
    docker.children[0].exit(0);
    docker.children[1].exit(0);
    await vi.advanceTimersByTimeAsync(0);
    // The cancel of 1 comes after its result was sent.
    send({ t: 'cancel', id: 1 });
    await vi.advanceTimersByTimeAsync(CLEANUP_SECOND_PASS_MS);
    expect(docker.children.slice(2).map((child) => child.args)).toEqual([PS_OF_LABEL, ['rm', '-f', ID_1], PS_OF_LABEL, ['rm', '-f', ID_1]]);
    // Review round 4 (M2): the script confirms the cancel of an operation that had ended.
    expect(messages.filter((message) => message.t === 'cancelled')).toEqual([{ t: 'cancelled', id: 1 }]);
    // A second cancel of the same id, and a cancel of 2 after the window, remove nothing more.
    send({ t: 'cancel', id: 1 });
    await vi.advanceTimersByTimeAsync(LATE_CANCEL_WINDOW_MS);
    send({ t: 'cancel', id: 2 });
    await vi.advanceTimersByTimeAsync(CLEANUP_SECOND_PASS_MS);
    expect(docker.children).toHaveLength(6);
  });

  it('waits for the cleanup of a late cancel before it exits, also when the input ends right after it (review round 3, K1)', async () => {
    const { server, send, docker, exits } = setup({ docker: fakeDocker({ respond: cleanupAnswers([ID_1]) }) });
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['run', '-d', 'img'], cleanup: LABEL } });
    docker.children[0].exit(0);
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'cancel', id: 1 });
    server.inputEnded();
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(CLEANUP_SECOND_PASS_MS);
    expect(docker.children.slice(1).map((child) => child.args)).toEqual([PS_OF_LABEL, ['rm', '-f', ID_1], PS_OF_LABEL, ['rm', '-f', ID_1]]);
    expect(exits).toEqual([0]);
  });

  it('pauses the output of the calls while the answers wait to be written, and resumes it when they are (review round 2, A2)', async () => {
    let congested = false;
    let drain: (() => void) | undefined;
    const docker = fakeDocker();
    const paused: string[] = [];
    const messages: ServerMessage[] = [];
    const server = new ChannelServer({
      write: (text) => {
        for (const line of text.split('\n').filter((part) => part !== '')) messages.push(JSON.parse(line) as ServerMessage);
        return true;
      },
      spawnDocker: (args, onStdout, onStderr) => {
        const child = docker.spawn(args, onStdout, onStderr);
        child.pause = () => paused.push(`pause ${args[0]}`);
        child.resume = () => paused.push(`resume ${args[0]}`);
        return child;
      },
      operations: OPERATIONS,
      exit: () => {},
      congested: () => congested,
      onDrain: (listener) => (drain = listener),
    });
    server.start();
    server.input(encodeMessage({ t: 'op', id: 1, op: 'docker', params: { args: ['logs', 'c'] } }));
    congested = true;
    docker.children[0].stdout('lots of output');
    expect(paused).toEqual(['pause logs']);
    // A call that starts meanwhile starts paused.
    server.input(encodeMessage({ t: 'op', id: 2, op: 'docker', params: { args: ['events'] } }));
    expect(paused).toEqual(['pause logs', 'pause events']);
    congested = false;
    drain?.();
    expect(paused).toEqual(['pause logs', 'pause events', 'resume logs', 'resume events']);
    server.shutdown();
  });

  it('cuts a log line that would be longer than the extension reads, and fails a result that is too large (review round 2, C1)', async () => {
    const operations: Record<string, OperationHandler> = {
      big: async () => 'x'.repeat(MAX_SERVER_LINE),
    };
    const { send, of, docker } = setup({ operations: { ...OPERATIONS, ...operations } });
    const huge = Array.from({ length: 50 }, () => '\\'.repeat(40_000));
    send({ t: 'op', id: 1, op: 'docker', params: { args: huge } });
    docker.children[0].exit(0);
    send({ t: 'op', id: 2, op: 'big', params: null });
    await vi.advanceTimersByTimeAsync(0);
    const lines = of(1).filter((message) => message.t === 'log') as { text: string }[];
    expect(lines[0].text.length).toBeLessThanOrEqual(MAX_LOG_TEXT + 1);
    expect(lines[0].text.endsWith('…')).toBe(true);
    for (const message of [...of(1), ...of(2)]) expect(encodeMessage(message).length).toBeLessThanOrEqual(MAX_SERVER_LINE);
    expect(of(2)).toEqual([
      { t: 'result', id: 2, ok: false, error: { code: 'tooLarge', message: 'The result of the operation is too large for the helper channel.' }, cancelled: false, timedOut: false },
    ]);
  });

  it('masks the secret per streamed call, so the end of one call does not give out a part of the secret of another (review round 2, B1)', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz';
    const operations: Record<string, OperationHandler> = {
      two: async (_params, context) => {
        const first = context.docker(['logs', 'a'], { stream: true });
        const second = context.docker(['logs', 'b'], { stream: true });
        await Promise.all([first, second]);
        return null;
      },
    };
    const { send, docker, of } = setup({ operations });
    send({ t: 'op', id: 1, op: 'two', params: null, secrets: { token: secret } });
    await vi.advanceTimersByTimeAsync(0);
    const [a, b] = docker.children;
    a.stdout(`token ${secret.slice(0, 10)}`);
    b.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    a.stdout(`${secret.slice(10)} end\n`);
    a.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    const out = of(1)
      .filter((message) => message.t === 'out')
      .map((message) => (message as { data: string }).data)
      .join('');
    expect(out).toBe('token *** end\n');
  });

  it('masks the kept error output before it is cut, so a cut cannot leave a part of the secret (review round 2, B2)', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz';
    let result: ContextDockerResult | undefined;
    const operations: Record<string, OperationHandler> = {
      build: async (_params, context) => {
        result = await context.docker(['build', '.']);
        return null;
      },
    };
    const { send, docker, of } = setup({ operations });
    send({ t: 'op', id: 1, op: 'build', params: null, secrets: { token: secret } });
    await vi.advanceTimersByTimeAsync(0);
    const [child] = docker.children;
    // One line without a line feed; the secret lies where the kept end would begin.
    child.stderr('y'.repeat(MAX_CONTEXT_STDERR_CHARACTERS));
    child.stderr(secret);
    child.stderr('z'.repeat(MAX_CONTEXT_STDERR_CHARACTERS - 10));
    child.exit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(result?.stderr).not.toContain(secret.slice(-8));
    expect(JSON.stringify(of(1))).not.toContain(secret.slice(-8));
  });

  it('masks the secret before it cuts the last error line of the log (review round 1, S2)', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const { send, docker, of } = setup();
    send({ t: 'op', id: 1, op: 'docker', params: { args: ['exec', '-i', 'c', 'cat'], inputIsSecret: true }, secrets: { token: secret } });
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
    send({ t: 'op', id: 1, op: 'steps', params: null, secrets: { token: 's3cr3t-value' } });
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
      // Review round 2 (C3): the second pass of the cleanup comes first.
      await vi.advanceTimersByTimeAsync(CLEANUP_SECOND_PASS_MS);
      expect(exits).toEqual([]);
      docker.children[4].exit(0);
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

    // Review round 5 (F3): a long request on a slow link: its pieces arrive, the pings wait behind it.
    it('not while the pieces of a long request arrive; after CHANNEL_SILENCE_EXIT_MS without any', async () => {
      const { server, send, exits, resultOf } = setup();
      const line = encodeMessage({ t: 'op', id: 1, op: 'probe', params: { pad: 'x'.repeat(4_000) } });
      for (let start = 0; start < line.length - 1; start += 100) {
        server.input(line.slice(start, Math.min(start + 100, line.length - 1)));
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(exits).toEqual([]);
      server.input('\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(resultOf(1)).toBeDefined();
      send({ t: 'ping', n: 1 });
      server.input('{"t":"pi');
      await vi.advanceTimersByTimeAsync(CHANNEL_SILENCE_EXIT_MS);
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

  // Live check of 2026-10-03: a long script is `<script>` in the log line, as in the batch helper.
  it('commandLine shows a script of more than one line or more than MAX_LOGGED_SCRIPT_LENGTH characters as <script>', () => {
    const long = 'x'.repeat(MAX_LOGGED_SCRIPT_LENGTH + 1);
    expect(commandLine(['exec', '-i', 'c', 'sh', '-c', 'set -eu\necho hi', 'sh', 'dev'])).toBe('docker exec -i c sh -c <script> sh dev');
    expect(commandLine(['run', 'img', 'node', '-e', long, '/opt/x.js'])).toBe('docker run img node -e <script> /opt/x.js');
    expect(commandLine(['exec', 'c', '/bin/sh', '-c', long])).toBe('docker exec c /bin/sh -c <script>');
    // A short one-line script stays, and so does a long argument that is no script.
    expect(commandLine(['exec', 'c', 'sh', '-c', 'echo hi'])).toBe('docker exec c sh -c "echo hi"');
    expect(commandLine(['exec', 'c', 'cat', long])).toBe(`docker exec c cat ${long}`);
    expect(commandLine(['exec', '-e', long, 'c', 'true'])).toBe(`docker exec -e ${long} c true`);
    expect(commandLine(['run', 'x'.repeat(MAX_LOGGED_SCRIPT_LENGTH)])).toBe(`docker run ${'x'.repeat(MAX_LOGGED_SCRIPT_LENGTH)}`);
  });
});

describe('the refresh operation over the fake Docker CLI (plan step 5, PR C)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function refresh(params: unknown, secret?: string) {
    const docker = fakeDocker({ respond: (args) => refreshFixture(args) });
    const ctx = setup({ docker });
    ctx.send(secret === undefined ? { t: 'op', id: 1, op: 'refresh', params } : { t: 'op', id: 1, op: 'refresh', params, secrets: { token: secret } });
    for (let round = 0; round < 200 && ctx.resultOf(1) === undefined; round++) await vi.advanceTimersByTimeAsync(0);
    return { result: ctx.resultOf(1), docker, messages: ctx.messages };
  }

  it('ends one call when its own signal aborts (the time limit of a call of the refresh)', async () => {
    const docker = fakeDocker({ endsOnTerm: true });
    const ctx = setup({
      docker,
      operations: {
        one: async (_params, context) => {
          const controller = new AbortController();
          const call = context.docker(['ps'], { signal: controller.signal });
          controller.abort();
          return (await call).exitCode;
        },
      },
    });
    ctx.send({ t: 'op', id: 1, op: 'one', params: null });
    for (let round = 0; round < 50 && ctx.resultOf(1) === undefined; round++) await vi.advanceTimersByTimeAsync(0);
    expect(docker.children[0].signals).toEqual(['SIGTERM']);
    expect(ctx.resultOf(1)).toMatchObject({ ok: true, value: null });
  });

  it('refuses invalid parameters and a secret, and calls no Docker', async () => {
    const env = REFRESH_ENVIRONMENTS[0];
    for (const params of [
      null,
      {},
      { environments: [{ ...env, extra: 1 }] },
      { environments: [env, env] },
      { environments: [{ ...env, containerName: '-e' }] },
    ]) {
      const { result, docker } = await refresh(params);
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
      expect(docker.children).toHaveLength(0);
    }
    const { result, docker, messages } = await refresh({ environments: [env] }, 'ghp_secret_value');
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(docker.children).toHaveLength(0);
    expect(JSON.stringify(messages)).not.toContain('ghp_secret_value');
  });
});
