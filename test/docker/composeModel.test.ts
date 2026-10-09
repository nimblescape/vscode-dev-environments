// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The model run of a Docker Compose configuration (implementation notes, section "Docker Compose") in the real workspace
// helper: `docker compose config` without the Docker socket and without network (L-12), all profiles, the `.env` of the
// project, the `$` probe, the configuration folder with the token hidden, and whether Compose reads our rewrite of its
// own output again with the same values (L-6, D-1). The open, stop, and delete of a Compose environment are tested with
// the pipeline (compose.test.ts). Plan step 7 (user decision of 2026-10-01): the per-step path is removed, so the model
// runs in the batch helper of the real worker under a lock, as an operation runs it, as the owner of the repository (user
// decision of 2026-10-01; Q2: without `--network none`); the seeds and the checks run in a plain container of the helper
// image (runInVolume). Plan step 11I1, PR A1: the batch helper is started from the test process as the worker's own flow
// starts it (inProcessBatches), without the relay of the worker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Plan step 11I2: the Docker CLI of the extension (BootstrapDocker) in place of the removed CLI adapter ContainerAdapter.
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { toNetworkInfo } from '../../src/core/docker/dockerObjects';
import { composeUpModel, isSupportedComposeVersion, resolveComposeFiles, type ComposeModelOutput } from '../../src/core/helper/compose';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import type { WorkspaceHelper } from '../../src/core/helper/workspaceHelper';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import { composeProjectName, environmentImageName, resourceName } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { DUMMY_TOKEN, dockerTestContext, runInVolume, testHelperImage, testWorkspaceHelper } from './harness';
import { inProcessBatches, type InProcessBatches } from './workerLocks';
import { composeAccessReport } from '../../src/core/policy';

const ENVIRONMENT_ID = 'c0ffee00-0000-4000-8000-000000000000';
/** User decisions 2026-10-03: the Compose project, the dev container, and the environment image are named after the repository and the pair of the ID. */
const REPOSITORY = 'devenv-test/app';
const PROJECT = composeProjectName(REPOSITORY, ENVIRONMENT_ID);
const CONTAINER_NAME = resourceName(REPOSITORY, ENVIRONMENT_ID);
const IMAGE = environmentImageName(REPOSITORY, ENVIRONMENT_ID, 1);
const REPO = '/workspaces/app';

/** Writes files into the volume (absolute paths), without the Docker socket and without network. */
const WRITE_FILES_SCRIPT = String.raw`const fs = require('fs');
const path = require('path');
const files = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const [file, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
`;

const COMPOSE_FILE = `services:
  app:
    build:
      context: ..
      dockerfile: .devcontainer/Dockerfile
    command: sleep infinity
    volumes:
      - ../..:/workspaces:cached
    environment:
      LITERAL: "a$$b"
  db:
    image: \${DB_IMAGE}
    env_file: db.env
    ports:
      - "5432"
    volumes:
      - pgdata:/data
      - ../init.sql:/init.sql:ro
  tools:
    profiles: [debug]
    image: ${TEST_BASE_IMAGE}
volumes:
  pgdata:
`;

