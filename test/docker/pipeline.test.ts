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
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerAdapter } from '../../src/core/docker/containerAdapter';
import { helperImageTag, registryBaseDigest } from '../../src/core/helper/helperImage';
import { readHelperState } from '../../src/core/helper/helperState';
import { WorkspaceHelper } from '../../src/core/helper/workspaceHelper';
import type { HttpTransport } from '../../src/core/http';
import { extractBaseImages } from '../../src/core/imageCheck/dockerfile';
import { ImageChecker } from '../../src/core/imageCheck/imageCheck';
import {
  CONTAINER_CREDENTIAL_HELPER,
  GIT_CREDENTIALS_CONFIG_FILE,
  HOME_GIT_CONFIG_CONTENT,
  containerEnvironment,
  containerGitSupport,
  devContainersSettings,
} from '../../src/core/helper/containerGit';
import { Messages } from '../../src/core/messages';
import {
  LABEL_ENVIRONMENT_ID,
  LABEL_HELPER_RUN,
  LABEL_OWNER_ID,
  LABEL_REPOSITORY,
  environmentImageRepository,
  newEnvironmentId,
  resourceName,
} from '../../src/core/names';
import { EnvironmentService } from '../../src/core/pipeline/environmentService';
import { isoTime, systemClock, type GitHubAuth } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { StoragePaths } from '../../src/core/storage/paths';
import { EnvironmentRegistry } from '../../src/core/storage/registry';
import { SessionFiles } from '../../src/core/storage/sessionFiles';
import type { ExtensionSettings } from '../../src/core/types';
import { OLD_GIT_BASE_IMAGE, TEST_BASE_IMAGE, TEST_RUN_LABEL, familiarName, readBaseline, removeRunObjects } from './dockerRun';
import {
  DUMMY_TOKEN,
  FakeUi,
  HELPER_DOCKERFILE,
  TEST_ACCOUNT,
  RecordingProgress,
  Timings,
  dockerTestContext,
  fakeAuth,
  hangingTransport,
  inConceptOrder,
  offlineTransport,
  registryClient,
  registryDigest,
  registryTransport,
  timedChecker,
  type CheckRecord,
} from './harness';

const REPOSITORY = 'devenv-test/tiny';
const FOLDER = '/workspaces/tiny';
const CONFIG_PATH = '.devcontainer/devcontainer.json';
const REMOTE_USER = 'dev';
/** The port of the container that the configuration publishes (appPort); the host port is free at the start. */
const CONTAINER_PORT = 8080;
const UNTRACKED = 'untracked.txt';
const FAKE_DIGEST = `sha256:${'0'.repeat(64)}`;
const DAY_MS = 24 * 60 * 60 * 1000;

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
};

