// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// PR H, a follow-up of plan step 11I (decision of 2026-10-09, docs/plan-remote-worker.md section 2): the helper image
// maintenance runs again, in the extension's preparation of the worker for an operation `open` (heartbeatHelperImage
// with HelperMaintenance: HelperImages.ensureImageUse) and in the background prebuild (HelperPrebuild:
// HelperImages.prebuildImage, due for a tag without a record or by helperRefreshDue, never for the daily cleanup alone).
// The rules of the maintenance itself are tested in helperImage.test.ts and helperImages.rules.test.ts; here: what is
// due, where it runs, with which setting, and what an open shows and keeps.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerTarget } from '../docker/dockerHost';
import type { ImageInfo } from '../docker/dockerObjects';
import { CommandError } from '../errors';
import { abortError, type Logger } from '../ports';
import { HELPER_PREBUILD_TIMEOUT_MS, HelperPrebuild, type HelperPrebuildDeps, type HelperPrebuildOutcome } from './helperPrebuild';
import { HELPER_REBUILD_TIMEOUT_MS, ensureHelperImageUse, helperImageTag, helperRefreshDue, type BaseDigestLookup } from './helperImage';
import { HelperImages, helperStatePathFor, type HelperImageDocker, type HelperImagesDeps, type HelperMaintenance } from './helperImages';
import { readHelperState, type HelperState } from './helperState';
import { heartbeatHelperImage } from '../session/heartbeatHelperImage';
import { HeartbeatPreparation } from '../session/heartbeatPreparation';

const DOCKERFILE = 'FROM node:22-bookworm-slim\n';
const TAG = helperImageTag(DOCKERFILE);
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
/** More than a week before NOW. */
const OLD = '2026-09-01T12:00:00.000Z';
/** Within the day before NOW. */
const TODAY = '2026-10-09T06:00:00.000Z';
/** Two days before NOW. */
const TWO_DAYS_AGO = '2026-10-07T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const ID1 = `sha256:${'1'.repeat(64)}`;
const ID2 = `sha256:${'2'.repeat(64)}`;
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const LOCAL: DockerTarget = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock', context: 'default' };

type BuildOptions = Parameters<HelperImageDocker['buildImage']>[0];

/** A Docker engine with the tags of its images: each build gives the tag the image `nextId`. */
class FakeDocker implements HelperImageDocker {
  readonly tags = new Map<string, string>();
  readonly builds: BuildOptions[] = [];
  buildHandler: (options: BuildOptions) => Promise<void> = async () => undefined;
  nextId = ID2;
  imageIdCalls = 0;
  listCalls = 0;
  readonly removals: string[] = [];

  async imageExists(reference: string): Promise<boolean> {
    return this.tags.has(reference);
  }

  async imageId(reference: string): Promise<string | undefined> {
    this.imageIdCalls++;
    return this.tags.get(reference);
  }

  async buildImage(options: BuildOptions): Promise<string | undefined> {
    this.builds.push(options);
    options.onOutput?.(`#1 building ${options.tag}`);
    await this.buildHandler(options);
    this.tags.set(options.tag, this.nextId);
    return this.nextId;
  }

  async listImagesByLabel(): Promise<ImageInfo[]> {
    this.listCalls++;
    return [...this.tags].map(([tag, id]) => ({ id, tags: [tag], createdAt: '' }));
  }

  async removeImage(reference: string): Promise<boolean> {
    this.removals.push(reference);
    return false;
  }
}

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
  output(text: string): void {
    this.lines.push(`output ${text}`);
  }
}

let dir: string;
let docker: FakeDocker;
let logger: RecordingLogger;

const statePath = (): string => path.join(dir, 'storage', 'helper.json');

function writeState(state: Omit<HelperState, 'version'>, engineKey = ''): void {
  const file = helperStatePathFor(statePath(), engineKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...state }));
}

function readState(engineKey = ''): Promise<HelperState> {
  return readHelperState(helperStatePathFor(statePath(), engineKey));
}

/** The record of a tag whose check (of today) asked for a rebuild: the registry has a new digest of the base image. */
const rebuildAsked = { baseImage: 'node:22-bookworm-slim', baseDigest: DIGEST_A, latestBaseDigest: DIGEST_B, builtAt: OLD, checkedAt: TODAY, lastUsedAt: TODAY };

