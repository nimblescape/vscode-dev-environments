// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 6, Docker Compose configurations (implementation notes, section "Docker Compose"): the open pipeline for a
// configuration with `dockerComposeFile` and `service`. The model run, the check of every service before any build and
// before each `up` that creates containers, the build and up models, the volumes, the labels, the image check over all
// services, update, rebuild, refused update, and start and stop of all containers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import {
  COMPOSE_DEV_DOCKERFILE,
  COMPOSE_MODEL_PATH,
  WORKSPACE_VOLUME_KEY,
  composeConfigHash,
  type ComposeModel,
  type ComposeModelOutput,
} from '../helper/compose';
import { Messages } from '../messages';
import {
  CONTAINER_VERSION,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_VERSION,
  LABEL_ENVIRONMENT_ID,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  LABEL_VOLUME,
  VOLUME_KIND_ADDITIONAL,
  VOLUME_KIND_COMPOSE,
  composeProjectName,
  environmentImageName,
  resourceName,
} from '../names';
import type { ContainerInfo } from '../docker/containerAdapter';
import type { BuildRecord, ContainerState } from '../types';
import type { RepositoryTarget } from './environmentService';
import {
  ACCOUNT,
  BASE_IMAGE,
  DIGEST_NEW,
  DIGEST_OLD,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  OTHER_ID,
  REPO,
  checked,
  createHarness,
  seedEnvironment,
  type Harness,
} from './environmentService.testkit';
import { DEFAULT_CONFIG_PATH } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const NAME = resourceName(REPO, ENV_ID);
const PROJECT = composeProjectName(ENV_ID);
const IMAGE_1 = environmentImageName(ENV_ID, 1);
const IMAGE_2 = environmentImageName(ENV_ID, 2);
const FOLDER = '/workspaces/api';
const DB_IMAGE = 'postgres:16';
const DB_DIGEST = `sha256:${'d'.repeat(64)}`;
const DB_DIGEST_NEW = `sha256:${'e'.repeat(64)}`;
const COMPOSE_LABELS = { 'com.docker.compose.project': PROJECT };

const CONFIG_TEXT = `{
  // A Docker Compose configuration like the templates "… & Postgres"
  "name": "API",
  "dockerComposeFile": ["compose.yml"],
  "service": "app",
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",
  "features": { "${FEATURE}": {} },
  "remoteUser": "vscode",
  "mounts": ["source=cache,target=/cache,type=volume"]
}`;