describe('model run of a Docker Compose configuration', () => {
  const { run, env, cli, log } = dockerTestContext('composeModel');
  const docker = new BootstrapDocker(new NodeProcessRunner(), run.dockerPath, env, log);
  // Plan step 11I (U7, decision of 2026-10-08): the helper of the worker, on the helper image of the tests as its own
  // image (before: a WorkspaceHelper that built that image itself); set in beforeAll.
  let helper: WorkspaceHelper;
  const volumeName = `devenv-test-compose-${run.runId}`;
  let apiVersion: string;
  // Plan step 7 (user decision of 2026-10-01): the per-step path is removed: the batch helper of the worker runs the model.
  // Plan step 11I1, PR A1: started from the test process (inProcessBatches) instead of through the lock of a worker.
  let batches: InProcessBatches | undefined;

  beforeAll(async () => {
    const image = await testHelperImage(docker, log, env);
    // Review round 1 (A-L4): the engine of the Docker context, as the worker's socket follows it.
    const socket = helperDockerSocket(env, process.platform, (await new DockerTargets(docker, env, log).current()).endpoint);
    batches = await inProcessBatches({ cli, log }, socket);
    // Plan step 11I (U7, decision of 2026-10-08): the model runs from that image with that socket, as in the worker.
    helper = testWorkspaceHelper(image, socket, cli, log);
    cli.ok(['volume', 'create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, volumeName]);
    apiVersion = cli.ok(['version', '--format', '{{.Server.APIVersion}}']);
    const files = {
      [`${REPO}/.devcontainer/compose.yml`]: COMPOSE_FILE,
      [`${REPO}/.devcontainer/.env`]: `DB_IMAGE=${TEST_BASE_IMAGE}\n`,
      [`${REPO}/.devcontainer/db.env`]: 'DB_PASSWORD=pw\n',
      [`${REPO}/.devcontainer/Dockerfile`]: `FROM ${TEST_BASE_IMAGE}\n`,
      [`${REPO}/.devcontainer/token.yml`]: 'services:\n  app:\n    env_file: ../../.devenv+/github-token\n',
      [`${REPO}/init.sql`]: 'select 1;\n',
      '/workspaces/.devenv+/github-token': `${DUMMY_TOKEN}\n`,
    };
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image.
    const result = await runInVolume(docker, volumeName, ['node', '-e', WRITE_FILES_SCRIPT], JSON.stringify(files));
    expect(result.exitCode, result.stderr).toBe(0);
  });

  afterAll(async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed: no batch helper is left over (plan step
    // 11I1, PR A1: no worker is started any more).
    // Review round 1 (A-L2): also when the setup failed before the batch helpers.
    const leftovers = batches === undefined ? [] : await batches.dispose();
    removeRunObjects(cli, run.runId);
    expect(leftovers).toEqual([]);
    expect(cli.volume(volumeName)).toBeUndefined();
  });

  async function model(names: string[]): Promise<ComposeModelOutput | { error: string }> {
    const resolved = resolveComposeFiles('.devcontainer/devcontainer.json', 'app', names);
    if (!('files' in resolved)) throw new Error(resolved.problem);
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed: the step in the batch helper of an operation.
    return batches!.inScope(ENVIRONMENT_ID, volumeName, () => helper.composeModel({ volumeName, repository: 'acme/app', files: resolved.files, project: PROJECT }));
  }

  it('prints the merged model of all profiles, and the policy allows it', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the model runs in the batch helper as the owner of the repository (was: a
    // per-step run without the Docker socket and network).
    const output = await model(['compose.yml']);
    if ('error' in output) throw new Error(output.error);
    log.info(`Compose ${output.version}, dollarEscaped ${output.dollarEscaped}, model ${JSON.stringify(output.model)}`);
    expect(isSupportedComposeVersion(output.version)).toBe(true);
    expect(output.model.name).toBe(PROJECT);
    expect(Object.keys(output.model.services).sort()).toEqual(['app', 'db', 'tools']);
    // Interpolated from the .env of the project folder.
    expect(output.model.services.db.image).toBe(TEST_BASE_IMAGE);
    // review round 19, S19-1: changed expectation, the model holds the texts that Compose uses (unescaped), whatever
    // Compose prints.
    expect(output.model.services.app.environment).toMatchObject({ LITERAL: 'a$b' });
    expect(output.model.volumes?.pgdata).toMatchObject({ name: `${PROJECT}_pgdata` });
    expect(output.dockerfiles).toEqual({ app: `FROM ${TEST_BASE_IMAGE}\n` });
    expect(output.realPaths[`${REPO}/init.sql`]).toBe(`${REPO}/init.sql`);
    const report = composeAccessReport({
      model: output.model,
      devService: 'app',
      project: PROJECT,
      repositoryFolder: REPO,
      ownVolume: volumeName,
      engineApiVersion: apiVersion,
      realPaths: output.realPaths,
      environment: { id: ENVIRONMENT_ID, ownerId: '1001' },
    });
    log.info(`Engine API ${apiVersion}: ${JSON.stringify(report)}`);
    const subpath = Number(apiVersion.split('.')[1]) >= 45;
    expect(report).toEqual({ hostAccess: [], unsupported: subpath ? [] : [`service db: bind mount ${REPO}/init.sql → /init.sql (needs Docker Engine 26 or newer)`] });
  });

  it('records the real path of a build context that links out of the repository, and the policy refuses it (review round 1, S1)', async () => {
    const files = { [`${REPO}/.devcontainer/linked.yml`]: 'services:\n  linked:\n    build:\n      context: ../ctx\n    command: sleep infinity\n' };
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image.
    const written = await runInVolume(docker, volumeName, ['node', '-e', WRITE_FILES_SCRIPT], JSON.stringify(files));
    expect(written.exitCode, written.stderr).toBe(0);
    const linked = await runInVolume(docker, volumeName, ['sh', '-c', `ln -sfn /workspaces/.devenv+ ${REPO}/ctx`]);
    expect(linked.exitCode, linked.stderr).toBe(0);
    const output = await model(['compose.yml', 'linked.yml']);
    if ('error' in output) throw new Error(output.error);
    expect(output.realPaths[`${REPO}/ctx`]).toBe('/workspaces/.devenv+');
    // The Dockerfile behind the link is not read (the folder with the token is hidden in the model run anyway).
    expect(output.dockerfiles.linked).toBeUndefined();
    expect(output.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    const input = {
      model: output.model,
      devService: 'app',
      project: PROJECT,
      repositoryFolder: REPO,
      ownVolume: volumeName,
      engineApiVersion: '1.45',
      realPaths: output.realPaths,
      dockerfiles: output.dockerfiles,
      environment: { id: ENVIRONMENT_ID, ownerId: '1001' },
    };
    const item = `service linked: build context ${REPO}/ctx (a link to /workspaces/.devenv+, outside of the repository)`;
    expect(composeAccessReport(input).hostAccess).toContain(item);
    // Whatever the switch says.
    expect(composeAccessReport(input, false).hostAccess).toContain(item);
  });

  it('reads a dockerfile_inline and a bind mount source with a literal $ as Compose uses them (review round 19, S19-1)', async () => {
    const files = {
      [`${REPO}/.devcontainer/dollar.yml`]: `services:\n  side:\n    build:\n      context: ..\n      dockerfile_inline: |\n        ARG X=${TEST_BASE_IMAGE}\n        FROM $$X\n    volumes:\n      - ../$$data:/data\n`,
      [`${REPO}/$data/x`]: 'x\n',
    };
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image.
    const written = await runInVolume(docker, volumeName, ['node', '-e', WRITE_FILES_SCRIPT], JSON.stringify(files));
    expect(written.exitCode, written.stderr).toBe(0);
    const output = await model(['compose.yml', 'dollar.yml']);
    if ('error' in output) throw new Error(output.error);
    log.info(`Compose ${output.version}, dollarEscaped ${output.dollarEscaped}, side ${JSON.stringify(output.model.services.side)}`);
    const text = `ARG X=${TEST_BASE_IMAGE}\nFROM $X\n`;
    expect(output.model.services.side.build).toMatchObject({ dockerfile_inline: text });
    expect(output.dockerfiles.side).toBe(text);
    expect(output.model.services.side.volumes).toContainEqual(expect.objectContaining({ type: 'bind', source: `${REPO}/$data`, target: '/data' }));
    expect(output.realPaths[`${REPO}/$data`]).toBe(`${REPO}/$data`);
    // Our rewrite, read again by Compose, names the same folder.
    const { model: rewritten } = composeUpModel(output.model, {
      project: PROJECT,
      devService: 'app',
      environmentId: ENVIRONMENT_ID,
      containerName: CONTAINER_NAME,
      volumeName,
      repositoryFolder: REPO,
      engineApiVersion: '1.45',
      realPaths: output.realPaths,
      image: IMAGE,
    });
    const script = `mkdir -p /tmp/m && cat > /tmp/m/compose.json && docker compose -p ${PROJECT} -f /tmp/m/compose.json --profile '*' config --format json`;
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the check is a plain container of the helper image.
    const result = await runInVolume(docker, volumeName, ['sh', '-c', script], JSON.stringify(rewritten));
    expect(result.exitCode, result.stderr).toBe(0);
    const again = JSON.parse(result.stdout) as Record<string, Record<string, Record<string, unknown>>>;
    expect(again.services.side.volumes).toContainEqual(
      expect.objectContaining({ volume: expect.objectContaining({ subpath: output.dollarEscaped ? 'app/$$data' : 'app/$data' }) }),
    );
  });

  it('reads the labels and the containers of a network, and leaves out a missing one (review round 1, S2)', async () => {
    const network = `devenv-test-backend-${run.runId}`;
    cli.ok(['network', 'create', '--label', 'com.docker.compose.project=devenv-11111111', '--label', `${TEST_RUN_LABEL}=${run.runId}`, network]);
    const container = cli.ok(['create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--label', 'nimblescape.devenv.environment-id=other', '--network', network, TEST_BASE_IMAGE, 'true']);
    try {
      // Plan step 11I2: the inspect by the Docker CLI of the test harness, read as the pipeline reads it (toNetworkInfo), in
      // place of inspectNetworks of the removed CLI adapter ContainerAdapter, which did the same (a missing network is left out).
      expect(cli.run(['network', 'inspect', `devenv-test-missing-${run.runId}`]).code).not.toBe(0);
      const networks = (JSON.parse(cli.ok(['network', 'inspect', network])) as unknown[]).map(toNetworkInfo).filter((info) => info !== undefined);
      expect(networks).toHaveLength(1);
      expect(networks[0]).toMatchObject({ name: network, labels: expect.objectContaining({ 'com.docker.compose.project': 'devenv-11111111' }) });
      // A created container is attached only once it runs; the labels decide here.
      log.info(`Containers of ${network}: ${JSON.stringify(networks[0].containers)}`);
    } finally {
      cli.run(['rm', '-f', container]);
      cli.run(['network', 'rm', network]);
    }
  });

  it('hides the configuration folder with the token from the files of the repository', async () => {
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed arrangement: the model runs as the owner of the repository with the
    // configuration folder closed (root's, 0700) during the step (was: an empty tmpfs over it in a per-step run), so the
    // repository gets a user other than root, as after the ownership fix of an open (a repository of root gets no such
    // isolation: the known limitation, docs/implementation-notes.md §17).
    const owned = await runInVolume(docker, volumeName, ['chown', '-R', '1000:1000', REPO]);
    expect(owned.exitCode, owned.stderr).toBe(0);
    const output = await model(['compose.yml', 'token.yml']);
    expect('error' in output).toBe(true);
    expect(JSON.stringify(output)).not.toContain(DUMMY_TOKEN);
  });

  it('reads our rewrite of its own output again with the same values (D-1)', async () => {
    const output = await model(['compose.yml']);
    if ('error' in output) throw new Error(output.error);
    const { model: rewritten } = composeUpModel(output.model, {
      project: PROJECT,
      devService: 'app',
      environmentId: ENVIRONMENT_ID,
      containerName: CONTAINER_NAME,
      volumeName,
      repositoryFolder: REPO,
      // Only `config` reads the model (no container starts), so the rewrite of repository files is read also on an
      // engine before Docker Engine 26.
      engineApiVersion: '1.45',
      realPaths: output.realPaths,
      image: IMAGE,
    });
    const script = `mkdir -p /tmp/m && cat > /tmp/m/compose.json && docker compose -p ${PROJECT} -f /tmp/m/compose.json --profile '*' config --format json`;
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the check is a plain container of the helper image.
    const result = await runInVolume(docker, volumeName, ['sh', '-c', script], JSON.stringify(rewritten));
    expect(result.exitCode, result.stderr).toBe(0);
    const again = JSON.parse(result.stdout) as Record<string, Record<string, Record<string, unknown>>>;
    log.info(`Model read again: ${JSON.stringify(again)}`);
    expect(again.services.app.environment).toMatchObject({ LITERAL: output.dollarEscaped ? 'a$$b' : 'a$b' });
    // User decisions 2026-10-03: the environment image `<resourceName>:<n>`.
    expect(again.services.app.image).toBe(IMAGE);
    expect(again.services.db.ports).toEqual([expect.objectContaining({ target: 5432, host_ip: '127.0.0.1' })]);
    expect(again.volumes.pgdata).toMatchObject({ name: `${PROJECT}_pgdata`, external: true });
    expect(again.services.db.volumes).toContainEqual(
      expect.objectContaining({ type: 'volume', source: 'devenv-workspace', target: '/init.sql', volume: expect.objectContaining({ subpath: 'app/init.sql' }) }),
    );
  });
});
