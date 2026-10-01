// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the batch helper of the worker on the real Docker engine of the runner (decision 2026-09-29: one
// helper per operation with the volume of the environment; Q2 of 2026-10-01: isolation inside it). The batches are
// taken through a held lock (HeldEnvironmentLock.batch), as plan step 6, PR C will. Checked: a missing volume is refused
// and not created; exactly one helper container per session; during a Git step the Git user cannot connect to the
// socket and cannot read CONFIG_FOLDER, and outside its step it cannot read the secrets tmpfs; the token is absent from
// `docker inspect` (Env, Args) and from the log; a step time limit ends that step and the session goes on; the modes
// are restored after the Git step; Docker Compose refuses remote includes in the helper; the helper container is gone
// after a close (cancel), after a kill of the worker, and after its silence when the worker hangs. The clone uses a
// derived image whose `git` only waits (so the Git step is deterministic and needs no network).
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import type { HeldEnvironmentLock } from '../../src/core/docker/environmentLock';
import { WorkspaceHelper, helperDockerSocket } from '../../src/core/helper/workspaceHelper';
import { BATCH_GIT_UID } from '../../src/core/helperChannel/batch';
import { HelperChannels, openHelperChannel } from '../../src/core/helperChannel/helperChannels';
import { LABEL_CHANNEL_STEP, LABEL_HELPER_CHANNEL } from '../../src/core/helperChannel/protocol';
import { newEnvironmentId } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { DUMMY_TOKEN, HELPER_DOCKERFILE, dockerTestContext, testStateVolume } from './harness';

const REPOSITORY = 'devenv-test/worker-batch';
/** As the folder of REPOSITORY in the volume. */
const FOLDER = '/workspaces/worker-batch';
/** The clone goes to a folder of its own (the folder of REPOSITORY exists and is no repository). */
const CLONED = 'devenv-test/worker-batch-clone';

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

