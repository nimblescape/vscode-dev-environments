// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #102 (B, mutation probes): the masker of an exec gives back the tail that it held because it
// could start a secret, reads the secrets of the operation at each push (a secret that comes during the exec is masked
// from then on), and gives back the end of the decoder after holding it.
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { engineApi, engineHijack } from './engineApi';
import { dockerEngine } from './engineClient';

/** A frame of the engine: the stream, three zero bytes, the length, the data. */
function frame(stream: 1 | 2, content: string | Buffer): Buffer {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

describe('the mask of the output of an exec (review round 2 of PR #102, B)', () => {
  const servers: http.Server[] = [];
  const sockets: net.Socket[] = [];
  const folders: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  /** An engine whose exec runs `write` once its input ended; `masked` is read at each call, as maskedValues. */
  async function serve(write: (socket: net.Socket) => void, masked: string[]) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-mask2-'));
    folders.push(folder);
    const socketPath = path.join(folder, 'docker.sock');
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(req.url?.endsWith('/exec') ? 201 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url?.endsWith('/exec') ? { Id: 'exec-1' } : { ExitCode: 0, Running: false }));
      });
    });
    server.on('upgrade', (_req, socket: net.Socket) => {
      sockets.push(socket);
      socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      socket.on('data', () => {});
      socket.on('end', () => write(socket));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return dockerEngine(engineApi(socketPath), engineHijack(socketPath), () => undefined, () => masked);
  }

  it('gives back at the end a short tail that could have started a secret, and masks a longer one (the flush)', async () => {
    const secret = 'ghp_' + 'F'.repeat(36);
    const engine = await serve((socket) => socket.end(Buffer.concat([frame(1, 'out: ghp'), frame(2, 'err: ghp_F')])), [secret]);
    const seen: string[] = [];
    const result = await engine.exec('c1', ['cat'], { onOutput: (stream, text) => seen.push(`${stream}:${text}`) });
    expect(result.stdout).toBe('out: ghp');
    // Adapted to the fix of A-M1 in the same round: a held tail of MIN_SECRET_LENGTH characters or more is masked at the
    // flush (before: 'err: ghp_F'); a shorter one ('ghp') passes as it is.
    expect(result.stderr).toBe('err: ***');
    const of = (stream: string) => seen.filter((text) => text.startsWith(`${stream}:`)).map((text) => text.slice(stream.length + 1)).join('');
    expect(of('stdout')).toBe('out: ghp');
    expect(of('stderr')).toBe('err: ***');
  });

  it('masks a secret that the operation gets while the exec runs, from then on', async () => {
    const late = 'late-secret-' + 'L'.repeat(20);
    const masked: string[] = [];
    const engine = await serve((socket) => {
      socket.write(frame(1, 'first\n'));
      setTimeout(() => socket.end(frame(1, `${late}\n`)), 100);
    }, masked);
    const result = await engine.exec('c1', ['cat'], {
      onOutput: (_stream, text) => {
        // As an answer to a request of the operation would: its secret joins maskedValues.
        if (text.includes('first')) masked.push(late);
      },
    });
    expect(result.stdout).toBe('first\n***\n');
  });

  it('gives back the end of the decoder also when the masker holds it (a secret that starts with U+FFFD)', async () => {
    const secret = '�' + 'Z'.repeat(20);
    // An incomplete UTF-8 sequence at the end: the decoder ends it with U+FFFD, which could start the secret.
    const engine = await serve((socket) => socket.end(frame(1, Buffer.concat([Buffer.from('abc'), Buffer.from([0xe2])]))), [secret]);
    const result = await engine.exec('c1', ['cat']);
    expect(result.stdout).toBe('abc�');
  });
});
