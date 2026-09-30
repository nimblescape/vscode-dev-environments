// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR A: Stop and Delete of a seeded environment through the real EnvironmentService with the worker (the
// helper channel) as the router of the ContainerAdapter, against the real Docker engine of the runner (the local
// Docker). Checked: the plain Docker calls went through the worker, and only calls that are not routable (plus the one
// direct engine identity call of the open) ran directly; the container and the volume are gone; no worker container is
// left over after the channels were disposed.
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { isRoutableDockerCall } from '../../src/core/docker/dockerRouting';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import { inProcessAnalyzer } from '../../src/core/helper/configurationAnalysis';
import { WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { HelperChannels, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import { ENGINE_IDENTITY_ARGS, LABEL_HELPER_CHANNEL } from '../../src/core/helperChannel/protocol';
import { ImageChecker } from '../../src/core/imageCheck/imageCheck';
import { LABEL_ENVIRONMENT_ID, LABEL_REPOSITORY, newEnvironmentId, resourceName } from '../../src/core/names';
import { EnvironmentService } from '../../src/core/pipeline/environmentService';
import { isoTime, systemClock, type ProcessRunner, type RunOptions, type RunResult, type StartOptions, type StartedProcess } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { StoragePaths } from '../../src/core/storage/paths';
import { EnvironmentRegistry } from '../../src/core/storage/registry';
import { SessionFiles } from '../../src/core/storage/sessionFiles';
import type { ExtensionSettings } from '../../src/core/types';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { FakeUi, HELPER_DOCKERFILE, RecordingProgress, TEST_ACCOUNT, dockerTestContext, fakeAuth, registryClient, registryTransport, testStateVolume } from './harness';

const REPOSITORY = 'devenv-test/worker-routing';

const settings: ExtensionSettings = {
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

/** The runner of the adapter: records every Docker call that runs directly (the spy). */
class SpyRunner implements ProcessRunner {
  readonly calls: { args: string[]; options: RunOptions }[] = [];
  constructor(private readonly inner: NodeProcessRunner) {}
  run(file: string, args: readonly string[], options?: RunOptions): Promise<RunResult> {
    this.calls.push({ args: [...args], options: options ?? {} });
    return this.inner.run(file, args, options);
  }
  start(file: string, args: readonly string[], options?: StartOptions): StartedProcess {
    return this.inner.start(file, args, options);
  }
}

describe('Stop and Delete through the worker (plan step 5, PR A)', () => {
  const { run, env, cli, log } = dockerTestContext('workerRouting');
  const runner = new NodeProcessRunner();
  const spy = new SpyRunner(runner);
  const docker = new ContainerAdapter(spy, run.dockerPath, env, log);
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
  const paths = new StoragePaths(path.join(run.runDir, 'worker-routing-storage'));
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
    owner: { windowId: 'docker-test-worker-routing', pid: process.pid },
    settings: () => settings,
    windowStatuses: () => sessionFiles.readWindowStatuses(),
    dockerTarget: () => targets.current(),
    // Plan step 5, PR B (D1: no unlocked path): the real lock of the worker, as extension.ts. Under it the plain calls go
    // through the worker that holds the lock (not the router); they are recorded as routed too.
    environmentLock: async (environmentId, waitSeconds, signal) => {
      const lock = await channels.lock(await targets.current(), environmentId, waitSeconds, signal);
      return {
        environmentId: lock.environmentId,
        lost: lock.lost,
        release: () => lock.release(),
        docker: async (args, options) => {
          const result = await lock.docker(args, options);
          routed.push([...args]);
          return result;
        },
      };
    },
  });
  const environmentId = newEnvironmentId();
  const name = resourceName(REPOSITORY, environmentId);
  let script = '';
  let helperTag = '';
  /** The direct calls of the opens of the worker (the engine identity), which are not calls of the service. */
  const openCalls: string[] = [];
  const routed: string[][] = [];
  let channels: HelperChannels;

  /** The worker containers of this run (the label of the run is added to each, as the helper channel test does). */
  const workerContainers = () =>
    cli.lines(['ps', '-a', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`, '--format', '{{.Names}}']);

  beforeAll(async () => {
    paths.ensureDirectoriesSync();
    script = await bundleScript();
    helperTag = await helper.ensureImage();
    // As extension.ts: the real openHelperChannel deps, with the socket of the workspace helper of the local Docker.
    channels = new HelperChannels({
      logger: log,
      open: (target) =>
        openHelperChannel(
          {
            start: (args) => {
              const all = [...args];
              all.splice(all.indexOf(helperTag), 0, '--label', `${TEST_RUN_LABEL}=${run.runId}`);
              return docker.start(all);
            },
            runDirect: (args, options) => {
              openCalls.push(JSON.stringify(args));
              return docker.runDirect(args, options);
            },
            logger: log,
            script: async () => script,
            helperTag: async () => helperTag,
            socketPath: async () => helperDockerSocket(env, process.platform, target.endpoint),
            // Plan step 5, PR B: the lock files in a volume of the test, never the one of the Session Monitor.
            stateVolume: testStateVolume({ run, cli }, 'workerRouting'),
          },
          target,
        ),
    });
    docker.setRouter(async (target, args, options) => {
      const result = await channels.docker(target, args, options);
      if (result !== undefined) routed.push([...args]);
      return result;
    });
  });

  afterAll(async () => {
    docker.setRouter(undefined);
    channels?.dispose();
    // The worker ends by the end of its input and `--rm` removes it.
    let leftovers: string[] = [];
    try {
      await waitUntil(() => workerContainers().length === 0, 'the removal of the worker container');
    } catch {
      leftovers = workerContainers();
    }
    removeRunObjects(cli, run.runId);
    expect(leftovers).toEqual([]);
    expect(cli.container(name)).toBeUndefined();
    expect(cli.volume(name)).toBeUndefined();
  });

  it('stops and deletes a seeded environment with its plain Docker calls through the worker', async () => {
    const target = await targets.current();
    expect(target.kind).toBe('local');
    // The worker is opened first, so that no call waits for its opening and takes the direct way meanwhile.
    expect(await channels.get(target)).toBeDefined();
    expect(openCalls).toEqual([JSON.stringify(ENGINE_IDENTITY_ARGS)]);
    expect(workerContainers()).toHaveLength(1);

    // The seeded environment: its volume, its running container (with an init, so that the stop is quick), its entry.
    cli.ok(['volume', 'create', '--label', `${LABEL_ENVIRONMENT_ID}=${environmentId}`, '--label', `${LABEL_REPOSITORY}=${REPOSITORY}`, '--label', `${TEST_RUN_LABEL}=${run.runId}`, name]);
    cli.ok([
      'run', '-d', '--init', '--name', name,
      '--label', `${LABEL_ENVIRONMENT_ID}=${environmentId}`, '--label', `${TEST_RUN_LABEL}=${run.runId}`,
      '--mount', `type=volume,source=${name},target=/workspaces`,
      TEST_BASE_IMAGE, 'sleep', '3600',
    ]);
    const now = isoTime(systemClock);
    await registry.add({
      id: environmentId,
      repository: REPOSITORY,
      configPath: '.devcontainer/devcontainer.json',
      volumeName: name,
      containerName: name,
      createdAt: now,
      lastUsedAt: now,
      owner: TEST_ACCOUNT,
      dockerHost: '',
    });
    expect(cli.container(name)?.State.Running).toBe(true);
    spy.calls.length = 0;

    await targets.withOperation(() => service.stop(environmentId));
    expect(cli.container(name)?.State.Running).toBe(false);
    expect(routed.some((args) => args[0] === 'stop')).toBe(true);

    await targets.withOperation(() => service.delete(environmentId, { progress: new RecordingProgress(), additionalVolumesToRemove: [] }));
    expect(cli.container(name)).toBeUndefined();
    expect(cli.volume(name)).toBeUndefined();
    expect(await registry.get(environmentId)).toBeUndefined();
    expect(routed.some((args) => args[0] === 'rm')).toBe(true);
    expect(routed.some((args) => args[0] === 'volume' && args[1] === 'rm')).toBe(true);

    // The spy: every call that ran directly is one that is not routable (the adapter adds its environment to each
    // direct call, so the check leaves `env` out), apart from the engine identity of a reopened worker.
    const direct = spy.calls
      .filter(({ args }) => !(openCalls.includes(JSON.stringify(args)) && JSON.stringify(args) === JSON.stringify(ENGINE_IDENTITY_ARGS)))
      .filter(({ args, options }) => isRoutableDockerCall(args, { ...options, env: undefined }));
    expect(direct.map(({ args }) => args.join(' '))).toEqual([]);
    log.info(`Routed through the worker: ${routed.map((args) => args.slice(0, 2).join(' ')).join(', ')}`);
    log.info(`Direct: ${spy.calls.map(({ args }) => args.slice(0, 2).join(' ')).join(', ')}`);
    // Still one worker; the calls did not open another.
    expect(workerContainers()).toHaveLength(1);
  });
});