describe('the batch helper of the worker (plan step 6, PR B)', () => {
  const context = dockerTestContext('workerBatch');
  const { run, env, cli, log } = context;
  const runner = new NodeProcessRunner();
  const docker = new ContainerAdapter(runner, run.dockerPath, env, log);
  const targets = new DockerTargets(docker, env, log);
  const helper = new WorkspaceHelper({ docker, logger: log, dockerfilePath: HELPER_DOCKERFILE, env });
  const volume = `devenv-test-batch-${run.runId}`;
  let script = '';
  let helperTag = '';
  /** The helper image with a `git` that only waits (deterministic Git steps). */
  let waitingGitImage = '';
  const allChannels: HelperChannels[] = [];
  const sessions: string[] = [];

  const helpersOf = (session: string) => cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_CHANNEL_STEP}=${session}`]);
  const execIn = (container: string, user: string, command: string) => cli.run(['exec', '--user', user, container, 'sh', '-c', command]);

  /** The workers of one window, with the state volume of the test; `names` gets their container names. */
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
            stateVolume: testStateVolume(context, 'workerBatch'),
          },
          target,
        ),
    });
    allChannels.push(channels);
    return channels;
  }

  async function lockAndBatch(channels: HelperChannels, image: string) {
    const target = await targets.current();
    const lock: HeldEnvironmentLock = await channels.lock(target, newEnvironmentId(), 5);
    const session = await lock.batch!({ volume, image, socket: helperDockerSocket(env, process.platform, target.endpoint) });
    sessions.push(session.session);
    return { lock, session };
  }

  beforeAll(async () => {
    script = await bundleScript();
    const use = await helper.ensureImageUse();
    helperTag = use.tag;
    // A `git` first on PATH that only waits: the clone runs as the Git user until its time limit.
    const dockerfile = `FROM ${helperTag}\nRUN printf '#!/bin/sh\\nexec sleep 300\\n' > /usr/local/bin/git && chmod 0755 /usr/local/bin/git\nLABEL ${TEST_RUN_LABEL}=${run.runId}\n`;
    cli.ok(['build', '-q', '-f', '-', '-t', `devenv-test-batch-git:${run.runId}`, path.dirname(HELPER_DOCKERFILE)], dockerfile);
    waitingGitImage = cli.ok(['image', 'inspect', '--format', '{{.Id}}', `devenv-test-batch-git:${run.runId}`]);
    cli.ok(['volume', 'create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, volume]);
    // The repository and CONFIG_FOLDER as an open leaves them (owner 1000, CONFIG_FOLDER 0755 with a readable file).
    cli.ok([
      'run', '--rm', '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--mount', `type=volume,source=${volume},target=/workspaces`, TEST_BASE_IMAGE, 'sh', '-c',
      `mkdir -p ${FOLDER}/.devcontainer /workspaces/.devenv+ && echo '{}' > ${FOLDER}/.devcontainer/devcontainer.json && ` +
        `printf 'services:\\n  a:\\n    image: alpine\\ninclude:\\n  - https://github.com/docker/compose.git#main\\n' > ${FOLDER}/git.yml && ` +
        `printf 'include:\\n  - oci://localhost:1/devenv/none:latest\\nservices:\\n  a:\\n    image: alpine\\n' > ${FOLDER}/oci.yml && ` +
        `echo '[user]' > /workspaces/.devenv+/gitconfig && chown -R 1000:1000 ${FOLDER} /workspaces/.devenv+ && chmod 0755 /workspaces/.devenv+`,
    ]);
  });

  afterAll(async () => {
    for (const channels of allChannels) channels.dispose();
    for (const session of sessions) for (const id of helpersOf(session)) cli.run(['rm', '-f', id]);
    let leftovers: string[] = [];
    try {
      await waitUntil(() => cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`]).length === 0, 'the removal of the workers');
    } catch {
      leftovers = cli.lines(['ps', '-a', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--format', '{{.Names}}']);
    }
    cli.run(['rmi', '-f', `devenv-test-batch-git:${run.runId}`]);
    removeRunObjects(cli, run.runId);
    expect(leftovers).toEqual([]);
  });

  it('refuses a missing volume and does not create it', async () => {
    const channels = windowChannels();
    const target = await targets.current();
    const lock = await channels.lock(target, newEnvironmentId(), 5);
    const missing = `devenv-test-batch-missing-${run.runId}`;
    await expect(lock.batch!({ volume: missing, image: waitingGitImage, socket: helperDockerSocket(env, process.platform, target.endpoint) })).rejects.toMatchObject({
      code: 'missingVolume',
    });
    expect(cli.volume(missing)).toBeUndefined();
    await lock.release();
  });

  it('isolates the Git user, keeps the token out of the container and the log, and keeps the session after a step time limit', async () => {
    const channels = windowChannels();
    const { lock, session } = await lockAndBatch(channels, waitingGitImage);
    const helpers = helpersOf(session.session);
    expect(helpers).toHaveLength(1);
    const container = helpers[0];
    const uid = `${BATCH_GIT_UID}:${BATCH_GIT_UID}`;
    const connect = `node -e "require('net').connect('/var/run/docker.sock').on('connect',()=>process.exit(0)).on('error',(e)=>{console.log(e.code);process.exit(3)})"`;
    // Root reaches the socket (through the link to the folder of root); the Git user does not, in or outside a step.
    expect(execIn(container, '0:0', connect).code).toBe(0);
    expect(execIn(container, uid, connect)).toMatchObject({ code: 3 });
    // Whatever the mode of the socket on the host (rootless Docker and Docker Desktop are open to more users): its folder
    // is root's, 0700.
    expect(execIn(container, '0:0', 'stat -c %a:%u /run/devenv-docker').out).toBe('700:0');
    expect(execIn(container, uid, 'ls /run/devenv-docker').code).not.toBe(0);
    expect(execIn(container, uid, 'ls /run/devenv-secrets').code).not.toBe(0);

    const output: string[] = [];
    const clone = session.step('clone', { repository: CLONED }, { secret: DUMMY_TOKEN, timeoutMs: 20_000, onOutput: (_stream, text) => output.push(text) });
    // The clone waits in its `git`, as the Git user: CONFIG_FOLDER is closed to that user for the step.
    await waitUntil(() => execIn(container, '0:0', `for p in /proc/[0-9]*; do [ "$(stat -c %u $p 2>/dev/null)" = ${BATCH_GIT_UID} ] && grep -q sleep $p/cmdline 2>/dev/null && exit 0; done; exit 1`).code === 0, 'the Git step');
    expect(execIn(container, uid, 'cat /workspaces/.devenv+/gitconfig').code).not.toBe(0);
    expect(execIn(container, uid, connect).code).toBe(3);
    expect(execIn(container, '0:0', 'cat /workspaces/.devenv+/gitconfig').out).toBe('[user]');
    // The token is in no variable and no argument of any process of the helper while the clone runs (the pattern comes on
    // standard input, so that it is not an argument of the search itself).
    // As root and as the Git user (root has no CAP_SYS_PTRACE in the container, so the variables of the Git user's
    // processes are readable only to that user). The search must see processes of the step at all.
    for (const user of ['0:0', uid]) {
      const search = cli.run(['exec', '-i', '--user', user, container, 'sh', '-c', 'grep -s -l -F -f /dev/stdin /proc/[0-9]*/environ /proc/[0-9]*/cmdline; true'], DUMMY_TOKEN);
      expect(search, user).toMatchObject({ code: 0, out: '' });
    }
    expect(cli.run(['exec', '--user', uid, container, 'sh', '-c', 'grep -s -l -F HOME=/nonexistent /proc/[0-9]*/environ; true']).out).not.toBe('');
    // The token is in no part of the container's configuration.
    expect(cli.ok(['inspect', container])).not.toContain(DUMMY_TOKEN);
    const inspected = JSON.parse(cli.ok(['inspect', container]))[0] as { Config: { Env: string[]; Cmd: string[] }; Args: string[] };
    expect([...inspected.Config.Env, ...inspected.Config.Cmd, ...inspected.Args].join('\n')).not.toContain(DUMMY_TOKEN);
    expect(inspected.Config.Env.some((entry) => entry.startsWith('DOCKER_HOST='))).toBe(false);

    const timed = await clone;
    expect(timed.timedOut).toBe(true);
    // After the Git step: no process of the Git user, the token gone, the modes back, the session usable.
    expect(execIn(container, '0:0', `for p in /proc/[0-9]*; do [ "$(stat -c %u $p 2>/dev/null)" = ${BATCH_GIT_UID} ] && exit 1; done; exit 0`).code).toBe(0);
    expect(execIn(container, '0:0', 'ls -A /run/devenv-secrets').out).toBe('');
    expect(execIn(container, '0:0', 'stat -c %a /workspaces /workspaces/.devenv+ /run/devenv-secrets').out.split('\n')).toEqual(['755', '755', '700']);
    expect(execIn(container, uid, 'ls /run/devenv-secrets').code).not.toBe(0);
    const listed = await session.step('listConfigs', { repository: REPOSITORY });
    expect(listed).toMatchObject({ exitCode: 0, timedOut: false });
    expect(JSON.parse(listed.stdout.trim().split('\n').pop()!)).toEqual(['.devcontainer/devcontainer.json']);
    expect(helpersOf(session.session)).toEqual([container]);
    expect(output.join('')).not.toContain(DUMMY_TOKEN);
    expect(log.tail(100_000)).not.toContain(DUMMY_TOKEN);

    // Close (the cancel of the operation): the container is gone.
    await session.close();
    await waitUntil(() => helpersOf(session.session).length === 0, 'the removal of the helper after the close');
    await lock.release();
  });

  it('Docker Compose refuses remote includes in the helper (Q2)', async () => {
    const channels = windowChannels();
    const { lock, session } = await lockAndBatch(channels, waitingGitImage);
    for (const [file, disabled] of [
      ['git.yml', 'git remote resource is disabled by "COMPOSE_EXPERIMENTAL_GIT_REMOTE"'],
      ['oci.yml', 'OCI remote resource is disabled by "COMPOSE_EXPERIMENTAL_OCI_REMOTE"'],
    ]) {
      const result = await session.step('composeModel', { repository: REPOSITORY, files: [`${FOLDER}/${file}`], project: 'devenv-batch-test' });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim().split('\n').pop()!)).toMatchObject({ error: expect.stringContaining(disabled) });
    }
    await session.close();
    await lock.release();
  });

  it('the helper is gone after a kill of the worker', async () => {
    const names: string[] = [];
    const channels = windowChannels(names);
    const { session } = await lockAndBatch(channels, waitingGitImage);
    expect(helpersOf(session.session)).toHaveLength(1);
    cli.ok(['kill', '--signal', 'KILL', names[0]]);
    await waitUntil(() => helpersOf(session.session).length === 0, 'the end of the helper after the worker', 90_000);
  });

  it('the helper is gone after its silence when the worker hangs', { timeout: 5 * 60_000 }, async () => {
    const names: string[] = [];
    const channels = windowChannels(names);
    const { session } = await lockAndBatch(channels, waitingGitImage);
    expect(helpersOf(session.session)).toHaveLength(1);
    cli.ok(['pause', names[0]]);
    try {
      // No ping reaches the helper; it ends after CHANNEL_SILENCE_EXIT_MS (60 s).
      await waitUntil(() => helpersOf(session.session).length === 0, 'the end of the helper by its silence', 150_000);
    } finally {
      cli.run(['unpause', names[0]]);
    }
  });
});
