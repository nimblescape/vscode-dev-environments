// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (review round 1, missing test 3; section 3b of the plan: the Docker tests drive the flows end to end
// through a real worker): the operation `tokenRemove` through the worker against the real Docker engine of the runner,
// so the port of the engine (engineClient.ts: the exec over a hijacked connection) runs against a real dockerd. The
// extension's side answers with the handler of the extension and the requests that the operation may send.
import * as crypto from 'crypto';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import { WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { HelperChannels, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import { LABEL_HELPER_CHANNEL, OP_STOP, OP_TOKEN_REMOVE, parseStopValue, parseTokenRemoveValue } from '../../src/core/helperChannel/protocol';
import { GITHUB_TOKEN_FILE, LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID, TOKEN_FOLDER, TOKEN_TMPFS, newEnvironmentId } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import type { Environment } from '../../src/core/types';
import { FLOW_REQUESTS, type HostSide } from '../../src/core/worker/hostSide';
import { hostSideHandler } from '../../src/core/worker/hostSideHandler';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { DUMMY_TOKEN, HELPER_DOCKERFILE, dockerTestContext, testStateVolume } from './harness';

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

/** The side of this computer for the flow: only the record of the environment; any other call fails the test. */
function hostWith(remoteUser: string | undefined, requests: string[]): HostSide {
  const refuse = (name: string) => () => {
    requests.push(name);
    throw new Error(`The flow called ${name}.`);
  };
  const deny = (names: string[]) => Object.fromEntries(names.map((name) => [name, refuse(name)]));
  return {
    questions: deny(['confirmUntrustedRepository', 'configurationChanged', 'configurationKindChanged', 'filesMissing', 'recreateContainer', 'message']),
    state: deny(['windowStatuses', 'pendings', 'settings', 'processAlive']),
    secrets: deny(['token', 'registry']),
    connect: deny(['connect']),
    records: {
      ...deny(['read', 'list', 'findForAccount', 'add', 'update', 'remove', 'forgetKeptVolumes', 'sessionFile']),
      get: async (id: string) => {
        requests.push(`get ${id}`);
        return { id, remoteUser } as Environment;
      },
    },
  } as unknown as HostSide;
}

describe('the flows through a real worker (plan step 11B1)', () => {
  const { run, env, cli, log } = dockerTestContext('workerFlows');
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
  let helperTag = '';
  let channels: HelperChannels;

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
            stateVolume: testStateVolume({ run, cli }, 'workerFlows'),
          },
          target,
        ),
    });
  });

  const workerContainers = () => cli.lines(['ps', '-a', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `label=${runLabel}`, '--format', '{{.Names}}']);

  afterAll(async () => {
    channels?.dispose();
    // The worker ends by the end of its input and `--rm` removes it; removing it at the same time fails ("removal of
    // container … is already in progress", found by the CI of PR #91), so wait for that first, as workerRefresh does.
    const deadline = Date.now() + 60_000;
    while (workerContainers().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    const leftovers = workerContainers();
    removeRunObjects(cli, run.runId);
    expect(leftovers).toEqual([]);
  });

  /** A running dev container of a new environment with the tmpfs of the token and a token in it; `args` add rights. */
  function devContainer(args: string[] = []): { id: string; name: string } {
    const id = newEnvironmentId();
    const name = `devenv-test-flow-${crypto.randomBytes(4).toString('hex')}`;
    cli.ok(['run', '-d', '--name', name, '--network', 'none', '--label', runLabel, '--label', `${LABEL_ENVIRONMENT_ID}=${id}`, ...args, '--tmpfs', TOKEN_TMPFS, TEST_BASE_IMAGE, 'sleep', '600']);
    cli.ok(['exec', '-u', 'root', name, 'sh', '-c', `printf %s '${DUMMY_TOKEN}' > ${GITHUB_TOKEN_FILE}`]);
    return { id, name };
  }

  const removal = async (environmentId: string, containerName: string, remoteUser?: string) => {
    const requests: string[] = [];
    const target = await targets.current();
    const value = await channels.flow(target, OP_TOKEN_REMOVE, { environmentId, containerName }, {
      timeoutMs: 60_000,
      onAsk: hostSideHandler(hostWith(remoteUser, requests), log, FLOW_REQUESTS[OP_TOKEN_REMOVE]),
    });
    return { value: parseTokenRemoveValue(value), requests };
  };

  it('empties the token folder of the running dev container through the worker, as root', async () => {
    const { id, name } = devContainer();
    const { value, requests } = await removal(id, name);
    expect(value).toEqual({ outcome: 'removed', container: cli.container(name)!.Id.slice(0, 12) });
    expect(requests).toEqual([]);
    expect(cli.ok(['exec', '-u', 'root', name, 'ls', '-A', TOKEN_FOLDER])).toBe('');
    expect(workerContainers()).toHaveLength(1);
  });

  it('answers notRunning for an environment without a running dev container', async () => {
    const { value, requests } = await removal(newEnvironmentId(), 'devenv-test-flow-missing');
    expect(value).toEqual({ outcome: 'notRunning' });
    expect(requests).toEqual([]);
  });

  // Plan step 11B2: Stop in the worker, under the lock that it takes itself: the Git state as the folder's user, then
  // the dev container and the running service of Docker Compose; no request to this computer.
  it('stops the dev container and its running service through the worker, with the Git state', async () => {
    const id = newEnvironmentId();
    const name = `devenv-test-stop-${crypto.randomBytes(4).toString('hex')}`;
    const common = ['--network', 'none', '--init', '--stop-timeout', '2', '--label', runLabel, '--label', `${LABEL_ENVIRONMENT_ID}=${id}`];
    cli.ok(['run', '-d', '--name', name, ...common, helperTag, 'sleep', '600']);
    cli.ok(['exec', name, 'git', 'init', '-q', '-b', 'feature/stop', '/workspaces/stop']);
    cli.ok(['run', '-d', '--name', `${name}-db-1`, ...common, '--label', `${LABEL_COMPOSE_SERVICE}=db`, TEST_BASE_IMAGE, 'sleep', '600']);
    const requests: string[] = [];
    const value = await channels.flow(
      await targets.current(),
      OP_STOP,
      { environmentId: id, containerName: name, folder: '/workspaces/stop', waitSeconds: 10 },
      { timeoutMs: 120_000, onAsk: hostSideHandler(hostWith(undefined, requests), log, FLOW_REQUESTS[OP_STOP]) },
    );
    expect(parseStopValue(value)).toMatchObject({ outcome: 'stopped', gitSummary: { branch: 'feature/stop', uncommittedFiles: 0 }, services: [`${name}-db-1`] });
    expect(requests).toEqual([]);
    expect(cli.container(name)?.State.Running).toBe(false);
    expect(cli.container(`${name}-db-1`)?.State.Running).toBe(false);
    // Nothing runs any more: a second Stop finds no running container and stops nothing.
    expect(parseStopValue(await channels.flow(await targets.current(), OP_STOP, { environmentId: id, containerName: name, folder: '/workspaces/stop', waitSeconds: 10 }, { timeoutMs: 60_000 }))).toEqual({
      outcome: 'notRunning',
      services: [],
    });
  });
});

