// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The open pipeline and the environment operations against the real Docker engine (concept 7.6, 7.7, 7.12, 7.14), on a
// seeded environment: a workspace volume with a Git repository, created through the workspace helper, and its registry
// entry. Its configuration builds a tiny Alpine image with Git and a non-root user `dev` with a home folder, so the
// ownership fix runs and the container-only Git (concept section 9) can be checked; it publishes one port (appPort).
// Configurations that the host access policy refuses are checked on further seeded environments. Real core modules and
// the real workspace helper; only the user interface, the GitHub session, and (for the offline scenarios) the network
// are fakes.
// Plan step 11I1, PR A2 (section 3b of the plan): every scenario runs through the flows of a real worker, as the
// extension sends them: the operations of a window (EnvironmentOperations, workerWindow.ts) send the open, Stop, the
// listing, the check of Delete, Delete, and the rebuild of the registry to the worker, whose own pipeline runs them (before:
// the pipeline in the test process over the relay of the worker, `lock` and `batch`, which 11I1 removes). The opens make
// sure of the real Session Monitor of the engine (decision D9 of 2026-10-07): the file is skipped when the engine had one
// before the tests, and removes the one that it made.
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as fs from 'fs';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
// Plan step 11I2: the Docker CLI of the extension (BootstrapDocker) in place of the removed CLI adapter ContainerAdapter.
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { ImageChecker } from '../../src/core/imageCheck/imageCheck';
import {
  CONTAINER_CREDENTIAL_HELPER,
  GIT_CREDENTIALS_CONFIG_FILE,
  HOME_GIT_CONFIG_CONTENT,
  containerEnvironment,
  containerGitSupport,
} from '../../src/core/helper/containerGit';
import { devContainersSettings } from '../../src/core/devContainers';
import { Messages } from '../../src/core/messages';
import {
  CONTAINER_VERSION,
  GH_CONFIG_FOLDER,
  GH_HOSTS_FILE,
  GH_VOLUME_CONFIG_FILE,
  GITHUB_TOKEN_FILE,
  TOKEN_FOLDER,
  TOKEN_TMPFS,
  LABEL_ENVIRONMENT_ID,
  LABEL_HELPER_RUN,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  environmentImageRepository,
  newEnvironmentId,
  resourceName,
} from '../../src/core/names';
import type { DeleteConfirmation } from '../../src/core/pipeline/deleteCheck';
import { isoTime, systemClock } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { scriptCommand } from '../../src/core/worker/containerScripts';
import { removeTokenFlow } from '../../src/core/worker/tokenRemoveFlow';
import { OLD_GIT_BASE_IMAGE, TEST_BASE_IMAGE, TEST_RUN_LABEL, familiarName, readBaseline, removeRunObjects } from './dockerRun';
import {
  DUMMY_TOKEN,
  FakeUi,
  TEST_ACCOUNT,
  RecordingProgress,
  Timings,
  createVolume,
  dockerTestContext,
  expectLabelledEnvironmentImage,
  fakeAuth,
  inConceptOrder,
  registryClient,
  registryDigest,
  registryTransport,
  runInVolume,
  testEngine,
  testHelperImage,
} from './harness';
import { monitorOfUser, removeTestMonitor, seedTestMonitorRun, workerWindow, type WorkerWindow } from './workerWindow';

const REPOSITORY = 'devenv-test/tiny';
const FOLDER = '/workspaces/tiny';
const CONFIG_PATH = '.devcontainer/devcontainer.json';
const REMOTE_USER = 'dev';
/** The port of the container that the configuration publishes (appPort); the host port is free at the start. */
const CONTAINER_PORT = 8080;
const UNTRACKED = 'untracked.txt';
const FAKE_DIGEST = `sha256:${'0'.repeat(64)}`;

/** Creates the repository in the volume as the helper creates a clone: as root, on the branch main, with one commit. */
const SEED_SCRIPT = `set -eu
mkdir -p "$1/.devcontainer"
printf '%s\\n' "$2" > "$1/.devcontainer/devcontainer.json"
printf '%s\\n' "$3" > "$1/.devcontainer/Dockerfile"
printf '# Tiny\\n' > "$1/README.md"
cd "$1"
git init -q -b main
git add -A
git -c user.name=Test -c user.email=test@example.invalid commit -q -m 'Initial commit'
`;

/**
 * Plan step 11I1, PR A2: the settings of the windows of this file (testSettings, with the image check of each open). The
 * test of the switched-off host access checks changes `hostAccessChecksOff` of the window in place.
 */
const SETTINGS = { updateImagesOnConnect: true };

/** Lifecycle token (user decision 2026-09-27): the files in the dev container where the lifecycle commands note each run. */
const POST_CREATE_LOG = '/tmp/devenv-post-create';
const POST_START_LOG = '/tmp/devenv-post-start';

/** A lifecycle command that appends `present` to `log` when the token file is there and not empty, else `missing`. */
function lifecycleTokenCommand(log: string): string {
  return `if test -s ${GITHUB_TOKEN_FILE}; then echo present; else echo missing; fi >> ${log}`;
}

/**
 * Plan step 11I1, PR A2: the user interface of the windows of this file, which also records what each confirmation of
 * Delete names. The check of Delete runs in the worker and answers the decision of the user (a DeleteDecision); the Git
 * state that it names reaches the window only in this question (before: the value of the safety check of the pipeline in the test process).
 */
class DeleteRecordingUi extends FakeUi {
  readonly deleteConfirmations: Array<{ repository: string; confirmation?: DeleteConfirmation }> = [];

  override async confirmDelete(repository: string, confirmation?: DeleteConfirmation): Promise<'delete' | 'open' | undefined> {
    this.deleteConfirmations.push({ repository, ...(confirmation === undefined ? {} : { confirmation }) });
    return super.confirmDelete(repository, confirmation);
  }
}

/** The time of a line of a TestLog in seconds since the log was opened (`[  12.3] INFO …`), of the first line that matches. */
function logSeconds(logged: string, pattern: RegExp): number {
  const line = logged.split('\n').find((candidate) => pattern.test(candidate));
  const seconds = line === undefined ? undefined : /^\[\s*(\d+(?:\.\d+)?)\]/.exec(line)?.[1];
  if (seconds === undefined) throw new Error(`No line of the log matches ${pattern}.`);
  return Number(seconds);
}

// Decision D9 of 2026-10-07: the opens through a real worker make sure of the Session Monitor of the engine; a monitor of
// the user (or of another run) is never touched, so the file is skipped then (its hooks do not run either).
const engineHadMonitor = monitorOfUser({ run: inject('dockerTest') });

