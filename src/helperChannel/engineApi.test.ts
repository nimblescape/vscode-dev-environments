// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 10A: the Engine API of the worker over its socket (engineApi.ts), and the pull over it through the port of
// the engine (DockerEngine.pull, plan step 11B3). Plan step 11I1, PR B1: moved here from engineOperations.test.ts, whose
// operations `pull` and `startContainers` were removed (the worker's flows pull through the port themselves); the cases of
// the pull that do not depend on those operations now call DockerEngine.pull directly.
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_REGISTRY, pullReference } from '../core/helperChannel/protocol';
import type { EnginePullLogin } from '../core/worker/dockerEngine';
import { engineApi, engineErrorMessage, MAX_ENGINE_ANSWER_CHARACTERS, MAX_ENGINE_LIST_ANSWER_CHARACTERS, type EngineAnswer, type EngineApi, type EngineRequest } from './engineApi';
import { dockerEngine, pullLine, registryAuthHeader } from './engineClient';

/** The port of the engine over the fake Engine API, with the registry secret `secret` (SECRET_REGISTRY) if any. */
function engineWith(api: EngineApi, secret?: string) {
  return dockerEngine(api, undefined, (name) => (name === SECRET_REGISTRY ? secret : undefined));
}

/** The login of a pull with the registry secret (as the flows of the worker pass it). */
function login(serveraddress: string, user: { username: string } | { identityToken: true }): EnginePullLogin {
  return { serveraddress, ...user, secretName: SECRET_REGISTRY };
}

/** An EngineApi that records the requests and answers with `answer` (a stream as chunks through onChunk). */
function fakeEngine(answer: (request: EngineRequest) => { status: number; chunks?: string[]; body?: string }) {
  const requests: EngineRequest[] = [];
  const engine: EngineApi = async (request) => {
    requests.push(request);
    const { status, chunks = [], body = '' } = answer(request);
    if (request.onChunk) for (const chunk of chunks) request.onChunk(chunk);
    return { status, body: request.onChunk ? '' : body || chunks.join(''), truncated: false };
  };
  return { engine, requests };
}

const LINES = [
  '{"status":"Pulling from library/alpine","id":"3.20"}\n{"status":"Pulling fs layer","progressDetail":{},"id":"a1b2"}\n',
  '{"status":"Downloading","progressDetail":{"current":10,"total":100},"progress":"[=> ]","id":"a1b2"}\n{"status":"Download complete","progressDetail":{},"id":"a1',
  'b2"}\n{"status":"Digest: sha256:abc"}\n{"status":"Status: Downloaded newer image for alpine:3.20"}\n',
];

describe('pullReference (plan step 10A)', () => {
  it('adds latest only without a tag or a digest', () => {
    expect(pullReference('alpine')).toBe('alpine:latest');
    expect(pullReference('localhost:5000/team/app')).toBe('localhost:5000/team/app:latest');
    expect(pullReference('ghcr.io/o/i:1')).toBe('ghcr.io/o/i:1');
    expect(pullReference(`alpine@sha256:${'a'.repeat(64)}`)).toBe(`alpine@sha256:${'a'.repeat(64)}`);
  });
});

