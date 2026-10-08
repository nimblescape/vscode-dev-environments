// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 7: each environment records its Docker host (the current Docker context when it was created). The service acts
// only on the environments of the current host; the others are never cloned, restored, recreated, deleted, stopped, or
// given a token.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserFacingError } from '../errors';
import { Messages } from '../messages';
import { LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID, LABEL_REPOSITORY, resourceName } from '../names';
import type { RepositoryTarget } from './operationBase';
import { ACCOUNT, ENV_ID, OTHER_ID, REPO, createHarness, seedEnvironment, type Harness } from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };

let h: Harness;
/** The Docker host of the current Docker context, as DockerTargets.host gives it. */
let currentHost: string;

beforeEach(() => {
  currentHost = '';
  h = createHarness({ dockerHost: async () => currentHost });
});

afterEach(() => {
  h.cleanup();
});

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

describe('the Docker host of a new environment', () => {
  it('a first open on a remote host records it', async () => {
    currentHost = 'build-box';
    const result = await h.service.open(TARGET, { progress: h.progress });
    expect(result.environment.dockerHost).toBe('build-box');
    expect((await h.registry.get(result.environment.id))?.dockerHost).toBe('build-box');
  });

  it('a first open on the local Docker records nothing (a missing field is local)', async () => {
    const result = await h.service.open(TARGET, { progress: h.progress });
    expect(result.environment).not.toHaveProperty('dockerHost');
  });

  it('an environment of the repository on another host is not used: the current host gets its own', async () => {
    await seedEnvironment(h, { extra: { dockerHost: 'build-box' } });
    const createdVolumes = new Set(h.docker.volumes.keys());
    const result = await h.service.open(TARGET, { progress: h.progress });
    expect(result.environment.id).not.toBe(ENV_ID);
    expect(result.environment).not.toHaveProperty('dockerHost');
    // The other host's environment is unchanged in the registry.
    expect((await h.registry.get(ENV_ID))?.dockerHost).toBe('build-box');
    expect((await h.registry.list()).map((env) => env.id).sort()).toEqual([ENV_ID, result.environment.id].sort());
    expect(createdVolumes.size).toBeLessThan(h.docker.volumes.size);
  });
});

describe('an environment of another Docker host is never acted on', () => {
  beforeEach(async () => {
    await seedEnvironment(h, { container: 'running', extra: { dockerHost: 'build-box' } });
    currentHost = 'other-box';
  });

  const refused = Messages.otherDockerHost(REPO, 'build-box', 'other-box');

  it.each([
    ['openEnvironment', () => h.service.openEnvironment(ENV_ID, { progress: h.progress })],
    ['stop', () => h.operations.stop(ENV_ID)],
    ['delete', () => h.service.delete(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] })],
    ['safetyCheck', () => h.service.safetyCheck(ENV_ID, { progress: h.progress })],
    // 2026-10-01: the Switch branch command was dropped (user decision). Its rows switchBranch and configurationChanged are gone.
    ['listConfigurations', () => h.service.listConfigurations(ENV_ID, { progress: h.progress })],
  ])('%s is refused with both hosts named, before Docker is asked', async (_name, operation) => {
    const changes = h.docker.log.length;
    const execs = h.docker.execs.length;
    const error = await rejection(operation());
    expect(error.code).toBe('otherDockerHost');
    expect(error.message).toBe(refused);
    // Nothing changed on the engine, no token was written, no helper ran, Docker was not started.
    expect(h.docker.log.length).toBe(changes);
    expect(h.docker.execs.length).toBe(execs);
    expect(h.dockerStarts).toBe(0);
    expect(h.helper.calls).toEqual([]);
    expect(await h.registry.get(ENV_ID)).toBeDefined();
  });

  it('reads nothing of it from Docker', async () => {
    // Plan step 11C1: changed expectation, the reads of the window go through windowStateInWorker (was: currentBranch).
    expect(await h.operations.windowStateInWorker((await h.registry.get(ENV_ID))!, 'devenv-x', { branch: true })).toBeUndefined();
    // Plan step 11I (D3): changed call, the one read of the removable volumes (removableVolumesOf), same expectation.
    expect((await h.service.removableVolumesOf(ENV_ID)).additional).toEqual([]);
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual([]);
    expect((await h.operations.inspectStates())?.has(ENV_ID)).toBe(false);
  });

  it('the environment of the local Docker is refused on a remote host too', async () => {
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web' });
    const error = await rejection(h.operations.stop(OTHER_ID));
    expect(error.message).toBe(Messages.otherDockerHost('acme/web', '', 'other-box'));
    expect(error.message).toContain('the local Docker');
  });
});

describe('inspectStates shows the environments of the current host only', () => {
  it('leaves out the other hosts (which would otherwise show "files missing")', async () => {
    await seedEnvironment(h, { container: 'running' });
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', container: null, volume: false, extra: { dockerHost: 'build-box' } });
    const states = await h.operations.inspectStates();
    expect([...(states?.keys() ?? [])]).toEqual([ENV_ID]);
    currentHost = 'build-box';
    expect([...((await h.operations.inspectStates())?.keys() ?? [])]).toEqual([OTHER_ID]);
  });
});