describe.skipIf(engineHadMonitor)('open pipeline on a seeded environment', () => {
  const context = dockerTestContext('pipeline');
  const { run, env, cli, log } = context;
  const runner = new NodeProcessRunner();
  const docker = new BootstrapDocker(runner, run.dockerPath, env, log);
  const ui = new DeleteRecordingUi();
  const timings = new Timings();
  // The reference reading of the registry digests that the build records must name (a test oracle in this process, never
  // a part of the pipeline: the image check of the opens runs in the worker).
  const digestChecker = new ImageChecker(registryClient(registryTransport, runner, env, log), log);
  // Plan step 11I1, PR A2: the window of the opens (before: the pipeline in this process over the relay of the worker,
  // the lock and the batch operations). Its workers hold the locks in the state volume of this file.
  const window = workerWindow(context, docker, { name: 'pipeline', windowId: 'docker-test-window', ui, settings: SETTINGS });
  const { registry, sessionFiles, paths, service } = window;
  // Plan step 11I1, PR A2 (decision D1 of 2026-10-07): the offline scenarios run through a window of the same computer
  // whose workers have no network (before: a service whose registry transport failed at once). The same window ID and
  // user interface as the window above (as the services of this file had before), so that its pending files and busy
  // marks are those of this window for the later operations; the same state volume, so the same locks.
  const offline = workerWindow(context, docker, {
    name: 'pipeline',
    computer: { paths, registry, sessionFiles },
    windowId: 'docker-test-window',
    ui,
    settings: SETTINGS,
    network: 'none',
  });
  /** The windows of this file; afterAll closes them all. */
  const windows: WorkerWindow[] = [window, offline];

  /** Plan step 11I1, PR A2 (decision D2): the length of the log now, to read what an open logged after it (logSince). */
  const logMark = (): number => fs.readFileSync(log.file, 'utf8').length;
  const logSince = (mark: number): string => fs.readFileSync(log.file, 'utf8').slice(mark);

  /**
   * Plan step 11I1, PR A2 (decision D2; before: the record of the image checker of the service, one check with the status
   * `checked`): the worker's image check of the open (its log lines reach the log of the window) read the digest of the
   * base image once, and found every registry.
   */
  function expectImageChecked(logged: string): void {
    expect(logged.split(`Image check: ${TEST_BASE_IMAGE} → sha256:`).length - 1).toBe(1);
    expect(logged).not.toContain('Image check skipped');
    expect(logged).not.toContain('The update step is skipped.');
  }

  // Plan step 11B1: the removal of the token is a flow of the worker (Controller.removeGitToken sends the operation);
  // here it runs against the real engine through the worker's port. Cleanup C4 (plan step 11J): the production client over
  // the Engine API (testEngine; before: the port over the Docker CLI of the tests).
  const removeToken = (id: string, name: string) => removeTokenFlow({ environmentId: id, containerName: name, engine: testEngine(env), records: { get: (one) => registry.get(one) } });

  const environmentId = newEnvironmentId();
  const volumeName = resourceName(REPOSITORY, environmentId);
  const containerName = volumeName;
  // User decisions 2026-10-03: the image repository is the name of the environment (resourceName), so it takes the repository.
  const imageRepository = environmentImageRepository(REPOSITORY, environmentId);

  function execIn(user: string, script: string): string {
    const result = cli.run(['exec', '-u', user, containerName, 'sh', '-c', script]);
    if (result.code !== 0) throw new Error(`docker exec as ${user} failed (${result.code}): ${result.err}`);
    return result.out;
  }

  /** Files in the repository folder that do not belong to the remote user (the ownership fix gave them all to it). */
  function filesOfOtherUsers(): string {
    return execIn('root', `find ${FOLDER} -xdev ! -user ${REMOTE_USER} | head -20`);
  }

  /** The untracked file that scenario 2 wrote is still in the volume. */
  function untrackedFileKept(): boolean {
    return execIn(REMOTE_USER, `cat ${FOLDER}/${UNTRACKED}`) === 'kept';
  }

  function containersOfEnvironment(): string[] {
    return cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_ENVIRONMENT_ID}=${environmentId}`]);
  }

  /** Workspace helper containers on the volume: each helper run removes its container (`--rm`). */
  function helperContainers(): string[] {
    return cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_HELPER_RUN}=true`, '--filter', `volume=${volumeName}`]);
  }

  /** Tags of the images of this run, one list per image. */
  function runImages(): string[][] {
    // Plan step 11I1, PR A2 (first CI run of PR #117): without `-a`. The worker labels the image over the Engine API
    // (EngineDocker.labelImage, a commit), which on the classic image store is a child of the previous image: that parent
    // is kept as an untagged layer of the labelled image (review round 1 of 11B3a, A-R1-6) and goes with it. An untagged
    // image without a child (a leftover) is still listed.
    const lines = cli.lines(['image', 'ls', '--no-trunc', '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`, '--format', '{{.ID}} {{.Repository}}:{{.Tag}}']);
    const images = new Map<string, string[]>();
    for (const line of lines) {
      const [id, tag] = line.split(' ');
      const tags = images.get(id) ?? [];
      if (tag !== '<none>:<none>') tags.push(tag);
      images.set(id, tags);
    }
    return [...images.values()].map((tags) => tags.sort());
  }

  function workspaceMount(): { Type: string; Name?: string } | undefined {
    return cli.container(containerName)?.Mounts.find((mount) => mount.Destination === '/workspaces');
  }

  /** ID of the base image that was on the computer before the tests; a stopped container keeps it (beforeAll). */
  let baselineBaseId: string | undefined;
  /** Host port of appPort. */
  let hostPort = 0;

  /** A free TCP port on 127.0.0.1. */
  async function freePort(): Promise<number> {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  /** The environment variables of the container (`docker inspect`). */
  function containerEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const entry of cli.container(containerName)?.Config.Env ?? []) {
      const index = entry.indexOf('=');
      env[entry.slice(0, index)] = entry.slice(index + 1);
    }
    return env;
  }

  /** `git credential fill` as the remote user in the container, for `host`. */
  function credentialFill(host: string): { code: number | null; out: string } {
    const result = cli.run(
      ['exec', '-i', '-u', REMOTE_USER, '-e', 'GIT_TERMINAL_PROMPT=0', containerName, 'git', 'credential', 'fill'],
      `protocol=https\nhost=${host}\npath=acme/api.git\n\n`,
    );
    return { code: result.code, out: result.out };
  }

  beforeAll(async () => {
    // A base image that was on the computer before the tests stays: Docker refuses to remove an image that a container
    // uses, so this stopped container keeps the removal of unused base images (concept 7.14 step 3) away from it. (The
    // classic image store removes its digest reference, which the next pull restores.) The container holds the image,
    // not the tag: when the registry has a newer image, the first open pulls it and moves the tag away, and the delete
    // may remove that pulled image with the tag. afterAll puts the tag back on the image of the user.
    const baseline = readBaseline(run);
    const guarded = baseline.images.some((image) => image.tags.map(familiarName).includes(familiarName(TEST_BASE_IMAGE)));
    if (guarded) {
      baselineBaseId = cli.image(TEST_BASE_IMAGE)?.Id;
      cli.ok(['create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--name', `devenv-test-guard-${run.runId}`, TEST_BASE_IMAGE, 'true']);
    }

    // Plan step 11I (U7, decision of 2026-10-08): the helper image through the harness (before: ensureImage of a
    // WorkspaceHelper).
    await timings.measure('workspace helper image ready', () => testHelperImage(docker, log, env));
    // Review round 1 of 11H2 (A-L5): the real monitor of the opens runs no background run during the tests.
    await seedTestMonitorRun(docker, { run });
    paths.ensureDirectoriesSync();
    hostPort = await freePort();
    const devcontainerJson = JSON.stringify(
      {
        name: 'Tiny',
        build: { dockerfile: 'Dockerfile' },
        remoteUser: REMOTE_USER,
        // The containers of the run carry the label of the run, so the cleanup finds them.
        runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`],
        // Without an address: the extension publishes it on 127.0.0.1 only (concept section 9 "Host access").
        appPort: [`${hostPort}:${CONTAINER_PORT}`],
        // Lifecycle token (user decision 2026-09-27): each run notes whether the token was there.
        postCreateCommand: lifecycleTokenCommand(POST_CREATE_LOG),
        postStartCommand: lifecycleTokenCommand(POST_START_LOG),
      },
      null,
      2,
    );
    const dockerfile = [
      `FROM ${TEST_BASE_IMAGE}`,
      'RUN apk add --no-cache git && adduser -D dev',
      `LABEL ${TEST_RUN_LABEL}=${run.runId}`,
    ].join('\n');
    await createVolume(docker, volumeName, {
      [LABEL_ENVIRONMENT_ID]: environmentId,
      [LABEL_REPOSITORY]: REPOSITORY,
      [TEST_RUN_LABEL]: run.runId,
    });
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
    });
    log.info(`Seeded environment ${environmentId}: volume ${volumeName}.`);
  });

  afterAll(async () => {
    timings.print(`Timings of the pipeline scenarios (${TEST_BASE_IMAGE}):`);
    // Plan step 6, PR C: no worker and no batch helper is left over. Plan step 11I1, PR A2: of any window of this file;
    // they close together, since each waits until the workers of the run are gone.
    const leftovers = [...new Set((await Promise.all(windows.map((one) => one.dispose()))).flat())];
    restoreBaseImageTag();
    removeRunObjects(cli, run.runId);
    // Decision D9 of 2026-10-07: the Session Monitor that the opens made sure of, its state volume and its tag.
    removeTestMonitor(context);
    expect(leftovers).toEqual([]);
    expect(cli.container(containerName)).toBeUndefined();
    expect(cli.volume(volumeName)).toBeUndefined();
    expect(runImages()).toEqual([]);
  });

  /**
   * Puts the tag of the base image back on the image that the user had, also after a failed test: a pull may have moved
   * it to a newer image, and the delete may have removed that image with the tag. The newer image that the tests pulled
   * is removed when it has no tag anymore.
   */
  function restoreBaseImageTag(): void {
    if (baselineBaseId === undefined) return;
    const currentId = cli.image(TEST_BASE_IMAGE)?.Id;
    if (currentId === baselineBaseId) return;
    const tagged = cli.run(['tag', baselineBaseId, TEST_BASE_IMAGE]);
    if (tagged.code !== 0) {
      log.error(`The tag ${TEST_BASE_IMAGE} could not be put back on ${baselineBaseId}: ${tagged.err}`);
      return;
    }
    log.info(`The tag ${TEST_BASE_IMAGE} is back on the image of the user ${baselineBaseId.slice(7, 19)}.`);
    const baselineIds = new Set(readBaseline(run).images.map((image) => image.id));
    const pulled = currentId !== undefined && !baselineIds.has(currentId) ? cli.image(currentId) : undefined;
    if (pulled && (pulled.RepoTags ?? []).length === 0) cli.run(['image', 'rm', pulled.Id]);
  }

  it('first open: builds devenv-<short>:1 and starts the container', async () => {
    const progress = new RecordingProgress();
    const events = ui.events.length;
    const mark = logMark();
    const stepsBefore = window.steps.length;
    const result = await timings.measure(
      'first open: pull, build :1, up',
      () => service.openEnvironmentInWorker(environmentId, { progress }),
      () => progress.summary(),
    );

    expect(progress.steps).toEqual(['checkingImage', 'downloadingImage', 'preparing', 'starting']);
    expect(progress.details).not.toContain(Messages.newerImage);
    // Plan step 11I1, PR A2 (decision D2): changed expectation (before: the record of the image checker, ['checked']).
    expectImageChecked(logSince(mark));
    expect(result).toMatchObject({ containerName, remoteWorkspaceFolder: FOLDER });

    const entry = await registry.get(environmentId);
    expect(entry?.buildRecord).toMatchObject({
      environmentImage: `${imageRepository}:1`,
      buildNumber: 1,
      configPath: CONFIG_PATH,
      images: { [TEST_BASE_IMAGE]: await registryDigest(digestChecker, TEST_BASE_IMAGE) },
      features: {},
    });
    expect(entry?.buildRecord?.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // User decisions 2026-10-03: the image carries the labels of the environment and its build record; the record pins its ID.
    expectLabelledEnvironmentImage(cli, entry);
    expect(entry?.remoteUser).toBe(REMOTE_USER);
    // The full Git summary after the first creation; no remote, so the commit counts as unpushed.
    expect(entry?.gitSummary).toMatchObject({ branch: 'main', uncommittedFiles: 0, unpushedCommits: 1, stashes: 0 });
    expect(entry?.busy).toBeUndefined();
    expect(fs.existsSync(paths.pendingFile(environmentId))).toBe(true);

    const container = cli.container(containerName);
    expect(container?.State.Running).toBe(true);
    expect(container?.Name).toBe(`/${containerName}`);
    expect(container?.Config.Image).toBe(`${imageRepository}:1`);
    expect(container?.Config.Labels?.[LABEL_ENVIRONMENT_ID]).toBe(environmentId);
    expect(workspaceMount()).toMatchObject({ Type: 'volume', Name: volumeName });
    // The host name is the repository name (the shell prompt shows it), not the container ID.
    expect(container?.Config.Hostname).toBe('tiny');
    expect(execIn(REMOTE_USER, 'hostname')).toBe('tiny');
    expect(cli.image(`${imageRepository}:1`)?.Config.Labels?.['devcontainer.metadata']).toContain(REMOTE_USER);
    // The Dev Container CLI left no other image (for example a `vsc-…` image).
    expect(runImages()).toEqual([[`${imageRepository}:1`]]);

    expect(filesOfOtherUsers()).toBe('');
    expect(execIn(REMOTE_USER, `touch ${FOLDER}/.git/write-test && rm ${FOLDER}/.git/write-test && echo ok`)).toBe('ok');
    expect(helperContainers()).toEqual([]);
    // Plan step 6, PR C: the whole open (the reads, the build, `up`, the lifecycle commands, the Git files, the ownership
    // fix after `up`) ran in exactly one batch helper container, which is gone now. Plan step 11G1: the ownership fix
    // before the container is created is a step of that batch helper too (repositoryOwnershipFix); the worker reads
    // /etc/passwd of the environment image through the Engine API without running anything. Plan step 11I1, PR A2:
    // counted by the step `batch` that the worker reports for each batch helper session (workerBatchSession; before: the
    // batch sessions of the relay's lock).
    expect(window.batchesOf(volumeName, stepsBefore)).toBe(1);
    expect(ui.since(events)).toEqual([]);
    // Lifecycle token (user decision 2026-09-27): postCreateCommand and postStartCommand ran once each, with the token.
    expect(execIn(REMOTE_USER, `cat ${POST_CREATE_LOG}`)).toBe('present');
    expect(execIn(REMOTE_USER, `cat ${POST_START_LOG}`)).toBe('present');
  });

  it('container-only Git: the variables, the label, the token file, and the Git configuration of the container (concept section 9)', () => {
    expect(cli.container(containerName)?.Config.Labels?.['nimblescape.devenv.container-version']).toBe(String(CONTAINER_VERSION));
    // Review round 2 (D2-1): Docker accepts the labels of Docker Compose with empty values, so an image cannot give the
    // container the project of another Compose configuration.
    expect(cli.container(containerName)?.Config.Labels).toMatchObject({ 'com.docker.compose.project': '', 'com.docker.compose.service': '' });
    // Review round 4 (D4-2): the configuration path, for the restore after a lost registry.
    expect(cli.container(containerName)?.Config.Labels?.['nimblescape.devenv.config-path']).toBe(CONFIG_PATH);
    const env = containerEnv();
    expect(env).toMatchObject({
      GIT_CONFIG_GLOBAL: '/workspaces/.devenv+/gitconfig',
      DOCKER_CONFIG: '/workspaces/.devenv+/docker',
      GIT_SSH_COMMAND: 'ssh -o IdentityAgent=none',
      GH_CONFIG_DIR: GH_CONFIG_FOLDER,
      // Remove every credential helper, include the helpers of the user, and for github.com only the one of the container.
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'include.path',
      GIT_CONFIG_VALUE_1: GIT_CREDENTIALS_CONFIG_FILE,
      GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_2: '',
      GIT_CONFIG_KEY_3: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_3: CONTAINER_CREDENTIAL_HELPER,
    });
    // Exactly the variables of the override configuration, and none of the Dev Containers extension or of GnuPG.
    expect(env).toMatchObject(containerEnvironment());
    for (const name of ['GIT_CONFIG_PARAMETERS', 'GNUPGHOME', 'SSH_AUTH_SOCK', 'REMOTE_CONTAINERS_IPC']) expect(env).not.toHaveProperty(name);
    // No token in any variable of the container.
    expect(Object.values(env).some((value) => value.includes(DUMMY_TOKEN))).toBe(false);
    // remoteEnv for the VS Code server and the settings of the Dev Containers extension are in the last entry of the label
    // that the Dev Containers extension reads when it attaches: the variables of Git and Docker only, so the variables of
    // the Dev Containers extension and the VS Code server (SSH_AUTH_SOCK, REMOTE_CONTAINERS_IPC, BROWSER) keep their values.
    const metadata: unknown = JSON.parse(cli.container(containerName)?.Config.Labels?.['devcontainer.metadata'] ?? '[]');
    const last = (Array.isArray(metadata) ? metadata[metadata.length - 1] : undefined) as Record<string, unknown> | undefined;
    expect(last?.remoteEnv).toEqual(containerEnvironment());
    expect(last?.customizations).toEqual({ vscode: { settings: devContainersSettings() } });

    // unit 15: changed expectation, the token file is in the tmpfs /run/devenv (in memory), not in the volume: mode 600,
    // owned by the remote user, readable by it. Only it and the sign-in of the GitHub CLI (hosts.yml, the same token, the
    // owner account) hold the token; the volume holds none.
    expect(cli.container(containerName)?.HostConfig.Tmpfs).toEqual({ [TOKEN_FOLDER]: TOKEN_TMPFS.slice(TOKEN_FOLDER.length + 1) });
    expect(execIn('root', `stat -f -c %T ${TOKEN_FOLDER}`)).toBe('tmpfs');
    expect(execIn('root', `stat -c "%a %U" ${TOKEN_FOLDER}`)).toBe(`700 ${REMOTE_USER}`);
    expect(execIn('root', `stat -c "%a %U" ${GITHUB_TOKEN_FILE}`)).toBe(`600 ${REMOTE_USER}`);
    expect(execIn(REMOTE_USER, `cat ${GITHUB_TOKEN_FILE}`)).toBe(DUMMY_TOKEN);
    expect(execIn('root', `grep -rl '${DUMMY_TOKEN}' ${TOKEN_FOLDER} || true`).split('\n').sort()).toEqual([GITHUB_TOKEN_FILE, GH_HOSTS_FILE].sort());
    expect(execIn('root', `grep -rl '${DUMMY_TOKEN}' /workspaces || true`)).toBe('');
    expect(execIn('root', 'stat -c "%a %U" /workspaces/.devenv+/docker')).toBe(`700 ${REMOTE_USER}`);
    expect(execIn('root', `stat -c "%a %U" ${GH_CONFIG_FOLDER}`)).toBe(`700 ${REMOTE_USER}`);
    expect(execIn('root', `stat -c "%a %U" ${GH_HOSTS_FILE}`)).toBe(`600 ${REMOTE_USER}`);
    const hosts = execIn(REMOTE_USER, `cat ${GH_HOSTS_FILE}`);
    expect(hosts).toContain(`oauth_token: "${DUMMY_TOKEN}"`);
    expect(hosts).toContain(`user: "${TEST_ACCOUNT.login}"`);
    // gh's settings stay in the volume: config.yml is a link there, which the remote user can write through.
    expect(execIn('root', `readlink ${GH_CONFIG_FOLDER}/config.yml`)).toBe(GH_VOLUME_CONFIG_FILE);
    expect(execIn(REMOTE_USER, `printf 'editor: vi\\n' > ${GH_CONFIG_FOLDER}/config.yml && cat ${GH_VOLUME_CONFIG_FILE}`)).toBe('editor: vi');
    // No GnuPG folder of the extension: GnuPG works where the image sets it up. unit 15: no token file in the volume.
    expect(execIn('root', 'ls -A /workspaces/.devenv+').split('\n').sort()).toEqual(['credentials.gitconfig', 'docker', 'gh', 'gitconfig']);
    expect(execIn('root', 'ls -A /workspaces/.devenv+/gh')).toBe('config.yml');

    // Git reads only the configuration of the container; the ~/.gitconfig of the extension includes it for Git without
    // the variables. No ~/.config/git/config of the extension.
    expect(execIn(REMOTE_USER, 'git config --global --list').split('\n')).toEqual([
      `user.name=${TEST_ACCOUNT.login}`,
      `user.email=${TEST_ACCOUNT.id}+${TEST_ACCOUNT.login}@users.noreply.github.com`,
      'credential.https://github.com.helper=',
      `credential.https://github.com.helper=${CONTAINER_CREDENTIAL_HELPER}`,
    ]);
    expect(execIn(REMOTE_USER, 'cat ~/.gitconfig')).toBe(HOME_GIT_CONFIG_CONTENT.trim());
    expect(execIn(REMOTE_USER, 'test -e ~/.config/git/config && echo exists || echo missing')).toBe('missing');
    expect(execIn(REMOTE_USER, 'git config --show-origin --get user.email')).toContain('file:/workspaces/.devenv+/gitconfig');

    // The credential helper answers for https://github.com with the token, and for no other host.
    const github = credentialFill('github.com');
    expect(github.code).toBe(0);
    expect(github.out).toContain('username=x-access-token');
    expect(github.out).toContain(`password=${DUMMY_TOKEN}`);
    const other = credentialFill('example.com');
    expect(other.code).not.toBe(0);
    expect(other.out).not.toContain(DUMMY_TOKEN);
  });

  it('container-only Git: a credential helper of the user in credentials.gitconfig answers for its host, never for github.com', () => {
    // No single quote in the value: the shell command below quotes it with single quotes.
    const userHelper = (password: string): string => `!f() { test "$1" = get && printf "username=u\\npassword=${password}\\n"; }; f`;
    const set = (key: string, value: string): string =>
      execIn(REMOTE_USER, `git config --file '${GIT_CREDENTIALS_CONFIG_FILE}' --add '${key}' '${value}' && echo ok`);
    try {
      expect(set('credential.https://gitlab.example.com.helper', userHelper('from-the-user'))).toBe('ok');
      expect(set('credential.https://github.com.helper', userHelper('not-for-github'))).toBe('ok');
      const gitlab = credentialFill('gitlab.example.com');
      expect(gitlab.code).toBe(0);
      expect(gitlab.out).toContain('password=from-the-user');
      const github = credentialFill('github.com');
      expect(github.code).toBe(0);
      expect(github.out).toContain(`password=${DUMMY_TOKEN}`);
      expect(github.out).not.toContain('not-for-github');
    } finally {
      execIn(REMOTE_USER, `git config --file '${GIT_CREDENTIALS_CONFIG_FILE}' --remove-section 'credential.https://gitlab.example.com' || true`);
      execIn(REMOTE_USER, `git config --file '${GIT_CREDENTIALS_CONFIG_FILE}' --remove-section 'credential.https://github.com' || true`);
    }
  });

  it('container-only Git: without the token file (removed when a window of another account leaves), Git gets no password', () => {
    // unit 15: changed expectation, the token file is in the tmpfs.
    const token = GITHUB_TOKEN_FILE;
    execIn('root', `cp -p ${token} /tmp/devenv-token-backup && rm -f ${token}`);
    try {
      const github = credentialFill('github.com');
      expect(github.code).not.toBe(0);
      expect(github.out).not.toContain('password=');
    } finally {
      execIn('root', `mv /tmp/devenv-token-backup ${token}`);
    }
    expect(execIn('root', `stat -c "%a %U" ${token}`)).toBe(`600 ${REMOTE_USER}`);
  });

  it('host access: appPort is published on 127.0.0.1 only', () => {
    expect(cli.lines(['port', containerName])).toEqual([`${CONTAINER_PORT}/tcp -> 127.0.0.1:${hostPort}`]);
  });

  it('network: the container reaches a service on the computer (host.docker.internal)', async (context) => {
    const resolved = cli.run(['exec', containerName, 'sh', '-c', 'getent hosts host.docker.internal || nslookup host.docker.internal']);
    // Docker Engine on Linux has the name only with --add-host host.docker.internal:host-gateway.
    if (resolved.code !== 0) context.skip();
    const server = http.createServer((_request, response) => response.end('hello from the computer'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      // Not with the synchronous DockerCli: the server of this process must answer while Docker runs the request.
      const result = await runner.run(run.dockerPath, ['exec', containerName, 'wget', '-q', '-T', '10', '-O', '-', `http://host.docker.internal:${port}/`], { env });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe('hello from the computer');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('stop: records the Git summary, then stops the container', async () => {
    expect(execIn(REMOTE_USER, `cd ${FOLDER} && printf kept > ${UNTRACKED} && echo ok`)).toBe('ok');
    const started = Date.now();
    await timings.measure('stop', () => service.stop(environmentId));

    const summary = (await registry.get(environmentId))?.gitSummary;
    expect(summary).toMatchObject({ branch: 'main', uncommittedFiles: 1, unpushedCommits: 1, stashes: 0 });
    expect(Date.parse(summary?.recordedAt ?? '')).toBeGreaterThanOrEqual(started - 1000);
    expect(cli.container(containerName)?.State.Status).toBe('exited');
  });

  it('unit 15: the token is gone when the container stops, and a docker start without the extension does not bring it back', () => {
    cli.ok(['start', containerName]);
    try {
      expect(execIn('root', `stat -f -c %T ${TOKEN_FOLDER} && ls -A ${TOKEN_FOLDER}`)).toBe('tmpfs');
      expect(execIn('root', `grep -rl '${DUMMY_TOKEN}' /run /workspaces /home /root /tmp 2>/dev/null || true`)).toBe('');
      // Git gets no password, and says nothing of the token.
      const github = credentialFill('github.com');
      expect(github.code).not.toBe(0);
      expect(github.out).not.toContain('password=');
    } finally {
      cli.ok(['stop', containerName]);
    }
  });

  it('open again with the image up to date: no pull, no build, the same container starts', async () => {
    const before = await registry.get(environmentId);
    const containerId = cli.container(containerName)?.Id;
    const progress = new RecordingProgress();
    const events = ui.events.length;
    const mark = logMark();
    const result = await timings.measure(
      'open again, up to date',
      () => service.openEnvironmentInWorker(environmentId, { progress }),
      () => progress.summary(),
    );

    expect(progress.steps).toEqual(['checkingImage', 'starting']);
    // Plan step 11I1, PR A2 (decision D2): changed expectation (before: the record of the image checker, ['checked']).
    expectImageChecked(logSince(mark));
    const container = cli.container(containerName);
    expect(container?.Id).toBe(containerId);
    expect(container?.State.Running).toBe(true);
    const after = await registry.get(environmentId);
    expect(after?.buildRecord).toEqual(before?.buildRecord);
    expect(after?.gitSummary).toMatchObject({ branch: 'main', uncommittedFiles: 1 });
    // Review round 1 of PR #124 (A, T-1): the branch script of the registry, as readBranch runs it, in this container
    // (Alpine, BusyBox ash): the summary above may still be an earlier record, this read is of now.
    expect(cli.ok(['exec', '-u', REMOTE_USER, containerName, ...scriptCommand('branch', [FOLDER])]).trim()).toBe('main');
    expect(cli.image(`${imageRepository}:2`)).toBeUndefined();
    expect(untrackedFileKept()).toBe(true);
    expect(result.remoteWorkspaceFolder).toBe(FOLDER);
    expect(ui.since(events)).toEqual([]);
    // Lifecycle token (user decision 2026-09-27): postStartCommand ran again, with the token; postCreateCommand did not.
    expect(execIn(REMOTE_USER, `cat ${POST_CREATE_LOG}`)).toBe('present');
    expect(execIn(REMOTE_USER, `cat ${POST_START_LOG}`).split('\n')).toEqual(['present', 'present']);
  });

  it('unit 15: after stop and start, the open writes the token into the memory of the container again', () => {
    expect(execIn(REMOTE_USER, `cat ${GITHUB_TOKEN_FILE}`)).toBe(DUMMY_TOKEN);
    expect(execIn(REMOTE_USER, `cat ${GH_HOSTS_FILE}`)).toContain(`oauth_token: "${DUMMY_TOKEN}"`);
    expect(credentialFill('github.com').out).toContain(`password=${DUMMY_TOKEN}`);
    expect(execIn('root', `grep -rl '${DUMMY_TOKEN}' /workspaces || true`)).toBe('');
  });

  it('unit 15: a sign-out or an account change removes the token from the memory of the running container', async () => {
    // As the controller does it (Controller.removeGitToken).
    const container = cli.container(containerName);
    expect(container?.State.Running).toBe(true);
    expect(await removeToken(environmentId, containerName)).toEqual({ outcome: 'removed', container: container!.Id.slice(0, 12) });
    expect(execIn('root', `ls -A ${TOKEN_FOLDER}`)).toBe('');
    expect(execIn('root', `grep -rl '${DUMMY_TOKEN}' ${TOKEN_FOLDER} /workspaces || true`)).toBe('');
    const github = credentialFill('github.com');
    expect(github.code).not.toBe(0);
    expect(github.out).not.toContain('password=');
    // The next open of the owner writes it again.
    await service.openEnvironmentInWorker(environmentId, { progress: new RecordingProgress() });
    expect(execIn(REMOTE_USER, `cat ${GITHUB_TOKEN_FILE}`)).toBe(DUMMY_TOKEN);
  });

  it('a container without the label nimblescape.devenv.container-version is not current and is created again, without a build', async () => {
    // A container of an older setup: the ID label, the workspace volume, no version label.
    cli.ok(['rm', '-f', containerName]);
    const oldId = cli.ok([
      'create',
      '--name',
      containerName,
      '--label',
      `${LABEL_ENVIRONMENT_ID}=${environmentId}`,
      '--label',
      `${TEST_RUN_LABEL}=${run.runId}`,
      '--mount',
      `type=volume,source=${volumeName},target=/workspaces`,
      '--entrypoint',
      'sh',
      `${imageRepository}:1`,
      '-c',
      'sleep 3600',
    ]);
    const progress = new RecordingProgress();
    const events = ui.events.length;
    await timings.measure('create an old container again', () => service.openEnvironmentInWorker(environmentId, { progress }), () => progress.summary());

    expect(progress.steps).toEqual(['checkingImage', 'starting']);
    const container = cli.container(containerName);
    expect(container?.Id).not.toBe(oldId);
    expect(container?.State.Running).toBe(true);
    expect(container?.Config.Image).toBe(`${imageRepository}:1`);
    expect(container?.Config.Labels?.['nimblescape.devenv.container-version']).toBe(String(CONTAINER_VERSION));
    expect(containerEnv().GIT_CONFIG_GLOBAL).toBe('/workspaces/.devenv+/gitconfig');
    // unit 15: the token is in the tmpfs of the new container.
    expect(execIn(REMOTE_USER, `cat ${GITHUB_TOKEN_FILE}`)).toBe(DUMMY_TOKEN);
    expect(containersOfEnvironment()).toHaveLength(1);
    expect(cli.image(`${imageRepository}:2`)).toBeUndefined();
    expect(untrackedFileKept()).toBe(true);
    expect(workspaceMount()?.Name).toBe(volumeName);
    expect(ui.since(events)).toEqual([]);
  });

  it('a newer base image: pull, build :2, replace the container, keep the files, remove the old image', async () => {
    await registry.updateEnvironment(environmentId, (entry) => {
      if (entry.buildRecord) entry.buildRecord.images[TEST_BASE_IMAGE] = FAKE_DIGEST;
    });
    const containerBefore = cli.container(containerName);
    const progress = new RecordingProgress();
    const events = ui.events.length;
    const started = Date.now();
    const result = await timings.measure(
      'update: pull, build :2, replace the container',
      () => service.openEnvironmentInWorker(environmentId, { progress }),
      () => progress.summary(),
    );

    expect(progress.steps).toEqual(['checkingImage', 'downloadingImage', 'preparing', 'starting']);
    expect(inConceptOrder(progress.steps)).toBe(true);
    expect(progress.details).toContain(Messages.newerImage);
    expect(cli.image(`${imageRepository}:2`)).toBeDefined();
    expect(cli.image(`${imageRepository}:1`)).toBeUndefined();
    expect(runImages()).toEqual([[`${imageRepository}:2`]]);

    const container = cli.container(containerName);
    expect(container?.Id).not.toBe(containerBefore?.Id);
    expect(container?.Name).toBe(`/${containerName}`);
    expect(container?.Config.Image).toBe(`${imageRepository}:2`);
    expect(container?.State.Running).toBe(true);
    expect(containersOfEnvironment()).toHaveLength(1);
    expect(workspaceMount()?.Name).toBe(volumeName);
    expect(untrackedFileKept()).toBe(true);
    expect(filesOfOtherUsers()).toBe('');

    const entry = await registry.get(environmentId);
    expect(entry?.buildRecord).toMatchObject({
      environmentImage: `${imageRepository}:2`,
      buildNumber: 2,
      images: { [TEST_BASE_IMAGE]: await registryDigest(digestChecker, TEST_BASE_IMAGE) },
    });
    expect(Date.parse(entry?.buildRecord?.builtAt ?? '')).toBeGreaterThanOrEqual(started - 1000);
    // User decisions 2026-10-03: the new image is labelled too, and the record pins its ID.
    expectLabelledEnvironmentImage(cli, entry);
    expect(entry?.busy).toBeUndefined();
    expect(result.remoteWorkspaceFolder).toBe(FOLDER);
    expect(ui.since(events)).toEqual([]);
    expect(helperContainers()).toEqual([]);
  });

  it('offline: an information message, and the container starts within the time limit of the check', async () => {
    await service.stop(environmentId);
    expect(cli.container(containerName)?.State.Status).toBe('exited');
    const containerId = cli.container(containerName)?.Id;
    const record = (await registry.get(environmentId))?.buildRecord;

    // No network: each request fails at once. Plan step 11I1, PR A2 (decision D1 of 2026-10-07): the open of the window
    // whose workers have no network. Deleted with D1 (they test behaviour that the worker no longer has): the open with a
    // registry that never answers (the 5 seconds of NFR-08 there), and the due weekly check of the base image of the
    // helper of a new window (its lookup, its record, and its overlap with the image check).
    const progress = new RecordingProgress();
    const events = ui.events.length;
    const mark = logMark();
    await timings.measure('open offline (no network)', () => offline.service.openEnvironmentInWorker(environmentId, { progress }), () => progress.summary());
    // Decision D2 of 2026-10-07: changed expectation (before: the record of the image checker, one check `unreachable`
    // within 5000 ms): the worker logged one check that reached no registry, and its time from the step `checkingImage`
    // (the progress line of the window) to that line is within the limit of the check (the log has tenths of seconds).
    const logged = logSince(mark);
    expect(logged.split('The update step is skipped.').length - 1).toBe(1);
    const skipped = /No connection to .+\. The update step is skipped\./;
    expect(logged).toMatch(skipped);
    const waited = logSeconds(logged, skipped) - logSeconds(logged, /: checkingImage$/);
    timings.add('  check without network, from the step to its end in the log', waited * 1000);
    expect(waited).toBeLessThanOrEqual(5.1);
    expect(ui.since(events)).toEqual([{ kind: 'info', text: Messages.registryUnreachable }]);
    expect(progress.steps).toEqual(['checkingImage', 'starting']);
    expect(cli.container(containerName)).toMatchObject({ Id: containerId, State: { Running: true } });

    expect((await registry.get(environmentId))?.buildRecord).toEqual(record);
    expect(cli.image(`${imageRepository}:3`)).toBeUndefined();
  });

  it('a container removed outside of the extension is created again, offline, from the environment image', async () => {
    const containerId = cli.container(containerName)?.Id;
    cli.ok(['rm', '-f', containerName]);
    const progress = new RecordingProgress();
    const events = ui.events.length;
    const result = await timings.measure(
      'create the removed container again, offline',
      // Plan step 11I1, PR A2 (decision D1): the window whose workers have no network.
      () => offline.service.openEnvironmentInWorker(environmentId, { progress }),
      () => progress.summary(),
    );

    expect(progress.steps).toEqual(['checkingImage', 'starting']);
    const container = cli.container(containerName);
    expect(container?.Id).not.toBe(containerId);
    expect(container?.State.Running).toBe(true);
    expect(container?.Config.Image).toBe(`${imageRepository}:2`);
    expect(container?.Config.Labels?.[LABEL_ENVIRONMENT_ID]).toBe(environmentId);
    expect(workspaceMount()?.Name).toBe(volumeName);
    expect(cli.image(`${imageRepository}:3`)).toBeUndefined();
    expect(untrackedFileKept()).toBe(true);
    expect(filesOfOtherUsers()).toBe('');
    expect(ui.since(events)).toEqual([{ kind: 'info', text: Messages.registryUnreachable }]);
    expect(result.remoteWorkspaceFolder).toBe(FOLDER);
  });

  it('recreate offer: a container whose /etc/passwd lacks the remote user; Cancel changes nothing, Recreate creates it again and keeps the files', async () => {
    const damagedId = cli.container(containerName)?.Id;
    const image = cli.container(containerName)?.Config.Image;
    // A file outside the volumes, which the recreation removes, and the damage: the remote user is gone from /etc/passwd.
    execIn(REMOTE_USER, 'echo outside > /tmp/outside-the-volume');
    cli.ok(['exec', '-u', '0', containerName, 'sh', '-c', `sed -i '/^${REMOTE_USER}:/d' /etc/passwd`]);
    cli.ok(['stop', '-t', '1', containerName]);

    // Cancel: `up` of the stopped container fails in the Dev Container CLI (it cannot exec as the user); nothing is removed.
    // Plan step 11I1, PR A2: through the window without network (decision D1), as before through the offline service; the
    // question comes through the requests of the worker to the user interface of the window. The worker answers the
    // refusal of its pipeline as its value, which the window throws as the UserFacingError (code and detail) it was.
    ui.recreateAnswer = false;
    let events = ui.events.length;
    const cancelled = await timings.measure('damaged container, Cancel', () =>
      offline.service.openEnvironmentInWorker(environmentId, { progress: new RecordingProgress() }).then(() => undefined, (caught: unknown) => caught),
    );
    expect(cancelled).toMatchObject({ code: 'startFailed' });
    expect((cancelled as { detail?: string }).detail).toContain(`unable to find user ${REMOTE_USER}`);
    expect(ui.since(events).filter((event) => event.kind === 'recreateContainer')).toEqual([
      { kind: 'recreateContainer', text: `${REPOSITORY}: ${Messages.containerRecreateQuestion(REPOSITORY, false)}` },
    ]);
    expect(cli.container(containerName)?.Id).toBe(damagedId);
    expect(cli.volume(volumeName)).toBeDefined();

    // Recreate: the failed `up` left the container running; the check as the remote user finds the damage again.
    ui.recreateAnswer = true;
    events = ui.events.length;
    const progress = new RecordingProgress();
    const result = await timings.measure('damaged container, Recreate', () => offline.service.openEnvironmentInWorker(environmentId, { progress }), () => progress.summary());

    expect(ui.since(events).filter((event) => event.kind === 'recreateContainer')).toHaveLength(1);
    expect(progress.details).toContain(Messages.containerRecreatedDamaged());
    expect(progress.steps).not.toContain('preparing');
    const container = cli.container(containerName);
    expect(container?.Id).not.toBe(damagedId);
    expect(container?.State.Running).toBe(true);
    expect(container?.Config.Image).toBe(image);
    expect(containersOfEnvironment()).toHaveLength(1);
    // The user exists again, the files in the volume are kept, the file outside it is gone.
    expect(execIn(REMOTE_USER, 'id -un')).toBe(REMOTE_USER);
    expect(untrackedFileKept()).toBe(true);
    expect(workspaceMount()?.Name).toBe(volumeName);
    expect(execIn(REMOTE_USER, 'test -e /tmp/outside-the-volume && echo present || echo gone')).toBe('gone');
    // postCreateCommand ran again in the new container, with the token.
    expect(execIn(REMOTE_USER, `cat ${POST_CREATE_LOG}`)).toBe('present');
    expect(execIn(REMOTE_USER, `cat ${GITHUB_TOKEN_FILE}`)).toBe(DUMMY_TOKEN);
    expect(result.remoteWorkspaceFolder).toBe(FOLDER);
    expect((await registry.get(environmentId))?.busy).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a bind mount', { mounts: ['source=/tmp,target=/host-tmp,type=bind'] }, 'bind mount /tmp'],
    ['privileged mode', { privileged: true }, 'privileged mode'],
    // Restrictions summary, findings 5 and 6: the values of runArgs would replace those of the extension.
    [
      'a label of Dev Environments',
      { runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`, '--label', `${LABEL_ENVIRONMENT_ID}=someone-else`] },
      `label ${LABEL_ENVIRONMENT_ID}`,
    ],
    [
      'a variable of container-only Git',
      { runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`, '-e', 'GIT_CONFIG_GLOBAL=/tmp/gitconfig'] },
      'variable GIT_CONFIG_GLOBAL in runArgs',
    ],
    [
      'the Docker socket of a Feature (docker-outside-of-docker)',
      { features: { 'ghcr.io/devcontainers/features/docker-outside-of-docker:1': {} } },
      'bind mount /var/run/docker.sock',
    ],
  ])('host access: a configuration with %s is refused before any build; the volume stays', async (_name, extra, item) => {
    const id = newEnvironmentId();
    const name = resourceName('devenv-test/refused', id);
    const config = JSON.stringify({ name: 'Refused', build: { dockerfile: 'Dockerfile' }, runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`], ...extra });
    const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, `LABEL ${TEST_RUN_LABEL}=${run.runId}`].join('\n');
    await createVolume(docker, name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: 'devenv-test/refused', [TEST_RUN_LABEL]: run.runId });
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image (runInVolume).
    const seeded = await runInVolume(docker, name, ['sh', '-c', SEED_SCRIPT, 'sh', '/workspaces/refused', config, dockerfile]);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id, repository: 'devenv-test/refused', configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
    try {
      const progress = new RecordingProgress();
      const error = await timings.measure(`refuse ${item}`, () => service.openEnvironmentInWorker(id, { progress }).then(() => undefined, (caught: unknown) => caught));
      // Plan step 11I1, PR A2: the worker answers the refusal of its pipeline as its value; the window throws it as the
      // UserFacingError that it was (refusalError: its code and message).
      expect(error).toMatchObject({ code: 'hostAccess' });
      expect((error as Error).message).toContain(item);
      expect(progress.steps).not.toContain('preparing');
      expect(cli.lines(['image', 'ls', '-q', environmentImageRepository('devenv-test/refused', id)])).toEqual([]);
      expect(cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_ENVIRONMENT_ID}=${id}`])).toEqual([]);
      // NFR-07: the environment keeps its volume.
      expect(cli.volume(name)).toBeDefined();
      expect(await registry.get(id)).toBeDefined();
    } finally {
      await registry.remove(id);
      cli.run(['volume', 'rm', name]);
    }
  });

  it('host access: a volume of a Docker Compose project is refused by its labels before any build; both volumes stay', async () => {
    // A volume of the run, labelled as Docker Compose labels the volumes of its projects (for example a database).
    const composeVolume = `devenv-test-compose-${run.runId}_data`;
    cli.ok(['volume', 'create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--label', 'com.docker.compose.project=devenv-test', '--label', 'com.docker.compose.volume=data', composeVolume]);
    const id = newEnvironmentId();
    const repository = 'devenv-test/compose-volume';
    const name = resourceName(repository, id);
    const config = JSON.stringify({
      name: 'Compose volume',
      build: { dockerfile: 'Dockerfile' },
      runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`],
      mounts: [`source=${composeVolume},target=/data,type=volume`],
    });
    const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, `LABEL ${TEST_RUN_LABEL}=${run.runId}`].join('\n');
    await createVolume(docker, name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [TEST_RUN_LABEL]: run.runId });
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image (runInVolume).
    const seeded = await runInVolume(docker, name, ['sh', '-c', SEED_SCRIPT, 'sh', '/workspaces/compose-volume', config, dockerfile]);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id, repository, configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
    try {
      const progress = new RecordingProgress();
      const error = await service.openEnvironmentInWorker(id, { progress }).then(() => undefined, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'hostAccess' });
      expect((error as Error).message).toContain(`volume ${composeVolume} of the Docker Compose project devenv-test`);
      expect(progress.steps).not.toContain('preparing');
      expect(cli.lines(['image', 'ls', '-q', environmentImageRepository(repository, id)])).toEqual([]);
      expect(cli.lines(['ps', '-a', '-q', '--filter', `volume=${composeVolume}`])).toEqual([]);
      expect(cli.volume(name)).toBeDefined();
      expect(cli.volume(composeVolume)).toBeDefined();
    } finally {
      await registry.remove(id);
      cli.run(['volume', 'rm', name]);
      cli.run(['volume', 'rm', composeVolume]);
    }
  });

  it('container-only Git with Git 2.30 (it ignores GIT_CONFIG_GLOBAL and GIT_CONFIG_COUNT): the token and the identity of the owner', async () => {
    const id = newEnvironmentId();
    const repository = 'devenv-test/old-git';
    const name = resourceName(repository, id);
    const config = JSON.stringify({ name: 'Old Git', build: { dockerfile: 'Dockerfile' }, remoteUser: REMOTE_USER, runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`] });
    const dockerfile = [`FROM ${OLD_GIT_BASE_IMAGE}`, 'RUN apk add --no-cache git && adduser -D dev', `LABEL ${TEST_RUN_LABEL}=${run.runId}`].join('\n');
    // A base image that the user had stays; one that this test pulled goes at the end.
    const pulledHere = !readBaseline(run).images.some((image) => image.tags.map(familiarName).includes(familiarName(OLD_GIT_BASE_IMAGE)));
    await createVolume(docker, name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [TEST_RUN_LABEL]: run.runId });
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image (runInVolume).
    const seeded = await runInVolume(docker, name, ['sh', '-c', SEED_SCRIPT, 'sh', '/workspaces/old-git', config, dockerfile]);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id, repository, configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
    const asUser = (args: string[], input?: string) => cli.run(['exec', ...(input === undefined ? [] : ['-i']), '-u', REMOTE_USER, '-e', 'GIT_TERMINAL_PROMPT=0', name, ...args], input);
    try {
      const events = ui.events.length;
      await timings.measure('first open with Git 2.30', () => service.openEnvironmentInWorker(id, { progress: new RecordingProgress() }));
      const version = asUser(['git', '--version']).out;
      expect(containerGitSupport(version), version).toBe('noGlobalVariable');
      // Git 2.9 to 2.31 gets no warning (only a log line).
      expect(ui.since(events)).toEqual([]);
      // The identity of the volume, through the include of the ~/.gitconfig of the extension.
      expect(asUser(['git', 'config', '--get', 'user.email']).out).toBe(`${TEST_ACCOUNT.id}+${TEST_ACCOUNT.login}@users.noreply.github.com`);
      // The credential helper of the container through the include of ~/.gitconfig (Git 2.30 reads no GIT_CONFIG_COUNT):
      // the token for github.com, nothing for others.
      const github = asUser(['git', 'credential', 'fill'], 'protocol=https\nhost=github.com\npath=acme/api.git\n\n');
      expect(github.code).toBe(0);
      expect(github.out).toContain(`password=${DUMMY_TOKEN}`);
      const other = asUser(['git', 'credential', 'fill'], 'protocol=https\nhost=example.com\npath=acme/api.git\n\n');
      expect(other.code).not.toBe(0);
      expect(other.out).not.toContain(DUMMY_TOKEN);
    } finally {
      await registry.remove(id);
      cli.run(['rm', '-f', name]);
      for (const image of cli.lines(['image', 'ls', '-q', environmentImageRepository(repository, id)])) cli.run(['image', 'rm', '-f', image]);
      cli.run(['volume', 'rm', name]);
      if (pulledHere) cli.run(['image', 'rm', OLD_GIT_BASE_IMAGE]);
    }
  });

  it('host access: --platform linux/amd64, --cap-drop ALL, --rm, and -it pass; --rm and -it are not passed, and the user writes ~/.gitconfig', async () => {
    const id = newEnvironmentId();
    const repository = 'devenv-test/no-rights';
    const name = resourceName(repository, id);
    const config = JSON.stringify({
      name: 'No rights',
      // The image is built for the platform of the container (on Apple silicon, amd64 runs emulated).
      build: { dockerfile: 'Dockerfile', options: ['--platform=linux/amd64'] },
      remoteUser: REMOTE_USER,
      runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`, '--platform', 'linux/amd64', '--cap-drop', 'ALL', '--rm', '-it'],
    });
    const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, 'RUN adduser -D dev', `LABEL ${TEST_RUN_LABEL}=${run.runId}`].join('\n');
    await createVolume(docker, name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [TEST_RUN_LABEL]: run.runId });
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image (runInVolume).
    const seeded = await runInVolume(docker, name, ['sh', '-c', SEED_SCRIPT, 'sh', '/workspaces/no-rights', config, dockerfile]);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id, repository, configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
    try {
      await timings.measure('first open with --platform linux/amd64, --cap-drop ALL, --rm, -it', () => service.openEnvironmentInWorker(id, { progress: new RecordingProgress() }));
      const container = cli.container(name);
      expect(container?.State.Running).toBe(true);
      expect(container?.HostConfig.AutoRemove).toBe(false);
      expect(container?.HostConfig.CapDrop).toEqual(['ALL']);
      expect(container?.Config.Tty).toBe(false);
      expect(container?.Config.OpenStdin).toBe(false);
      expect(cli.image(container!.Config.Image)?.Architecture).toBe('amd64');
      expect(fs.readFileSync(log.file, 'utf8')).toContain(`Removed from the runArgs of ${repository}: --rm (`);
      // Without its capabilities, root may not write into the home folder of the user: the user wrote ~/.gitconfig.
      const gitconfig = cli.run(['exec', '-u', REMOTE_USER, name, 'sh', '-c', 'stat -c %U ~/.gitconfig && grep -c "^\\[include\\]" ~/.gitconfig']);
      expect(gitconfig.out, gitconfig.err).toBe(`${REMOTE_USER}\n1`);
      // Unit 15: nor may root give the token in the tmpfs to the user: nothing is left there, and the user learns that Git
      // in the environment could not be prepared.
      expect(cli.run(['exec', '-u', 'root', name, 'ls', '-A', TOKEN_FOLDER]).out).toBe('');
      expect(ui.events.some((event) => JSON.stringify(event).includes(Messages.gitSetupFailed))).toBe(true);
      // Without --rm, a stop keeps the container. Plan step 11I2: `docker stop` by the Docker CLI of the test harness (was:
      // stopContainer of the removed CLI adapter ContainerAdapter, the same call).
      cli.ok(['stop', name]);
      expect(cli.container(name)?.State.Running).toBe(false);
    } finally {
      await registry.remove(id);
      cli.run(['rm', '-f', name]);
      for (const image of cli.lines(['image', 'ls', '-q', environmentImageRepository(repository, id)])) cli.run(['image', 'rm', '-f', image]);
      cli.run(['volume', 'rm', name]);
    }
  });

  /**
   * Review of unit 15: an environment of the base image of the tests with `runArgs`, opened once; `check` runs while the
   * container runs. Everything is removed at the end (also the anonymous volumes of the container).
   */
  async function withEnvironment(repository: string, runArgs: string[], check: (name: string, id: string) => Promise<void>, dockerfileLines: string[] = []): Promise<void> {
    const id = newEnvironmentId();
    const name = resourceName(repository, id);
    const config = JSON.stringify({ name: repository, build: { dockerfile: 'Dockerfile' }, remoteUser: REMOTE_USER, runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`, ...runArgs] });
    const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, 'RUN adduser -D dev', ...dockerfileLines, `LABEL ${TEST_RUN_LABEL}=${run.runId}`].join('\n');
    await createVolume(docker, name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [TEST_RUN_LABEL]: run.runId });
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image (runInVolume).
    const seeded = await runInVolume(docker, name, ['sh', '-c', SEED_SCRIPT, 'sh', `/workspaces/${repository.split('/')[1]}`, config, dockerfile]);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id, repository, configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
    try {
      await timings.measure(`first open of ${repository}`, () => service.openEnvironmentInWorker(id, { progress: new RecordingProgress() }));
      expect(cli.container(name)?.State.Running).toBe(true);
      await check(name, id);
    } finally {
      await registry.remove(id);
      cli.run(['rm', '-f', '-v', name]);
      for (const image of cli.lines(['image', 'ls', '-q', environmentImageRepository(repository, id)])) cli.run(['image', 'rm', '-f', image]);
      cli.run(['volume', 'rm', name]);
    }
  }

  it('review of unit 15 (T1): a volume on /var/run (the link of the image to /run) hides the tmpfs: nothing is written, the open warns', async () => {
    const events = ui.events.length;
    // The image has /run/devenv, so the volume (an anonymous one, filled from the image) has the folder too.
    await withEnvironment(
      'devenv-test/var-run-volume',
      ['-v', '/var/run'],
      async (name) => {
        expect(ui.since(events).some((event) => JSON.stringify(event).includes(Messages.gitSetupFailed))).toBe(true);
        const found = cli.run(['exec', '-u', 'root', name, 'sh', '-c', `grep -rl '${DUMMY_TOKEN}' /run /var/run /workspaces 2>/dev/null || true`]);
        expect(found.out).toBe('');
        expect(fs.readFileSync(log.file, 'utf8')).toMatch(/is not (a tmpfs mount|the tmpfs) of the container/);
      },
      ['RUN mkdir -p /run/devenv'],
    );
  });

  it('review of unit 15 (P1): with --cap-drop DAC_OVERRIDE and a user other than root, the token is written, a second open works, a sign-out removes it', async () => {
    await withEnvironment('devenv-test/no-dac-override', ['--cap-drop', 'DAC_OVERRIDE'], async (name, id) => {
      const asUser = (script: string) => cli.run(['exec', '-u', REMOTE_USER, name, 'sh', '-c', script]);
      expect(asUser(`cat ${GITHUB_TOKEN_FILE}`).out).toBe(DUMMY_TOKEN);
      // What the user may do in its folder, then a second open (the container runs).
      expect(asUser(`cd ${TOKEN_FOLDER} && mkdir -p x/y && ln -s / l && chmod 000 x/y x gh && chmod 000 ${TOKEN_FOLDER}`).code).toBe(0);
      const events = ui.events.length;
      await service.openEnvironmentInWorker(id, { progress: new RecordingProgress() });
      expect(ui.since(events).some((event) => JSON.stringify(event).includes(Messages.gitSetupFailed))).toBe(false);
      expect(asUser(`cat ${GITHUB_TOKEN_FILE}`).out).toBe(DUMMY_TOKEN);
      expect(asUser(`cat ${GH_HOSTS_FILE}`).out).toContain(`oauth_token: "${DUMMY_TOKEN}"`);
      // A sign-out, as the controller does it.
      await removeToken(id, name);
      expect(cli.run(['exec', '-u', 'root', name, 'ls', '-A', TOKEN_FOLDER]).out).toBe('');
      expect(cli.run(['exec', '-u', 'root', name, 'sh', '-c', `grep -rl '${DUMMY_TOKEN}' ${TOKEN_FOLDER} || true`]).out).toBe('');
    });
  });

  it('host access checks off for the repository (unit 10): a configuration with privileged: true starts; with the checks on again it is refused and not started', async () => {
    const id = newEnvironmentId();
    const repository = 'devenv-test/privileged';
    const name = resourceName(repository, id);
    const config = JSON.stringify({
      name: 'Privileged',
      build: { dockerfile: 'Dockerfile' },
      privileged: true,
      runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`],
    });
    const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, `LABEL ${TEST_RUN_LABEL}=${run.runId}`].join('\n');
    await createVolume(docker, name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [TEST_RUN_LABEL]: run.runId });
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image (runInVolume).
    const seeded = await runInVolume(docker, name, ['sh', '-c', SEED_SCRIPT, 'sh', '/workspaces/privileged', config, dockerfile]);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id, repository, configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
    // The setting names the repository in another case: compared without case. Plan step 11I1, PR A2: the settings of the
    // window, which the open sends to the worker (its hostAccessChecks).
    window.settings.hostAccessChecksOff = ['DevEnv-Test/Privileged'];
    try {
      await timings.measure('first open with privileged: true, checks off', () => service.openEnvironmentInWorker(id, { progress: new RecordingProgress() }));
      const container = cli.container(name);
      expect(container?.State.Running).toBe(true);
      expect(container?.HostConfig.Privileged).toBe(true);
      expect(container?.Config.Labels?.['nimblescape.devenv.host-access']).toBe('unrestricted');
      // Plan step 11I1, PR A2: the worker logs it to its operation, whose log lines the window writes to its log.
      expect(fs.readFileSync(log.file, 'utf8')).toContain(`The host access checks are off for ${repository}`);

      // Checks on again: the open stops with the normal refusal, and the container is not started.
      window.settings.hostAccessChecksOff = [];
      // Plan step 11I2: `docker stop` by the Docker CLI of the test harness (was: stopContainer of the removed ContainerAdapter).
      cli.ok(['stop', name]);
      const error = await service.openEnvironmentInWorker(id, { progress: new RecordingProgress() }).then(() => undefined, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'hostAccess' });
      expect((error as Error).message).toContain('privileged mode');
      expect(cli.container(name)?.State.Running).toBe(false);
    } finally {
      window.settings.hostAccessChecksOff = [];
      await registry.remove(id);
      cli.run(['rm', '-f', name]);
      for (const image of cli.lines(['image', 'ls', '-q', environmentImageRepository(repository, id)])) cli.run(['image', 'rm', '-f', image]);
      cli.run(['volume', 'rm', name]);
    }
  });

  it('two accounts, one repository: two volumes and two containers, each with the identity of its owner; both come back after a lost registry (D-3)', async () => {
    const repository = 'devenv-test/shared';
    const second = { id: '4343', login: 'devenv-test-second' };
    // Plan step 11I1, PR A2: a second window of the same computer (its registry and session files), signed in with the
    // second account, whose workers share the state volume (the locks) of this file (before: a second service over the
    // relay). A window ID of its own: it is another window. afterAll closes it with the others.
    const secondWindow = workerWindow(context, docker, {
      name: 'pipeline',
      computer: { paths, registry, sessionFiles },
      windowId: 'docker-test-second-account',
      ui,
      settings: SETTINGS,
      auth: { ...fakeAuth, getAccount: async () => second },
    });
    windows.push(secondWindow);
    const config = JSON.stringify({ name: 'Shared', build: { dockerfile: 'Dockerfile' }, remoteUser: REMOTE_USER, runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`] });
    const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, 'RUN apk add --no-cache git && adduser -D dev', `LABEL ${TEST_RUN_LABEL}=${run.runId}`].join('\n');
    const owners = [TEST_ACCOUNT, second];
    const entries = owners.map((account) => {
      const id = newEnvironmentId();
      return { account, id, name: resourceName(repository, id) };
    });
    try {
      const now = isoTime(systemClock);
      for (const { account, id, name } of entries) {
        await createVolume(docker, name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [LABEL_OWNER_ID]: account.id, [TEST_RUN_LABEL]: run.runId });
        // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; the seed is a plain container of the helper image (runInVolume).
        const seeded = await runInVolume(docker, name, ['sh', '-c', SEED_SCRIPT, 'sh', '/workspaces/shared', config, dockerfile]);
        expect(seeded.exitCode, seeded.stderr).toBe(0);
        // The registry keeps one environment per repository and account, so both entries are added.
        await registry.add({ id, repository, configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: account });
      }
      await timings.measure('first open of the first account', () => service.openEnvironmentInWorker(entries[0].id, { progress: new RecordingProgress() }));
      await timings.measure('first open of the second account', () => secondWindow.service.openEnvironmentInWorker(entries[1].id, { progress: new RecordingProgress() }));
      // Each account's own environment cannot be opened by the other one (the window refuses it before it sends the open).
      await expect(service.openEnvironmentInWorker(entries[1].id, { progress: new RecordingProgress() })).rejects.toMatchObject({ code: 'otherAccount' });
      expect(new Set(entries.map(({ name }) => name)).size).toBe(2);
      for (const { account, name } of entries) {
        expect(cli.volume(name)).toBeDefined();
        expect(cli.container(name)?.State.Running).toBe(true);
        const email = cli.run(['exec', '-u', REMOTE_USER, name, 'git', 'config', '--get', 'user.email']);
        expect(email.out, email.err).toBe(`${account.id}+${account.login}@users.noreply.github.com`);
      }
      // A lost registry: both environments come back from the labels of their volumes, each with its owner. Plan step
      // 11I1, PR A2: the rebuild of the registry by the worker (`reconcile`; its entries come back as `record restore`).
      for (const { id } of entries) await registry.remove(id);
      expect(await service.reconcileInWorker({ passive: false })).toBeGreaterThanOrEqual(2);
      for (const { account, id } of entries) expect((await registry.get(id))?.owner?.id).toBe(account.id);
    } finally {
      for (const { id, name } of entries) {
        await registry.remove(id);
        cli.run(['rm', '-f', name]);
        cli.run(['volume', 'rm', name]);
      }
      // By reference, not by ID: the two builds are identical, so both tags can name one image ID.
      for (const { id } of entries) {
        for (const reference of cli.lines(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', environmentImageRepository(repository, id)])) {
          cli.run(['image', 'rm', reference]);
        }
      }
    }
  });

  it('plan step 7: the listing of the configuration picker runs in exactly one batch helper under the lock and leaves none', async () => {
    // Plan step 11I1, PR A2: the listing in the worker (`listConfigurations`); its batch helpers are counted by the step
    // `batch` that the worker reports (before: the batch sessions of the relay's lock).
    const stepsBefore = window.steps.length;
    expect(await service.listConfigurationsInWorker(environmentId, { progress: new RecordingProgress() })).toEqual([CONFIG_PATH]);
    expect(window.batchesOf(volumeName, stepsBefore)).toBe(1);
    expect(helperContainers()).toEqual([]);
  });

  it('user decision 2026-10-02: the safety check of a volume without the repository folder runs no batch helper and gives the recorded state', async () => {
    const repository = 'devenv-test/empty';
    const id = newEnvironmentId();
    const name = resourceName(repository, id);
    const recorded = { branch: 'old', uncommittedFiles: 3, unpushedCommits: 2, stashes: 1, recordedAt: '2026-09-20T10:00:00.000Z' };
    try {
      await createVolume(docker, name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [TEST_RUN_LABEL]: run.runId });
      const now = isoTime(systemClock);
      await registry.add({ id, repository, configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT, gitSummary: recorded });
      // user decision 2026-10-02: Delete runs no Git: changed expectation (was in plan step 7: one batch helper, its
      // step as nobody): no container runs, so the check gives the recorded state without any helper or lock.
      // Plan step 11I1, PR A2: changed expectation (before: the value of the safety check, `recorded`): the check of
      // Delete runs in the worker (`deleteCheck`), which answers the decision of the user (Delete); the recorded state
      // reaches the window in the confirmation, which names its counts and its time (not its branch). The entry keeps it.
      const stepsBefore = window.steps.length;
      const confirmations = ui.deleteConfirmations.length;
      const decision = await service.deleteCheckInWorker(id, { progress: new RecordingProgress(), repository, otherWindow: false });
      expect(decision).toEqual({ decision: 'delete', additionalVolumesToRemove: [] });
      expect(ui.deleteConfirmations.slice(confirmations)).toMatchObject([
        { repository, confirmation: { changes: { uncommittedFiles: 3, unpushedCommits: 2, stashes: 1 }, recordedAt: recorded.recordedAt, otherWindow: false } },
      ]);
      expect((await registry.get(id))?.gitSummary).toEqual(recorded);
      expect(window.batchesOf(name, stepsBefore)).toBe(0);
      expect(cli.lines(['ps', '-a', '-q', '--filter', `label=${LABEL_HELPER_RUN}=true`, '--filter', `volume=${name}`])).toEqual([]);
    } finally {
      await registry.remove(id);
      cli.run(['volume', 'rm', name]);
    }
  });

  it('safety check and delete: the container, the images, the volume, and the registry entry are removed', async () => {
    const progress = new RecordingProgress();
    const stepsBefore = window.steps.length;
    const confirmations = ui.deleteConfirmations.length;
    // Plan step 11I1, PR A2: the check of Delete and Delete in the worker (`deleteCheck`, `delete`; before: safetyCheck and
    // delete of the pipeline in this process). The user interface answers Delete, with no additional volume.
    const decision = await timings.measure('safety check', () => service.deleteCheckInWorker(environmentId, { progress, repository: REPOSITORY, otherWindow: false }));
    expect(decision).toEqual({ decision: 'delete', additionalVolumesToRemove: [] });
    // user decision 2026-10-02: Delete runs no Git: changed expectation (was in plan step 7: the Git summary in exactly
    // one batch helper under the lock): the check opens no batch helper; it names the recorded state, refreshed in the
    // dev container when it runs. Its counts are those of before (the untracked file, the one commit without a remote).
    // Plan step 11I1, PR A2: changed expectation (before: the value of the safety check, with the branch): the counts that
    // the confirmation names; the entry holds the whole state with its branch.
    expect(ui.deleteConfirmations.slice(confirmations)).toMatchObject([
      { repository: REPOSITORY, confirmation: { changes: { uncommittedFiles: 1, unpushedCommits: 1, stashes: 0 }, otherWindow: false } },
    ]);
    expect((await registry.get(environmentId))?.gitSummary).toMatchObject({ branch: 'main', uncommittedFiles: 1, unpushedCommits: 1, stashes: 0 });
    expect(window.batchesOf(volumeName, stepsBefore)).toBe(0);
    expect(helperContainers()).toEqual([]);

    await timings.measure('delete', () => service.deleteInWorker(environmentId, { progress, additionalVolumesToRemove: decision.decision === 'delete' ? decision.additionalVolumesToRemove : [] }));
    expect(containersOfEnvironment()).toEqual([]);
    expect(cli.container(containerName)).toBeUndefined();
    expect(cli.lines(['image', 'ls', '-q', imageRepository])).toEqual([]);
    expect(runImages()).toEqual([]);
    expect(cli.volume(volumeName)).toBeUndefined();
    expect(await registry.get(environmentId)).toBeUndefined();
    expect(fs.existsSync(paths.pendingFile(environmentId))).toBe(false);
    expect(helperContainers()).toEqual([]);
    // Concept 7.14 step 3: the base image goes too, because no other build record uses it; also with the classic image
    // store, where the removal by digest leaves the tag. The image of the user stays (by its ID: a pulled newer image
    // may have taken the tag away from it, and afterAll puts the tag back).
    if (baselineBaseId) expect(cli.image(baselineBaseId)).toBeDefined();
    else expect(cli.image(TEST_BASE_IMAGE)).toBeUndefined();
  });
});