describe('open pipeline on a seeded environment', () => {
  const { run, env, cli, log } = dockerTestContext('pipeline');
  const runner = new NodeProcessRunner();
  const docker = new ContainerAdapter(runner, run.dockerPath, env, log);
  const helper = new WorkspaceHelper({ docker, logger: log, dockerfilePath: HELPER_DOCKERFILE, env });
  const paths = new StoragePaths(path.join(run.runDir, 'pipeline-storage'));
  const registry = new EnvironmentRegistry(paths, systemClock, { logger: log });
  const sessionFiles = new SessionFiles(paths);
  const ui = new FakeUi();
  const owner = { windowId: 'docker-test-window', pid: process.pid };
  const checks: CheckRecord[] = [];
  const timings = new Timings();
  const onlineClient = registryClient(registryTransport, runner, env, log);
  const digestChecker = new ImageChecker(onlineClient, log);

  /**
   * The workspace helper of a new window whose weekly check of the base image of the helper is due, with a state file
   * of its own, and a digest lookup through `transport`, like the image check of its service. The cleanup ran today, so
   * it never sees the helper images of the user; the transports of these helpers never return a digest, so they never
   * rebuild the helper image.
   */
  function helperWithDueCheck(transport: HttpTransport, name: string) {
    const statePath = path.join(run.runDir, `${name}-helper-state`, 'helper.json');
    const content = fs.readFileSync(HELPER_DOCKERFILE, 'utf8');
    const tag = helperImageTag(content);
    const eightDaysAgo = new Date(Date.now() - 8 * DAY_MS).toISOString();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const record = { baseImage: extractBaseImages(content)[0], baseDigest: FAKE_DIGEST, checkedAt: eightDaysAgo, lastUsedAt: eightDaysAgo };
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, images: { [tag]: record }, lastCleanupAt: new Date().toISOString() }));
    const lookUp = registryBaseDigest(registryClient(transport, runner, env, log));
    const lookups: Array<{ startedAt: number; endedAt?: number }> = [];
    const checks: Array<Promise<void>> = [];
    const windowHelper = new WorkspaceHelper({
      docker,
      logger: log,
      dockerfilePath: HELPER_DOCKERFILE,
      env,
      statePath,
      baseDigest: async (reference, signal) => {
        const lookup: { startedAt: number; endedAt?: number } = { startedAt: Date.now() };
        lookups.push(lookup);
        try {
          return await lookUp(reference, signal);
        } finally {
          lookup.endedAt = Date.now();
        }
      },
      onBaseImageCheck: (check) => checks.push(check),
    });
    return {
      helper: windowHelper,
      lookups,
      eightDaysAgo,
      /** The record of the helper tag, after the checks in the background ended. */
      record: async () => {
        await Promise.all(checks.splice(0));
        return (await readHelperState(statePath)).images[tag];
      },
    };
  }
  const offlineHelper = helperWithDueCheck(offlineTransport, 'offline');
  const hangingHelper = helperWithDueCheck(hangingTransport, 'hanging');

  function service(transport: HttpTransport, label: string, workspaceHelper: WorkspaceHelper = helper, auth: GitHubAuth = fakeAuth): EnvironmentService {
    const client = transport === registryTransport ? onlineClient : registryClient(transport, runner, env, log);
    return new EnvironmentService({
      docker,
      runner,
      helper: workspaceHelper,
      registry,
      sessionFiles,
      imageChecker: timedChecker(new ImageChecker(client, log), label, checks),
      auth,
      ui,
      logger: log,
      clock: systemClock,
      platform: process.platform,
      env,
      owner,
      settings: () => settings,
      windowStatuses: () => sessionFiles.readWindowStatuses(),
    });
  }
  const online = service(registryTransport, 'online');
  const offline = service(offlineTransport, 'offline', offlineHelper.helper);
  const hanging = service(hangingTransport, 'hanging', hangingHelper.helper);

  const environmentId = newEnvironmentId();
  const volumeName = resourceName(REPOSITORY, environmentId);
  const containerName = volumeName;
  const imageRepository = environmentImageRepository(environmentId);

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
    const lines = cli.lines(['image', 'ls', '-a', '--no-trunc', '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`, '--format', '{{.ID}} {{.Repository}}:{{.Tag}}']);
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

    await timings.measure('workspace helper image ready', () => helper.ensureImage());
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
      },
      null,
      2,
    );
    const dockerfile = [
      `FROM ${TEST_BASE_IMAGE}`,
      'RUN apk add --no-cache git && adduser -D dev',
      `LABEL ${TEST_RUN_LABEL}=${run.runId}`,
    ].join('\n');
    await docker.createVolume(volumeName, {
      [LABEL_ENVIRONMENT_ID]: environmentId,
      [LABEL_REPOSITORY]: REPOSITORY,
      [TEST_RUN_LABEL]: run.runId,
    });
    const seeded = await helper.run(volumeName, ['sh', '-c', SEED_SCRIPT, 'sh', FOLDER, devcontainerJson, dockerfile], {
      docker: false,
      network: false,
    });
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

  afterAll(() => {
    timings.print(`Timings of the pipeline scenarios (${TEST_BASE_IMAGE}):`);
    restoreBaseImageTag();
    removeRunObjects(cli, run.runId);
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
    const checked = checks.length;
    const result = await timings.measure(
      'first open: pull, build :1, up',
      () => online.openEnvironment(environmentId, { progress }),
      () => progress.summary(),
    );

    expect(progress.steps).toEqual(['checkingImage', 'downloadingImage', 'preparing', 'starting']);
    expect(progress.details).not.toContain(Messages.newerImage);
    expect(checks.slice(checked).map((check) => check.status)).toEqual(['checked']);
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
    expect(cli.image(`${imageRepository}:1`)?.Config.Labels?.['devcontainer.metadata']).toContain(REMOTE_USER);
    // The Dev Container CLI left no other image (for example a `vsc-…` image).
    expect(runImages()).toEqual([[`${imageRepository}:1`]]);

    expect(filesOfOtherUsers()).toBe('');
    expect(execIn(REMOTE_USER, `touch ${FOLDER}/.git/write-test && rm ${FOLDER}/.git/write-test && echo ok`)).toBe('ok');
    expect(helperContainers()).toEqual([]);
    expect(ui.since(events)).toEqual([]);
  });

  it('container-only Git: the variables, the label, the token file, and the Git configuration of the container (concept section 9)', () => {
    expect(cli.container(containerName)?.Config.Labels?.['devenv.container-version']).toBe('3');
    const env = containerEnv();
    expect(env).toMatchObject({
      GIT_CONFIG_GLOBAL: '/workspaces/.devenv+/gitconfig',
      DOCKER_CONFIG: '/workspaces/.devenv+/docker',
      GIT_SSH_COMMAND: 'ssh -o IdentityAgent=none',
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

    // The token file: mode 600, owned by the remote user, readable by it, and the only file with the token.
    expect(execIn('root', 'stat -c "%a %U" /workspaces/.devenv+/github-token')).toBe(`600 ${REMOTE_USER}`);
    expect(execIn(REMOTE_USER, 'cat /workspaces/.devenv+/github-token')).toBe(DUMMY_TOKEN);
    expect(execIn('root', `grep -rl '${DUMMY_TOKEN}' /workspaces || true`)).toBe('/workspaces/.devenv+/github-token');
    expect(execIn('root', 'stat -c "%a %U" /workspaces/.devenv+/docker')).toBe(`700 ${REMOTE_USER}`);
    // No GnuPG folder of the extension: GnuPG works where the image sets it up.
    expect(execIn('root', 'ls -A /workspaces/.devenv+').split('\n').sort()).toEqual(['credentials.gitconfig', 'docker', 'gitconfig', 'github-token']);

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
    const token = '/workspaces/.devenv+/github-token';
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
    await timings.measure('stop', () => online.stop(environmentId));

    const summary = (await registry.get(environmentId))?.gitSummary;
    expect(summary).toMatchObject({ branch: 'main', uncommittedFiles: 1, unpushedCommits: 1, stashes: 0 });
    expect(Date.parse(summary?.recordedAt ?? '')).toBeGreaterThanOrEqual(started - 1000);
    expect(cli.container(containerName)?.State.Status).toBe('exited');
  });

  it('open again with the image up to date: no pull, no build, the same container starts', async () => {
    const before = await registry.get(environmentId);
    const containerId = cli.container(containerName)?.Id;
    const progress = new RecordingProgress();
    const events = ui.events.length;
    const checked = checks.length;
    const result = await timings.measure(
      'open again, up to date',
      () => online.openEnvironment(environmentId, { progress }),
      () => progress.summary(),
    );

    expect(progress.steps).toEqual(['checkingImage', 'starting']);
    expect(checks.slice(checked).map((check) => check.status)).toEqual(['checked']);
    const container = cli.container(containerName);
    expect(container?.Id).toBe(containerId);
    expect(container?.State.Running).toBe(true);
    const after = await registry.get(environmentId);
    expect(after?.buildRecord).toEqual(before?.buildRecord);
    expect(after?.gitSummary).toMatchObject({ branch: 'main', uncommittedFiles: 1 });
    expect(cli.image(`${imageRepository}:2`)).toBeUndefined();
    expect(untrackedFileKept()).toBe(true);
    expect(result.remoteWorkspaceFolder).toBe(FOLDER);
    expect(ui.since(events)).toEqual([]);
  });

  it('a container of an older version (without the label devenv.container-version) is created again, without a build', async () => {
    // A container as the first version of the extension created it: the ID label, the workspace volume, no version label.
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
    await timings.measure('create an old container again', () => online.openEnvironment(environmentId, { progress }), () => progress.summary());

    expect(progress.steps).toEqual(['checkingImage', 'starting']);
    const container = cli.container(containerName);
    expect(container?.Id).not.toBe(oldId);
    expect(container?.State.Running).toBe(true);
    expect(container?.Config.Image).toBe(`${imageRepository}:1`);
    expect(container?.Config.Labels?.['devenv.container-version']).toBe('3');
    expect(containerEnv().GIT_CONFIG_GLOBAL).toBe('/workspaces/.devenv+/gitconfig');
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
      () => online.openEnvironment(environmentId, { progress }),
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
    expect(entry?.busy).toBeUndefined();
    expect(result.remoteWorkspaceFolder).toBe(FOLDER);
    expect(ui.since(events)).toEqual([]);
    expect(helperContainers()).toEqual([]);
  });

  it('offline: an information message, and the container starts within the time limit of the check', async () => {
    await online.stop(environmentId);
    expect(cli.container(containerName)?.State.Status).toBe('exited');
    const containerId = cli.container(containerName)?.Id;
    const record = (await registry.get(environmentId))?.buildRecord;

    // No network: each request fails at once. The window is new: the weekly check of the helper's base image is due.
    let progress = new RecordingProgress();
    let events = ui.events.length;
    let checked = checks.length;
    await timings.measure('open offline (no network)', () => offline.openEnvironment(environmentId, { progress }), () => progress.summary());
    expect(checks.slice(checked)).toEqual([expect.objectContaining({ label: 'offline', status: 'unreachable' })]);
    expect(checks[checks.length - 1].ms).toBeLessThanOrEqual(5000);
    expect(ui.since(events)).toEqual([{ kind: 'info', text: Messages.registryUnreachable }]);
    expect(progress.steps).toEqual(['checkingImage', 'starting']);
    expect(cli.container(containerName)).toMatchObject({ Id: containerId, State: { Running: true } });
    expect(offlineHelper.lookups).toHaveLength(1);
    expect(await offlineHelper.record()).toMatchObject({ checkedAt: offlineHelper.eightDaysAgo, attemptedAt: expect.any(String) });

    // A registry that never answers: the check ends after 5 seconds (NFR-08), then the container starts. The helper of
    // this new window checks its base image at the same time, in the background: its 5 seconds overlap with those of
    // the image check, instead of coming first.
    await online.stop(environmentId);
    progress = new RecordingProgress();
    events = ui.events.length;
    checked = checks.length;
    await timings.measure('open with a registry that never answers', () => hanging.openEnvironment(environmentId, { progress }), () => progress.summary());
    expect(checks.slice(checked)).toEqual([expect.objectContaining({ label: 'hanging', status: 'unreachable' })]);
    const check = checks[checks.length - 1];
    const waited = check.ms;
    timings.add('  check with a registry that never answers', waited);
    expect(waited).toBeGreaterThanOrEqual(4900);
    expect(waited).toBeLessThanOrEqual(5500);
    expect(hangingHelper.lookups).toHaveLength(1);
    const helperLookup = hangingHelper.lookups[0];
    timings.add('  image check started after the start of the helper check', check.startedAt - helperLookup.startedAt);
    expect(check.startedAt).toBeLessThan(helperLookup.endedAt ?? Number.POSITIVE_INFINITY);
    expect(ui.since(events)).toEqual([{ kind: 'info', text: Messages.registryUnreachable }]);
    expect(cli.container(containerName)).toMatchObject({ Id: containerId, State: { Running: true } });
    expect(await hangingHelper.record()).toMatchObject({ checkedAt: hangingHelper.eightDaysAgo, attemptedAt: expect.any(String) });
    expect(helperLookup.endedAt! - helperLookup.startedAt).toBeLessThanOrEqual(5500);

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
      () => offline.openEnvironment(environmentId, { progress }),
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
    await docker.createVolume(name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: 'devenv-test/refused', [TEST_RUN_LABEL]: run.runId });
    const seeded = await helper.run(name, ['sh', '-c', SEED_SCRIPT, 'sh', '/workspaces/refused', config, dockerfile], { docker: false, network: false });
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id, repository: 'devenv-test/refused', configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
    try {
      const progress = new RecordingProgress();
      const error = await timings.measure(`refuse ${item}`, () => online.openEnvironment(id, { progress }).then(() => undefined, (caught: unknown) => caught));
      expect(error).toMatchObject({ code: 'hostAccess' });
      expect((error as Error).message).toContain(item);
      expect(progress.steps).not.toContain('preparing');
      expect(cli.lines(['image', 'ls', '-q', environmentImageRepository(id)])).toEqual([]);
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
    await docker.createVolume(name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [TEST_RUN_LABEL]: run.runId });
    const seeded = await helper.run(name, ['sh', '-c', SEED_SCRIPT, 'sh', '/workspaces/compose-volume', config, dockerfile], { docker: false, network: false });
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id, repository, configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
    try {
      const progress = new RecordingProgress();
      const error = await online.openEnvironment(id, { progress }).then(() => undefined, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'hostAccess' });
      expect((error as Error).message).toContain(`volume ${composeVolume} of the Docker Compose project devenv-test`);
      expect(progress.steps).not.toContain('preparing');
      expect(cli.lines(['image', 'ls', '-q', environmentImageRepository(id)])).toEqual([]);
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
    await docker.createVolume(name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [TEST_RUN_LABEL]: run.runId });
    const seeded = await helper.run(name, ['sh', '-c', SEED_SCRIPT, 'sh', '/workspaces/old-git', config, dockerfile], { docker: false, network: false });
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id, repository, configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
    const asUser = (args: string[], input?: string) => cli.run(['exec', ...(input === undefined ? [] : ['-i']), '-u', REMOTE_USER, '-e', 'GIT_TERMINAL_PROMPT=0', name, ...args], input);
    try {
      const events = ui.events.length;
      await timings.measure('first open with Git 2.30', () => online.openEnvironment(id, { progress: new RecordingProgress() }));
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
      for (const image of cli.lines(['image', 'ls', '-q', environmentImageRepository(id)])) cli.run(['image', 'rm', '-f', image]);
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
    await docker.createVolume(name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [TEST_RUN_LABEL]: run.runId });
    const seeded = await helper.run(name, ['sh', '-c', SEED_SCRIPT, 'sh', '/workspaces/no-rights', config, dockerfile], { docker: false, network: false });
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    const now = isoTime(systemClock);
    await registry.add({ id, repository, configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: TEST_ACCOUNT });
    try {
      await timings.measure('first open with --platform linux/amd64, --cap-drop ALL, --rm, -it', () => online.openEnvironment(id, { progress: new RecordingProgress() }));
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
      // Without --rm, a stop keeps the container.
      await docker.stopContainer(name);
      expect(cli.container(name)?.State.Running).toBe(false);
    } finally {
      await registry.remove(id);
      cli.run(['rm', '-f', name]);
      for (const image of cli.lines(['image', 'ls', '-q', environmentImageRepository(id)])) cli.run(['image', 'rm', '-f', image]);
      cli.run(['volume', 'rm', name]);
    }
  });

  it('two accounts, one repository: two volumes and two containers, each with the identity of its owner; both come back after a lost registry (D-3)', async () => {
    const repository = 'devenv-test/shared';
    const second = { id: '4343', login: 'devenv-test-second' };
    const secondService = service(registryTransport, 'second account', helper, { ...fakeAuth, getAccount: async () => second });
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
        await docker.createVolume(name, { [LABEL_ENVIRONMENT_ID]: id, [LABEL_REPOSITORY]: repository, [LABEL_OWNER_ID]: account.id, [TEST_RUN_LABEL]: run.runId });
        const seeded = await helper.run(name, ['sh', '-c', SEED_SCRIPT, 'sh', '/workspaces/shared', config, dockerfile], { docker: false, network: false });
        expect(seeded.exitCode, seeded.stderr).toBe(0);
        // The registry keeps one environment per repository and account, so both entries are added.
        await registry.add({ id, repository, configPath: CONFIG_PATH, volumeName: name, containerName: name, createdAt: now, lastUsedAt: now, owner: account });
      }
      await timings.measure('first open of the first account', () => online.openEnvironment(entries[0].id, { progress: new RecordingProgress() }));
      await timings.measure('first open of the second account', () => secondService.openEnvironment(entries[1].id, { progress: new RecordingProgress() }));
      // Each account's own environment cannot be opened by the other one.
      await expect(online.openEnvironment(entries[1].id, { progress: new RecordingProgress() })).rejects.toMatchObject({ code: 'otherAccount' });
      expect(new Set(entries.map(({ name }) => name)).size).toBe(2);
      for (const { account, name } of entries) {
        expect(cli.volume(name)).toBeDefined();
        expect(cli.container(name)?.State.Running).toBe(true);
        const email = cli.run(['exec', '-u', REMOTE_USER, name, 'git', 'config', '--get', 'user.email']);
        expect(email.out, email.err).toBe(`${account.id}+${account.login}@users.noreply.github.com`);
      }
      // A lost registry: both environments come back from the labels of their volumes, each with its owner.
      for (const { id } of entries) await registry.remove(id);
      expect(await online.reconcileFromVolumes()).toBeGreaterThanOrEqual(2);
      for (const { account, id } of entries) expect((await registry.get(id))?.owner?.id).toBe(account.id);
    } finally {
      for (const { id, name } of entries) {
        await registry.remove(id);
        cli.run(['rm', '-f', name]);
        for (const image of cli.lines(['image', 'ls', '-q', environmentImageRepository(id)])) cli.run(['image', 'rm', '-f', image]);
        cli.run(['volume', 'rm', name]);
      }
    }
  });

  it('safety check and delete: the container, the images, the volume, and the registry entry are removed', async () => {
    const progress = new RecordingProgress();
    const summary = await timings.measure('safety check', () => online.safetyCheck(environmentId, { progress }));
    expect(summary).toMatchObject({ branch: 'main', uncommittedFiles: 1, unpushedCommits: 1, stashes: 0 });

    await timings.measure('delete', () => online.delete(environmentId, { progress, removeAdditionalVolumes: false }));
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