// Plan step 11I1, PR B1: these cases called the removed operation `pull`; they now call DockerEngine.pull, which that
// operation ran (plan step 11B3). The checks of the operation itself (its parameters, its secret names, its log lines,
// its message with the seconds) are gone with it.
describe('the pull over the Engine API (plan step 10A)', () => {
  it('pulls by POST /images/create without credentials, and gives the lines of docker pull without the progress bars', async () => {
    const { engine, requests } = fakeEngine(() => ({ status: 200, chunks: LINES }));
    const lines: string[] = [];
    await engineWith(engine).pull('alpine:3.20', { onLine: (line) => lines.push(line) });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/images/create?fromImage=alpine%3A3.20', headers: {} });
    expect(lines).toEqual(['3.20: Pulling from library/alpine', 'a1b2: Pulling fs layer', 'a1b2: Download complete', 'Digest: sha256:abc', 'Status: Downloaded newer image for alpine:3.20']);
  });

  it('sends the password only in X-Registry-Auth, never in the path', async () => {
    const { engine, requests } = fakeEngine(() => ({ status: 200, chunks: LINES }));
    await engineWith(engine, 's3cret-password').pull('ghcr.io/o/i:1', { login: login('ghcr.io', { username: 'octo' }) });
    const header = requests[0].headers?.['X-Registry-Auth'];
    expect(header).toBe(registryAuthHeader({ username: 'octo', password: 's3cret-password', serveraddress: 'ghcr.io' }));
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({ username: 'octo', password: 's3cret-password', serveraddress: 'ghcr.io' });
    expect(requests[0].path).not.toContain('s3cret');
  });

  // Review round 1 of PR #89 (B-R1-12): the last line of the stream counts also without a final line feed.
  it('fails with an error in the last line of the stream, also without a final line feed', async () => {
    const { engine } = fakeEngine(() => ({ status: 200, chunks: ['{"status":"x"}\n{"errorDetail":{"message":"denied"}}'] }));
    await expect(engineWith(engine).pull('alpine:1')).rejects.toThrow('denied');
  });

  // Review round 1 of PR #89 (A-R1-1): the engine decodes the header with Go's base64.URLEncoding, which needs the padding.
  it('registryAuthHeader is URL-safe Base64 with its padding, for every length', () => {
    // Review round 2 of 11B3a (B-R2-2): '???' and '~~~' give a `/` and a `+` in Base64, which must not stay.
    for (const password of ['p', 'pa', 'pas', 'pass+/?~', '???', '~~~']) {
      const header = registryAuthHeader({ username: 'u', password, serveraddress: 'ghcr.io' });
      const json = JSON.stringify({ username: 'u', password, serveraddress: 'ghcr.io' });
      expect(header).toBe(Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
      expect(header.length % 4).toBe(0);
      expect(header).toMatch(/^[A-Za-z0-9_-]+={0,2}$/);
    }
  });

  // Review round 1 of PR #89 (A-R1-3): an identity token of `docker login` goes as `identitytoken`.
  it('sends an identity token as identitytoken with the server, without a user', async () => {
    const { engine, requests } = fakeEngine(() => ({ status: 200, chunks: LINES }));
    await engineWith(engine, 'refresh-token-1').pull('reg.example/o/i:1', { login: login('reg.example', { identityToken: true }) });
    expect(JSON.parse(Buffer.from(requests[0].headers!['X-Registry-Auth'], 'base64url').toString('utf8'))).toEqual({ identitytoken: 'refresh-token-1', serveraddress: 'reg.example' });
  });

  it('fails with the error of the stream, and with the message of an error answer', async () => {
    const streamed = fakeEngine(() => ({ status: 200, chunks: ['{"status":"Pulling from o/i","id":"1"}\n{"errorDetail":{"message":"denied: no access"},"error":"denied"}\n'] }));
    await expect(engineWith(streamed.engine).pull('ghcr.io/o/i:1')).rejects.toThrow('denied: no access');
    const refused = fakeEngine(() => ({ status: 404, chunks: ['{"message":"pull access denied for nope"}\n'] }));
    await expect(engineWith(refused.engine).pull('nope:1')).rejects.toThrow(/pull access denied for nope$/);
  });

  it('passes the signal to the request', async () => {
    const { engine, requests } = fakeEngine(() => ({ status: 200 }));
    const controller = new AbortController();
    await engineWith(engine).pull('alpine:1', { signal: controller.signal });
    expect(requests[0].signal).toBe(controller.signal);
  });

  it('pullLine: the line of docker pull, or nothing for a progress bar', () => {
    expect(pullLine({ status: 'Downloading', progressDetail: { current: 1 }, id: 'x' })).toBeUndefined();
    expect(pullLine({ status: 'Waiting', progressDetail: {}, id: 'x' })).toBe('x: Waiting');
    expect(pullLine({ status: 'Digest: sha256:1' })).toBe('Digest: sha256:1');
    expect(pullLine({ id: 'x' })).toBeUndefined();
  });
});

describe('engineApi over a Unix socket (plan step 10A)', () => {
  const servers: http.Server[] = [];
  let folder: string | undefined;

  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (folder !== undefined) fs.rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  });

  async function serve(handler: http.RequestListener): Promise<EngineApi> {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-engine-'));
    const socket = path.join(folder, 'docker.sock');
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return engineApi(socket);
  }

  it('sends the method, the path, the headers, and a JSON body; answers with the status and the text', async () => {
    const seen: { method?: string; url?: string; auth?: string | string[]; type?: string | string[]; body: string }[] = [];
    const engine = await serve((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers['x-registry-auth'], type: req.headers['content-type'], body });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end('{"Id":"x"}');
      });
    });
    const answer = await engine({ method: 'POST', path: '/containers/create?name=a', headers: { 'X-Registry-Auth': 'abc' }, json: { Image: 'alpine' } });
    expect(answer).toEqual({ status: 201, body: '{"Id":"x"}', truncated: false });
    expect(seen).toEqual([{ method: 'POST', url: '/containers/create?name=a', auth: 'abc', type: 'application/json', body: '{"Image":"alpine"}' }]);
  });

  it('streams the answer through onChunk, and cuts a long answer', async () => {
    const engine = await serve((req, res) => {
      res.writeHead(200);
      if (req.url === '/long') res.end('x'.repeat(MAX_ENGINE_ANSWER_CHARACTERS + 10));
      else {
        res.write('a\n');
        res.end('b\n');
      }
    });
    const chunks: string[] = [];
    const streamed = await engine({ method: 'GET', path: '/stream', onChunk: (text) => chunks.push(text) });
    expect(streamed.body).toBe('');
    expect(chunks.join('')).toBe('a\nb\n');
    const long = await engine({ method: 'GET', path: '/long' });
    expect(long.truncated).toBe(true);
    expect(long.body).toHaveLength(MAX_ENGINE_ANSWER_CHARACTERS);
  });

  // Review round 1 of PR #126 (F2): a request may name a larger bound (the lists of every container or image of an engine,
  // as the Session Monitor reads them, up to MAX_ENGINE_LIST_ANSWER_CHARACTERS, as the 16 MiB buffer of the Docker CLI it
  // ran before); every other request keeps MAX_ENGINE_ANSWER_CHARACTERS.
  it('keeps the bound of its request: a list reads past 1 MiB, and is cut at its own bound (review round 1 of PR #126, F2)', async () => {
    const engine = await serve((req, res) => {
      res.writeHead(200);
      res.end(req.url === '/three' ? 'y'.repeat(3 * 1024 * 1024) : 'x'.repeat(MAX_ENGINE_ANSWER_CHARACTERS + 10));
    });
    expect(MAX_ENGINE_LIST_ANSWER_CHARACTERS).toBe(16 * 1024 * 1024);
    const listed = await engine({ method: 'GET', path: '/long', maxCharacters: MAX_ENGINE_LIST_ANSWER_CHARACTERS });
    expect(listed.truncated).toBe(false);
    expect(listed.body).toHaveLength(MAX_ENGINE_ANSWER_CHARACTERS + 10);
    const bounded = await engine({ method: 'GET', path: '/three', maxCharacters: 2 * 1024 * 1024 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.body).toHaveLength(2 * 1024 * 1024);
    // Without a bound of its own: the default.
    const plain = await engine({ method: 'GET', path: '/three' });
    expect(plain.truncated).toBe(true);
    expect(plain.body).toHaveLength(MAX_ENGINE_ANSWER_CHARACTERS);
  });

  it('rejects with an AbortError when the signal aborts, and with the error of a missing socket', async () => {
    const engine = await serve(() => {
      // Never answers.
    });
    const controller = new AbortController();
    const pending = engine({ method: 'GET', path: '/hang', signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const aborted = new AbortController();
    aborted.abort();
    await expect(engine({ method: 'GET', path: '/x', signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(engineApi(path.join(folder!, 'missing.sock'))({ method: 'GET', path: '/x' })).rejects.toThrow(/ENOENT/);
  });

  it('engineErrorMessage: the message of the engine, else the status and the text', () => {
    const answer = (status: number, body: string): EngineAnswer => ({ status, body, truncated: false });
    expect(engineErrorMessage(answer(404, '{"message":"No such container: x"}'))).toBe('No such container: x');
    expect(engineErrorMessage(answer(500, 'oops'))).toBe('HTTP status 500: oops');
    expect(engineErrorMessage(answer(502, ''))).toBe('HTTP status 502');
  });
});