/** The helper image of a window, with the state file and the clock of these tests. */
function images(overrides: Partial<HelperImagesDeps> = {}): HelperImages {
  return new HelperImages({ docker, logger, dockerfilePath: path.join(dir, 'Dockerfile'), clock: { now: () => NOW }, statePath: statePath(), ...overrides });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-11ih-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE);
  docker = new FakeDocker();
  logger = new RecordingLogger();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('helperRefreshDue (PR H, decision of 2026-10-09)', () => {
  // The states here record no cleanup: the daily cleanup is due in each of them, and never makes the refresh due.
  const due = (state: Omit<HelperState, 'version'>, checkBaseImage: boolean, baseDigest = true, content = DOCKERFILE): boolean =>
    helperRefreshDue({ version: 1, ...state }, content, { now: NOW, checkBaseImage, baseDigest });

  it('the daily cleanup alone is no refresh: not due, with the setting on or off', () => {
    const checked = { [TAG]: { checkedAt: TODAY } };
    expect(due({ images: checked }, false)).toBe(false);
    expect(due({ images: checked }, true)).toBe(false);
    expect(due({ images: checked, lastCleanupAt: OLD }, true)).toBe(false);
  });

  it('the rebuild that a check asked for is due only with the setting on', () => {
    expect(due({ images: { [TAG]: rebuildAsked } }, true)).toBe(true);
    expect(due({ images: { [TAG]: rebuildAsked } }, false)).toBe(false);
    // Also without a lookup of the base digest: the new digest is recorded already.
    expect(due({ images: { [TAG]: rebuildAsked } }, true, false)).toBe(true);
  });

  // Review round 1 of PR H (A-L2): changed expectation (and name; it was "…, a day after an attempt"): for the prebuild,
  // an attempt that the registry did not answer puts the check off by a week, not a day (two days ago: not due).
  it('the weekly check is due only with the setting on and a lookup of the base digest, a week after an unanswered attempt', () => {
    const at = (record: object): Omit<HelperState, 'version'> => ({ images: { [TAG]: record } });
    expect(due(at({ checkedAt: OLD }), true)).toBe(true);
    expect(due(at({ checkedAt: OLD }), false)).toBe(false);
    expect(due(at({ checkedAt: OLD }), true, false)).toBe(false);
    expect(due(at({ checkedAt: TODAY }), true)).toBe(false);
    expect(due(at({ checkedAt: OLD, attemptedAt: TODAY }), true)).toBe(false);
    expect(due(at({ checkedAt: OLD, attemptedAt: TWO_DAYS_AGO }), true)).toBe(false);
    expect(due(at({ attemptedAt: TWO_DAYS_AGO }), true)).toBe(false);
    expect(due(at({ checkedAt: OLD, attemptedAt: OLD }), true)).toBe(true);
    // A record of the tag of another Dockerfile does not count.
    expect(due({ images: { 'devenv-helper:0123456789ab': { checkedAt: TODAY } } }, true)).toBe(true);
  });

  it('a Dockerfile without a base image has no check and no rebuild', () => {
    const content = 'ARG X=1\n';
    expect(due({ images: { [helperImageTag(content)]: { ...rebuildAsked, checkedAt: OLD } } }, true, true, content)).toBe(false);
  });
});

describe('HelperImages.refreshDue (PR H)', () => {
  it('reads the state file of the engine of the operation, and knows whether it has a lookup of the base digest', async () => {
    const lookup: BaseDigestLookup = async () => DIGEST_A;
    // helper.json of the local Docker: the weekly check is due there.
    writeState({ images: { [TAG]: { checkedAt: OLD } } });
    // The remote host: checked today, so no refresh is due (only its daily cleanup, which is none).
    writeState({ images: { [TAG]: { checkedAt: TODAY } } }, 'build-box');
    const remote = images({ engine: async () => ({ key: 'build-box' }), baseDigest: lookup });
    expect(await remote.refreshDue({ checkBaseImage: true })).toBe(false);
    expect(await images({ baseDigest: lookup }).refreshDue({ checkBaseImage: true })).toBe(true);
    // The check of the remote host is due by its time, but only with a lookup.
    writeState({ images: { [TAG]: { checkedAt: OLD } } }, 'build-box');
    expect(await remote.refreshDue({ checkBaseImage: true })).toBe(true);
    expect(await images({ engine: async () => ({ key: 'build-box' }) }).refreshDue({ checkBaseImage: true })).toBe(false);
    // Without a state file, nothing is due (and nothing is maintained).
    expect(await images({ statePath: undefined }).refreshDue({ checkBaseImage: true })).toBe(false);
    expect(docker.imageIdCalls).toBe(0);
  });
});

