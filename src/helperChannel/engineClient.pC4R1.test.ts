// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup PR #140 (probe): the removed tests "A-R1-3: a long line of stderr … is not logged" and "at the
// cap of the tail its first line … is dropped" checked the error output only on the removed CLI testkit of the ensure;
// here on the production attached create (createAttached reads the tail with readableStderr), whose `detail` the ensure
// logs ("docker run failed: …").
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitorRunSpec } from '../core/remoteMonitor/monitorEngine';
import { engineApi, engineHijack } from './engineApi';
import { dockerEngine } from './engineClient';

const READY = 'Session Monitor started';
const ID = 'c0ffee'.repeat(10) + 'c0ff';
const SPEC: MonitorRunSpec = {
  name: 'devenv-session-monitor',
  image: 'sha256:' + 'a'.repeat(64),
  labels: { 'nimblescape.devenv.session-monitor': 'label' },
  restartPolicy: 'on-failure',
  network: 'none',
  log: { driver: 'json-file', maxSize: '1m', maxFile: '2' },
  mounts: { socket: '/var/run/docker.sock', volume: 'devenv-session-monitor', volumeTarget: '/state' },
  env: {},
  command: ['node'],
};

function frame(stream: 1 | 2, data: Buffer | string): Buffer {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

type Answer = { status: number; json?: unknown };

describe('createAttached: the readable end of the error output (review round 1 of cleanup PR #140)', () => {
  const servers: http.Server[] = [];
  const sockets: net.Socket[] = [];
  const folders: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  /** An engine: `create` and `start` answer those requests; `onInput` writes on the attach once the input line came. */
  async function serve(create: Answer, start: Answer = { status: 204 }, onInput: (socket: net.Socket) => void = () => {}) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-attach-pc4r1-'));
    folders.push(folder);
    const socketPath = path.join(folder, 'docker.sock');
    const urls: string[] = [];
    let markClosed: () => void = () => {};
    const attachClosed = new Promise<void>((resolve) => (markClosed = resolve));
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        urls.push(req.url ?? '');
        const given = (req.url ?? '').startsWith('/containers/create') ? create : (req.url ?? '').endsWith('/start') ? start : { status: 404, json: { message: 'unexpected' } };
        res.writeHead(given.status, { 'Content-Type': 'application/json' });
        res.end(given.json !== undefined ? JSON.stringify(given.json) : '');
      });
    });
    server.on('upgrade', (req, socket: net.Socket) => {
      sockets.push(socket);
      urls.push(req.url ?? '');
      socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      let input = '';
      socket.on('data', (chunk: Buffer) => {
        input += chunk.toString('utf8');
        if (input.endsWith('\n')) onInput(socket);
      });
      socket.on('error', () => {});
      socket.on('close', () => markClosed());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return { engine: dockerEngine(engineApi(socketPath), engineHijack(socketPath)), urls, attachClosed };
  }

  const CREATED = { status: 201, json: { Id: ID } };
  const options = (timeoutMs = 5_000) => ({ input: 'x\n', readyText: READY, timeoutMs });
  /** Writes the frames one by one, with a pause between them (separate reads). */
  const writeApart = (socket: net.Socket, frames: Buffer[], end = false) => {
    frames.forEach((data, at) => setTimeout(() => {
      socket.write(data);
      if (end && at === frames.length - 1) setTimeout(() => socket.end(), 20);
    }, at * 20));
  };


  it('a long line of the error output (the source line of an uncaught error) is not in the detail, the loader line is', async () => {
    const { engine } = await serve(CREATED, undefined, (socket) =>
      writeApart(socket, [frame(2, `/opt/devenv/monitor.js:1\n${'y'.repeat(3_000)}\n`), frame(2, 'devenv loader: x\n')], true),
    );
    const created = (await engine.createAttached(SPEC, options())) as { kind: string; detail: string };
    expect(created.kind).toBe('exited');
    expect(created.detail).toContain('devenv loader: x');
    expect(created.detail).not.toContain('yyyyyyyyyy');
  });

  it('at the cap of the tail its first line (the cut end of a longer one) is dropped, even when it is short', async () => {
    const rest = `${'short line\n'.repeat(300)}devenv loader: x\n`;
    const { engine } = await serve(CREATED, undefined, (socket) => writeApart(socket, [frame(2, `${'z'.repeat(10_000)}\n`), frame(2, rest)], true));
    const created = (await engine.createAttached(SPEC, options())) as { kind: string; detail: string };
    expect(created.kind).toBe('exited');
    expect(created.detail).toContain('short line\ndevenv loader: x');
    expect(created.detail).not.toContain('z');
  });
});
