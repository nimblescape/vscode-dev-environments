// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"; decision of 2026-10-09, "11H: the shared VS
// Code server and the Session Monitor's daily run"): an open through a real worker that carries a VS Code server. The
// store is a volume of this test file (testVscodeVolume, the one that its workers mount at /vscode; never the store of
// the engine), seeded with a tiny fake server of a commit that no VS Code has, so nothing is downloaded: the worker finds
// it present. The new dev container mounts the store read-only at /opt/devenv/vscode, and the open links the server as
// the remote user into ~/.vscode-server/bin/<commit>. The dev image is of glibc (the helper image's base, which the
// engine has): a container of musl is never linked. Skipped where the engine had a Session Monitor before the tests.
// Plan step 11H3 (decision of 2026-10-09): the store also holds a fake `.vsix` of an extension that devcontainer.json
// names (no network: the open never downloads extensions); the open records the list in the store and copies the file
// into ~/.vscode-server/extensionsCache of the remote user.
import * as crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { LABEL_ENVIRONMENT_ID, LABEL_REPOSITORY, VSCODE_STORE_TARGET, newEnvironmentId, resourceName } from '../../src/core/names';
import { isoTime, systemClock } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { serverPlatform } from '../../src/core/worker/vscodeServerStore';
import { TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { RecordingProgress, TEST_ACCOUNT, createVolume, dockerTestContext, runInVolume, testHelperImage, testVscodeVolume } from './harness';
import { monitorOfUser as engineHadMonitor, removeTestMonitor, seedTestMonitorRun, workerWindow } from './workerWindow';

const NAME = 'vscodeServer';
const REPOSITORY = 'devenv-test/vscode-server';
const FOLDER = '/workspaces/vscode-server';
const CONFIG_PATH = '.devcontainer/devcontainer.json';
const REMOTE_USER = 'dev';
/** A glibc image that the engine has: the base of the helper image (resources/helper/Dockerfile). */
const GLIBC_BASE_IMAGE = process.env.DEVENV_TEST_GLIBC_IMAGE ?? 'node:24-trixie-slim';
/** A commit of no VS Code: the update service is never asked for it (the store has it). */
const COMMIT = crypto.randomBytes(20).toString('hex');

const SEED_SCRIPT = `set -eu
mkdir -p "$1/.devcontainer"
printf '%s\\n' "$2" > "$1/.devcontainer/devcontainer.json"
printf '%s\\n' "$3" > "$1/.devcontainer/Dockerfile"
cd "$1"
git init -q -b main
git add -A
git -c user.name=Test -c user.email=test@example.invalid commit -q -m 'Initial commit'
`;

/** The fake server in the store (mounted at /workspaces by runInVolume): bin/code-server and node, readable for all. */
const STORE_SEED_SCRIPT = `set -eu
folder="/workspaces/server/stable/$1/$2"
mkdir -p "$folder/bin"
printf '#!/bin/sh\\necho fake server\\n' > "$folder/bin/code-server"
printf '#!/bin/sh\\necho fake node\\n' > "$folder/node"
chmod 755 /workspaces/server /workspaces/server/stable "/workspaces/server/stable/$1" "$folder" "$folder/bin" "$folder/bin/code-server" "$folder/node"
mkdir -p /workspaces/extensions/universal
printf 'PK\\003\\004fake vsix\\n' > "/workspaces/extensions/universal/$3"
chmod 755 /workspaces/extensions /workspaces/extensions/universal
chmod 644 "/workspaces/extensions/universal/$3"
`;

/** Plan step 11H3: the extension that devcontainer.json names, and its cache name in the store. */
const EXTENSION = 'devenv-test.fake-extension';
const EXTENSION_FILE = `${EXTENSION}-1.0.0`;

describe('the shared VS Code server of an open through a real worker (plan step 11H1)', () => {
  const { run, env, cli, log } = dockerTestContext(NAME);
  const runner = new NodeProcessRunner();
  const docker = new BootstrapDocker(runner, run.dockerPath, env, log);
  const window = workerWindow({ run, env, cli, log }, docker, { name: NAME, windowId: 'docker-test-vscode-server', vscodeServer: { commit: COMMIT, quality: 'stable' } });
  const { registry, service, paths } = window;
  const environmentId = newEnvironmentId();
  const volumeName = resourceName(REPOSITORY, environmentId);
  const containerName = volumeName;
  const monitorOfUser = engineHadMonitor({ run });
  // The store of the workers of this file (workerLocks mounts the same volume).
  const store = testVscodeVolume({ run, cli }, NAME);
  const platform = serverPlatform(cli.ok(['info', '-f', '{{.Architecture}}']).trim());
  const skipped = monitorOfUser || platform === undefined;

  function execIn(user: string, script: string): { code: number | null; out: string } {
    const result = cli.run(['exec', '-u', user, containerName, 'sh', '-c', script]);
    return { code: result.code, out: result.out.trim() };
  }

  beforeAll(async () => {
    if (skipped) {
      log.info(`The test of the shared VS Code server is skipped (a Session Monitor of the user before the tests: ${monitorOfUser}; the platform of the engine: ${platform ?? 'none'}).`);
      return;
    }
    await testHelperImage(docker, log, env);
    // Review round 1 of 11H2 (A-L5): the real monitor of the opens runs no background run during the tests (it would
    // download the newest server into the store of this file and link it into its container).
    await seedTestMonitorRun(docker, { run });
    paths.ensureDirectoriesSync();
    const seededStore = await runInVolume(docker, store, ['sh', '-c', STORE_SEED_SCRIPT, 'sh', platform!, COMMIT, EXTENSION_FILE]);
    expect(seededStore.exitCode, seededStore.stderr).toBe(0);
    const devcontainerJson = JSON.stringify(
      {
        name: 'VS Code server',
        build: { dockerfile: 'Dockerfile' },
        remoteUser: REMOTE_USER,
        runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`],
        customizations: { vscode: { extensions: [EXTENSION] } },
      },
      null,
      2,
    );
    const dockerfile = [
      `FROM ${GLIBC_BASE_IMAGE}`,
      'RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* && useradd -m dev',
      `LABEL ${TEST_RUN_LABEL}=${run.runId}`,
    ].join('\n');
    await createVolume(docker, volumeName, { [LABEL_ENVIRONMENT_ID]: environmentId, [LABEL_REPOSITORY]: REPOSITORY, [TEST_RUN_LABEL]: run.runId });
    const seeded = await runInVolume(docker, volumeName, ['sh', '-c', SEED_SCRIPT, 'sh', FOLDER, devcontainerJson, dockerfile]);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id: environmentId, repository: REPOSITORY, configPath: CONFIG_PATH, volumeName, containerName, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
  });

  afterAll(async () => {
    const leftovers = await window.dispose();
    // The store of this file carries the label of the run: removed here with the rest (the leftover check stays clean).
    removeRunObjects(cli, run.runId);
    removeTestMonitor({ run, cli });
    expect(leftovers).toEqual([]);
    expect(cli.container(containerName)).toBeUndefined();
    expect(cli.volume(store)).toBeUndefined();
  });

  it.skipIf(skipped)('the new container mounts the store read-only, and the server is linked as the remote user', async () => {
    const result = await service.openEnvironmentInWorker(environmentId, { progress: new RecordingProgress() });
    expect(result.containerName).toBe(containerName);
    const container = cli.container(containerName);
    expect(container?.State.Running).toBe(true);
    expect(container?.Mounts).toContainEqual(expect.objectContaining({ Type: 'volume', Name: store, Destination: VSCODE_STORE_TARGET, RW: false }));
    // The link of the remote user, into the store; the folders are the user's.
    const server = `${VSCODE_STORE_TARGET}/server/stable/${platform}/${COMMIT}`;
    expect(execIn(REMOTE_USER, `readlink "/home/${REMOTE_USER}/.vscode-server/bin/${COMMIT}"`).out).toBe(server);
    expect(execIn(REMOTE_USER, `test -O "/home/${REMOTE_USER}/.vscode-server" && test -O "/home/${REMOTE_USER}/.vscode-server/bin" && echo own`).out).toBe('own');
    expect(execIn(REMOTE_USER, `"/home/${REMOTE_USER}/.vscode-server/bin/${COMMIT}/bin/code-server"`).out).toBe('fake server');
    // The store is read-only in the dev container, also for root.
    expect(execIn('root', `touch ${VSCODE_STORE_TARGET}/x`).code).not.toBe(0);
    // Plan step 11H3: the list is recorded in the store, and the cached `.vsix` is in the extension cache of the user.
    expect(JSON.parse(execIn('root', `cat ${VSCODE_STORE_TARGET}/extensions/wanted/${environmentId}.json`).out)).toMatchObject({ configuration: [EXTENSION] });
    expect(execIn(REMOTE_USER, `test -O "/home/${REMOTE_USER}/.vscode-server/extensionsCache" && test -f "/home/${REMOTE_USER}/.vscode-server/extensionsCache/${EXTENSION_FILE}" && tail -c +5 "/home/${REMOTE_USER}/.vscode-server/extensionsCache/${EXTENSION_FILE}"`).out).toBe('fake vsix');
    // Never a volume of the environment: no label of it, not recorded.
    expect(cli.volume(store)?.Labels?.[LABEL_ENVIRONMENT_ID]).toBeUndefined();
    expect((await registry.get(environmentId))?.additionalVolumes ?? []).not.toContain(store);
  });

  it.skipIf(skipped)('a second open finds the server present and leaves the link as it is', async () => {
    const before = execIn(REMOTE_USER, `stat -c %i "/home/${REMOTE_USER}/.vscode-server/bin/${COMMIT}"`).out;
    await service.openEnvironmentInWorker(environmentId, { progress: new RecordingProgress() });
    expect(execIn(REMOTE_USER, `stat -c %i "/home/${REMOTE_USER}/.vscode-server/bin/${COMMIT}"`).out).toBe(before);
  });
});
