// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3: the Docker of the pipeline over the Engine API (EngineDocker on the port of engineClient.ts) answers
// as ContainerAdapter answers over the Docker CLI, against the real engine of the runner: the same objects, asked both
// ways. Also what only the API way does: the labels of an image by a commit, and (plan step 11G1) the read of a file of
// an image without running anything.
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
  const withVolume = `devenv-test-engine-${tag}:volume`;

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
    cli.run(['image', 'rm', '-f', withVolume]);
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

  // Plan step 11G1: replaces the test of runOnVolume (a container run to its end on the volume), which the read of
  // /etc/passwd through the archive endpoint replaced.
  it('plan step 11G1: reads the IDs of a user from /etc/passwd of an image without running anything, and leaves no container', async () => {
    // The IDs that `id -u` and `id -g` print in a container of the image.
    const uid = cli.ok(['run', '--rm', '--network', 'none', TEST_BASE_IMAGE, 'id', '-u', 'nobody']);
    const gid = cli.ok(['run', '--rm', '--network', 'none', TEST_BASE_IMAGE, 'id', '-g', 'nobody']);
    const containersBefore = new Set(cli.lines(['ps', '-aq', '--no-trunc']));
    expect(await apiDocker.imageUserIds(TEST_BASE_IMAGE, 'root')).toEqual({ uid: '0', gid: '0' });
    expect(await apiDocker.imageUserIds(TEST_BASE_IMAGE, '0')).toEqual({ uid: '0', gid: '0' });
    expect(await apiDocker.imageUserIds(TEST_BASE_IMAGE, 'nobody')).toEqual({ uid, gid });
    expect(await apiDocker.imageUserIds(TEST_BASE_IMAGE, 'devenv-no-such-user')).toBeUndefined();
    // A path that does not exist is unknown, not a failure; a missing image is a failure.
    const engine = dockerEngine(engineApi(socket), engineHijack(socket));
    expect(await engine.imageFile(TEST_BASE_IMAGE, '/etc/devenv-missing')).toBeUndefined();
    // A folder is no regular file (any base image has /etc).
    expect(await engine.imageFile(TEST_BASE_IMAGE, '/etc')).toBeUndefined();
    await expect(apiDocker.imageUserIds('devenv-test-missing:1', 'root')).rejects.toThrow();
    // No container of the reads is left.
    expect(cli.lines(['ps', '-aq', '--no-trunc']).filter((id) => !containersBefore.has(id))).toEqual([]);
    expect(cli.lines(['ps', '-aq', '--filter', 'name=devenv-read-'])).toEqual([]);
  });

  it('leaves no anonymous volume of an image with `VOLUME` behind (review round 1 of 11B3a, A-R1-1)', async () => {
    cli.ok(['create', '--name', `${name}-base`, '--label', runLabel, TEST_BASE_IMAGE, 'true']);
    cli.ok(['commit', '--change', 'VOLUME /data', `${name}-base`, withVolume]);
    cli.ok(['rm', `${name}-base`]);
    const anonymous = (): Set<string> => new Set(cli.lines(['volume', 'ls', '-q', '--filter', 'dangling=true']).filter((volume) => /^[0-9a-f]{64}$/.test(volume)));
    const before = anonymous();
    // Plan step 11G1: changed expectation, the read of /etc/passwd (its container is created from the image) in place of
    // runOnVolume; the checks of the named volume of the workspace went with runOnVolume, which mounted it.
    expect(await apiDocker.imageUserIds(withVolume, 'root')).toEqual({ uid: '0', gid: '0' });
    await apiDocker.labelImage(withVolume, { 'nimblescape.devenv.test': 'yes' });
    expect([...anonymous()].filter((volume) => !before.has(volume))).toEqual([]);
  });

  it('exec: a refusal of the engine is a result, over the API as over the Docker CLI (review round 1 of 11B3a, A-R1-3)', async () => {
    const target = `${name}-exec`;
    cli.ok(['run', '-d', '--name', target, '--network', 'none', '--init', '--label', runLabel, TEST_BASE_IMAGE, 'sleep', '600']);
    for (const docker of [cliDocker, apiDocker]) {
      const unknownUser = await docker.exec(target, ['id'], { user: 'nobody2' });
      expect(unknownUser.exitCode).not.toBe(0);
      expect(unknownUser.stdout + unknownUser.stderr).toMatch(/nobody2/);
    }
    cli.ok(['stop', '-t', '0', target]);
    for (const docker of [cliDocker, apiDocker]) {
      const stopped = await docker.exec(target, ['id']);
      expect(stopped.exitCode).not.toBe(0);
      expect(stopped.stderr).toMatch(/is not running/);
    }
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
