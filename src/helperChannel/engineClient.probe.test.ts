// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I (PR A): what the probe and the sweep of the worker need from the port of the engine (DockerEngine), over
// the Engine API instead of the worker's own Docker CLI: the identity of the engine (`GET /info`) and the prune of the
// stopped containers by filters (`POST /containers/prune`). Against an HTTP server on a Unix socket that answers as the
// engine, as the other tests of engineClient.ts; the exact reading of an answer through a fake EngineApi.
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ENGINE_IDENTITY_LENGTH, SWEEP_FILTERS } from '../core/helperChannel/protocol';
import { EngineError } from '../core/worker/dockerEngine';
import { engineApi, engineHijack, type EngineAnswer, type EngineApi } from './engineApi';
import { dockerEngine } from './engineClient';

interface Call {
  method: string;
  url: string;
  body: string;
}

describe('the identity and the prune of the port over the Engine API (plan step 11I, PR A)', () => {
  const servers: http.Server[] = [];
  const folders: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  /** An engine whose requests `answer` serves (no answer: it holds the request); `closed`: requests ended before an answer. */
  async function serve(answer: (call: Call) => { status: number; json?: unknown; body?: string } | undefined) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-probe-'));
    folders.push(folder);
    const socketPath = path.join(folder, 'docker.sock');
    const calls: Call[] = [];
    const closed: Call[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const call = { method: req.method ?? '', url: req.url ?? '', body };
        calls.push(call);
        const given = answer(call);
        if (given === undefined) {
          res.on('close', () => closed.push(call));
          return;
        }
        res.writeHead(given.status, { 'Content-Type': 'application/json' });
        res.end(given.json !== undefined ? JSON.stringify(given.json) : (given.body ?? ''));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return { engine: dockerEngine(engineApi(socketPath), engineHijack(socketPath)), calls, closed };
  }

  /** The port over an EngineApi that answers each request with `answer` (the reading of an answer, exactly). */
  function fake(answer: EngineAnswer) {
    const requests: string[] = [];
    const api: EngineApi = async (request) => (requests.push(`${request.method} ${request.path}`), answer);
    return { engine: dockerEngine(api, engineHijack(path.join(os.tmpdir(), 'devenv-no-socket'))), requests };
  }

  describe('identity', () => {
    it('reads the ID and the root folder of the engine from /info, nothing else', async () => {
      const { engine, calls } = await serve(() => ({ status: 200, json: { ID: 'ABCD:EFGH', DockerRootDir: '/srv/docker&<data>', Containers: 3, Name: 'host' } }));
      expect(await engine.identity()).toEqual({ id: 'ABCD:EFGH', rootDir: '/srv/docker&<data>' });
      expect(calls).toEqual([{ method: 'GET', url: '/info', body: '' }]);
    });

    it('fails with an EngineError for an answer without a valid identity, and with the message and status of the engine', async () => {
      for (const json of [
        { DockerRootDir: '/var/lib/docker' },
        { ID: '', DockerRootDir: '/var/lib/docker' },
        { ID: 7, DockerRootDir: '/var/lib/docker' },
        { ID: 'id' },
        { ID: 'id', DockerRootDir: null },
        { ID: 'a'.repeat(MAX_ENGINE_IDENTITY_LENGTH + 1), DockerRootDir: '/var/lib/docker' },
        null,
        [],
      ]) {
        const { engine } = await serve(() => ({ status: 200, json }));
        await expect(engine.identity(), JSON.stringify(json)).rejects.toThrow(new EngineError('The engine answered /info without its ID and root folder.', 200));
      }
      const notJson = await serve(() => ({ status: 200, body: 'not json' }));
      await expect(notJson.engine.identity()).rejects.toBeInstanceOf(EngineError);
      const busy = await serve(() => ({ status: 500, json: { message: 'the daemon is busy' } }));
      await expect(busy.engine.identity()).rejects.toMatchObject({ name: 'EngineError', message: 'the daemon is busy', status: 500 });
    });

    it('a cancel ends the request with an AbortError', async () => {
      const { engine, closed } = await serve(() => undefined);
      const controller = new AbortController();
      const reading = engine.identity(controller.signal);
      setTimeout(() => controller.abort(), 20);
      await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
      for (let i = 0; i < 100 && closed.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(closed.map((call) => call.url)).toEqual(['/info']);
    });
  });

  describe('pruneContainers', () => {
    it('prunes with the filters as the Engine API takes them, without a body, and answers the IDs that it removed', async () => {
      const ids = ['a'.repeat(64), 'b'.repeat(64)];
      const { engine, calls } = await serve(() => ({ status: 200, json: { ContainersDeleted: [...ids, '', 7], SpaceReclaimed: 1024 } }));
      expect(await engine.pruneContainers(SWEEP_FILTERS)).toEqual(ids);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: 'POST', body: '' });
      // The filters of the sweep: the label of the channels with any value, and the age, exactly (no other filter).
      expect(decodeURIComponent(calls[0].url)).toBe('/containers/prune?filters={"label":["nimblescape.devenv.helper-channel"],"until":["10m"]}');
      const none = await serve(() => ({ status: 200, json: { ContainersDeleted: null, SpaceReclaimed: 0 } }));
      expect(await none.engine.pruneContainers({ label: ['x=y'] })).toEqual([]);
    });

    it('fails with the message and status of the engine, for example a prune that runs already', async () => {
      const { engine } = await serve(() => ({ status: 409, json: { message: 'a prune operation is already running' } }));
      await expect(engine.pruneContainers(SWEEP_FILTERS)).rejects.toMatchObject({ name: 'EngineError', message: 'a prune operation is already running', status: 409 });
    });

    it('fails for an answer that it cannot read', async () => {
      for (const body of ['not json', '{}', '{"ContainersDeleted":"a"}', '{"ContainersDeleted":{}}', 'null', '[]']) {
        const { engine, requests } = fake({ status: 200, body, truncated: false });
        await expect(engine.pruneContainers(SWEEP_FILTERS), body).rejects.toThrow(new EngineError('The engine answered the prune of the containers with an invalid value.', 200));
        expect(requests).toEqual([`POST /containers/prune?filters=${encodeURIComponent(JSON.stringify(SWEEP_FILTERS))}`]);
      }
      const truncated = fake({ status: 200, body: '{"ContainersDeleted":["a', truncated: true });
      await expect(truncated.engine.pruneContainers(SWEEP_FILTERS)).rejects.toThrow(new EngineError('The engine answered the prune of the containers with more than can be read.', 200));
    });

    it('a cancel ends the request with an AbortError, also one cancelled before it starts', async () => {
      const { engine, calls, closed } = await serve(() => undefined);
      const controller = new AbortController();
      const pruning = engine.pruneContainers(SWEEP_FILTERS, controller.signal);
      for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await expect(pruning).rejects.toMatchObject({ name: 'AbortError' });
      for (let i = 0; i < 100 && closed.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(closed).toHaveLength(1);
      await expect(engine.pruneContainers(SWEEP_FILTERS, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toHaveLength(1);
    });
  });
});