describe('HelperPrebuild: due for a refresh, never for the cleanup alone, and then runs the maintenance that is due (PR H)', () => {
  function prebuild(helper: HelperImages, overrides: Partial<HelperPrebuildDeps> = {}): HelperPrebuild {
    return new HelperPrebuild({
      helper,
      dockerRunning: async () => true,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      statePath: statePath(),
      checkBaseImage: () => true,
      logger,
      ...overrides,
    });
  }

  it('runs the rebuild that a check asked for in the background with the setting on, so the next open does not wait for it', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: rebuildAsked }, lastCleanupAt: TODAY });
    const helper = images();
    const running = vi.fn(async () => true);
    expect(await prebuild(helper, { dockerRunning: running }).start()).toBe('present');
    expect(running).toHaveBeenCalledTimes(1);
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ tag: TAG, pull: true, noCache: true });
    expect(docker.tags.get(TAG)).toBe(ID2);
    expect(logger.lines).toContain('info The workspace helper image is built again in the background.');
    expect(logger.lines).toContain(`info The workspace helper image ${TAG} is ready.`);
    const record = (await readState()).images[TAG];
    expect(record?.latestBaseDigest).toBeUndefined();
    expect(record?.baseDigest).toBe(DIGEST_B);
    // The preparation of the worker for an open in this window finds it done.
    expect(await helper.ensureImageUse({ checkBaseImage: true })).toEqual({ tag: TAG, id: ID2 });
    expect(docker.builds).toHaveLength(1);
  });

  it('with the setting off, a rebuild that a check asked for is not due: Docker is not asked', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: rebuildAsked }, lastCleanupAt: TODAY });
    const running = vi.fn(async () => true);
    expect(await prebuild(images(), { dockerRunning: running, checkBaseImage: () => false }).start()).toBe('notDue');
    expect(running).not.toHaveBeenCalled();
    expect(docker.imageIdCalls).toBe(0);
    expect(docker.builds).toEqual([]);
  });

  it('the daily cleanup alone does not make it due: Docker is not asked, with the setting on or off', async () => {
    docker.tags.set(TAG, ID1);
    // Checked today, no rebuild asked, and no cleanup for weeks.
    writeState({ images: { [TAG]: { baseImage: 'node:22-bookworm-slim', baseDigest: DIGEST_A, builtAt: OLD, checkedAt: TODAY } }, lastCleanupAt: OLD });
    const lookup: BaseDigestLookup = async () => DIGEST_A;
    for (const setting of [true, false]) {
      const running = vi.fn(async () => true);
      expect(await prebuild(images({ baseDigest: lookup }), { dockerRunning: running, checkBaseImage: () => setting }).start()).toBe('notDue');
      expect(running).not.toHaveBeenCalled();
    }
    expect(docker.imageIdCalls).toBe(0);
    expect(docker.listCalls).toBe(0);
    expect((await readState()).lastCleanupAt).toBe(OLD);
  });

  it('with the setting off, a prebuild for a tag without a record looks up no base image and starts no check', async () => {
    const lookup = vi.fn<BaseDigestLookup>(async () => DIGEST_A);
    const checks: Promise<void>[] = [];
    const window = (): HelperImages => images({ baseDigest: lookup, onBaseImageCheck: (check) => checks.push(check) });
    // The tag is missing: it is built with --pull, without the digest of its base image.
    expect(await prebuild(window(), { checkBaseImage: () => false }).start()).toBe('built');
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ tag: TAG, pull: true });
    // The tag exists, but the state file of this window has no record of it (another installation built it).
    fs.rmSync(statePath());
    expect(await prebuild(window(), { checkBaseImage: () => false }).start()).toBe('present');
    expect(lookup).not.toHaveBeenCalled();
    expect(checks).toEqual([]);
    expect(docker.builds).toHaveLength(1);
  });

  it('a registry that does not answer makes it contact Docker once a week, not every day (review round 1 of PR H, A-L2)', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: { baseImage: 'node:22-bookworm-slim', baseDigest: DIGEST_A, builtAt: OLD, checkedAt: OLD } }, lastCleanupAt: TODAY });
    const unreachable: BaseDigestLookup = async () => 'unreachable';
    const outcomes: HelperPrebuildOutcome[] = [];
    let asked = 0;
    // The first window start of four days: today, the next two days, and a week later.
    for (const day of [0, 1, 2, 8]) {
      const now = NOW + day * DAY + 60_000;
      const checks: Promise<void>[] = [];
      const helper = images({ baseDigest: unreachable, clock: { now: () => now }, onBaseImageCheck: (check) => checks.push(check) });
      const dockerRunning = async (): Promise<boolean> => {
        asked++;
        return true;
      };
      outcomes.push(await prebuild(helper, { dockerRunning }).start());
      await Promise.all(checks);
    }
    expect(outcomes).toEqual(['present', 'notDue', 'notDue', 'present']);
    expect(asked).toBe(2);
    expect((await readState()).images[TAG]?.attemptedAt).toBe(new Date(NOW + 8 * DAY + 60_000).toISOString());
  });

  it('a rebuild that its time limit ends counts as failed: the existing image, and the next start does not repeat it (review round 1 of PR H)', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: rebuildAsked }, lastCleanupAt: TODAY });
    // A rebuild that stalls without failing: it ends only when its signal aborts (docker build is ended).
    docker.buildHandler = (options) =>
      new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('docker build was ended')), { once: true });
      });
    const helper = images();
    // The prebuild's own wait ends at its time limit, as before ('failed', logged); the shared ensure ends the stalled
    // rebuild (its docker build) and counts it as a failed rebuild: the next check is in a week.
    expect(await prebuild(helper, { timeoutMs: 50 }).start()).toBe('failed');
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0].signal?.aborted).toBe(true);
    await vi.waitFor(async () => {
      const record = (await readState()).images[TAG];
      expect(record?.latestBaseDigest).toBeUndefined();
      expect(record?.checkedAt).toBe(new Date(NOW).toISOString());
    });
    expect(logger.lines.join('\n')).toContain(`The workspace helper image ${TAG} was not built again within its time limit, so its build was stopped. The existing image is used.`);
    // An open of this window gets the existing image, without a rebuild of its own.
    expect(await helper.ensureImageUse({ checkBaseImage: true })).toEqual({ tag: TAG, id: ID1 });
    expect(docker.builds).toHaveLength(1);
    expect(docker.tags.get(TAG)).toBe(ID1);
    // The next window start finds no rebuild asked: nothing is due, Docker is not asked.
    const running = vi.fn(async () => true);
    expect(await prebuild(images(), { dockerRunning: running }).start()).toBe('notDue');
    expect(running).not.toHaveBeenCalled();
    expect(docker.builds).toHaveLength(1);
  });

  it('a prebuild that is due for a rebuild also runs the cleanup that is due', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: rebuildAsked }, lastCleanupAt: OLD });
    expect(await prebuild(images()).start()).toBe('present');
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ tag: TAG, pull: true, noCache: true });
    // The removal of the previous image after the rebuild lists the images, and so does the cleanup.
    expect(docker.listCalls).toBe(2);
    const state = await readState();
    expect(state.lastCleanupAt).toBe(new Date(NOW).toISOString());
    expect(state.images[TAG]?.latestBaseDigest).toBeUndefined();
  });

  it('starts the weekly check of the base image when it is due; a window that starts later finds nothing due', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: { baseImage: 'node:22-bookworm-slim', baseDigest: DIGEST_A, builtAt: OLD, checkedAt: OLD } }, lastCleanupAt: TODAY });
    const checks: Promise<void>[] = [];
    const lookup = vi.fn<BaseDigestLookup>(async () => DIGEST_A);
    const helper = images({ baseDigest: lookup, onBaseImageCheck: (check) => checks.push(check) });
    expect(await prebuild(helper).start()).toBe('present');
    await Promise.all(checks);
    expect(lookup).toHaveBeenCalledWith('node:22-bookworm-slim', expect.any(AbortSignal));
    expect((await readState()).images[TAG]?.checkedAt).toBe(new Date(NOW).toISOString());
    expect(docker.builds).toEqual([]);
    const running = vi.fn(async () => true);
    expect(await prebuild(images({ baseDigest: lookup }), { dockerRunning: running }).start()).toBe('notDue');
    expect(running).not.toHaveBeenCalled();
  });

  it('extension.ts gives the prebuild the setting updateImagesOnConnect of the window', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'vscode', 'extension.ts'), 'utf8');
    expect(source).toContain('const helperPrebuild = new HelperPrebuild({');
    expect(source).toContain('checkBaseImage: () => getSettings().updateImagesOnConnect,');
  });

  it('a rebuild that fails keeps the image: present, not built, and the next check is in a week', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: rebuildAsked }, lastCleanupAt: TODAY });
    docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'Temporary failure resolving deb.debian.org');
    };
    expect(await prebuild(images()).start()).toBe('present');
    expect(docker.tags.get(TAG)).toBe(ID1);
    expect(logger.lines.join('\n')).toContain(`The workspace helper image ${TAG} could not be built again. The existing image is used`);
    const record = (await readState()).images[TAG];
    expect(record?.latestBaseDigest).toBeUndefined();
    expect(record?.checkedAt).toBe(new Date(NOW).toISOString());
  });
});

