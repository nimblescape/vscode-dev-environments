// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #127 (reviewer B, mutation tests): the pipeline reads the containers of one environment through
// EnvironmentDocker.environmentContainers (plan step 11I, U4, decision of 2026-10-08). Each call site was mutated to the
// containers of every environment (listEnvironmentContainers) and no test failed, because no test had a container of
// another environment next to the one that the flow works on. Each test here names the mutant (Pnn, at the call site of
// environmentService.ts) that it kills: the containers of another environment of the same account are never started,
// stopped or removed, and never decide about this one.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContainerInfo } from '../docker/dockerObjects';
import { UserFacingError } from '../errors';
import { composeConfigHash, composeInputsHash, type ComposeModel, type ComposeModelOutput } from '../helper/compose';
import { DevcontainerCommandError } from '../helper/devcontainerCli';
import {
  CONTAINER_VERSION,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_VERSION,
  LABEL_ENVIRONMENT_ID,
  LABEL_HOST_ACCESS,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  LABEL_VOLUME,
  VOLUME_KIND_ADDITIONAL,
  composeProjectName,
  environmentImageName,
  resourceName,
} from '../names';
import type { BuildRecord, ContainerState, WindowStatus } from '../types';
import type { RepositoryTarget } from './operationBase';
import {
  ACCOUNT,
  BASE_IMAGE,
  DEFAULT_CONFIG_TEXT,
  DIGEST_NEW,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  OTHER_ID,
  REPO,
  T0,
  checked,
  createHarness,
  seedEnvironment,
  type Harness,
} from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const PROJECT = composeProjectName(REPO, ENV_ID);
const IMAGE_1 = environmentImageName(REPO, ENV_ID, 1);
const DB_IMAGE = 'postgres:16';
const DB_DIGEST = `sha256:${'d'.repeat(64)}`;
const COMPOSE_LABELS = { 'com.docker.compose.project': PROJECT, 'com.docker.compose.container-number': '1' };
/** The other environment: of the same account, another repository. */
const OTHER_REPO = 'acme/web';
const OTHER_PROJECT = composeProjectName(OTHER_REPO, OTHER_ID);

// The Docker Compose configuration of environmentService.compose.test.ts (a dev service `app` and a database `db`).
const CONFIG_TEXT = `{
  "name": "API",
  "dockerComposeFile": ["compose.yml"],
  "service": "app",
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",
  "features": { "${FEATURE}": {} },
  "remoteUser": "vscode",
  "mounts": ["source=cache,target=/cache,type=volume"]
}`;

function model(): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: { image: BASE_IMAGE, command: ['sleep', 'infinity'], volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces', bind: {} }], networks: { default: null } },
      db: { image: DB_IMAGE, volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', volume: {} }], networks: { default: null } },
    },
    networks: { default: { name: `${PROJECT}_default` } },
    volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
  };
}

function output(): ComposeModelOutput {
  return { version: '2.40.3', dollarEscaped: true, model: model(), dockerfiles: {}, realPaths: { '/workspaces': '/workspaces' }, inputsHash: 'inputs-1' };
}

let h: Harness;

beforeEach(() => {
  h = createHarness({ newEnvironmentId: () => ENV_ID });
});

afterEach(() => {
  h.cleanup();
});

function options() {
  return { progress: h.progress };
}

function useCompose(): void {
  h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT } };
  h.helper.composeOutput = output();
  h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST }, { [FEATURE]: FEATURE_DIGEST });
}