/** The merged model of CONFIG_TEXT as `docker compose config --format json` prints it. */
function model(): ComposeModel {
  return {
    name: PROJECT,
    services: {
      app: {
        image: BASE_IMAGE,
        command: ['sleep', 'infinity'],
        // The templates' bind mount of the parent of the repository: replaced by the workspace volume.
        volumes: [{ type: 'bind', source: '/workspaces', target: '/workspaces', bind: {} }],
        networks: { default: null },
      },
      db: {
        image: DB_IMAGE,
        ports: [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' }],
        volumes: [
          { type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data', volume: {} },
          { type: 'bind', source: `${FOLDER}/init.sql`, target: '/docker-entrypoint-initdb.d/init.sql', read_only: true, bind: {} },
        ],
        networks: { default: null },
      },
    },
    networks: { default: { name: `${PROJECT}_default` } },
    volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
  };
}

function output(changes: (m: ComposeModel) => void = () => undefined): ComposeModelOutput {
  const m = model();
  changes(m);
  return {
    version: '2.40.3',
    dollarEscaped: true,
    model: m,
    dockerfiles: {},
    realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/init.sql`]: `${FOLDER}/init.sql` },
  };
}

const HASH = composeConfigHash(CONFIG_TEXT, model(), {});

let h: Harness;

beforeEach(() => {
  h = createHarness({ newEnvironmentId: () => ENV_ID });
  useCompose(h);
});

afterEach(() => {
  h.cleanup();
});

function useCompose(harness: Harness, out: ComposeModelOutput = output()): void {
  harness.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT } };
  harness.helper.composeOutput = out;
  harness.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST }, { [FEATURE]: FEATURE_DIGEST });
}

function options() {
  return { progress: h.progress };
}

async function rejection(promise: Promise<unknown>): Promise<UserFacingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UserFacingError) return error;
    throw error;
  }
  throw new Error('The promise did not reject.');
}

function upModel(index = -1): ComposeModel {
  const up = h.helper.ups.at(index);
  return JSON.parse(up?.files?.[COMPOSE_MODEL_PATH] ?? 'null') as ComposeModel;
}

function devContainer(): ContainerInfo | undefined {
  return h.docker.containersOf(ENV_ID).find((c) => c.labels[LABEL_COMPOSE_SERVICE] === undefined);
}

function dbContainer(): ContainerInfo | undefined {
  return h.docker.containersOf(ENV_ID).find((c) => c.labels[LABEL_COMPOSE_SERVICE] === 'db');
}

/** A Compose environment that is up to date: build record with the compose part, dev and db containers. */
async function seedCompose(p: { dev?: ContainerState | null; db?: ContainerState | null; record?: Partial<BuildRecord> } = {}): Promise<void> {
  await seedEnvironment(h, {
    container: p.dev === undefined ? 'stopped' : p.dev,
    containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app' },
    record: {
      configHash: HASH,
      images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST },
      compose: { service: 'app', images: [`${PROJECT}-app`] },
      ...p.record,
    },
  });
  h.docker.images.add(DB_IMAGE);
  const dbState = p.db === undefined ? 'stopped' : p.db;
  if (dbState !== null) {
    h.docker.addContainer({
      environmentId: ENV_ID,
      name: `${PROJECT}-db-1`,
      state: dbState,
      image: DB_IMAGE,
      labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' },
    });
  }
}

describe('first open of a Docker Compose configuration', () => {
  it('reads the model, checks it, builds the dev service image, and starts both services', async () => {
    const result = await h.service.open(TARGET, options());

    expect(h.helper.calls.filter((call) => !call.startsWith('readConfigFiles') && call !== 'ensureImage')).toEqual([
      'clone main',
      `readConfiguration ${DEFAULT_CONFIG_PATH}`,
      `composeModel ${PROJECT}`,
      `readConfiguration ${DEFAULT_CONFIG_PATH}`,
      `build ${IMAGE_1}`,
      'prepareGit',
      `up ${IMAGE_1}`,
    ]);
    // The model run gets the compose files of the configuration, resolved against its folder.
    expect(h.helper.composeModels).toEqual([{ files: [`${FOLDER}/.devcontainer/compose.yml`], project: PROJECT }]);
    // devcontainer.json first without the merged configuration, then with our copy, whose only compose file is ours.
    expect(h.helper.readConfigurations[0]).toEqual({ configPath: DEFAULT_CONFIG_PATH, merged: false });
    const merged = h.helper.readConfigurations[1];
    expect(merged.override).toMatchObject({ dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app', name: 'API' });
    expect(merged.env).toEqual({ COMPOSE_PROJECT_NAME: PROJECT });
    expect(Object.keys(merged.files ?? {}).sort()).toEqual([COMPOSE_MODEL_PATH, COMPOSE_DEV_DOCKERFILE].sort());

    // The images of all services are downloaded before the build (the image check covers them).
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([`pull ${BASE_IMAGE}`, `pull ${DB_IMAGE}`]);
    expect(h.checker.calls.at(-1)).toEqual({ images: [BASE_IMAGE, DB_IMAGE], features: [FEATURE] });

    // Build: our copy of devcontainer.json names the build model; the image-only dev service gets a build of its own (D-8).
    const build = h.helper.builds[0];
    expect(build.override).toMatchObject({ dockerComposeFile: [COMPOSE_MODEL_PATH], service: 'app' });
    expect(build.override).not.toHaveProperty('initializeCommand');
    expect(build.env).toEqual({ COMPOSE_PROJECT_NAME: PROJECT });
    expect(build.files?.[COMPOSE_DEV_DOCKERFILE]).toBe(`FROM ${BASE_IMAGE}\n`);
    const buildModel = JSON.parse(build.files?.[COMPOSE_MODEL_PATH] ?? '{}') as ComposeModel;
    expect(buildModel.services.app).toMatchObject({ image: `${PROJECT}-app`, build: { dockerfile: COMPOSE_DEV_DOCKERFILE } });

    // Up: the override configuration and the up model.
    const up = h.helper.ups[0];
    expect(up.override).toMatchObject({
      dockerComposeFile: [COMPOSE_MODEL_PATH],
      service: 'app',
      workspaceFolder: FOLDER,
      shutdownAction: 'none',
    });
    expect(up.override).not.toHaveProperty('image');
    expect(up.override).not.toHaveProperty('runArgs');
    expect(up.env).toEqual({ COMPOSE_PROJECT_NAME: PROJECT });
    const m = upModel();
    expect(m.name).toBe(PROJECT);
    expect(m.services.app).toMatchObject({
      image: IMAGE_1,
      pull_policy: 'never',
      container_name: NAME,
      labels: { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION) },
      volumes: [{ type: 'volume', source: WORKSPACE_VOLUME_KEY, target: '/workspaces' }],
    });
    expect(m.services.app).not.toHaveProperty('build');
    expect(m.services.db).toMatchObject({
      pull_policy: 'missing',
      labels: { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_COMPOSE_SERVICE]: 'db' },
      ports: [expect.objectContaining({ target: 5432, host_ip: '127.0.0.1' })],
    });
    // A file of the repository reaches the service from the workspace volume (volume.subpath).
    expect(m.services.db.volumes).toContainEqual({
      type: 'volume',
      source: WORKSPACE_VOLUME_KEY,
      target: '/docker-entrypoint-initdb.d/init.sql',
      volume: { nocopy: true, subpath: 'api/init.sql' },
      read_only: true,
    });
    expect(m.volumes).toEqual({
      pgdata: { name: `${PROJECT}_pgdata`, external: true },
      cache: { name: `${PROJECT}_cache`, external: true },
      [WORKSPACE_VOLUME_KEY]: { name: NAME, external: true },
    });

    // The volumes are created before `up` with the labels of the environment: the project volume as service data.
    const labels = { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id };
    expect(h.docker.volumes.get(`${PROJECT}_pgdata`)).toEqual({ ...labels, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE });
    expect(h.docker.volumes.get(`${PROJECT}_cache`)).toEqual({ ...labels, [LABEL_VOLUME]: VOLUME_KIND_ADDITIONAL });
    expect(h.docker.log.indexOf(`volume create ${PROJECT}_pgdata`)).toBeGreaterThanOrEqual(0);

    // Both containers carry the environment ID; the lookup finds the dev container.
    expect(devContainer()).toMatchObject({ name: NAME, state: 'running', image: IMAGE_1 });
    expect(dbContainer()).toMatchObject({ state: 'running', labels: expect.objectContaining({ [LABEL_ENVIRONMENT_ID]: ENV_ID }) });
    expect((await h.docker.findContainer(ENV_ID))?.name).toBe(NAME);
    expect(result).toMatchObject({ containerName: NAME, remoteWorkspaceFolder: FOLDER });

    const entry = await h.registry.get(ENV_ID);
    expect(entry?.buildRecord).toMatchObject({
      environmentImage: IMAGE_1,
      configHash: HASH,
      images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST },
      features: { [FEATURE]: FEATURE_DIGEST },
      compose: { service: 'app', images: [`${PROJECT}-app`] },
    });
    expect(entry?.additionalVolumes).toEqual(expect.arrayContaining([`${PROJECT}_pgdata`, `${PROJECT}_cache`]));
    expect(h.logger.infos.some((line) => line.includes('Changed in the Docker Compose model') && line.includes('published on 127.0.0.1 only'))).toBe(true);
  });

  it('refuses a privileged side service before any build, also with the host access checks off', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    useCompose(h, output((m) => (m.services.db.privileged = true)));
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess('service db: privileged mode'));
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([]);
    // A failed first open leaves nothing behind.
    expect(await h.registry.list()).toEqual([]);
    expect(h.docker.containers.size).toBe(0);
  });

  it('checks devcontainer.json of a Compose configuration with the host access checks on, whatever the switch says', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"remoteUser"', '"privileged": true, "remoteUser"') } };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess('privileged mode'));
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses a configuration without a dev service before the model run', async () => {
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: '{ "dockerComposeFile": "compose.yml" }' } };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.unsupportedOptions('service (the dev service of the Docker Compose configuration is missing)'));
    expect(h.helper.composeModels).toEqual([]);
  });

  it('refuses a dev service that the model does not have, and a local Feature', async () => {
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: { configText: '{ "dockerComposeFile": "compose.yml", "service": "web", "features": { "./local": {} } }' },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('local Feature ./local in a Docker Compose configuration');
    expect(error.message).toContain('service web (not in the Docker Compose configuration)');
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses a project volume of another environment', async () => {
    h.docker.volumes.set(`${PROJECT}_pgdata`, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/other' });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`${PROJECT}_pgdata`);
    expect(h.helper.builds).toEqual([]);
    // The volume of the other environment stays.
    expect(h.docker.volumes.get(`${PROJECT}_pgdata`)).toEqual({ [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/other' });
  });

  it('refuses a bind mount of repository files with a Docker Engine older than 26, naming the version', async () => {
    h.docker.apiVersion = '1.44';
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(
      Messages.unsupportedOptions(`service db: bind mount ${FOLDER}/init.sql → /docker-entrypoint-initdb.d/init.sql (needs Docker Engine 26 or newer)`),
    );
  });

  it('reports a compose file that Docker Compose cannot read, with its message in the details', async () => {
    h.helper.composeOutput = { error: 'yaml: line 3: mapping values are not allowed in this context' };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('buildFailed');
    expect(error.message).toBe(Messages.composeConfigurationFailed);
    expect(error.detail).toContain('mapping values are not allowed');
    expect(await h.registry.list()).toEqual([]);
  });

  it('refuses the image metadata of the dev service image before up (a Feature with privileged mode)', async () => {
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/dind:1', privileged: true }];
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
  });

  it('checks the model again before up creates the containers, with the labels of the volumes then', async () => {
    // Another environment took the name of the project volume while the image was built.
    h.helper.onBuild = () => {
      h.docker.volumes.set(`${PROJECT}_pgdata`, { [LABEL_ENVIRONMENT_ID]: OTHER_ID, [LABEL_REPOSITORY]: 'acme/other' });
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`${PROJECT}_pgdata`);
    expect(h.helper.builds).toHaveLength(1);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
  });

  it('does not check or pass the properties that the CLI ignores for Compose, and logs them', async () => {
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"remoteUser"', '"runArgs": ["--privileged"], "appPort": [3000], "remoteUser"') },
    };
    await h.service.open(TARGET, options());
    expect(h.logger.infos).toContain(
      `The Dev Container CLI ignores runArgs, appPort of ${DEFAULT_CONFIG_PATH} for Docker Compose. They are not used and not checked.`,
    );
    expect(h.helper.ups[0].override).not.toHaveProperty('runArgs');
    expect(h.helper.ups[0].override).not.toHaveProperty('appPort');
  });

  it('fails when up used another Compose project (L-2)', async () => {
    h.helper.composeProjectNameResult = 'api_devcontainer';
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain(`not ${PROJECT}`);
  });
});

describe('existing Docker Compose environment', () => {
  it('opens again without a build: up starts both containers', async () => {
    await seedCompose();
    const dev = devContainer()?.id;
    const db = dbContainer()?.id;
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(devContainer()).toMatchObject({ id: dev, state: 'running' });
    expect(dbContainer()).toMatchObject({ id: db, state: 'running' });
    expect(h.ui.prompts).toEqual([]);
    // The existing container passed the checks when it was created: no new volumes are created without a new container.
    expect(h.docker.log.filter((line) => line.startsWith('volume create'))).toEqual([]);
  });

  it('starts a stopped side service when the dev container runs (D-22)', async () => {
    await seedCompose({ dev: 'running', db: 'stopped' });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log).toContain(`start ${dbContainer()?.id}`);
    expect(dbContainer()?.state).toBe('running');
  });

  it('updates when the image of a side service changed: pull, build, and replace the dev container', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST } } });
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([`pull ${DB_IMAGE}`]);
    expect(h.helper.calls.filter((call) => call.startsWith('build') || call.startsWith('up'))).toEqual([
      `build ${IMAGE_2}`,
      `up ${IMAGE_2} --remove-existing-container`,
    ]);
    expect(upModel().services.app.image).toBe(IMAGE_2);
    const entry = await h.registry.get(ENV_ID);
    expect(entry?.buildRecord).toMatchObject({ environmentImage: IMAGE_2, images: { [DB_IMAGE]: DB_DIGEST_NEW } });
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
  });

  it('keeps the environment when the newer dev service image needs access to the computer (refused update)', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST } } });
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/dind:1', privileged: true }];
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('build') || call.startsWith('up'))).toEqual([`build ${IMAGE_2}`, `up ${IMAGE_1}`]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(h.ui.warnings).toEqual([Messages.updateRefused('privileged mode')]);
    const entry = await h.registry.get(ENV_ID);
    expect(entry?.buildRecord?.environmentImage).toBe(IMAGE_1);
    expect(entry?.refusedUpdate).toMatchObject({ configHash: HASH, items: 'privileged mode' });

    // The same update is not built again.
    h.helper.calls.length = 0;
    devContainer()!.state = 'stopped';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
  });

  it('asks before a rebuild when the model changed, and rebuilds on "Rebuild now"', async () => {
    await seedCompose();
    useCompose(h, output((m) => (m.services.db.environment = { POSTGRES_PASSWORD: 'dev' })));
    h.ui.configurationChangedAnswer = 'rebuildNow';
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(true);
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO}`]);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    const changed = (h.helper.composeOutput as ComposeModelOutput).model;
    expect((await h.registry.get(ENV_ID))?.buildRecord?.configHash).toBe(composeConfigHash(CONFIG_TEXT, changed, {}));
  });

  it('counts an unchanged model as unchanged, and a model that cannot be read as changed', async () => {
    await seedCompose();
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(false);
    h.helper.composeOutput = { error: 'yaml: invalid' };
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(true);
  });

  it('starts the containers with docker start when the configuration cannot be read (D-15), the services first', async () => {
    await seedCompose();
    h.helper.composeOutput = { error: 'yaml: invalid' };
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([`start ${dbContainer()?.id}`, `start ${devContainer()?.id}`]);
    expect(h.ui.warnings).toEqual([Messages.composeConfigurationFailed]);
  });

  it('starts all containers with docker start when the workspace helper is not available', async () => {
    await seedCompose();
    h.helper.ensureImageError = new UserFacingError('helperFailed', Messages.helperFailed);
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([`start ${dbContainer()?.id}`, `start ${devContainer()?.id}`]);
  });

  it('replaces a single container of the environment when the configuration became a Compose configuration', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    // Compose pulls a missing image of a side service itself (pull_policy missing).
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0].id;
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${single}`);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(devContainer()).toMatchObject({ name: NAME, state: 'running' });
    expect(dbContainer()?.state).toBe('running');
    // The containers of the configuration are new: the volumes are created with the labels before `up`.
    expect(h.docker.volumes.get(`${PROJECT}_pgdata`)?.[LABEL_VOLUME]).toBe(VOLUME_KIND_COMPOSE);
  });
});

describe('stop of a Docker Compose environment', () => {
  it('stops the dev container first, then the other services', async () => {
    await seedCompose({ dev: 'running', db: 'running' });
    await h.service.stop(ENV_ID);
    expect(h.docker.log.filter((line) => line.startsWith('stop'))).toEqual([`stop ${devContainer()?.id}`, `stop ${dbContainer()?.id}`]);
    expect(dbContainer()?.state).toBe('stopped');
  });

  it('stops a running side service also when the dev container does not run', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    await h.service.stop(ENV_ID);
    expect(h.docker.log.filter((line) => line.startsWith('stop'))).toEqual([`stop ${dbContainer()?.id}`]);
  });
});
