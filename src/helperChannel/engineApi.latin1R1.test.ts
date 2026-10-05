// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #114 (A-L3): a read of a file of an image (`latin1`) ends at the bound of an answer at once, and
// the connection is closed, instead of reading the rest of a large answer until its time limit.
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ENGINE_ANSWER_CHARACTERS, engineApi } from './engineApi';

describe('engineApi with latin1 (review round 1 of PR #114, A-L3)', () => {
  const servers: http.Server[] = [];
  const folders: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  it('answers a truncated body once it passed the bound, while the engine still sends, and closes the connection', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-latin1-'));
    folders.push(folder);
    const socketPath = path.join(folder, 'docker.sock');
    let closed = false;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-tar' });
      const chunk = Buffer.alloc(256 * 1024, 0xe4);
      // Endless: only the bound of the reader ends the answer.
      const timer = setInterval(() => res.write(chunk), 1);
      res.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const answer = await engineApi(socketPath)({ method: 'GET', path: '/containers/x/archive?path=%2Fetc%2Fpasswd', latin1: true, signal: AbortSignal.timeout(20_000) });
    expect(answer.truncated).toBe(true);
    expect(answer.body.length).toBe(MAX_ENGINE_ANSWER_CHARACTERS);
    // latin1: one character per byte.
    expect(answer.body.charCodeAt(0)).toBe(0xe4);
    for (let i = 0; i < 100 && !closed; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(true);
  });
});