/** A Docker Compose environment of ENV_ID that is up to date (as seedCompose of environmentService.compose.test.ts). */
async function seedCompose(dev: ContainerState, db: ContainerState, record: Partial<BuildRecord> = {}): Promise<void> {
  await seedEnvironment(h, {
    container: dev,
    containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app' },
    record: {
      configHash: composeConfigHash(CONFIG_TEXT, model(), {}),
      images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST },
      compose: { service: 'app', images: [`${PROJECT}-app`], serviceImages: [DB_IMAGE], version: '2.40.3', inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', {}) },
      ...record,
    },
  });
  h.docker.images.add(DB_IMAGE);
  h.docker.addContainer({ environmentId: ENV_ID, name: `${PROJECT}-db-1`, state: db, image: DB_IMAGE, labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' } });
}

function dbContainer(): ContainerInfo | undefined {
  return h.docker.containersOf(ENV_ID).find((c) => c.labels[LABEL_COMPOSE_SERVICE] === 'db');
}

/** The entry of the other environment (same account, its own repository), without a container of its own yet. */
async function otherEnvironment(): Promise<void> {
  await seedEnvironment(h, { id: OTHER_ID, repository: OTHER_REPO, container: null, volume: false, record: null });
}

/** A container of the database service of the other environment's Docker Compose project. */
function theirService(state: ContainerState, labels: Record<string, string> = {}, volumes?: string[]): ContainerInfo {
  const added = h.docker.addContainer({
    environmentId: OTHER_ID,
    name: `${OTHER_PROJECT}-db-1`,
    state,
    image: DB_IMAGE,
    labels: { [LABEL_COMPOSE_SERVICE]: 'db', 'com.docker.compose.project': OTHER_PROJECT, 'com.docker.compose.container-number': '1', 'com.docker.compose.service': 'db', ...labels },
  });
  if (volumes !== undefined) h.docker.containers.set(added.id, { ...added, volumes });
  return h.docker.containers.get(added.id)!;
}

/** The dev container of the other environment (a single container). */
function theirDevContainer(state: ContainerState): ContainerInfo {
  return h.docker.addContainer({ environmentId: OTHER_ID, name: resourceName(OTHER_REPO, OTHER_ID), state, image: environmentImageName(OTHER_REPO, OTHER_ID, 1) });
}

/** The container is there as it was: never started, stopped or removed. */
function untouched(container: ContainerInfo): void {
  expect(h.docker.containers.get(container.id)?.state).toBe(container.state);
  expect(h.docker.log.filter((line) => line.endsWith(` ${container.id}`))).toEqual([]);
}

describe('review round 1 of PR #127 (reviewer B): the containers of another environment are not this one\'s', () => {
  // Kills P01 (unrestrictedServiceContainer: `environmentContainers(ctx.env.id)` → `listEnvironmentContainers()`): a
  // service of another environment that was created while the host access checks were off would make this current
  // Docker Compose environment outdated, so its open would create its containers again.
  it('P01: a service of another environment of the checks-off time does not make a current environment outdated', async () => {
    useCompose();
    await seedCompose('running', 'running');
    await otherEnvironment();
    const theirs = theirService('running', { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups).toEqual([]);
    expect(h.logger.infos.join('\n')).not.toContain('created while the host access checks were off');
    untouched(theirs);
  });

  // Kills P02 (startStoppedServices): the open of a running Docker Compose environment starts its stopped services, never
  // the stopped services of another environment.
  it('P02: the open starts the stopped services of this environment only', async () => {
    useCompose();
    await seedCompose('running', 'stopped');
    await otherEnvironment();
    const theirs = theirService('stopped');
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log).toContain(`start ${dbContainer()!.id}`);
    untouched(theirs);
  });

  // Kills P03 (the services before `up`): next to a single container, the containers of other services are strays of
  // this environment that go; a service of another environment is not one of them (before: it would be stopped and
  // removed, or the start refused).
  it('P03: the start of a single container never removes a service of another environment as a stray', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    await otherEnvironment();
    const theirs = theirService('running');
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups).toHaveLength(1);
    untouched(theirs);
  });

  // Kills P04 (upContainers, through anyContainerRuns): whether a container of this environment runs decides whether
  // another window still counts; a running container of another environment must not keep an outdated stopped container
  // from being created again (review round 5 of PR #68, A-R5-1).
  it('P04: a running container of another environment is not a running container of this one', async () => {
    h.cleanup();
    const statusOfB: WindowStatus = { windowId: 'window-b', pid: 5353, environmentId: ENV_ID, state: 'active', updatedAt: new Date(T0).toISOString() };
    h = createHarness({ newEnvironmentId: () => ENV_ID, windowStatuses: async () => [statusOfB] });
    h.alivePids.add(5353);
    await seedEnvironment(h, { container: 'stopped', containerLabels: { [LABEL_CONTAINER_VERSION]: '0' } });
    await otherEnvironment();
    const theirs = theirDevContainer('running');
    await h.service.open(TARGET, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
    untouched(theirs);
  });

  // Kills P05 (recordContainerVolumes with `all`): the volumes of the containers of this environment are recorded as its
  // additional volumes, never an additional volume of another environment of the same owner that only its container
  // mounts (the record would keep that volume at the other environment's Delete).
  it('P05: the open records the volumes of the containers of this environment only', async () => {
    useCompose();
    await seedCompose('running', 'running');
    await otherEnvironment();
    h.docker.volumes.set('web-cache', { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: OTHER_REPO, [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_VOLUME]: VOLUME_KIND_ADDITIONAL });
    theirService('running', {}, ['web-cache']);
    await h.service.openEnvironment(ENV_ID, options());
    expect((await h.registry.get(ENV_ID))?.additionalVolumes ?? []).not.toContain('web-cache');
  });

  // Kills P06 (removeComposeServices): the switch of a Docker Compose environment to a single container removes its own
  // services, never those of another environment.
  it('P06: the switch to a single container removes the services of this environment only', async () => {
    useCompose();
    await seedCompose('stopped', 'stopped');
    h.docker.images.add(`${PROJECT}-app`);
    h.docker.imageConfigs.set(`${PROJECT}-app`, { User: '', Labels: { [LABEL_ENVIRONMENT_ID]: ENV_ID } });
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
    const db = dbContainer()!.id;
    await otherEnvironment();
    const theirs = theirService('running');
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${db}`);
    untouched(theirs);
  });

  // Kills P09 (containersUseCompose): an entry without a build record and without a dev container is of the kind of
  // its own containers; a service of another environment does not make it a Docker Compose environment (whose question
  // of the switch would end the open).
  it('P09: a service of another environment does not make an entry without a record a Docker Compose environment', async () => {
    await seedEnvironment(h, { record: null, container: null });
    await otherEnvironment();
    const theirs = theirService('stopped');
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.ui.prompts.filter((prompt) => prompt.startsWith('configurationKindChanged'))).toEqual([]);
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
    untouched(theirs);
  });

  // Kills P10 (removableVolumesByKind): an additional volume of this environment is data of its services only when a
  // container of its own services mounts it; a service of another environment that mounts it does not move it into the
  // question of the data of the services.
  it('P10: the volumes that a service of another environment mounts are no data of the services of this one', async () => {
    await seedEnvironment(h, { container: 'stopped', extra: { additionalVolumes: ['api-tools'] } });
    h.docker.volumes.set('api-tools', { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_VOLUME]: VOLUME_KIND_ADDITIONAL });
    await otherEnvironment();
    theirService('running', {}, ['api-tools']);
    expect(await h.service.removableVolumesOf(ENV_ID)).toEqual({ additional: ['api-tools'], serviceData: [], possibly: [] });
  });

  // Kills P11 (removeFailedFirstOpen: `docker.environmentContainers(env.id)` → `docker.listEnvironmentContainers()`): a
  // failed first open removes what it created, never the containers of another environment.
  it('P11: a failed first open removes its own container only', async () => {
    await otherEnvironment();
    const theirDev = theirDevContainer('running');
    const theirs = theirService('stopped');
    h.helper.upError = () => new DevcontainerCommandError('devcontainer up', 1, '', 'port is already allocated');
    const error = await h.service.open(TARGET, options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as UserFacingError).code).toBe('startFailed');
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    untouched(theirDev);
    untouched(theirs);
  });
});

