// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3: the Docker of the pipeline over the Engine API (EngineDocker on the port of engineClient.ts) answers
// as the Docker CLI answers, against the real engine of the runner: the same objects, asked both ways. Plan step 11I2:
// the CLI side is the Docker CLI of the test harness (`docker inspect` and friends, read with the pipeline's reading of
// the inspect JSON, dockerObjects.ts) instead of the removed CLI adapter ContainerAdapter, which read it the same way.
// Also what only the API way does: the labels of an image by a commit, and (plan step 11G1) the read of a file of an
// image without running anything. Plan step 11I (PR A): and what the probe and the sweep of the worker read and do over
// the port (the version, the identity of the engine, the prune), against what the Docker CLI reports.
import * as crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { ENGINE_IDENTITY_ARGS, engineIdentity } from '../../src/core/helperChannel/protocol';
import { mapContainerState, publicInfo, toContainerInfo, toLabels, toVolumeInfo, type ContainerInfo, type ListedContainer } from '../../src/core/docker/dockerObjects';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID, newEnvironmentId } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { EngineDocker } from '../../src/core/worker/engineDocker';
import { engineApi, engineHijack } from '../../src/helperChannel/engineApi';
import { dockerEngine } from '../../src/helperChannel/engineClient';
import { commitsInProcesses } from '../../src/remoteMonitor/backgroundRules';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { dockerTestContext } from './harness';

