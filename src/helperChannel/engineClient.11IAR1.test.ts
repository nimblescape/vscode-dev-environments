// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #122 (reviewer B): probes for mutants of the identity and the prune of the port over the Engine API
// (engineClient.ts) that the tests of the PR left alive.
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SWEEP_FILTERS } from '../core/helperChannel/protocol';
import { EngineError } from '../core/worker/dockerEngine';
import { engineHijack, type EngineAnswer, type EngineApi } from './engineApi';
import { dockerEngine } from './engineClient';

function fake(answer: EngineAnswer) {
  const api: EngineApi = async () => answer;
  return dockerEngine(api, engineHijack(path.join(os.tmpdir(), 'devenv-no-socket')));
}

describe('review round 1 of PR #122 (reviewer B): identity and pruneContainers', () => {
  // Kills the mutant `{ id: value?.ID ?? value?.Name, … }`: the identity is the `ID` of /info only, never another field
  // (another name would let a different engine pass as the target's).
  it('identity: an answer without ID is refused even when it has a Name', async () => {
    const engine = fake({ status: 200, body: JSON.stringify({ Name: 'host', DockerRootDir: '/var/lib/docker' }), truncated: false });
    await expect(engine.identity()).rejects.toThrow(new EngineError('The engine answered /info without its ID and root folder.', 200));
  });

  // Kills the mutant `answer.status !== 200 && answer.status !== 204`: only a 200 is a prune answer; any other status is
  // the engine's failure, even with a body that reads as one.
  it('pruneContainers: a status other than 200 is a failure, whatever the body', async () => {
    for (const status of [204, 201]) {
      const engine = fake({ status, body: JSON.stringify({ ContainersDeleted: ['a'.repeat(64)] }), truncated: false });
      await expect(engine.pruneContainers(SWEEP_FILTERS), String(status)).rejects.toMatchObject({ name: 'EngineError', status });
    }
  });
});
