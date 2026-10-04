// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #101 (B, mutation probes): DockerEngine.tagImage over the Engine API: the split at the last
// colon, the encoding of the repository, a 200 answer, and the cancel.
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { engineApi, engineHijack } from './engineApi';
import { dockerEngine } from './engineClient';

describe('tagImage over the Engine API (review round 1 of PR #101, B)', () => {
  const servers: http.Server[] = [];
  const folders: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  async function serve(status: number) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-tag-'));
    folders.push(folder);
    const socketPath = path.join(folder, 'docker.sock');
    const urls: string[] = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        urls.push(req.url ?? '');
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(status >= 400 ? JSON.stringify({ message: 'refused' }) : '');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return { engine: dockerEngine(engineApi(socketPath), engineHijack(socketPath)), urls };
  }

  it('splits the reference at its last colon and encodes the repository', async () => {
    const { engine, urls } = await serve(201);
    await engine.tagImage('sha256:aaa', 'devenv-monitor:x:0123456789ab');
    await engine.tagImage('sha256:aaa', 'devenv&monitor:0123456789ab');
    expect(urls).toEqual([
      '/images/sha256%3Aaaa/tag?repo=devenv-monitor%3Ax&tag=0123456789ab',
      '/images/sha256%3Aaaa/tag?repo=devenv%26monitor&tag=0123456789ab',
    ]);
  });

  it('accepts a 200 answer', async () => {
    const { engine, urls } = await serve(200);
    await expect(engine.tagImage('sha256:aaa', 'devenv-monitor:0123456789ab')).resolves.toBeUndefined();
    expect(urls).toHaveLength(1);
  });

  it('a cancelled tag is never sent', async () => {
    const { engine, urls } = await serve(201);
    const aborted = new AbortController();
    aborted.abort();
    await expect(engine.tagImage('sha256:aaa', 'devenv-monitor:0123456789ab', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(urls).toEqual([]);
  });
});
