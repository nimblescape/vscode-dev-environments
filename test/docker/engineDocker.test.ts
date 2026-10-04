// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3: the Docker of the pipeline over the Engine API (EngineDocker on the port of engineClient.ts) answers
// as ContainerAdapter answers over the Docker CLI, against the real engine of the runner: the same objects, asked both
// ways. Also what only the API way does: the labels of an image by a commit, and a container run to its end.
import * as crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID, newEnvironmentId } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { EngineDocker } from '../../src/core/worker/engineDocker';
import { engineApi, engineHijack } from '../../src/helperChannel/engineApi';
import { dockerEngine } from '../../src/helperChannel/engineClient';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { dockerTestContext } from './harness';

describe('the Docker of the pipeline over the Engine API (plan step 11B3)', () => {
  const { run, env, cli, log } = dockerTestContext('engineDocker');
  const runLabel = `${TEST_RUN_LABEL}=${run.runId}`;
  const cliDocker = new ContainerAdapter(new NodeProcessRunner(), run.dockerPath, env, log);
  const socket = helperDockerSocket(env, process.platform);
  const apiDocker = new EngineDocker(dockerEngine(engineApi(socket), engineHijack(socket)), log);
  const id = newEnvironmentId();
  const tag = crypto.randomBytes(4).toString('hex');
  const name = `devenv-test-engine-${tag}`;
  const image = `devenv-test-engine-${tag}:1`;

  beforeAll(() => {
    cli.ok(['volume', 'create', '--label', runLabel, '--label', `${LABEL_ENVIRONMENT_ID}=${id}`, name]);
    cli.ok(['tag', TEST_BASE_IMAGE, image]);
    const common = ['--network', 'none', '--init', '--label', runLabel, '--label', `${LABEL_ENVIRONMENT_ID}=${id}`];
    cli.ok(['run', '-d', '--name', name, ...common, '--mount', `type=volume,source=${name},target=/workspaces`, TEST_BASE_IMAGE, 'sleep', '600']);
    cli.ok(['create', '--name', `${name}-db-1`, ...common, '--label', `${LABEL_COMPOSE_SERVICE}=db`, TEST_BASE_IMAGE, 'sleep', '600']);
  });

  afterAll(() => {
    removeRunObjects(cli, run.runId);
    cli.run(['image', 'rm', '-f', image]);
  });

  it('answers the reads as the Docker CLI does', async () => {
    const [cliContainer, apiContainer] = [await cliDocker.findContainer(id, name), await apiDocker.findContainer(id, name)];
    expect(apiContainer).toEqual(cliContainer);
    expect(apiContainer).toMatchObject({ name, state: 'running', volumes: [name] });
    const byId = (list: { id: string }[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId((await apiDocker.listEnvironmentContainers()).filter((c) => c.labels[LABEL_ENVIRONMENT_ID] === id))).toEqual(
      byId((await cliDocker.listEnvironmentContainers()).filter((c) => c.labels[LABEL_ENVIRONMENT_ID] === id)),
    );
    expect(await apiDocker.containerState(`${name}-db-1`)).toBe(await cliDocker.containerState(`${name}-db-1`));
    expect(await apiDocker.containerState('devenv-test-missing')).toBe('missing');
    expect(await apiDocker.inspectVolumes([name, 'devenv-test-missing'])).toEqual(await cliDocker.inspectVolumes([name, 'devenv-test-missing']));
    expect([await apiDocker.volumeExists(name), await apiDocker.volumeExists('devenv-test-missing')]).toEqual([true, false]);
    expect(await apiDocker.imageId(image)).toBe(await cliDocker.imageId(image));
    expect(await apiDocker.imageNames(image)).toEqual(await cliDocker.imageNames(image));
    expect(await apiDocker.imageLabels(image)).toEqual(await cliDocker.imageLabels(image));
    expect(await apiDocker.imageConfig(image)).toEqual(await cliDocker.imageConfig(image));
    expect(await apiDocker.listImageTags(`devenv-test-engine-${tag}`)).toEqual(await cliDocker.listImageTags(`devenv-test-engine-${tag}`));
    const references = [image, 'devenv-test-missing:1', 'Not A Reference'];
    expect(await apiDocker.inspectImageNames(references)).toEqual(await cliDocker.inspectImageNames(references));
    expect((await apiDocker.inspectImageNames(references)).images.map((found) => found.id)).toEqual([await cliDocker.imageId(image)]);
    expect(await apiDocker.engineApiVersion()).toBe(await cliDocker.engineApiVersion());
    expect(await apiDocker.isRunning()).toBe(true);
  });

  it('labels an image without a build: the labels are there, the configuration is kept, the image runs', async () => {
    const before = cli.image(image)!;
    await apiDocker.labelImage(image, { [LABEL_ENVIRONMENT_ID]: id, 'nimblescape.devenv.test': 'yes' });
    const after = cli.image(image)!;
    expect(after.Id).not.toBe(before.Id);
    expect(after.Config.Labels).toMatchObject({ [LABEL_ENVIRONMENT_ID]: id, 'nimblescape.devenv.test': 'yes' });
    expect(cli.ok(['run', '--rm', '--network', 'none', image, 'echo', 'labelled'])).toBe('labelled');
    // No container of the commit is left.
    expect(cli.lines(['ps', '-a', '--filter', `ancestor=${image}`, '--format', '{{.ID}}'])).toEqual([]);
  });

  it('runs a container on the volume to its end and removes it; a failure names its output', async () => {
    const labels = { [TEST_RUN_LABEL]: run.runId, 'nimblescape.devenv.test-run': tag };
    await apiDocker.runOnVolume({ image: TEST_BASE_IMAGE, volume: name, target: '/w', entrypoint: 'sh', args: ['-c', 'echo done > /w/run-marker'], user: 'root', labels });
    expect(cli.ok(['exec', name, 'cat', '/workspaces/run-marker'])).toBe('done');
    await expect(
      apiDocker.runOnVolume({ image: TEST_BASE_IMAGE, volume: name, target: '/w', entrypoint: 'sh', args: ['-c', 'echo broken >&2; exit 3'], user: 'root', labels }),
    ).rejects.toThrow(/exit code 3: .*broken/);
    expect(await apiDocker.containerIdsWithLabel(`nimblescape.devenv.test-run=${tag}`)).toEqual([]);
  });

  it('stops, renames and removes as the Docker CLI does; a missing container is no failure', async () => {
    await apiDocker.stopContainer(name);
    expect(cli.container(name)?.State.Running).toBe(false);
    await apiDocker.stopContainer('devenv-test-missing');
    await apiDocker.renameContainer(`${name}-db-1`, `${name}-db-2`);
    expect(cli.container(`${name}-db-2`)).toBeDefined();
    await apiDocker.removeContainer(`${name}-db-2`);
    await apiDocker.removeContainer('devenv-test-missing');
    expect(cli.container(`${name}-db-2`)).toBeUndefined();
    // An image in use is not removed, either way; it is an answer, not a failure.
    cli.ok(['create', '--name', `${name}-user`, '--label', runLabel, image, 'true']);
    expect(await apiDocker.removeImage(image)).toBe(false);
    expect(await cliDocker.removeImage(image)).toBe(false);
    cli.ok(['rm', `${name}-user`]);
    expect(await apiDocker.removeImage(image)).toBe(true);
    expect(await apiDocker.removeImage(image)).toBe(false);
  });
});