describe('the Docker of the pipeline over the Engine API (plan step 11B3)', () => {
  const { run, env, cli, log } = dockerTestContext('engineDocker');
  const runLabel = `${TEST_RUN_LABEL}=${run.runId}`;
  // Plan step 11I2: the Docker CLI of the extension (BootstrapDocker) for the one call that it still has (removeImage).
  const cliDocker = new BootstrapDocker(new NodeProcessRunner(), run.dockerPath, env, log);
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

  /** Plan step 11I2: a container as the Docker CLI describes it (`docker container inspect`), read as the pipeline reads it. */
  const cliContainer = (reference: string): ContainerInfo | undefined => {
    const inspected = toContainerInfo((JSON.parse(cli.ok(['container', 'inspect', reference])) as unknown[])[0]);
    return inspected === undefined ? undefined : publicInfo(inspected);
  };

  /**
   * Plan step 11I (U4, decision of 2026-10-08): a container of a list of the pipeline as the Docker CLI describes it: its
   * public shape and the time of its create (ListedContainer).
   */
  const cliListed = (reference: string): ListedContainer | undefined => {
    const inspected = toContainerInfo((JSON.parse(cli.ok(['container', 'inspect', reference])) as unknown[])[0]);
    return inspected === undefined ? undefined : { ...publicInfo(inspected), ...(inspected.created !== '' ? { created: inspected.created } : {}) };
  };

  // Plan step 11I2: changed expectation (before: each answer of EngineDocker equal to the answer of the removed CLI
  // adapter ContainerAdapter): each answer equal to what the Docker CLI of the test harness reports for the same object,
  // read with the same functions as the adapter read it (dockerObjects.ts) or as it read the CLI's answer.
  it('answers the reads as the Docker CLI does', async () => {
    const apiContainer = await apiDocker.findContainer(id, name);
    expect(apiContainer).toEqual(cliContainer(name));
    expect(apiContainer).toMatchObject({ name, state: 'running', volumes: [name] });
    const byId = (list: { id: string }[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    const listed = cli.lines(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL_ENVIRONMENT_ID}=${id}`]);
    expect(listed).toHaveLength(2);
    // Plan step 11I (U4, decision of 2026-10-08): changed expectation, each listed container with the time of its create
    // (before: its public shape only), the list of one environment (environmentContainers) the same.
    expect(byId((await apiDocker.listEnvironmentContainers()).filter((c) => c.labels[LABEL_ENVIRONMENT_ID] === id))).toEqual(byId(listed.map((listedId) => cliListed(listedId)!)));
    expect(byId(await apiDocker.environmentContainers(id))).toEqual(byId(listed.map((listedId) => cliListed(listedId)!)));
    expect(await apiDocker.containerState(`${name}-db-1`)).toBe(mapContainerState(cli.container(`${name}-db-1`)!.State.Status));
    expect(await apiDocker.containerState(`${name}-db-1`)).toBe('stopped');
    expect(await apiDocker.containerState('devenv-test-missing')).toBe('missing');
    expect(await apiDocker.inspectVolumes([name, 'devenv-test-missing'])).toEqual([toVolumeInfo(cli.volume(name))]);
    expect([await apiDocker.volumeExists(name), await apiDocker.volumeExists('devenv-test-missing')]).toEqual([true, false]);
    const details = cli.image(image)!;
    expect(await apiDocker.imageId(image)).toBe(details.Id);
    expect(await apiDocker.imageNames(image)).toEqual({ repoTags: details.RepoTags ?? [], repoDigests: details.RepoDigests ?? [] });
    expect(await apiDocker.imageLabels(image)).toEqual(toLabels(details.Config.Labels));
    expect(await apiDocker.imageConfig(image)).toEqual(JSON.parse(cli.ok(['image', 'inspect', '--format', '{{json .Config}}', image])));
    // The tags of exactly this repository, sorted by tag, numbers numerically (as listImageTags sorts them).
    const repository = `devenv-test-engine-${tag}`;
    const tags = cli
      .lines(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', repository])
      .filter((reference) => reference.startsWith(`${repository}:`) && !reference.endsWith(':<none>'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    expect(tags).toContain(image);
    expect(await apiDocker.listImageTags(repository)).toEqual([...new Set(tags)]);
    const references = [image, 'devenv-test-missing:1', 'Not A Reference'];
    // As the Docker CLI answers about each reference: a missing image is left out; a reference that the CLI refuses as such
    // (an invalid reference, as the removed adapter classified the CLI's answer) is `invalid`.
    expect(cli.run(['image', 'inspect', 'devenv-test-missing:1']).err).toMatch(/no such image/i);
    const refused = cli.run(['image', 'inspect', 'Not A Reference']);
    expect(refused.code).not.toBe(0);
    // Review round 1 of PR #120 (A-L1): the engine refuses it as a reference (400, both image stores), so it is always
    // `invalid` (was: whatever the removed adapter answered; a missing image is the case above).
    expect(refused.err).toMatch(/invalid reference|reference format/i);
    const unchecked = [{ reference: 'Not A Reference', reason: 'invalid' }];
    expect(await apiDocker.inspectImageNames(references)).toEqual({
      images: [{ id: details.Id, repoTags: details.RepoTags ?? [], repoDigests: details.RepoDigests ?? [] }],
      unchecked,
    });
    expect(await apiDocker.engineApiVersion()).toBe(cli.ok(['version', '--format', '{{.Server.APIVersion}}']));
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
    // Plan step 11I2: changed arrangement (before: the exec of the removed CLI adapter ContainerAdapter on the CLI side):
    // the same `docker exec` by the Docker CLI of the test harness, with the same expectations on both sides.
    const viaCli = (args: string[]) => {
      const result = cli.run(['exec', ...args]);
      return { exitCode: result.code, stdout: result.out, stderr: result.err };
    };
    for (const unknownUser of [viaCli(['-u', 'nobody2', target, 'id']), await apiDocker.exec(target, ['id'], { user: 'nobody2' })]) {
      expect(unknownUser.exitCode).not.toBe(0);
      expect(unknownUser.stdout + unknownUser.stderr).toMatch(/nobody2/);
    }
    cli.ok(['stop', '-t', '0', target]);
    for (const stopped of [viaCli([target, 'id']), await apiDocker.exec(target, ['id'])]) {
      expect(stopped.exitCode).not.toBe(0);
      expect(stopped.stderr).toMatch(/is not running/);
    }
  });

  // Plan step 11I (PR A): the requests of the probe and the sweep of the worker (before: its own Docker CLI): the version
  // and the identity of the engine as the Docker CLI reports them (the identity as values, as the open compares them),
  // and the prune of the stopped containers of filters: never a running one, never one younger than `until`.
  it('plan step 11I (PR A): the version, the identity and the prune of the probe and the sweep, as the Docker CLI sees them', async () => {
    const engine = dockerEngine(engineApi(socket), engineHijack(socket));
    expect((await engine.version()).version).toBe(cli.ok(['version', '--format', '{{.Server.Version}}']));
    const identity = await engine.identity();
    expect(identity.id).not.toBe('');
    expect(identity).toEqual(engineIdentity(cli.ok([...ENGINE_IDENTITY_ARGS])));
    // A label of this test alone, so that no prune here reaches another container of the run or of the user.
    const pruneLabel = `devenv-test.prune=${tag}`;
    // Plan step 11I (U5, decision of 2026-10-08): a label key that `label!` names, as the sweep names the label of the
    // Session Monitor (SWEEP_FILTERS).
    const guardKey = `devenv-test.guard-${tag}`;
    const stopped = cli.ok(['create', '--name', `${name}-prune-stopped`, '--label', runLabel, '--label', pruneLabel, TEST_BASE_IMAGE, 'true']);
    const guarded = cli.ok(['create', '--name', `${name}-prune-guarded`, '--label', runLabel, '--label', pruneLabel, '--label', `${guardKey}=1`, TEST_BASE_IMAGE, 'true']);
    cli.ok(['run', '-d', '--name', `${name}-prune-running`, '--network', 'none', '--init', '--label', runLabel, '--label', pruneLabel, TEST_BASE_IMAGE, 'sleep', '600']);
    try {
      // Both are younger than 10 minutes, the age of the sweep (SWEEP_MIN_AGE): it keeps them.
      // Review round 1 of PR #122 (A, L2): the engine runs one prune at a time (the sweep of a channel of an earlier
      // test may still run): a refusal for that reason is tried again.
      const prune = async (filters: Record<string, string[]>): Promise<string[]> => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await engine.pruneContainers(filters);
          } catch (error) {
            if (attempt >= 10 || !(error instanceof Error) || !error.message.includes('a prune operation is already running')) throw error;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      };
      expect(await prune({ label: [pruneLabel], until: ['10m'] })).toEqual([]);
      expect(cli.container(`${name}-prune-stopped`)).toBeDefined();
      // Without the age: only the stopped one goes, named by its full ID. Plan step 11I (U5, decision of 2026-10-08):
      // changed input, with `label!` as the sweep sends it: the stopped one with that label stays as well.
      expect(await prune({ label: [pruneLabel], 'label!': [guardKey] })).toEqual([stopped]);
      expect(cli.container(`${name}-prune-stopped`)).toBeUndefined();
      expect(cli.container(`${name}-prune-running`)?.State.Running).toBe(true);
      expect(cli.container(`${name}-prune-guarded`)).toBeDefined();
      // Plan step 11I (U5): without `label!`, that one goes too.
      expect(await prune({ label: [pruneLabel] })).toEqual([guarded]);
      expect(cli.container(`${name}-prune-running`)?.State.Running).toBe(true);
    } finally {
      cli.run(['rm', '-f', `${name}-prune-stopped`, `${name}-prune-guarded`, `${name}-prune-running`]);
    }
  });

  // Review round 2 of 11H2 (reviewer A, A2-L3): what the cleanup of the shared VS Code server store reads of a real engine
  // (review round 1, A-M2): the running and paused containers that mount the store volume (containerIds with the volume
  // and the states, as serversInUse asks), and their processes (`GET /containers/<id>/top`) in the shape that the parse
  // takes, with the commit that a process names; a stopped container is not listed and has no processes. The 40-hex
  // path is in the command line of `sh` around `sleep` (the `sleep` of Alpine's BusyBox refuses an argument that is no
  // number). Everything is removed afterwards, and checked to be gone.
  it('review round 2 of 11H2 (A2-L3): the containers that mount a volume, running or paused, and their processes', async () => {
    const engine = dockerEngine(engineApi(socket), engineHijack(socket));
    const commit = crypto.randomBytes(20).toString('hex');
    const volume = `${name}-store`;
    const names = { running: `${name}-top-running`, paused: `${name}-top-paused`, stopped: `${name}-top-stopped` };
    cli.ok(['volume', 'create', '--label', runLabel, volume]);
    try {
      const ids: Record<keyof typeof names, string> = { running: '', paused: '', stopped: '' };
      const mount = `type=volume,source=${volume},target=/opt/devenv/vscode,readonly`;
      for (const key of Object.keys(names) as Array<keyof typeof names>) {
        ids[key] = cli.ok(['run', '-d', '--name', names[key], '--network', 'none', '--init', '--label', runLabel, '--mount', mount, TEST_BASE_IMAGE, 'sh', '-c', `sleep 600; : /x/${commit}/node`]);
      }
      cli.ok(['pause', names.paused]);
      cli.ok(['stop', '-t', '0', names.stopped]);
      // CI of #136: the stopped container was once still listed as running right after `docker stop`; wait for its exit.
      cli.ok(['wait', names.stopped]);
      const listed = await engine.containerIds({ volume: [volume], status: ['running', 'paused'] }, AbortSignal.timeout(60_000));
      expect([...listed].sort()).toEqual([ids.running, ids.paused].sort());
      for (const key of ['running', 'paused'] as const) {
        const processes = await engine.processes(ids[key], AbortSignal.timeout(60_000));
        expect(processes, key).toBeDefined();
        expect(processes!.every((row) => Array.isArray(row) && row.every((field) => typeof field === 'string')), key).toBe(true);
        expect([...commitsInProcesses(processes!)], key).toEqual([commit]);
      }
      expect(await engine.processes(ids.stopped, AbortSignal.timeout(60_000))).toBeUndefined();
      expect(await engine.processes('devenv-test-missing', AbortSignal.timeout(60_000))).toBeUndefined();
    } finally {
      cli.run(['rm', '-f', names.running, names.paused, names.stopped]);
      cli.run(['volume', 'rm', volume]);
    }
    // No container or volume of this test is left.
    expect(cli.lines(['ps', '-aq', '--filter', `volume=${volume}`])).toEqual([]);
    for (const leftover of Object.values(names)) expect(cli.container(leftover), leftover).toBeUndefined();
    expect(cli.lines(['volume', 'ls', '-q']).filter((entry) => entry === volume)).toEqual([]);
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
