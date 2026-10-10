// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup PR C2 (reviewer B, probes):
// - B1: the service reads the Git state with readGitSummary in its cancel mode `fail` (a cancel is a failed read, logged
//   as such, as before the PR), not Stop's `throw`.
// - B9: composeContainers (now upContainers plus a filter) keeps its rule: the containers of Docker Compose of the
//   project, with this environment's ID label or none; never another environment's, never a single container.
// - A4: prepareHelper reads the own image with the signal of the open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerInfo } from '../docker/dockerObjects';
import { LABEL_ENVIRONMENT_ID, composeProjectName } from '../names';
import type { Environment } from '../types';
import type { RepositoryTarget } from './operationBase';
import { DEFAULT_CONFIG_PATH } from './recordRules';
import { ENV_ID, OTHER_ID, REPO, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

describe('the Git state of the service on a cancel (PR C2, B1, review round 1)', () => {
  it('a cancel during the read is a failed read of the Git state (logged by the container), not an error of recordGitState', async () => {
    await seedEnvironment(h, { container: 'running' });
    const id = h.docker.containersOf(ENV_ID)[0].id;
    const controller = new AbortController();
    // The cancel comes while the script runs: the exec rejects with its AbortError.
    h.docker.execHandler = () => {
      controller.abort();
      return {};
    };
    expect(await h.service.recordGitState(ENV_ID, controller.signal)).toBe(false);
    expect(h.logger.infos.filter((line) => line.startsWith('The Git state'))).toEqual([`The Git state in ${id} could not be read: The operation was cancelled.`]);
  });
});

describe('composeContainers after its merge into upContainers (PR C2, B9, review round 1)', () => {
  it('the Compose containers of the project with this ID label or none; not another environment\'s, not the single container', async () => {
    const env = await seedEnvironment(h, { container: 'running' });
    const single = h.docker.containersOf(ENV_ID)[0];
    const project = composeProjectName(REPO, ENV_ID);
    const compose = { 'com.docker.compose.project': project, 'com.docker.compose.container-number': '1' };
    const db = h.docker.addContainer({ environmentId: ENV_ID, name: `${project}-db-1`, state: 'running', image: 'postgres:16', labels: { ...compose } });
    const unlabelled = h.docker.addContainer({ environmentId: ENV_ID, name: `${project}-cache-1`, state: 'running', image: 'redis:7', labels: { ...compose } });
    delete unlabelled.labels[LABEL_ENVIRONMENT_ID];
    // A container of another environment that carries the labels of this project.
    const theirs = h.docker.addContainer({ environmentId: OTHER_ID, name: `${project}-web-1`, state: 'running', image: 'nginx:1', labels: { ...compose } });
    const service = h.service as unknown as { composeContainers(env: Environment): Promise<ContainerInfo[]> };
    const ids = (await service.composeContainers(env)).map((container) => container.id);
    expect(ids.sort()).toEqual([db.id, unlabelled.id].sort());
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(single.id);
  });
});

describe('the helper image of the open (PR C2, A4, review round 1)', () => {
  it('prepareHelper reads the own image with the signal of the open', async () => {
    const target: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
    const seen: (AbortSignal | undefined)[] = [];
    const own = h.helper.ownImageUse.bind(h.helper);
    vi.spyOn(h.helper, 'ownImageUse').mockImplementation(async (signal?: AbortSignal) => (seen.push(signal), own(signal)));
    const controller = new AbortController();
    await h.service.open(target, { progress: h.progress, signal: controller.signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.aborted).toBe(false);
    controller.abort();
    expect(seen[0]?.aborted).toBe(true);
  });
});
