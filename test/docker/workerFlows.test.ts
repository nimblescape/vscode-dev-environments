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
import { LABEL_HELPER_CHANNEL, OP_DELETE, OP_LIST_CONFIGURATIONS, OP_STOP, OP_TOKEN_REMOVE, OP_WINDOW_STATE, parseDeleteValue, parseListConfigurationsValue, parseStopValue, parseTokenRemoveValue, parseWindowStateValue } from '../../src/core/helperChannel/protocol';
import { GITHUB_TOKEN_FILE, LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID, LABEL_OWNER_ID, TOKEN_FOLDER, TOKEN_TMPFS, newEnvironmentId } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import type { Environment } from '../../src/core/types';
import { FLOW_REQUESTS, type HostSide } from '../../src/core/worker/hostSide';
import { hostSideHandler } from '../../src/core/worker/hostSideHandler';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { DUMMY_TOKEN, HELPER_DOCKERFILE, dockerTestContext, testStateVolume } from './harness';

async function bundleScript(): Promise<string> {
  const result = await esbuild.build({
    // Plan step 11B3b: the compile-time constants of esbuild.mjs (the worker now bundles the workspace helper).
    define: { __DEVCONTAINER_CLI_VERSION__: JSON.stringify(__DEVCONTAINER_CLI_VERSION__) },
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
    expect(parseStopValue(value)).toMatchObject({ outcome: 'stopped', gitSummary: { branch: 'feature/stop', uncommittedFiles: 0 }, services: [`${name}-db-1`], failures: [] });
    expect(requests).toEqual([]);
    expect(cli.container(name)?.State.Running).toBe(false);
    expect(cli.container(`${name}-db-1`)?.State.Running).toBe(false);
    // Nothing runs any more: a second Stop finds no running container and stops nothing.
    expect(parseStopValue(await channels.flow(await targets.current(), OP_STOP, { environmentId: id, containerName: name, folder: '/workspaces/stop', waitSeconds: 10 }, { timeoutMs: 60_000 }))).toEqual({
      outcome: 'notRunning',
      services: [],
      failures: [],
    });
  });

  // Plan step 11C1 (decisions of 2026-10-04): the reads of an attached window by the worker: the state of its dev
  // container, whether it may be used as it is, and its branch; no request to this computer.
  it('reads the state, the version and the branch of a dev container through the worker', async () => {
    const id = newEnvironmentId();
    const name = `devenv-test-window-${crypto.randomBytes(4).toString('hex')}`;
    cli.ok(['run', '-d', '--name', name, '--network', 'none', '--init', '--label', runLabel, '--label', `${LABEL_ENVIRONMENT_ID}=${id}`, helperTag, 'sleep', '600']);
    cli.ok(['exec', name, 'git', 'init', '-q', '-b', 'feature/window', '/workspaces/window']);
    const requests: string[] = [];
    const read = async (containerName: string, branch: boolean) =>
      parseWindowStateValue(
        await channels.flow(
          await targets.current(),
          OP_WINDOW_STATE,
          { environmentId: id, containerName, checks: 'on', ...(branch ? { branch: { folder: '/workspaces/window' } } : {}) },
          { timeoutMs: 60_000, onAsk: hostSideHandler(hostWith(undefined, requests), log, FLOW_REQUESTS[OP_WINDOW_STATE]) },
        ),
      );
    // A container without the version label of the extension is of an older version.
    expect(await read(name, true)).toEqual({ state: 'running', outdated: 'version', branch: 'feature/window' });
    expect(requests).toEqual([]);
    cli.ok(['stop', '-t', '0', name]);
    expect(await read(name, true)).toEqual({ state: 'stopped', outdated: 'version' });
    expect(await read('devenv-test-window-missing', false)).toEqual({ state: 'missing' });
  });

  // Plan step 11B3b (user decision of 2026-10-04): the listing of Select configuration by the worker's own pipeline: the
  // record and the account from this computer, the volume and its labels from the engine, the lock taken in the worker,
  // and the step listConfigs in a batch helper that the worker starts from its own image; it is gone afterwards. A lock
  // held elsewhere is refused as busy after the wait of D3.
  it('lists the configurations through the worker in a batch helper of its own image, and refuses while the lock is held elsewhere', async () => {
    const id = newEnvironmentId();
    const volume = `devenv-test-list-${crypto.randomBytes(4).toString('hex')}`;
    const repository = 'devenv-test/worker-list';
    cli.ok(['volume', 'create', '--label', runLabel, '--label', `${LABEL_ENVIRONMENT_ID}=${id}`, volume]);
    cli.ok([
      'run', '--rm', '--label', runLabel, '--mount', `type=volume,source=${volume},target=/workspaces`, TEST_BASE_IMAGE, 'sh', '-c',
      'mkdir -p /workspaces/worker-list/.devcontainer/python && echo \'{}\' > /workspaces/worker-list/.devcontainer/devcontainer.json && ' +
        "echo '{}' > /workspaces/worker-list/.devcontainer/python/devcontainer.json && chown -R 1000:1000 /workspaces/worker-list",
    ]);
    const requests: string[] = [];
    const environment = { id, repository, owner: { id: '42', login: 'octo' }, volumeName: volume, containerName: volume } as unknown as Environment;
    const host = {
      ...hostWith(undefined, requests),
      records: { ...hostWith(undefined, requests).records, get: async (requested: string) => (requests.push(`get ${requested}`), requested === id ? environment : undefined) },
      state: { ...hostWith(undefined, requests).state, account: async (interactive: boolean) => (requests.push(`account ${interactive}`), { id: '42', login: 'octo' }) },
    } as HostSide;
    const target = await targets.current();
    const list = () =>
      channels.flow(target, OP_LIST_CONFIGURATIONS, { environmentId: id, dockerHost: target.host, owner: { windowId: 'window-1', pid: process.pid } }, {
        timeoutMs: 180_000,
        onAsk: hostSideHandler(host, log, FLOW_REQUESTS[OP_LIST_CONFIGURATIONS]),
      });
    const value = parseListConfigurationsValue(await list());
    expect(value).toEqual({ configPaths: expect.arrayContaining(['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json']) });
    expect((value as { configPaths: string[] }).configPaths[0]).toBe('.devcontainer/devcontainer.json');
    expect(requests).toEqual([`get ${id}`, 'account true']);
    // The batch helper is gone: no container uses the volume any more. (That it runs from the worker's own image ID is
    // checked by the unit test of the operation; review round 1 of 11B3b.)
    expect(cli.lines(['ps', '-a', '--filter', `volume=${volume}`, '--format', '{{.ID}}'])).toEqual([]);
    // A lock held elsewhere: refused as busy (startFailed) after the wait, and nothing ran.
    const held = await channels.lock(target, id, 5);
    try {
      expect(parseListConfigurationsValue(await list())).toMatchObject({ refused: { code: 'startFailed' } });
      // Review round 1 of 11B3b (missing test): no batch helper was started for the refused listing.
      expect(cli.lines(['ps', '-a', '--filter', `volume=${volume}`, '--format', '{{.ID}}'])).toEqual([]);
    } finally {
      await held.release();
    }
  }, 240_000);

  // Plan step 11C2a (decisions of 2026-10-03 and 2026-10-04): the Delete by the worker's own pipeline against the real
  // engine: the busy mark, the entry and the session files of the environment from this computer (each for its
  // environment), the lock in the worker, the dev container and the workspace volume removed over the port of the engine.
  // Review round 1 of 11C2a (A-R1-H1): with an additional volume that the user confirmed.
  it('deletes an environment through the worker: its dev container, its volume and a confirmed additional volume, with the requests of Delete only', async () => {
    const id = newEnvironmentId();
    const name = `devenv-test-delete-${crypto.randomBytes(4).toString('hex')}`;
    const extra = `${name}-cache`;
    const repository = 'devenv-test/worker-delete';
    cli.ok(['volume', 'create', '--label', runLabel, '--label', `${LABEL_ENVIRONMENT_ID}=${id}`, name]);
    cli.ok(['volume', 'create', '--label', runLabel, '--label', `${LABEL_ENVIRONMENT_ID}=${id}`, '--label', `${LABEL_OWNER_ID}=42`, extra]);
    cli.ok(['run', '-d', '--init', '--name', name, '--network', 'none', '--label', runLabel, '--label', `${LABEL_ENVIRONMENT_ID}=${id}`, '--mount', `type=volume,source=${name},target=/workspaces`, TEST_BASE_IMAGE, 'sleep', '600']);
    const requests: string[] = [];
    const environment = { id, repository, owner: { id: '42', login: 'octo' }, volumeName: name, containerName: name, additionalVolumes: [extra] } as unknown as Environment;
    const base = hostWith(undefined, requests);
    const host = {
      ...base,
      records: {
        ...base.records,
        get: async (requested: string) => (requests.push(`get ${requested}`), requested === id ? environment : undefined),
        list: async () => (requests.push('list'), [environment]),
        read: async () => (requests.push('read'), { version: 1, environments: [environment] }),
        markBusy: async (requested: string, operation: string) => (requests.push(`markBusy ${requested} ${operation}`), { environment }),
        clearBusy: async (requested: string) => void requests.push(`clearBusy ${requested}`),
        remove: async (requested: string, volumes: unknown) => void requests.push(`remove ${requested} ${JSON.stringify(volumes)}`),
        sessionFile: async (kind: string, requested: string) => void requests.push(`sessionFile ${kind} ${requested}`),
      },
      state: { ...base.state, account: async (interactive: boolean) => (requests.push(`account ${interactive}`), { id: '42', login: 'octo' }) },
    } as HostSide;
    const target = await targets.current();
    const params = { environmentId: id, dockerHost: target.host, owner: { windowId: 'window-1', pid: process.pid }, additionalVolumesToRemove: [extra], monitorSource: '0123456789abcdef0123456789abcdef' };
    const value = parseDeleteValue(
      await channels.flow(target, OP_DELETE, params, { timeoutMs: 180_000, onAsk: hostSideHandler(host, log, FLOW_REQUESTS[OP_DELETE], { environmentId: id }) }),
    );
    expect(value).toEqual({ deleted: true });
    expect(cli.lines(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])).toEqual([]);
    expect(cli.lines(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'])).toEqual([]);
    expect(cli.lines(['volume', 'ls', '--filter', `name=^${extra}$`, '--format', '{{.Name}}'])).toEqual([]);
    expect(requests).toEqual([
      // Read before and within the queue of the repository (as the Delete of the extension read it).
      `get ${id}`,
      `get ${id}`,
      'account true',
      `markBusy ${id} delete`,
      'read',
      `remove ${id} {"kept":[],"removed":["${extra}"]}`,
      `sessionFile removePending ${id}`,
      `sessionFile removeOperation ${id}`,
      `sessionFile removeDisconnectRequest ${id}`,
      `sessionFile removeReopenOf ${id}`,
    ]);
  }, 240_000);
});

