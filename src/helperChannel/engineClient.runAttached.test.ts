// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11G3: the attached run of the batch helper over the Engine API (DockerEngine.runAttached, `docker run --rm -i`
// without a `docker` process of the worker), against a fake EngineApi and a fake EngineHijack: the exact create (every
// option of the former `docker run` of the helper, from batchRunSpec), the attach before the wait and the start, the
// input and the output of the process, its exit code from the wait, a refused create or start, the cancel before and
// after the start, and the kill (a stop, then the removal).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { batchRunSpec } from '../core/helperChannel/batch';
import { loaderCommand } from '../core/loader/pipeLoader';
import { isAbortError } from '../core/ports';
import { EngineError } from '../core/worker/dockerEngine';
import type { EngineAnswer, EngineHijackRequest, EngineRequest, EngineStream } from './engineApi';
import { ATTACHED_DRAIN_MS, ATTACHED_KILL_WAIT_MS, ATTACHED_STOP_SECONDS, RUN_CLEANUP_TIMEOUT_MS, dockerEngine } from './engineClient';

const SESSION = '0a1b2c3d4e5f60718293a4b5';
const ID = 'c0ffee'.repeat(10) + 'c0ff';
const IMAGE = `sha256:${'a'.repeat(64)}`;
const HASH = 'f'.repeat(64);
const SPEC = batchRunSpec({ session: SESSION, volume: 'devenv-v', image: IMAGE, socket: '/run/user/1000/docker.sock', scriptHash: HASH });

