// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #126 (reviewer B), mutation probe of the bound of an answer (src/helperChannel/engineApi.ts,
// `maxCharacters` of review round 1 of PR #126, F2): an answer of exactly its bound is whole, not cut (mutant A8: `>=` in
// place of `>`, so such an answer counts as truncated and a list of exactly that size fails as "more than can be read").
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ENGINE_ANSWER_CHARACTERS, engineApi } from './engineApi';

describe('the bound of an answer of the Engine API (review round 2 of PR #126, B)', () => {
  const servers: http.Server[] = [];
  const folders: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  // Kills A8: the bound is the most text that is kept, so an answer of exactly that many characters is kept whole and is
  // not truncated, with a bound of the request and with the default bound.
  it('keeps an answer of exactly its bound whole: not truncated (A8)', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-bound-'));
    folders.push(folder);
    const socketPath = path.join(folder, 'docker.sock');
    const OWN = 2 * 1024 * 1024;
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end((req.url === '/own' ? 'o' : 'd').repeat(req.url === '/own' ? OWN : MAX_ENGINE_ANSWER_CHARACTERS));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const engine = engineApi(socketPath);
    const own = await engine({ method: 'GET', path: '/own', maxCharacters: OWN });
    expect(own.truncated).toBe(false);
    expect(own.body).toHaveLength(OWN);
    const plain = await engine({ method: 'GET', path: '/default' });
    expect(plain.truncated).toBe(false);
    expect(plain.body).toHaveLength(MAX_ENGINE_ANSWER_CHARACTERS);
    // One character more is cut at the bound.
    const over = await engine({ method: 'GET', path: '/own', maxCharacters: OWN - 1 });
    expect(over.truncated).toBe(true);
    expect(over.body).toHaveLength(OWN - 1);
  });
});
