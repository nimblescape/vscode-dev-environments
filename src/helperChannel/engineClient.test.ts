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
import { EngineError, type DockerEngine } from '../core/worker/dockerEngine';
import { engineApi, engineHijack } from './engineApi';
import { dockerEngine } from './engineClient';

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
    { Type: 'bind', Source: '/tmp' },
  ],
};

describe('the port of the engine over the Engine API (plan step 11B1)', () => {
  const servers: http.Server[] = [];
  const sockets: net.Socket[] = [];
  let folder: string | undefined;

  afterEach(async () => {
    // The hijacked connections stay open until the test ends them.
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (folder !== undefined) fs.rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  });

  /** An engine whose requests `answer` serves; an exec is served over a hijacked connection by `exec`. */
  async function serve(
    answer: (call: Call) => { status: number; json?: unknown; body?: string },
    exec?: (socket: net.Socket, input: Buffer) => void,
  ): Promise<{ engine: DockerEngine; calls: Call[] }> {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-engine-'));
    const socketPath = path.join(folder, 'docker.sock');
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const call = { method: req.method ?? '', url: req.url ?? '', body };
        calls.push(call);
        const given = answer(call);
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
      socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      let input = head.subarray(length);
      socket.on('data', (chunk: Buffer) => (input = Buffer.concat([input, chunk])));
      socket.on('end', () => exec?.(socket, input));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return { engine: dockerEngine(engineApi(socketPath), engineHijack(socketPath)), calls };
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
      (call) => (call.url.endsWith('/exec') ? { status: 201, json: { Id: 'exec-1' } } : { status: 200, json: { ExitCode: 3 } }),
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
      (call) => (call.url.endsWith('/exec') ? { status: 201, json: { Id: 'exec-1' } } : { status: 200, json: { ExitCode: 0 } }),
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
    expect(calls.map((call) => call.url)).toEqual(['/containers/c1/stop?t=20', '/containers/c1/start']);
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
      (call) => (call.url.endsWith('/exec') ? { status: 201, json: { Id: 'exec-1' } } : { status: 200, json: { ExitCode: 0 } }),
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
});
