// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open pipeline for a Docker Compose configuration (implementation notes, section "Docker Compose") against the
// real Docker engine: an app service built from a one-line Dockerfile and a db service from an image, both from the
// test base image with `sleep infinity`. Open: both containers with the labels of the environment, the dev container
// with the name of the environment and the workspace volume, the published port of db on 127.0.0.1 only, the repository
// files that db mounts (a folder and a single file) from the workspace volume (volume.subpath), the volumes of the
// project and of `mounts` with our labels; the refusal of a privileged service before any build; Stop of both; open
// again without a build. Package C of unit 6: the host name of the dev container; Delete (all containers, the network,
// and the images of the project; the data volumes of the services only when the user ticks them); the label
// nimblescape.devenv.host-access=unrestricted on every container, and ports as the model writes them, while the host
// access checks are off for the repository.
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import { environmentDevcontainerId } from '../../src/core/helper/cliVariables';
import { supportsVolumeSubpath } from '../../src/core/helper/compose';
import { WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { ImageChecker } from '../../src/core/imageCheck/imageCheck';
import { Messages } from '../../src/core/messages';
import {
  CONTAINER_VERSION,
  GITHUB_TOKEN_FILE,
  TOKEN_FOLDER,
  TOKEN_TMPFS,
  HOST_ACCESS_CHECKED,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_COMPOSE_SERVICE,
  LABEL_ENVIRONMENT_ID,
  LABEL_HOST_ACCESS,
  LABEL_REPOSITORY,
  LABEL_VOLUME,
  VOLUME_KIND_COMPOSE,
  composeProjectName,
  environmentImageRepository,
  newEnvironmentId,
  resourceName,
} from '../../src/core/names';
import { EnvironmentService } from '../../src/core/pipeline/environmentService';
import { isoTime, systemClock } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { StoragePaths } from '../../src/core/storage/paths';
import { EnvironmentRegistry } from '../../src/core/storage/registry';
import { SessionFiles } from '../../src/core/storage/sessionFiles';
import type { ExtensionSettings } from '../../src/core/types';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import {
  DUMMY_TOKEN,
  FakeUi,
  HELPER_DOCKERFILE,
  RecordingProgress,
  TEST_ACCOUNT,
  dockerTestContext,
  expectLabelledEnvironmentImage,
  fakeAuth,
  registryClient,
  registryTransport,
  runInVolume,
} from './harness';
import { inProcessAnalyzer } from '../../src/core/helper/configurationAnalysis';
import { workerLocks } from './workerLocks';

const CONFIG_PATH = '.devcontainer/devcontainer.json';
const INIT_SQL = 'select 1;';
const SEED_TEXT = 'seed data';
/** Lifecycle token (user decision 2026-09-27): the file in the dev container where postCreateCommand notes its run. */
const POST_CREATE_LOG = '/tmp/devenv-post-create';

/** Writes the files of `$2` (JSON: relative path → text) into the repository folder `$1` and commits them, as root. */
const SEED_SCRIPT = `set -eu
mkdir -p "$1"
cd "$1"
node -e '
const fs = require("fs");
const path = require("path");
for (const [file, text] of Object.entries(JSON.parse(process.argv[1]))) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
' "$2"
git init -q -b main
git add -A
git -c user.name=Test -c user.email=test@example.invalid commit -q -m 'Initial commit'
`;

let settings: ExtensionSettings = {
  reopenLastOnStartup: true,
  stopOnClose: true,
  waitingTimeSeconds: 30,
  updateImagesOnConnect: true,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: false,
  refreshIntervalMinutes: 60,
  hostAccessChecksOff: [],
};

describe('open pipeline for a Docker Compose configuration', () => {
  const { run, env, cli, log } = dockerTestContext('compose');
  const runner = new NodeProcessRunner();
  const docker = new ContainerAdapter(runner, run.dockerPath, env, log);
  const helper = new WorkspaceHelper({ docker, logger: log, dockerfilePath: HELPER_DOCKERFILE, env });
  const paths = new StoragePaths(path.join(run.runDir, 'compose-storage'));
  const registry = new EnvironmentRegistry(paths, systemClock, { logger: log });
  const sessionFiles = new SessionFiles(paths);
  const ui = new FakeUi();
  // Plan step 6, PR C: the real locks of the workers (the opens run their helper steps in the batch helper of the worker
  // that holds the lock; there is no other path, D1).
  const targets = new DockerTargets(docker, env, log);
  const locks = workerLocks({ run, cli, log }, docker, targets, 'compose', async (target) => helperDockerSocket(env, process.platform, target.endpoint));
  const service = new EnvironmentService({
    analyzer: inProcessAnalyzer,
    // Plan step 5, PR B (D1: no unlocked path): the lock is required. Plan step 6, PR C: changed (before: a fake lock that
    // was always granted, whose plain Docker calls ran directly): the real lock of the worker, whose batch helper runs the
    // helper steps of the opens.
    environmentLock: locks.take,
    flow: (op, params, options) => locks.flow(op, params, options),
    docker,
    runner,
    helper,
    registry,
    sessionFiles,
    imageChecker: new ImageChecker(registryClient(registryTransport, runner, env, log), log),
    auth: fakeAuth,
    ui,
    logger: log,
    clock: systemClock,
    platform: process.platform,
    env,
    owner: { windowId: 'docker-test-compose', pid: process.pid },
    settings: () => settings,
    windowStatuses: () => sessionFiles.readWindowStatuses(),
  });

  /**
   * A seeded environment: its workspace volume with the repository, and its registry entry.
   * User decisions 2026-10-03: the project and the environment image are named after the repository too (resourceName).
   */
  function environment(repository: string) {
    const id = newEnvironmentId();
    const name = resourceName(repository, id);
    return { repository, id, name, project: composeProjectName(repository, id), folder: `/workspaces/${repository.split('/')[1]}` };
  }
  const app = environment('devenv-test/tiny-compose');
  const refused = environment('devenv-test/refused-compose');
  const unrestricted = environment('devenv-test/unrestricted-compose');
  // Review round 15 (K1): a `mounts` entry that the Dev Container CLI would write as a bind of the Docker socket.
  const tmpfsSource = environment('devenv-test/tmpfs-source-compose');
  const TMPFS_SOURCE_MOUNT = 'type=tmpfs,src=/var/run/docker.sock,dst=/var/run/docker.sock';
  const HISTORY_MOUNT = 'source=history-${devcontainerId},target=/history,type=volume';
  let apiVersion: string;

  /** The compose file: `db` publishes a port without an address and mounts a folder and a file of the repository. */
  function composeFile(extra = ''): string {
    return `services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    command: sleep infinity
    volumes:
      - ../..:/workspaces:cached
    labels:
      ${TEST_RUN_LABEL}: "${run.runId}"
  db:
    image: ${TEST_BASE_IMAGE}
    command: sleep infinity
    # Review round 7 (P7-1): as the templates (Python & PostgreSQL); rewritten to no.
    restart: unless-stopped
    ports:
      - "5432"
    volumes:
      - dbdata:/data
      - ../seed:/init/seed:ro
      - ../init.sql:/init/init.sql:ro
    labels:
      ${TEST_RUN_LABEL}: "${run.runId}"
${extra}volumes:
  dbdata:
`;
  }

  async function seed(target: ReturnType<typeof environment>, compose: string, mounts: readonly string[] = ['source=cache,target=/cache,type=volume']): Promise<void> {
    const devcontainerJson = JSON.stringify({
      name: 'Tiny Compose',
      dockerComposeFile: ['compose.yml'],
      service: 'app',
      workspaceFolder: target.folder,
      // A named volume of `mounts`: the Dev Container CLI declares it in the project; our model declares it external.
      mounts,
      // Lifecycle token (user decision 2026-09-27): notes whether the token was there when the command ran.
      postCreateCommand: `if test -s ${GITHUB_TOKEN_FILE}; then echo present; else echo missing; fi >> ${POST_CREATE_LOG}`,
    });
    const files = {
      [CONFIG_PATH]: devcontainerJson,
      '.devcontainer/compose.yml': compose,
      '.devcontainer/Dockerfile': `FROM ${TEST_BASE_IMAGE}\nRUN apk add --no-cache git\nLABEL ${TEST_RUN_LABEL}=${run.runId}\n`,
      'init.sql': `${INIT_SQL}\n`,
      'seed/data.txt': `${SEED_TEXT}\n`,
    };
    await docker.createVolume(target.name, {
      [LABEL_ENVIRONMENT_ID]: target.id,
      [LABEL_REPOSITORY]: target.repository,
      [TEST_RUN_LABEL]: run.runId,
    });
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image (runInVolume).
    const seeded = await runInVolume(docker, target.name, ['sh', '-c', SEED_SCRIPT, 'sh', target.folder, JSON.stringify(files)]);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({
      id: target.id,
      repository: target.repository,
      configPath: CONFIG_PATH,
      volumeName: target.name,
      containerName: target.name,
      createdAt: now,
      lastUsedAt: now,
      owner: TEST_ACCOUNT,
    });
  }

  function containers(target: ReturnType<typeof environment>): string[] {
    return cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_ENVIRONMENT_ID}=${target.id}`]);
  }

  function dbContainer(target = app): string {
    const ids = cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_ENVIRONMENT_ID}=${target.id}`, '--filter', `label=${LABEL_COMPOSE_SERVICE}=db`]);
    expect(ids).toHaveLength(1);
    return ids[0];
  }

  function exec(container: string, script: string): string {
    const result = cli.run(['exec', container, 'sh', '-c', script]);
    if (result.code !== 0) throw new Error(`docker exec failed (${result.code}): ${result.err}`);
    return result.out;
  }

  /** The containers, networks, and volumes of the Compose projects: they carry the labels of the environment. */
  function removeProjectObjects(): void {
    for (const target of [app, refused, unrestricted, tmpfsSource]) {
      for (const id of containers(target)) cli.run(['rm', '-f', id]);
      for (const id of cli.lines(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${target.project}`])) cli.run(['network', 'rm', id]);
      for (const name of cli.lines(['volume', 'ls', '-q', '--filter', `label=${LABEL_ENVIRONMENT_ID}=${target.id}`])) {
        if (name !== target.name) cli.run(['volume', 'rm', name]);
      }
      for (const image of cli.lines(['image', 'ls', '-q', '--filter', `reference=${environmentImageRepository(target.repository, target.id)}*`])) cli.run(['image', 'rm', '-f', image]);
    }
  }

  beforeAll(async () => {
    await helper.ensureImage();
    paths.ensureDirectoriesSync();
    apiVersion = cli.ok(['version', '--format', '{{.Server.APIVersion}}']);
    log.info(`Docker Engine API ${apiVersion}`);
    // Review round 17 (D17-1): with a volume named with `${devcontainerId}`, which read-configuration leaves as written.
    await seed(app, composeFile(), ['source=cache,target=/cache,type=volume', HISTORY_MOUNT]);
    // The privileged line goes into the db service; the replace must match (review round 7 put `restart` before `ports`).
    const refusedFile = composeFile('').replace('    restart: unless-stopped\n    ports:', '    restart: unless-stopped\n    privileged: true\n    ports:');
    expect(refusedFile).toContain('privileged: true');
    await seed(refused, refusedFile);
    await seed(unrestricted, composeFile());
    await seed(tmpfsSource, composeFile(), [TMPFS_SOURCE_MOUNT]);
    // Delete removes the base images that no build record uses any more; a stopped container of the base image keeps it
    // for the other tests and for the baseline of the engine (Docker does not remove an image that a container uses).
    cli.ok(['create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--name', `devenv-test-compose-guard-${run.runId}`, TEST_BASE_IMAGE, 'true']);
  });

  afterAll(async () => {
    // Plan step 6, PR C: no worker and no batch helper is left over.
    const leftovers = await locks.dispose();
    removeProjectObjects();
    removeRunObjects(cli, run.runId);
    expect(leftovers).toEqual([]);
    expect(containers(app)).toEqual([]);
    expect(cli.volume(app.name)).toBeUndefined();
  });

  it('refuses a privileged service before any build: no image, no container, the volume stays', async () => {
    const error = await service.openEnvironment(refused.id, { progress: new RecordingProgress() }).then(
      () => undefined,
      (reason: unknown) => reason as Error & { code?: string },
    );
    expect(error?.code).toBe('hostAccess');
    expect(error?.message).toBe(Messages.hostAccess('service db: privileged mode'));
    expect(containers(refused)).toEqual([]);
    expect(cli.lines(['image', 'ls', '-q', '--filter', `reference=${environmentImageRepository(refused.repository, refused.id)}*`])).toEqual([]);
    expect(cli.volume(refused.name)).toBeDefined();
    expect(cli.volume(`${refused.project}_dbdata`)).toBeUndefined();
  });

  it('refuses a tmpfs mount with a source, which the CLI writes as a bind mount, also with the checks off: no container (review round 15, K1)', async () => {
    settings = { ...settings, hostAccessChecksOff: [tmpfsSource.repository] };
    let error: (Error & { code?: string }) | undefined;
    try {
      error = await service.openEnvironment(tmpfsSource.id, { progress: new RecordingProgress() }).then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      );
    } finally {
      settings = { ...settings, hostAccessChecksOff: [] };
    }
    expect(error?.code).toBe('hostAccess');
    expect(error?.message).toContain(`mount ${JSON.stringify(TMPFS_SOURCE_MOUNT)} is written differently by the Dev Container CLI and is not supported`);
    expect(containers(tmpfsSource)).toEqual([]);
    expect(cli.lines(['image', 'ls', '-q', '--filter', `reference=${environmentImageRepository(tmpfsSource.repository, tmpfsSource.id)}*`])).toEqual([]);
  });

  it('first open: both services run with the labels, the port on 127.0.0.1, and repository files from the volume', async () => {
    if (!supportsVolumeSubpath(apiVersion)) {
      // Docker Engine before 26 has no volume.subpath: the bind mounts of repository files are refused (tested in the unit tests).
      log.info(`Docker Engine API ${apiVersion} has no volume.subpath; the open is refused.`);
      return;
    }
    const progress = new RecordingProgress();
    const batchesBefore = locks.batches.get(app.id)?.length ?? 0;
    const result = await service.openEnvironment(app.id, { progress });
    expect(result).toMatchObject({ containerName: app.name, remoteWorkspaceFolder: app.folder });
    expect(progress.steps).toEqual(['checkingImage', 'downloadingImage', 'preparing', 'starting']);
    // Plan step 6, PR C: the whole open (the reads, the Compose model and hashes, the folders, the build, `up`, the
    // lifecycle commands, the Git files) ran in exactly one batch helper container.
    expect((locks.batches.get(app.id) ?? []).length - batchesBefore).toBe(1);

    // The dev container: the name of the environment, the labels, the project, the environment image, the workspace volume.
    const dev = cli.container(app.name);
    expect(dev?.State.Running).toBe(true);
    expect(dev?.Config.Image).toBe(`${environmentImageRepository(app.repository, app.id)}:1`);
    expect(dev?.Config.Labels).toMatchObject({
      [LABEL_ENVIRONMENT_ID]: app.id,
      'nimblescape.devenv.container-version': String(CONTAINER_VERSION),
      'com.docker.compose.project': app.project,
      'com.docker.compose.service': 'app',
    });
    expect(dev?.Config.Labels?.[LABEL_COMPOSE_SERVICE]).toBeUndefined();
    // Review round 3 (D3-2): with `--id-label`, the CLI sets no devcontainer.config_file, so a restored entry cannot read
    // its configuration path from its containers.
    expect(dev?.Config.Labels?.['devcontainer.config_file']).toBeUndefined();
    expect(dev?.Mounts.find((mount) => mount.Destination === '/workspaces')).toMatchObject({ Type: 'volume', Name: app.name });
    // The host name of the dev container is the repository name, as for a single container; db keeps the one of Docker.
    expect(dev?.Config.Hostname).toBe('tiny-compose');
    // The volume of `mounts` is the project volume that we created with the labels (the CLI's declaration merged into ours).
    expect(dev?.Mounts.find((mount) => mount.Destination === '/cache')).toMatchObject({ Type: 'volume', Name: `${app.project}_cache` });
    // D-7 (package C): a volume of the project, like the data of the services: `compose`, never shared.
    expect(cli.volume(`${app.project}_cache`)?.Labels).toMatchObject({ [LABEL_ENVIRONMENT_ID]: app.id, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE });
    // Review round 17 (D17-1): the `${devcontainerId}` volume by the name that the CLI computes, created with the labels.
    const history = `${app.project}_history-${environmentDevcontainerId(app.id)}`;
    expect(dev?.Mounts.find((mount) => mount.Destination === '/history')).toMatchObject({ Type: 'volume', Name: history });
    expect(cli.volume(history)?.Labels).toMatchObject({ [LABEL_ENVIRONMENT_ID]: app.id, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE });
    // Compose kept our declaration `external: true` for it and for the project volume: it created no volume and warned
    // about none that it did not create.
    expect(fs.readFileSync(log.file, 'utf8')).not.toContain('was not created by Docker Compose');
    expect(exec(app.name, `cat ${app.folder}/init.sql`)).toBe(INIT_SQL);
    // Unit 15: the token is in the tmpfs of the dev container (in memory), not in the volume; db has no such tmpfs.
    expect(dev?.HostConfig.Tmpfs).toEqual({ [TOKEN_FOLDER]: TOKEN_TMPFS.slice(TOKEN_FOLDER.length + 1) });
    expect(exec(app.name, `stat -f -c %T ${TOKEN_FOLDER}`)).toBe('tmpfs');
    expect(exec(app.name, `cat ${GITHUB_TOKEN_FILE}`)).toBe(DUMMY_TOKEN);
    expect(exec(app.name, `grep -rl '${DUMMY_TOKEN}' /workspaces || true`)).toBe('');

    // The db container: the labels of the environment, the port on 127.0.0.1 only, the data volume of the project.
    const db = dbContainer();
    const details = cli.container(db);
    expect(details?.State.Running).toBe(true);
    expect(details?.Config.Hostname).not.toBe('tiny-compose');
    expect(details?.Config.Labels).toMatchObject({ [LABEL_ENVIRONMENT_ID]: app.id, [LABEL_COMPOSE_SERVICE]: 'db', 'com.docker.compose.project': app.project });
    // Review round 7 (P7-1): `restart: unless-stopped` of the compose file opens, and Docker never starts db by itself.
    expect(details?.HostConfig.RestartPolicy?.Name).toBe('no');
    expect(dev?.HostConfig.RestartPolicy?.Name ?? 'no').toBe('no');
    expect(fs.readFileSync(log.file, 'utf8')).toContain('service db: restart unless-stopped');
    const ports = cli.lines(['port', db, '5432/tcp']);
    expect(ports.length).toBeGreaterThan(0);
    for (const binding of ports) expect(binding).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(details?.Mounts.find((mount) => mount.Destination === '/data')).toMatchObject({ Type: 'volume', Name: `${app.project}_dbdata` });
    expect(cli.volume(`${app.project}_dbdata`)?.Labels).toMatchObject({ [LABEL_ENVIRONMENT_ID]: app.id, [LABEL_VOLUME]: VOLUME_KIND_COMPOSE });
    // Review round 2 (D2-3): the data volume of db carries the label of the data of a service; the cache of the dev
    // service does not.
    expect(cli.volume(`${app.project}_dbdata`)?.Labels?.['nimblescape.devenv.service-data']).toBe('true');
    expect(cli.volume(`${app.project}_cache`)?.Labels?.['nimblescape.devenv.service-data']).toBeUndefined();
    // Review round 2 (D2-2): every container gets nimblescape.devenv.host-access=checked from the model, whatever its
    // image says.
    expect(dev?.Config.Labels?.[LABEL_HOST_ACCESS]).toBe('checked');
    expect(details?.Config.Labels?.[LABEL_HOST_ACCESS]).toBe('checked');
    // Review round 4 (D4-2): the dev container carries the configuration path, for the restore after a lost registry.
    // Review round 5 (D5-1): only the dev service gets it; on the other services a changed selection would change their
    // Compose config hash and recreate them (their container file system would be lost).
    expect(dev?.Config.Labels?.['nimblescape.devenv.config-path']).toBe(CONFIG_PATH);
    expect(details?.Config.Labels?.['nimblescape.devenv.config-path']).toBeUndefined();
    // Review round 2 (D2-4): Compose puts labels on its containers that images never have (isComposeContainer).
    expect(dev?.Config.Labels?.['com.docker.compose.container-number']).toBeDefined();

    // Repository files from the workspace volume (volume.subpath): a folder and a single file, read-only.
    expect(details?.Mounts.find((mount) => mount.Destination === '/init/seed')).toMatchObject({ Type: 'volume', Name: app.name });
    expect(details?.Mounts.find((mount) => mount.Destination === '/init/init.sql')).toMatchObject({ Type: 'volume', Name: app.name });
    expect(exec(db, 'cat /init/seed/data.txt')).toBe(SEED_TEXT);
    expect(exec(db, 'cat /init/init.sql')).toBe(INIT_SQL);
    expect(cli.run(['exec', db, 'sh', '-c', 'echo changed > /init/init.sql']).code).not.toBe(0);
    // Only these paths of the volume: not the configuration folder with the token.
    expect(exec(db, 'ls /init')).toBe('init.sql\nseed');
    expect(exec(db, 'test -e /workspaces && echo yes || echo no')).toBe('no');
    expect(exec(db, `test -e ${TOKEN_FOLDER} && echo yes || echo no`)).toBe('no');

    const entry = await registry.get(app.id);
    expect(entry?.buildRecord).toMatchObject({
      environmentImage: `${environmentImageRepository(app.repository, app.id)}:1`,
      compose: { service: 'app', images: [`${app.project}-app`] },
    });
    // User decisions 2026-10-03: the Compose project, the dev container, and the workspace volume have one name.
    expect(app.project).toBe(app.name);
    // User decisions 2026-10-03: the environment image carries the labels of the environment and its build record (the
    // record pins its ID); the image that Compose built for the service and the networks of the project carry the
    // environment ID (rewriteModel).
    expectLabelledEnvironmentImage(cli, entry);
    expect(cli.image(`${app.project}-app`)?.Config.Labels?.[LABEL_ENVIRONMENT_ID]).toBe(app.id);
    const networks = cli.lines(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${app.project}`]);
    expect(networks.length).toBeGreaterThan(0);
    for (const network of networks) expect(cli.ok(['network', 'inspect', '-f', `{{index .Labels "${LABEL_ENVIRONMENT_ID}"}}`, network])).toBe(app.id);
    // Review round 10, F1/F3 (was D9-1): the paths that other services mount are on the entry, not the build record, and
    // read-only mounts are not recorded: db mounts seed and init.sql read-only, so neither is left out of the ownership fixes.
    expect(entry?.buildRecord?.compose).not.toHaveProperty('serviceFolders');
    expect(entry?.serviceFolders ?? []).not.toEqual(expect.arrayContaining([`${app.folder}/seed`]));
    expect(entry?.serviceFolders ?? []).not.toEqual(expect.arrayContaining([`${app.folder}/init.sql`]));
    // Review round 11 (G3, G4): the inspect of the db container (with the list of the containers of the project) yields
    // its subpaths of the workspace volume, read-only, as the list of the paths of the services reads them.
    const listed = (await docker.listProjectContainers(app.project)).find((container) => container.id.startsWith(db));
    expect(listed?.volumeSubpaths).toEqual(
      expect.arrayContaining([
        { volume: app.name, subpath: path.posix.relative('/workspaces', `${app.folder}/seed`), readOnly: true },
        { volume: app.name, subpath: path.posix.relative('/workspaces', `${app.folder}/init.sql`), readOnly: true },
      ]),
    );
    expect(entry?.buildRecord?.images).toHaveProperty([TEST_BASE_IMAGE]);
    expect(entry?.additionalVolumes).toEqual(expect.arrayContaining([`${app.project}_dbdata`, `${app.project}_cache`]));
    // Lifecycle token (user decision 2026-09-27): postCreateCommand ran once in the dev container, with the token.
    expect(exec(app.name, `cat ${POST_CREATE_LOG}`)).toBe('present');
  });

  it('Stop stops both containers; the next open starts them again without a build', async () => {
    if (!supportsVolumeSubpath(apiVersion)) return;
    const before = containers(app).sort();
    await service.stop(app.id);
    expect(cli.container(app.name)?.State.Running).toBe(false);
    expect(cli.container(dbContainer())?.State.Running).toBe(false);

    const progress = new RecordingProgress();
    await service.openEnvironment(app.id, { progress });
    expect(progress.steps).not.toContain('preparing');
    expect(containers(app).sort()).toEqual(before);
    expect(cli.container(app.name)?.State.Running).toBe(true);
    expect(cli.container(dbContainer())?.State.Running).toBe(true);
    expect(cli.lines(['image', 'ls', '--format', '{{.Tag}}', environmentImageRepository(app.repository, app.id)])).toEqual(['1']);
    expect((await registry.get(app.id))?.buildRecord?.buildNumber).toBe(1);
    // Lifecycle token (user decision 2026-09-27): run-user-commands after the start does not run postCreateCommand again.
    expect(exec(app.name, `cat ${POST_CREATE_LOG}`)).toBe('present');
  });

  it('Delete removes the containers, the network, and the images of the project, and only the ticked data volumes', async () => {
    if (!supportsVolumeSubpath(apiVersion)) return;
    // A one-off container of the project (`docker compose run`), without the labels of the environment.
    const oneOff = cli.ok([
      'create',
      '--label',
      `com.docker.compose.project=${app.project}`,
      '--label',
      `${TEST_RUN_LABEL}=${run.runId}`,
      TEST_BASE_IMAGE,
      'true',
    ]);
    expect(cli.lines(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${app.project}`]).length).toBeGreaterThan(0);
    expect(cli.lines(['image', 'ls', '-q', '--filter', `reference=${app.project}-*`]).length).toBeGreaterThan(0);
    // Review round 17 (D17-1): with the `${devcontainerId}` volume, which Delete lists like the other volumes of the project.
    const history = `${app.project}_history-${environmentDevcontainerId(app.id)}`;
    expect(await service.removableServiceDataVolumes(app.id)).toEqual(expect.arrayContaining([`${app.project}_dbdata`, `${app.project}_cache`, history]));
    // Review round 7 (D7-1): a running db is stopped (its stop time) before `docker rm -f`, so that it shuts down cleanly.
    const db = dbContainer();
    cli.ok(['start', db]);
    const logBefore = fs.readFileSync(log.file, 'utf8').length;

    await service.delete(app.id, { progress: new RecordingProgress(), additionalVolumesToRemove: [`${app.project}_cache`, history] });

    const deleteLog = fs.readFileSync(log.file, 'utf8').slice(logBefore);
    expect(deleteLog.indexOf(`Stopping container ${db}`)).toBeGreaterThanOrEqual(0);
    expect(deleteLog.indexOf(`Removing container ${db}`)).toBeGreaterThan(deleteLog.indexOf(`Stopping container ${db}`));

    expect(containers(app)).toEqual([]);
    expect(cli.container(oneOff)).toBeUndefined();
    expect(cli.lines(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${app.project}`])).toEqual([]);
    expect(cli.lines(['image', 'ls', '-q', '--filter', `reference=${app.project}-*`])).toEqual([]);
    expect(cli.lines(['image', 'ls', '-q', '--filter', `reference=${environmentImageRepository(app.repository, app.id)}:*`])).toEqual([]);
    expect(cli.volume(app.name)).toBeUndefined();
    // Ticked: removed. Not ticked: the data of the database stays.
    expect(cli.volume(`${app.project}_cache`)).toBeUndefined();
    expect(cli.volume(history)).toBeUndefined();
    expect(cli.volume(`${app.project}_dbdata`)).toBeDefined();
    expect(await registry.get(app.id)).toBeUndefined();
  });

  it('labels every container nimblescape.devenv.host-access=unrestricted and keeps the ports while the checks are off', async () => {
    if (!supportsVolumeSubpath(apiVersion)) return;
    settings = { ...settings, hostAccessChecksOff: [unrestricted.repository] };
    try {
      await service.openEnvironment(unrestricted.id, { progress: new RecordingProgress() });
    } finally {
      settings = { ...settings, hostAccessChecksOff: [] };
    }
    const dev = cli.container(unrestricted.name);
    expect(dev?.Config.Labels?.[LABEL_HOST_ACCESS]).toBe(HOST_ACCESS_UNRESTRICTED);
    const db = dbContainer(unrestricted);
    expect(cli.container(db)?.Config.Labels?.[LABEL_HOST_ACCESS]).toBe(HOST_ACCESS_UNRESTRICTED);
    // The port without an address is published as the model writes it: not only on 127.0.0.1.
    const ports = cli.lines(['port', db, '5432/tcp']);
    expect(ports.length).toBeGreaterThan(0);
    expect(ports.some((binding) => !binding.startsWith('127.0.0.1:'))).toBe(true);

    // With the checks on again, the next open creates the containers again with nimblescape.devenv.host-access=checked
    // (review round 2, D2-2: the model sets the label on every service, so an image label cannot claim "unrestricted"),
    // the port on 127.0.0.1.
    await service.openEnvironment(unrestricted.id, { progress: new RecordingProgress() });
    expect(cli.container(unrestricted.name)?.Config.Labels?.[LABEL_HOST_ACCESS]).toBe(HOST_ACCESS_CHECKED);
    const again = dbContainer(unrestricted);
    expect(cli.container(again)?.Config.Labels?.[LABEL_HOST_ACCESS]).toBe(HOST_ACCESS_CHECKED);
    for (const binding of cli.lines(['port', again, '5432/tcp'])) expect(binding).toMatch(/^127\.0\.0\.1:\d+$/);

    await service.delete(unrestricted.id, {
      progress: new RecordingProgress(),
      additionalVolumesToRemove: await service.removableServiceDataVolumes(unrestricted.id),
    });
    expect(containers(unrestricted)).toEqual([]);
    expect(cli.volume(`${unrestricted.project}_dbdata`)).toBeUndefined();
  });
});
