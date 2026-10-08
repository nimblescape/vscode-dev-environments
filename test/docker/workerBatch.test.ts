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
// after a close (cancel). The clone uses a
// derived image whose `git` only waits (so the Git step is deterministic and needs no network).
// User decision of 2026-10-01 ("we shall run as the repo owner user. that is what a real user would do as well."; it
// replaces option A): a Compose model step runs as the owner of the repository (1000 here): it cannot read a file in
// CONFIG_FOLDER (root's and 0700 during the step, the owner's again after it), and it can read a 0600 file of the owner
// in the repository (an `.env`); createFolders (agreed extension) creates folders of the owner.
// Plan step 11I1, PR A1: the batch helper of the checks of one session is started from the test process as the worker's
// own flow starts it (inProcessBatches: workerBatchSession over the Engine API), without the `lock` and `batch` relay of
// the worker. Plan step 11I1, PR A2 (decision D5 of 2026-10-07): the end of the helper with its worker (a kill, a
// silence) is tested at unit level only (src/helperChannel/batch.e2e.test.ts).
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Plan step 11I2: the Docker CLI of the extension (BootstrapDocker) in place of the removed CLI adapter ContainerAdapter.
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { DockerTargets } from '../../src/core/docker/dockerTargets';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import { BATCH_DOCKER_SOCKET, BATCH_GIT_UID } from '../../src/core/helperChannel/batch';
import { LABEL_CHANNEL_STEP } from '../../src/core/helperChannel/protocol';
import { HELPER_CACHE_FOLDER, HELPER_CACHE_VOLUME, LABEL_HELPER_RUN, SECRETS_FOLDER, WORKSPACES_ROOT } from '../../src/core/names';
import { bundleHash } from '../../src/core/loader/pipeLoader';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { DUMMY_TOKEN, HELPER_DOCKERFILE, dockerTestContext, testHelperImage } from './harness';
import { inProcessBatches, workerScript, type InProcessBatches } from './workerLocks';

