// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1: the port `DockerEngine` over the Engine API, against a real HTTP server on a Unix socket (as the
// engine answers: JSON for the requests, a hijacked connection with framed output for an exec).
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineError, isMissing, type DockerEngine } from '../core/worker/dockerEngine';
import { MIN_SECRET_LENGTH, SECRET_TOKEN } from '../core/helperChannel/protocol';
import { scriptCommand } from '../core/worker/containerScripts';
import { engineApi, engineHijack, MAX_ENGINE_FRAME_BYTES, type EngineAnswer, type EngineApi, type EngineRequest } from './engineApi';
import { dockerEngine, MAX_EXEC_OUTPUT_CHARACTERS } from './engineClient';

interface Call {
  method: string;
  url: string;
  body: string;
}

/** A frame of the engine: the stream, three zero bytes, the length, the data. */
function frame(stream: 1 | 2, text: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

const INSPECT = {
  Id: 'c0ffee'.repeat(10) + 'c0ff',
  Name: '/devenv-acme-api-brave-noether',
  Created: '2026-10-03T19:00:00.000Z',
  RestartCount: 2,
  State: { Status: 'running', Running: true, Paused: false, ExitCode: 0 },
  Config: { Labels: { 'nimblescape.devenv.environment-id': 'e1' }, Image: 'devenv-acme-api-brave-noether:1' },
  Image: 'sha256:' + 'a'.repeat(64),
  Mounts: [
    { Type: 'volume', Name: 'devenv-acme-api-brave-noether' },
    // Review round 1 of plan step 11B1 (B-R1-20): only the mounts of the type volume, whatever else has a name.
    { Type: 'bind', Name: 'not-a-volume', Source: '/tmp' },
    { Type: 'tmpfs', Name: 'not-a-volume-either' },
  ],
};

describe('the port of the engine over the Engine API (plan step 11B1)', () => {
  const servers: http.Server[] = [];
  const sockets: net.Socket[] = [];
  // Review round 3 of plan step 11B1 (A-R3-4): every folder of a test, not only the last one.
  const folders: string[] = [];
  let folder: string | undefined;

  afterEach(async () => {
    // The hijacked connections stay open until the test ends them.
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const each of folders.splice(0)) fs.rmSync(each, { recursive: true, force: true });
    folder = undefined;
  });

  /** An engine whose requests `answer` serves; an exec is served over a hijacked connection by `exec`. */
  async function serve(
    answer: (call: Call) => { status: number; json?: unknown; body?: string } | undefined,
    exec?: (socket: net.Socket, input: Buffer) => void,
    more: {
      /** Written in the same write as the answer 101 (review round 1 of 11B1, A-R1-1, B-R1-3). */
      withUpgrade?: Buffer;
      /** Called at once after the upgrade, before the input ended. */
      onUpgrade?: (socket: net.Socket) => void;
      /** The status of an exec start that the engine does not upgrade (review round 1 of 11B1, A-R1-10, B-R1-9). */
      refuse?: { status: number; json: unknown };
      secrets?: Record<string, string>;
      /** Plan step 11E1: the values to mask, when not those of `secrets`. */
      masked?: string[];
    } = {},
  ): Promise<{ engine: DockerEngine; calls: Call[] }> {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-engine-'));
    folders.push(folder);
    const socketPath = path.join(folder, 'docker.sock');
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const call = { method: req.method ?? '', url: req.url ?? '', body };
        calls.push(call);
        const given = answer(call);
        // No answer: the engine hangs.
        if (given === undefined) return;
        res.writeHead(given.status, { 'Content-Type': 'application/json' });
        res.end(given.json !== undefined ? JSON.stringify(given.json) : (given.body ?? ''));
      });
    });
    // The hijacked start of an exec: the engine answers 101 and the connection carries the streams.
    server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
      sockets.push(socket);
      // As the engine does: the body of the request comes before the stream, so it is not input of the process.
      const length = Number(req.headers['content-length'] ?? 0);
      calls.push({ method: 'POST', url: req.url ?? '', body: head.subarray(0, length).toString('utf8') });
      if (more.refuse !== undefined) {
        const body = JSON.stringify(more.refuse.json);
        socket.end(`HTTP/1.1 ${more.refuse.status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        return;
      }
      const upgrade = Buffer.from('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      socket.write(more.withUpgrade === undefined ? upgrade : Buffer.concat([upgrade, more.withUpgrade]));
      more.onUpgrade?.(socket);
      let input = head.subarray(length);
      socket.on('data', (chunk: Buffer) => (input = Buffer.concat([input, chunk])));
      socket.on('end', () => exec?.(socket, input));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const secrets = more.secrets ?? {};
    // Plan step 11E1: every secret of the operation is masked in the output of an exec (OperationContext.maskedValues).
    return { engine: dockerEngine(engineApi(socketPath), engineHijack(socketPath), (name) => secrets[name], () => more.masked ?? Object.values(secrets)), calls };
  }

  it('reads a container with its state, labels, image and volumes; a missing one is undefined', async () => {
    const { engine, calls } = await serve((call) => (call.url.includes('missing') ? { status: 404, json: { message: 'No such container' } } : { status: 200, json: INSPECT }));
    expect(await engine.container('devenv-acme-api-brave-noether')).toEqual({
      id: INSPECT.Id,
      name: 'devenv-acme-api-brave-noether',
      state: 'running',
      rawState: 'running',
      exitCode: 0,
      restartCount: 2,
      labels: { 'nimblescape.devenv.environment-id': 'e1' },
      image: 'devenv-acme-api-brave-noether:1',
      imageId: INSPECT.Image,
      volumes: ['devenv-acme-api-brave-noether'],
      created: '2026-10-03T19:00:00.000Z',
    });
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/containers/devenv-acme-api-brave-noether/json' });
    expect(await engine.container('missing')).toBeUndefined();
  });

  it('a paused container counts as running, a stopped one as stopped', async () => {
    const { engine } = await serve((call) => ({
      status: 200,
      json: call.url.includes('paused')
        ? { ...INSPECT, State: { Status: 'paused', Running: false, Paused: true } }
        : { ...INSPECT, State: { Status: 'exited', Running: false, Paused: false, ExitCode: 137 } },
    }));
    expect(await engine.container('paused')).toMatchObject({ state: 'running', rawState: 'paused' });
    expect(await engine.container('other')).toMatchObject({ state: 'stopped', rawState: 'exited', exitCode: 137 });
  });

  it('lists the containers of a label and inspects each one; one that is gone is left out', async () => {
    const { engine, calls } = await serve((call) =>
      call.url.startsWith('/containers/json')
        ? { status: 200, json: [{ Id: 'a'.repeat(64) }, { Id: 'b'.repeat(64) }, { noId: true }] }
        : call.url.includes('b'.repeat(64))
          ? { status: 404, json: { message: 'No such container' } }
          : { status: 200, json: INSPECT },
    );
    const found = await engine.containers('nimblescape.devenv.environment-id=e1');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(INSPECT.Id);
    expect(decodeURIComponent(calls[0].url)).toBe('/containers/json?all=true&filters={"label":["nimblescape.devenv.environment-id=e1"]}');
  });

  it('runs a process in a container: its output by stream, its exit code, and its input on the connection', async () => {
    const { engine, calls } = await serve(
      (call) => (call.url.endsWith('/exec') ? { status: 201, json: { Id: 'exec-1' } } : { status: 200, json: { ExitCode: 3, Running: false } }),
      (socket, input) => {
        socket.write(frame(1, `in:${input.toString('utf8')}`));
        socket.write(frame(2, 'a warning'));
        socket.end();
      },
    );
    const output: string[] = [];
    const result = await engine.exec('c1', ['sh', '-c', 'cat'], { user: 'root', workdir: '/w', input: 'hello', onOutput: (stream, text) => output.push(`${stream}:${text}`) });
    expect(result).toEqual({ exitCode: 3, stdout: 'in:hello', stderr: 'a warning', timedOut: false });
    expect(output).toEqual(['stdout:in:hello', 'stderr:a warning']);
    expect(JSON.parse(calls[0].body)).toEqual({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: ['sh', '-c', 'cat'], User: 'root', WorkingDir: '/w' });
    expect(calls.map((call) => call.url)).toEqual(['/containers/c1/exec', '/exec/exec-1/start', '/exec/exec-1/json']);
  });

  it('ends a process at its time limit and reports what it wrote until then', async () => {
    const { engine } = await serve(
      (call) => (call.url.endsWith('/exec') ? { status: 201, json: { Id: 'exec-1' } } : { status: 200, json: { ExitCode: 0, Running: false } }),
      (socket) => {
        socket.write(frame(1, 'started'));
        // Never ends: the time limit of the call must end it.
      },
    );
    const result = await engine.exec('c1', ['sleep', '60'], { timeoutMs: 50 });
    expect(result).toMatchObject({ exitCode: null, timedOut: true, stdout: 'started' });
  });

  it('stops and starts a container; 304 (nothing to do) is no failure', async () => {
    const { engine, calls } = await serve((call) => ({ status: call.url.includes('stop') ? 204 : 304 }));
    await engine.stop('c1', 20);
    await engine.start('c1');
    // Plan step 11B2 (review round 1, B-R1-6, B-R1-7): without a time, the container's own stop time (no query).
    await engine.stop('c1');
    expect(calls.map((call) => call.url)).toEqual(['/containers/c1/stop?t=20', '/containers/c1/start', '/containers/c1/stop']);
    // Review round 1 of plan step 11B1 (B-R1-13): a stop of a container that does not run, and a missing one.
    const nothing = await serve(() => ({ status: 304 }));
    await nothing.engine.stop('c1', 20);
    const missing = await serve(() => ({ status: 404, json: { message: 'No such container' } }));
    for (const call of [missing.engine.stop('c1', 20), missing.engine.start('c1')]) {
      const thrown = await call.catch((error: unknown) => error);
      expect(isMissing(thrown)).toBe(true);
    }
  });

  it('throws an EngineError with the message of the engine and its status', async () => {
    const { engine } = await serve(() => ({ status: 500, json: { message: 'the daemon is busy' } }));
    for (const call of [engine.container('c1'), engine.containers('label'), engine.stop('c1', 10), engine.start('c1'), engine.exec('c1', ['true'])]) {
      const thrown = await call.catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(EngineError);
      expect(thrown).toMatchObject({ message: 'the daemon is busy', status: 500 });
    }
  });

  it('throws when the engine answers an inspect or an exec create with something it cannot read', async () => {
    const empty = await serve(() => ({ status: 200, body: 'not json' }));
    await expect(empty.engine.container('c1')).rejects.toBeInstanceOf(EngineError);
    const noId = await serve((call) => (call.url.endsWith('/exec') ? { status: 201, json: {} } : { status: 200, json: [] }));
    await expect(noId.engine.exec('c1', ['true'])).rejects.toThrow(/invalid value/);
  });

  it('a cancel ends the call with an AbortError', async () => {
    const { engine } = await serve(
      (call) => (call.url.endsWith('/exec') ? { status: 201, json: { Id: 'exec-1' } } : { status: 200, json: { ExitCode: 0, Running: false } }),
      () => {
        // Never answers.
      },
    );
    const controller = new AbortController();
    const running = engine.exec('c1', ['sleep', '60'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    const aborted = new AbortController();
    aborted.abort();
    await expect(engine.container('c1', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  /** An engine whose exec create and inspect succeed (exit code 0, ended), with the exec served by `exec`. */
  const execAnswers = (inspect: unknown = { ExitCode: 0, Running: false }) => (call: Call) =>
    call.url.endsWith('/exec') ? { status: 201, json: { Id: 'exec-1' } } : { status: 200, json: inspect };

  it('hands on the output that came with the answer 101 (review round 1 of 11B1, A-R1-1, B-R1-3)', async () => {
    const output: string[] = [];
    const { engine } = await serve(execAnswers(), (socket) => socket.end(), { withUpgrade: Buffer.concat([frame(1, 'early'), frame(2, 'warning')]) });
    const result = await engine.exec('c1', ['true'], { onOutput: (stream, text) => output.push(`${stream}:${text}`) });
    expect(result).toEqual({ exitCode: 0, stdout: 'early', stderr: 'warning', timedOut: false });
    expect(output).toEqual(['stdout:early', 'stderr:warning']);
  });

  it('puts together frames that come in pieces, and characters split between frames (review round 1, B-R1-2, A-R1-13)', async () => {
    const whole = Buffer.concat([frame(1, 'hello world'), frame(2, 'e'), frame(1, '!')]);
    const euro = Buffer.from('€', 'utf8');
    const { engine } = await serve(execAnswers(), (socket) => {
      // The header in two pieces, then the data byte by byte, then a character split between two frames.
      const pieces = [whole.subarray(0, 3), whole.subarray(3, 8), ...[...whole.subarray(8)].map((byte) => Buffer.from([byte]))];
      for (const piece of pieces) socket.write(piece);
      const first = Buffer.alloc(8 + 2);
      first[0] = 1;
      first.writeUInt32BE(2, 4);
      euro.copy(first, 8, 0, 2);
      const second = Buffer.alloc(8 + 1);
      second[0] = 1;
      second.writeUInt32BE(1, 4);
      euro.copy(second, 8, 2, 3);
      socket.write(first);
      socket.end(second);
    });
    const output: string[] = [];
    const result = await engine.exec('c1', ['true'], { onOutput: (stream, text) => output.push(`${stream}:${text}`) });
    expect(result).toMatchObject({ stdout: 'hello world!€', stderr: 'e' });
    expect(output.join('')).not.toContain('\uFFFD');
  });

  it('fails when the output is not framed, a frame is too long, or the output ends in the middle of a frame (review round 1, A-R1-12, B-R1-10, B-R1-11)', async () => {
    const half = frame(1, 'hello').subarray(0, 10);
    const tooLong = Buffer.alloc(8);
    tooLong[0] = 1;
    tooLong.writeUInt32BE(MAX_ENGINE_FRAME_BYTES + 1, 4);
    for (const [written, message] of [
      [Buffer.from('plain terminal output'), 'not framed'],
      [tooLong, `a frame of ${MAX_ENGINE_FRAME_BYTES + 1} bytes`],
      [half, 'in the middle of a frame'],
    ] as const) {
      const { engine } = await serve(execAnswers(), (socket) => socket.end(written));
      await expect(engine.exec('c1', ['true'])).rejects.toThrow(message);
    }
  });

  it('fails when the connection breaks, never as a clean end (review round 1, A-R1-2)', async () => {
    const { engine, calls } = await serve(execAnswers(), undefined, {
      onUpgrade: (socket) => {
        // A Unix socket cannot be reset: the engine goes away in the middle of a frame.
        socket.write(Buffer.concat([frame(1, 'started'), frame(1, 'more').subarray(0, 9)]));
        setTimeout(() => socket.destroy(), 10);
      },
    });
    await expect(engine.exec('c1', ['true'])).rejects.toThrow();
    // The inspect is never asked after a broken connection.
    expect(calls.some((call) => call.url.endsWith('/json') && call.url.startsWith('/exec/'))).toBe(false);
  });

  it('fails when the process still runs after its output ended, and when the inspect fails (review round 1, A-R1-2, B-R1-14)', async () => {
    const running = await serve(execAnswers({ ExitCode: 0, Running: true }), (socket) => socket.end());
    await expect(running.engine.exec('c1', ['true'])).rejects.toThrow('the process did not');
    const failing = await serve(
      (call) => (call.url.endsWith('/exec') ? { status: 201, json: { Id: 'exec-1' } } : { status: 500, json: { message: 'the daemon is busy' } }),
      (socket) => socket.end(),
    );
    await expect(failing.engine.exec('c1', ['true'])).rejects.toMatchObject({ name: 'EngineError', status: 500, message: 'the daemon is busy' });
    const noCode = await serve(execAnswers({ Running: false }), (socket) => socket.end());
    expect(await noCode.engine.exec('c1', ['true'])).toMatchObject({ exitCode: null, timedOut: false });
  });

  it('refuses an exec start that the engine does not upgrade, with its message and status (review round 1, A-R1-10, A-R1-20, B-R1-9)', async () => {
    for (const status of [409, 200]) {
      const { engine } = await serve(execAnswers(), undefined, { refuse: { status, json: { message: 'the container is paused' } } });
      const thrown = await engine.exec('c1', ['true']).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(EngineError);
      expect(thrown).toMatchObject({ message: 'the container is paused', status });
    }
  });

  it('gives the secret that the operation holds as the standard input, never in a request (review round 1, A-R1-3, B-R1-8)', async () => {
    const { engine, calls } = await serve(
      execAnswers(),
      (socket, input) => {
        // Changed (plan step 11E1, review round 1 of PR #102): the output of an exec masks every secret, so the engine
        // answers whether the input was the secret (before: it echoed the input, and the test read the token in stdout).
        socket.end(frame(1, `in:${input.toString('utf8') === 'ghp_value'}`));
      },
      { secrets: { [SECRET_TOKEN]: 'ghp_value' } },
    );
    const result = await engine.exec('c1', scriptCommand('tokenWrite', ['dev', 'octocat']), { user: 'root', secretInputName: SECRET_TOKEN });
    expect(result.stdout).toBe('in:true');
    expect(JSON.parse(calls[0].body)).toMatchObject({ AttachStdin: true });
    expect(JSON.stringify(calls)).not.toContain('ghp_value');
    // A secret that the operation does not hold is a failure, never an empty input.
    const none = await serve(execAnswers(), (socket) => socket.end());
    await expect(none.engine.exec('c1', ['cat'], { secretInputName: SECRET_TOKEN })).rejects.toThrow(`holds no secret ${SECRET_TOKEN}`);
    expect(none.calls).toEqual([]);
  });

  it('ends at its time limit also when the operation gives its cancel signal (review round 1, B-R1-1)', async () => {
    const { engine } = await serve(execAnswers(), () => {
      // Never ends.
    });
    const started = Date.now();
    const result = await engine.exec('c1', ['sleep', '60'], { signal: new AbortController().signal, timeoutMs: 50 });
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('the time limit covers the create of the exec and its inspect (review round 1, A-R1-4)', async () => {
    const hangingCreate = await serve(() => undefined);
    expect(await hangingCreate.engine.exec('c1', ['true'], { timeoutMs: 50 })).toMatchObject({ timedOut: true, exitCode: null });
    const hangingInspect = await serve((call) => (call.url.endsWith('/exec') ? { status: 201, json: { Id: 'exec-1' } } : undefined), (socket) => socket.end(frame(1, 'done')));
    expect(await hangingInspect.engine.exec('c1', ['true'], { timeoutMs: 200 })).toMatchObject({ timedOut: true, exitCode: null, stdout: 'done' });
  });

  it('keeps at most MAX_EXEC_OUTPUT_CHARACTERS of a stream, and hands all of it to onOutput (review round 1, A-R1-14)', async () => {
    const big = 'x'.repeat(MAX_EXEC_OUTPUT_CHARACTERS + 10);
    const { engine } = await serve(execAnswers(), (socket) => socket.end(frame(1, big)));
    let seen = 0;
    const result = await engine.exec('c1', ['true'], { onOutput: (_stream, text) => (seen += text.length) });
    expect(result.stdout).toHaveLength(MAX_EXEC_OUTPUT_CHARACTERS);
    expect(seen).toBe(big.length);
  });

  it('plan step 11E (review round 2 of 11B1, A-R2-4): masks the secret of the input before the cut of each stream', async () => {
    const secret = 'ghp_' + 'S'.repeat(36);
    // The secret starts 10 characters before the limit, so a plain cut would keep its first 10 characters.
    const before = 'a'.repeat(MAX_EXEC_OUTPUT_CHARACTERS - 10);
    const { engine } = await serve(execAnswers(), (socket) => socket.end(Buffer.concat([frame(1, before), frame(1, `${secret}tail`), frame(2, `${secret} on stderr`)])), {
      secrets: { [SECRET_TOKEN]: secret },
    });
    const result = await engine.exec('c1', ['cat'], { secretInputName: SECRET_TOKEN });
    // Masked, the stream is shorter than the limit: nothing of it is cut.
    expect(result.stdout).toBe(`${before}***tail`);
    expect(result.stdout).not.toContain('ghp_');
    expect(result.stderr).toBe('*** on stderr');
    // Without a secret input, nothing is masked and the cut is as before.
    const plain = await serve(execAnswers(), (socket) => socket.end(Buffer.concat([frame(1, before), frame(1, `${secret}tail`)])));
    expect((await plain.engine.exec('c1', ['cat'])).stdout).toBe(`${before}${secret}`.slice(0, MAX_EXEC_OUTPUT_CHARACTERS));
  });

  it('review round 1 of PR #102 (A-H1): a repeated secret, the second one across the cut, leaves no part of itself', async () => {
    const secret = 'ghp_' + 'R'.repeat(36);
    // The second secret starts after the limit of the raw text, and its mask crosses the limit of the kept one.
    const padding = 'p'.repeat(MAX_EXEC_OUTPUT_CHARACTERS - 5);
    const { engine } = await serve(execAnswers(), (socket) => socket.end(Buffer.concat([frame(1, `${secret}\n`), frame(1, padding), frame(1, `${secret}tail`)])), {
      secrets: { [SECRET_TOKEN]: secret },
    });
    const seen: string[] = [];
    const result = await engine.exec('c1', ['cat'], { secretInputName: SECRET_TOKEN, onOutput: (_stream, text) => seen.push(text) });
    expect(result.stdout).toBe(`***\n${padding}***tail`.slice(0, MAX_EXEC_OUTPUT_CHARACTERS));
    expect(result.stdout).not.toContain('ghp_');
    // onOutput gets the masked output only, all of it.
    expect(seen.join('')).toBe(`***\n${padding}***tail`);
    // A secret repeated so often that the masked text is far shorter than the limit.
    const many = await serve(execAnswers(), (socket) => socket.end(frame(1, secret.repeat(30_000))), { secrets: { [SECRET_TOKEN]: secret } });
    expect((await many.engine.exec('c1', ['cat'], { secretInputName: SECRET_TOKEN })).stdout).toBe('***'.repeat(30_000));
  });

  it('review round 1 of PR #102 (A-M1): masks every secret of the operation, with and without a secret input, also across frames', async () => {
    const registry = 'registry-password-' + 'Q'.repeat(20);
    const token = 'ghp_' + 'T'.repeat(36);
    const before = 'b'.repeat(MAX_EXEC_OUTPUT_CHARACTERS - 8);
    const output = Buffer.concat([frame(1, before), frame(1, registry.slice(0, 5)), frame(1, `${registry.slice(5)} and ${token.slice(0, 10)}`), frame(1, token.slice(10)), frame(2, `${token}!`)]);
    // Without a secret input: the secrets of the operation.
    const plain = await serve(execAnswers(), (socket) => socket.end(output), { masked: [registry, token] });
    const result = await plain.engine.exec('c1', ['env']);
    expect(result.stdout).toBe(`${before}*** and ***`.slice(0, MAX_EXEC_OUTPUT_CHARACTERS));
    expect(result.stderr).toBe('***!');
    for (const text of [result.stdout, result.stderr]) {
      expect(text).not.toContain('registry-pa');
      expect(text).not.toContain('ghp_');
    }
    // With the token as the input, the registry password of the operation is masked too.
    const withInput = await serve(execAnswers(), (socket) => socket.end(output), { secrets: { [SECRET_TOKEN]: token }, masked: [registry] });
    expect((await withInput.engine.exec('c1', ['cat'], { secretInputName: SECRET_TOKEN })).stdout).toBe(`${before}*** and ***`.slice(0, MAX_EXEC_OUTPUT_CHARACTERS));
  });

  it('review round 2 of PR #102 (A-M1): a frame that ends inside a secret, then the time limit, leaves no part of it', async () => {
    const token = 'ghp_' + 'Z'.repeat(36);
    const { engine } = await serve(execAnswers(), (socket) => {
      // The rest of the token never comes.
      socket.write(frame(1, `start ${token.slice(0, 39)}`));
      socket.write(frame(2, `err ${token.slice(0, 20)}`));
    }, { masked: [token] });
    const seen: string[] = [];
    const result = await engine.exec('c1', ['cat'], { timeoutMs: 300, onOutput: (_stream, text) => seen.push(text) });
    expect(result).toMatchObject({ timedOut: true, stdout: 'start ***', stderr: 'err ***' });
    for (const text of [result.stdout, result.stderr, seen.join('')]) {
      for (let at = 0; at + MIN_SECRET_LENGTH <= token.length; at++) expect(text).not.toContain(token.slice(at, at + MIN_SECRET_LENGTH));
    }
  });

  it('ends the exec when onOutput throws, never the process (review round 2, A-R2-1)', async () => {
    const { engine } = await serve(execAnswers(), (socket) => socket.end(frame(1, 'x')));
    await expect(
      engine.exec('c1', ['true'], {
        onOutput: () => {
          throw new Error('the listener broke');
        },
      }),
    ).rejects.toThrow('the listener broke');
  });

  it('a cancel while the output streams ends the exec with an AbortError (review round 2, missing test 1)', async () => {
    const { engine } = await serve(execAnswers(), undefined, { onUpgrade: (socket) => socket.write(frame(1, 'started')) });
    const controller = new AbortController();
    const output: string[] = [];
    const running = engine.exec('c1', ['sleep', '60'], { signal: controller.signal, onOutput: (_stream, text) => (output.push(text), controller.abort()) });
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(output).toEqual(['started']);
  });

  it('rejects without an uncaught error when the engine goes away while the input is written (review round 2, B-R2-6)', async () => {
    const { engine } = await serve(execAnswers(), undefined, { onUpgrade: (socket) => socket.destroy() });
    await expect(engine.exec('c1', ['cat'], { input: 'x'.repeat(8 * 1024 * 1024) })).rejects.toThrow();
  });

  it('rejects a hijack to a socket that does not exist, and one that is cancelled before it starts (review round 2, B-R2-7, B-R2-17)', async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-engine-'));
    folders.push(folder);
    await expect(engineHijack(path.join(folder, 'missing.sock'))({ path: '/exec/x/start', json: {}, onFrame: () => {} })).rejects.toThrow();
    const { calls } = await serve(execAnswers());
    const aborted = new AbortController();
    aborted.abort();
    await expect(engineHijack(path.join(folder, 'docker.sock'))({ path: '/exec/x/start', json: {}, onFrame: () => {}, signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });

  it('fails the list when the inspect of a listed container fails (review round 2, B-R2-8)', async () => {
    const { engine } = await serve((call) => (call.url.startsWith('/containers/json') ? { status: 200, json: [{ Id: 'a'.repeat(64) }] } : { status: 500, json: { message: 'the daemon is busy' } }));
    await expect(engine.containers('label')).rejects.toMatchObject({ name: 'EngineError', status: 500 });
  });

  it('refuses a header with padding or stream 0, and a frame of exactly the cap is accepted (review round 2, B-R2-12, B-R2-13)', async () => {
    for (const header of [[1, 1, 0, 0], [1, 0, 0, 1], [0, 0, 0, 0]]) {
      const bad = Buffer.concat([Buffer.from(header), Buffer.from([0, 0, 0, 1]), Buffer.from('x')]);
      const { engine } = await serve(execAnswers(), (socket) => socket.end(bad));
      await expect(engine.exec('c1', ['true']), JSON.stringify(header)).rejects.toThrow('not framed');
    }
    const atCap = Buffer.alloc(8);
    atCap[0] = 1;
    atCap.writeUInt32BE(MAX_ENGINE_FRAME_BYTES, 4);
    const { engine } = await serve(execAnswers(), (socket) => socket.end(atCap));
    await expect(engine.exec('c1', ['true'])).rejects.toThrow('in the middle of a frame');
  });

  it('caps the whole stream, keeps a decoder per stream, and flushes a cut character (review round 2, B-R2-14, B-R2-15)', async () => {
    const euro = Buffer.from('€', 'utf8');
    const raw = (stream: 1 | 2, data: Buffer) => {
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(data.length, 4);
      return Buffer.concat([header, data]);
    };
    const mixed = await serve(execAnswers(), (socket) =>
      socket.end(Buffer.concat([raw(1, euro.subarray(0, 1)), raw(2, Buffer.from('e')), raw(1, euro.subarray(1)), raw(2, euro.subarray(0, 2))])),
    );
    expect(await mixed.engine.exec('c1', ['true'])).toMatchObject({ stdout: '€', stderr: 'e\uFFFD' });
    const big = await serve(execAnswers(), (socket) => socket.end(Buffer.concat([frame(1, 'a'.repeat(MAX_EXEC_OUTPUT_CHARACTERS - 10)), frame(1, 'b'.repeat(100))])));
    const result = await big.engine.exec('c1', ['true']);
    expect(result.stdout).toHaveLength(MAX_EXEC_OUTPUT_CHARACTERS);
    expect(result.stdout.endsWith('a'.repeat(5) + 'b'.repeat(10))).toBe(true);
  });

  it('attaches no input without one, starts without detaching, and fails an inspect that does not say the process ended (review round 2, B-R2-16)', async () => {
    const { engine, calls } = await serve(execAnswers(), (socket) => socket.end());
    await engine.exec('c1', ['true']);
    expect(JSON.parse(calls[0].body)).toMatchObject({ AttachStdin: false });
    expect(JSON.parse(calls[1].body)).toEqual({ Detach: false, Tty: false });
    const unknown = await serve(execAnswers({ ExitCode: 0 }), (socket) => socket.end());
    await expect(unknown.engine.exec('c1', ['true'])).rejects.toThrow('the process did not');
    const created = await serve((call) => (call.url.endsWith('/exec') ? { status: 200, json: { Id: 'exec-1' } } : { status: 200, json: { ExitCode: 0, Running: false } }));
    await expect(created.engine.exec('c1', ['true'])).rejects.toBeInstanceOf(EngineError);
    const list = await serve(() => ({ status: 200, json: { not: 'a list' } }));
    await expect(list.engine.containers('label')).rejects.toBeInstanceOf(EngineError);
  });

  it('hands no further frame to a listener that cancelled the exec (review round 3, A-R3-1, A-R3-6)', async () => {
    const { engine } = await serve(execAnswers(), undefined, { onUpgrade: (socket) => socket.write(Buffer.concat([frame(1, 'a'), frame(1, 'b'), frame(1, 'c')])) });
    const controller = new AbortController();
    const seen: string[] = [];
    await expect(engine.exec('c1', ['true'], { signal: controller.signal, onOutput: (_stream, text) => (seen.push(text), controller.abort()) })).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual(['a']);
  });

  it('rejects with the error of a throwing listener, and hands it nothing more (review round 3, B-R3-5)', async () => {
    const { engine } = await serve(execAnswers(), undefined, { onUpgrade: (socket) => socket.write(Buffer.concat([frame(1, 'a'), frame(1, 'b')])) });
    const thrown = new Error('the listener broke');
    let calls = 0;
    await expect(
      engine.exec('c1', ['true'], {
        onOutput: () => {
          calls++;
          throw thrown;
        },
      }),
    ).rejects.toBe(thrown);
    expect(calls).toBe(1);
  });

  // Plan step 11B3: the requests of the pipeline's Docker over the port.
  describe('the requests of the pipeline (plan step 11B3)', () => {
    it('reads the version, an inspect (missing is undefined), and the lists with their filters', async () => {
      const { engine, calls } = await serve((call) => {
        if (call.url === '/version') return { status: 200, json: { ApiVersion: '1.48', Version: '29.0.0' } };
        if (call.url.startsWith('/volumes/gone') || call.url.startsWith('/images/gone')) return { status: 404, json: { message: 'No such volume' } };
        if (call.url.startsWith('/volumes/v1')) return { status: 200, json: { Name: 'v1', Labels: { a: 'b' } } };
        if (call.url.startsWith('/containers/json')) return { status: 200, json: [{ Id: 'a'.repeat(64) }, { Id: '' }, {}] };
        if (call.url.startsWith('/images/json')) {
          return { status: 200, json: [{ Id: 'sha256:1', RepoTags: ['p-app:1', '<none>:<none>'], RepoDigests: ['<none>@<none>'], Labels: null, Created: 1759485600 }, { noId: true }] };
        }
        if (call.url.startsWith('/volumes?')) return { status: 200, json: { Volumes: [{ Name: 'v1' }, { Name: '' }] } };
        if (call.url.startsWith('/networks?')) return { status: 200, json: [{ Name: 'n1' }, { Name: 'n1' }, { Name: 'n2' }] };
        return { status: 500, json: { message: 'unexpected' } };
      });
      expect(await engine.version()).toEqual({ apiVersion: '1.48', version: '29.0.0' });
      expect(await engine.inspect('volume', 'v1')).toEqual({ Name: 'v1', Labels: { a: 'b' } });
      expect(await engine.inspect('volume', 'gone')).toBeUndefined();
      expect(await engine.inspect('image', 'gone')).toBeUndefined();
      expect(await engine.containerIds({ label: ['a=b'] })).toEqual(['a'.repeat(64)]);
      expect(await engine.images({ reference: ['p-*'] })).toEqual([{ id: 'sha256:1', repoTags: ['p-app:1'], repoDigests: [], labels: {}, created: '2025-10-03T10:00:00.000Z' }]);
      expect(await engine.volumeNames({ label: ['x'] })).toEqual(['v1']);
      expect(await engine.networkNames({ label: ['x'] })).toEqual(['n1', 'n2']);
      const urls = calls.map((call) => decodeURIComponent(call.url));
      expect(urls).toContain('/containers/json?all=true&filters={"label":["a=b"]}');
      expect(urls).toContain('/images/json?filters={"reference":["p-*"]}');
      expect(urls).toContain('/volumes?filters={"label":["x"]}');
      expect(urls).toContain('/networks?filters={"label":["x"]}');
    });

    it('refuses an inspect or a list that it cannot read', async () => {
      const { engine } = await serve((call) => (call.url.startsWith('/images/json') ? { status: 200, json: { not: 'a list' } } : { status: 200, body: 'not json' }));
      await expect(engine.inspect('container', 'c')).rejects.toBeInstanceOf(EngineError);
      await expect(engine.images({})).rejects.toBeInstanceOf(EngineError);
      await expect(engine.version()).rejects.toBeInstanceOf(EngineError);
    });

    it('removes, renames and creates with the answers of the engine', async () => {
      const answers: Record<string, number> = {};
      const { engine, calls } = await serve((call) => ({ status: answers[`${call.method} ${decodeURIComponent(call.url.split('?')[0])}`] ?? 500, json: { message: 'conflict: unable to remove' } }));
      answers['DELETE /containers/c'] = 204;
      answers['DELETE /containers/gone'] = 404;
      await engine.removeContainer('c');
      await engine.removeContainer('gone');
      answers['POST /containers/c/rename'] = 204;
      await engine.renameContainer('c', 'new name');
      for (const [status, outcome] of [
        [200, 'removed'],
        [404, 'missing'],
        [409, 'inUse'],
      ] as const) {
        answers['DELETE /images/img:1'] = status;
        expect(await engine.removeImage('img:1')).toBe(outcome);
      }
      answers['DELETE /images/img:1'] = 500;
      await expect(engine.removeImage('img:1')).rejects.toMatchObject({ status: 500 });
      answers['POST /volumes/create'] = 201;
      await engine.createVolume('v', { a: 'b' });
      answers['DELETE /volumes/v'] = 404;
      answers['DELETE /networks/n'] = 404;
      await engine.removeVolume('v');
      await engine.removeNetwork('n');
      answers['DELETE /volumes/v'] = 409;
      await expect(engine.removeVolume('v')).rejects.toMatchObject({ status: 409 });
      answers['POST /containers/c/rename'] = 409;
      await expect(engine.renameContainer('c', 'taken')).rejects.toMatchObject({ status: 409 });
      expect(calls.find((call) => call.url.startsWith('/containers/c?'))?.url).toBe('/containers/c?force=true');
      expect(decodeURIComponent(calls.find((call) => call.url.includes('rename'))!.url)).toBe('/containers/c/rename?name=new name');
      expect(JSON.parse(calls.find((call) => call.url === '/volumes/create')!.body)).toEqual({ Name: 'v', Labels: { a: 'b' } });
    });

    it('labels an image by a commit of a created container with the image\'s configuration and the labels, and removes the container', async () => {
      const { engine, calls } = await serve((call) => {
        if (call.url.startsWith('/images/')) return { status: 200, json: { Id: 'sha256:old', Config: { Cmd: ['node'], Labels: { keep: 'x' }, User: 'dev' } } };
        if (call.url.startsWith('/containers/create')) return { status: 201, json: { Id: 'tmp' } };
        if (call.url.startsWith('/commit')) return { status: 201, json: { Id: 'sha256:new' } };
        return { status: 204 };
      });
      expect(await engine.labelImage('registry:5000/devenv-a:2', { add: 'y' })).toBe('sha256:new');
      const commit = calls.find((call) => call.url.startsWith('/commit'))!;
      expect(decodeURIComponent(commit.url)).toBe('/commit?container=tmp&repo=registry:5000/devenv-a&tag=2&pause=false');
      expect(JSON.parse(commit.body)).toEqual({ Cmd: ['node'], Labels: { keep: 'x', add: 'y' }, User: 'dev' });
      // Review round 1 of 11B3a (A-R1-1): the throwaway container goes with its anonymous volumes (`v=true`).
      expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/containers/tmp?force=true&v=true' });
      // Review round 1 of 11B3a (A-R1-7): the create is never cancelled half-way; a cancel before it creates nothing.
      const cancelled = new AbortController();
      cancelled.abort();
      const before = calls.length;
      await expect(engine.labelImage('img', {}, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls.slice(before).filter((call) => call.url.startsWith('/containers/create'))).toEqual([]);
      // A commit that fails removes the container too.
      const failing = await serve((call) => {
        if (call.url.startsWith('/images/')) return { status: 200, json: { Id: 'sha256:old', Config: {} } };
        if (call.url.startsWith('/containers/create')) return { status: 201, json: { Id: 'tmp' } };
        if (call.url.startsWith('/commit')) return { status: 500, json: { message: 'no space left on device' } };
        return { status: 204 };
      });
      await expect(failing.engine.labelImage('img', {})).rejects.toThrow('no space left on device');
      // Review round 1 of 11B3a (A-R1-1): the throwaway container goes with its anonymous volumes (`v=true`).
      expect(failing.calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/containers/tmp?force=true&v=true' });
      expect(decodeURIComponent(failing.calls.find((call) => call.url.startsWith('/commit'))!.url)).toContain('repo=img&tag=latest');
    });

    // Review round 2 of 11B3a (mutation testing of reviewer B): the requests and the reading of the answers, exactly.
    describe('the requests and answers, exactly (review round 2 of 11B3a, B-R2-1 to B-R2-10, B-R2-15)', () => {
      type Route = (request: EngineRequest) => EngineAnswer | Promise<EngineAnswer> | undefined;
      const ok = (value: unknown, status = 200): EngineAnswer => ({ status, body: typeof value === 'string' ? value : JSON.stringify(value), truncated: false });
      function fake(route: Route): { engine: DockerEngine; requests: EngineRequest[] } {
        const requests: EngineRequest[] = [];
        const api: EngineApi = async (request) => {
          requests.push(request);
          return (await route(request)) ?? ok({ message: 'not routed' }, 500);
        };
        return { engine: dockerEngine(api, engineHijack(path.join(os.tmpdir(), 'devenv-no-socket'))), requests };
      }
      const containerJson = (id: string) => ({ Id: id, Name: `/${id}`, State: { Status: 'running', Running: true }, Config: { Labels: {}, Image: 'img' }, Mounts: [] });

      it('B-R2-1: the paths of the inspects and the encoded filters', async () => {
        const { engine, requests } = fake((request) => (request.path.endsWith('/json') && request.path.startsWith('/images/') ? ok({ Id: 'sha256:1' }) : request.path.startsWith('/networks/') ? ok({ Name: 'n' }) : ok([])));
        expect(await engine.inspect('image', 'x:1')).toEqual({ Id: 'sha256:1' });
        expect(await engine.inspect('network', 'n')).toEqual({ Name: 'n' });
        await engine.containerIds({ label: ['a=b'] });
        expect(requests.map((request) => request.path)).toEqual(['/images/x%3A1/json', '/networks/n', `/containers/json?all=true&filters=%7B%22label%22%3A%5B%22a%3Db%22%5D%7D`]);
      });

      it('B-R2-3, B-R2-10: a container gone since the list is left out, the ones after it are not; an invalid inspect fails', async () => {
        const { engine } = fake((request) => {
          if (request.path.startsWith('/containers/json')) return ok([{ Id: 'a' }, { Id: 'gone' }, { Id: 'c' }]);
          if (request.path === '/containers/gone/json') return ok({ message: 'No such container' }, 404);
          if (request.path === '/containers/bad/json') return ok({ Id: 'bad' });
          return ok(containerJson(request.path.split('/')[2]));
        });
        expect((await engine.containers('l')).map((container) => container.id)).toEqual(['a', 'c']);
        await expect(engine.container('bad')).rejects.toBeInstanceOf(EngineError);
        // An inspect answered with a list is no object (B-R2-15).
        const listed = fake(() => ok([]));
        await expect(listed.engine.inspect('image', 'x')).rejects.toThrow('invalid value');
      });

      it('B-R2-4, B-R2-5: the labels of an image, and a volume list of null', async () => {
        const { engine } = fake((request) =>
          request.path.startsWith('/images/json') ? ok([{ Id: 'sha256:1', RepoTags: ['a:1'], RepoDigests: [], Labels: { k: 'v', n: 1 }, Created: 0 }]) : ok({ Volumes: null, Warnings: null }),
        );
        expect((await engine.images({}))[0].labels).toEqual({ k: 'v' });
        expect(await engine.volumeNames({})).toEqual([]);
      });

      it('B-R2-6: labelImage overrides an old label, creates with `Cmd [true]`, and splits a registry port from the tag', async () => {
        const { engine, requests } = fake((request) => {
          if (request.path.startsWith('/images/')) return ok({ Id: 'sha256:old', Config: { Labels: { keep: 'x', add: 'old' } } });
          if (request.path.startsWith('/containers/create')) return ok({ Id: 'tmp' }, 201);
          if (request.path.startsWith('/commit')) return ok({ Id: 'sha256:new' }, 201);
          return ok('', 204);
        });
        await engine.labelImage('registry:5000/name', { add: 'y' });
        expect(requests.find((request) => request.path.startsWith('/containers/create'))?.json).toEqual({ Image: 'registry:5000/name', Cmd: ['true'], Entrypoint: [], Labels: {} });
        const commit = requests.find((request) => request.path.startsWith('/commit'))!;
        expect(commit.json).toEqual({ Labels: { keep: 'x', add: 'y' } });
        expect(decodeURIComponent(commit.path)).toContain('repo=registry:5000/name&tag=latest');
        // A cancel while the create is pending: the create is not cancelled (A-R1-7); the container is removed.
        const controller = new AbortController();
        const slow = fake(async (request) => {
          if (request.path.startsWith('/images/')) return ok({ Id: 'sha256:old', Config: {} });
          if (request.path.startsWith('/containers/create')) {
            controller.abort();
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (request.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            return ok({ Id: 'tmp2' }, 201);
          }
          if (request.path.startsWith('/commit')) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          return ok('', 204);
        });
        await expect(slow.engine.labelImage('img:1', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(slow.requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/containers/tmp2?force=true&v=true' });
        // A missing image is an EngineError 404 (B-R2-15).
        const missing = fake(() => ok({ message: 'No such image' }, 404));
        await expect(missing.engine.labelImage('img:1', {})).rejects.toMatchObject({ status: 404 });
      });

      it('B-R2-7, B-R2-8, B-R2-9: runContainer follows the cancel, reads the wait strictly, and cleans the log', async () => {
        const spec = { image: 'img:1', entrypoint: 'sh', args: [], user: 'root', labels: {}, volumes: [] };
        let wait: () => EngineAnswer | Promise<EngineAnswer> = () => ok({ StatusCode: 0 });
        let log = '';
        const { engine, requests } = fake((request) => {
          if (request.path.startsWith('/containers/create')) return ok({ Id: 'r' }, 201);
          if (request.path.endsWith('/wait')) return wait();
          if (request.path.includes('/logs')) return ok(log);
          return ok('', 204);
        });
        // B-R2-7: a cancel of the caller ends a hanging wait with an AbortError, not as timed out; the container goes.
        wait = () =>
          new Promise((_resolve, reject) => {
            const signal = requests.at(-1)!.signal!;
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        await expect(engine.runContainer(spec, { signal: controller.signal, timeoutMs: 60_000 })).rejects.toMatchObject({ name: 'AbortError' });
        expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/containers/r?force=true&v=true' });
        // B-R2-8: a wait without a status code is no success; a wait that fails is a failure, and the container goes.
        wait = () => ok({});
        expect(await engine.runContainer(spec)).toMatchObject({ exitCode: null, timedOut: false });
        wait = () => ok({ message: 'boom' }, 500);
        await expect(engine.runContainer(spec)).rejects.toMatchObject({ status: 500 });
        expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/containers/r?force=true&v=true' });
        // B-R2-9: the headers of the frames of the log are left out, and its end is kept.
        wait = () => ok({ StatusCode: 1 });
        const frame = (stream: number, text: string) => String.fromCharCode(stream, 0, 0, 0, 0, 0, 0, text.length) + text;
        log = frame(1, 'out\n') + frame(2, 'err\n');
        expect((await engine.runContainer(spec)).output).toBe('out\nerr\n');
        log = 'a'.repeat(70 * 1024) + 'THE END';
        const long = (await engine.runContainer(spec)).output;
        expect(long.endsWith('THE END')).toBe(true);
        expect(long.length).toBe(64 * 1024);
      });

      // Review round 4 of 11B3a (mutation testing, G1 to G6): the time limits of their own, driven by a spy of
      // AbortSignal.timeout that hands out a controllable signal per call.
      function controlledTimeouts(): { limits: { ms: number; controller: AbortController }[]; restore: () => void } {
        const limits: { ms: number; controller: AbortController }[] = [];
        const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
          const controller = new AbortController();
          limits.push({ ms, controller });
          return controller.signal;
        });
        return { limits, restore: () => spy.mockRestore() };
      }
      const abortWith = (signal: AbortSignal | undefined): Promise<never> =>
        new Promise((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal?.aborted) fail();
          signal?.addEventListener('abort', fail);
        });
      const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));
      const limitOf = (limits: { ms: number; controller: AbortController }[], signal: AbortSignal | undefined) => limits.find((limit) => limit.controller.signal === signal);

      it('G1: a create of labelImage that does not answer in time is an EngineError, and its container is removed by its name', async () => {
        const { limits, restore } = controlledTimeouts();
        try {
          const { engine, requests } = fake((request) => {
            if (request.path.startsWith('/images/')) return ok({ Id: 'sha256:old', Config: {} });
            if (request.path.startsWith('/containers/create')) return abortWith(request.signal);
            return ok('', 204);
          });
          const labelling = engine.labelImage('img:1', {});
          await settle();
          const create = requests.find((request) => request.path.startsWith('/containers/create'))!;
          expect(limitOf(limits, create.signal)?.ms).toBe(60_000);
          limitOf(limits, create.signal)!.controller.abort();
          const error = await labelling.catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(EngineError);
          expect(error).toMatchObject({ status: 0, message: expect.stringContaining('did not answer the create') });
          expect(error).not.toMatchObject({ name: 'AbortError' });
          const name = create.path.split('name=')[1];
          expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: `/containers/${name}?force=true&v=true` });
          // G5: the removal by name has a time limit of its own, never an aborted signal, and its failure changes nothing.
          expect(requests.at(-1)?.signal).toBeDefined();
          expect(requests.at(-1)?.signal?.aborted).toBe(false);
        } finally {
          restore();
        }
        const failingRemoval = fake((request) => {
          if (request.path.startsWith('/images/')) return ok({ Id: 'sha256:old', Config: {} });
          if (request.path.startsWith('/containers/create')) return ok({ Id: '' }, 201);
          if (request.method === 'DELETE') throw new Error('engine gone');
          return ok('', 204);
        });
        await expect(failingRemoval.engine.labelImage('img:1', {})).rejects.toThrow('invalid value');
      });

      it('G2, G3, G4: the log of a run and its start have time limits; the removal has its own and never fails the run', async () => {
        const spec = { image: 'img:1', entrypoint: 'sh', args: [], user: 'root', labels: {}, volumes: [] };
        const { limits, restore } = controlledTimeouts();
        try {
          // G2: a log that does not end is cut by its own limit; the exit code stays, the container goes.
          const { engine, requests } = fake((request) => {
            if (request.path.startsWith('/containers/create')) return ok({ Id: 'r' }, 201);
            if (request.path.endsWith('/wait')) return ok({ StatusCode: 4 });
            if (request.path.includes('/logs')) return abortWith(request.signal);
            return ok('', 204);
          });
          const running = engine.runContainer(spec);
          await settle();
          const log = requests.find((request) => request.path.includes('/logs'))!;
          expect(limitOf(limits, log.signal)?.ms).toBe(60_000);
          limitOf(limits, log.signal)!.controller.abort();
          expect(await running).toEqual({ exitCode: 4, output: '', timedOut: false });
          expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/containers/r?force=true&v=true' });
          // G4: the removal has a time limit of its own, not aborted.
          expect(limitOf(limits, requests.at(-1)?.signal)?.ms).toBe(60_000);
          expect(requests.at(-1)?.signal?.aborted).toBe(false);
        } finally {
          restore();
        }
        // G3: a start that does not answer is cut by the time limit of the run.
        const hangingStart = fake((request) => {
          if (request.path.startsWith('/containers/create')) return ok({ Id: 's' }, 201);
          if (request.path.endsWith('/start')) return abortWith(request.signal);
          return ok('', 204);
        });
        expect(await hangingStart.engine.runContainer(spec, { timeoutMs: 50 })).toEqual({ exitCode: null, output: '', timedOut: true });
        expect(hangingStart.requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/containers/s?force=true&v=true' });
        // G4: a cancel does not reach the removal; a removal that fails does not fail a run that succeeded.
        const controller = new AbortController();
        const cancelled = fake((request) => {
          if (request.path.startsWith('/containers/create')) return ok({ Id: 'c' }, 201);
          if (request.path.endsWith('/wait')) return abortWith(request.signal);
          return ok('', 204);
        });
        const run = cancelled.engine.runContainer(spec, { signal: controller.signal });
        await settle();
        controller.abort();
        await expect(run).rejects.toMatchObject({ name: 'AbortError' });
        const removal = cancelled.requests.at(-1)!;
        expect(removal).toMatchObject({ method: 'DELETE', path: '/containers/c?force=true&v=true' });
        expect(removal.signal).toBeDefined();
        expect(removal.signal).not.toBe(controller.signal);
        expect(removal.signal?.aborted).toBe(false);
        const failingRemoval = fake((request) => {
          if (request.path.startsWith('/containers/create')) return ok({ Id: 'f' }, 201);
          if (request.path.endsWith('/wait')) return ok({ StatusCode: 0 });
          if (request.method === 'DELETE') throw new Error('engine gone');
          return ok('', 204);
        });
        expect(await failingRemoval.engine.runContainer(spec)).toEqual({ exitCode: 0, output: '', timedOut: false });
        // G6 (#21): a wait without a status code reads the log, for the reason.
        const noCode = fake((request) => {
          if (request.path.startsWith('/containers/create')) return ok({ Id: 'n' }, 201);
          if (request.path.endsWith('/wait')) return ok({});
          if (request.path.includes('/logs')) return ok('the reason');
          return ok('', 204);
        });
        expect(await noCode.engine.runContainer(spec)).toEqual({ exitCode: null, output: 'the reason', timedOut: false });
      });

      it('B-R2-15: a pull prints a line that is no JSON, fails with the first error, and needs the secret of its login', async () => {
        const { engine } = fake((request) => {
          request.onChunk?.('plain text\n{"error":"first"}\n{"error":"second"}\n');
          return ok('');
        });
        const lines: string[] = [];
        await expect(engine.pull('a:1', { onLine: (line) => lines.push(line) })).rejects.toThrow('first');
        expect(lines).toEqual(['plain text']);
        await expect(engine.pull('a:1', { login: { serveraddress: 'r', username: 'u', secretName: 'missing' } })).rejects.toThrow('holds no secret missing');
      });
    });

    it('names the container of the commit, and removes it with a time limit of its own (review round 3 of 11B3a, A-R3-1, A-R3-3)', async () => {
      const requests: { method: string; path: string; signal?: AbortSignal }[] = [];
      let createdId: unknown = 'tmp';
      const fakeApi: EngineApi = async (request) => {
        requests.push({ method: request.method, path: request.path, signal: request.signal });
        if (request.path.startsWith('/images/')) return { status: 200, body: JSON.stringify({ Id: 'sha256:old', Config: {} }), truncated: false };
        if (request.path.startsWith('/containers/create')) return { status: 201, body: JSON.stringify({ Id: createdId }), truncated: false };
        if (request.path.startsWith('/commit')) return { status: 201, body: JSON.stringify({ Id: 'sha256:new' }), truncated: false };
        return { status: 204, body: '', truncated: false };
      };
      const engine = dockerEngine(fakeApi, engineHijack(path.join(os.tmpdir(), 'devenv-no-socket')));
      expect(await engine.labelImage('img:1', { a: 'b' })).toBe('sha256:new');
      const create = requests.find((request) => request.path.startsWith('/containers/create'))!;
      expect(create.path).toMatch(/^\/containers\/create\?name=devenv-label-[0-9a-f]{12}$/);
      // The create has a time limit, never the cancel signal of the operation.
      expect(create.signal).toBeDefined();
      const removal = requests.at(-1)!;
      expect(removal).toMatchObject({ method: 'DELETE', path: '/containers/tmp?force=true&v=true' });
      expect(removal.signal?.aborted).toBe(false);
      // Review round 4 of 11B3a (A-R4-1): the cancel signal of the operation never reaches the create.
      const controller = new AbortController();
      requests.length = 0;
      await engine.labelImage('img:1', {}, controller.signal);
      const limited = requests.find((request) => request.path.startsWith('/containers/create'))!;
      expect(limited.signal).toBeDefined();
      expect(limited.signal).not.toBe(controller.signal);
      // A create whose answer fails (A-R4-2): the container is removed by its name, and the failure stays as it is.
      const broken = dockerEngine(async (request) => {
        requests.push({ method: request.method, path: request.path, signal: request.signal });
        if (request.path.startsWith('/containers/create')) throw new Error('socket hang up');
        return fakeApi(request);
      }, engineHijack(path.join(os.tmpdir(), 'devenv-no-socket')));
      requests.length = 0;
      await expect(broken.labelImage('img:1', {})).rejects.toThrow('socket hang up');
      const brokenName = requests.find((request) => request.path.startsWith('/containers/create'))!.path.split('name=')[1];
      expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: `/containers/${brokenName}?force=true&v=true` });
      // An answer without an ID: the container is removed by its name.
      createdId = '';
      requests.length = 0;
      await expect(engine.labelImage('img:1', {})).rejects.toThrow('invalid value');
      const name = requests.find((request) => request.path.startsWith('/containers/create'))!.path.split('name=')[1];
      expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: `/containers/${name}?force=true&v=true` });
    });

    it('runs a container to its end: create, start, wait, the log only on a failure, the removal always', async () => {
      let code = 0;
      const { engine, calls } = await serve((call) => {
        if (call.url === '/containers/create') return { status: 201, json: { Id: 'run1' } };
        if (call.url.endsWith('/wait')) return { status: 200, json: { StatusCode: code } };
        if (call.url.includes('/logs')) return { status: 200, body: 'chown: denied' };
        return { status: 204 };
      });
      const spec = { image: 'img:1', entrypoint: 'sh', args: ['-c', 'x'], user: 'root', labels: { a: 'b' }, volumes: [{ name: 'v', target: '/workspaces' }] };
      expect(await engine.runContainer(spec)).toEqual({ exitCode: 0, output: '', timedOut: false });
      expect(JSON.parse(calls[0].body)).toEqual({
        Image: 'img:1',
        Entrypoint: ['sh'],
        Cmd: ['-c', 'x'],
        User: 'root',
        Labels: { a: 'b' },
        HostConfig: { Init: true, NetworkMode: 'none', Mounts: [{ Type: 'volume', Source: 'v', Target: '/workspaces' }] },
      });
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /containers/create', 'POST /containers/run1/start', 'POST /containers/run1/wait', 'DELETE /containers/run1?force=true&v=true']);
      code = 2;
      expect(await engine.runContainer(spec)).toEqual({ exitCode: 2, output: 'chown: denied', timedOut: false });
      // Review round 1 of 11B3a (A-R1-8): only the end of the log is read.
      expect(calls.find((call) => call.url.includes('/logs'))?.url).toBe('/containers/run1/logs?stdout=true&stderr=true&tail=200');
      const hanging = await serve((call) => (call.url === '/containers/create' ? { status: 201, json: { Id: 'run2' } } : call.url.endsWith('/wait') ? undefined : { status: 204 }));
      expect(await hanging.engine.runContainer(spec, { timeoutMs: 50 })).toEqual({ exitCode: null, output: '', timedOut: true });
      // Review round 1 of 11B3a (A-R1-1): with its anonymous volumes; the named volume of the workspace is kept by the engine.
      expect(hanging.calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/containers/run2?force=true&v=true' });
    });

    it('the time limit of a run covers its create, ends with its wait, and a slow log keeps the exit code (review round 2 of 11B3a, A-R2-2, A-R2-4)', async () => {
      // The create does not answer: the run ends at its limit; there is no container ID to remove (the caller removes it by label).
      const slowCreate = await serve(() => undefined);
      const spec = { image: 'img:1', entrypoint: 'sh', args: [], user: 'root', labels: { a: 'b' }, volumes: [] };
      expect(await slowCreate.engine.runContainer(spec, { timeoutMs: 50 })).toEqual({ exitCode: null, output: '', timedOut: true });
      expect(slowCreate.calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /containers/create']);
      // The run fails and its log comes after the limit of the run: the exit code and the log are the answer.
      const answerAfter = (ms: number, answer: EngineAnswer, signal?: AbortSignal): Promise<EngineAnswer> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(answer), ms);
          signal?.addEventListener('abort', () => (clearTimeout(timer), reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
        });
      const requests: string[] = [];
      const fakeApi: EngineApi = async (request) => {
        requests.push(`${request.method} ${request.path}`);
        if (request.path === '/containers/create') return { status: 201, body: JSON.stringify({ Id: 'run3' }), truncated: false };
        if (request.path.endsWith('/wait')) return { status: 200, body: JSON.stringify({ StatusCode: 4 }), truncated: false };
        if (request.path.includes('/logs')) return answerAfter(120, { status: 200, body: 'late reason', truncated: false }, request.signal);
        return { status: 204, body: '', truncated: false };
      };
      const fake = dockerEngine(fakeApi, engineHijack(path.join(os.tmpdir(), 'devenv-no-socket')));
      expect(await fake.runContainer(spec, { timeoutMs: 50 })).toEqual({ exitCode: 4, output: 'late reason', timedOut: false });
      expect(requests.at(-1)).toBe('DELETE /containers/run3?force=true&v=true');
      // A cancel of the operation ends the read of the log; the container is still removed.
      const controller = new AbortController();
      const cancelled = fake.runContainer(spec, { signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      expect(requests.at(-1)).toBe('DELETE /containers/run3?force=true&v=true');
      // A log read that throws (the connection broke) is no output either; the exit code stays.
      const brokenLog = dockerEngine(async (request) => {
        if (request.path.includes('/logs')) throw new Error('socket hang up');
        return fakeApi(request);
      }, engineHijack(path.join(os.tmpdir(), 'devenv-no-socket')));
      expect(await brokenLog.runContainer(spec)).toEqual({ exitCode: 4, output: '', timedOut: false });
      // A log that fails is no output; the exit code stays.
      const failedLog = await serve((call) => {
        if (call.url === '/containers/create') return { status: 201, json: { Id: 'run4' } };
        if (call.url.endsWith('/wait')) return { status: 200, json: { StatusCode: 5 } };
        if (call.url.includes('/logs')) return { status: 500, json: { message: 'busy' } };
        return { status: 204 };
      });
      expect(await failedLog.engine.runContainer(spec, { timeoutMs: 50 })).toEqual({ exitCode: 5, output: '', timedOut: false });
    });

    it('never pulls a reference without a tag or a digest (review round 2 of 11B3a, A-R2-1)', async () => {
      const { engine, calls } = await serve(() => ({ status: 200, body: '' }));
      // Review round 4 of 11B3a (G6): also an invalid digest, and as an EngineError with status 0.
      for (const reference of ['node', 'ghcr.io/o/i', 'registry:5000/i', 'node:', 'node@sha256:xyz', 'node@']) {
        await expect(engine.pull(reference)).rejects.toThrow(`The pull of ${reference} needs a tag or a digest.`);
        await expect(engine.pull(reference)).rejects.toMatchObject({ status: 0 });
        await expect(engine.pull(reference)).rejects.toBeInstanceOf(EngineError);
      }
      expect(calls).toEqual([]);
      await engine.pull('registry:5000/i:1');
      expect(calls.map((call) => decodeURIComponent(call.url))).toEqual(['/images/create?fromImage=registry:5000/i:1']);
    });
  });
});

