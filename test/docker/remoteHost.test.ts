// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Unit 7: Docker on another computer through the Docker context, against the real Docker engine. The "remote computer"
// is an SSH server in a container (test/docker/sshd: Alpine with openssh-server and the Docker CLI, key authentication
// only) whose Docker socket is the socket of the engine of the runner. A test SSH config names it; a wrapper `ssh` first on
// PATH adds `-F <config>`, so the Docker CLI's ssh uses it and the SSH config of the user is not touched. The context of
// the host (user decisions 2026-10-03: named after the SSH alias, `devenv-test-remote`, with `ssh://devenv-test-remote` and
// the description of Dev Environments) is created in a Docker configuration folder of this file only.
// Checked: the test of a host and the plain reasons of its failures (unknown host key, login failed, unreachable), the
// context switch and the detection of the remote mode, the open pipeline of a seeded environment through the context
// (every Docker call goes through SSH: the SSH server logs each connection), the containers and volumes on the engine
// reached through SSH, the token file in the tmpfs, and the Docker host recorded in the registry. Plan step 11I1, PR A2:
// the operations are the flows of the worker, as the window sends them (workerWindow.ts), instead of the pipeline of the
// test process over the relay of the worker (removed by 11I1): the worker on the remote engine is started through SSH
// and talks to its socket there (decision D6 of 2026-10-07: so not every Docker call is an SSH connection any more). The
// open makes sure of the real Session Monitor (decision D9 of 2026-10-07).
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Plan step 11I2: the Docker CLI of the extension (BootstrapDocker) in place of the removed CLI adapter ContainerAdapter.
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { findExecutable } from '../../src/core/docker/dockerCli';
import { ownContextDescription, remoteContextNames } from '../../src/core/docker/dockerHost';
import { ensureDockerRunning } from '../../src/core/docker/dockerStart';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import {
  findRemoteContext,
  isOwnContext,
  listContextInfos,
  startDockerFor,
  testRemoteDockerHost,
  useContext,
  useRemoteContext,
  type SshCheckDeps,
} from '../../src/core/docker/remoteDocker';
import { DOCKER_SOCKET, WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import {
  GITHUB_TOKEN_FILE,
  LABEL_ENVIRONMENT_ID,
  LABEL_REPOSITORY,
  TOKEN_FOLDER,
  TOKEN_TMPFS,
  newEnvironmentId,
  resourceName,
} from '../../src/core/names';
import { isoTime, systemClock } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { RemoteDockerState } from '../../src/core/storage/remoteDockerState';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, createDockerConfig, removeRunObjects } from './dockerRun';
import {
  DUMMY_TOKEN,
  HELPER_DOCKERFILE,
  RecordingProgress,
  TEST_ACCOUNT,
  Timings,
  createVolume,
  dockerTestContext,
  expectLabelledEnvironmentImage,
  runInVolume } from './harness';
import { monitorOfUser, removeTestMonitor, testComputer, workerWindow, type WorkerWindow } from './workerWindow';

const ALIAS = 'devenv-test-remote';
const REPOSITORY = 'devenv-test/remote';
const FOLDER = '/workspaces/remote';
const CONFIG_PATH = '.devcontainer/devcontainer.json';
const REMOTE_USER = 'dev';
const SSHD_DOCKERFILE_FOLDER = path.resolve(__dirname, 'sshd');

/** Creates the repository in the volume as the helper creates a clone (see pipeline.test.ts). */
const SEED_SCRIPT = `set -eu
mkdir -p "$1/.devcontainer"
printf '%s\\n' "$2" > "$1/.devcontainer/devcontainer.json"
printf '%s\\n' "$3" > "$1/.devcontainer/Dockerfile"
cd "$1"
git init -q -b main
git add -A
git -c user.name=Test -c user.email=test@example.invalid commit -q -m 'Initial commit'
`;

