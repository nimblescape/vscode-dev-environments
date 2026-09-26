// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The model run of a Docker Compose configuration (implementation notes, section "Docker Compose") in the real workspace
// helper: `docker compose config` without the Docker socket and without network (L-12), all profiles, the `.env` of the
// project, the `$` probe, the configuration folder with the token hidden, and whether Compose reads our rewrite of its
// own output again with the same values (L-6, D-1). The open, stop, and delete of a Compose environment are tested with
// the pipeline (compose.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { composeUpModel, isSupportedComposeVersion, resolveComposeFiles, type ComposeModelOutput } from '../../src/core/helper/compose';
import { composeAccessReport } from '../../src/core/helper/composeAccess';
import { WorkspaceHelper } from '../../src/core/helper/workspaceHelper';
import { composeProjectName } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { DUMMY_TOKEN, HELPER_DOCKERFILE, dockerTestContext } from './harness';

const ENVIRONMENT_ID = 'c0ffee00-0000-4000-8000-000000000000';
const PROJECT = composeProjectName(ENVIRONMENT_ID);
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
  const docker = new ContainerAdapter(new NodeProcessRunner(), run.dockerPath, env, log);
  const helper = new WorkspaceHelper({ docker, logger: log, dockerfilePath: HELPER_DOCKERFILE, env });
  const volumeName = `devenv-test-compose-${run.runId}`;
  let apiVersion: string;

  beforeAll(async () => {
    await helper.ensureImage();
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
    const result = await helper.run(volumeName, ['node', '-e', WRITE_FILES_SCRIPT], { input: JSON.stringify(files), docker: false, network: false });
    expect(result.exitCode, result.stderr).toBe(0);
  });

  afterAll(() => {
    removeRunObjects(cli, run.runId);
    expect(cli.volume(volumeName)).toBeUndefined();
  });

  async function model(names: string[]): Promise<ComposeModelOutput | { error: string }> {
    const resolved = resolveComposeFiles('.devcontainer/devcontainer.json', 'app', names);
    if (!('files' in resolved)) throw new Error(resolved.problem);
    return helper.composeModel({ volumeName, repository: 'acme/app', files: resolved.files, project: PROJECT });
  }

  it('prints the merged model of all profiles without the Docker socket and network, and the policy allows it', async () => {
    const output = await model(['compose.yml']);
    if ('error' in output) throw new Error(output.error);
    log.info(`Compose ${output.version}, dollarEscaped ${output.dollarEscaped}, model ${JSON.stringify(output.model)}`);
    expect(isSupportedComposeVersion(output.version)).toBe(true);
    expect(output.model.name).toBe(PROJECT);
    expect(Object.keys(output.model.services).sort()).toEqual(['app', 'db', 'tools']);
    // Interpolated from the .env of the project folder.
    expect(output.model.services.db.image).toBe(TEST_BASE_IMAGE);
    expect(output.model.services.app.environment).toMatchObject({ LITERAL: output.dollarEscaped ? 'a$$b' : 'a$b' });
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
      environment: { id: ENVIRONMENT_ID },
    });
    log.info(`Engine API ${apiVersion}: ${JSON.stringify(report)}`);
    const subpath = Number(apiVersion.split('.')[1]) >= 45;
    expect(report).toEqual({ hostAccess: [], unsupported: subpath ? [] : [`service db: bind mount ${REPO}/init.sql → /init.sql (needs Docker Engine 26 or newer)`] });
  });

  it('records the real path of a build context that links out of the repository, and the policy refuses it (review round 1, S1)', async () => {
    const files = { [`${REPO}/.devcontainer/linked.yml`]: 'services:\n  linked:\n    build:\n      context: ../ctx\n    command: sleep infinity\n' };
    const written = await helper.run(volumeName, ['node', '-e', WRITE_FILES_SCRIPT], { input: JSON.stringify(files), docker: false, network: false });
    expect(written.exitCode, written.stderr).toBe(0);
    const linked = await helper.run(volumeName, ['sh', '-c', `ln -sfn /workspaces/.devenv+ ${REPO}/ctx`], { docker: false, network: false });
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
      environment: { id: ENVIRONMENT_ID },
    };
    const item = `service linked: build context ${REPO}/ctx (a link to /workspaces/.devenv+, outside of the repository)`;
    expect(composeAccessReport(input).hostAccess).toContain(item);
    // Whatever the switch says.
    expect(composeAccessReport(input, false).hostAccess).toContain(item);
  });

  it('reads the labels and the containers of a network, and leaves out a missing one (review round 1, S2)', async () => {
    const network = `devenv-test-backend-${run.runId}`;
    cli.ok(['network', 'create', '--label', 'com.docker.compose.project=devenv-11111111', '--label', `${TEST_RUN_LABEL}=${run.runId}`, network]);
    const container = cli.ok(['create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--label', 'devenv.environment-id=other', '--network', network, TEST_BASE_IMAGE, 'true']);
    try {
      const networks = await docker.inspectNetworks([network, `devenv-test-missing-${run.runId}`]);
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
      containerName: 'devenv-test-compose-app',
      volumeName,
      repositoryFolder: REPO,
      dollarEscaped: output.dollarEscaped,
      // Only `config` reads the model (no container starts), so the rewrite of repository files is read also on an
      // engine before Docker Engine 26.
      engineApiVersion: '1.45',
      realPaths: output.realPaths,
      image: 'devenv-c0ffee00:1',
    });
    const script = `mkdir -p /tmp/m && cat > /tmp/m/compose.json && docker compose -p ${PROJECT} -f /tmp/m/compose.json --profile '*' config --format json`;
    const result = await helper.run(volumeName, ['sh', '-c', script], { input: JSON.stringify(rewritten), docker: false, network: false });
    expect(result.exitCode, result.stderr).toBe(0);
    const again = JSON.parse(result.stdout) as Record<string, Record<string, Record<string, unknown>>>;
    log.info(`Model read again: ${JSON.stringify(again)}`);
    expect(again.services.app.environment).toMatchObject({ LITERAL: output.dollarEscaped ? 'a$$b' : 'a$b' });
    expect(again.services.app.image).toBe('devenv-c0ffee00:1');
    expect(again.services.db.ports).toEqual([expect.objectContaining({ target: 5432, host_ip: '127.0.0.1' })]);
    expect(again.volumes.pgdata).toMatchObject({ name: `${PROJECT}_pgdata`, external: true });
    expect(again.services.db.volumes).toContainEqual(
      expect.objectContaining({ type: 'volume', source: 'devenv-workspace', target: '/init.sql', volume: expect.objectContaining({ subpath: 'app/init.sql' }) }),
    );
  });
});
