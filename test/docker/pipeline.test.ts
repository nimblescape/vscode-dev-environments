// The open pipeline and the environment operations against the real Docker engine (concept 7.6, 7.7, 7.12, 7.14), on a
// seeded environment: a workspace volume with a Git repository, created through the workspace helper, and its registry
// entry. Its configuration builds a tiny Alpine image with Git and uses the non-root user `guest`, so the ownership fix
// runs. Real core modules and the real workspace helper; only the user interface, the GitHub session, and (for the
// offline scenarios) the network are fakes.
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
import { Messages } from '../../src/core/messages';
import {
  LABEL_ENVIRONMENT_ID,
  LABEL_HELPER_RUN,
  LABEL_REPOSITORY,
  environmentImageRepository,
  newEnvironmentId,
  resourceName,
} from '../../src/core/names';
import { EnvironmentService } from '../../src/core/pipeline/environmentService';
import { isoTime, systemClock } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { StoragePaths } from '../../src/core/storage/paths';
import { EnvironmentRegistry } from '../../src/core/storage/registry';
import { SessionFiles } from '../../src/core/storage/sessionFiles';
import type { ExtensionSettings } from '../../src/core/types';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, familiarName, readBaseline, removeRunObjects } from './dockerRun';
import {
  FakeUi,
  HELPER_DOCKERFILE,
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
const REMOTE_USER = 'guest';
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

  function service(transport: HttpTransport, label: string, workspaceHelper: WorkspaceHelper = helper): EnvironmentService {
    const client = transport === registryTransport ? onlineClient : registryClient(transport, runner, env, log);
    return new EnvironmentService({
      docker,
      runner,
      helper: workspaceHelper,
      registry,
      sessionFiles,
      imageChecker: timedChecker(new ImageChecker(client, log), label, checks),
      auth: fakeAuth,
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
    const devcontainerJson = JSON.stringify(
      {
        name: 'Tiny',
        build: { dockerfile: 'Dockerfile' },
        remoteUser: REMOTE_USER,
        // The containers of the run carry the label of the run, so the cleanup finds them.
        runArgs: ['--label', `${TEST_RUN_LABEL}=${run.runId}`],
      },
      null,
      2,
    );
    const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, 'RUN apk add --no-cache git', `LABEL ${TEST_RUN_LABEL}=${run.runId}`].join('\n');
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
    await registry.add({ id: environmentId, repository: REPOSITORY, configPath: CONFIG_PATH, volumeName, containerName, createdAt: now, lastUsedAt: now });
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
