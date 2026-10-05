// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #111 (A-M2): a lifecycle command that failed in a running container keeps the container (the open
// goes on with a warning). In the worker the workspace helper reads whether it runs over the engine; its own `docker
// container inspect` would fail closed there, so every such open failed.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import type { EngineContainer } from './dockerEngine';
import type { HostSide } from './hostSide';
import { workerServiceDeps } from './workerServices';

const ID = 'c'.repeat(64);

function helperWith(container: EngineContainer | undefined) {
  const asked: string[] = [];
  const all = workerServiceDeps({
    host: { questions: {}, state: {}, records: {}, secrets: {} } as unknown as HostSide,
    engine: { ...unusedEngine(), container: async (reference) => (asked.push(reference), container) },
    secretOf: () => undefined,
    forgetSecret: () => undefined,
    logger: silentLogger,
    ownHelper: { image: { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/s.sock' },
    dockerHost: '',
    owner: { windowId: 'w', pid: 1 },
    environmentLock: async () => {
      throw new Error('no lock in this test');
    },
  });
  return { runs: (all.helper as unknown as { containerRuns(id: string): Promise<boolean> }).containerRuns(ID), asked };
}

describe('whether a container runs, in the worker (review round 1 of PR #111, A-M2)', () => {
  it('is read over the engine, never through a Docker CLI', async () => {
    const running = helperWith({ id: ID, name: 'devenv-x', state: 'running', rawState: 'running', labels: {}, image: 'i' });
    expect(await running.runs).toBe(true);
    expect(running.asked).toEqual([ID]);
    expect(await helperWith({ id: ID, name: 'devenv-x', state: 'stopped', rawState: 'exited', labels: {}, image: 'i' }).runs).toBe(false);
    expect(await helperWith(undefined).runs).toBe(false);
  });
});
