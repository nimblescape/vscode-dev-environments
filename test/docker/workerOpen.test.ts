// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E6 (section 3b of the plan: the Docker tests drive the flows end to end through a real worker): the open of a
// seeded environment as the extension sends it (EnvironmentService.openEnvironmentInWorker, extensionFlow and the
// extension's HostSide over a real registry and real session files) to a real worker, whose own pipeline builds the
// image, runs `up` and the lifecycle commands in its batch helper, writes the token, makes sure that the Session Monitor
// runs, and records the open through the requests of the operation. The window would connect with the answer (A1).
// The test makes sure of the Session Monitor of the engine (devenv-session-monitor); it is skipped where one exists before
// the tests (a monitor of the user is never touched), and removes the one it made.
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import { inProcessAnalyzer } from '../../src/core/helper/configurationAnalysis';
import { helperImageTag } from '../../src/core/helper/helperImage';
import { monitorImageTag } from '../../src/core/helper/helperState';
import { WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { ImageChecker } from '../../src/core/imageCheck/imageCheck';
import { GITHUB_TOKEN_FILE, LABEL_ENVIRONMENT_ID, LABEL_REPOSITORY, newEnvironmentId, resourceName } from '../../src/core/names';
import { EnvironmentService } from '../../src/core/pipeline/environmentService';
import { windowLifecycleMemory } from '../../src/core/pipeline/lifecycleMemory';
import { isoTime, systemClock } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { REMOTE_MONITOR_CONTAINER, REMOTE_MONITOR_VOLUME } from '../../src/core/remoteMonitor/protocol';
import { StoragePaths } from '../../src/core/storage/paths';
import { EnvironmentRegistry } from '../../src/core/storage/registry';
import { SessionFiles } from '../../src/core/storage/sessionFiles';
import type { ExtensionSettings } from '../../src/core/types';
import { extensionFlow, extensionHostSide } from '../../src/vscode/hostSide';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, readBaseline, removeRunObjects } from './dockerRun';
import { FakeUi, HELPER_DOCKERFILE, RecordingProgress, TEST_ACCOUNT, dockerTestContext, fakeAuth, offlineTransport, registryClient, runInVolume } from './harness';
import { workerLocks } from './workerLocks';

const REPOSITORY = 'devenv-test/worker-open';
const FOLDER = '/workspaces/worker-open';
const CONFIG_PATH = '.devcontainer/devcontainer.json';
const REMOTE_USER = 'dev';
const SOURCE = '0123456789abcdef0123456789abcdef';
const CREATED_LOG = '/tmp/devenv-post-create';

/** Creates the repository in the volume as the helper creates a clone: as root, on the branch main, with one commit. */
const SEED_SCRIPT = `set -eu
mkdir -p "$1/.devcontainer"
printf '%s\\n' "$2" > "$1/.devcontainer/devcontainer.json"
printf '%s\\n' "$3" > "$1/.devcontainer/Dockerfile"
cd "$1"
git init -q -b main
git add -A
git -c user.name=Test -c user.email=test@example.invalid commit -q -m 'Initial commit'
`;

const settings: ExtensionSettings = {
  reopenLastOnStartup: true,
  stopOnClose: true,
  waitingTimeSeconds: 30,
  // No registry question: the open builds from the base image that the engine has or pulls.
  updateImagesOnConnect: false,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: false,
  refreshIntervalMinutes: 60,
  hostAccessChecksOff: [],
};