describe('the preparation of the worker for an open runs the maintaining ensure (PR H)', () => {
  /** The preparation of the workers of a window (heartbeatHelperImage, as heartbeatWiring makes it) over `helper`. */
  function preparationOf(helper: HelperImages) {
    const preparation = new HeartbeatPreparation(HELPER_PREBUILD_TIMEOUT_MS, { now: () => NOW });
    const outputs: string[] = [];
    const image = heartbeatHelperImage({ preparation, helper, inTarget: (_target, fn) => fn(), onOutput: (text) => outputs.push(text) });
    const events: string[] = [];
    const maintenance = (checkBaseImage: boolean): HelperMaintenance => ({
      checkBaseImage,
      onBuild: (kind) => events.push(`build ${kind}`),
      onBuildEnd: () => events.push('end'),
    });
    return { preparation, image, outputs, events, maintenance };
  }

  it('runs the rebuild that a check asked for before the worker starts, with its progress and output, only with the setting on', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: rebuildAsked }, lastCleanupAt: TODAY });
    const off = preparationOf(images());
    await off.image.prepareWorker(LOCAL, undefined, off.maintenance(false));
    expect(docker.builds).toEqual([]);
    expect(off.events).toEqual([]);
    off.preparation.dispose();
    // Another window, with the setting on.
    const on = preparationOf(images());
    await on.image.prepareWorker(LOCAL, undefined, on.maintenance(true));
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ tag: TAG, pull: true, noCache: true });
    expect(docker.tags.get(TAG)).toBe(ID2);
    expect(on.events).toEqual(['build refresh', 'end']);
    expect(on.outputs).toEqual([`#1 building ${TAG}`]);
    on.preparation.dispose();
  });

  it('runs the cleanup that is due, also with the setting off', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: { baseImage: 'node:22-bookworm-slim', baseDigest: DIGEST_A, builtAt: OLD, checkedAt: TODAY } }, lastCleanupAt: OLD });
    const { preparation, image, maintenance } = preparationOf(images());
    await image.prepareWorker(LOCAL, undefined, maintenance(false));
    expect(docker.builds).toEqual([]);
    expect(docker.listCalls).toBe(1);
    expect((await readState()).lastCleanupAt).toBe(new Date(NOW).toISOString());
    preparation.dispose();
  });

  it('a rebuild that fails keeps the image: the preparation succeeds, so the worker of the open starts from it', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: rebuildAsked }, lastCleanupAt: TODAY });
    docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'no space left on device');
    };
    const { preparation, image, events, maintenance } = preparationOf(images());
    await expect(image.prepareWorker(LOCAL, undefined, maintenance(true))).resolves.toBeUndefined();
    expect(docker.tags.get(TAG)).toBe(ID1);
    expect(events).toEqual(['build refresh', 'end']);
    preparation.dispose();
  });

  it('joins the rebuild of the background prebuild with its progress; another preparation uses the present tag at once', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: rebuildAsked }, lastCleanupAt: TODAY });
    let release = (): void => undefined;
    docker.buildHandler = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const helper = images();
    const pre = helper.prebuildImage({ signal: new AbortController().signal, checkBaseImage: true });
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const { preparation, image, events, maintenance } = preparationOf(helper);
    // A Stop or a heartbeat (no maintenance): the tag exists, so it does not wait for the rebuild (A-R2-1).
    await image.prepareWorker(LOCAL, undefined);
    let opened = false;
    const open = image.prepareWorker(LOCAL, undefined, maintenance(true)).then(() => (opened = true));
    await vi.waitFor(() => expect(events).toEqual(['build refresh']));
    expect(opened).toBe(false);
    release();
    expect(await pre).toEqual({ tag: TAG, id: ID2 });
    await open;
    expect(events).toEqual(['build refresh', 'end']);
    expect(docker.builds).toHaveLength(1);
    preparation.dispose();
  });
});