/** A free TCP port on 127.0.0.1 (nothing listens on it afterwards). */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('Docker on another computer through the Docker context (unit 7)', () => {
  const { run, env: localEnv, cli: localCli, log } = dockerTestContext('remoteHost');
  const runner = new NodeProcessRunner();
  const timings = new Timings();
  const dir = path.join(run.runDir, 'remote-host');
  const sshdImage = `devenv-test-sshd:${run.runId}`;
  const sshdContainer = `devenv-test-sshd-${run.runId}`;
  const environmentId = newEnvironmentId();
  const volumeName = resourceName(REPOSITORY, environmentId);
  const containerName = volumeName;

  // The environment of this file: its own Docker configuration (the context of the host lives there), the wrapper
  // `ssh` first on PATH, and neither DOCKER_HOST nor DOCKER_CONTEXT, so the current context decides.
  const env: NodeJS.ProcessEnv = { ...localEnv };
  let docker: BootstrapDocker;
  let targets: DockerTargets;
  let sshDeps: () => SshCheckDeps;
  let sshLog = '';

  /** "Accepted publickey" lines of the SSH server: one per SSH connection of the Docker CLI. */
  function acceptedConnections(): number {
    const result = localCli.run(['logs', sshdContainer]);
    sshLog = `${result.out}\n${result.err}`;
    return sshLog.split('\n').filter((line) => line.includes('Accepted publickey')).length;
  }

  function execIn(user: string, script: string): string {
    const result = localCli.run(['exec', '-u', user, containerName, 'sh', '-c', script]);
    if (result.code !== 0) throw new Error(`docker exec as ${user} failed (${result.code}): ${result.err}`);
    return result.out;
  }

  beforeAll(async () => {
    fs.mkdirSync(dir, { recursive: true });
    const sshPath = findExecutable('ssh', process.env, process.platform);
    const keygenPath = findExecutable('ssh-keygen', process.env, process.platform);
    if (!sshPath || !keygenPath) throw new Error('The Docker tests of unit 7 need the OpenSSH client (ssh and ssh-keygen).');
    const key = path.join(dir, 'id_ed25519');
    const otherKey = path.join(dir, 'other_ed25519');
    for (const file of [key, otherKey]) {
      const generated = await runner.run(keygenPath, ['-q', '-t', 'ed25519', '-N', '', '-C', 'devenv-test', '-f', file]);
      expect(generated.exitCode, generated.stderr).toBe(0);
    }

    // The SSH server: the socket of the engine of the runner is its Docker socket (its "own" engine).
    await timings.measure('SSH server image', async () =>
      localCli.ok(['build', '-q', '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--build-arg', `BASE_IMAGE=${TEST_BASE_IMAGE}`, '-t', sshdImage, SSHD_DOCKERFILE_FOLDER]),
    );
    const engineSocket = helperDockerSocket(localEnv, process.platform);
    localCli.ok([
      'run', '-d', '--name', sshdContainer, '--label', `${TEST_RUN_LABEL}=${run.runId}`,
      '-e', `AUTHORIZED_KEY=${fs.readFileSync(`${key}.pub`, 'utf8').trim()}`,
      '-v', `${engineSocket}:/var/run/docker.sock`,
      '-p', '127.0.0.1::22',
      sshdImage,
    ]);
    const port = Number(localCli.ok(['port', sshdContainer, '22/tcp']).split('\n')[0].split(':').pop());
    expect(port).toBeGreaterThan(0);
    // The host key comes from the container itself; nothing accepts a host key over the network.
    const hostKey = localCli.ok(['exec', sshdContainer, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']).split(' ').slice(0, 2).join(' ');
    const knownHosts = path.join(dir, 'known_hosts');
    fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${hostKey}\n`);
    const common = ['  HostName 127.0.0.1', `  Port ${port}`, '  User root', '  IdentitiesOnly yes', '  StrictHostKeyChecking yes'];
    const config = path.join(dir, 'ssh_config');
    fs.writeFileSync(
      config,
      [
        `Host ${ALIAS}`, ...common, `  IdentityFile ${key}`, `  UserKnownHostsFile ${knownHosts}`,
        'Host devenv-test-unknown-key', ...common, `  IdentityFile ${key}`, `  UserKnownHostsFile ${path.join(dir, 'empty_known_hosts')}`,
        'Host devenv-test-wrong-key', ...common, `  IdentityFile ${otherKey}`, `  UserKnownHostsFile ${knownHosts}`,
        // A port on which nothing listens.
        'Host devenv-test-closed', '  HostName 127.0.0.1', `  Port ${await freePort()}`, '  User root',
        '',
      ].join('\n'),
    );
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nexec '${sshPath}' -F '${config}' "$@"\n`, { mode: 0o755 });

    env.DOCKER_CONFIG = path.join(dir, 'docker-config');
    createDockerConfig(env.DOCKER_CONFIG, process.env);
    env.PATH = `${bin}${path.delimiter}${env.PATH ?? ''}`;
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    docker = new BootstrapDocker(runner, run.dockerPath, env, log);
    targets = new DockerTargets(docker, env, log);
    // Review, C3: the SSH check before the Docker calls uses the wrapper `ssh` (the test SSH config).
    sshDeps = () => ({ runner, sshPath: findExecutable('ssh', env, process.platform), env });

    // The SSH server answers once sshd runs.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const test = await testRemoteDockerHost(docker, ALIAS, sshDeps(), { timeoutMs: 20_000 });
      if (test.ok) break;
      if (Date.now() > deadline) throw new Error(`The SSH server does not answer: ${test.detail}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  /** Plan step 6, PR C: the workers of the open through SSH (disposed by the test, and here after a failure). */
  let remoteWindow: WorkerWindow | undefined;
  // Decision D9 of 2026-10-07: the open makes sure of the real Session Monitor; a monitor of the user is never touched.
  const skipped = monitorOfUser({ run });

  afterAll(async () => {
    timings.print('Timings of the remote Docker host scenarios:');
    await remoteWindow?.dispose();
    removeRunObjects(localCli, run.runId);
    removeTestMonitor({ run, cli: localCli });
    expect(localCli.container(containerName)).toBeUndefined();
    expect(localCli.volume(volumeName)).toBeUndefined();
    expect(localCli.container(sshdContainer)).toBeUndefined();
  });

  it('tests a host without questions, and names the reason of a failure', async () => {
    await expect(testRemoteDockerHost(docker, ALIAS, sshDeps())).resolves.toMatchObject({ ok: true, rootless: false });
    for (const [alias, problem] of [
      ['devenv-test-unknown-key', 'hostKey'],
      ['devenv-test-wrong-key', 'login'],
      ['devenv-test-closed', 'unreachable'],
    ] as const) {
      const started = Date.now();
      const result = await testRemoteDockerHost(docker, alias, sshDeps(), { timeoutMs: 40_000 });
      log.info(`${alias}: ${JSON.stringify(result)}`);
      expect(result).toMatchObject({ ok: false, problem });
      // No prompt waits for an answer: each failure comes at once.
      expect(Date.now() - started).toBeLessThan(30_000);
    }
  });

  it('switches the context to ssh://<alias>: the remote mode follows it, and back', async () => {
    await expect(targets.resolve()).resolves.toMatchObject({ kind: 'local', host: '' });
    // User decisions 2026-10-03: the context is named after the SSH alias (the first of remoteContextNames, free in the
    // Docker configuration of this file) and marked as one of Dev Environments by its description.
    const context = await useRemoteContext(docker, ALIAS);
    expect(context).toBe(ALIAS);
    expect(remoteContextNames(ALIAS)[0]).toBe(ALIAS);
    await expect(findRemoteContext(docker, ALIAS)).resolves.toBe(ALIAS);
    await expect(isOwnContext(docker, ALIAS)).resolves.toBe(true);
    expect((await listContextInfos(docker)).find((info) => info.name === ALIAS)).toEqual({
      name: ALIAS,
      description: ownContextDescription(ALIAS),
      endpoint: `ssh://${ALIAS}`,
    });
    await expect(targets.resolve()).resolves.toEqual({ kind: 'remote', host: ALIAS, endpoint: `ssh://${ALIAS}`, context: ALIAS });
    await useContext(docker, 'default');
    await expect(targets.resolve()).resolves.toMatchObject({ kind: 'local' });
    // User decisions 2026-10-03: the existing context is taken again, no second one is created.
    await expect(useRemoteContext(docker, ALIAS)).resolves.toBe(ALIAS);
    expect((await listContextInfos(docker)).filter((info) => info.endpoint === `ssh://${ALIAS}`).map((info) => info.name)).toEqual([ALIAS]);
  });

  it.skipIf(skipped)('opens a seeded environment through the context: containers, volumes, and the token on the engine reached through SSH', async () => {
    await useRemoteContext(docker, ALIAS);
    const state = new RemoteDockerState(path.join(dir, 'remote-docker.json'));
    const sshPath = findExecutable('ssh', env, process.platform);
    const helper = new WorkspaceHelper({
      docker,
      logger: log,
      dockerfilePath: HELPER_DOCKERFILE,
      env,
      // As extension.ts: on a remote host, the socket of that computer.
      engine: async () => {
        const target = await targets.current();
        if (target.kind !== 'remote') return { key: target.host, endpoint: target.endpoint };
        return { key: target.host, socket: (await state.rootlessSocket(target.host)) ?? DOCKER_SOCKET };
      },
    });
    // Plan step 6, PR C: the real worker of the engine reached through SSH (as extension.ts: the socket of that computer),
    // whose batch helper runs the helper steps of the open; there is no other path (D1). Plan step 11I1, PR A2: the
    // window of the shared harness, whose operations run in that worker (was: the pipeline of the test process over the
    // `lock` relay of the worker).
    const window = workerWindow({ run, env, cli: localCli, log }, docker, {
      name: 'remoteHost',
      computer: testComputer({ run, log }, 'remote-host'),
      windowId: 'docker-test-remote-window',
      settings: { updateImagesOnConnect: true },
      socketPath: async (target) => (target.kind === 'remote' ? ((await state.rootlessSocket(target.host)) ?? DOCKER_SOCKET) : helperDockerSocket(env, process.platform, target.endpoint)),
      startDocker: async ({ onStarting, signal }) =>
        startDockerFor(
          await targets.current(),
          () => ensureDockerRunning(docker, runner, log, { platform: process.platform, env, onStarting, signal }),
          { docker, runner, state, logger: log, sshPath, env },
          signal,
        ),
    });
    remoteWindow = window;
    const { registry, service } = window;

    let beforeOpen = 0;
    let logBeforeOpen = 0;
    const stepsBefore = window.steps.length;
    const progress = new RecordingProgress();
    await timings.measure(
      'seed and open through SSH',
      () =>
        targets.withOperation(async () => {
          await helper.ensureImage();
          const devcontainerJson = JSON.stringify({
            name: 'Remote',
            build: { dockerfile: 'Dockerfile' },
            remoteUser: REMOTE_USER,
            runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`],
          });
          const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, 'RUN apk add --no-cache git && adduser -D dev', `LABEL ${TEST_RUN_LABEL}=${run.runId}`].join('\n');
          await createVolume(docker, volumeName, { [LABEL_ENVIRONMENT_ID]: environmentId, [LABEL_REPOSITORY]: REPOSITORY, [TEST_RUN_LABEL]: run.runId });
          // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image (runInVolume).
          const seeded = await runInVolume(docker, volumeName, ['sh', '-c', SEED_SCRIPT, 'sh', FOLDER, devcontainerJson, dockerfile]);
          expect(seeded.exitCode, seeded.stderr).toBe(0);
          const now = isoTime(systemClock);
          await registry.add({
            id: environmentId,
            repository: REPOSITORY,
            configPath: CONFIG_PATH,
            volumeName,
            containerName,
            createdAt: now,
            lastUsedAt: now,
            owner: TEST_ACCOUNT,
            dockerHost: await targets.host(),
          });
          // Review round 1 of PR #117 (A-M2): the SSH connections of the open alone (the seed above uses SSH too).
          beforeOpen = acceptedConnections();
          logBeforeOpen = fs.readFileSync(log.file, 'utf8').length;
          return service.openEnvironmentInWorker(environmentId, { progress });
        }),
      () => progress.summary(),
    );

    // No Docker Desktop start for a remote host: no step "Starting Docker".
    expect(progress.steps).not.toContain('startingDocker');
    // Decision D6 of 2026-10-07 (was: every Docker call went through SSH, more than 5 connections): the worker was started
    // through SSH to the "remote computer", and talks to its engine there.
    expect(acceptedConnections() - beforeOpen).toBeGreaterThan(0);
    expect(sshLog).toContain('Starting session: command for root');
    expect(window.locks.workerNames).toHaveLength(1);
    expect(fs.readFileSync(log.file, 'utf8').slice(logBeforeOpen)).toContain(`Helper channel to ${ALIAS} is open`);
    // The objects are on the engine that the SSH server reaches (the engine of the runner).
    expect(localCli.volume(volumeName)).toBeDefined();
    const container = localCli.container(containerName);
    expect(container?.State.Running).toBe(true);
    expect(container?.Config.Labels?.[LABEL_ENVIRONMENT_ID]).toBe(environmentId);
    // The token went into the tmpfs of the container through `docker exec` over SSH.
    expect(container?.HostConfig.Tmpfs).toEqual({ [TOKEN_FOLDER]: TOKEN_TMPFS.slice(TOKEN_FOLDER.length + 1) });
    expect(execIn('root', `stat -f -c %T ${TOKEN_FOLDER}`)).toBe('tmpfs');
    expect(execIn(REMOTE_USER, `cat ${GITHUB_TOKEN_FILE}`)).toBe(DUMMY_TOKEN);
    // The registry records the Docker host; the environment is of that host only.
    expect((await registry.get(environmentId))?.dockerHost).toBe(ALIAS);
    // User decisions 2026-10-03: the image built through SSH carries the labels of the environment and its build record;
    // the record pins its ID.
    expectLabelledEnvironmentImage(localCli, await registry.get(environmentId));

    // Back on the local Docker, the environment of the remote host is never acted on.
    await useContext(docker, 'default');
    await expect(targets.withOperation(() => service.stop(environmentId))).rejects.toMatchObject({ code: 'otherDockerHost' });
    expect(localCli.container(containerName)?.State.Running).toBe(true);

    // On the remote host again, the stop goes through SSH.
    await useRemoteContext(docker, ALIAS);
    await targets.withOperation(() => service.stop(environmentId));
    expect(localCli.container(containerName)?.State.Running).toBe(false);
    // Review round 2 of PR #117 (B-L3): the stop ran in the worker on the remote engine (no local worker was started).
    expect(window.locks.workerNames).toHaveLength(1);
    // Plan step 6, PR C: the open ran its helper steps in one batch helper of the worker on the remote engine; no worker
    // and no batch helper is left over.
    // Plan step 11I1, PR A2: counted by the progress steps of the worker (was: the locks of the relay).
    expect(window.batchesOf(volumeName, stepsBefore)).toBe(1);
    expect(await window.dispose()).toEqual([]);
  });
});
