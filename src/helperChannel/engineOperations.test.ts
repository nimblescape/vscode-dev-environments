// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 10A (decision of 2026-10-03): the operations of the worker over the Engine API, `pull` and `startContainers`.
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePullParams, parseStartContainersParams, pullReference } from '../core/helperChannel/protocol';
import { engineApi, engineErrorMessage, MAX_ENGINE_ANSWER_CHARACTERS, type EngineAnswer, type EngineApi, type EngineRequest } from './engineApi';
import { pullLine, pullOperation, registryAuthHeader, startContainersOperation } from './engineOperations';
import { OperationError, type OperationContext } from './server';

function context(secret?: string, signal: AbortSignal = new AbortController().signal) {
  const logs: string[] = [];
  const out: string[] = [];
  const value: OperationContext = {
    signal,
    secret,
    progress: () => {},
    log: (text) => logs.push(text),
    output: (_stream, text) => out.push(text),
    docker: async () => {
      throw new Error('no docker process in an Engine API operation');
    },
  };
  return { context: value, logs, out };
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

describe('protocol of pull and startContainers (plan step 10A)', () => {
  it('pullReference adds latest only without a tag or a digest', () => {
    expect(pullReference('alpine')).toBe('alpine:latest');
    expect(pullReference('localhost:5000/team/app')).toBe('localhost:5000/team/app:latest');
    expect(pullReference('ghcr.io/o/i:1')).toBe('ghcr.io/o/i:1');
    expect(pullReference(`alpine@sha256:${'a'.repeat(64)}`)).toBe(`alpine@sha256:${'a'.repeat(64)}`);
  });

  it('parsePullParams takes a reference with a tag or a digest, and a user only with its server', () => {
    expect(parsePullParams({ reference: 'alpine:3.20' })).toEqual({ reference: 'alpine:3.20' });
    expect(parsePullParams({ reference: 'ghcr.io/o/i:1', username: 'u', serveraddress: 'ghcr.io' })).toEqual({ reference: 'ghcr.io/o/i:1', username: 'u', serveraddress: 'ghcr.io' });
    for (const value of [
      { reference: 'alpine' },
      { reference: '' },
      { reference: '-x:1' },
      { reference: 'a b:1' },
      { reference: 'x'.repeat(600) + ':1' },
      { reference: 'alpine:1', username: 'u' },
      { reference: 'alpine:1', serveraddress: 's' },
      { reference: 'alpine:1', username: '', serveraddress: 's' },
      { reference: 'alpine:1', username: 'u', serveraddress: 'a b' },
      { reference: 'alpine:1', password: 'p' },
      null,
    ]) {
      expect(parsePullParams(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('parseStartContainersParams takes 1 to 64 full container IDs', () => {
    const id = 'a'.repeat(64);
    expect(parseStartContainersParams({ ids: [id] })).toEqual({ ids: [id] });
    for (const value of [{ ids: [] }, { ids: ['abc'] }, { ids: [id.toUpperCase()] }, { ids: Array(65).fill(id) }, { ids: [id], x: 1 }, {}]) {
      expect(parseStartContainersParams(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe('pull (plan step 10A)', () => {
  it('pulls by POST /images/create without credentials, and prints the lines of docker pull without the progress bars', async () => {
    const { engine, requests } = fakeEngine(() => ({ status: 200, chunks: LINES }));
    const { context: ctx, out, logs } = context();
    expect(await pullOperation(engine)({ reference: 'alpine:3.20' }, ctx)).toEqual({});
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/images/create?fromImage=alpine%3A3.20', headers: {} });
    expect(out.join('')).toBe(
      ['3.20: Pulling from library/alpine', 'a1b2: Pulling fs layer', 'a1b2: Download complete', 'Digest: sha256:abc', 'Status: Downloaded newer image for alpine:3.20', ''].join('\n'),
    );
    expect(logs[0]).toBe('pull alpine:3.20');
    expect(logs[1]).toMatch(/^pull alpine:3\.20: done after \d+\.\d s$/);
  });

  it('sends the password only in X-Registry-Auth, never in the path or a log line', async () => {
    const { engine, requests } = fakeEngine(() => ({ status: 200, chunks: LINES }));
    const { context: ctx, logs } = context('s3cret-password');
    await pullOperation(engine)({ reference: 'ghcr.io/o/i:1', username: 'octo', serveraddress: 'ghcr.io' }, ctx);
    const header = requests[0].headers?.['X-Registry-Auth'];
    expect(header).toBe(registryAuthHeader('octo', 's3cret-password', 'ghcr.io'));
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({ username: 'octo', password: 's3cret-password', serveraddress: 'ghcr.io' });
    expect(requests[0].path).not.toContain('s3cret');
    expect(logs.join('\n')).not.toContain('s3cret');
    expect(logs[0]).toBe('pull ghcr.io/o/i:1 (with the credentials for ghcr.io)');
  });

  it('fails with the error of the stream, and with the message of an error answer', async () => {
    const streamed = fakeEngine(() => ({ status: 200, chunks: ['{"status":"Pulling from o/i","id":"1"}\n{"errorDetail":{"message":"denied: no access"},"error":"denied"}\n'] }));
    await expect(pullOperation(streamed.engine)({ reference: 'ghcr.io/o/i:1' }, context().context)).rejects.toThrow(/The pull of ghcr\.io\/o\/i:1 failed after \d+\.\d s: denied: no access/);
    const refused = fakeEngine(() => ({ status: 404, chunks: ['{"message":"pull access denied for nope"}\n'] }));
    const error = await pullOperation(refused.engine)({ reference: 'nope:1' }, context().context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('failed');
    expect((error as Error).message).toMatch(/pull access denied for nope$/);
  });

  it('refuses invalid parameters and a secret without a user (or a user without a secret), and sends nothing', async () => {
    const { engine, requests } = fakeEngine(() => ({ status: 200 }));
    for (const [params, secret] of [
      [{ reference: 'alpine' }, undefined],
      [{ reference: 'alpine:1' }, 'password'],
      [{ reference: 'alpine:1', username: 'u', serveraddress: 's' }, undefined],
    ] as const) {
      const error = await pullOperation(engine)(params, context(secret).context).catch((e: unknown) => e);
      expect((error as OperationError).code).toBe('invalid');
    }
    expect(requests).toEqual([]);
  });

  it('passes the signal of the operation to the request', async () => {
    const { engine, requests } = fakeEngine(() => ({ status: 200 }));
    const controller = new AbortController();
    await pullOperation(engine)({ reference: 'alpine:1' }, context(undefined, controller.signal).context);
    expect(requests[0].signal).toBe(controller.signal);
  });

  it('pullLine: the line of docker pull, or nothing for a progress bar', () => {
    expect(pullLine({ status: 'Downloading', progressDetail: { current: 1 }, id: 'x' })).toBeUndefined();
    expect(pullLine({ status: 'Waiting', progressDetail: {}, id: 'x' })).toBe('x: Waiting');
    expect(pullLine({ status: 'Digest: sha256:1' })).toBe('Digest: sha256:1');
    expect(pullLine({ id: 'x' })).toBeUndefined();
  });
});

describe('startContainers (plan step 10A)', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);

  it('starts each container in order; a running one (304) counts as started', async () => {
    const { engine, requests } = fakeEngine((request) => ({ status: request.path.includes(A) ? 204 : 304 }));
    expect(await startContainersOperation(engine)({ ids: [A, B] }, context().context)).toEqual({});
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ['POST', `/containers/${A}/start`],
      ['POST', `/containers/${B}/start`],
    ]);
  });

  it('fails with the message of the engine and stops there', async () => {
    const { engine, requests } = fakeEngine(() => ({ status: 500, body: '{"message":"port is already allocated"}' }));
    await expect(startContainersOperation(engine)({ ids: [A, B] }, context().context)).rejects.toThrow('The container aaaaaaaaaaaa could not be started: port is already allocated');
    expect(requests).toHaveLength(1);
  });

  it('refuses invalid IDs and a secret', async () => {
    const { engine, requests } = fakeEngine(() => ({ status: 204 }));
    await expect(startContainersOperation(engine)({ ids: ['c1'] }, context().context)).rejects.toMatchObject({ code: 'invalid' });
    await expect(startContainersOperation(engine)({ ids: [A] }, context('token').context)).rejects.toMatchObject({ code: 'invalid' });
    expect(requests).toEqual([]);
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
