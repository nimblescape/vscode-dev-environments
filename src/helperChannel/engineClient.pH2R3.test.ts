// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 3 of 11H2 (reviewer B, mutation testing): the bound of the processes of a container (round 2, A2-L1) is
// exactly the bound of the lists, no larger (any larger bound passed the round-2 test of a 2 MiB answer).
import { describe, expect, it } from 'vitest';
import { MAX_ENGINE_LIST_ANSWER_CHARACTERS, type EngineApi, type EngineRequest } from './engineApi';
import { dockerEngine } from './engineClient';

describe('11H2 review round 3 (B): the bound of the processes of a container', () => {
  it('reads GET /containers/<id>/top up to MAX_ENGINE_LIST_ANSWER_CHARACTERS', async () => {
    const requests: EngineRequest[] = [];
    const api: EngineApi = async (request) => (requests.push(request), { status: 200, body: JSON.stringify({ Titles: ['PID'], Processes: [['1']] }), truncated: false });
    const engine = dockerEngine(api, async () => Promise.reject(new Error('no exec in this test')));
    expect(await engine.processes('a b')).toEqual([['1']]);
    expect(requests.map((request) => [request.method, request.path, request.maxCharacters])).toEqual([['GET', '/containers/a%20b/top', MAX_ENGINE_LIST_ANSWER_CHARACTERS]]);
  });
});
