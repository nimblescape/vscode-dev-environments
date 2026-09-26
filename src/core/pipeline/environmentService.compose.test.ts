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
  HOST_ACCESS_UNRESTRICTED,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONTAINER_VERSION,
  LABEL_HOST_ACCESS,
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
  DEFAULT_CONFIG_TEXT,
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
async function seedCompose(
  p: {
    dev?: ContainerState | null;
    db?: ContainerState | null;
    record?: Partial<BuildRecord>;
    /** More labels of the dev container and of the db container. */
    devLabels?: Record<string, string>;
    dbLabels?: Record<string, string>;
  } = {},
): Promise<void> {
  await seedEnvironment(h, {
    container: p.dev === undefined ? 'stopped' : p.dev,
    containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app', ...p.devLabels },
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
      labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db', ...p.dbLabels },
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
    // D-7 (package C of unit 6): the volume of a `mounts` entry is a volume of the project too (`<project>_cache`), so it
    // is `compose` (never shared with another environment), not `additional`.
    expect(h.docker.volumes.get(`${PROJECT}_cache`)).toEqual({ ...labels, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE });
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

  // Package C of unit 6 integrates the switch of the host access checks: privileged mode is access to the computer
  // (class `computer`), which the checks off lift, as for a single container (describe 'Docker Compose with the host access checks off').
  // So this refusal is checked with the checks on; the checks off keep the items of the class `protected` refused (below).
  it('refuses a privileged side service before any build', async () => {
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

  it('refuses the workspace volume in a side service before any build, also with the host access checks off', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    useCompose(
      h,
      output((m) => {
        (m.services.db.volumes as unknown[]).push({ type: 'bind', source: '/workspaces', target: '/w' });
      }),
    );
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess('service db: bind mount /workspaces → /w (the workspace volume, which holds the GitHub token)'));
    expect(h.helper.builds).toEqual([]);
    expect(await h.registry.list()).toEqual([]);
  });

  // Package C of unit 6: devcontainer.json of a Compose configuration follows the switch as a single configuration does
  // (privileged mode is lifted with the checks off, describe 'Docker Compose with the host access checks off'); it is checked with the
  // checks on here.
  it('checks devcontainer.json of a Compose configuration with the rules of a single configuration', async () => {
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

// ---------------------------------------------------------------------------------------------------------------------
// Package C of unit 6: the host name, the switch of the host access checks, Delete, a failed first open, a change back
// to a single container, and the restore after a lost registry.

/** The labels of the environment on a volume (additionalVolumeLabels) with the kind `kind`. */
function volumeLabelsOf(kind: string): Record<string, string> {
  return { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id, [LABEL_VOLUME]: kind };
}

describe('the host name of the dev container', () => {
  it('names the dev container after the repository, as a single container, and not the other services', async () => {
    await h.service.open(TARGET, options());
    expect(upModel().services.app.hostname).toBe('api');
    expect(upModel().services.db).not.toHaveProperty('hostname');
  });

  it('keeps the host name of the dev service, and sets none with network_mode host', async () => {
    useCompose(h, output((m) => (m.services.app.hostname = 'box')));
    await h.service.open(TARGET, options());
    expect(upModel().services.app.hostname).toBe('box');
    h.cleanup();
    h = createHarness({ newEnvironmentId: () => ENV_ID });
    useCompose(h, output((m) => (m.services.app.network_mode = 'host')));
    await h.service.open(TARGET, options());
    expect(upModel().services.app).not.toHaveProperty('hostname');
  });
});

describe('Docker Compose with the host access checks off for the repository', () => {
  const offLines = () => h.logger.warnings.filter((line) => line.startsWith(`The host access checks are off for ${REPO}`));

  it('opens a model with a privileged service and the Docker socket, keeps its ports, and labels every container', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    useCompose(
      h,
      output((m) => {
        m.services.db.privileged = true;
        (m.services.db.volumes as unknown[]).push({ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' });
        m.services.db.ports = [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp', host_ip: '0.0.0.0' }];
      }),
    );
    await h.service.open(TARGET, options());
    const m = upModel();
    expect(m.services.db).toMatchObject({ privileged: true, ports: [{ target: 5432, published: '5432', host_ip: '0.0.0.0' }] });
    expect(m.services.db.volumes).toContainEqual({ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' });
    for (const container of h.docker.containersOf(ENV_ID)) expect(container.labels[LABEL_HOST_ACCESS]).toBe(HOST_ACCESS_UNRESTRICTED);
    expect(offLines()).toHaveLength(1);
  });

  it('keeps the ports of the model without an address as they are (no 127.0.0.1)', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    await h.service.open(TARGET, options());
    expect(upModel().services.db.ports).toEqual([{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' }]);
  });

  it('allows devcontainer.json and a Feature that need the computer', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"remoteUser"', '"privileged": true, "remoteUser"') } };
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/dind:1', privileged: true }];
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  it('still refuses what stays refused with the checks off: a variable of the GitHub CLI in the dev service', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    useCompose(h, output((m) => (m.services.app.environment = { GH_TOKEN: 'x' })));
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service app: variable GH_TOKEN in environment');
    expect(h.helper.builds).toEqual([]);
  });

  it('creates the containers again once the checks are on again (the dev container has the label)', async () => {
    await seedCompose({ devLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED }, dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
    const m = upModel();
    expect(m.services.app.labels).not.toHaveProperty(LABEL_HOST_ACCESS);
    expect(m.services.db.labels).not.toHaveProperty(LABEL_HOST_ACCESS);
    expect(m.services.db.ports).toEqual([expect.objectContaining({ host_ip: '127.0.0.1' })]);
    expect(devContainer()?.labels[LABEL_HOST_ACCESS]).toBeUndefined();
    expect(h.progress.details).toContain(Messages.containerHostAccessChecksOn);
  });

  it('creates the containers again when only a side service has the label', async () => {
    await seedCompose({ dev: 'running', db: 'running', dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
    expect(h.progress.details).toContain(Messages.containerHostAccessChecksOn);
    expect(h.logger.infos.some((line) => line.includes(`${PROJECT}-db-1 was created while the host access checks were off`))).toBe(true);
  });

  it('refuses the model once the checks are on again when it still needs the computer, and starts nothing', async () => {
    await seedCompose({ devLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    useCompose(h, output((m) => (m.services.db.privileged = true)));
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.message).toBe(Messages.hostAccess('service db: privileged mode'));
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
  });

  it('does not start containers of the checks-off time with docker start when the configuration cannot be read (D-15)', async () => {
    await seedCompose({ devLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED }, dbLabels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    h.helper.composeOutput = { error: 'yaml: invalid' };
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
    expect(h.helper.ups).toEqual([]);
  });
});

describe('Delete of a Docker Compose environment', () => {
  async function seedForDelete(): Promise<{ oneOff: string }> {
    await seedCompose({ dev: 'running', db: 'running' });
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      entry.additionalVolumes = [`${PROJECT}_pgdata`, `${PROJECT}_cache`, 'shared-tools'];
    });
    h.docker.volumes.set(`${PROJECT}_pgdata`, volumeLabelsOf(VOLUME_KIND_COMPOSE));
    h.docker.volumes.set(`${PROJECT}_cache`, volumeLabelsOf(VOLUME_KIND_COMPOSE));
    h.docker.volumes.set('shared-tools', volumeLabelsOf(VOLUME_KIND_ADDITIONAL));
    h.docker.networks.set(`${PROJECT}_default`, COMPOSE_LABELS);
    h.docker.networks.set('devenv-7c1d2e3f_default', { 'com.docker.compose.project': 'devenv-7c1d2e3f' });
    h.docker.images.add(`${PROJECT}-app`);
    h.docker.images.add(`${PROJECT}-worker:latest`);
    h.docker.images.add('devenv-7c1d2e3f-app');
    // A one-off container of `docker compose run`: the label of the project, not the one of the environment.
    const oneOff = h.docker.addContainer({ environmentId: 'x', name: `${PROJECT}-db-run-1`, state: 'stopped', image: DB_IMAGE, labels: COMPOSE_LABELS });
    delete oneOff.labels[LABEL_ENVIRONMENT_ID];
    return { oneOff: oneOff.id };
  }

  it('lists the volumes of the project apart from the other additional volumes', async () => {
    await seedForDelete();
    expect(await h.service.removableServiceDataVolumes(ENV_ID)).toEqual([`${PROJECT}_pgdata`, `${PROJECT}_cache`]);
    expect(await h.service.removableAdditionalVolumes(ENV_ID)).toEqual(['shared-tools']);
  });

  it('removes all containers, the networks, and the images of the project, and keeps the data of the services by default', async () => {
    const { oneOff } = await seedForDelete();
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    expect(h.docker.containerByRef(oneOff)).toBeUndefined();
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(false);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(false);
    expect(h.docker.images.has(`${PROJECT}-worker:latest`)).toBe(false);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
    expect(h.docker.volumes.has(NAME)).toBe(false);
    // The data of the services and the other volumes stay; so does everything of another environment.
    expect(h.docker.volumes.has(`${PROJECT}_pgdata`)).toBe(true);
    expect(h.docker.volumes.has('shared-tools')).toBe(true);
    expect(h.docker.networks.has('devenv-7c1d2e3f_default')).toBe(true);
    expect(h.docker.images.has('devenv-7c1d2e3f-app')).toBe(true);
    expect(await h.registry.list()).toEqual([]);
    // The containers go before the networks, which Docker removes only when no container uses them.
    expect(h.docker.log.indexOf(`network rm ${PROJECT}_default`)).toBeGreaterThan(h.docker.log.indexOf(`rm ${oneOff}`));
  });

  it('removes the volumes of the project that the user ticked', async () => {
    await seedForDelete();
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [`${PROJECT}_pgdata`] });
    expect(h.docker.volumes.has(`${PROJECT}_pgdata`)).toBe(false);
    expect(h.docker.volumes.has(`${PROJECT}_cache`)).toBe(true);
  });

  it('removes the project also without a build record (a restored environment), found by its containers', async () => {
    await seedForDelete();
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      delete entry.buildRecord;
    });
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(false);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(false);
  });
});

describe('a failed first open of a Docker Compose configuration', () => {
  it('removes the containers, the networks, and the images of the project', async () => {
    h.helper.onBuild = () => {
      h.docker.images.add(`${PROJECT}-app`);
    };
    h.helper.composeProjectNameResult = 'api_devcontainer';
    await rejection(h.service.open(TARGET, options()));
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(false);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(false);
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
    expect(h.docker.volumes.has(NAME)).toBe(false);
    expect(await h.registry.list()).toEqual([]);
  });
});

describe('a Docker Compose environment whose configuration became a single container', () => {
  beforeEach(async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    h.docker.networks.set(`${PROJECT}_default`, COMPOSE_LABELS);
    h.docker.images.add(`${PROJECT}-app`);
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
  });

  it('removes the other services, then creates the container again as a single container', async () => {
    const db = dbContainer()?.id;
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${db}`);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1} --remove-existing-container`]);
    // `up` got a single container, and the containers of Compose are gone.
    expect(h.helper.ups[0].override).toHaveProperty('runArgs');
    const containers = h.docker.containersOf(ENV_ID);
    expect(containers).toHaveLength(1);
    expect(containers[0].labels['com.docker.compose.project']).toBeUndefined();
    // The side service went before `up`, which finds the container by the ID label; the network after it.
    expect(h.docker.log.indexOf(`rm ${db}`)).toBeLessThan(h.docker.log.indexOf(`network rm ${PROJECT}_default`));
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(false);
    expect(h.progress.details).toContain(Messages.containerComposeReplaced);
    // The merged configuration of the container of Compose is not checked (the CLI could read another service).
    expect(h.logger.infos.some((line) => line.includes('was created for a Docker Compose configuration. Its merged configuration is not checked'))).toBe(true);
  });

  it('removes the images that Compose built for the project after the rebuild', async () => {
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(false);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.compose).toBeUndefined();
  });
});

describe('restore of a Docker Compose environment after a lost registry', () => {
  it('restores the entry with the volumes of the project, finds both containers, and asks about the data at Delete', async () => {
    h.docker.volumes.set(NAME, { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.volumes.set(`${PROJECT}_pgdata`, volumeLabelsOf(VOLUME_KIND_COMPOSE));
    h.docker.images.add(IMAGE_1);
    h.docker.images.add(DB_IMAGE);
    h.docker.addContainer({
      environmentId: ENV_ID,
      name: NAME,
      state: 'stopped',
      image: IMAGE_1,
      labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app' },
    });
    h.docker.addContainer({
      environmentId: ENV_ID,
      name: `${PROJECT}-db-1`,
      state: 'stopped',
      image: DB_IMAGE,
      labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' },
    });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    const restored = await h.registry.get(ENV_ID);
    expect(restored?.additionalVolumes).toEqual([`${PROJECT}_pgdata`]);
    expect(await h.service.removableServiceDataVolumes(ENV_ID)).toEqual([`${PROJECT}_pgdata`]);
    expect((await h.service.inspectStates())?.get(ENV_ID)).toEqual({ container: 'stopped', volume: true });

    // Without a build record, the next open builds, and `up` creates the dev container again in the same project.
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.helper.ups[0].env).toEqual({ COMPOSE_PROJECT_NAME: PROJECT });
    expect(dbContainer()?.state).toBe('running');
    expect((await h.registry.get(ENV_ID))?.buildRecord?.compose).toEqual({ service: 'app', images: [`${PROJECT}-app`] });
  });
});