function frame(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

interface FakeStream extends EngineStream {
  request: EngineHijackRequest;
  input: string[];
  inputEnded: boolean;
  destroyed: boolean;
  paused: number;
  /** Ends the output cleanly (the container ended), or breaks the connection. */
  finish(error?: Error): void;
}

/**
 * A fake engine: `answer` serves the requests (an undefined answer waits until `respond` or the signal of the request);
 * the hijack of the attach gives a FakeStream.
 */
function fakeEngine(answer: (request: EngineRequest) => { status: number; json?: unknown } | undefined) {
  const requests: EngineRequest[] = [];
  const waiting = new Map<string, (answer: EngineAnswer) => void>();
  const streams: FakeStream[] = [];
  const order: string[] = [];
  const api = (request: EngineRequest): Promise<EngineAnswer> => {
    requests.push(request);
    order.push(`${request.method} ${request.path.split('?')[0]}`);
    return new Promise<EngineAnswer>((resolve, reject) => {
      if (request.signal?.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      const given = answer(request);
      if (given === undefined) {
        waiting.set(request.path.split('?')[0], resolve);
        return;
      }
      queueMicrotask(() => resolve({ status: given.status, body: given.json === undefined ? '' : JSON.stringify(given.json), truncated: false }));
    });
  };
  const hijack = async (request: EngineHijackRequest): Promise<EngineStream> => {
    order.push(`HIJACK ${request.path.split('?')[0]}`);
    if (request.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    let settle!: (error?: Error) => void;
    const ended = new Promise<void>((resolve, reject) => (settle = (error) => (error === undefined ? resolve() : reject(error))));
    ended.catch(() => undefined);
    const stream: FakeStream = {
      request,
      input: [],
      inputEnded: false,
      destroyed: false,
      paused: 0,
      write: (data) => (stream.input.push(data.toString()), true),
      end: () => void (stream.inputEnded = true),
      ended,
      destroy: () => {
        stream.destroyed = true;
        settle(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
      pause: () => void stream.paused++,
      resume: () => void stream.paused--,
      finish: (error) => settle(error),
    };
    streams.push(stream);
    return stream;
  };
  const respond = (path: string, status: number, json?: unknown) => {
    const resolve = waiting.get(path);
    if (resolve === undefined) throw new Error(`No request to ${path} waits.`);
    waiting.delete(path);
    resolve({ status, body: json === undefined ? '' : JSON.stringify(json), truncated: false });
  };
  return { engine: dockerEngine(api, hijack), requests, streams, order, respond, waits: () => [...waiting.keys()] };
}

/** The answers of an engine that runs the container: the create, the start, the stop and the removal; the wait waits. */
const running =
  (overrides: Record<string, { status: number; json?: unknown }> = {}) =>
  (request: EngineRequest): { status: number; json?: unknown } | undefined => {
    const path = request.path.split('?')[0];
    if (overrides[path] !== undefined) return overrides[path];
    if (path === '/containers/create') return { status: 201, json: { Id: ID } };
    if (path.endsWith('/wait')) return undefined;
    if (path.endsWith('/start')) return { status: 204 };
    if (path.endsWith('/stop')) return { status: 204 };
    if (request.method === 'DELETE') return { status: 204 };
    return { status: 500, json: { message: 'unexpected' } };
  };

describe('the attached run of the batch helper over the Engine API (plan step 11G3)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates it as `docker run --rm -i` of the helper did, attaches, registers the wait, and starts it', async () => {
    const fake = fakeEngine(running());
    const run = await fake.engine.runAttached(SPEC);
    expect(run.id).toBe(ID);
    expect(fake.order).toEqual(['POST /containers/create', `HIJACK /containers/${ID}/attach`, `POST /containers/${ID}/wait`, `POST /containers/${ID}/start`]);
    const [create, wait, start] = fake.requests;
    expect(create.path).toBe(`/containers/create?name=devenv-batch-${SESSION}`);
    // Every option of the former `docker run --rm -i --pull never` of the helper (batchRunArgs), as the CLI sends it.
    expect(create.json).toEqual({
      Image: IMAGE,
      Cmd: loaderCommand({ path: '/opt/devenv/batch.js', hash: HASH, entry: 'startBatchHelper' }),
      Labels: { 'nimblescape.devenv.helper-run': 'true', 'nimblescape.devenv.channel-step': SESSION },
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
      HostConfig: {
        AutoRemove: true,
        NetworkMode: 'default',
        LogConfig: { Type: 'none', Config: {} },
        SecurityOpt: ['no-new-privileges'],
        Mounts: [
          { Type: 'volume', Source: 'devenv-v', Target: '/workspaces' },
          { Type: 'volume', Source: 'devenv-helper-cache', Target: '/devenv-cache' },
          { Type: 'bind', Source: '/run/user/1000/docker.sock', Target: '/run/devenv-docker/docker.sock' },
        ],
        Tmpfs: { '/run/devenv-secrets': 'rw,noexec,nosuid,nodev,size=1m,mode=0700' },
      },
    });
    // No variable, no entrypoint of its own (tini of the image stays), no user, nothing privileged, no pull.
    const body = create.json as Record<string, unknown> & { HostConfig: Record<string, unknown> };
    for (const key of ['Env', 'Entrypoint', 'User']) expect(body[key]).toBeUndefined();
    for (const key of ['Privileged', 'CapAdd', 'Binds', 'PortBindings', 'Devices']) expect(body.HostConfig[key]).toBeUndefined();
    expect(fake.requests.some((request) => request.path.startsWith('/images/create'))).toBe(false);
    expect(fake.streams[0].request.path).toBe(`/containers/${ID}/attach?stream=1&stdin=1&stdout=1&stderr=1`);
    // The wait for its removal (as the CLI waits with `--rm`), before the start.
    expect(wait.path).toBe(`/containers/${ID}/wait?condition=removed`);
    expect(start.path).toBe(`/containers/${ID}/start`);
    run.process.kill();
  });

  it('carries the input and the output of the process, and its exit code once the engine removed it', async () => {
    const fake = fakeEngine(running());
    const run = await fake.engine.runAttached(SPEC);
    const stream = fake.streams[0];
    // Output before a listener is kept for it; a character split across frames is decoded whole.
    stream.request.onFrame(1, frame('hello '));
    const stdout: string[] = [];
    const stderr: string[] = [];
    run.process.onStdout((text) => stdout.push(text));
    run.process.onStderr((text) => stderr.push(text));
    const euro = Buffer.from('€', 'utf8');
    stream.request.onFrame(1, euro.subarray(0, 1));
    stream.request.onFrame(1, Buffer.concat([euro.subarray(1), frame('\n')]));
    stream.request.onFrame(2, frame('a warning\n'));
    expect(stdout.join('')).toBe('hello €\n');
    expect(stderr).toEqual(['a warning\n']);
    expect(run.process.write('"the script"\n')).toBe(true);
    expect(stream.input).toEqual(['"the script"\n']);
    run.process.end();
    expect(stream.inputEnded).toBe(true);
    // The input is closed: nothing more is written.
    expect(run.process.write('late')).toBe(false);
    run.pause();
    expect(stream.paused).toBe(1);
    run.resume();
    expect(stream.paused).toBe(0);
    let exited: unknown;
    void run.process.exited.then((value) => (exited = value));
    fake.respond(`/containers/${ID}/wait`, 200, { StatusCode: 3, Error: null });
    stream.finish();
    await vi.waitFor(() => expect(exited).toEqual({ exitCode: 3 }));
    expect(stream.destroyed).toBe(true);
    // It ended by itself: no stop and no removal of the worker.
    expect(fake.order.filter((entry) => entry.includes('/stop') || entry.startsWith('DELETE'))).toEqual([]);
  });

  it('a wait that fails gives no exit code but the failure; the rest of the output is waited for only ATTACHED_DRAIN_MS', async () => {
    const fake = fakeEngine(running());
    const run = await fake.engine.runAttached(SPEC);
    vi.useFakeTimers();
    let exited: { exitCode: number | null; error?: Error } | undefined;
    void run.process.exited.then((value) => (exited = value));
    fake.respond(`/containers/${ID}/wait`, 500, { message: 'the engine failed' });
    await vi.advanceTimersByTimeAsync(ATTACHED_DRAIN_MS - 1);
    expect(exited).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(exited?.exitCode).toBeNull();
    expect(exited?.error?.message).toBe('the engine failed');
    expect(fake.streams[0].destroyed).toBe(true);
  });

  it('refuses a create that the engine refuses (a name in use, a missing image) with its status, and attaches nothing', async () => {
    for (const [status, message] of [
      [409, 'Conflict. The container name "/devenv-batch-x" is already in use by container "abc".'],
      [404, 'No such image: sha256:aaaa'],
    ] as const) {
      const fake = fakeEngine(running({ '/containers/create': { status, json: { message } } }));
      const failure = await fake.engine.runAttached(SPEC).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(EngineError);
      expect(failure).toMatchObject({ status, message });
      expect(fake.order).toEqual(['POST /containers/create']);
    }
    const invalid = fakeEngine(running({ '/containers/create': { status: 201, json: {} } }));
    await expect(invalid.engine.runAttached(SPEC)).rejects.toMatchObject({ message: 'The engine answered the create of a container with an invalid value.' });
    expect(invalid.order).toEqual(['POST /containers/create']);
  });

  it('sends the create without the signal of the operation, within its own time limit', async () => {
    const controller = new AbortController();
    const fake = fakeEngine(running());
    const run = await fake.engine.runAttached(SPEC, { signal: controller.signal });
    const create = fake.requests[0];
    expect(create.signal).toBeDefined();
    expect(create.signal).not.toBe(controller.signal);
    expect(create.signal?.aborted).toBe(false);
    // The attach and the start end with the cancel; the wait does not (it reads the end of a killed run too).
    expect(fake.streams[0].request.signal).toBe(controller.signal);
    expect(fake.requests[2].signal).toBe(controller.signal);
    expect(fake.requests[1].signal).not.toBe(controller.signal);
    run.process.kill();
  });

  it('removes a created container whose start the engine refuses, ends its connection and its wait', async () => {
    const fake = fakeEngine(running({ [`/containers/${ID}/start`]: { status: 500, json: { message: 'invalid mount config' } } }));
    const failure = await fake.engine.runAttached(SPEC).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 500, message: 'invalid mount config' });
    expect(fake.streams[0].destroyed).toBe(true);
    expect(fake.requests[1].signal?.aborted).toBe(true);
    const removal = fake.requests[fake.requests.length - 1];
    expect(removal).toMatchObject({ method: 'DELETE', path: `/containers/${ID}?force=true&v=true` });
    expect(removal.signal).toBeDefined();
  });

  it('a cancel before the call sends nothing; a cancel during the create removes the created container and rejects with an AbortError', async () => {
    const before = fakeEngine(running());
    const aborted = new AbortController();
    aborted.abort();
    const refused = await before.engine.runAttached(SPEC, { signal: aborted.signal }).catch((error: unknown) => error);
    expect(isAbortError(refused)).toBe(true);
    expect(before.requests).toEqual([]);

    const controller = new AbortController();
    const during = fakeEngine((request) => {
      if (request.path.startsWith('/containers/create')) {
        // The cancel comes while the engine creates it: the create still answers (it has its own signal).
        controller.abort();
        return { status: 201, json: { Id: ID } };
      }
      return running()(request);
    });
    const cancelled = await during.engine.runAttached(SPEC, { signal: controller.signal }).catch((error: unknown) => error);
    expect(isAbortError(cancelled)).toBe(true);
    expect(during.order).toEqual(['POST /containers/create', `DELETE /containers/${ID}`]);
  });

  it('a cancel during the start removes the created container and rejects with an AbortError', async () => {
    const controller = new AbortController();
    const fake = fakeEngine((request) => {
      if (request.path.endsWith('/start')) {
        controller.abort();
        return undefined;
      }
      return running()(request);
    });
    const cancelled = await fake.engine.runAttached(SPEC, { signal: controller.signal }).catch((error: unknown) => error);
    expect(isAbortError(cancelled)).toBe(true);
    expect(fake.streams[0].destroyed).toBe(true);
    expect(fake.order[fake.order.length - 1]).toBe(`DELETE /containers/${ID}`);
  });

  it('a cancel after the start stops it (SIGTERM, SIGKILL after stopSeconds), removes it, and its exit follows', async () => {
    const controller = new AbortController();
    const fake = fakeEngine(running());
    const run = await fake.engine.runAttached(SPEC, { signal: controller.signal, stopSeconds: 5 });
    controller.abort();
    await vi.waitFor(() => expect(fake.order).toContain(`DELETE /containers/${ID}`));
    const stop = fake.requests.find((request) => request.path.includes('/stop'));
    expect(stop?.path).toBe(`/containers/${ID}/stop?t=5`);
    // Within a time limit of its own, never the cancel signal.
    expect(stop?.signal).not.toBe(controller.signal);
    expect(fake.order.indexOf(`POST /containers/${ID}/stop`)).toBeLessThan(fake.order.indexOf(`DELETE /containers/${ID}`));
    fake.respond(`/containers/${ID}/wait`, 200, { StatusCode: 143 });
    fake.streams[0].finish();
    expect(await run.process.exited).toEqual({ exitCode: 143 });
  });

  it('kill stops and removes it once (also when called again), with ATTACHED_STOP_SECONDS by default; a wait that never answers is ended', async () => {
    const fake = fakeEngine(running());
    const run = await fake.engine.runAttached(SPEC);
    vi.useFakeTimers();
    run.process.kill();
    run.process.kill();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.requests.filter((request) => request.path.includes('/stop')).map((request) => request.path)).toEqual([`/containers/${ID}/stop?t=${ATTACHED_STOP_SECONDS}`]);
    expect(fake.requests.filter((request) => request.method === 'DELETE').map((request) => request.path)).toEqual([`/containers/${ID}?force=true&v=true`]);
    let exited: { exitCode: number | null; error?: Error } | undefined;
    void run.process.exited.then((value) => (exited = value));
    await vi.advanceTimersByTimeAsync(ATTACHED_KILL_WAIT_MS + ATTACHED_DRAIN_MS);
    expect(exited?.exitCode).toBeNull();
    expect(exited?.error).toBeInstanceOf(Error);
    expect(RUN_CLEANUP_TIMEOUT_MS).toBe(60_000);
  });

  it('a connection that breaks while it runs ends it (stop and removal)', async () => {
    const fake = fakeEngine(running());
    await fake.engine.runAttached(SPEC);
    fake.streams[0].finish(new Error('The connection to the engine closed before the output ended.'));
    await vi.waitFor(() => expect(fake.order).toContain(`DELETE /containers/${ID}`));
    expect(fake.order).toContain(`POST /containers/${ID}/stop`);
  });
});
