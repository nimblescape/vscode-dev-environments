// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: the environment lock with the real workers (two HelperChannels, as two windows or computers) on the
// real Docker engine of the runner, with a state volume of the test. Checked: a second lock is busy while the first is
// held; after a hard kill of the first worker, the kernel freed the lock and the second takes it; two Deletes of the
// same environment at the same time give exactly one winner, and the other removes nothing (user decision D3); no
// worker container is left over.
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import { inProcessAnalyzer } from '../../src/core/helper/configurationAnalysis';
import { WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { HelperChannels, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import { LABEL_HELPER_CHANNEL } from '../../src/core/helperChannel/protocol';
import { ImageChecker } from '../../src/core/imageCheck/imageCheck';
import { LABEL_ENVIRONMENT_ID, LABEL_REPOSITORY, newEnvironmentId, resourceName } from '../../src/core/names';
import { EnvironmentService, PipelineTexts } from '../../src/core/pipeline/environmentService';
import { isoTime, systemClock } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { StoragePaths } from '../../src/core/storage/paths';
import { EnvironmentRegistry } from '../../src/core/storage/registry';
import { SessionFiles } from '../../src/core/storage/sessionFiles';
import type { ExtensionSettings } from '../../src/core/types';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { FakeUi, HELPER_DOCKERFILE, RecordingProgress, TEST_ACCOUNT, dockerTestContext, fakeAuth, registryClient, registryTransport, testStateVolume } from './harness';

const REPOSITORY = 'devenv-test/worker-lock';
/** Short waits for the test (the service asks for ENVIRONMENT_LOCK_WAIT_SECONDS, 10 s). */
const TEST_WAIT_SECONDS = 1;

const settings: ExtensionSettings = {
  reopenLastOnStartup: true,
  stopOnClose: true,
  waitingTimeSeconds: 30,
  updateImagesOnConnect: false,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: false,
  refreshIntervalMinutes: 60,
  hostAccessChecksOff: [],
};

async function bundleScript(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../../src/helperChannel/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    minify: true,
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('the environment lock with real workers (plan step 5, PR B)', () => {
  const context = dockerTestContext('workerLock');
  const { run, env, cli, log } = context;
  const runner = new NodeProcessRunner();
  const docker = new ContainerAdapter(runner, run.dockerPath, env, log);
  const targets = new DockerTargets(docker, env, log);
  const helper = new WorkspaceHelper({
    docker,
    logger: log,
    dockerfilePath: HELPER_DOCKERFILE,
    env,
    engine: async () => {
      const target = await targets.current();
      return { key: target.host, endpoint: target.endpoint };
    },
  });
  let script = '';
  let helperTag = '';
  const allChannels: HelperChannels[] = [];

  /** The worker containers of this run. */
  const workerContainers = () =>
    cli.lines(['ps', '-a', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`, '--format', '{{.Names}}']);

  /** The workers of one window (as extension.ts), with the state volume of the test; `names` gets their container names. */
  function windowChannels(names: string[] = []): HelperChannels {
    const channels = new HelperChannels({
      logger: log,
      open: (target) =>
        openHelperChannel(
          {
            start: (args) => {
              const all = [...args];
              all.splice(all.indexOf(helperTag), 0, '--label', `${TEST_RUN_LABEL}=${run.runId}`);
              names.push(all[all.indexOf('--name') + 1]);
              return docker.start(all);
            },
            runDirect: (args, options) => docker.runDirect(args, options),
            logger: log,
            script: async () => script,
            helperTag: async () => helperTag,
            socketPath: async () => helperDockerSocket(env, process.platform, target.endpoint),
            stateVolume: testStateVolume(context, 'workerLock'),
          },
          target,
        ),
    });
    allChannels.push(channels);
    return channels;
  }

  /** The service of one window or computer: its own registry, its own workers. */
  function windowService(name: string, channels: HelperChannels): { service: EnvironmentService; registry: EnvironmentRegistry } {
    const paths = new StoragePaths(path.join(run.runDir, `worker-lock-${name}`));
    paths.ensureDirectoriesSync();
    const registry = new EnvironmentRegistry(paths, systemClock, { logger: log });
    const sessionFiles = new SessionFiles(paths);
    const service = new EnvironmentService({
      analyzer: inProcessAnalyzer,
      docker,
      runner,
      helper,
      registry,
      sessionFiles,
      imageChecker: new ImageChecker(registryClient(registryTransport, runner, env, log), log),
      auth: fakeAuth,
      ui: new FakeUi(),
      logger: log,
      clock: systemClock,
      platform: process.platform,
      env,
      owner: { windowId: `docker-test-worker-lock-${name}`, pid: process.pid },
      settings: () => settings,
      windowStatuses: () => sessionFiles.readWindowStatuses(),
      dockerTarget: () => targets.current(),
      // As extension.ts, with the short wait of the test.
      environmentLock: async (environmentId, _waitSeconds, signal) => channels.lock(await targets.current(), environmentId, TEST_WAIT_SECONDS, signal),
    });
    return { service, registry };
  }

  beforeAll(async () => {
    script = await bundleScript();
    helperTag = await helper.ensureImage();
  });

  afterAll(async () => {
    for (const channels of allChannels) channels.dispose();
    let leftovers: string[] = [];
    try {
      await waitUntil(() => workerContainers().length === 0, 'the removal of the worker containers');
    } catch {
      leftovers = workerContainers();
    }
    removeRunObjects(cli, run.runId);
    expect(leftovers).toEqual([]);
  });

  it('a second lock is busy while the first is held; after a hard kill of the first worker the second takes it', async () => {
    const target = await targets.current();
    const firstNames: string[] = [];
    const first = windowChannels(firstNames);
    const second = windowChannels();
    const id = newEnvironmentId();

    const held = await first.lock(target, id, TEST_WAIT_SECONDS);
    const startedAt = Date.now();
    await expect(second.lock(target, id, TEST_WAIT_SECONDS)).rejects.toMatchObject({ name: 'EnvironmentLockError', kind: 'busy' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(TEST_WAIT_SECONDS * 1000 - 100);

    // A hard kill of the container of the first worker: nothing lets go of the lock but the kernel.
    expect(firstNames).toHaveLength(1);
    cli.ok(['kill', '--signal', 'KILL', firstNames[0]]);
    const reason = await Promise.race([held.lost, new Promise<string>((resolve) => setTimeout(() => resolve('not lost'), 60_000))]);
    expect(reason).not.toBe('not lost');
    const taken = await second.lock(target, id, 10);
    expect(taken.environmentId).toBe(id);
    await taken.release();
    // Released: the first window takes it again with a new worker.
    const again = await first.lock(target, id, TEST_WAIT_SECONDS);
    await again.release();
  });

  it('two Deletes of the same environment at the same time: exactly one winner, the other removes nothing', async () => {
    const target = await targets.current();
    expect(target.kind).toBe('local');
    const channelsA = windowChannels();
    const channelsB = windowChannels();
    // Both workers are opened first, so that the Deletes race for the lock and not for the open of a worker.
    expect(await channelsA.get(target)).toBeDefined();
    expect(await channelsB.get(target)).toBeDefined();
    const a = windowService('a', channelsA);
    const b = windowService('b', channelsB);
    const environmentId = newEnvironmentId();
    const name = resourceName(REPOSITORY, environmentId);
    cli.ok(['volume', 'create', '--label', `${LABEL_ENVIRONMENT_ID}=${environmentId}`, '--label', `${LABEL_REPOSITORY}=${REPOSITORY}`, '--label', `${TEST_RUN_LABEL}=${run.runId}`, name]);
    // `sleep` as process 1 ignores SIGTERM: the stop of the winner takes its stop time, while it holds the lock.
    cli.ok([
      'run', '-d', '--stop-timeout', '5', '--name', name,
      '--label', `${LABEL_ENVIRONMENT_ID}=${environmentId}`, '--label', `${TEST_RUN_LABEL}=${run.runId}`,
      '--mount', `type=volume,source=${name},target=/workspaces`,
      TEST_BASE_IMAGE, 'sleep', '3600',
    ]);
    const now = isoTime(systemClock);
    const entry = {
      id: environmentId,
      repository: REPOSITORY,
      configPath: '.devcontainer/devcontainer.json',
      volumeName: name,
      containerName: name,
      createdAt: now,
      lastUsedAt: now,
      owner: TEST_ACCOUNT,
      dockerHost: '',
    };
    await a.registry.add({ ...entry });
    await b.registry.add({ ...entry });

    const outcomes = await Promise.allSettled(
      [a, b].map(({ service }) => targets.withOperation(() => service.delete(environmentId, { progress: new RecordingProgress(), additionalVolumesToRemove: [] }))),
    );
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0].reason as Error).message).toBe(PipelineTexts.environmentLockBusy(REPOSITORY));
    // The winner removed everything; the entry of the other stays, without its busy mark.
    expect(cli.container(name)).toBeUndefined();
    expect(cli.volume(name)).toBeUndefined();
    const winner = outcomes[0].status === 'fulfilled' ? a : b;
    const loser = winner === a ? b : a;
    expect(await winner.registry.get(environmentId)).toBeUndefined();
    const kept = await loser.registry.get(environmentId);
    expect(kept?.id).toBe(environmentId);
    expect(kept?.busy).toBeUndefined();
  });
});