describe('the time limit of a rebuild that a check asked for (review round 1 of PR H)', () => {
  /** A rebuild that stalls without failing: it ends only when its signal aborts (then docker build is ended). */
  const stalled = (options: BuildOptions): Promise<void> =>
    new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });

  it('a rebuild that never ends is stopped after HELPER_REBUILD_TIMEOUT_MS and counts as failed: the existing image, the warning, the next check in a week', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: rebuildAsked }, lastCleanupAt: TODAY });
    docker.buildHandler = stalled;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const ensure = ensureHelperImageUse(docker, path.join(dir, 'Dockerfile'), { statePath: statePath(), clock: { now: () => NOW }, logger, checkBaseImage: true });
      // Not vi.waitFor (it would advance the fake clock): wait by the real clock until the build runs.
      const deadline = Date.now() + 10_000;
      while (docker.builds.length === 0 && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
      expect(docker.builds).toHaveLength(1);
      expect(docker.builds[0]).toMatchObject({ tag: TAG, pull: true, noCache: true });
      await vi.advanceTimersByTimeAsync(HELPER_REBUILD_TIMEOUT_MS - 1_000);
      expect(docker.builds[0].signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await ensure).toEqual({ tag: TAG, id: ID1 });
      // The signal of the build ended it (BootstrapDocker ends the docker build process with it).
      expect(docker.builds[0].signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(docker.tags.get(TAG)).toBe(ID1);
    expect(logger.lines).toContain(`warn The workspace helper image ${TAG} was not built again within its time limit, so its build was stopped. The existing image is used.`);
    const record = (await readState()).images[TAG];
    expect(record?.latestBaseDigest).toBeUndefined();
    expect(record?.checkedAt).toBe(new Date(NOW).toISOString());
  });

  it('a cancel of the caller during the rebuild still rejects with an AbortError and changes nothing', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: rebuildAsked }, lastCleanupAt: TODAY });
    docker.buildHandler = stalled;
    const controller = new AbortController();
    const ensure = ensureHelperImageUse(docker, path.join(dir, 'Dockerfile'), {
      statePath: statePath(),
      clock: { now: () => NOW },
      logger,
      checkBaseImage: true,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    controller.abort();
    expect(await ensure).toMatchObject({ name: 'AbortError' });
    expect(docker.builds[0].signal?.aborted).toBe(true);
    expect(docker.tags.get(TAG)).toBe(ID1);
    // The rebuild that the check asked for is still asked for: the next ensure builds again.
    expect((await readState()).images[TAG]).toMatchObject({ latestBaseDigest: DIGEST_B, checkedAt: TODAY });
    expect(logger.lines.join('\n')).not.toContain('could not be built again');
    expect(logger.lines.join('\n')).not.toContain('within its time limit');
  });
});
