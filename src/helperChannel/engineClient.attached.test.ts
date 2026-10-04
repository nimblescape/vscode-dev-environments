// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D2: the attached create of the Session Monitor (DockerEngine.createAttached) and the clock of the daemon
// (systemTime) over the Engine API, against an HTTP server on a Unix socket that answers as the engine (JSON for the
// requests, a hijacked connection with framed output for the attach).
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonitorRunSpec } from '../core/remoteMonitor/monitorEngine';
import { engineApi, engineHijack } from './engineApi';
import { dockerEngine } from './engineClient';

interface Call {
  method: string;
  url: string;
  body: string;
}

function frame(stream: 1 | 2, text: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

const READY = 'Session Monitor started';
const ID = 'c0ffee'.repeat(10) + 'c0ff';
const SPEC: MonitorRunSpec = {
  name: 'devenv-session-monitor',
  image: 'sha256:' + 'a'.repeat(64),
  labels: { 'nimblescape.devenv.session-monitor': 'label', 'nimblescape.devenv.monitor-create': 'nonce' },
  restartPolicy: 'on-failure',
  network: 'none',
  log: { driver: 'json-file', maxSize: '1m', maxFile: '2' },
  mounts: { socket: '/var/run/docker.sock', volume: 'devenv-session-monitor', volumeTarget: '/state' },
  env: { DEVENV_IMAGE_TZ: 'UTC' },
  command: ['node', '-e', 'loader', '/opt/devenv/monitor.js', 'hash', 'startMonitor'],
};

describe('the attached create and the clock of the daemon over the Engine API (plan step 11D2)', () => {
  const servers: http.Server[] = [];
  const sockets: net.Socket[] = [];
  const folders: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  /**
   * An engine whose requests `answer` serves, and whose attach calls `onInput` with each piece of input (to answer on the
   * connection); `inputEnded` resolves when the client ended its input.
   */
  async function serve(answer: (call: Call) => { status: number; json?: unknown } | undefined, onInput: (socket: net.Socket, input: string) => void = () => {}) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-attach-'));
    folders.push(folder);
    const socketPath = path.join(folder, 'docker.sock');
    const calls: Call[] = [];
    let input = '';
    let markEnded: () => void = () => {};
    const inputEnded = new Promise<void>((resolve) => (markEnded = resolve));
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const call = { method: req.method ?? '', url: req.url ?? '', body };
        calls.push(call);
        const given = answer(call);
        if (given === undefined) return;
        res.writeHead(given.status, { 'Content-Type': 'application/json' });
        res.end(given.json !== undefined ? JSON.stringify(given.json) : '');
      });
    });
    server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
      sockets.push(socket);
      calls.push({ method: 'POST', url: req.url ?? '', body: '' });
      socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      const receive = (chunk: Buffer) => {
        input += chunk.toString('utf8');
        onInput(socket, input);
      };
      if (head.length > 0) receive(head);
      socket.on('data', receive);
      socket.on('end', () => markEnded());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return { engine: dockerEngine(engineApi(socketPath), engineHijack(socketPath)), calls, input: () => input, inputEnded };
  }

  const engineAnswers =
    (start: { status: number; json?: unknown } = { status: 204 }) =>
    (call: Call) => {
      if (call.url.startsWith('/containers/create')) return { status: 201, json: { Id: ID } };
      if (call.url.endsWith('/start')) return start;
      return { status: 404, json: { message: 'unexpected' } };
    };

  it('creates the container with an open input, attaches before the start, writes the line, and ends its input at the ready line', async () => {
    const { engine, calls, input, inputEnded } = await serve(engineAnswers(), (socket, given) => {
      if (given.endsWith('\n')) socket.write(frame(1, `2026-10-04T12:00:00Z ${READY} (Node.js v24).\n`));
    });
    expect(await engine.createAttached(SPEC, { input: '"the script"\n', readyText: READY, timeoutMs: 5_000 })).toEqual({ kind: 'ready' });
    expect(calls.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual([
      'POST /containers/create',
      `POST /containers/${ID}/attach`,
      `POST /containers/${ID}/start`,
    ]);
    expect(calls[0].url).toBe('/containers/create?name=devenv-session-monitor');
    expect(calls[1].url).toBe(`/containers/${ID}/attach?stream=1&stdin=1&stdout=1&stderr=1`);
    expect(JSON.parse(calls[0].body)).toEqual({
      Image: SPEC.image,
      Cmd: SPEC.command,
      Labels: SPEC.labels,
      Env: ['DEVENV_IMAGE_TZ=UTC'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
      HostConfig: {
        RestartPolicy: { Name: 'on-failure' },
        NetworkMode: 'none',
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '2' } },
        Binds: ['/var/run/docker.sock:/var/run/docker.sock', 'devenv-session-monitor:/state'],
      },
    });
    expect(input()).toBe('"the script"\n');
    await inputEnded;
  });

  it('with image maintenance, the default network', async () => {
    const { engine, calls } = await serve(engineAnswers(), (socket, given) => {
      if (given.endsWith('\n')) socket.write(frame(1, READY));
    });
    await engine.createAttached({ ...SPEC, network: 'default' }, { input: 'x\n', readyText: READY, timeoutMs: 5_000 });
    expect(JSON.parse(calls[0].body).HostConfig.NetworkMode).toBe('default');
  });

  it('a name in use is a conflict; another refusal of the create is not; nothing is attached then', async () => {
    const conflict = await serve(() => ({ status: 409, json: { message: 'Conflict. The container name "/devenv-session-monitor" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.' } }));
    expect(await conflict.engine.createAttached(SPEC, { input: 'x\n', readyText: READY, timeoutMs: 5_000 })).toMatchObject({ kind: 'exited', conflict: true });
    expect(conflict.calls).toHaveLength(1);
    const missing = await serve(() => ({ status: 404, json: { message: 'No such image: sha256:aaa' } }));
    expect(await missing.engine.createAttached(SPEC, { input: 'x\n', readyText: READY, timeoutMs: 5_000 })).toEqual({ kind: 'exited', detail: 'No such image: sha256:aaa', conflict: false });
    const otherConflict = await serve(() => ({ status: 409, json: { message: 'something else conflicts' } }));
    expect(await otherConflict.engine.createAttached(SPEC, { input: 'x\n', readyText: READY, timeoutMs: 5_000 })).toMatchObject({ kind: 'exited', conflict: false });
  });

  it('a container that ends before its ready line is exited, with the end of its error output', async () => {
    const { engine } = await serve(engineAnswers(), (socket, given) => {
      if (!given.endsWith('\n')) return;
      socket.write(frame(2, 'devenv loader: the script does not match its hash\n'));
      socket.end();
    });
    expect(await engine.createAttached(SPEC, { input: 'x\n', readyText: READY, timeoutMs: 5_000 })).toEqual({
      kind: 'exited',
      detail: 'devenv loader: the script does not match its hash',
      conflict: false,
    });
  });

  it('a refused start is exited (the caller removes the container by its labels)', async () => {
    const { engine } = await serve(engineAnswers({ status: 500, json: { message: 'cannot start: no such file' } }));
    expect(await engine.createAttached(SPEC, { input: 'x\n', readyText: READY, timeoutMs: 5_000 })).toEqual({ kind: 'exited', detail: 'cannot start: no such file', conflict: false });
  });

  it('no ready line within the time limit is a timeout; a cancel is aborted', async () => {
    const quiet = await serve(engineAnswers());
    expect(await quiet.engine.createAttached(SPEC, { input: 'x\n', readyText: READY, timeoutMs: 300 })).toEqual({ kind: 'timeout' });
    await quiet.inputEnded;
    const cancelled = await serve(engineAnswers());
    const controller = new AbortController();
    const creating = cancelled.engine.createAttached(SPEC, { input: 'x\n', readyText: READY, timeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await creating).toEqual({ kind: 'aborted' });
    // A cancel before anything was sent rejects.
    await expect(cancelled.engine.createAttached(SPEC, { input: 'x\n', readyText: READY, timeoutMs: 5_000, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a create that gets no answer ends at the time limit (the caller removes what it may have made by its labels)', async () => {
    const { engine } = await serve(() => undefined);
    expect(await engine.createAttached(SPEC, { input: 'x\n', readyText: READY, timeoutMs: 300 })).toEqual({ kind: 'timeout' });
  });

  it('plan step 11D3: a container of a tag is checked for the pinned image ID before its start', async () => {
    const PINNED = 'sha256:' + 'b'.repeat(64);
    const answers = (image: string, status = 200) => (call: Call) => {
      if (call.url.startsWith('/containers/create')) return { status: 201, json: { Id: ID } };
      if (call.url === `/containers/${ID}/json`) return { status, json: status === 200 ? { Id: ID, Image: image } : { message: 'no such container' } };
      if (call.url.endsWith('/start')) return { status: 204 };
      return { status: 404, json: { message: 'unexpected' } };
    };
    const spec = { ...SPEC, image: 'devenv-monitor:0123456789ab', imageId: PINNED };
    const same = await serve(answers(PINNED), (socket, given) => {
      if (given.endsWith('\n')) socket.write(frame(1, READY));
    });
    expect(await same.engine.createAttached(spec, { input: 'x\n', readyText: READY, timeoutMs: 5_000 })).toEqual({ kind: 'ready' });
    expect(same.calls.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual([
      'POST /containers/create',
      `GET /containers/${ID}/json`,
      `POST /containers/${ID}/attach`,
      `POST /containers/${ID}/start`,
    ]);
    // The ID is no field of the create.
    expect(JSON.parse(same.calls[0].body).Image).toBe('devenv-monitor:0123456789ab');
    expect(JSON.parse(same.calls[0].body)).not.toHaveProperty('imageId');
    const other = await serve(answers('sha256:' + 'c'.repeat(64)));
    expect(await other.engine.createAttached(spec, { input: 'x\n', readyText: READY, timeoutMs: 5_000 })).toEqual({
      kind: 'exited',
      detail: `the container was created from the image sha256:${'c'.repeat(64)}, not from ${PINNED}`,
      conflict: false,
    });
    // Never attached or started: the caller removes it by its labels.
    expect(other.calls.map((call) => call.url.split('?')[0])).toEqual(['/containers/create', `/containers/${ID}/json`]);
    const unreadable = await serve(answers('', 404));
    expect(await unreadable.engine.createAttached(spec, { input: 'x\n', readyText: READY, timeoutMs: 5_000 })).toMatchObject({ kind: 'exited', detail: 'no such container' });
    expect(unreadable.calls).toHaveLength(2);
    const noImage = await serve((call) => (call.url === `/containers/${ID}/json` ? { status: 200, json: { Id: ID } } : answers(PINNED)(call)));
    expect(await noImage.engine.createAttached(spec, { input: 'x\n', readyText: READY, timeoutMs: 5_000 })).toMatchObject({ kind: 'exited', detail: `the container was created from the image that cannot be read, not from ${PINNED}` });
  });

  it('plan step 11D3: tags an image by its ID; a refusal fails; only a local repository:tag', async () => {
    const good = await serve(() => ({ status: 201 }));
    await good.engine.tagImage('sha256:' + 'a'.repeat(64), 'devenv-monitor:0123456789ab');
    expect(good.calls).toEqual([{ method: 'POST', url: `/images/sha256%3A${'a'.repeat(64)}/tag?repo=devenv-monitor&tag=0123456789ab`, body: '' }]);
    const refused = await serve(() => ({ status: 404, json: { message: 'No such image: sha256:aaa' } }));
    await expect(refused.engine.tagImage('sha256:aaa', 'devenv-monitor:0123456789ab')).rejects.toThrow('No such image');
    for (const reference of ['devenv-monitor', ':x', 'ghcr.io/acme/x:1', 'devenv-monitor@sha256:aa']) {
      await expect(refused.engine.tagImage('sha256:aaa', reference)).rejects.toThrow('is not a local repository:tag');
    }
    expect(refused.calls).toHaveLength(1);
  });

  it('reads the clock of the daemon; an answer without it is a failure', async () => {
    const good = await serve(() => ({ status: 200, json: { SystemTime: '2026-10-04T12:00:00.123456789Z', Containers: 3 } }));
    expect(await good.engine.systemTime()).toBe('2026-10-04T12:00:00.123456789Z');
    expect(good.calls[0]).toMatchObject({ method: 'GET', url: '/info' });
    const bad = await serve(() => ({ status: 200, json: { Containers: 3 } }));
    await expect(bad.engine.systemTime()).rejects.toThrow('without its time');
  });
});
