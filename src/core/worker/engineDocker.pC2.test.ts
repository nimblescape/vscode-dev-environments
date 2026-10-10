// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup after plan step 11 (PR C2, D2, behaviour change): EngineDocker.labelImage runs within the time limit of each
// call of EngineDocker (DOCKER_QUERY_TIMEOUT_MS), so that a stalled engine cannot hold the lock of the environment up to
// the time limit of the open; before, DockerEngine.labelImage got the signal of the operation only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCKER_QUERY_TIMEOUT_MS } from '../docker/dockerTimeouts';
import { EngineError, type DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { EngineDocker } from './engineDocker';

afterEach(() => {
  vi.restoreAllMocks();
});

/** An engine whose labelImage answers only its signal: it rejects with an AbortError when that aborts. */
function stalled(): { engine: DockerEngine; signals: (AbortSignal | undefined)[] } {
  const signals: (AbortSignal | undefined)[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    inspect: async () => ({ Id: 'sha256:old' }),
    labelImage: (_image, _labels, signal) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    },
  };
  return { engine, signals };
}

describe('EngineDocker.labelImage within the time limit of a call (PR C2, D2)', () => {
  it('a labelImage that the engine does not end fails with the time limit of a call, and the port gets that limit as its signal', async () => {
    // The time limit of a call (60 s) is shortened here; every other time limit stays.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => timeout(ms === DOCKER_QUERY_TIMEOUT_MS ? 20 : ms));
    const { engine, signals } = stalled();
    const labelled = new EngineDocker(engine).labelImage('img:1', { a: 'b' });
    await expect(labelled).rejects.toThrow(new EngineError(`The engine did not answer the labels of img:1 within ${DOCKER_QUERY_TIMEOUT_MS / 1000} s.`, 0));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('the cancel of the operation still reaches the port and passes as its AbortError', async () => {
    const { engine, signals } = stalled();
    const controller = new AbortController();
    const labelled = new EngineDocker(engine).labelImage('img:1', { a: 'b' }, controller.signal);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    // A signal of its own (the cancel and the time limit), not the one of the operation alone.
    expect(signals[0]).not.toBe(controller.signal);
    expect(signals[0]?.aborted).toBe(false);
    controller.abort();
    await expect(labelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals[0]?.aborted).toBe(true);
  });
});
