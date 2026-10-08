// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #126 (reviewer B), mutation probes of src/helperChannel/engineClient.ts: the time limit of the
// lists of every container and image (DockerEngine.containerSummaries, mutant S4, and DockerEngine.images, mutant B5:
// the signal of the caller is not given to the request, so a list that the engine does not answer never ends) and of the
// stop that the Session Monitor runs under the lock of an environment (DockerEngine.stop, mutant P1, code from before
// this PR), and the bound of the other lists (mutant B6: a list other than containerSummaries and images gets the 16 MiB
// bound). Each test names the mutants it kills.
import { describe, expect, it } from 'vitest';
import { abortError } from '../core/ports';
import type { EngineAnswer, EngineApi, EngineRequest } from './engineApi';
import { dockerEngine } from './engineClient';

/**
 * The port over an Engine API in memory that never answers a request with a signal until that signal aborts (as the
 * Engine API of an engine that hangs, or the stop of a container whose lock a hung operation of it holds), and answers
 * `idle` at once to a request without a signal (what a call without a time limit would get from an engine that answers).
 */
function hangingEngine(idle: EngineAnswer) {
  const requests: EngineRequest[] = [];
  const api: EngineApi = async (request) => {
    requests.push(request);
    const signal = request.signal;
    if (signal === undefined) return idle;
    return new Promise<EngineAnswer>((_resolve, reject) => {
      if (signal.aborted) reject(abortError());
      else signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  };
  return { engine: dockerEngine(api, async () => Promise.reject(new Error('no exec in this test'))), requests };
}

/** What a list without a time limit gets at once from an engine that answers: an empty list. */
const LIST: EngineAnswer = { status: 200, body: '[]', truncated: false };

describe('the time limit of the lists and the stop of the Session Monitor (review round 2 of PR #126, B)', () => {
  // Kills S4: the loop gives each list LIST_TIMEOUT_MS (main.ts, tick and decideAgain); without the signal on the request
  // a list that the engine does not answer never ends, and the loop (`for (;;) await loop.tick()`) stops nothing on the
  // whole engine and never exits when idle, without a line in the log.
  it('containerSummaries gives its signal to the request, so the time limit ends a list that the engine does not answer (S4)', async () => {
    const { engine, requests } = hangingEngine(LIST);
    const limit = new AbortController();
    const listed = engine.containerSummaries('nimblescape.devenv.environment-id', limit.signal);
    limit.abort();
    await expect(listed).rejects.toMatchObject({ name: 'AbortError' });
    // The one request of the list got the signal (or one that ended with it).
    expect(requests.map((request) => request.signal?.aborted)).toEqual([true]);
  });

  // Kills B5: the image pass gives each list of the images IMAGE_LIST_TIMEOUT_MS (images.ts), and the worker its time limit
  // and its cancel (EngineDocker); without the signal on the request a list that the engine does not answer holds the
  // pass for ever, and every later pass and check of the schedule is left out (`running`, `checking` of ImageSchedule),
  // so no old image is removed again, and an operation of the worker that lists images can neither end nor be cancelled.
  it('images gives its signal to the request, so the time limit ends a list that the engine does not answer (B5)', async () => {
    const { engine, requests } = hangingEngine(LIST);
    const limit = new AbortController();
    const listed = engine.images({}, limit.signal);
    limit.abort();
    await expect(listed).rejects.toMatchObject({ name: 'AbortError' });
    // The one request of the list got the signal (or one that ended with it).
    expect(requests.map((request) => request.signal?.aborted)).toEqual([true]);
  });

  // Kills P1 (code from before this PR, which the monitor's stop under the lock of an environment uses since this PR):
  // the loop gives each stop STOP_TIMEOUT_MS (main.ts, stopContainers), the worker its time limit and its cancel; without
  // the signal on the request a stop that the engine never answers (moby's stop waits without a limit for the lock of the
  // container, which a hung operation of it holds: a start, or the cleanup after its exit such as an unmount) holds the
  // loop and the lock of the environment for ever: no stop on the whole engine, and every operation of a window on that
  // environment finds it busy.
  it('stop gives its signal to the request, so the time limit ends a stop that the engine does not answer (P1)', async () => {
    const { engine, requests } = hangingEngine({ status: 204, body: '', truncated: false });
    const limit = new AbortController();
    const stopped = engine.stop('a'.repeat(64), undefined, limit.signal);
    limit.abort();
    await expect(stopped).rejects.toMatchObject({ name: 'AbortError' });
    // The one request of the stop got the signal (or one that ended with it).
    expect(requests.map((request) => request.signal?.aborted)).toEqual([true]);
  });
});

describe('the bound of the answers of the other lists (review round 2 of PR #126, B)', () => {
  // Kills B6 (the list of the volumes with the 16 MiB bound); also pins the other requests of the port that read a list or
  // an object: only containerSummaries and images name a bound of their own (engineClient.11IMR1.test.ts), every other
  // request keeps the default of engineApi (MAX_ENGINE_ANSWER_CHARACTERS).
  it('gives no bound of its own to the lists of the volumes and networks, the version, the identity, the IDs and the inspects (B6)', async () => {
    const requests: EngineRequest[] = [];
    const api: EngineApi = async (request) => {
      requests.push(request);
      const path = request.path.split('?')[0];
      const value =
        path === '/volumes'
          ? { Volumes: [{ Name: 'v' }] }
          : path === '/networks' || path === '/containers/json'
            ? []
            : path === '/version'
              ? { ApiVersion: '1.47', Version: '28.5.1' }
              : path === '/info'
                ? { ID: 'engine', DockerRootDir: '/var/lib/docker' }
                : { Id: 'x' };
      return { status: 200, body: JSON.stringify(value), truncated: false };
    };
    const engine = dockerEngine(api, async () => Promise.reject(new Error('no exec in this test')));
    await engine.volumeNames({});
    await engine.networkNames({});
    await engine.version();
    await engine.identity();
    await engine.containerIds({ label: ['k'] });
    await engine.inspect('volume', 'v');
    // No bound of its own: engineApi takes MAX_ENGINE_ANSWER_CHARACTERS for an undefined one.
    expect(requests.map((request) => [request.path.split('?')[0], request.maxCharacters])).toEqual([
      ['/volumes', undefined],
      ['/networks', undefined],
      ['/version', undefined],
      ['/info', undefined],
      ['/containers/json', undefined],
      ['/volumes/v', undefined],
    ]);
  });
});
