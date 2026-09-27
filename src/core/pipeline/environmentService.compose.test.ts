// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 6, Docker Compose configurations (implementation notes, section "Docker Compose"): the open pipeline for a
// configuration with `dockerComposeFile` and `service`. The model run, the check of every service before any build and
// before each `up` that creates containers, the build and up models, the volumes, the labels, the image check over all
// services, update, rebuild, refused update, and start and stop of all containers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandError, UserFacingError } from '../errors';
import {
  COMPOSE_DEV_DOCKERFILE,
  COMPOSE_MODEL_PATH,
  WORKSPACE_VOLUME_KEY,
  composeConfigHash,
  composeInputsHash,
  type ComposeModel,
  type ComposeModelOutput,
} from '../helper/compose';
import { ANALYSIS_FAILED_ITEM, dockerCheckItem } from '../helper/configurationAnalysis';
import { Messages } from '../messages';
import { abortError } from '../ports';
import { EXISTING_PATHS_SCRIPT, MAX_SERVICE_FOLDERS, OWNERSHIP_FIX_SCRIPT, servicePathArguments } from '../git/gitSummary';
import {
  CONTAINER_VERSION,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONFIG_PATH,
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
import { DEFAULT_CONFIG_PATH, repositoryServiceDataFolders } from './pipelineRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const NAME = resourceName(REPO, ENV_ID);
const PROJECT = composeProjectName(ENV_ID);
const IMAGE_1 = environmentImageName(ENV_ID, 1);
const IMAGE_2 = environmentImageName(ENV_ID, 2);
const FOLDER = '/workspaces/api';
const DB_IMAGE = 'postgres:16';
const DB_DIGEST = `sha256:${'d'.repeat(64)}`;
const DB_DIGEST_NEW = `sha256:${'e'.repeat(64)}`;
// Compose puts the project and, on containers only, the number of the container and the hash of its configuration
// (review round 2, D2-4: isComposeContainer needs one of them).
const COMPOSE_LABELS = { 'com.docker.compose.project': PROJECT, 'com.docker.compose.container-number': '1' };

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
    inputsHash: 'inputs-1',
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
    // Review round 2 (D2-3): changed expectation, the volume of the service db is labelled as its data.
    expect(h.docker.volumes.get(`${PROJECT}_pgdata`)).toEqual({ ...labels, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE, 'devenv.service-data': 'true' });
    // D-7 (package C of unit 6): the volume of a `mounts` entry is a volume of the project too (`<project>_cache`), so it
    // is `compose` (never shared with another environment), not `additional`.
    expect(h.docker.volumes.get(`${PROJECT}_cache`)).toEqual({ ...labels, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE });
    expect(h.docker.log.indexOf(`volume create ${PROJECT}_pgdata`)).toBeGreaterThanOrEqual(0);

    // Both containers carry the environment ID; the lookup finds the dev container.
    expect(devContainer()).toMatchObject({ name: NAME, state: 'running', image: IMAGE_1 });
    expect(dbContainer()).toMatchObject({ state: 'running', labels: expect.objectContaining({ [LABEL_ENVIRONMENT_ID]: ENV_ID }) });
    expect((await h.docker.findContainer(ENV_ID, NAME))?.name).toBe(NAME);
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

  it('names an engine whose version could not be read as unknown, not as old (review round 1, P-5)', async () => {
    h.docker.apiVersion = undefined;
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(
      Messages.unsupportedOptions(
        `service db: bind mount ${FOLDER}/init.sql → /docker-entrypoint-initdb.d/init.sql (needs Docker Engine 26 or newer; the version of the Docker Engine could not be read)`,
      ),
    );
  });

  it('refuses a network of another environment under a name of its own, found by its labels, before any build (review round 1, S2)', async () => {
    useCompose(
      h,
      output((m) => {
        m.networks = { ...m.networks, backend: { name: 'backend' } };
        m.services.db.networks = { default: null, backend: null };
      }),
    );
    h.docker.networks.set('backend', { 'com.docker.compose.project': 'devenv-7c1d2e3f' });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('network backend of another environment'));
    expect(h.helper.builds).toEqual([]);
    expect(h.docker.networkInspections[0]).toEqual(expect.arrayContaining([`${PROJECT}_default`, 'backend']));
  });

  it('refuses an external network that a container of another environment uses (review round 1, S2)', async () => {
    useCompose(h, output((m) => (m.networks = { ...m.networks, shared: { name: 'shared', external: true } })));
    const other = h.docker.addContainer({ environmentId: OTHER_ID, name: 'devenv-acme-other-7c1d2e3f', state: 'running', image: 'x' });
    h.docker.networks.set('shared', {});
    h.docker.networkContainers.set('shared', [other.id]);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('network shared of another environment'));
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses a network of another environment that network_mode names by a prefix of its ID (review round 2, S2-04)', async () => {
    useCompose(h, output((m) => (m.services.db.network_mode = 'f00dbabe')));
    h.docker.networks.set('devenv-7c1d2e3f_default', { 'com.docker.compose.project': 'devenv-7c1d2e3f' });
    h.docker.networkIds.set('devenv-7c1d2e3f_default', `f00dbabe${'0'.repeat(56)}`);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('service db: network f00dbabe of another environment'));
    expect(h.helper.builds).toEqual([]);
  });

  it('allows an external network with a container of another environment of the same owner (review round 2, P2-2)', async () => {
    useCompose(h, output((m) => (m.networks = { ...m.networks, shared: { name: 'shared', external: true } })));
    await seedEnvironment(h, { id: OTHER_ID, repository: 'acme/web', container: 'running' });
    h.docker.networks.set('shared', {});
    h.docker.networkContainers.set('shared', [h.docker.containersOf(OTHER_ID)[0].id]);
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  it('refuses a local build whose Dockerfile links out of the repository, before any build (review round 1, S1)', async () => {
    useCompose(h, {
      ...output((m) => (m.services.db = { build: { context: `${FOLDER}/db`, dockerfile: 'Dockerfile' } })),
      realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/db`]: '/devenv-cache', [`${FOLDER}/db/Dockerfile`]: '/devenv-cache/Dockerfile' },
    });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toContain(`service db: build context ${FOLDER}/db (a link to /devenv-cache, outside of the repository)`);
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses a side service built FROM the image of another environment (review round 1, S4)', async () => {
    useCompose(h, {
      ...output((m) => (m.services.db = { build: { context: `${FOLDER}/db`, dockerfile: 'Dockerfile' } })),
      dockerfiles: { db: 'FROM index.docker.io/library/devenv-7c1d2e3f:3\n' },
    });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess('service db: FROM image index.docker.io/library/devenv-7c1d2e3f:3 of another environment'));
  });

  it('refuses the image of a side service that Docker would find by the prefix of its ID (review round 2, S2-05)', async () => {
    useCompose(h, output((m) => (m.services.db.image = 'a1b2c3')));
    h.docker.images.add('a1b2c3');
    h.docker.imageRepoNames.set('a1b2c3', { repoTags: ['devenv-7c1d2e3f-db:latest'], repoDigests: [] });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.unsupportedOptions('service db: image a1b2c3 (an image ID; name the image)'));
    expect(h.helper.builds).toEqual([]);
  });

  it('uses the image of a side service that Docker Compose built for another project (review round 2, D2-1)', async () => {
    h.docker.images.add(DB_IMAGE);
    h.docker.imageConfigs.set(DB_IMAGE, { Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'db' } });
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  it('refuses a label of the extension on the image of a side service before up creates the containers (review round 1, D2)', async () => {
    h.docker.images.add(DB_IMAGE);
    h.docker.imageConfigs.set(DB_IMAGE, { Labels: { 'devenv.compose-service': 'x' } });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toBe(Messages.hostAccess(`label devenv.compose-service of the image ${DB_IMAGE}`));
    expect(h.helper.ups).toEqual([]);
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
    // The existing container passed the checks when it was created: the model and the image are not checked again
    // (no image inspect). Review round 1 (P-2): the volumes of the model that are missing are created all the same
    // (before, none was created without a new container, and `up` failed on an external volume that did not exist).
    expect(h.docker.log.filter((line) => line.startsWith('image inspect'))).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('volume create')).sort()).toEqual([`volume create ${PROJECT}_cache`, `volume create ${PROJECT}_pgdata`]);
  });

  it('creates only the missing volumes when up adds the container of a new service (review round 1, P-2)', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    h.docker.volumes.set(`${PROJECT}_pgdata`, volumeLabelsOf(VOLUME_KIND_COMPOSE));
    h.docker.volumes.set(`${PROJECT}_cache`, volumeLabelsOf(VOLUME_KIND_COMPOSE));
    // The model gained a service with a volume; "Rebuild later" starts the environment without a build.
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: DB_IMAGE, volumes: [{ type: 'volume', source: 'cachedata', target: '/data' }] };
        m.volumes = { ...m.volumes, cachedata: { name: `${PROJECT}_cachedata` } };
      }),
    );
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    expect(h.docker.log.filter((line) => line.startsWith('volume create'))).toEqual([`volume create ${PROJECT}_cachedata`]);
    expect(h.docker.volumes.get(`${PROJECT}_cachedata`)?.[LABEL_VOLUME]).toBe(VOLUME_KIND_COMPOSE);
    expect(h.docker.log.indexOf(`volume create ${PROJECT}_cachedata`)).toBeGreaterThanOrEqual(0);
    expect(upModel().volumes).toMatchObject({ cachedata: { name: `${PROJECT}_cachedata`, external: true } });
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
    // review round 16, Dp: the image of the dev service is not here, so it is downloaded before the build, whose user
    // (with Features) the Dev Container CLI writes into its compose file for the build (checkComposeBuildImages).
    expect(h.docker.log.filter((line) => line.startsWith('pull'))).toEqual([`pull ${DB_IMAGE}`, `pull ${BASE_IMAGE}`]);
    expect(h.helper.calls.filter((call) => call.startsWith('build') || call.startsWith('up'))).toEqual([
      `build ${IMAGE_2}`,
      `up ${IMAGE_2} --remove-existing-container`,
    ]);
    expect(upModel().services.app.image).toBe(IMAGE_2);
    const entry = await h.registry.get(ENV_ID);
    expect(entry?.buildRecord).toMatchObject({ environmentImage: IMAGE_2, images: { [DB_IMAGE]: DB_DIGEST_NEW } });
    expect(h.docker.images.has(IMAGE_1)).toBe(false);
  });

  it('removes the old base image of the dev service after an update, but not the old image of a side service (review round 1, D5)', async () => {
    await seedCompose({
      record: { images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST }, compose: { service: 'app', images: [`${PROJECT}-app`], serviceImages: [DB_IMAGE] } },
    });
    const oldBase = `mcr.microsoft.com/devcontainers/base@${DIGEST_OLD}`;
    const oldDb = `docker.io/library/postgres@${DB_DIGEST}`;
    h.docker.images.add(oldBase);
    h.docker.images.add(oldDb);
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
    expect(h.docker.log).toContain(`rmi ${oldBase}`);
    // The image of the database is the user's (for example also used outside Dev Environments).
    expect(h.docker.log).not.toContain(`rmi ${oldDb}`);
    expect(h.docker.images.has(oldDb)).toBe(true);
  });

  it('removes no base image of a Docker Compose build record without the list of service images (review round 1, D5)', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST } } });
    const oldDb = `docker.io/library/postgres@${DB_DIGEST}`;
    h.docker.images.add(oldDb);
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW, [DB_IMAGE]: DB_DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([IMAGE_2]);
    expect(h.docker.log.filter((line) => line.startsWith('rmi') && line.includes('@'))).toEqual([]);
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

  it('takes over a new Compose version that prints the unchanged files as another model, without a question (review round 1, P-4)', async () => {
    await seedCompose({ record: { compose: { service: 'app', images: [`${PROJECT}-app`], serviceImages: [DB_IMAGE], version: '2.39.0', inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', {}) } } });
    // The same files, printed by the newer plugin with a key more.
    useCompose(h, { ...output((m) => (m.services.db.stop_signal = 'SIGTERM')), version: '2.40.3' });
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(false);
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.ui.prompts).toEqual([]);
    expect(h.helper.builds).toEqual([]);
    const record = (await h.registry.get(ENV_ID))?.buildRecord;
    expect(record?.configHash).toBe(composeConfigHash(CONFIG_TEXT, (h.helper.composeOutput as ComposeModelOutput).model, {}));
    expect(record?.compose?.version).toBe('2.40.3');
  });

  it('asks when the files changed, and when the same Compose version prints another model (review round 1, P-4)', async () => {
    const record = { compose: { service: 'app', images: [`${PROJECT}-app`], serviceImages: [DB_IMAGE], version: '2.40.3', inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', {}) } };
    await seedCompose({ record });
    useCompose(h, { ...output(), version: '2.41.0', inputsHash: 'inputs-2' });
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(true);
    useCompose(h, output((m) => (m.services.db.stop_signal = 'SIGTERM')));
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(true);
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.ui.prompts).toEqual([`configurationChanged ${REPO}`]);
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

  it('starts all containers with docker start when up fails because the workspace helper failed (review round 1, P-3)', async () => {
    await seedCompose();
    h.helper.upError = () => new UserFacingError('helperFailed', Messages.helperFailed);
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([`start ${dbContainer()?.id}`, `start ${devContainer()?.id}`]);
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
    // Review round 1 (P-1): the kind switches only with a build (before: also with "Rebuild later").
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${single}`);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(devContainer()).toMatchObject({ name: NAME, state: 'running' });
    expect(dbContainer()?.state).toBe('running');
    // The containers of the configuration are new: the volumes are created with the labels before `up`.
    expect(h.docker.volumes.get(`${PROJECT}_pgdata`)?.[LABEL_VOLUME]).toBe(VOLUME_KIND_COMPOSE);
    // Review round 1 (P-1): the user learns that the files outside the repository are removed.
    expect(h.progress.details).toContain(Messages.containerComposeCreated);
  });

  it('does not start the single container from its image when up of the new Compose configuration fails (review round 2, D2-4)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0];
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('compose up failed') : undefined);
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('now uses Docker Compose');
    expect(error.detail).toContain(`removed the container ${single.name}`);
    // No `up` of the other kind (a single container from the old image, or Compose from it).
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(h.docker.images.has(IMAGE_1)).toBe(true);
  });

  it('starts the single container as it is on "Rebuild later" when the configuration became a Compose configuration (review round 1, P-1)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    const single = h.docker.containersOf(ENV_ID)[0].id;
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log).not.toContain(`rm ${single}`);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_1}`]);
    // A single container: the override configuration of a single container, no model.
    expect(h.helper.ups[0].override).toHaveProperty('runArgs');
    expect(h.helper.ups[0].files).toBeUndefined();
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
    expect(h.docker.containersOf(ENV_ID)[0]).toMatchObject({ id: single, state: 'running' });
    expect(h.progress.details).not.toContain(Messages.containerComposeCreated);
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
    // Review round 2 (D2-2): changed expectation, `checked` on every service (before: no label).
    expect(m.services.app.labels).toMatchObject({ [LABEL_HOST_ACCESS]: 'checked' });
    expect(m.services.db.labels).toMatchObject({ [LABEL_HOST_ACCESS]: 'checked' });
    expect(m.services.db.ports).toEqual([expect.objectContaining({ host_ip: '127.0.0.1' })]);
    expect(devContainer()?.labels[LABEL_HOST_ACCESS]).toBe('checked');
    expect(h.progress.details).toContain(Messages.containerHostAccessChecksOn);
  });

  it('does not take a side service for unrestricted when the image that Compose built has the label (review round 2, D2-2)', async () => {
    useCompose(h, {
      ...output((m) => (m.services.tool = { build: { context: FOLDER, dockerfile: 'tool.Dockerfile' } })),
      dockerfiles: { tool: 'FROM alpine:3.22\nLABEL devenv.host-access=unrestricted\n' },
      realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/init.sql`]: `${FOLDER}/init.sql`, [FOLDER]: FOLDER, [`${FOLDER}/tool.Dockerfile`]: `${FOLDER}/tool.Dockerfile` },
    });
    // The image that Compose builds during `up` (not checked before it): its label would reach the container.
    h.docker.images.add(`${PROJECT}-tool`);
    h.docker.imageConfigs.set(`${PROJECT}-tool`, { Labels: { [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    await h.service.open(TARGET, options());
    const tool = h.docker.containersOf(ENV_ID).find((c) => c.labels[LABEL_COMPOSE_SERVICE] === 'tool');
    expect(tool?.labels[LABEL_HOST_ACCESS]).toBe('checked');
    // The next open finds the containers current: nothing is created again.
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups).toHaveLength(1);
    expect(h.progress.details).not.toContain(Messages.containerHostAccessChecksOn);
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

  it('lists a volume with a name of its own that a side service mounts as data of the services (review round 1, D1)', async () => {
    // The database keeps its data in a volume that the model names itself (label `additional`), recorded at the open.
    useCompose(
      h,
      output((m) => {
        m.volumes = { pgdata: { name: 'myapp-db' } };
      }),
    );
    await h.service.open(TARGET, options());
    expect(h.docker.volumes.get('myapp-db')?.[LABEL_VOLUME]).toBe(VOLUME_KIND_ADDITIONAL);
    // Review round 2 (D2-3): and the label of the data of a service.
    expect(h.docker.volumes.get('myapp-db')?.['devenv.service-data']).toBe('true');
    expect((await h.registry.get(ENV_ID))?.serviceVolumes).toEqual(['myapp-db']);
    expect(await h.service.removableServiceDataVolumes(ENV_ID)).toContain('myapp-db');
    expect(await h.service.removableAdditionalVolumes(ENV_ID)).not.toContain('myapp-db');
    // Also without the record: the container of the service mounts it.
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      delete entry.serviceVolumes;
    });
    dbContainer()!.volumes = ['myapp-db'];
    expect(await h.service.removableServiceDataVolumes(ENV_ID)).toContain('myapp-db');
    expect(await h.service.removableAdditionalVolumes(ENV_ID)).not.toContain('myapp-db');
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

  it('keeps a container of another environment that has the label of the project (review round 1, D3)', async () => {
    await seedForDelete();
    // For example a single container of another environment whose image has the label of this project.
    const foreign = h.docker.addContainer({ environmentId: OTHER_ID, name: 'devenv-acme-other-7c1d2e3f', state: 'running', image: 'x', labels: { ...COMPOSE_LABELS } });
    h.docker.images.add(`${PROJECT}-tool`);
    h.docker.imageConfigs.set(`${PROJECT}-tool`, { Labels: { [LABEL_ENVIRONMENT_ID]: OTHER_ID } });
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.containerByRef(foreign.id)).toBeDefined();
    expect(h.docker.log).not.toContain(`rm ${foreign.id}`);
    expect(h.docker.images.has(`${PROJECT}-tool`)).toBe(true);
    expect(h.docker.images.has(`${PROJECT}-app`)).toBe(false);
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
    // Review round 1 (P-1): the kind switches only with a build (before: also with "Rebuild later").
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${db}`);
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    // `up` got a single container, and the containers of Compose are gone.
    expect(h.helper.ups[0].override).toHaveProperty('runArgs');
    const containers = h.docker.containersOf(ENV_ID);
    expect(containers).toHaveLength(1);
    // Review round 2 (D2-1): changed expectation, the override configuration sets the label empty (before: not set).
    expect(containers[0].labels['com.docker.compose.project']).toBe('');
    expect(containers[0].labels['com.docker.compose.service']).toBe('');
    // The side service went before `up`, which finds the container by the ID label; the network after it.
    expect(h.docker.log.indexOf(`rm ${db}`)).toBeLessThan(h.docker.log.indexOf(`network rm ${PROJECT}_default`));
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(false);
    expect(h.progress.details).toContain(Messages.containerComposeReplaced);
    // The merged configuration of the container of Compose is not checked (the CLI could read another service).
    expect(h.logger.infos.some((line) => line.includes('was created for a Docker Compose configuration. Its merged configuration is not checked'))).toBe(true);
  });

  it('does not start the old image of Docker Compose as a single container when up fails (review round 2, D2-4)', async () => {
    const db = dbContainer();
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('up failed') : undefined);
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('no longer uses Docker Compose');
    expect(error.detail).toContain(`removed the container ${db?.name} of the service db`);
    // Before (D2-4): a single container from the image of the Compose dev service, which inherits the label of the
    // project and was then taken for a container of Compose.
    expect(h.helper.calls.filter((call) => call.startsWith('up'))).toEqual([`up ${IMAGE_2} --remove-existing-container`]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
  });

  it('starts the containers of Docker Compose with docker start on "Rebuild later" (review round 1, P-1)', async () => {
    const db = dbContainer()?.id;
    const dev = devContainer()?.id;
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log).not.toContain(`rm ${db}`);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([`start ${db}`, `start ${dev}`]);
    expect(h.docker.networks.has(`${PROJECT}_default`)).toBe(true);
    expect(h.progress.details).not.toContain(Messages.containerComposeReplaced);
  });

  it('refuses to start on "Rebuild later" when the Docker Compose environment has no dev container (review round 1, P-1)', async () => {
    for (const container of h.docker.containersOf(ENV_ID)) h.docker.containers.delete(container.id);
    h.ui.configurationChangedAnswer = 'later';
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain('no longer uses Docker Compose');
    expect(h.helper.ups).toEqual([]);
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
  /** The workspace volume of the environment and a volume of its own with `labels`, which no container mounts. */
  function seedVolumes(volumes: Record<string, Record<string, string>>): void {
    h.docker.volumes.set(NAME, { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    for (const [name, labels] of Object.entries(volumes)) h.docker.volumes.set(name, labels);
  }

  it('restores the volumes of the services from their label, and asks about them at Delete (review round 2, D2-3)', async () => {
    // A volume with `name:` of the model (label `additional`) that the database used; no container mounts it now.
    seedVolumes({
      'myapp-db': { ...volumeLabelsOf(VOLUME_KIND_ADDITIONAL), 'devenv.service-data': 'true' },
      'shared-tools': volumeLabelsOf(VOLUME_KIND_ADDITIONAL),
    });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(ENV_ID))?.serviceVolumes).toEqual(['myapp-db']);
    expect(await h.service.removableServiceDataVolumes(ENV_ID)).toEqual(['myapp-db']);
    expect(await h.service.removableAdditionalVolumes(ENV_ID)).toEqual(['shared-tools']);
    // Review round 3 (P3-4): known by its label, so no "possibly".
    expect(await h.service.possibleServiceDataVolumes(ENV_ID)).toEqual([]);
  });

  it('asks about every volume of a restored entry whose volumes have no label of the data of a service (review round 2, D2-3)', async () => {
    // Created by a version before the label: whether a service used it is not known.
    seedVolumes({ 'myapp-db': volumeLabelsOf(VOLUME_KIND_ADDITIONAL), 'shared-tools': volumeLabelsOf(VOLUME_KIND_ADDITIONAL) });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect(await h.service.removableServiceDataVolumes(ENV_ID)).toEqual(['myapp-db', 'shared-tools']);
    expect(await h.service.removableAdditionalVolumes(ENV_ID)).toEqual([]);
    // Review round 3 (P3-4): the question names them as additional volumes that may hold data of services.
    expect(await h.service.possibleServiceDataVolumes(ENV_ID)).toEqual(['myapp-db', 'shared-tools']);
    // Once the entry has a build record (its next open), the volumes are known by their use again.
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      entry.buildRecord = { builtAt: '2026-09-24T15:40:00.000Z', environmentImage: IMAGE_1, buildNumber: 1, configPath: DEFAULT_CONFIG_PATH, configHash: HASH, images: {}, features: {} };
    });
    expect(await h.service.removableServiceDataVolumes(ENV_ID)).toEqual([]);
    expect(await h.service.removableAdditionalVolumes(ENV_ID)).toEqual(['myapp-db', 'shared-tools']);
  });

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
    // Review round 1 (D5): the record names the pulled images of the other services, which are no base images.
    // Review round 1 (P-4): the version of Compose and the hash of the files as written, too.
    expect((await h.registry.get(ENV_ID))?.buildRecord?.compose).toEqual({
      service: 'app',
      images: [`${PROJECT}-app`],
      serviceImages: [DB_IMAGE],
      version: '2.40.3',
      inputsHash: composeInputsHash(CONFIG_TEXT, 'inputs-1', {}),
      // Review round 10, D10-1 and D10-3: no serviceFolders here any more (before: [`${FOLDER}/init.sql`]): the entry
      // holds them (Environment.serviceFolders), and a read-only mount such as init.sql is not recorded.
    });
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toBeUndefined();
  });
});

describe('review round 3 of unit 6 (P3-1, P3-3, D3-1, D3-2)', () => {
  const DB_LABELS = { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db', 'com.docker.compose.config-hash': 'x' };

  function addDb(state: ContainerState = 'running'): ContainerInfo {
    return h.docker.addContainer({ environmentId: ENV_ID, name: `${PROJECT}-db-1`, state, image: DB_IMAGE, labels: { ...DB_LABELS } });
  }

  it('removes the containers that a failed up of the switch to Docker Compose created, and keeps the volumes (D3-1, P3-3)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('compose up failed') : undefined);
    // Compose created and started the db container before the dev service failed (for example a port in use).
    let db: ContainerInfo | undefined;
    h.helper.beforeUpError = () => {
      db = addDb();
    };
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(error.detail).toContain(`The containers that Docker Compose had created were removed again: the container ${PROJECT}-db-1 of the service db.`);
    expect(error.detail).not.toContain('could not be created.');
    expect(h.docker.log).toContain(`rm ${db?.id}`);
    expect(dbContainer()).toBeUndefined();
    expect(h.docker.volumes.has(`${PROJECT}_pgdata`)).toBe(true);
  });

  it('never takes a container of another service for the dev container of a single container (D3-1)', async () => {
    // As after a failed switch to Docker Compose whose db container could not be removed.
    await seedEnvironment(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('compose up failed') : undefined);
    await rejection(h.service.openEnvironment(ENV_ID, options()));
    const db = addDb();
    h.helper.upError = () => undefined;
    // "Rebuild later": the single container is created again from its image; the db container goes first.
    h.ui.configurationChangedAnswer = 'later';
    const result = await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${db.id}`);
    expect(h.helper.ups.at(-1)?.image).toBe(IMAGE_1);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).not.toContain(db.id);
    expect(result.containerName).toBe(NAME);
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
  });

  it('never lets an up find the container of another service next to a single container (D3-1)', async () => {
    // An up-to-date single container, and a container of a service of Docker Compose with the ID label.
    await seedEnvironment(h, { container: 'stopped' });
    const dev = devContainer();
    useSingle();
    const db = addDb();
    // Review round 4, P4-3: changed expectation. Next to a single dev container, the container of the other service is a
    // stray: it is removed (its volumes stay), and the single container starts as usual, without a rebuild (which would
    // not help when the configuration cannot be used).
    const result = await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${db.id}`);
    expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([dev?.id]);
    expect(h.helper.ups.map((up) => [up.image, up.removeExistingContainer])).toEqual([[IMAGE_1, false]]);
    expect(h.helper.builds).toEqual([]);
    expect(result.containerName).toBe(NAME);
    expect(h.docker.log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
  });

  it('keeps the kind of a restored environment without build record whose containers are of Docker Compose (D3-2)', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    await h.registry.updateEnvironment(ENV_ID, (e) => {
      delete e.buildRecord;
    });
    const db = dbContainer();
    const dev = devContainer();
    useSingle();
    // Review round 4, D4-3: changed expectation, a question of its own that names the switch (configurationKindChanged).
    h.ui.configurationKindChangedAnswer = 'later';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.ui.prompts).toEqual([`configurationKindChanged ${REPO}`]);
    expect(h.ui.kindQuestions).toEqual([Messages.configurationKindChanged(true, DEFAULT_CONFIG_PATH)]);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('rm'))).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toContain(`start ${dev?.id}`);
    expect(dbContainer()?.id).toBe(db?.id);
    // "Rebuild now" switches, as a rebuild does.
    // Review round 4, D4-3: changed expectation, the answer of configurationKindChanged.
    h.ui.configurationKindChangedAnswer = 'rebuildNow';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds).toHaveLength(1);
    expect(h.docker.log).toContain(`rm ${db?.id}`);
  });

  it('starts the existing environment when a Dockerfile of a service does not exist in the repository (P3-1)', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    useCompose(h, {
      ...output((m) => (m.services.db = { build: { context: `${FOLDER}/db`, dockerfile: 'Dockerfile' } })),
      realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/init.sql`]: `${FOLDER}/init.sql`, [`${FOLDER}/db`]: `${FOLDER}/db`, [`${FOLDER}/db/Dockerfile`]: null },
      missing: [`${FOLDER}/db/Dockerfile`],
    });
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openEnvironment(ENV_ID, options());
    const text = Messages.buildFileMissing(`service db: Dockerfile ${FOLDER}/db/Dockerfile`);
    expect(h.ui.warnings).toContain(text);
    expect(h.helper.builds).toEqual([]);
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toContain(`start ${devContainer()?.id}`);
    // A new environment: a plain error of the configuration, no refusal of the policy.
    const other = createHarness({ newEnvironmentId: () => ENV_ID });
    try {
      useCompose(other, h.helper.composeOutput as ComposeModelOutput);
      const error = await rejection(other.service.open(TARGET, { progress: other.progress }));
      expect(error.code).toBe('buildFailed');
      expect(error.message).toBe(text);
      expect(other.helper.builds).toEqual([]);
    } finally {
      other.cleanup();
    }
  });

  it('still refuses a build context or Dockerfile of the repository whose link leads nowhere or out (P3-1)', async () => {
    useCompose(h, {
      ...output((m) => (m.services.db = { build: { context: `${FOLDER}/db`, dockerfile: 'Dockerfile' } })),
      realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/init.sql`]: `${FOLDER}/init.sql`, [`${FOLDER}/db`]: `${FOLDER}/db`, [`${FOLDER}/db/Dockerfile`]: null },
    });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`service db: Dockerfile Dockerfile (the path does not exist in the repository)`);
  });
});

/** The single-container configuration at the default path. */
function useSingle(): void {
  h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
  h.helper.composeOutput = undefined as never;
  h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
}

describe('review round 4 of unit 6 (D4-1, D4-2, D4-3, P4-2, P4-3)', () => {
  const DB_LABELS = { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db', 'com.docker.compose.config-hash': 'x' };
  const COMPOSE_PATH = '.devcontainer/compose/devcontainer.json';

  function addDb(state: ContainerState = 'running', labels: Record<string, string> = {}): ContainerInfo {
    return h.docker.addContainer({ environmentId: ENV_ID, name: `${PROJECT}-db-1`, state, image: DB_IMAGE, labels: { ...DB_LABELS, ...labels } });
  }

  it('never removes a container of Docker Compose that existed before a failed switch, for example of a cancelled one (D4-1)', async () => {
    // A switch to Docker Compose that was cancelled after `up` created the containers: the record stays single.
    await seedEnvironment(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    const cancel = new AbortController();
    h.helper.upError = (image) => (image === IMAGE_2 ? abortError() : undefined);
    let db: ContainerInfo | undefined;
    h.helper.beforeUpError = () => {
      db = addDb();
      h.docker.addContainer({
        environmentId: ENV_ID,
        name: NAME,
        state: 'running',
        image: IMAGE_2,
        labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app', 'com.docker.compose.config-hash': 'y' },
      });
      cancel.abort();
    };
    await h.service.openEnvironment(ENV_ID, { progress: h.progress, signal: cancel.signal }).catch(() => undefined);
    h.helper.upError = () => undefined;
    h.helper.beforeUpError = undefined;
    // "Later": the user works with the containers of Docker Compose.
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openEnvironment(ENV_ID, options());
    // A later "Rebuild now" whose `up` fails: the db container stays.
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image !== IMAGE_1 && image !== IMAGE_2 ? new Error('port 5432 in use') : undefined);
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(h.docker.log).not.toContain(`rm ${db?.id}`);
    expect(dbContainer()?.id).toBe(db?.id);
    expect(error.detail).not.toContain('were removed again');
  });

  it('removes only the containers that the failed up created when the switch removed the single container (D4-1)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    // A db container of an earlier switch exists already.
    const db = addDb('stopped');
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('compose up failed') : undefined);
    let cache: ContainerInfo | undefined;
    h.helper.beforeUpError = () => {
      cache = h.docker.addContainer({ environmentId: ENV_ID, name: `${PROJECT}-cache-1`, state: 'running', image: DB_IMAGE, labels: { ...DB_LABELS, [LABEL_COMPOSE_SERVICE]: 'cache', 'com.docker.compose.service': 'cache' } });
    };
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('startFailed');
    expect(h.docker.log).toContain(`rm ${cache?.id}`);
    expect(h.docker.log).not.toContain(`rm ${db.id}`);
    expect(error.detail).toContain(`The containers that Docker Compose had created were removed again: the container ${PROJECT}-cache-1 of the service cache.`);
    expect(error.detail).toContain(`The containers of Docker Compose that existed before this start were kept: the container ${PROJECT}-db-1 of the service db.`);
  });

  it('labels the dev container that up creates with the configuration path (D4-2, D5-1)', async () => {
    // Docker Compose: the dev service and the other services.
    await h.service.open(TARGET, options());
    expect(upModel().services.app.labels).toMatchObject({ [LABEL_CONFIG_PATH]: DEFAULT_CONFIG_PATH });
    // Review round 5, D5-1: changed expectation, only the dev service carries the label.
    expect(upModel().services.db.labels).not.toHaveProperty(LABEL_CONFIG_PATH);
    expect(devContainer()?.labels[LABEL_CONFIG_PATH]).toBe(DEFAULT_CONFIG_PATH);
    // Review round 5, D5-1: changed expectation, only the dev service carries the label.
    expect(dbContainer()?.labels[LABEL_CONFIG_PATH]).toBeUndefined();
    // A single container.
    const other = createHarness({ newEnvironmentId: () => ENV_ID });
    try {
      other.helper.files = { [COMPOSE_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
      other.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
      await other.service.open({ ...TARGET, configPaths: [COMPOSE_PATH] }, { progress: other.progress });
      expect(other.helper.ups[0].override.runArgs).toEqual(expect.arrayContaining(['--label', `${LABEL_CONFIG_PATH}=${COMPOSE_PATH}`]));
      expect(other.docker.containersOf(ENV_ID)[0].labels[LABEL_CONFIG_PATH]).toBe(COMPOSE_PATH);
    } finally {
      other.cleanup();
    }
  });

  function seedRestore(): void {
    h.docker.volumes.set(NAME, { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.images.add(DB_IMAGE);
  }

  it('restores the configuration path from the label of the containers, the dev container first (D4-2)', async () => {
    seedRestore();
    h.docker.addContainer({ environmentId: ENV_ID, name: NAME, state: 'stopped', image: IMAGE_1, labels: { ...COMPOSE_LABELS, 'com.docker.compose.service': 'app', [LABEL_CONFIG_PATH]: COMPOSE_PATH } });
    addDb('stopped', { [LABEL_CONFIG_PATH]: '.devcontainer/other/devcontainer.json' });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(COMPOSE_PATH);
  });

  it('keeps the default configuration path when only a container of another service carries the label (D4-2, S6-2)', async () => {
    seedRestore();
    addDb('stopped', { [LABEL_CONFIG_PATH]: COMPOSE_PATH });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    // Review round 6, S6-2: changed expectation, the label of another service (perhaps of its image) does not count.
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
  });

  it.each(['../../etc/devcontainer.json', '/workspaces/api/.devcontainer/devcontainer.json', '.devcontainer/../x/devcontainer.json', '.devcontainer/a/b/devcontainer.json', 'devcontainer.json'])(
    'keeps the default configuration path for the label %j (D4-2)',
    async (value) => {
      seedRestore();
      // Review round 6, S6-2: changed setup, the label is on the dev container, the only one whose label counts.
      h.docker.addContainer({ environmentId: ENV_ID, name: NAME, state: 'stopped', image: IMAGE_1, labels: { ...COMPOSE_LABELS, 'com.docker.compose.service': 'app', [LABEL_CONFIG_PATH]: value } });
      expect(await h.service.reconcileFromVolumes()).toBe(1);
      expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
      expect(h.logger.warnings.some((line) => line.includes('which is no configuration path'))).toBe(true);
    },
  );

  it('asks before a switch when the dev container of Docker Compose is gone and old containers of other services carry no label (D4-2, D4-3)', async () => {
    await seedCompose({ dev: null, db: 'running' });
    await h.registry.updateEnvironment(ENV_ID, (e) => {
      delete e.buildRecord;
    });
    const db = dbContainer();
    useSingle();
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(h.ui.prompts).toEqual([`configurationKindChanged ${REPO}`]);
    // Review round 5, P5-4: changed expectation, the question of its own for a missing dev container.
    expect(h.ui.kindQuestions).toEqual([Messages.configurationKindChangedDevContainerMissing(DEFAULT_CONFIG_PATH)]);
    // "Later": nothing can start without the switch, and nothing is removed.
    expect(error.code).toBe('startFailed');
    expect(error.detail).toBe(Messages.composeDevContainerMissing(DEFAULT_CONFIG_PATH));
    expect(h.docker.log.filter((line) => line.startsWith('rm'))).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    expect(dbContainer()?.id).toBe(db?.id);
    // "Rebuild now" switches.
    h.ui.configurationKindChangedAnswer = 'rebuildNow';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.log).toContain(`rm ${db?.id}`);
    expect(h.helper.builds).toHaveLength(1);
  });

  it('names the switch to Docker Compose and what Rebuild now removes (D4-3)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    await h.registry.updateEnvironment(ENV_ID, (e) => {
      delete e.buildRecord;
    });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.ui.kindQuestions).toEqual([Messages.configurationKindChanged(false, DEFAULT_CONFIG_PATH)]);
    expect(h.ui.kindQuestions[0]).toContain('Select configuration…');
    expect(h.ui.kindQuestions[0]).toContain('named volumes are kept');
    expect(h.helper.ups.map((up) => up.image)).toEqual([IMAGE_1]);
    expect(h.helper.builds).toEqual([]);
  });

  it('checks devcontainer.json before a Dockerfile of a service that does not exist (P4-2)', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    useCompose(h, {
      ...output((m) => (m.services.db = { build: { context: `${FOLDER}/db`, dockerfile: 'Dockerfile' } })),
      realPaths: { '/workspaces': '/workspaces', [`${FOLDER}/init.sql`]: `${FOLDER}/init.sql`, [`${FOLDER}/db`]: `${FOLDER}/db`, [`${FOLDER}/db/Dockerfile`]: null },
      missing: [`${FOLDER}/db/Dockerfile`],
    });
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"remoteUser"', '"privileged": true, "remoteUser"') } };
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess('privileged mode'));
    expect(h.docker.log.filter((line) => line.startsWith('start'))).toEqual([]);
  });

  it.each([false, true])(
    'removes stray containers of other services next to a single container and starts it, also when the configuration cannot be read (P4-3, rebuild %s)',
    async (forceRebuild) => {
      await seedEnvironment(h, { container: 'stopped' });
      const dev = devContainer();
      useSingle();
      h.helper.readConfigurationError = new Error('bad config');
      const db = addDb('stopped');
      const result = await h.service.openEnvironment(ENV_ID, { progress: h.progress, forceRebuild });
      expect(result.containerName).toBe(NAME);
      expect(h.docker.log).toContain(`rm ${db.id}`);
      expect(h.docker.containersOf(ENV_ID).map((c) => c.id)).toEqual([dev?.id]);
      expect(h.docker.log.filter((line) => line.startsWith('volume rm'))).toEqual([]);
    },
  );
});

describe('review round 5 of unit 6 (D5-1, D5-2, D5-3, P5-4)', () => {
  const OTHER_PATH = '.devcontainer/other/devcontainer.json';

  it('keeps the other services as they are when the selected configuration changes between two that share the compose file (D5-1)', async () => {
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT },
      [OTHER_PATH]: { configText: CONFIG_TEXT.replace('["compose.yml"]', '["../compose.yml"]') },
    };
    await h.service.open(TARGET, options());
    const first = upModel();
    await h.service.openEnvironment(ENV_ID, { progress: h.progress, configPath: OTHER_PATH });
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(OTHER_PATH);
    expect(h.helper.ups).toHaveLength(2);
    const second = upModel();
    expect(first.services.app.labels).toMatchObject({ [LABEL_CONFIG_PATH]: DEFAULT_CONFIG_PATH });
    expect(second.services.app.labels).toMatchObject({ [LABEL_CONFIG_PATH]: OTHER_PATH });
    // The labels of the db service decide its configuration hash in Docker Compose: the same, so its container stays.
    expect(second.services.db).toEqual(first.services.db);
    expect(second.services.db.labels).not.toHaveProperty([LABEL_CONFIG_PATH]);
  });

  it.each(['.devcontainer/a\\b/devcontainer.json', '.devcontainer/my config/devcontainer.json'])(
    'starts a single container of the configuration %j, with the label devenv.config-path (D5-2)',
    async (configPath) => {
      const other = createHarness({ newEnvironmentId: () => ENV_ID });
      try {
        other.helper.files = { [configPath]: { configText: DEFAULT_CONFIG_TEXT } };
        other.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW }, { [FEATURE]: FEATURE_DIGEST });
        const result = await other.service.open({ ...TARGET, configPaths: [configPath] }, { progress: other.progress });
        expect(result.containerName).toBe(NAME);
        expect(other.helper.ups[0].override.runArgs).toEqual(expect.arrayContaining(['--label', `${LABEL_CONFIG_PATH}=${configPath}`]));
        expect(other.docker.containersOf(ENV_ID)[0].labels[LABEL_CONFIG_PATH]).toBe(configPath);
      } finally {
        other.cleanup();
      }
    },
  );

  it('restores the configuration path of a folder with a backslash from the label (D5-2)', async () => {
    h.docker.volumes.set(NAME, { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.addContainer({ environmentId: ENV_ID, name: NAME, state: 'stopped', image: IMAGE_1, labels: { [LABEL_CONFIG_PATH]: '.devcontainer/a\\b/devcontainer.json' } });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(ENV_ID))?.configPath).toBe('.devcontainer/a\\b/devcontainer.json');
  });

  async function withoutRecord(): Promise<void> {
    await h.registry.updateEnvironment(ENV_ID, (e) => {
      delete e.buildRecord;
    });
  }

  it('reports a switch from Docker Compose to a single container in configurationChanged, with the question of the pipeline (D5-3)', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    await withoutRecord();
    useSingle();
    expect(await h.service.configurationChanged(ENV_ID, options())).toEqual({ question: Messages.configurationKindChanged(true, DEFAULT_CONFIG_PATH) });
    // The pipeline asks the same question.
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.ui.kindQuestions).toEqual([Messages.configurationKindChanged(true, DEFAULT_CONFIG_PATH)]);
  });

  it('reports a switch from a single container to Docker Compose in configurationChanged (D5-3)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    await withoutRecord();
    expect(await h.service.configurationChanged(ENV_ID, options())).toEqual({ question: Messages.configurationKindChanged(false, DEFAULT_CONFIG_PATH) });
  });

  it('reports a switch when the dev container of Docker Compose is gone, with the question for it (D5-3, P5-4)', async () => {
    await seedCompose({ dev: null, db: 'stopped' });
    await withoutRecord();
    useSingle();
    const question = Messages.configurationKindChangedDevContainerMissing(DEFAULT_CONFIG_PATH);
    expect(await h.service.configurationChanged(ENV_ID, options())).toEqual({ question });
    expect(question).toContain('Later starts nothing');
    expect(question).toContain('choose Rebuild');
    expect(question).toContain('Select configuration…');
    expect(question).not.toContain('Later keeps');
    // The pipeline asks the same question; Later starts nothing.
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    expect(h.ui.kindQuestions).toEqual([question]);
    expect(error.detail).toBe(Messages.composeDevContainerMissing(DEFAULT_CONFIG_PATH));
  });

  it('reports a change without a switch as true, as before (D5-3)', async () => {
    // Containers of Docker Compose and a Docker Compose configuration.
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    await withoutRecord();
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(true);
    // No containers: nothing to switch.
    for (const container of h.docker.containersOf(ENV_ID)) await h.docker.removeContainer(container.id);
    useSingle();
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(true);
  });

  it('reports a single container with a single-container configuration as changed (D5-3)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    await withoutRecord();
    useSingle();
    expect(await h.service.configurationChanged(ENV_ID, options())).toBe(true);
  });
});

describe('review round 6 of unit 6 (S6-2)', () => {
  it('restores the default configuration when only a side container carries the label and the dev container is gone (S6-2)', async () => {
    h.docker.volumes.set(NAME, { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
    h.docker.images.add(DB_IMAGE);
    const labels = { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db', [LABEL_CONFIG_PATH]: '.devcontainer/other/devcontainer.json' };
    h.docker.addContainer({ environmentId: ENV_ID, name: `${PROJECT}-db-1`, state: 'stopped', image: DB_IMAGE, labels });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    expect((await h.registry.get(ENV_ID))?.configPath).toBe(DEFAULT_CONFIG_PATH);
    expect(h.logger.warnings.some((line) => line.includes('which is no configuration path'))).toBe(false);
  });
});

describe('review round 7 of unit 6 (P7-1, P7-2, D7-1)', () => {
  it('opens a model with restart: unless-stopped (the templates), rewrites it to no, and logs it (P7-1)', async () => {
    useCompose(
      h,
      output((m) => {
        m.services.db.restart = 'unless-stopped';
        m.services.db.deploy = { restart_policy: { condition: 'any' } };
      }),
    );
    await h.service.open(TARGET, options());
    expect(upModel().services.db.restart).toBe('no');
    expect(upModel().services.db.deploy).toEqual({ restart_policy: { condition: 'none' } });
    const changed = h.logger.infos.find((line) => line.startsWith('Changed in the Docker Compose model'));
    expect(changed).toContain('service db: restart unless-stopped (Dev Environments starts the containers itself (no))');
    expect(changed).toContain('service db: deploy.restart_policy.condition any');
  });

  it('takes the container state of an environment from its dev container, and marks running side services (P7-2)', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    expect((await h.service.inspectStates())?.get(ENV_ID)).toEqual({ container: 'stopped', volume: true, servicesRunning: true });
    await h.service.stop(ENV_ID);
    expect((await h.service.inspectStates())?.get(ENV_ID)).toEqual({ container: 'stopped', volume: true });
  });

  it('reports a running dev container as running, and no dev container as missing (P7-2)', async () => {
    await seedCompose({ dev: 'running', db: 'stopped' });
    expect((await h.service.inspectStates())?.get(ENV_ID)).toEqual({ container: 'running', volume: true });
    h.docker.containers.delete(devContainer()!.id);
    dbContainer()!.state = 'running';
    expect((await h.service.inspectStates())?.get(ENV_ID)).toEqual({ container: 'missing', volume: true, servicesRunning: true });
  });

  /** The lines of the Docker log for `id`: `stop` must come before `rm`. */
  function stopBeforeRemove(id: string): void {
    const stop = h.docker.log.indexOf(`stop ${id}`);
    const rm = h.docker.log.indexOf(`rm ${id}`);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(rm).toBeGreaterThan(stop);
  }

  it('stops a running side service before Delete removes it (D7-1)', async () => {
    await seedCompose({ dev: 'running', db: 'running' });
    const db = dbContainer()!.id;
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    stopBeforeRemove(db);
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
  });

  it('removes a stopped side service at Delete without a stop (D7-1)', async () => {
    await seedCompose({ dev: 'running', db: 'stopped' });
    const db = dbContainer()!.id;
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.log).not.toContain(`stop ${db}`);
    expect(h.docker.log).toContain(`rm ${db}`);
  });

  it('removes a side service at Delete also when its stop fails (D7-1)', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    const db = dbContainer()!.id;
    const stop = h.docker.stopContainer.bind(h.docker);
    h.docker.stopContainer = async (ref: string) => {
      await stop(ref);
      if (ref === db) throw new Error('stop timed out');
    };
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.log).toContain(`rm ${db}`);
    expect(h.logger.warnings.some((line) => line.includes('stop timed out'))).toBe(true);
    expect(await h.registry.list()).toEqual([]);
  });

  it('stops a running side service before the switch to a single container removes it (D7-1)', async () => {
    await seedCompose({ dev: 'stopped', db: 'running' });
    h.docker.networks.set(`${PROJECT}_default`, COMPOSE_LABELS);
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
    const db = dbContainer()!.id;
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openEnvironment(ENV_ID, options());
    stopBeforeRemove(db);
  });

  it('stops a running stray side service before it is removed next to a single container (D7-1)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    useSingle();
    h.docker.images.add(DB_IMAGE);
    const db = h.docker.addContainer({
      environmentId: ENV_ID,
      name: `${PROJECT}-db-1`,
      state: 'running',
      image: DB_IMAGE,
      labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' },
    });
    await h.service.openEnvironment(ENV_ID, options());
    stopBeforeRemove(db.id);
  });
});

describe('review round 8 of unit 6 (P8-3, D8-1): a side service is stopped before each removal', () => {
  const DB_LABELS = { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db', 'com.docker.compose.config-hash': 'x' };

  function addDb(state: ContainerState = 'running'): ContainerInfo {
    return h.docker.addContainer({ environmentId: ENV_ID, name: `${PROJECT}-db-1`, state, image: DB_IMAGE, labels: { ...DB_LABELS } });
  }

  /** The lines of the Docker log for `id`: `stop` must come before `rm`. */
  function stopBeforeRemove(id: string): void {
    const stop = h.docker.log.indexOf(`stop ${id}`);
    const rm = h.docker.log.indexOf(`rm ${id}`);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(rm).toBeGreaterThan(stop);
  }

  it('stops the containers that a failed up of the switch to Docker Compose created before it removes them (removeFailedComposeContainers)', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    h.docker.images.add(DB_IMAGE);
    h.ui.configurationChangedAnswer = 'rebuildNow';
    h.helper.upError = (image) => (image === IMAGE_2 ? new Error('compose up failed') : undefined);
    let db: ContainerInfo | undefined;
    h.helper.beforeUpError = () => {
      db = addDb();
    };
    await rejection(h.service.openEnvironment(ENV_ID, options()));
    // Before: `docker rm -f` of the running database (a SIGKILL).
    stopBeforeRemove(db!.id);
  });

  it('stops the running side services of a failed first open before it removes them (removeFailedFirstOpen)', async () => {
    h.helper.upError = () => new Error('compose up failed');
    let db: ContainerInfo | undefined;
    h.helper.beforeUpError = () => {
      db = addDb();
    };
    await rejection(h.service.open(TARGET, options()));
    stopBeforeRemove(db!.id);
    expect(h.docker.containersOf(ENV_ID)).toEqual([]);
  });

  it('stops a running side service of the project without the ID label before Delete removes it (removeComposeProject)', async () => {
    await seedCompose({ dev: 'stopped', db: null });
    const db = addDb();
    // For example a container of an earlier model: only the labels of the project.
    delete h.docker.containers.get(db.id)!.labels[LABEL_ENVIRONMENT_ID];
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    stopBeforeRemove(db.id);
    expect(h.docker.containers.has(db.id)).toBe(false);
  });
});

describe('review round 8 of unit 6 (P8-2): a bind mount of a repository folder that does not exist yet', () => {
  const SOURCE = `${FOLDER}/data/postgres`;

  function withDataFolder(ancestor: string | null): void {
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: SOURCE, target: '/var/lib/postgresql/data', bind: { create_host_path: true } }];
    });
    out.realPaths = { ...out.realPaths, [SOURCE]: null };
    out.mountAncestors = { [SOURCE]: ancestor };
    useCompose(h, out);
  }

  it('creates the folder in the workspace volume before up, and mounts it as a folder of the volume', async () => {
    withDataFolder(FOLDER);
    // Before: refused (the path does not exist in the repository).
    await h.service.open(TARGET, options());
    expect(h.helper.createdFolders).toEqual([[SOURCE]]);
    const calls = h.helper.calls;
    expect(calls.indexOf(`createRepositoryFolders ${SOURCE}`)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(`createRepositoryFolders ${SOURCE}`)).toBeLessThan(calls.findIndex((call) => call.startsWith('up')));
    expect(upModel().services.db.volumes).toEqual([
      { type: 'volume', source: WORKSPACE_VOLUME_KEY, target: '/var/lib/postgresql/data', volume: { nocopy: true, subpath: 'api/data/postgres' } },
    ]);
    const changed = h.logger.infos.find((line) => line.startsWith('Changed in the Docker Compose model'));
    expect(changed).toContain(`service db: bind mount ${SOURCE} → /var/lib/postgresql/data (the folder api/data/postgres of the workspace volume, created in the repository before the start`);
  });

  it('refuses it when the nearest folder is a link out of the repository, before anything is built or created', async () => {
    withDataFolder('/workspaces/.devenv+');
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.hostAccess(`service db: bind mount ${SOURCE} → /var/lib/postgresql/data (a link to /workspaces/.devenv+, outside of the repository)`));
    expect(h.helper.createdFolders).toEqual([]);
    expect(h.helper.builds).toEqual([]);
  });

  it('does not start when the folder cannot be created', async () => {
    withDataFolder(FOLDER);
    h.helper.createFoldersError = new Error('data leads out of the repository');
    await expect(h.service.open(TARGET, options())).rejects.toThrow();
    expect(h.helper.ups).toEqual([]);
  });
});

describe('review round 9 of unit 6 (D9-1): the ownership fixes leave out the paths of the repository that other services mount', () => {
  const SOURCE = `${FOLDER}/data/postgres`;
  const INIT_SQL = `${FOLDER}/init.sql`;

  function withDataFolder(): void {
    const out = output((m) => {
      m.services.db.volumes = [
        { type: 'bind', source: SOURCE, target: '/var/lib/postgresql/data', bind: { create_host_path: true } },
        { type: 'bind', source: INIT_SQL, target: '/docker-entrypoint-initdb.d/init.sql', read_only: true, bind: {} },
      ];
    });
    out.realPaths = { ...out.realPaths, [SOURCE]: null };
    out.mountAncestors = { [SOURCE]: FOLDER };
    useCompose(h, out);
  }

  /** The arguments after `sh -c <script> sh` of the ownership fix of the repository folder with `docker exec`. */
  function fixArguments(): string[][] {
    return h.docker.execs
      .filter((e) => e.user === 'root' && e.command[0] === 'sh' && e.command[2].includes('chown') && e.command[4] === FOLDER)
      .map((e) => e.command.slice(4));
  }

  it('leaves the data folder of db out of the fix after up, and records the paths in the build record', async () => {
    withDataFolder();
    await h.service.open(TARGET, options());
    // Before: `[FOLDER, 'vscode']`: the fix after `up` (db has run) gave the data of Postgres to vscode.
    // Review round 10, D10-3: without the read-only INIT_SQL (before: [FOLDER, 'vscode', SOURCE, INIT_SQL]).
    // Review round 11, G5: the ready arguments of find (before: [FOLDER, 'vscode', SOURCE]).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [SOURCE])]]);
    // The fix before `up` of the new clone: no service has run on the files yet, so every file gets its owner.
    const before = h.docker.runs.filter((run) => run.all.includes('--entrypoint'));
    expect(before).toHaveLength(1);
    expect(before[0].args.slice(-2)).toEqual([FOLDER, 'vscode']);
    // Review round 10, D10-1 and D10-3: in the entry, not in the build record, and without the read-only INIT_SQL
    // (before: buildRecord.compose.serviceFolders [SOURCE, INIT_SQL]).
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([SOURCE]);
    expect((await h.registry.get(ENV_ID))?.buildRecord?.compose?.serviceFolders).toBeUndefined();
  });

  it('leaves them out when a rebuild creates the containers again, and Switch branch… gets them from the build record', async () => {
    withDataFolder();
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    await h.service.openEnvironment(ENV_ID, { ...options(), forceRebuild: true });
    // Review round 10, D10-3: without the read-only INIT_SQL (before: [FOLDER, 'vscode', SOURCE, INIT_SQL] and
    // [[SOURCE, INIT_SQL]]). Review round 11, G5: the ready arguments of find (before: [FOLDER, 'vscode', SOURCE]).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [SOURCE])]]);
    await h.service.switchBranch(ENV_ID, 'feature-x', options());
    expect(h.helper.switchServiceFolders).toEqual([[SOURCE]]);
  });

  it('records the paths at an up without a build, and leaves out nothing for a build record written before them', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    // A record without serviceFolders (written by an earlier version): Switch branch… leaves out nothing, as before.
    await h.service.switchBranch(ENV_ID, 'feature-x', options());
    expect(h.helper.switchServiceFolders).toEqual([[]]);
    // The next start with up records the paths of the model. Review round 10, D10-3: with a data folder of db that
    // exists (the read-only init.sql of the default model is no longer recorded); D10-1: in the entry (before:
    // buildRecord.compose.serviceFolders [INIT_SQL]).
    const out = output((m) => {
      m.services.db.volumes = [...(m.services.db.volumes as unknown[]), { type: 'bind', source: SOURCE, target: '/var/lib/postgresql/data', bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [SOURCE]: SOURCE };
    useCompose(h, out);
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openEnvironment(ENV_ID, options());
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([SOURCE]);
    await h.service.switchBranch(ENV_ID, 'main', options());
    expect(h.helper.switchServiceFolders.at(-1)).toEqual([SOURCE]);
  });
});

describe('review round 10 of unit 6 (D10-1): the recorded paths of the services never shrink while a container may mount them', () => {
  const OLD = `${FOLDER}/data/pg`;
  const NEW = `${FOLDER}/pgdata`;

  /** The default model with db's data in NEW (a folder that exists). */
  function withNewFolder(): void {
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: NEW, target: '/var/lib/postgresql/data', bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [NEW]: NEW };
    useCompose(h, out);
  }

  it('keeps the folder of the old model at an up --no-recreate (Rebuild later), for Switch branch… and Delete', async () => {
    // A build record of review round 9 names OLD; the db container was created with it and is not created again.
    await seedCompose({ dev: 'stopped', db: 'stopped', record: { compose: { service: 'app', images: [`${PROJECT}-app`], serviceFolders: [OLD] } } as Partial<BuildRecord> });
    withNewFolder();
    h.ui.configurationChangedAnswer = 'later';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.ups.map((up) => up.removeExistingContainer)).toEqual([false]);
    const entry = await h.registry.get(ENV_ID);
    // Before: [NEW] (in the build record), and the next Switch branch… gave the live data in OLD to the dev user.
    // Review round 11, G3: the paths of the model first, then the recorded ones (before: [OLD, NEW]).
    expect(entry?.serviceFolders).toEqual([NEW, OLD]);
    expect(entry?.buildRecord?.compose?.serviceFolders).toBeUndefined();
    await h.service.switchBranch(ENV_ID, 'feature-x', options());
    // Review round 11, G3: in the order of the record (before: [OLD, NEW]).
    expect(h.helper.switchServiceFolders.at(-1)).toEqual([NEW, OLD]);
    // The question of Delete names both. Review round 11, G3: in the order of the record (before: ['./data/pg', './pgdata']).
    expect(repositoryServiceDataFolders(entry!)).toEqual(['./pgdata', './data/pg']);
    // Another start with the same model changes nothing.
    h.docker.containersOf(ENV_ID).forEach((container) => (container.state = 'stopped'));
    await h.service.openEnvironment(ENV_ID, options());
    // Review round 11, G3: in the order of the record (before: [OLD, NEW]).
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([NEW, OLD]);
  });

  it('records the folders before a first up that fails, so that Switch branch… leaves them out', async () => {
    // An entry without a build record (restored after a lost registry, or a first open that was cut off).
    await seedEnvironment(h, { container: null, record: null });
    h.docker.images.add(DB_IMAGE);
    withNewFolder();
    h.helper.upError = () => new Error('Error response from daemon: driver failed programming external connectivity');
    // Compose created the db container (with NEW) before the failure.
    h.helper.beforeUpError = () => {
      h.docker.addContainer({ environmentId: ENV_ID, name: `${PROJECT}-db-1`, state: 'running', image: DB_IMAGE, labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' } });
    };
    await expect(h.service.openEnvironment(ENV_ID, options())).rejects.toBeInstanceOf(UserFacingError);
    expect((await h.registry.get(ENV_ID))?.buildRecord).toBeUndefined();
    // Before: nothing was recorded without a build record, and Switch branch… gave the data of db to the dev user.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([NEW]);
    await h.service.switchBranch(ENV_ID, 'feature-x', options());
    expect(h.helper.switchServiceFolders.at(-1)).toEqual([NEW]);
  });

  it('replaces the list when no container of another service exists before up (review round 11, G3: and the old folder is gone)', async () => {
    await seedCompose({ dev: 'stopped', db: null, record: { compose: { service: 'app', images: [`${PROJECT}-app`], serviceFolders: [OLD] } } as Partial<BuildRecord> });
    withNewFolder();
    // Review round 11, G3: OLD is kept only while it exists in the volume (before: dropped because no container of
    // another service existed, although its data may still be there); here it no longer exists.
    h.docker.missingPaths.add(OLD);
    await h.service.openEnvironment(ENV_ID, { ...options(), forceRebuild: true });
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([NEW]);
    h.docker.missingPaths.clear();
    // With the db container of NEW, a model with OLD adds OLD.
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: OLD, target: '/var/lib/postgresql/data', bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [OLD]: OLD };
    useCompose(h, out);
    h.docker.containersOf(ENV_ID).forEach((container) => (container.state = 'stopped'));
    await h.service.openEnvironment(ENV_ID, { ...options(), forceRebuild: true });
    // Review round 11, G3: the paths of the model first, then those that the db container mounts (before: [NEW, OLD]).
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([OLD, NEW]);
  });
});

describe('review round 9 of unit 6 (D9-3): a dev container is stopped before it is removed', () => {
  function stopBeforeRemove(id: string): void {
    const stop = h.docker.log.indexOf(`stop ${id}`);
    const rm = h.docker.log.indexOf(`rm ${id}`);
    // Before: only `rm -f` (a SIGKILL of the processes of the running container).
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(rm).toBeGreaterThan(stop);
  }

  it('stops the running dev container of Docker Compose before Delete removes it', async () => {
    await seedCompose({ dev: 'running', db: 'running' });
    const dev = devContainer()!;
    const db = dbContainer()!;
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    stopBeforeRemove(dev.id);
    stopBeforeRemove(db.id);
  });

  it('stops a running single container before Delete removes it', async () => {
    await seedEnvironment(h, { container: 'running' });
    const dev = h.docker.containersOf(ENV_ID)[0];
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    stopBeforeRemove(dev.id);
  });

  it('stops the running single container before the switch to Docker Compose replaces it', async () => {
    await seedEnvironment(h, { container: 'running' });
    const single = h.docker.containersOf(ENV_ID)[0];
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.containers.has(single.id)).toBe(false);
    stopBeforeRemove(single.id);
  });

  it('removes a stopped dev container without a stop', async () => {
    await seedEnvironment(h, { container: 'stopped' });
    const dev = h.docker.containersOf(ENV_ID)[0];
    await h.service.delete(ENV_ID, { ...options(), additionalVolumesToRemove: [] });
    expect(h.docker.log).not.toContain(`stop ${dev.id}`);
    expect(h.docker.log).toContain(`rm ${dev.id}`);
  });
});

describe('review round 9 of unit 6 (S9-1, S9-3): the bounds of the extension host for a Docker Compose model', () => {
  it('refuses a model with more services than MAX_COMPOSE_SERVICES before it analyses or rewrites it (S9-1)', async () => {
    useCompose(
      h,
      output((m) => {
        for (let i = 0; i < 501; i++) m.services[`s${i}`] = { image: 'alpine:3.22' };
      }),
    );
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.configurationTooComplex(ANALYSIS_FAILED_ITEM));
    expect(h.helper.builds).toEqual([]);
    expect(h.logger.warnings.some((line) => line.includes('503 services (at most 500)'))).toBe(true);
  });

  it('refuses a model with too many top-level volumes, or too much Dockerfile text over its services, before it hashes it (review round 10, S10-1, S10-2)', async () => {
    const text = `FROM alpine\nRUN echo ${'a'.repeat(1024 * 1024)}`;
    const big = output((m) => {
      for (let i = 0; i < 40; i++) m.services[`s${i}`] = { build: { context: FOLDER, dockerfile: 'Dockerfile' } };
    });
    big.dockerfiles = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, text]));
    useCompose(h, big);
    const error = await rejection(h.service.open(TARGET, options()));
    // Before: 40 MiB of JSON text for each hash in the extension host, then the job size check of the worker.
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(Messages.configurationTooComplex(ANALYSIS_FAILED_ITEM));
    expect(h.logger.warnings.some((line) => line.includes(`more than ${32 * 1024 * 1024} characters of Dockerfiles of the services`))).toBe(true);
    useCompose(
      h,
      output((m) => {
        m.volumes = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`v${i}`, { name: `x_v${i}` }]));
      }),
    );
    expect((await rejection(h.service.open(TARGET, options()))).code).toBe('hostAccess');
    expect(h.logger.warnings.some((line) => line.includes('5001 top-level volumes (at most 5000)'))).toBe(true);
    expect(h.helper.builds).toEqual([]);
  });

  it('asks Docker about the image IDs of all services with one call, and not at all for a refused model (S9-3)', async () => {
    useCompose(
      h,
      output((m) => {
        for (let i = 0; i < 50; i++) m.services[`s${i}`] = { image: `example.com/s${i}:1` };
      }),
    );
    await h.service.open(TARGET, options());
    // Before: one `docker image inspect` per reference (104). Now one for each check of the model: before the build, and
    // before the `up` that creates the containers.
    expect(h.docker.imageInspections).toHaveLength(2);
    for (const references of h.docker.imageInspections) {
      expect(references).toHaveLength(52);
      expect(references).toEqual(expect.arrayContaining([DB_IMAGE, BASE_IMAGE, 'example.com/s0:1', 'example.com/s49:1']));
    }
    h.docker.imageInspections.length = 0;
    useCompose(
      h,
      output((m) => {
        m.services.db.privileged = true;
      }),
    );
    await expect(h.service.openEnvironment(ENV_ID, { ...options(), forceRebuild: true })).rejects.toMatchObject({ code: 'hostAccess' });
    expect(h.docker.imageInspections).toEqual([]);
  });

  it('still refuses a service image that Docker resolves by its image ID', async () => {
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: 'a1b2c3' };
      }),
    );
    h.docker.images.add('a1b2c3');
    h.docker.imageRepoNames.set('a1b2c3', { repoTags: ['devenv-7c1d2e3f-db:latest'], repoDigests: [] });
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.message).toContain('image a1b2c3 (an image ID; name the image)');
  });

  it('refuses the image ID of a service also when another reference cannot be inspected, and that reference too (review round 10, P10-1)', async () => {
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: '3f2a1b9c' };
        // Review round 11, G2: foo/Bar is now refused before any inspect (not a valid image reference); a reference
        // that Docker's grammar allows but Docker cannot inspect (an image ID prefix of several images) takes its place.
        m.services.unused = { image: 'a1b2' };
      }),
    );
    h.docker.images.add('3f2a1b9c');
    h.docker.imageRepoNames.set('3f2a1b9c', { repoTags: ['devenv-7c1d2e3f-db:latest'], repoDigests: [] });
    h.docker.uninspectableImages.add('a1b2');
    const error = await rejection(h.service.open(TARGET, options()));
    // Before: the batch failed for foo/Bar ("invalid reference format"), and no reference of it was checked.
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service cache: image 3f2a1b9c (an image ID; name the image)');
    // Review round 11, G2: a1b2 in place of foo/Bar.
    expect(error.message).toContain('service unused: image a1b2 (the image reference could not be checked)');
    expect(h.helper.builds).toEqual([]);
  });
});

describe('review round 11 of unit 6 (G1, G2): the image check of Docker tells a refusal from a failure to check', () => {
  // Review round 12, P12-1: a text of its own for a check that Docker could not answer (before: the internal error, which
  // said "reinstall Dev Environments").
  const INTERNAL = Messages.configurationCheckDocker(dockerCheckItem(`${BASE_IMAGE}, ${DB_IMAGE}`));

  /** Makes the `n`th inspectImageNames (counted from 1) fail as `failure`; the others answer. */
  function failInspection(n: number, failure: (references: readonly string[]) => void): void {
    const original = h.docker.inspectImageNames.bind(h.docker);
    let calls = 0;
    h.docker.inspectImageNames = async (references: readonly string[]) => {
      calls++;
      if (calls === n) failure(references);
      try {
        return await original(references);
      } finally {
        h.docker.transientImages = new Set();
        h.docker.uninspectableImages.clear();
      }
    };
  }

  it('does not remember an update whose check before `up` timed out (G1)', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST } } });
    // The inspect at the load answers; the one before the `up` of the new image (composeReport) times out.
    failInspection(2, () => (h.docker.transientImages = 'all'));
    await h.service.openEnvironment(ENV_ID, options());
    // Before: remembered as a refused update ("needs access to your computer"), and never built again.
    expect((await h.registry.get(ENV_ID))?.refusedUpdate).toBeUndefined();
    // Review round 12, P12-1: dockerCheckItem in place of analysisInternalItem.
    expect(h.ui.warnings).toEqual([Messages.updateCheckFailed(dockerCheckItem(`${BASE_IMAGE}, ${DB_IMAGE}`))]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(devContainer()?.state).toBe('running');
    // The next open, with Docker healthy again, builds the update again.
    h.helper.builds.length = 0;
    devContainer()!.state = 'stopped';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.helper.builds).toHaveLength(1);
    expect((await h.registry.get(ENV_ID))?.refusedUpdate).toBeUndefined();
  });

  it('starts the existing environment when the daemon fails at the load (G1)', async () => {
    await seedCompose();
    h.docker.transientImages = 'all';
    await h.service.openEnvironment(ENV_ID, options());
    // Before: refused with "Change the configuration of the repository", and nothing started.
    expect(h.ui.warnings).toEqual([INTERNAL]);
    expect(devContainer()?.state).toBe('running');
    expect(dbContainer()?.state).toBe('running');
    expect(h.helper.builds).toEqual([]);
  });

  it('does not use a new configuration whose images Docker could not inspect (G1)', async () => {
    h.docker.transientImages = 'all';
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toBe(INTERNAL);
    // Review round 12, P12-1: the text of a check that Docker could not answer, without "reinstall".
    expect(error.message).toBe(`Docker could not check the image references (${BASE_IMAGE}, ${DB_IMAGE}). Check that Docker is running and try again.`);
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
  });

  it('still refuses, and remembers, an update with a reference that Docker calls invalid (G1)', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST } } });
    // For example an image ID prefix that matches several images.
    failInspection(2, () => h.docker.uninspectableImages.add(DB_IMAGE));
    await h.service.openEnvironment(ENV_ID, options());
    const entry = await h.registry.get(ENV_ID);
    expect(entry?.refusedUpdate).toMatchObject({ configHash: HASH, items: `service db: image ${DB_IMAGE} (the image reference could not be checked)` });
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
  });

  it('refuses a reference that is not valid in Docker\'s grammar before any inspect (G2)', async () => {
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: 'foo/Bar' };
        m.services.web = { image: 'redis:-1' };
      }),
    );
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service cache: image foo/Bar (not a valid image reference)');
    expect(error.message).toContain('service web: image redis:-1 (not a valid image reference)');
    // Before: inspected with the other references, then one by one.
    expect(h.docker.imageInspections.flat()).not.toContain('foo/Bar');
    // Review round 13, P13-1: the configuration is refused for them anyway, so the other references are not inspected
    // either (before: [[BASE_IMAGE, DB_IMAGE]]).
    expect(h.docker.imageInspections).toEqual([]);
    expect(h.helper.builds).toEqual([]);
  });

  it('refuses a reference that is not valid in Docker\'s grammar also when Docker cannot answer for the others (review round 13, P13-1)', async () => {
    await seedCompose();
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: 'foo/Bar' };
      }),
    );
    h.docker.transientImages = 'all';
    const error = await rejection(h.service.openEnvironment(ENV_ID, options()));
    // Before: AnalysisFailedError of Docker (the invalid reference dropped), and the existing environment started.
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service cache: image foo/Bar (not a valid image reference)');
    expect(error.message).not.toContain('Docker could not check');
    expect(h.ui.warnings).toEqual([]);
    expect(devContainer()?.state).toBe('stopped');
    expect(dbContainer()?.state).toBe('stopped');
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
    // The configuration is refused anyway: no inspect.
    expect(h.docker.imageInspections).toEqual([]);
  });

  it('refuses, and remembers, an update with a reference that Docker calls invalid also when another one is transient (review round 13, P13-1)', async () => {
    await seedCompose({ record: { images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST } } });
    // The load answers; the check before the `up` of the new image gets `invalid` for the base image (for example an
    // image ID prefix of several images) and then `transient` for db (the daemon stopped answering).
    failInspection(2, () => {
      h.docker.uninspectableImages.add(BASE_IMAGE);
      h.docker.transientImages = new Set([DB_IMAGE]);
    });
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.imageInspections.at(-1)).toEqual([BASE_IMAGE, DB_IMAGE]);
    const items = `service app: image ${BASE_IMAGE} (the image reference could not be checked)`;
    // Before: AnalysisFailedError of Docker for db, and the refusal for the base image was neither shown nor remembered.
    expect((await h.registry.get(ENV_ID))?.refusedUpdate).toMatchObject({ configHash: HASH, items });
    expect(h.ui.warnings).toEqual([Messages.updateRefused(items)]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(devContainer()?.state).toBe('running');
  });

  it('does not refuse a transient reference as an image ID from the images of the others (review round 14, P14-2)', async () => {
    // A service with the image `cafe` (a local cafe:latest); db's image has an ID that starts with cafe.
    const cafeModel = model();
    cafeModel.services.cache = { image: 'cafe' };
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: 'cafe' };
      }),
    );
    await seedCompose({ record: { configHash: composeConfigHash(CONFIG_TEXT, cafeModel, {}), images: { [BASE_IMAGE]: DIGEST_OLD, [DB_IMAGE]: DB_DIGEST } } });
    h.docker.images.add('cafe');
    h.docker.imageIds.set(DB_IMAGE, `sha256:cafe${'0'.repeat(60)}`);
    // The load answers (cafe is the image cafe:latest); before the `up` of the new image, the first batch finds db's image and `cafe` is transient.
    failInspection(2, () => (h.docker.transientImages = new Set(['cafe'])));
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.imageInspections.at(-1)).toEqual([BASE_IMAGE, DB_IMAGE, 'cafe']);
    // Before: refused as "an image ID; name the image" (cafe was never inspected), and remembered as a refused update.
    expect((await h.registry.get(ENV_ID))?.refusedUpdate).toBeUndefined();
    expect(h.ui.warnings).toEqual([Messages.updateCheckFailed(dockerCheckItem('cafe'))]);
    expect(h.docker.images.has(IMAGE_2)).toBe(false);
    expect(devContainer()?.state).toBe('running');
  });

  it('logs a transient reference and refuses the others for their definitive items (review round 14, P14-2)', async () => {
    // `cafe` is transient, 3f2a1b9c (an image ID) is answered: refused for 3f2a1b9c only.
    useCompose(
      h,
      output((m) => {
        m.services.cache = { image: '3f2a1b9c' };
        m.services.web = { image: 'cafe' };
      }),
    );
    h.docker.images.add('3f2a1b9c');
    h.docker.imageRepoNames.set('3f2a1b9c', { repoTags: ['devenv-7c1d2e3f-db:latest'], repoDigests: [] });
    h.docker.images.add('cafe');
    h.docker.images.add(DB_IMAGE);
    h.docker.imageIds.set(DB_IMAGE, `sha256:cafe${'0'.repeat(60)}`);
    h.docker.transientImages = new Set(['cafe']);
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service cache: image 3f2a1b9c (an image ID; name the image)');
    // Before: also "service web: image cafe (an image ID; name the image)".
    expect(error.message).not.toContain('image cafe');
    expect(h.logger.warnings).toContain('Docker could not check the image references cafe; the configuration is refused for the others.');
  });

  it('passes the cancellation to the inspect (G2)', async () => {
    const controller = new AbortController();
    h.docker.inspectImageNames = async (_references: readonly string[], signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw abortError();
    };
    const error = await rejection(h.service.open(TARGET, { ...options(), signal: controller.signal }));
    expect(error.code).toBe('cancelled');
  });
});

describe('review round 11 of unit 6 (G3, G4, G5): the paths of the services from facts', () => {
  const PGDATA = `${FOLDER}/pgdata`;
  const DATA = `${FOLDER}/data/pg`;

  /** The default model with db's data in `folder` (a folder that exists). */
  function withModelFolder(folder: string): void {
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: folder, target: '/var/lib/postgresql/data', bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [folder]: folder };
    useCompose(h, out);
  }

  /** The arguments after `sh -c <script> sh` of the ownership fixes of the repository folder with `docker exec`. */
  function fixArguments(): string[][] {
    return h.docker.execs
      .filter((e) => e.user === 'root' && e.command[0] === 'sh' && e.command[2].includes('chown') && e.command[4] === FOLDER)
      .map((e) => e.command.slice(4));
  }

  async function record(folders: string[]): Promise<void> {
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      entry.serviceFolders = folders;
    });
  }

  function stopAll(): void {
    h.docker.containersOf(ENV_ID).forEach((container) => (container.state = 'stopped'));
  }

  it('keeps a folder of an earlier model while it exists, after the containers of the services were removed (G3)', async () => {
    // The db container of the earlier model (./pgdata) was removed while it was stopped (`docker container prune`).
    await seedCompose({ dev: 'stopped', db: null });
    await record([PGDATA]);
    withModelFolder(DATA);
    await h.service.openEnvironment(ENV_ID, { ...options(), forceRebuild: true });
    // Before: [DATA]: no container of another service existed before `up`, so the list was replaced, the fix after `up`
    // gave the data of Postgres in ./pgdata to vscode, and Delete no longer named it.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([DATA, PGDATA]);
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [DATA, PGDATA])]]);
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual(['./data/pg', './pgdata']);
    // Once ./pgdata is gone from the volume, the next `up` drops it.
    h.docker.missingPaths.add(PGDATA);
    stopAll();
    await h.service.openEnvironment(ENV_ID, options());
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([DATA]);
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual(['./data/pg']);
    // The check ran as root in the dev container, with the recorded paths that nothing else names.
    const checks = h.docker.execs.filter((e) => e.command[2] === EXISTING_PATHS_SCRIPT);
    expect(checks.map((e) => [e.user, e.command.slice(4)])).toEqual([
      ['root', [PGDATA]],
      ['root', [PGDATA]],
    ]);
  });

  it('keeps the recorded folders when the configuration became a single container, while they exist (G3)', async () => {
    await seedCompose({ dev: 'stopped', db: 'stopped' });
    await record([PGDATA]);
    h.docker.networks.set(`${PROJECT}_default`, COMPOSE_LABELS);
    h.docker.images.add(`${PROJECT}-app`);
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
    h.ui.configurationChangedAnswer = 'rebuildNow';
    await h.service.openEnvironment(ENV_ID, options());
    expect(h.docker.containersOf(ENV_ID)).toHaveLength(1);
    // Before: cleared (no container of another service is left), although the data of Postgres is still in ./pgdata.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([PGDATA]);
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual(['./pgdata']);
    h.docker.missingPaths.add(PGDATA);
    stopAll();
    await h.service.openEnvironment(ENV_ID, options());
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toBeUndefined();
  });

  it('keeps the recorded list when the containers cannot be read after up (never shrinks on an error)', async () => {
    await seedCompose({ dev: 'stopped', db: null });
    await record([PGDATA]);
    h.docker.missingPaths.add(PGDATA);
    withModelFolder(DATA);
    const up = h.helper.up.bind(h.helper);
    const list = h.docker.listProjectContainers.bind(h.docker);
    let broken = false;
    h.helper.up = async (p) => {
      const result = await up(p);
      broken = true;
      return result;
    };
    h.docker.listProjectContainers = async (project: string) => {
      if (broken) throw new CommandError('docker ps', 1, '', 'Cannot connect to the Docker daemon');
      return list(project);
    };
    await h.service.openEnvironment(ENV_ID, { ...options(), forceRebuild: true });
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([DATA, PGDATA]);
    expect(h.docker.execs.filter((e) => e.command[2] === EXISTING_PATHS_SCRIPT)).toEqual([]);
    // Switch branch… and Delete too.
    await h.service.switchBranch(ENV_ID, 'feature-x', options());
    expect(h.helper.switchServiceFolders.at(-1)).toEqual([DATA, PGDATA]);
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual(['./data/pg', './pgdata']);
  });

  it('Switch branch… of a restored entry leaves alone the folder that the running db mounts (G4)', async () => {
    // An entry without a record (restored from its volumes), and a db container that mounts ./data/pg, as Docker
    // inspects it (HostConfig.Mounts with VolumeOptions.Subpath).
    await seedEnvironment(h, {
      container: 'running',
      record: null,
      containerLabels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), ...COMPOSE_LABELS, 'com.docker.compose.service': 'app' },
    });
    h.docker.addContainer({
      environmentId: ENV_ID,
      name: `${PROJECT}-db-1`,
      state: 'running',
      image: DB_IMAGE,
      labels: { [LABEL_COMPOSE_SERVICE]: 'db', ...COMPOSE_LABELS, 'com.docker.compose.service': 'db' },
      volumeSubpaths: [
        { volume: NAME, subpath: 'api/data/pg', readOnly: false },
        // Not a path of the services: read-only, another volume, outside of the repository, .git.
        { volume: NAME, subpath: 'api/init.sql', readOnly: true },
        { volume: 'other-volume', subpath: 'api/x', readOnly: false },
        { volume: NAME, subpath: 'other/x', readOnly: false },
        { volume: NAME, subpath: 'api/.git', readOnly: false },
      ],
    });
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toBeUndefined();
    await h.service.switchBranch(ENV_ID, 'feature-x', options());
    // Before: [] (the documented limit): the restore of the owner gave the live data of Postgres to the dev user.
    expect(h.helper.switchServiceFolders.at(-1)).toEqual([DATA]);
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual(['./data/pg']);
  });

  it('fills the paths of a restored entry from the mounts of the containers that it finds (G4)', async () => {
    h.docker.volumes.set(NAME, { [LABEL_ENVIRONMENT_ID]: ENV_ID, [LABEL_REPOSITORY]: REPO, [LABEL_OWNER_ID]: ACCOUNT.id });
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
      volumeSubpaths: [{ volume: NAME, subpath: 'api/data/pg', readOnly: false }],
    });
    expect(await h.service.reconcileFromVolumes()).toBe(1);
    // Before: no list: Switch branch… and the ownership fixes left nothing out until the next `up`.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([DATA]);
  });

  it(`records at most ${MAX_SERVICE_FOLDERS} paths, and changes only the files of root beyond them (G5)`, async () => {
    // For example ./data/${HOSTNAME}: a new path at each open, and the folders of the earlier runs still exist.
    await seedCompose({ dev: 'stopped', db: null });
    const earlier = Array.from({ length: MAX_SERVICE_FOLDERS }, (_, i) => `${FOLDER}/data/host-${i}`);
    await record(earlier);
    withModelFolder(DATA);
    await h.service.openEnvironment(ENV_ID, { ...options(), forceRebuild: true });
    const entry = await h.registry.get(ENV_ID);
    // Before: 1001 paths, and one more at each open, without a bound.
    expect(entry?.serviceFolders).toHaveLength(MAX_SERVICE_FOLDERS);
    expect(entry?.serviceFolders?.[0]).toBe(DATA);
    expect(entry?.serviceFoldersOverflow).toBe(true);
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', '-path', FOLDER, '-o', '-path', `${FOLDER}/*`]]);
    expect(h.logger.warnings.some((line) => line.includes(`More than ${MAX_SERVICE_FOLDERS} paths of ${REPO}`))).toBe(true);
    await h.service.switchBranch(ENV_ID, 'feature-x', options());
    expect(h.helper.switchServiceFolders.at(-1)).toBe('repository');
    // The existence check of the recorded paths goes in calls of a bounded command line.
    const checks = h.docker.execs.filter((e) => e.command[2] === EXISTING_PATHS_SCRIPT);
    expect(checks.length).toBeGreaterThan(1);
    // The record before `up` held DATA and the first 999 earlier paths.
    expect(checks.flatMap((e) => e.command.slice(4))).toHaveLength(MAX_SERVICE_FOLDERS - 1);
  });
});

describe('review round 12 of unit 6 (D12-2): the ownership fix in the dev container leaves its other mounts below the repository alone', () => {
  const PGDATA = `${FOLDER}/.pgdata`;

  /** The arguments after `sh -c <script> sh` of the ownership fixes of the repository folder with `docker exec`. */
  function fixArguments(): string[][] {
    return h.docker.execs
      .filter((e) => e.user === 'root' && e.command[0] === 'sh' && e.command[2].includes('chown') && e.command[4] === FOLDER)
      .map((e) => e.command.slice(4));
  }

  it('protects the target of a volume that the dev service shares with db, without recording it', async () => {
    // pgdata:/workspaces/api/.pgdata in the dev service, pgdata:/var/lib/postgresql/data in db: one local volume, on the
    // file system of the workspace volume, so `find -xdev` goes into it.
    useCompose(
      h,
      output((m) => {
        m.services.app.volumes = [...(m.services.app.volumes as unknown[]), { type: 'volume', source: 'pgdata', target: `${PGDATA}/`, volume: {} }];
      }),
    );
    await h.service.open(TARGET, options());
    // Before: [FOLDER, 'vscode'] alone, and the files of Postgres (uid 999) in the volume were given to vscode.
    // review round 16, L2: the targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [PGDATA], new Set([PGDATA]))]]);
    // Not a path of the workspace volume: neither recorded nor named for Delete.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toBeUndefined();
    expect(await h.service.repositoryServiceData(ENV_ID)).toEqual([]);
  });

  it('adds the mounts of devcontainer.json (read with docker inspect) after the paths of the services, and falls back to the whole repository when the container cannot be read', async () => {
    h.helper.containerMounts = [
      { type: 'volume', volume: 'api-node_modules', target: `${FOLDER}/node_modules` },
      { type: 'tmpfs', target: `${FOLDER}/tmp` },
      { type: 'bind', target: '/home/vscode/.ssh' },
    ];
    await h.service.open(TARGET, options());
    // review round 16, L2: the targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [`${FOLDER}/node_modules`, `${FOLDER}/tmp`], new Set([`${FOLDER}/node_modules`, `${FOLDER}/tmp`]))]]);

    h.cleanup();
    h = createHarness({ newEnvironmentId: () => ENV_ID });
    useCompose(h);
    // The inspect after `up` fails.
    const find = h.docker.findContainer.bind(h.docker);
    h.docker.findContainer = async (id: string, name: string) => {
      if (h.helper.ups.length > 0) throw new Error('Cannot connect to the Docker daemon');
      return find(id, name);
    };
    await h.service.open(TARGET, options());
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, 'repository')]]);
  });
  it('protects an alias of the workspace volume below the repository that the dev service mounts (review round 13, D13-1)', async () => {
    // ./data:/workspaces/api/pgview in the dev service, ./data:/var/lib/postgresql/data in db.
    const DATA = `${FOLDER}/data`;
    const PGVIEW = `${FOLDER}/pgview`;
    const out = output((m) => {
      m.services.db.volumes = [{ type: 'bind', source: DATA, target: '/var/lib/postgresql/data', bind: {} }];
      m.services.app.volumes = [...(m.services.app.volumes as unknown[]), { type: 'bind', source: DATA, target: PGVIEW, bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [DATA]: DATA };
    useCompose(h, out);
    await h.service.open(TARGET, options());
    const upApp = upModel().services.app.volumes as Array<{ type: string; source?: string; target: string }>;
    // The pipeline rewrote the bind to the workspace volume (a subpath of it).
    expect(upApp.find((entry) => entry.target === PGVIEW)).toMatchObject({ type: 'volume', source: WORKSPACE_VOLUME_KEY });
    // Before: [DATA] alone, and `find -xdev` gave the files of db (uid 999) to vscode through pgview.
    // review round 16, L2: the targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [DATA, PGVIEW], new Set([PGVIEW]))]]);
    // Not recorded: it matters only in the dev container.
    expect((await h.registry.get(ENV_ID))?.serviceFolders).toEqual([DATA]);
  });

  it('gives a mount of the workspace volume at its own canonical path the full fix (review round 14, P14-1)', async () => {
    // ..:/workspaces/api and ../src:/workspaces/api/src in the dev service: the subpaths api and api/src of the workspace
    // volume, each at its own path. src is no alias: after a change of the uid of the remote user, its files of the
    // old uid must get the new one.
    const SRC = `${FOLDER}/src`;
    const out = output((m) => {
      m.services.app.volumes = [
        ...(m.services.app.volumes as unknown[]),
        { type: 'bind', source: FOLDER, target: FOLDER, bind: {} },
        { type: 'bind', source: SRC, target: SRC, bind: {} },
      ];
    });
    out.realPaths = { ...out.realPaths, [FOLDER]: FOLDER, [SRC]: SRC };
    useCompose(h, out);
    await h.service.open(TARGET, options());
    const upApp = upModel().services.app.volumes as Array<{ type: string; target: string; volume?: { subpath?: string } }>;
    expect(upApp.find((entry) => entry.target === SRC)).toMatchObject({ type: 'volume', volume: { subpath: 'api/src' } });
    // Before: [SRC], and only the files of root in src got the remote user.
    expect(fixArguments()).toEqual([[FOLDER, 'vscode']]);
  });

  it('keeps a mount of the workspace volume at its own path protected when the mounts of the container cannot be read (review round 14, P14-1)', async () => {
    const SRC = `${FOLDER}/src`;
    const out = output((m) => {
      m.services.app.volumes = [...(m.services.app.volumes as unknown[]), { type: 'bind', source: SRC, target: SRC, bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [SRC]: SRC };
    useCompose(h, out);
    h.docker.execHandler = (_container, command) => (command[0] === 'cat' ? { exitCode: 1, stderr: 'cat: not found' } : {});
    await h.service.open(TARGET, options());
    expect(h.docker.execs.filter((e) => e.command[0] === 'cat').map((e) => [e.command, e.user])).toEqual([[['cat', '/proc/self/mountinfo'], 'root']]);
    // review round 16, L2: the targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [SRC], new Set([SRC]))]]);
  });

  it('keeps a mount of the workspace volume protected when a link in the volume makes it another folder (review round 14, P14-1)', async () => {
    // ../src:/workspaces/api/src, but src is a link to data in the volume (db mounts ./data): Docker mounts data there.
    const SRC = `${FOLDER}/src`;
    const out = output((m) => {
      m.services.app.volumes = [...(m.services.app.volumes as unknown[]), { type: 'bind', source: SRC, target: SRC, bind: {} }];
    });
    out.realPaths = { ...out.realPaths, [SRC]: SRC };
    useCompose(h, out);
    h.docker.volumeLinks.set('api/src', 'api/data');
    await h.service.open(TARGET, options());
    // review round 16, L2: the targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [SRC], new Set([SRC]))]]);
  });

  it('gives an anonymous volume of the dev container the full fix, and keeps a named volume protected (review round 13, D13-3)', async () => {
    // An anonymous `node_modules` volume (Docker names it with 64 hexadecimal characters), whose image content is of uid
    // 1000, and a named cache volume.
    h.helper.containerMounts = [
      { type: 'volume', volume: 'c'.repeat(64), target: `${FOLDER}/node_modules` },
      { type: 'volume', volume: 'api-cache', target: `${FOLDER}/.cache` },
    ];
    await h.service.open(TARGET, options());
    // Before (review round 12): node_modules protected too (only the files of root changed).
    // review round 16, L2: the targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [`${FOLDER}/.cache`], new Set([`${FOLDER}/.cache`]))]]);
  });

  it('keeps an anonymous volume protected when the host access checks are off (review round 13, D13-3)', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    h.helper.containerMounts = [{ type: 'volume', volume: 'c'.repeat(64), target: `${FOLDER}/node_modules` }];
    await h.service.open(TARGET, options());
    // review round 16, L2: the targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(fixArguments()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [`${FOLDER}/node_modules`], new Set([`${FOLDER}/node_modules`]))]]);
  });
});

describe('review round 15 of unit 6 (K1, K2): the `mounts` of a Compose configuration as the Dev Container CLI writes them', () => {
  const REWRITTEN = (mount: unknown) => `mount ${JSON.stringify(mount)} is written differently by the Dev Container CLI and is not supported`;

  it('refuses a tmpfs mount with a source in devcontainer.json before any build, also with the checks off', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"source=cache,target=/cache,type=volume"', '"type=tmpfs,src=/,dst=/host"') },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(REWRITTEN('type=tmpfs,src=/,dst=/host'));
    expect(h.helper.builds).toEqual([]);
    expect(h.helper.ups).toEqual([]);
  });

  it('refuses a Feature that mounts the Docker socket as tmpfs before up (image metadata)', async () => {
    const mount = { type: 'tmpfs', source: '/var/run/docker.sock', target: '/var/run/docker.sock' };
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/sock:1', mounts: [mount] }];
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(REWRITTEN(mount));
    expect(h.helper.ups).toEqual([]);
    expect(devContainer()).toBeUndefined();
  });

  it('refuses a volume at the internal folder by the target that the CLI cuts at the second `=` (K2)', async () => {
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: {
        configText: CONFIG_TEXT.replace('"source=cache,target=/cache,type=volume"', '"type=volume,src=foo,dst=/workspaces/.devenv+=x"'),
      },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(REWRITTEN('type=volume,src=foo,dst=/workspaces/.devenv+=x'));
    expect(h.helper.builds).toEqual([]);
  });

  it('still opens the usual named volume of `mounts` and a docker-in-docker Feature', async () => {
    h.helper.buildMetadata = [
      { id: 'ghcr.io/devcontainers/features/docker-in-docker:2', mounts: [{ source: 'dind-var-lib-docker-${devcontainerId}', target: '/var/lib/docker', type: 'volume' }] },
    ];
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  it('checks the label with the variables of the CLI substituted, as for a single container (merge of #27, review round 16, L3)', async () => {
    h.helper.buildMetadata = [
      {
        id: 'ghcr.io/acme/features/cache:1',
        mounts: ['source=${localWorkspaceFolderBasename}-node_modules,target=${containerWorkspaceFolder}/node_modules,type=volume'],
      },
    ];
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });

  it('refuses a variable of the label that is left after the substitution with the item of #27, not as written differently', async () => {
    const mount = 'source=${localEnv:TERM}-x,target=/x,type=volume';
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/term:1', mounts: [mount] }];
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`mount ${JSON.stringify(mount)} uses \${localEnv:TERM}, which cannot be checked`);
    expect(error.message).not.toContain(REWRITTEN(mount));
    expect(h.helper.ups).toEqual([]);
  });
});

describe('review round 15 of unit 6 (K3, K4): the ownership fixes after up', () => {
  const CONFIG = '/workspaces/.devenv+';

  /** The execs in the dev container that walk a folder with an ownership fix: [folder, user, …]. */
  function devFixes(): string[][] {
    return h.docker.execs.filter((e) => e.command[2] === OWNERSHIP_FIX_SCRIPT).map((e) => e.command.slice(4));
  }

  it('fixes the internal folder in a helper container with the numeric IDs of the remote user, not in the dev container (K3)', async () => {
    // A mount of the dev container through a link of the repository (x -> ../.devenv+) would lie in the internal folder
    // in the dev container; the helper mounts only the workspace volume.
    h.helper.containerMounts = [{ type: 'volume', volume: `${PROJECT}_pgdata`, target: `${FOLDER}/x` }];
    await h.service.open(TARGET, options());
    expect(devFixes().map((args) => args[0])).toEqual([FOLDER]);
    expect(devFixes().some((args) => args[0] === CONFIG)).toBe(false);
    const ids = h.docker.execs.filter((e) => e.command[0] === 'id');
    expect(ids.map((e) => [e.command, e.user])).toEqual([
      [['id', '-u', 'vscode'], 'root'],
      [['id', '-g', 'vscode'], 'root'],
    ]);
    expect(h.helper.configOwnershipFixes).toEqual([{ volumeName: NAME, folder: CONFIG, uid: '1000', gid: '1000' }]);
  });

  it('skips the fix of the internal folder and logs it when the IDs are not numbers (K3)', async () => {
    h.docker.execHandler = (_container, command) => (command[0] === 'id' && command[1] === '-g' ? { stdout: '1000 staff\n' } : {});
    await h.service.open(TARGET, options());
    expect(h.helper.configOwnershipFixes).toEqual([]);
    expect(h.logger.warnings.some((line) => line.includes(`The owner of the files in ${CONFIG} could not be changed`) && line.includes('id -g vscode'))).toBe(true);
    expect(devFixes().some((args) => args[0] === CONFIG)).toBe(false);
  });

  it('logs a failed fix of the internal folder, and the open goes on (K3)', async () => {
    h.helper.configOwnershipResult = { exitCode: 1, stderr: `${CONFIG} is not a folder.` };
    const result = await h.service.open(TARGET, options());
    expect(result.containerName).toBe(NAME);
    expect(h.logger.warnings).toContain(`The owner of the files in ${CONFIG} could not be changed: ${CONFIG} is not a folder.`);
  });

  it('leaves a volume that the dev container mounts in .git to its owners, and the rest of .git gets the full fix (K4)', async () => {
    h.helper.containerMounts = [{ type: 'volume', volume: `${PROJECT}_pgdata`, target: `${FOLDER}/.git/pg` }];
    await h.service.open(TARGET, options());
    // Before: [FOLDER, 'vscode'] alone (the filter of .git dropped the target), and the fix gave the data of db to vscode.
    // review round 16, L2: the targets of the mounts of the dev container are marked one by one (DevMountPaths).
    expect(devFixes()).toEqual([[FOLDER, 'vscode', ...servicePathArguments(FOLDER, [`${FOLDER}/.git/pg`], new Set([`${FOLDER}/.git/pg`]))]]);
    expect(servicePathArguments(FOLDER, [`${FOLDER}/.git/pg`], true)).toEqual(['(', '-path', `${FOLDER}/.git/pg`, '-o', '-path', `${FOLDER}/.git/pg/*`, ')']);
  });
});

describe('review round 16 of unit 6 (Dp): the user that the Dev Container CLI writes into its compose file for the build', () => {
  const USER = 'root\n      ssh:\n        - default=/workspaces/.devenv+/github-token';

  it('refuses an image of the dev service whose user has a line break, before the build, also with the checks off', async () => {
    for (const off of [false, true]) {
      h.cleanup();
      h = createHarness({ newEnvironmentId: () => ENV_ID });
      useCompose(h);
      if (off) h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
      h.docker.imageConfigs.set(BASE_IMAGE, { User: USER });
      const error = await rejection(h.service.open(TARGET, options()));
      expect(error.code).toBe('hostAccess');
      expect(error.message).toContain(`service app: the user ${JSON.stringify(USER)} of the image ${BASE_IMAGE}`);
      expect(h.helper.builds).toEqual([]);
      expect(h.helper.ups).toEqual([]);
    }
  });

  it('checks the image after its download, and builds with a plain user', async () => {
    h.docker.imageConfigs.set(BASE_IMAGE, { User: 'vscode' });
    await h.service.open(TARGET, options());
    expect(h.docker.log.indexOf(`pull ${BASE_IMAGE}`)).toBeGreaterThanOrEqual(0);
    expect(h.helper.builds).toHaveLength(1);
  });

  it('does not inspect the images without Features (the CLI writes no user then)', async () => {
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace(`"features": { "${FEATURE}": {} },`, '') } };
    h.docker.imageConfigs.set(BASE_IMAGE, { User: USER });
    await h.service.open(TARGET, options());
    expect(h.helper.builds).toHaveLength(1);
  });

  it('refuses a build target of the dev service with a line break before any build', async () => {
    useCompose(
      h,
      output((m) => {
        m.services.app = { build: { context: `${FOLDER}/.devcontainer`, dockerfile: 'Dockerfile', target: 'base\n      ssh:\n        - default' }, command: ['sleep', 'infinity'] };
      }),
    );
    const out = h.helper.composeOutput as ComposeModelOutput;
    h.helper.composeOutput = {
      ...out,
      dockerfiles: { app: 'FROM alpine AS base\n' },
      realPaths: { ...out.realPaths, [`${FOLDER}/.devcontainer`]: `${FOLDER}/.devcontainer`, [`${FOLDER}/.devcontainer/Dockerfile`]: `${FOLDER}/.devcontainer/Dockerfile` },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain('service app: build target');
    expect(h.helper.builds).toEqual([]);
  });
});

describe('review round 16 of unit 6 (L1): values that the Dev Container CLI writes as text into its compose file for up', () => {
  it('refuses a containerUser of the image metadata with a line break before up, also with the checks off', async () => {
    h.settings = { ...h.settings, hostAccessChecksOff: [REPO] };
    const user = 'root\n    privileged: true';
    h.helper.buildMetadata = [{ id: 'ghcr.io/acme/features/user:1', containerUser: user, entrypoint: '/x.sh"]\n    privileged: true\n    x-a: ["' }];
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`containerUser ${JSON.stringify(user)}`);
    expect(h.helper.ups).toEqual([]);
  });

  it('refuses a containerEnv name of devcontainer.json that is no plain name before any build', async () => {
    h.helper.files = {
      [DEFAULT_CONFIG_PATH]: { configText: CONFIG_TEXT.replace('"remoteUser": "vscode",', `"remoteUser": "vscode", "containerEnv": { "A'": "1" },`) },
    };
    const error = await rejection(h.service.open(TARGET, options()));
    expect(error.code).toBe('hostAccess');
    expect(error.message).toContain(`containerEnv variable "A'"`);
    expect(h.helper.builds).toEqual([]);
  });

  it('still opens with the usual values', async () => {
    h.helper.buildMetadata = [{ id: 'ghcr.io/devcontainers/features/docker-in-docker:2', entrypoint: '/usr/local/share/docker-init.sh', containerEnv: { DOCKER_BUILDKIT: '1' } }, { containerUser: 'vscode' }];
    await h.service.open(TARGET, options());
    expect(h.helper.ups).toHaveLength(1);
  });
});
