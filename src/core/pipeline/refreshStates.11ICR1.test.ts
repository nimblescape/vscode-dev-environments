// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #127 (reviewer B): mutation tests of readEnvironmentStates by the rule of the dev container
// (plan step 11I, U4, decision of 2026-10-08). Each test names the mutant of refreshStates.ts that it kills.
import { describe, expect, it } from 'vitest';
import type { ListedContainer } from '../docker/dockerObjects';
import { LABEL_ENVIRONMENT_ID } from '../names';
import { readEnvironmentStates, type StateDocker, type StateEnvironment } from './refreshStates';

const ENV: StateEnvironment = { id: 'env-r1', containerName: 'devenv-r1', volumeName: 'v-r1', folder: '/workspaces/r1', branch: true };

function listed(id: string, name: string, state: 'running' | 'stopped', created?: string): ListedContainer {
  return {
    id,
    name,
    state,
    rawState: state === 'running' ? 'running' : 'exited',
    labels: { [LABEL_ENVIRONMENT_ID]: ENV.id },
    image: 'img',
    ...(created !== undefined ? { created } : {}),
  };
}

function docker(containers: ListedContainer[], execs: string[]): StateDocker {
  return {
    listEnvironmentContainers: async () => containers,
    listEnvironmentVolumes: async () => [{ name: ENV.volumeName, labels: {} }],
    volumeExists: async () => true,
    exec: async (container) => (execs.push(container), { exitCode: 0, stdout: `branch-of-${container}\n`, stderr: '', timedOut: false }),
  };
}

describe('review round 1 of PR #127 (reviewer B): servicesRunning is another container than the dev container of the rule', () => {
  // Kills F03 (refreshStates.ts:119, `other.id !== dev?.id` → `other.name !== env.containerName`): the dev container of
  // the rule has another name than the recorded one (created again under another name); it is the dev container, not
  // "another container of the environment", so the answer has no servicesRunning.
  it('a lone running dev container of another name: running, its branch by its ID, and no servicesRunning', async () => {
    const execs: string[] = [];
    const states = await readEnvironmentStates(docker([listed('id-renamed', 'devenv-r1-again', 'running', '2026-10-08T09:00:00Z')], execs), [ENV]);
    expect(states.runtime.get(ENV.id)).toEqual({ container: 'running', volume: true });
    expect(execs).toEqual(['id-renamed']);
    expect(states.branches.get(ENV.id)).toBe('branch-of-id-renamed');
  });
});
