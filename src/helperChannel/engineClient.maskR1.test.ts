// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #102 (B, mutation probes): the mask of the secret input of an exec keeps a whole secret that
// starts at the limit (pulled in by the mask of an earlier one), keeps across frames a secret that the first frame fills up to the limit, cuts a
// masked stream that holds no secret, and masks the output of an exec that ends at its time limit.
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_TOKEN } from '../core/helperChannel/protocol';
import { engineApi, engineHijack } from './engineApi';
import { dockerEngine, MAX_EXEC_OUTPUT_CHARACTERS } from './engineClient';

const SECRET = 'ghp_' + 'S'.repeat(36);

/** A frame of the engine: the stream, three zero bytes, the length, the data. */
function frame(stream: 1 | 2, text: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

describe('the mask of the secret input of an exec (review round 1 of PR #102, B)', () => {
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

  /** An engine whose exec writes `output` once its input ended; `hangInspect` leaves the inspect without an answer. */
  async function serve(output: Buffer, hangInspect = false) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-mask-'));
    folders.push(folder);
    const socketPath = path.join(folder, 'docker.sock');
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url?.endsWith('/exec')) {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: 'exec-1' }));
        } else if (!hangInspect) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ExitCode: 0, Running: false }));
        }
      });
    });
    server.on('upgrade', (req, socket: net.Socket) => {
      sockets.push(socket);
      socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      socket.on('data', () => {});
      socket.on('end', () => socket.end(output));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return dockerEngine(engineApi(socketPath), engineHijack(socketPath), (name) => (name === SECRET_TOKEN ? SECRET : undefined));
  }

  it('a whole secret that starts at MAX is masked, and the mask of an earlier one pulls it in', async () => {
    const filler = 'a'.repeat(MAX_EXEC_OUTPUT_CHARACTERS - SECRET.length);
    const engine = await serve(Buffer.concat([frame(1, `${SECRET}${filler}${SECRET}tail`), frame(2, `${SECRET}${filler}${SECRET}`)]));
    const result = await engine.exec('c1', ['cat'], { secretInputName: SECRET_TOKEN });
    // Adapted to the fix of A-H1 in the same round (masked as it comes): the masked text is shorter than the limit, so
    // nothing of it is cut (the probe was written for the window MAX + the length of the secret, which lost `tail`).
    expect(result.stdout).toBe(`***${filler}***tail`);
    expect(result.stderr).toBe(`***${filler}***`);
  });

  it('keeps the rest of a secret that a later frame brings once the stream holds MAX_EXEC_OUTPUT_CHARACTERS', async () => {
    const before = 'a'.repeat(MAX_EXEC_OUTPUT_CHARACTERS - 10);
    const engine = await serve(Buffer.concat([frame(1, before + SECRET.slice(0, 10)), frame(1, `${SECRET.slice(10)}tail`)]));
    const result = await engine.exec('c1', ['cat'], { secretInputName: SECRET_TOKEN });
    expect(result.stdout).toBe(`${before}***tail`);
  });

  it('cuts each stream to MAX_EXEC_OUTPUT_CHARACTERS also with a secret input that the output does not hold', async () => {
    const big = 'x'.repeat(MAX_EXEC_OUTPUT_CHARACTERS + 10);
    const engine = await serve(Buffer.concat([frame(1, big), frame(2, big)]));
    const result = await engine.exec('c1', ['cat'], { secretInputName: SECRET_TOKEN });
    expect(result.stdout).toBe(big.slice(0, MAX_EXEC_OUTPUT_CHARACTERS));
    expect(result.stderr).toBe(big.slice(0, MAX_EXEC_OUTPUT_CHARACTERS));
  });

  it('masks the output of an exec that ends at its time limit', async () => {
    const engine = await serve(Buffer.concat([frame(1, `in:${SECRET}`), frame(2, `err:${SECRET}`)]), true);
    const result = await engine.exec('c1', ['cat'], { secretInputName: SECRET_TOKEN, timeoutMs: 300 });
    expect(result).toEqual({ exitCode: null, stdout: 'in:***', stderr: 'err:***', timedOut: true });
  });
});