describe('the open through a real worker (plan step 11E6)', () => {
  const { run, env, cli, log } = dockerTestContext('workerOpen');
  const runner = new NodeProcessRunner();
  const docker = new ContainerAdapter(runner, run.dockerPath, env, log);
  const helper = new WorkspaceHelper({ docker, logger: log, dockerfilePath: HELPER_DOCKERFILE, env });
  const paths = new StoragePaths(path.join(run.runDir, 'worker-open-storage'));
  const registry = new EnvironmentRegistry(paths, systemClock, { logger: log });
  const sessionFiles = new SessionFiles(paths);
  const ui = new FakeUi();
  const owner = { windowId: 'docker-test-window', pid: process.pid };
  const targets = new DockerTargets(docker, env, log);
  const locks = workerLocks({ run, cli, log }, docker, targets, 'workerOpen', async (target) => helperDockerSocket(env, process.platform, target.endpoint));
  const memory = windowLifecycleMemory();
  // The extension's side of the requests, as extension.ts wires it.
  const flow = extensionFlow(
    locks.channels,
    () => targets.current(),
    extensionHostSide({
      registry,
      sessionFiles,
      ui,
      auth: fakeAuth,
      credentials: { getForPull: async () => undefined },
      settings: () => settings,
      windowId: owner.windowId,
      pid: owner.pid,
      clock: systemClock,
      isProcessAlive: (pid) => pid === process.pid,
      lifecycleMemory: memory,
      logger: log,
    }),
    log,
  );
  const service = new EnvironmentService({
    analyzer: inProcessAnalyzer,
    environmentLock: locks.take,
    flow,
    workerRefresh: (environments) => locks.refresh(environments),
    docker,
    runner,
    helper,
    registry,
    sessionFiles,
    imageChecker: new ImageChecker(registryClient(offlineTransport, runner, env, log), log),
    auth: fakeAuth,
    ui,
    logger: log,
    clock: systemClock,
    platform: process.platform,
    env,
    owner,
    settings: () => settings,
    windowStatuses: () => sessionFiles.readWindowStatuses(),
    lifecycleMemory: memory,
    // The Docker engine of the tests runs; nothing to start here.
    startDocker: async () => {},
    monitorSource: () => SOURCE,
    openMonitor: () => ({ images: { prefixes: [], schedule: '7 6 * * *', timeZone: 'UTC' }, listSent: () => {} }),
  });

  const environmentId = newEnvironmentId();
  const volumeName = resourceName(REPOSITORY, environmentId);
  const containerName = volumeName;
  const helperTag = helperImageTag(fs.readFileSync(HELPER_DOCKERFILE, 'utf8'));
  // A Session Monitor of the user (or of another run) is never touched: the test is skipped then.
  const baseline = readBaseline(run);
  const monitorOfUser = baseline.containers.some((container) => container.name === REMOTE_MONITOR_CONTAINER) || baseline.volumes.includes(REMOTE_MONITOR_VOLUME);

  function execIn(user: string, script: string): { code: number | null; out: string } {
    const result = cli.run(['exec', '-u', user, containerName, 'sh', '-c', script]);
    return { code: result.code, out: result.out.trim() };
  }

  beforeAll(async () => {
    if (monitorOfUser) {
      log.info(`The engine has a Session Monitor (${REMOTE_MONITOR_CONTAINER}) before the tests; the open through a real worker is skipped.`);
      return;
    }
    await helper.ensureImage();
    paths.ensureDirectoriesSync();
    const devcontainerJson = JSON.stringify(
      {
        name: 'Worker open',
        build: { dockerfile: 'Dockerfile' },
        remoteUser: REMOTE_USER,
        // The containers of the run carry the label of the run, so the cleanup finds them.
        runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`],
        postCreateCommand: `echo created >> ${CREATED_LOG}`,
      },
      null,
      2,
    );
    const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, 'RUN apk add --no-cache git && adduser -D dev', `LABEL ${TEST_RUN_LABEL}=${run.runId}`].join('\n');
    await docker.createVolume(volumeName, { [LABEL_ENVIRONMENT_ID]: environmentId, [LABEL_REPOSITORY]: REPOSITORY, [TEST_RUN_LABEL]: run.runId });
    const seeded = await runInVolume(docker, volumeName, ['sh', '-c', SEED_SCRIPT, 'sh', FOLDER, devcontainerJson, dockerfile]);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id: environmentId, repository: REPOSITORY, configPath: CONFIG_PATH, volumeName, containerName, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
  });

  afterAll(async () => {
    const leftovers = await locks.dispose();
    removeRunObjects(cli, run.runId);
    if (!monitorOfUser) {
      // The Session Monitor that the open made sure of, its state volume and its tag (plan step 11D3).
      cli.run(['rm', '-f', REMOTE_MONITOR_CONTAINER]);
      cli.run(['volume', 'rm', REMOTE_MONITOR_VOLUME]);
      const tag = monitorImageTag(helperTag);
      if (tag !== undefined) cli.run(['image', 'rm', tag]);
    }
    expect(leftovers).toEqual([]);
    expect(cli.container(containerName)).toBeUndefined();
    expect(cli.volume(volumeName)).toBeUndefined();
  });

  it.skipIf(monitorOfUser)('builds, starts and records the environment in the worker; the window gets what it connects with', async () => {
    const progress = new RecordingProgress();
    const result = await service.openEnvironmentInWorker(environmentId, { progress });
    expect(result.containerName).toBe(containerName);
    expect(result.remoteWorkspaceFolder).toBe(FOLDER);
    expect(result.environment).toMatchObject({ id: environmentId, remoteUser: REMOTE_USER, remoteWorkspaceFolder: FOLDER });
    // The records of the open came through the requests: no busy mark is left, the build is recorded, the pending file is written.
    const entry = await registry.get(environmentId);
    expect(entry?.busy).toBeUndefined();
    expect(entry?.buildRecord?.buildNumber).toBe(1);
    expect((await sessionFiles.readPendings()).map((pending) => pending.environmentId)).toEqual([environmentId]);
    // The steps of the worker were the progress of the open.
    expect(progress.steps).toContain('preparing');
    expect(progress.steps).toContain('starting');
    // The container runs with its lifecycle commands done and the token of the operation in its memory.
    expect(cli.container(containerName)?.State.Running).toBe(true);
    expect(execIn(REMOTE_USER, `cat ${CREATED_LOG}`).out).toBe('created');
    expect(execIn('root', `cat ${GITHUB_TOKEN_FILE}`).out).not.toBe('');
    // The Session Monitor of the engine runs (the open made sure of it, D1).
    expect(cli.container(REMOTE_MONITOR_CONTAINER)?.State.Running).toBe(true);
    // The token never reached the log of the window unmasked.
    expect(fs.readFileSync(log.file, 'utf8')).not.toContain('dummy-token-of-the-docker-tests');
  });

  it.skipIf(monitorOfUser)('a second open opens the running container as it is', async () => {
    const id = cli.container(containerName)?.Id;
    const progress = new RecordingProgress();
    await service.openEnvironmentInWorker(environmentId, { progress });
    expect(cli.container(containerName)?.Id).toBe(id);
    expect(progress.steps).not.toContain('preparing');
    expect(execIn(REMOTE_USER, `cat ${CREATED_LOG}`).out).toBe('created');
  });
});