const REPOSITORY = 'devenv-test/worker-batch';
/** As the folder of REPOSITORY in the volume. */
const FOLDER = '/workspaces/worker-batch';
/** The clone goes to a folder of its own (the folder of REPOSITORY exists and is no repository). */
const CLONED = 'devenv-test/worker-batch-clone';

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
  const docker = new BootstrapDocker(runner, run.dockerPath, env, log);
  const targets = new DockerTargets(docker, env, log);
  const volume = `devenv-test-batch-${run.runId}`;
  let script = '';
  let helperTag = '';
  /** The helper image with a `git` that only waits (deterministic Git steps). */
  let waitingGitImage = '';
  /** Plan step 11I1, PR A1: the batch helpers started from the test process. */
  let batches: InProcessBatches | undefined;
  const sessions: string[] = [];

  const helpersOf = (session: string) => cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_CHANNEL_STEP}=${session}`]);
  const execIn = (container: string, user: string, command: string) => cli.run(['exec', '--user', user, container, 'sh', '-c', command]);

  /** Plan step 11I1, PR A1: a batch session as the worker's own flow opens it, from the test process (no lock needed). */
  async function openBatch(image: string) {
    const target = await targets.current();
    const session = await batches!.open({ volume, image, socket: helperDockerSocket(env, process.platform, target.endpoint) });
    sessions.push(session.session);
    return session;
  }

  beforeAll(async () => {
    // Plan step 11I1, PR A1: the bundle of workerLocks.ts, which the in-process batch helpers load too.
    script = await workerScript();
    // Review round 1 (A-L4): the engine of the Docker context, as the worker's socket follows it.
    batches = await inProcessBatches({ cli, log }, helperDockerSocket(env, process.platform, (await targets.current()).endpoint));
    // Plan step 11I (U7, decision of 2026-10-08): the helper image through the harness (before: ensureImageUse of a
    // WorkspaceHelper).
    const use = await testHelperImage(docker, log, env);
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
        // Plan step 6, PR C (option A): a compose file whose env_file is a file of CONFIG_FOLDER.
        `printf 'services:\\n  a:\\n    image: alpine\\n    env_file: ../.devenv+/gitconfig\\n' > ${FOLDER}/token.yml && ` +
        // User decision of 2026-10-01 (Compose reads as the repository owner): a compose file whose env_file is the
        // `.env` of the repository, a file of the owner with mode 0600.
        `printf 'services:\\n  a:\\n    image: alpine\\n    env_file: .env\\n' > ${FOLDER}/owner.yml && ` +
        `echo 'OWNER_ONLY=read-by-the-owner' > ${FOLDER}/.env && ` +
        `echo '[user]' > /workspaces/.devenv+/gitconfig && chown -R 1000:1000 ${FOLDER} /workspaces/.devenv+ && chmod 0755 /workspaces/.devenv+ && chmod 0600 ${FOLDER}/.env`,
    ]);
  });

  afterAll(async () => {
    // Plan step 11I1, PR A1: no in-process batch helper is left over.
    // Review round 1 (A-L2): also when the setup failed before the batch helpers.
    const batchLeftovers = batches === undefined ? [] : await batches.dispose();
    for (const session of sessions) for (const id of helpersOf(session)) cli.run(['rm', '-f', id]);
    cli.run(['rmi', '-f', `devenv-test-batch-git:${run.runId}`]);
    removeRunObjects(cli, run.runId);
    // Plan step 11I1, PR A2: no worker is started any more (decision D5 of 2026-10-07), so none can be left over.
    expect(batchLeftovers).toEqual([]);
  });

  it('refuses a missing volume and does not create it', async () => {
    // Plan step 11I1, PR A1: opened from the test process (was: through the lock of a worker).
    const target = await targets.current();
    const missing = `devenv-test-batch-missing-${run.runId}`;
    await expect(batches!.open({ volume: missing, image: waitingGitImage, socket: helperDockerSocket(env, process.platform, target.endpoint) })).rejects.toMatchObject({
      code: 'missingVolume',
    });
    expect(cli.volume(missing)).toBeUndefined();
  });

  it('isolates the Git user, keeps the token out of the container and the log, and keeps the session after a step time limit', async () => {
    // Plan step 11I1, PR A1: opened from the test process (was: through the lock of a worker).
    const session = await openBatch(waitingGitImage);
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
    const clone = session.step('clone', { repository: CLONED }, { secrets: { token: DUMMY_TOKEN }, timeoutMs: 20_000, onOutput: (_stream, text) => output.push(text) });
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
    // Plan step 11G3: the worker creates the helper over the Engine API (DockerEngine.runAttached) instead of its own
    // `docker run --rm -i --pull never`, with exactly its options: its name and labels, AutoRemove (`--rm`), an open input
    // (`-i`), no log, no new privileges, the default network, the three mounts, the secrets tmpfs, the pinned image with
    // the entrypoint of the image and the pipe loader as its command, and nothing more.
    const created = JSON.parse(cli.ok(['inspect', container]))[0] as {
      Name: string;
      Image: string;
      Config: { Labels: Record<string, string>; OpenStdin: boolean; StdinOnce: boolean; Tty: boolean; Entrypoint: string[] | null; Cmd: string[]; User: string };
      HostConfig: {
        AutoRemove: boolean;
        LogConfig: { Type: string };
        SecurityOpt: string[] | null;
        NetworkMode: string;
        Privileged: boolean;
        CapAdd: string[] | null;
        Binds: string[] | null;
        Tmpfs: Record<string, string> | null;
        Mounts: Array<{ Type: string; Source: string; Target: string }> | null;
      };
    };
    const socket = helperDockerSocket(env, process.platform, (await targets.current()).endpoint);
    expect(created.Name).toBe(`/devenv-batch-${session.session}`);
    expect(created.Image).toBe(waitingGitImage);
    expect(created.Config.Labels).toMatchObject({ [LABEL_HELPER_RUN]: 'true', [LABEL_CHANNEL_STEP]: session.session });
    expect([created.Config.OpenStdin, created.Config.StdinOnce, created.Config.Tty]).toEqual([true, true, false]);
    expect(created.Config.Entrypoint).toEqual(['/usr/bin/tini', '-g', '--']);
    expect(created.Config.Cmd.slice(-3)).toEqual(['/opt/devenv/batch.js', bundleHash(script), 'startBatchHelper']);
    expect(created.Config.User).toBe('');
    expect(created.HostConfig.AutoRemove).toBe(true);
    expect(created.HostConfig.LogConfig.Type).toBe('none');
    expect(created.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);
    expect(['default', 'bridge']).toContain(created.HostConfig.NetworkMode);
    expect(created.HostConfig.Privileged).toBe(false);
    expect(created.HostConfig.CapAdd ?? []).toEqual([]);
    expect(created.HostConfig.Binds ?? []).toEqual([]);
    expect(created.HostConfig.Tmpfs).toEqual({ [SECRETS_FOLDER]: 'rw,noexec,nosuid,nodev,size=1m,mode=0700' });
    expect((created.HostConfig.Mounts ?? []).map((mount) => [mount.Type, mount.Source, mount.Target])).toEqual([
      ['volume', volume, WORKSPACES_ROOT],
      ['volume', HELPER_CACHE_VOLUME, HELPER_CACHE_FOLDER],
      ['bind', socket, BATCH_DOCKER_SOCKET],
    ]);

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
  });

  it('Docker Compose refuses remote includes in the helper (Q2)', async () => {
    // Plan step 11I1, PR A1: opened from the test process (was: through the lock of a worker).
    const session = await openBatch(waitingGitImage);
    for (const [file, disabled] of [
      ['git.yml', 'git remote resource is disabled by "COMPOSE_EXPERIMENTAL_GIT_REMOTE"'],
      ['oci.yml', 'OCI remote resource is disabled by "COMPOSE_EXPERIMENTAL_OCI_REMOTE"'],
    ]) {
      const result = await session.step('composeModel', { repository: REPOSITORY, files: [`${FOLDER}/${file}`], project: 'devenv-batch-test' });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim().split('\n').pop()!)).toMatchObject({ error: expect.stringContaining(disabled) });
    }
    await session.close();
  });

  // User decision of 2026-10-01 ("we shall run as the repo owner user. that is what a real user would do as well."): the
  // Compose model step runs as the owner of the repository (1000), so Compose, which follows `env_file`, cannot read a
  // file in CONFIG_FOLDER, which belongs to that owner but is root's and 0700 during the step; the folder gets its owner
  // and mode back. (Under option A, which this replaces, the step ran as the unprivileged Git user.)
  it('a Compose model step as the repository owner cannot read a file in CONFIG_FOLDER (user decision of 2026-10-01)', async () => {
    // Plan step 11I1, PR A1: opened from the test process (was: through the lock of a worker).
    const session = await openBatch(waitingGitImage);
    const container = helpersOf(session.session)[0];
    const result = await session.step('composeModel', { repository: REPOSITORY, files: [`${FOLDER}/token.yml`], project: 'devenv-batch-test' });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(/permission denied/i);
    expect(output).not.toContain('[user]');
    // User decision of 2026-10-01: the owner of CONFIG_FOLDER is restored as well (root's during the step).
    expect(execIn(container, '0:0', 'stat -c %a:%u:%g /workspaces/.devenv+').out).toBe('755:1000:1000');
    expect(execIn(container, '0:0', 'cat /workspaces/.devenv+/gitconfig').out).toBe('[user]');
    await session.close();
  });

  // User decision of 2026-10-01: the Compose read runs as the owner of the repository, as a real user would, so it reads
  // a 0600 file of that owner in the repository (an `.env` that `env_file` names).
  it('a Compose model step reads a 0600 file of the repository owner (user decision of 2026-10-01)', async () => {
    // Plan step 11I1, PR A1: opened from the test process (was: through the lock of a worker).
    const session = await openBatch(waitingGitImage);
    const container = helpersOf(session.session)[0];
    const result = await session.step('composeModel', { repository: REPOSITORY, files: [`${FOLDER}/owner.yml`], project: 'devenv-batch-test' });
    expect(result.exitCode).toBe(0);
    const printed = JSON.parse(result.stdout.trim().split('\n').pop()!) as { error?: string; model?: { services: Record<string, { environment?: Record<string, string> }> } };
    expect(printed.error).toBeUndefined();
    expect(printed.model?.services.a.environment).toMatchObject({ OWNER_ONLY: 'read-by-the-owner' });
    expect(execIn(container, '0:0', `stat -c %a:%u ${FOLDER}/.env`).out).toBe('600:1000');
    // The agreed extension of the same day: createFolders runs as the owner too, so the folders it creates are the owner's.
    const created = await session.step('createFolders', { repository: REPOSITORY, folders: [`${FOLDER}/data/pg`] });
    expect(created.exitCode).toBe(0);
    expect(execIn(container, '0:0', `stat -c %u:%g ${FOLDER}/data ${FOLDER}/data/pg`).out.split('\n')).toEqual(['1000:1000', '1000:1000']);
    await session.close();
  });
  // Plan step 11I1, PR A2 (decision D5 of 2026-10-07): the end of the helper with its worker (after a kill of the worker,
  // and after its silence when the worker hangs) is tested at unit level only (src/helperChannel/batch.e2e.test.ts); the
  // two Docker tests here took their helper through the `lock` and `batch` relay of the worker, which 11I1 removes.
});
