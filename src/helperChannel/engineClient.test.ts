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
import { afterEach, describe, expect, it } from 'vitest';
import { EngineError, isMissing, type DockerEngine } from '../core/worker/dockerEngine';
import { SECRET_TOKEN } from '../core/helperChannel/protocol';
import { scriptCommand } from '../core/worker/containerScripts';
import { engineApi, engineHijack, MAX_ENGINE_FRAME_BYTES } from './engineApi';
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
    return { engine: dockerEngine(engineApi(socketPath), engineHijack(socketPath), (name) => secrets[name]), calls };
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
        socket.end(frame(1, `in:${input.toString('utf8')}`));
      },
      { secrets: { [SECRET_TOKEN]: 'ghp_value' } },
    );
    const result = await engine.exec('c1', scriptCommand('tokenWrite', ['dev', 'octocat']), { user: 'root', secretInputName: SECRET_TOKEN });
    expect(result.stdout).toBe('in:ghp_value');
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
});
