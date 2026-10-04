// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #100 (B, mutation probes): the attached create over the Engine API (createAttached).
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

describe('createAttached probes (review round 1 of PR #100, B)', () => {
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
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-attach-r1-'));
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

  it('the conflict is only that of the status 409', async () => {
    const { engine } = await serve({ status: 500, json: { message: 'Conflict. The container name "/devenv-session-monitor" is already in use by container "abc".' } });
    expect(await engine.createAttached(SPEC, options())).toMatchObject({ kind: 'exited', conflict: false });
  });

  it('a create answered without an ID, or with an empty one, is exited and nothing is attached', async () => {
    for (const json of [{}, { Id: '' }]) {
      const { engine, urls } = await serve({ status: 201, json });
      expect(await engine.createAttached(SPEC, options())).toEqual({ kind: 'exited', detail: 'The engine answered the create of a container with an invalid value.', conflict: false });
      expect(urls).toHaveLength(1);
    }
  });

  it('the ready line across frames', async () => {
    const { engine } = await serve(CREATED, undefined, (socket) => writeApart(socket, [frame(1, 'Session Mon'), frame(1, 'itor started\n')]));
    expect(await engine.createAttached(SPEC, options())).toEqual({ kind: 'ready' });
  });

  it('a container that was started already (304) goes on to its ready line', async () => {
    const { engine } = await serve(CREATED, { status: 304 }, (socket) => socket.write(frame(1, `${READY}\n`)));
    expect(await engine.createAttached(SPEC, options())).toEqual({ kind: 'ready' });
  });

  it('the error output across frames (a character split between them too), its end only, or the fallback text', async () => {
    const umlaut = Buffer.from('ü', 'utf8');
    const split = await serve(CREATED, undefined, (socket) =>
      writeApart(socket, [frame(2, Buffer.concat([Buffer.from('loader: gr'), umlaut.subarray(0, 1)])), frame(2, Buffer.concat([umlaut.subarray(1), Buffer.from('n failed\n')]))], true),
    );
    expect(await split.engine.createAttached(SPEC, options())).toEqual({ kind: 'exited', detail: 'loader: grün failed', conflict: false });
    const lines = Array.from({ length: 60 }, (_unused, at) => `line ${String(at).padStart(2, '0')} ${'.'.repeat(90)}\n`);
    const long = await serve(CREATED, undefined, (socket) => writeApart(socket, lines.map((line) => frame(2, line)), true));
    const detail = (await long.engine.createAttached(SPEC, options())) as { detail: string };
    expect(detail.detail.length).toBeLessThanOrEqual(4_000);
    expect(detail.detail).toContain('line 59');
    expect(detail.detail).not.toContain('line 00');
    const silent = await serve(CREATED, undefined, (socket) => socket.end());
    expect(await silent.engine.createAttached(SPEC, options())).toEqual({ kind: 'exited', detail: 'the container ended before it reported its start', conflict: false });
  });

  it('the connection is closed after the ready line, and the time limit is cleared', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    // As the engine does after the input ended (StdinOnce), the output goes on: the client must close the connection.
    const { engine, attachClosed } = await serve(CREATED, undefined, (socket) => {
      socket.write(frame(1, `${READY}\n`));
      const timer = setInterval(() => (socket.destroyed ? clearInterval(timer) : socket.write(frame(1, 'still running\n'))), 20);
    });
    expect(await engine.createAttached(SPEC, options(4_321))).toEqual({ kind: 'ready' });
    const at = setSpy.mock.calls.findIndex((call) => call[1] === 4_321);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(clearSpy).toHaveBeenCalledWith(setSpy.mock.results[at].value);
    await attachClosed;
  });

  it('the time limit ends the wait at its time', async () => {
    const { engine } = await serve(CREATED);
    const begin = Date.now();
    expect(await engine.createAttached(SPEC, options(300))).toEqual({ kind: 'timeout' });
    expect(Date.now() - begin).toBeLessThan(2_000);
  });
});