describe('restore after a lost registry reads only the current host', () => {
  it('stamps the restored entries with the current host', async () => {
    const name = resourceName(REPO, OTHER_ID);
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    currentHost = 'build-box';
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.dockerHost).toBe('build-box');
  });

  it('an environment of the same repository and account on another host does not keep it from being restored', async () => {
    await seedEnvironment(h, { extra: { dockerHost: 'other-box' } });
    const name = resourceName(REPO, OTHER_ID);
    h.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(OTHER_ID))?.dockerHost).toBeUndefined();
    expect((await h.registry.get(ENV_ID))?.dockerHost).toBe('other-box');
  });
});

describe('an endpoint that is neither local nor SSH is never reached (review, D2)', () => {
  const ENDPOINT = 'tcp://10.0.0.5:2375';
  let u: Harness;
  let dockerReads: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(async () => {
    u = createHarness({ dockerTarget: async () => ({ kind: 'unsupported', host: ENDPOINT, endpoint: ENDPOINT }) });
    // Seeded with a recorded endpoint that is neither local nor SSH (the registry is a file that anything can change),
    // and one of the local Docker.
    await seedEnvironment(u, { container: 'running', extra: { dockerHost: ENDPOINT } });
    await seedEnvironment(u, { id: OTHER_ID, repository: 'acme/web', container: 'running' });
    const docker = u.docker as unknown as Record<string, (...args: unknown[]) => unknown>;
    dockerReads = [
      'isRunning',
      'listEnvironmentContainers',
      // Plan step 11I (U4, decision of 2026-10-08): the containers of one environment are a call of the port now.
      'environmentContainers',
      'listEnvironmentVolumes',
      'volumeExists',
      'findContainer',
      'inspectVolumes',
      'stopContainer',
      'exec',
    ]
      .filter((name) => typeof docker[name] === 'function')
      .map((name) => vi.spyOn(docker, name as never));
  });

  afterEach(() => {
    u.cleanup();
  });

  const noDockerCall = (): void => {
    for (const spy of dockerReads) expect(spy).not.toHaveBeenCalled();
    expect(u.dockerStarts).toBe(0);
    expect(u.helper.calls).toEqual([]);
  };

  it.each([
    ['open', () => u.service.open(TARGET, { progress: u.progress })],
    ['openEnvironment', () => u.service.openEnvironment(ENV_ID, { progress: u.progress })],
    ['stop', () => u.operations.stop(ENV_ID)],
    ['stop (local environment)', () => u.operations.stop(OTHER_ID)],
    ['delete', () => u.service.delete(ENV_ID, { progress: u.progress, additionalVolumesToRemove: [] })],
    ['safetyCheck', () => u.service.safetyCheck(ENV_ID, { progress: u.progress })],
    // 2026-10-01: the Switch branch command was dropped (user decision). Its rows switchBranch and configurationChanged are gone.
    ['listConfigurations', () => u.service.listConfigurations(ENV_ID, { progress: u.progress })],
  ])('%s is refused with dockerEndpointUnsupported, before any Docker call', async (_name, operation) => {
    const error = await rejection(operation());
    expect(error.code).toBe('dockerEndpointUnsupported');
    expect(error.message).toBe(Messages.dockerEndpointUnsupported(ENDPOINT));
    noDockerCall();
    expect(u.docker.log).toEqual([]);
  });

  it('the reads of the view and the restore do nothing, and the message is shown once', async () => {
    const name = resourceName('acme/lost', OTHER_ID.replace(/^./, 'f'));
    u.docker.volumes.set(name, { [LABEL_ENVIRONMENT_ID]: OTHER_ID.replace(/^./, 'f'), [LABEL_REPOSITORY]: 'acme/lost', [LABEL_OWNER_ID]: ACCOUNT.id });
    // Plan step 11F1: changed, the reads of the window (EnvironmentOperations) and those of the pipeline (EnvironmentService,
    // which runs in the worker) each show the message once.
    const shown = () => u.ui.warnings.filter((warning) => warning === Messages.dockerEndpointUnsupported(ENDPOINT));
    expect(await u.operations.inspectStates()).toEqual(new Map());
    // Plan step 11C1: changed expectation, windowStateInWorker (was: currentBranch).
    expect(await u.operations.windowStateInWorker((await u.registry.get(ENV_ID))!, 'devenv-x', { branch: true })).toBeUndefined();
    expect(await u.operations.inspectStates()).toEqual(new Map());
    expect(shown()).toHaveLength(1);
    expect(await u.service.reconcileFromVolumes()).toBe(0);
    // Plan step 11I (D3): changed call, the one read of the removable volumes (removableVolumesOf), same expectation.
    expect((await u.service.removableVolumesOf(ENV_ID)).additional).toEqual([]);
    expect((await u.service.removableVolumesOf(ENV_ID)).serviceData).toEqual([]);
    expect(await u.service.repositoryServiceData(ENV_ID)).toEqual([]);
    noDockerCall();
    // Never recorded as the host of a restored entry.
    expect((await u.registry.list()).filter((env) => env.repository === 'acme/lost')).toEqual([]);
    expect(shown()).toHaveLength(2);
  });
});
