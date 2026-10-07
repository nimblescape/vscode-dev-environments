// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11G3, review B (mutation testing): `pause` of a hijacked stream stops the reading of the engine's output
// (no frame reaches onFrame until `resume`), so that the batch helper's output waits in the engine while the connection
// of the extension is congested instead of piling up in the worker.
import * as fs from 'fs';
import * as http from 'http';
import type * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { engineHijack } from './engineApi';

function frame(kind: 1 | 2, text: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = kind;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the pause of a hijacked stream (plan step 11G3, review B)', () => {
  const servers: http.Server[] = [];
  const folders: string[] = [];
  const sockets: net.Socket[] = [];
  afterEach(async () => {
    // An upgraded connection is no longer one of the server's: ended here.
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  it('reads no output while paused, and all of it after the resume', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-pause-'));
    folders.push(folder);
    const socketPath = path.join(folder, 'docker.sock');
    let engineSide: net.Socket | undefined;
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on('upgrade', (_req, socket: net.Socket) => {
      engineSide = socket;
      sockets.push(socket);
      socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const received: string[] = [];
    const stream = await engineHijack(socketPath)({ path: '/containers/x/attach?stream=1&stdin=1&stdout=1&stderr=1', onFrame: (_kind, data) => received.push(data.toString('utf8')) });
    for (let i = 0; i < 100 && engineSide === undefined; i++) await tick(5);
    engineSide!.write(frame(1, 'before'));
    for (let i = 0; i < 100 && received.length === 0; i++) await tick(5);
    expect(received).toEqual(['before']);
    stream.pause?.();
    engineSide!.write(frame(1, 'while paused'));
    await tick(150);
    expect(received).toEqual(['before']);
    stream.resume?.();
    for (let i = 0; i < 100 && received.length < 2; i++) await tick(5);
    expect(received).toEqual(['before', 'while paused']);
    stream.destroy();
  });
});
