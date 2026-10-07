// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11G3, review B (mutation testing): DockerEngine.runAttached reports a create that its own time limit ended
// as an EngineError (never as an AbortError, which the batch operation reads as a cancel), and removes a container whose
// start a cancel ended with a request that is not already aborted (the cancel signal would drop the removal, and a
// container that was created but never started is not removed by AutoRemove).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { batchRunSpec } from '../core/helperChannel/batch';
import { isAbortError } from '../core/ports';
import { EngineError } from '../core/worker/dockerEngine';
import type { EngineAnswer, EngineHijackRequest, EngineRequest, EngineStream } from './engineApi';
import { RUN_CLEANUP_TIMEOUT_MS, dockerEngine } from './engineClient';

const ID = 'c0ffee'.repeat(10) + 'c0ff';
const SPEC = batchRunSpec({ session: '0a1b2c3d4e5f60718293a4b5', volume: 'devenv-v', image: `sha256:${'a'.repeat(64)}`, socket: '/run/user/1000/docker.sock', scriptHash: 'f'.repeat(64) });

const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** A fake engine: `answer` gives the status of a request, or undefined to wait until its signal aborts. */
function fakeEngine(answer: (request: EngineRequest) => number | undefined) {
  const requests: Array<{ request: EngineRequest; abortedAtSend: boolean }> = [];
  const api = (request: EngineRequest): Promise<EngineAnswer> => {
    requests.push({ request, abortedAtSend: request.signal?.aborted === true });
    return new Promise<EngineAnswer>((resolve, reject) => {
      if (request.signal?.aborted) return reject(aborted());
      request.signal?.addEventListener('abort', () => reject(aborted()), { once: true });
      const status = answer(request);
      if (status === undefined) return;
      const body = request.path.startsWith('/containers/create') ? JSON.stringify({ Id: ID }) : '';
      queueMicrotask(() => resolve({ status, body, truncated: false }));
    });
  };
  const hijack = async (request: EngineHijackRequest): Promise<EngineStream> => {
    if (request.signal?.aborted) throw aborted();
    const ended = new Promise<void>(() => {});
    return { write: () => true, end: () => {}, ended, destroy: () => {} };
  };
  return { engine: dockerEngine(api, hijack), requests };
}

describe('runAttached (plan step 11G3, review B)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a create that does not answer within its own time limit rejects with an EngineError, not an AbortError', async () => {
    const limits: AbortController[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      if (ms !== RUN_CLEANUP_TIMEOUT_MS) return timeout(ms);
      const controller = new AbortController();
      limits.push(controller);
      return controller.signal;
    });
    const fake = fakeEngine((request) => (request.path.startsWith('/containers/create') ? undefined : 204));
    const operation = new AbortController();
    const failure = fake.engine.runAttached(SPEC, { signal: operation.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    // The create's own time limit ends (the operation was not cancelled).
    const create = fake.requests[0].request;
    const limit = limits.find((controller) => controller.signal === create.signal);
    expect(limit).toBeDefined();
    limit!.abort();
    const error = await failure;
    expect(isAbortError(error)).toBe(false);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ status: 0 });
    expect((error as Error).message).toContain('did not answer the create');
  });

  it('a cancel during the start removes the created container with a request that the cancel did not already end', async () => {
    const operation = new AbortController();
    const fake = fakeEngine((request) => {
      if (request.path.startsWith('/containers/create')) return 201;
      if (request.path.endsWith('/start')) {
        operation.abort();
        return undefined;
      }
      if (request.path.includes('/wait')) return undefined;
      return 204;
    });
    const failure = await fake.engine.runAttached(SPEC, { signal: operation.signal }).catch((error: unknown) => error);
    expect(isAbortError(failure)).toBe(true);
    const removals = fake.requests.filter(({ request }) => request.method === 'DELETE');
    expect(removals.map(({ request }) => request.path)).toEqual([`/containers/${ID}?force=true&v=true`]);
    expect(removals[0].abortedAtSend).toBe(false);
    expect(removals[0].request.signal).toBeDefined();
    expect(removals[0].request.signal).not.toBe(operation.signal);
  });
});
