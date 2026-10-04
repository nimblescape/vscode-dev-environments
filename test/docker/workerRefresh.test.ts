// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR C: the refresh of the sidebar in one operation of the worker (the helper channel) against the real
// Docker engine of the runner, compared with the same refresh without the worker. The environments: one running from the
// helper image with a Git repository on a branch, one stopped with a volume without the labels (found by its name), one
// with nothing, and one running whose branch is not asked for. No worker container is left over.
import * as path from 'path';
import * as esbuild from 'esbuild';
import { monitorScriptPlugin } from '../../scripts/monitorScript.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import { WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { HelperChannels, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import { LABEL_HELPER_CHANNEL } from '../../src/core/helperChannel/protocol';
import { LABEL_ENVIRONMENT_ID, newEnvironmentId } from '../../src/core/names';
import { readEnvironmentStates, type StateEnvironment } from '../../src/core/pipeline/refreshStates';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { HELPER_DOCKERFILE, dockerTestContext, testStateVolume } from './harness';

async function bundleScript(): Promise<string> {
  const result = await esbuild.build({
    // Plan step 11B3b: the compile-time constants of esbuild.mjs (the worker now bundles the workspace helper).
    define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) },
    // Plan step 11D2: the script of the Session Monitor in the worker, as esbuild.mjs bundles it.
    plugins: [monitorScriptPlugin(path.resolve(__dirname, '../..'), { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) })],
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

describe('the refresh through the worker (plan step 5, PR C)', () => {
  const { run, env, cli, log } = dockerTestContext('workerRefresh');
  const docker = new ContainerAdapter(new NodeProcessRunner(), run.dockerPath, env, log);
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
  const runLabel = `${TEST_RUN_LABEL}=${run.runId}`;
  const names = { git: `devenv-refresh-git-${run.runId}`, stopped: `devenv-refresh-stopped-${run.runId}`, none: `devenv-refresh-none-${run.runId}`, other: `devenv-refresh-other-${run.runId}` };
  const environments: StateEnvironment[] = [
    { id: newEnvironmentId(), containerName: names.git, volumeName: names.git, user: 'root', folder: '/workspaces/refresh', branch: true },
    { id: newEnvironmentId(), containerName: names.stopped, volumeName: names.stopped, folder: '/workspaces/refresh', branch: true },
    { id: newEnvironmentId(), containerName: names.none, volumeName: names.none, folder: '/workspaces/refresh', branch: true },
    { id: newEnvironmentId(), containerName: names.other, volumeName: names.other, folder: '/workspaces/refresh', branch: false },
  ];
  let helperTag = '';
  let channels: HelperChannels;

  const workerContainers = () =>
    cli.lines(['ps', '-a', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `label=${runLabel}`, '--format', '{{.Names}}']);

  beforeAll(async () => {
    const script = await bundleScript();
    helperTag = await helper.ensureImage();
    channels = new HelperChannels({
      logger: log,
      open: (target) =>
        openHelperChannel(
          {
            start: (args) => {
              const all = [...args];
              all.splice(all.indexOf(helperTag), 0, '--label', runLabel);
              return docker.start(all);
            },
            runDirect: (args, options) => docker.runDirect(args, options),
            logger: log,
            script: async () => script,
            helperTag: async () => helperTag,
            socketPath: async () => helperDockerSocket(env, process.platform, target.endpoint),
            // Plan step 5, PR B: the lock files in a volume of the test, never the one of the Session Monitor.
            stateVolume: testStateVolume({ run, cli }, 'workerRefresh'),
          },
          target,
        ),
    });
    const [git, stopped, , other] = environments;
    // Running from the helper image, with a labelled volume and a Git repository on a branch.
    cli.ok(['volume', 'create', '--label', `${LABEL_ENVIRONMENT_ID}=${git.id}`, '--label', runLabel, names.git]);
    cli.ok([
      'run', '-d', '--name', names.git, '--label', `${LABEL_ENVIRONMENT_ID}=${git.id}`, '--label', runLabel,
      '--mount', `type=volume,source=${names.git},target=/workspaces`, helperTag, 'sleep', '3600',
    ]);
    cli.ok(['exec', names.git, 'git', 'init', '-q', '-b', 'feature/refresh', '/workspaces/refresh']);
    // Stopped (created, never started), with a volume without the labels of the extension.
    cli.ok(['volume', 'create', '--label', runLabel, names.stopped]);
    cli.ok([
      'create', '--name', names.stopped, '--label', `${LABEL_ENVIRONMENT_ID}=${stopped.id}`, '--label', runLabel,
      '--mount', `type=volume,source=${names.stopped},target=/workspaces`, TEST_BASE_IMAGE, 'sleep', '3600',
    ]);
    // Running, but its branch is not asked for (an environment of another account).
    cli.ok(['volume', 'create', '--label', `${LABEL_ENVIRONMENT_ID}=${other.id}`, '--label', runLabel, names.other]);
    cli.ok(['run', '-d', '--init', '--name', names.other, '--label', `${LABEL_ENVIRONMENT_ID}=${other.id}`, '--label', runLabel, TEST_BASE_IMAGE, 'sleep', '3600']);
  });

  afterAll(async () => {
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
  });

  it('gives the same states and branches through the worker as without it, and changes nothing', async () => {
    const target = await targets.current();
    expect(target.kind).toBe('local');
    expect(await channels.get(target)).toBeDefined();
    const before = cli.lines(['ps', '-a', '--filter', `label=${runLabel}`, '--format', '{{.Names}} {{.State}}']).sort();

    const viaWorker = await channels.refresh(target, environments);
    const direct = await readEnvironmentStates(docker, environments);
    expect(viaWorker).toBeDefined();
    expect(viaWorker).toEqual(direct);
    const [git, stopped, none, other] = environments;
    expect(direct.runtime).toEqual(
      new Map([
        [git.id, { container: 'running', volume: true }],
        [stopped.id, { container: 'stopped', volume: true }],
        [none.id, { container: 'missing', volume: false }],
        [other.id, { container: 'running', volume: true }],
      ]),
    );
    expect(direct.branches).toEqual(new Map([[git.id, 'feature/refresh']]));

    // It only read: the same containers in the same states.
    expect(cli.lines(['ps', '-a', '--filter', `label=${runLabel}`, '--format', '{{.Names}} {{.State}}']).sort()).toEqual(before);
    expect(workerContainers()).toHaveLength(1);
  });
});
