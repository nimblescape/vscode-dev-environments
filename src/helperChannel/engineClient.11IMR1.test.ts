// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I, review round 1 of PR #126 (the Session Monitor on the Engine API): DockerEngine.containerSummaries, the
// list of the containers as the engine gives it without an inspect of each (F1), and the bound of the answers of the
// lists of every container and image (F2), over an Engine API in memory.
import { describe, expect, it } from 'vitest';
import { EngineError } from '../core/worker/dockerEngine';
import { MAX_ENGINE_LIST_ANSWER_CHARACTERS, type EngineAnswer, type EngineApi, type EngineRequest } from './engineApi';
import { containerName, dockerEngine } from './engineClient';

const ok = (value: unknown, status = 200): EngineAnswer => ({ status, body: typeof value === 'string' ? value : JSON.stringify(value), truncated: false });

/** The port over an Engine API in memory that answers with `route` and records the requests. */
function fake(route: (request: EngineRequest) => EngineAnswer) {
  const requests: EngineRequest[] = [];
  const api: EngineApi = async (request) => (requests.push(request), route(request));
  return { engine: dockerEngine(api, async () => Promise.reject(new Error('no exec in this test'))), requests };
}

const DEV = 'a'.repeat(64);
const DB = 'b'.repeat(64);

describe('DockerEngine.containerSummaries (review round 1 of PR #126, F1)', () => {
  it('reads the list as it is: all=1 and the label filter, the first name without `/`, the state and the labels, and no inspect', async () => {
    const { engine, requests } = fake((request) =>
      request.path.startsWith('/containers/json')
        ? ok([
            { Id: DEV, Names: ['/devenv-api'], State: 'running', Labels: { 'nimblescape.devenv.environment-id': 'e1' }, Status: 'Up 5 minutes' },
            { Id: DB, Names: ['/devenv-api-db-1', '/other/alias'], State: 'exited', Labels: { 'nimblescape.devenv.environment-id': 'e1', 'nimblescape.devenv.compose-service': 'db' } },
          ])
        : // An inspect of either container would fail (a broken layer): the list never asks for one.
          ok({ message: 'RWLayer of container is unexpectedly nil' }, 500),
    );
    expect(await engine.containerSummaries('nimblescape.devenv.environment-id=e1')).toEqual([
      { id: DEV, name: 'devenv-api', state: 'running', labels: { 'nimblescape.devenv.environment-id': 'e1' } },
      { id: DB, name: 'devenv-api-db-1', state: 'exited', labels: { 'nimblescape.devenv.environment-id': 'e1', 'nimblescape.devenv.compose-service': 'db' } },
    ]);
    expect(requests.map((request) => `${request.method} ${decodeURIComponent(request.path)}`)).toEqual([
      'GET /containers/json?all=1&filters={"label":["nimblescape.devenv.environment-id=e1"]}',
    ]);
  });

  it('leaves out an entry without an ID; reads a missing name, state or labels as empty', async () => {
    const { engine } = fake(() =>
      ok([{ Names: ['/no-id'], State: 'running' }, { Id: '', State: 'running' }, null, 'text', { Id: DEV }, { Id: DB, Names: 'not a list', State: 7, Labels: null }]),
    );
    expect(await engine.containerSummaries('k')).toEqual([
      { id: DEV, name: '', state: '', labels: {} },
      { id: DB, name: '', state: '', labels: {} },
    ]);
  });

  it('fails with the answer of the engine, and for an answer that is no list', async () => {
    await expect(fake(() => ok({ message: 'the daemon is busy' }, 500)).engine.containerSummaries('k')).rejects.toMatchObject({ message: 'the daemon is busy', status: 500 });
    await expect(fake(() => ok({ not: 'a list' })).engine.containerSummaries('k')).rejects.toBeInstanceOf(EngineError);
    await expect(fake(() => ({ status: 200, body: '[{"Id":"', truncated: true })).engine.containerSummaries('k')).rejects.toThrow('more than can be read');
  });
});

describe('the bound of the answers of the lists (review round 1 of PR #126, F2)', () => {
  it('reads the lists of every container and image up to MAX_ENGINE_LIST_ANSWER_CHARACTERS; the other requests keep the default bound', async () => {
    const { engine, requests } = fake((request) => (request.path.startsWith('/images/') && !request.path.startsWith('/images/json') ? ok({ Id: 'sha256:1' }) : ok([])));
    await engine.containerSummaries('k');
    await engine.images({});
    await engine.containerIds({ ancestor: ['sha256:1'] });
    await engine.inspect('image', 'x:1');
    expect(requests.map((request) => [request.path.split('?')[0], request.maxCharacters])).toEqual([
      ['/containers/json', MAX_ENGINE_LIST_ANSWER_CHARACTERS],
      ['/images/json', MAX_ENGINE_LIST_ANSWER_CHARACTERS],
      ['/containers/json', undefined],
      ['/images/x%3A1/json', undefined],
    ]);
  });
});

// PR #126 review round 2 (A, L1): the name of a container in the list is its own name, never an alias of a legacy
// `--link` that the engine sorts first (the name goes into the log lines of the stops of the Session Monitor).
describe('the name of a container in the list of the engine (PR #126 review round 2, A L1)', () => {
  it('takes its own name before an alias of a legacy link, else the first one, else none', () => {
    expect(containerName(['/aaa/db', '/devenv-api-db-1'])).toBe('devenv-api-db-1');
    expect(containerName(['/devenv-api'])).toBe('devenv-api');
    expect(containerName(['/aaa/db'])).toBe('aaa/db');
    expect(containerName([])).toBe('');
  });
});
