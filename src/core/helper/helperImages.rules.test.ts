// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I (U7, decision of 2026-10-08): the rules of the helper image of the extension (HelperImages, the
// background prebuild HelperPrebuild, and the functions of helperImages.ts), moved from workspaceHelper.test.ts, which
// tested them through WorkspaceHelper while it delegated to HelperImages. WorkspaceHelper runs only in the worker now,
// from the worker's own image (workspaceHelper.test.ts), so each test here calls HelperImages itself. A helper run
// without the image of an open (before: a step of WorkspaceHelper in a batch scope, `helperStep`) got its image from
// HelperImages.runImage, so such a run is runImage here, with the image that it gives; a run with the pinned image of
// an open never reached HelperImages, so what such a run showed (that the engine still has the pinned image) is checked
// on the images of the fake engine (`present`).
import { AsyncLocalStorage } from 'async_hooks';
import * as crypto from 'crypto';
import { getEventListeners } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageInfo } from '../docker/dockerObjects';
import { LOCAL_DOCKER_TARGET, type DockerTarget } from '../docker/dockerHost';
import { operationDockerTarget } from '../docker/dockerTargets';
import { REMOTE_INFO_TIMEOUT_MS } from '../docker/remoteDocker';
import { CommandError, UserFacingError, isUserFacingError } from '../errors';
import { abortError, isAbortError, type Logger, type RunOptions, type RunResult } from '../ports';
import { HELPER_CHECK_INTERVAL_MS, HELPER_GENERATION, helperImageTag, type BaseDigestLookup, type HelperImageUse } from './helperImage';
import { HELPER_PREBUILD_TIMEOUT_MS, HelperPrebuild, dockerEngineAnswers, type HelperPrebuildDeps } from './helperPrebuild';
import type { HelperState } from './helperState';
import {
  DOCKER_SOCKET,
  HELPER_IMAGE_RECHECK_MS,
  HelperImages,
  helperDockerSocket,
  helperStatePathFor,
  type HelperEngine,
  type HelperImageDocker,
  type HelperImagesDeps,
} from './helperImages';

const DOCKERFILE = 'FROM node:22-bookworm-slim\n';
const TAG = helperImageTag(DOCKERFILE);
/** Plan step 6, PR D: a remote SSH engine for the background prebuild. */
const REMOTE_TARGET: DockerTarget = { kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box', context: 'devenv-build-box' };

type BuildOptions = Parameters<HelperImageDocker['buildImage']>[0];

/**
 * The image ID of the fake for a tag: a full `sha256:` ID, which helper.json keeps (review round 1 of PR #64, S5: an ID
 * of another form, like the former `id:<tag>`, is dropped).
 */
function fakeImageId(tag: string): string {
  return `sha256:${crypto.createHash('sha256').update(tag).digest('hex')}`;
}

/** Plan step 11I (U7): the image part of the FakeDocker of workspaceHelper.test.ts (without its `docker run`). */
class FakeDocker implements HelperImageDocker {
  readonly images = new Set<string>();
  /** Image IDs that differ from fakeImageId(tag): a tag that points to another image now. */
  readonly ids = new Map<string, string>();
  readonly builds: BuildOptions[] = [];
  buildHandler: (options: BuildOptions) => Promise<void> = async () => undefined;

  /** Calls of imageId: each one is a run of ensureHelperImage with a state file. */
  imageIdCalls = 0;
  /** Calls of listImagesByLabel: the cleanup, or the removal of the previous image after a rebuild. */
  listCalls = 0;
  readonly removals: string[] = [];

  async imageExists(reference: string): Promise<boolean> {
    return this.images.has(reference);
  }

  async imageId(reference: string): Promise<string | undefined> {
    this.imageIdCalls++;
    return this.images.has(reference) ? this.idOf(reference) : undefined;
  }

  idOf(tag: string): string {
    return this.ids.get(tag) ?? fakeImageId(tag);
  }

  /** Review round 3 of PR #64 (P4): returns the ID of the built image, as BootstrapDocker.buildImage finds it by its build label. */
  async buildImage(options: BuildOptions): Promise<string | undefined> {
    this.builds.push(options);
    await this.buildHandler(options);
    this.images.add(options.tag);
    return this.idOf(options.tag);
  }

  async listImagesByLabel(): Promise<ImageInfo[]> {
    this.listCalls++;
    return [...this.images].map((tag) => ({ id: this.idOf(tag), tags: [tag], createdAt: '' }));
  }

  async removeImage(reference: string): Promise<boolean> {
    this.removals.push(reference);
    return this.images.delete(reference);
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

/**
 * Plan step 11I (U7): whether the engine of the fake has the image `use` (its ID): what a run with the pinned image of
 * an open showed before (its `docker run` of the image ID found it).
 */
function present(use: HelperImageUse): boolean {
  return [...docker.images].some((tag) => docker.idOf(tag) === use.id);
}

/** Plan step 11I (U7): the helper image of a window (before: createHelper, a WorkspaceHelper that delegated to it). */
function createImages(): HelperImages {
  return new HelperImages({
    docker,
    logger,
    dockerfilePath: path.join(dir, 'Dockerfile'),
    env: {},
    platform: 'darwin',
    clock: { now: () => Date.parse('2026-09-24T17:10:00Z') },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE);
  docker = new FakeDocker();
  logger = new RecordingLogger();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('helperDockerSocket', () => {
  it('uses /var/run/docker.sock by default and with Docker Desktop', () => {
    expect(helperDockerSocket({}, 'linux')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({ DOCKER_HOST: 'unix:///Users/me/.docker/run/docker.sock' }, 'darwin')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' }, 'win32')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({ DOCKER_HOST: 'unix:///home/me/.docker/desktop/docker.sock' }, 'linux')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({ DOCKER_HOST: 'tcp://10.0.0.1:2376' }, 'linux')).toBe(DOCKER_SOCKET);
  });

  it('uses the path of a unix:// DOCKER_HOST on Linux (for example rootless Docker)', () => {
    expect(helperDockerSocket({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, 'linux')).toBe('/run/user/1000/docker.sock');
  });

  // Unit 7: the endpoint of the current Docker context, like DOCKER_HOST (a context of a local rootless engine).
  it('uses the endpoint of the current Docker context with the same rules', () => {
    expect(helperDockerSocket({}, 'linux', 'unix:///run/user/1000/docker.sock')).toBe('/run/user/1000/docker.sock');
    expect(helperDockerSocket({}, 'linux', 'unix:///home/me/.docker/desktop/docker.sock')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({}, 'darwin', 'unix:///Users/me/.docker/run/docker.sock')).toBe(DOCKER_SOCKET);
    expect(helperDockerSocket({ DOCKER_HOST: 'unix:///run/user/1/docker.sock' }, 'linux', '')).toBe('/run/user/1/docker.sock');
  });
});

describe('helperStatePathFor (unit 7)', () => {
  it('keeps helper.json for the local Docker and gives each remote host a file of its own', () => {
    expect(helperStatePathFor('/s/helper.json', '')).toBe('/s/helper.json');
    const box = helperStatePathFor('/s/helper.json', 'box');
    expect(box).toMatch(/^\/s\/helper-remote-[0-9a-f]{16}\.json$/);
    expect(helperStatePathFor('/s/helper.json', 'me@box')).not.toBe(box);
  });
});

describe('HelperImages.ensureImage', () => {
  it('shares one build between concurrent callers', async () => {
    const helper = createImages();
    const tags = await Promise.all([helper.ensureImage(), helper.ensureImage(), helper.ensureImage()]);
    expect(tags).toEqual([TAG, TAG, TAG]);
    expect(docker.builds).toHaveLength(1);
  });

  it('reports a failed build as helperFailed and tries again at the next call', async () => {
    const helper = createImages();
    docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'network error');
    };
    const error = await helper.ensureImage().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).toMatchObject({ code: 'helperFailed', message: 'The workspace helper could not be prepared.' });
    expect((error as UserFacingError).detail).toContain('network error');

    docker.buildHandler = async () => undefined;
    await expect(helper.ensureImage()).resolves.toBe(TAG);
    expect(docker.builds).toHaveLength(2);
  });

  it('passes other user-facing errors through', async () => {
    const helper = createImages();
    docker.imageExists = async () => {
      throw new UserFacingError('dockerNotInstalled', 'Docker Desktop is not installed.');
    };
    await expect(helper.ensureImage()).rejects.toMatchObject({ code: 'dockerNotInstalled' });
  });

  it('fails with helperFailed when the Dockerfile cannot be read', async () => {
    fs.rmSync(path.join(dir, 'Dockerfile'));
    await expect(createImages().ensureImage()).rejects.toMatchObject({ code: 'helperFailed' });
  });
});

describe('HelperImages.ensureImage with a state file (implementation notes 7)', () => {
  const START = Date.parse('2026-09-24T12:00:00Z');
  const DIGEST = `sha256:${'a'.repeat(64)}`;

  function setup(answer: () => Promise<string | 'unreachable' | undefined> = async () => DIGEST) {
    let now = START;
    const lookups: string[] = [];
    const checks: Array<Promise<void>> = [];
    const baseDigest: BaseDigestLookup = (reference) => {
      lookups.push(reference);
      return answer();
    };
    const statePath = path.join(dir, 'storage', 'helper.json');
    const deps: HelperImagesDeps = {
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'darwin',
      clock: { now: () => now },
      statePath,
      baseDigest,
      onBaseImageCheck: (check) => checks.push(check),
    };
    return {
      helper: new HelperImages(deps),
      lookups,
      advance: (ms: number) => {
        now += ms;
      },
      iso: (offsetMs = 0) => new Date(now + offsetMs).toISOString(),
      state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState,
      /** Waits for the checks of the base image that ensureImage started in the background. */
      settled: () => Promise.all(checks.splice(0)),
    };
  }

  it('builds a new helper with --pull and records the digest of its base image', async () => {
    const { helper, lookups, state, iso } = setup();
    expect(await helper.ensureImage()).toBe(TAG);
    expect(lookups).toEqual(['node:22-bookworm-slim']);
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ tag: TAG, pull: true });
    // Changed expectation (user decision 2026-09-29, for diagnosis since "no previous helper image"; review round 3 of PR #64,
    // P4; review round 4, R4-2/R4-3; comment corrected in review round 25, A-R25-1): the ID of the image that this build
    // made, found by its build label.
    expect(state().images[TAG]).toEqual({
      baseImage: 'node:22-bookworm-slim',
      baseDigest: DIGEST,
      builtAt: iso(),
      checkedAt: iso(),
      lastUsedAt: iso(),
      // Changed expectation (review round 1 of PR #64, S5): the fake gives full sha256: IDs, the only form helper.json keeps.
      imageId: fakeImageId(TAG),
      // Changed expectation (review round 2 of PR #64, A-N2): the build records the helper generation.
      generation: HELPER_GENERATION,
    });
  });

  it('uses the existing image when the registry cannot be reached', async () => {
    docker.images.add(TAG);
    const { helper, lookups, state, settled } = setup(async () => 'unreachable');
    expect(await helper.ensureImage()).toBe(TAG);
    await settled();
    expect(lookups).toHaveLength(1);
    expect(docker.builds).toHaveLength(0);
    expect(state().images[TAG].checkedAt).toBeUndefined();
    // Plan step 11I (U7, decision of 2026-10-08): changed expectation, a helper run gets the existing image (runImage;
    // before: a step of WorkspaceHelper with it, which ran with exit code 0).
    expect(await helper.runImage({})).toEqual({ tag: TAG, id: fakeImageId(TAG) });
  });

  it('reuses the image for an hour; after that, ensureImage checks again, and the helper runs only record the use', async () => {
    // Plan step 11I (U7, decision of 2026-10-08): changed setup, each helper run is runImage (before: a step of
    // WorkspaceHelper, which got its image from runImage).
    const { helper, lookups, advance, iso, state, settled } = setup();
    await helper.ensureImage();
    const calls = docker.imageIdCalls;
    expect(calls).toBeGreaterThan(0);

    // A long-lived window: the helper runs of a stop or a delete never check or rebuild.
    // 2026-10-01: the Switch branch command was dropped (user decision).
    advance(HELPER_CHECK_INTERVAL_MS + HELPER_IMAGE_RECHECK_MS);
    await helper.runImage({});
    expect(docker.imageIdCalls).toBe(calls);
    expect(lookups).toHaveLength(1);
    expect(state().images[TAG].lastUsedAt).toBe(iso());
    const used = iso();
    advance(10 * 60 * 1000);
    await helper.runImage({});
    expect(state().images[TAG].lastUsedAt).toBe(used);

    // The open pipeline (ensureImage) runs ensureHelperImage again: the weekly check is due.
    await helper.ensureImage();
    await settled();
    expect(docker.imageIdCalls).toBe(calls + 1);
    expect(lookups).toHaveLength(2);
    expect(state().images[TAG].checkedAt).toBe(iso());
    await helper.ensureImage();
    // Changed expectation (review round 4 of PR #64, R4-1): an open that reuses the cache checks once that the tag still
    // has the cached image (one imageId call), without running ensureHelperImage again.
    expect(docker.imageIdCalls).toBe(calls + 2);
    expect(lookups).toHaveLength(2);
    expect(docker.builds).toHaveLength(1);
  });
});

describe('HelperImages reuses its cached helper image only while the tag still has it (review round 4 of PR #64, R4-1)', () => {
  const START = Date.parse('2026-09-24T12:00:00Z');
  const I1 = fakeImageId(TAG);
  const I2 = `sha256:${'2'.repeat(64)}`;
  const DIGEST_A = `sha256:${'a'.repeat(64)}`;
  const DIGEST_B = `sha256:${'b'.repeat(64)}`;

  /** Two windows with the same Docker engine and the same helper.json. */
  function windows() {
    const now = START;
    const statePath = path.join(dir, 'storage', 'helper.json');
    const window = (baseDigest?: BaseDigestLookup) =>
      new HelperImages({ docker, logger, dockerfilePath: path.join(dir, 'Dockerfile'), env: {}, platform: 'darwin', clock: { now: () => now }, statePath, baseDigest });
    // Plan step 11I (U7, decision of 2026-10-08): changed setup, no `docker run` that answers "No such image" for an
    // image ID that no tag has anymore: a run of the pinned image of an open is checked with `present`.
    return { a: window(), b: window(async () => DIGEST_B), statePath };
  }

  it('gives the next open of window A the image that window B rebuilt, without a build, after B removed the old image', async () => {
    // Plan step 11I (U7, decision of 2026-10-08): changed expectation, the engine has the pinned image of each open
    // (`present`; before: a step of WorkspaceHelper with it ran with exit code 0, and the last one used I2).
    const { a, b, statePath } = windows();
    const first = await a.ensureImageUse();
    expect(first).toEqual({ tag: TAG, id: I1 });
    expect(present(first)).toBe(true);
    // Window B rebuilds the tag from a new base image (a check asked for it); the image I1 is gone.
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState;
    saved.images[TAG] = { ...saved.images[TAG], baseImage: 'node:22-bookworm-slim', baseDigest: DIGEST_A, latestBaseDigest: DIGEST_B };
    fs.writeFileSync(statePath, JSON.stringify(saved));
    docker.buildHandler = async () => {
      docker.ids.set(TAG, I2);
    };
    expect(await b.ensureImageUse()).toEqual({ tag: TAG, id: I2 });
    const builds = docker.builds.length;
    // Within the hour of its cache, the next open of window A pins the new image and succeeds.
    const second = await a.ensureImageUse();
    expect(second).toEqual({ tag: TAG, id: I2 });
    expect(docker.builds).toHaveLength(builds);
    expect(present(second)).toBe(true);
  });

  it('builds the tag again for the next open of window A after a prune removed it', async () => {
    // Plan step 11I (U7, decision of 2026-10-08): changed expectation, the engine has the pinned image of the open
    // (`present`; before: a step of WorkspaceHelper with it ran with exit code 0).
    const { a } = windows();
    expect(await a.ensureImageUse()).toEqual({ tag: TAG, id: I1 });
    // docker image prune -a.
    docker.images.delete(TAG);
    docker.buildHandler = async () => {
      docker.ids.set(TAG, I2);
    };
    const image = await a.ensureImageUse();
    expect(image).toEqual({ tag: TAG, id: I2 });
    expect(docker.builds).toHaveLength(2);
    expect(present(image)).toBe(true);
  });

  it('resets the cache of the window when its image is gone, and keeps it when Docker cannot answer the check', async () => {
    const { a } = windows();
    await a.ensureImageUse();
    // Another window moved the tag; the pinned image of this open is gone.
    docker.ids.set(TAG, I2);
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed, and with it the reset of the cache by a
    // pinned run that found its image gone (a batch helper with that image cannot be started, the step is refused). Changed
    // expectation: the next open finds the moved tag by the check of its cached image and resolves the new image.
    expect(await a.ensureImageUse()).toEqual({ tag: TAG, id: I2 });

    // Docker does not answer the check of the cached image: the cache stays.
    const calls = docker.imageIdCalls;
    const imageId = docker.imageId.bind(docker);
    docker.imageId = async () => {
      throw new CommandError('docker image inspect', 1, '', 'Cannot connect to the Docker daemon');
    };
    expect(await a.ensureImageUse()).toEqual({ tag: TAG, id: I2 });
    docker.imageId = imageId;
    expect(docker.imageIdCalls).toBe(calls);
    expect(docker.builds).toHaveLength(1);
    expect(logger.lines.join('\n')).toContain(`The workspace helper image ${TAG} could not be checked`);
  });

  it('awaits the new cache when it was replaced during the check', async () => {
    const { a } = windows();
    await a.ensureImageUse();
    // Plan step 11F2: the cache of the helper image is in HelperImages. Plan step 11I (U7): changed setup, HelperImages
    // itself (before: the `images` of the WorkspaceHelper).
    const cache = a as unknown as { resetImage(): void; imagePromise: Promise<HelperImageUse> };
    const I3 = `sha256:${'3'.repeat(64)}`;
    const calls = docker.imageIdCalls;
    const imageId = docker.imageId.bind(docker);
    let replaced = false;
    docker.imageId = async (reference) => {
      if (!replaced) {
        replaced = true;
        // Meanwhile, a run outside an open found its image missing and reset the cache (resetImage).
        cache.resetImage();
        docker.ids.set(TAG, I2);
        // The new (pending) result of another caller; this caller awaits it and does not reset it.
        cache.imagePromise = Promise.resolve({ tag: TAG, id: I3 });
      }
      return imageId(reference);
    };
    expect(await a.ensureImageUse()).toEqual({ tag: TAG, id: I3 });
    expect(docker.imageIdCalls).toBe(calls + 1);
  });
});

describe('HelperImages keeps the helper image of each engine apart for overlapping opens (review round 8 of PR #64, R8-1)', () => {
  const REMOTE_ID = `sha256:${'r'.repeat(64)}`;

  /**
   * One window with two engines: the local Docker and a remote one (key `box`). Each operation keeps its engine, as the
   * Docker target of an open does (AsyncLocalStorage); the Docker calls go to the engine of the operation.
   */
  function engines() {
    const als = new AsyncLocalStorage<string>();
    const local = new FakeDocker();
    const remote = new FakeDocker();
    remote.ids.set(TAG, REMOTE_ID);
    const dispatch = new Proxy({} as HelperImageDocker, {
      get: (_target, property) => {
        const target = als.getStore() === 'box' ? remote : local;
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const helper = new HelperImages({
      docker: dispatch,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'linux',
      clock: { now: () => Date.parse('2026-09-24T12:00:00Z') },
      statePath: path.join(dir, 'storage', 'helper.json'),
      engine: async () => ({ key: als.getStore() ?? '' }),
    });
    const onRemote = <T>(action: () => Promise<T>): Promise<T> => als.run('box', action);
    return { helper, local, remote, onRemote };
  }

  /** A build of `docker` that waits for `release`. */
  function blockBuild(docker: FakeDocker): { release: () => void } {
    const gate = { release: () => undefined as void };
    docker.buildHandler = () =>
      new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    return gate;
  }

  it('gives a local open the local image when a remote open replaced the cache during the check of the cached image', async () => {
    const { helper, local, remote, onRemote } = engines();
    expect(await helper.ensureImageUse()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    // The next local open checks the cached image (cachedImageCurrent); the check waits.
    const imageId = local.imageId.bind(local);
    let answer: (() => void) | undefined;
    local.imageId = (reference) =>
      new Promise((resolve) => {
        answer = () => resolve(imageId(reference));
      });
    const first = helper.ensureImageUse();
    await vi.waitFor(() => expect(answer).toBeDefined());
    local.imageId = imageId;
    // Meanwhile, an open on the remote engine replaces the cache with the image of its engine.
    expect(await onRemote(() => helper.ensureImageUse())).toEqual({ tag: TAG, id: REMOTE_ID });
    answer?.();
    expect(await first).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(local.builds).toHaveLength(1);
    expect(remote.builds).toHaveLength(1);
  });

  it('gives a local open that joins the prebuild the local image when a remote open replaced the cache meanwhile', async () => {
    const { helper, local, remote, onRemote } = engines();
    const localBuild = blockBuild(local);
    const pre = helper.prebuildImage({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(local.builds).toHaveLength(1));
    // The local open joins the prebuild (the result of a helper run without the maintenance).
    const first = helper.ensureImageUse();
    // Meanwhile, an open on the remote engine starts the build of its engine.
    const remoteBuild = blockBuild(remote);
    const second = onRemote(() => helper.ensureImageUse());
    await vi.waitFor(() => expect(remote.builds).toHaveLength(1));
    localBuild.release();
    expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    remoteBuild.release();
    expect(await first).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await second).toEqual({ tag: TAG, id: REMOTE_ID });
    expect(local.builds).toHaveLength(1);
    expect(remote.builds).toHaveLength(1);
  });

  // Review round 20 of PR #64 (B-R20-5d): a replaced (stale) ensure touches neither the cache nor the progress of the new one.
  it('a replaced ensure that fails later leaves the cache of the other engine alone: no second build', async () => {
    const { helper, local, remote, onRemote } = engines();
    let fail: (() => void) | undefined;
    let failed = false;
    // The build with --pull waits for `fail`; the retry without --pull fails at once.
    local.buildHandler = () =>
      failed
        ? Promise.reject(new CommandError('docker build', 1, '', 'network unreachable'))
        : new Promise<void>((_resolve, reject) => {
            fail = () => {
              failed = true;
              reject(new CommandError('docker build', 1, '', 'network unreachable'));
            };
          });
    const first = helper.ensureImageUse().catch((error: unknown) => error);
    await vi.waitFor(() => expect(fail).toBeDefined());
    const remoteBuild = blockBuild(remote);
    const second = onRemote(() => helper.ensureImageUse());
    await vi.waitFor(() => expect(remote.builds).toHaveLength(1));
    // The replaced local ensure fails while the remote build runs.
    fail?.();
    expect(await first).toMatchObject({ code: 'helperFailed' });
    // Another remote open joins the running remote build.
    const third = onRemote(() => helper.ensureImageUse());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(remote.builds).toHaveLength(1);
    remoteBuild.release();
    expect(await second).toEqual({ tag: TAG, id: REMOTE_ID });
    expect(await third).toEqual({ tag: TAG, id: REMOTE_ID });
    expect(remote.builds).toHaveLength(1);
  });

  it('a replaced ensure that succeeds later does not put its image into the cache of the other engine', async () => {
    const { helper, local, onRemote } = engines();
    const localBuild = blockBuild(local);
    const first = helper.ensureImageUse();
    await vi.waitFor(() => expect(local.builds).toHaveLength(1));
    expect(await onRemote(() => helper.ensureImageUse())).toEqual({ tag: TAG, id: REMOTE_ID });
    localBuild.release();
    expect(await first).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    // The next remote open reuses its cache: no "has another image now".
    expect(await onRemote(() => helper.ensureImageUse())).toEqual({ tag: TAG, id: REMOTE_ID });
    expect(logger.lines.join('\n')).not.toContain('It is prepared again');
  });

  it('a replaced ensure that starts its build later gives no build progress to an open of the other engine', async () => {
    const { helper, local, remote, onRemote } = engines();
    remote.images.add(TAG);
    // The local ensure waits before it finds its tag missing.
    const imageId = local.imageId.bind(local);
    let answer: (() => void) | undefined;
    local.imageId = (reference) =>
      new Promise((resolve) => {
        answer = () => resolve(imageId(reference));
      });
    const first = helper.ensureImageUse();
    await vi.waitFor(() => expect(answer).toBeDefined());
    local.imageId = imageId;
    expect(await onRemote(() => helper.ensureImageUse())).toEqual({ tag: TAG, id: REMOTE_ID });
    answer?.();
    expect(await first).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(local.builds).toHaveLength(1);
    const onBuild = vi.fn();
    expect(await onRemote(() => helper.ensureImageUse({ onBuild }))).toEqual({ tag: TAG, id: REMOTE_ID });
    expect(remote.builds).toEqual([]);
    expect(onBuild).not.toHaveBeenCalled();
  });
});

describe('HelperImages without a previous helper image (user decision 2026-09-29)', () => {
  /** A helper image of an older extension version that this installation built. It is never used. */
  const OLDER = 'devenv-helper:0123456789ab';
  const START = Date.parse('2026-09-24T12:00:00Z');

  function setup() {
    let now = START;
    const statePath = path.join(dir, 'storage', 'helper.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    docker.images.add(OLDER);
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, images: { [OLDER]: { builtAt: '2026-09-20T12:00:00.000Z', imageId: fakeImageId(OLDER), generation: HELPER_GENERATION } } }),
    );
    const helper = new HelperImages({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'darwin',
      clock: { now: () => now },
      statePath,
    });
    return {
      helper,
      advance: (ms: number) => {
        now += ms;
      },
      state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState,
    };
  }

  const offline = async (): Promise<void> => {
    throw new CommandError('docker build', 1, '', 'Temporary failure resolving deb.debian.org');
  };

  it('fails with helperFailed when the current tag cannot be built, never runs an older helper image, and builds the tag again at the next ensureImage', async () => {
    // user decision 2026-09-29: no previous helper image. Changed expectation: before, the older helper image of this
    // installation was returned and the helper runs used it by its image ID. Plan step 11I (U7, decision of
    // 2026-10-08): changed expectation, a helper run gets no image (runImage fails; before: a step of WorkspaceHelper
    // failed and ran no container) and then the image of the current tag (before: the step ran with its ID).
    const { helper, advance } = setup();
    docker.buildHandler = offline;
    const error = await helper.ensureImageUse().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'helperFailed' });
    expect((error as UserFacingError).message).toBe('The workspace helper could not be prepared.');
    await expect(helper.runImage({})).rejects.toMatchObject({ code: 'helperFailed' });
    expect(logger.lines.join('\n')).not.toContain('previous helper');

    // The next open (online again) builds the current tag and uses it.
    docker.buildHandler = async () => undefined;
    advance(60_000);
    expect(await helper.ensureImageUse()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    // Plan step 7 (user decision of 2026-10-01): the per-step path is removed; changed expectation: the step runs in a
    // batch helper, which is started with the image ID of the current tag (was: the tag).
    expect(await helper.runImage({})).toEqual({ tag: TAG, id: fakeImageId(TAG) });
  });

  it('keeps the runs of an open on the image ID of its current tag when another window rebuilds the tag in the middle of the open (review round 3 of PR #64, P2)', async () => {
    // Plan step 11I (U7, decision of 2026-10-08): changed expectation, the image that the open pinned stays as it was,
    // and a helper run after the ensure of withEnvironmentLock (ensureImagePresent) gets the image that the tag has
    // now, by its ID (runImage). Before: the steps of WorkspaceHelper with these images; that the steps of an open run
    // its pinned `image` is tested in workspaceHelper.test.ts ("every public method runs the helper image of the open
    // that it gets as `image`").
    const { helper } = setup();
    const image = await helper.ensureImageUse();
    expect(image.id).toBe(fakeImageId(TAG));
    // Another window rebuilds the tag (--pull --no-cache): the tag points to another image now.
    const rebuilt = `sha256:${'7'.repeat(64)}`;
    docker.ids.set(TAG, rebuilt);
    expect(image).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    await helper.ensureImagePresent();
    const run = await helper.runImage({});
    expect(run.id).toBe(rebuilt);
    expect(run.id).not.toBe(fakeImageId(TAG));
  });

  it('pins the image that the ensure of the open awaited when the cache of the window is replaced while it is pending (review round 3 of PR #64, P1)', async () => {
    // user decision 2026-09-29: no previous helper image. Changed expectation: before, the open was offline and pinned the
    // previous helper; now the pending ensure of the open builds the current tag while a helper run of another Docker
    // engine replaces the cache, and the open still gets the image that its ensure built. Plan step 11I (U7, decision
    // of 2026-10-08): changed expectation, the helper run of the other engine is runImage (before: a step of
    // WorkspaceHelper that got its image from it), and the run of the open with its pinned image is WorkspaceHelper's
    // (tested in workspaceHelper.test.ts: "every public method runs the helper image of the open that it gets as
    // `image`").
    const { helper } = setup();
    let engineKey = '';
    (helper as unknown as { deps: HelperImagesDeps }).deps.engine = async () => ({ key: engineKey });
    let release: () => void = () => undefined;
    let first = true;
    docker.buildHandler = async () => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
    };
    const pending = helper.ensureImageUse();
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    // A helper run for another engine replaces the cache while the build of the open still runs.
    engineKey = 'ssh://build-box';
    const other = helper.runImage({}).catch((e: unknown) => e);
    expect(await other).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    release();
    const image = await pending;
    expect(image).toEqual({ tag: TAG, id: fakeImageId(TAG) });
  });
});

describe('HelperImages.prebuildImage and HelperPrebuild (background prebuild, user decision 2026-09-29)', () => {
  const statePath = () => path.join(dir, 'storage', 'helper.json');

  function stateHelper(engine?: () => Promise<HelperEngine>): HelperImages {
    return new HelperImages({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'darwin',
      clock: { now: () => Date.parse('2026-09-24T12:00:00Z') },
      statePath: statePath(),
      engine,
    });
  }

  /** A build that waits for `release` and ends with an AbortError when its signal aborts. */
  function blockingBuild(): { release: () => void } {
    const gate = { release: () => undefined as void };
    docker.buildHandler = (options) =>
      new Promise<void>((resolve, reject) => {
        gate.release = resolve;
        options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    return gate;
  }

  function prebuild(helper: HelperImages, overrides: Partial<HelperPrebuildDeps> = {}): HelperPrebuild {
    return new HelperPrebuild({
      helper,
      dockerRunning: async () => true,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      statePath: statePath(),
      logger,
      ...overrides,
    });
  }

  it('builds a missing tag once: an open that starts during the prebuild waits for it and does not build again', async () => {
    // Plan step 11I (U7, decision of 2026-10-08): changed expectation, the helper run is runImage and gets the built
    // image (before: a step of WorkspaceHelper that got its image from it, and ran with exit code 0).
    const helper = stateHelper();
    const gate = blockingBuild();
    const pre = helper.prebuildImage({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const open = helper.ensureImageUse();
    const run = helper.runImage({});
    gate.release();
    expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await run).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ tag: TAG, pull: true });
  });

  it('joins the build of an open that runs already', async () => {
    const helper = stateHelper();
    const gate = blockingBuild();
    const open = helper.ensureImageUse();
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const pre = helper.prebuildImage({ signal: new AbortController().signal });
    gate.release();
    expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(1);
  });

  it('is cancelled by its signal; an open that waited for it builds for itself', async () => {
    const helper = stateHelper();
    blockingBuild();
    const controller = new AbortController();
    const pre = helper.prebuildImage({ signal: controller.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const open = helper.ensureImageUse();
    docker.buildHandler = async () => undefined;
    controller.abort();
    expect(await pre).toMatchObject({ name: 'AbortError' });
    expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(2);
  });

  it('PR #77 review round 1 (A-R1-1): a prebuild whose build stalls ends at its time limit; an open and a worker preparation that waited for it build for themselves', async () => {
    const helper = stateHelper(async () => ({ key: 'build-box', socket: DOCKER_SOCKET }));
    blockingBuild();
    const pre = prebuild(helper, { timeoutMs: 200 }).start(REMOTE_TARGET);
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const user = new AbortController();
    const cancelled = helper.ensureImageUse({ signal: user.signal }).catch((e: unknown) => e);
    user.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    const open = helper.ensureImageUse({ signal: new AbortController().signal });
    const lock = helper.ensureImagePresent({ signal: new AbortController().signal });
    docker.buildHandler = async () => undefined;
    expect(await pre).toBe('failed');
    expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await lock).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds[0].signal?.aborted).toBe(true);
  });

  it('PR #77 review round 2 (B-R2-1): without timeoutMs (as extension.ts starts it) a stalled prebuild ends at HELPER_PREBUILD_TIMEOUT_MS, at most 30 minutes', async () => {
    expect(HELPER_PREBUILD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(HELPER_PREBUILD_TIMEOUT_MS).toBeLessThanOrEqual(30 * 60_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const gate = blockingBuild();
    try {
      const helper = stateHelper(async () => ({ key: 'build-box', socket: DOCKER_SOCKET }));
      let settled = false;
      const pre = prebuild(helper).start(REMOTE_TARGET);
      void pre.then(() => { settled = true; });
      // Not vi.waitFor: under fake timers it would advance the clock itself. Wait by the real clock (only setTimeout is
      // fake), not by a fixed number of turns: a loaded CI runner needed more than 500 (PR #78 CI, 2026-10-01).
      const deadline = Date.now() + 10_000;
      while (docker.builds.length === 0 && Date.now() < deadline) await new Promise((r) => setImmediate(r));
      expect(docker.builds).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(HELPER_PREBUILD_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await pre).toBe('failed');
      expect(docker.builds[0].signal?.aborted).toBe(true);
    } finally {
      gate.release();
      vi.useRealTimers();
    }
  });

  // Review round 16 of PR #64 (R16-2): a caller that joined the build of another caller that is cancelled builds for itself.
  it('R16-2: an open that joined the build of another open that is cancelled builds for itself', async () => {
    const helper = stateHelper();
    blockingBuild();
    const a = new AbortController();
    const openA = helper.ensureImageUse({ signal: a.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const openB = helper.ensureImageUse();
    docker.buildHandler = async () => undefined;
    a.abort();
    expect(await openA).toMatchObject({ name: 'AbortError' });
    expect(await openB).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(2);
  });

  it('R16-2: a helper run that joined the build of an open that is cancelled builds for itself', async () => {
    // Plan step 11I (U7, decision of 2026-10-08): changed expectation, the helper run is runImage and gets the image of
    // its own build (before: a step of WorkspaceHelper that got its image from it, and ran once with exit code 0).
    const helper = stateHelper();
    blockingBuild();
    const a = new AbortController();
    const openA = helper.ensureImageUse({ signal: a.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const run = helper.runImage({});
    docker.buildHandler = async () => undefined;
    a.abort();
    expect(await openA).toMatchObject({ name: 'AbortError' });
    expect(await run).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(2);
  });

  // Changed expectation (Plan step 6, PR D: the prebuild runs on every engine): this was "builds nothing when the Docker
  // context is a remote host" (prebuildImage returned undefined, HelperPrebuild answered `remote`).
  it('builds the missing tag also when the Docker context is a remote host (Plan step 6, PR D)', async () => {
    const helper = stateHelper(async () => ({ key: 'build-box', socket: DOCKER_SOCKET }));
    expect(await helper.prebuildImage({ signal: new AbortController().signal })).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await helper.engineKey()).toBe('build-box');
    expect(docker.builds).toHaveLength(1);
  });

  // Changed expectation (Plan step 6, PR D): this was "asks no Docker engine whether it runs when the Docker context is a
  // remote host" (review round 17 of PR #64, R17-2). The prebuild now runs as an operation on the remote target, so its
  // `docker info` goes to that host (with our own SSH check first, dockerEngineAnswers), and only when the state file of
  // that host does not know the tag (the test below: not due, nothing asked).
  it('prebuilds a remote target as an operation on it, with the state file of that engine (Plan step 6, PR D)', async () => {
    const helper = stateHelper(async () => ({ key: operationDockerTarget()?.host ?? '', socket: DOCKER_SOCKET }));
    const targetsOfBuild: Array<DockerTarget | undefined> = [];
    docker.buildHandler = async () => {
      targetsOfBuild.push(operationDockerTarget());
    };
    const running = vi.fn(async (_target: DockerTarget, _signal: AbortSignal) => true);
    expect(await prebuild(helper, { dockerRunning: running }).start(REMOTE_TARGET)).toBe('built');
    expect(running).toHaveBeenCalledTimes(1);
    expect(running.mock.calls[0][0]).toBe(REMOTE_TARGET);
    // The build ran within the operation on the remote target (its Docker calls get the context of that host).
    expect(targetsOfBuild).toEqual([REMOTE_TARGET]);
    // The record is in the state file of the remote engine, not in helper.json of the local Docker.
    const remoteState = JSON.parse(fs.readFileSync(helperStatePathFor(statePath(), 'build-box'), 'utf8')) as HelperState;
    expect(remoteState.images[TAG]?.builtAt).toBeDefined();
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it('keeps "is due" per engine: a record of one engine does not count for another (Plan step 6, PR D)', async () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(
      helperStatePathFor(statePath(), 'build-box'),
      JSON.stringify({ version: 1, images: { [TAG]: { builtAt: '2026-09-20T12:00:00.000Z' } } }),
    );
    const engine = async (): Promise<HelperEngine> => ({ key: operationDockerTarget()?.host ?? '', socket: DOCKER_SOCKET });
    // The remote host knows the tag: not due, and neither it nor its Docker is asked.
    const running = vi.fn(async () => true);
    expect(await prebuild(stateHelper(engine), { dockerRunning: running }).start(REMOTE_TARGET)).toBe('notDue');
    expect(running).not.toHaveBeenCalled();
    expect(docker.builds).toEqual([]);
    expect(docker.imageIdCalls).toBe(0);
    // helper.json of the local Docker does not know it: the local Docker is due and gets the build.
    expect(await prebuild(stateHelper(engine), { dockerRunning: running }).start(LOCAL_DOCKER_TARGET)).toBe('built');
    expect(running).toHaveBeenCalledWith(LOCAL_DOCKER_TARGET, expect.any(AbortSignal));
    expect(docker.builds).toHaveLength(1);
    // A new remote host has no record yet: it is due and its Docker is asked (the fake Docker of this test has the tag
    // already, so it is found there).
    const other: DockerTarget = { kind: 'remote', host: 'other-box', endpoint: 'ssh://other-box', context: 'devenv-other-box' };
    expect(await prebuild(stateHelper(engine), { dockerRunning: running }).start(other)).toBe('present');
    expect(running).toHaveBeenCalledWith(other, expect.any(AbortSignal));
    expect(fs.existsSync(helperStatePathFor(statePath(), 'other-box'))).toBe(true);
  });

  it('does nothing on a remote host whose Docker does not answer, and never on an unsupported endpoint (Plan step 6, PR D)', async () => {
    const engine = async (): Promise<HelperEngine> => ({ key: operationDockerTarget()?.host ?? '', socket: DOCKER_SOCKET });
    expect(await prebuild(stateHelper(engine), { dockerRunning: async () => false }).start(REMOTE_TARGET)).toBe('dockerNotRunning');
    expect(docker.builds).toEqual([]);
    expect(docker.imageIdCalls).toBe(0);
    expect(logger.lines.join('\n')).toContain('Docker is not running');
    const running = vi.fn(async () => true);
    const unsupported: DockerTarget = { kind: 'unsupported', host: 'tcp://10.0.0.5:2375', endpoint: 'tcp://10.0.0.5:2375' };
    expect(await prebuild(stateHelper(engine), { dockerRunning: running }).start(unsupported)).toBe('unsupported');
    expect(running).not.toHaveBeenCalled();
    expect(docker.builds).toEqual([]);
  });

  describe('dockerEngineAnswers (Plan step 6, PR D)', () => {
    function sshRunner(result: Partial<RunResult>) {
      return { run: vi.fn(async (_file: string, _args: readonly string[], _options?: RunOptions): Promise<RunResult> => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result })) };
    }

    it('asks the local Docker with docker info only, and never starts it', async () => {
      const runner = sshRunner({});
      const daemonStatus = vi.fn(async () => ({ running: false }));
      const deps = { daemonStatus, ssh: { runner, sshPath: '/usr/bin/ssh', env: {} }, logger };
      expect(await dockerEngineAnswers(LOCAL_DOCKER_TARGET, deps, new AbortController().signal)).toBe(false);
      expect(daemonStatus).toHaveBeenCalledTimes(1);
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('checks a remote host with ssh -o BatchMode=yes first, so no question is ever asked; then docker info with the remote time limit', async () => {
      const runner = sshRunner({});
      const daemonStatus = vi.fn(async (_signal: AbortSignal, _timeoutMs?: number) => ({ running: true }));
      const deps = { daemonStatus, ssh: { runner, sshPath: '/usr/bin/ssh', env: {} }, logger };
      expect(await dockerEngineAnswers(REMOTE_TARGET, deps, new AbortController().signal)).toBe(true);
      expect(runner.run).toHaveBeenCalledTimes(1);
      const [file, args, options] = runner.run.mock.calls[0];
      expect(file).toBe('/usr/bin/ssh');
      expect(args).toEqual(expect.arrayContaining(['-o', 'BatchMode=yes']));
      expect(options?.env?.SSH_ASKPASS_REQUIRE).toBe('never');
      expect(daemonStatus).toHaveBeenCalledWith(expect.any(AbortSignal), REMOTE_INFO_TIMEOUT_MS);
    });

    it('answers false without docker info when the SSH check of a remote host fails, and false for an unsupported endpoint', async () => {
      const runner = sshRunner({ exitCode: 255, stderr: 'build-box: Permission denied (publickey).' });
      const daemonStatus = vi.fn(async () => ({ running: true }));
      const deps = { daemonStatus, ssh: { runner, sshPath: '/usr/bin/ssh', env: {} }, logger };
      expect(await dockerEngineAnswers(REMOTE_TARGET, deps, new AbortController().signal)).toBe(false);
      expect(daemonStatus).not.toHaveBeenCalled();
      expect(logger.lines.join('\n')).toContain('cannot be reached over SSH');
      const unsupported: DockerTarget = { kind: 'unsupported', host: 'tcp://10.0.0.5:2375', endpoint: 'tcp://10.0.0.5:2375' };
      expect(await dockerEngineAnswers(unsupported, deps, new AbortController().signal)).toBe(false);
      expect(daemonStatus).not.toHaveBeenCalled();
      expect(runner.run).toHaveBeenCalledTimes(1);
    });

    it('PR #77 review round 1 (A-R1-2): answers false without docker info for a remote host that our ssh cannot check (no unattended question)', async () => {
      const runner = sshRunner({});
      const daemonStatus = vi.fn(async () => ({ running: true }));
      const deps = { daemonStatus, ssh: { runner, sshPath: '/usr/bin/ssh', env: {} }, logger };
      const odd: DockerTarget = { kind: 'remote', host: 'me@corp.example@build-box', endpoint: 'ssh://me@corp.example@build-box', context: 'odd' };
      expect(await dockerEngineAnswers(odd, deps, new AbortController().signal)).toBe(false);
      expect(runner.run).not.toHaveBeenCalled();
      expect(daemonStatus).not.toHaveBeenCalled();
    });
  });

  // Review round 5 of PR #64, R5-2: helper.json alone decides whether the prebuild is due; there is no extension version
  // to remember anymore (the expectation on the saved version is gone).
  // Review round 7 of PR #64 (R7-3): a caller whose signal is already aborted when it would start the shared ensure
  // starts nothing (no build, no Docker call) and leaves no unhandled rejection behind.
  it('a cancelled caller starts no shared ensure and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      docker.buildHandler = async (options) => {
        if (options.signal?.aborted) throw abortError();
      };
      const helper = stateHelper();
      await expect(helper.prebuildImage({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
      await expect(helper.ensureImageUse({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
      expect(docker.builds).toEqual([]);
      expect(docker.imageIdCalls).toBe(0);
      // Cancelled during the check of a cached image: the tag is gone, so the cache is reset, and nothing starts.
      await helper.ensureImageUse();
      expect(docker.builds).toHaveLength(1);
      docker.images.delete(TAG);
      const controller = new AbortController();
      const imageId = docker.imageId.bind(docker);
      docker.imageId = async (...args: Parameters<typeof docker.imageId>) => {
        controller.abort();
        return imageId(...args);
      };
      await expect(helper.ensureImageUse({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(docker.builds).toHaveLength(1);
      docker.imageId = imageId;
      await helper.ensureImageUse();
      expect(docker.builds).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('HelperPrebuild builds the tag that helper.json does not know, logs it, and the next open does not build', async () => {
    const helper = stateHelper();
    const task = prebuild(helper);
    expect(await task.start()).toBe('built');
    expect(logger.lines).toContain('info The workspace helper image is built in the background.');
    expect(logger.lines).toContain(`info The workspace helper image ${TAG} was built in the background.`);
    expect(await helper.ensureImageUse()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(1);
    // start() runs once.
    expect(await task.start()).toBe('built');
    expect(docker.builds).toHaveLength(1);
    // Review round 5 of PR #64, R5-2: a window that starts later finds the record of the build and does nothing.
    const running = vi.fn(async () => true);
    expect(await prebuild(stateHelper(), { dockerRunning: running }).start()).toBe('notDue');
    expect(running).not.toHaveBeenCalled();
  });

  it('HelperPrebuild runs when helper.json does not know the current tag, and finds an existing tag', async () => {
    docker.images.add(TAG);
    const helper = stateHelper();
    expect(await prebuild(helper).start()).toBe('present');
    expect(docker.builds).toEqual([]);
    expect(logger.lines).toContain(`info The workspace helper image ${TAG} is ready.`);
  });

  it('HelperPrebuild asks Docker nothing when it is not due', async () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ version: 1, images: { [TAG]: { builtAt: '2026-09-20T12:00:00.000Z' } } }));
    let asked = false;
    const helper = stateHelper(async () => {
      asked = true;
      return { key: '' };
    });
    const running = vi.fn(async () => true);
    // Review round 5 of PR #64, R5-2: a live record of the current tag is enough (no version).
    expect(await prebuild(helper, { dockerRunning: running }).start()).toBe('notDue');
    // Changed expectation (Plan step 6, PR D): the engine is read for the key of its state file (in the extension the
    // target of the operation, no Docker call); this was `false`. Docker itself is still not asked (below).
    expect(asked).toBe(true);
    expect(running).not.toHaveBeenCalled();
    expect(docker.imageIdCalls).toBe(0);
    // A tag that the cleanup removed is not known.
    fs.writeFileSync(statePath(), JSON.stringify({ version: 1, images: { [TAG]: { removedAt: '2026-09-20T12:00:00.000Z' } } }));
    expect(await prebuild(helper, { dockerRunning: running }).start()).toBe('built');
  });

  // Review round 5 of PR #64, R5-2: no version to remember (the expectation on the saved version is gone).
  // Changed expectation (review round 6 of PR #64, R6-1: no cross-window lock): the expectation that no lock file exists is gone.
  it('HelperPrebuild does not build when Docker is not running', async () => {
    const helper = stateHelper();
    expect(await prebuild(helper, { dockerRunning: async () => false }).start()).toBe('dockerNotRunning');
    expect(docker.builds).toEqual([]);
    expect(logger.lines.join('\n')).toContain('Docker is not running');
  });

  // Review round 5 of PR #64, R5-2: no version to remember (the expectation on the saved version is gone).
  // Changed expectation (review round 6 of PR #64, R6-1: no cross-window lock): the expectations on the lock file are gone.
  it('HelperPrebuild is cancelled by dispose, and a failed build is logged', async () => {
    const helper = stateHelper();
    blockingBuild();
    const task = prebuild(helper);
    const outcome = task.start();
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    task.dispose();
    expect(await outcome).toBe('cancelled');
    // The docker build got the signal of the prebuild.
    expect(docker.builds[0].signal?.aborted).toBe(true);

    docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'Temporary failure resolving deb.debian.org');
    };
    expect(await prebuild(helper).start()).toBe('failed');
    expect(logger.lines.join('\n')).toContain('The workspace helper image could not be prepared in the background');
  });

  // Changed expectation (review round 6 of PR #64, R6-1: no cross-window lock): this replaces the test "two windows over
  // the same helper.json: exactly one build, the other window is busy".
  it('HelperPrebuild disposed while it reads helper.json asks Docker nothing (review round 20 of PR #64, B-R20-5b)', async () => {
    const helper = {
      // Plan step 6, PR D: engineKey replaces usesLocalEngine (the prebuild reads the state file of the engine).
      engineKey: vi.fn(async () => ''),
      prebuildImage: vi.fn(async (options: { signal: AbortSignal }) => {
        if (options.signal.aborted) throw abortError();
        return { tag: TAG, id: fakeImageId(TAG) };
      }),
    };
    const running = vi.fn(async () => true);
    const task = prebuild(stateHelper(), { helper, dockerRunning: running });
    const outcome = task.start();
    task.dispose();
    expect(await outcome).toBe('cancelled');
    expect(helper.engineKey).not.toHaveBeenCalled();
    expect(running).not.toHaveBeenCalled();
    expect(helper.prebuildImage).not.toHaveBeenCalled();
  });

  it('HelperPrebuild disposed during the build is cancelled, also when the build then fails with another error (review round 20 of PR #64, B-R20-5c)', async () => {
    const helper = {
      // Plan step 6, PR D: engineKey replaces usesLocalEngine.
      engineKey: vi.fn(async () => ''),
      prebuildImage: vi.fn(
        (options: { signal: AbortSignal }) =>
          new Promise<HelperImageUse>((_resolve, reject) => {
            // The killed docker build ends with an ordinary failure, which the helper reports as helperFailed.
            options.signal.addEventListener('abort', () => reject(new UserFacingError('helperFailed', 'The workspace helper could not be prepared.', 'exit code 143')), { once: true });
          }),
      ),
    };
    const task = prebuild(stateHelper(), { helper });
    const outcome = task.start();
    await vi.waitFor(() => expect(helper.prebuildImage).toHaveBeenCalled());
    task.dispose();
    expect(await outcome).toBe('cancelled');
    expect(logger.lines.join('\n')).not.toContain('could not be prepared in the background');
  });

  it('HelperPrebuild is cancelled, without a warning, when a step fails with another error after dispose (review round 20 of PR #64, B-R20-5c)', async () => {
    let task: HelperPrebuild | undefined;
    const helper = {
      // Deactivation while the Docker context is read; the read then fails with an ordinary error. Plan step 6, PR D:
      // engineKey replaces usesLocalEngine (read for the state file of the engine).
      engineKey: async (): Promise<string> => {
        task?.dispose();
        throw new Error('the Docker context cannot be read');
      },
      prebuildImage: async () => ({ tag: TAG, id: fakeImageId(TAG) }),
    };
    task = prebuild(stateHelper(), { helper });
    expect(await task.start()).toBe('cancelled');
    expect(logger.lines.join('\n')).not.toContain('could not be prepared in the background');
  });

  describe('windows without a cross-window lock (review round 6 of PR #64, R6-1)', () => {
    it('two windows that start together may each build; a window that starts later is not due and asks Docker nothing', async () => {
      const releases: Array<() => void> = [];
      docker.buildHandler = () => new Promise<void>((resolve) => releases.push(resolve));
      const first = prebuild(stateHelper()).start();
      const second = prebuild(stateHelper()).start();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(2));
      for (const release of releases) release();
      expect(await Promise.all([first, second])).toEqual(['built', 'built']);
      expect(logger.lines.join('\n')).not.toContain('another window');
      const builds = docker.builds.length;
      const imageIdCalls = docker.imageIdCalls;
      let asked = false;
      const third = stateHelper(async () => {
        asked = true;
        return { key: '' };
      });
      const running = vi.fn(async () => true);
      expect(await prebuild(third, { dockerRunning: running }).start()).toBe('notDue');
      // Changed expectation (Plan step 6, PR D): the engine is read for the key of its state file (no Docker call); this
      // was `false`. Docker itself is still not asked (below).
      expect(asked).toBe(true);
      expect(running).not.toHaveBeenCalled();
      expect(docker.builds).toHaveLength(builds);
      expect(docker.imageIdCalls).toBe(imageIdCalls);
    });

    it('asks Docker nothing for a live record of the current tag', async () => {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), JSON.stringify({ version: 1, images: { [TAG]: { builtAt: '2026-09-20T12:00:00.000Z' } } }));
      const helper = { engineKey: vi.fn(async () => ''), prebuildImage: vi.fn(async () => ({ tag: TAG, id: fakeImageId(TAG) })) };
      const running = vi.fn(async () => true);
      expect(await prebuild(stateHelper(), { helper, dockerRunning: running }).start()).toBe('notDue');
      // Changed expectation (Plan step 6, PR D): the engine key is read now (it picks the state file of the engine; in
      // the extension it is the target of the operation, no Docker call); this was "usesLocalEngine not called".
      expect(helper.engineKey).toHaveBeenCalledTimes(1);
      expect(helper.prebuildImage).not.toHaveBeenCalled();
      expect(running).not.toHaveBeenCalled();
      expect(docker.imageIdCalls).toBe(0);
    });
  });

  // Review round 5 of PR #64, R5-3 (a): the prebuild does no maintenance.
  it('does no maintenance: no rebuild that a check asked for, no check of the base image, no cleanup', async () => {
    docker.images.add(TAG);
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    const old = '2026-09-01T12:00:00.000Z';
    const record = {
      baseImage: 'node:22-bookworm-slim',
      baseDigest: `sha256:${'a'.repeat(64)}`,
      latestBaseDigest: `sha256:${'b'.repeat(64)}`,
      builtAt: old,
      checkedAt: old,
      lastUsedAt: old,
    };
    fs.writeFileSync(statePath(), JSON.stringify({ version: 1, images: { [TAG]: record }, lastCleanupAt: old }));
    const helper = stateHelper();
    expect(await helper.prebuildImage({ signal: new AbortController().signal })).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toEqual([]);
    expect(docker.listCalls).toBe(0);
    expect(docker.removals).toEqual([]);
  });

  describe('a caller that joins the shared build can cancel its wait and gets the progress (review round 5 of PR #64, R5-1)', () => {
    it('an open that waits for the prebuild ends at once when its signal aborts; the prebuild goes on and its result is reused', async () => {
      const helper = stateHelper();
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const controller = new AbortController();
      let openError: unknown;
      // Its onBuild tells when it waits for the build (the build has started).
      let waits = false;
      const open = helper
        .ensureImageUse({ signal: controller.signal, onBuild: () => (waits = true) })
        .catch((error: unknown) => (openError = error));
      await vi.waitFor(() => expect(waits).toBe(true));
      controller.abort();
      await vi.waitFor(() => expect(openError).toMatchObject({ name: 'AbortError' }));
      await open;
      // The shared build did not get the abort.
      expect(docker.builds[0].signal?.aborted).toBe(false);
      gate.release();
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
      expect(await helper.ensureImageUse()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
    });

    // Review round 21 of PR #64 (B-R21-1): the abort of an open that waits for the build of a helper run (here the
    // prebuild) keeps that still-running build in the cache, so a helper run that starts before it ends joins it.
    it('an open that cancels its wait keeps the running prebuild in the cache; a later helper run joins it', async () => {
      // Plan step 11I (U7, decision of 2026-10-08): changed expectation, the helper run is runImage and gets the image
      // of the prebuild (before: a step of WorkspaceHelper that got its image from it, and ran once with exit code 0).
      const helper = stateHelper();
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const controller = new AbortController();
      let waits = false;
      const open = helper.ensureImageUse({ signal: controller.signal, onBuild: () => (waits = true) });
      await vi.waitFor(() => expect(waits).toBe(true));
      controller.abort();
      await expect(open).rejects.toMatchObject({ name: 'AbortError' });
      const run = helper.runImage({});
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The run waits for the build of the prebuild; it starts no build of its own (checked before the release, which a
      // second build would replace).
      expect(docker.builds).toHaveLength(1);
      gate.release();
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(await run).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
    });

    it('a helper run that waits for the prebuild ends at once when its signal aborts, without a docker run', async () => {
      // Plan step 11I (U7, decision of 2026-10-08): changed expectation, the helper run is runImage, which rejects with
      // the AbortError, so no run gets an image (before: a step of WorkspaceHelper, which started no `docker run`).
      const helper = stateHelper();
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const controller = new AbortController();
      let runError: unknown;
      const run = helper.runImage({ signal: controller.signal }).catch((error: unknown) => (runError = error));
      // The run waits for the build now (the engine is known at once).
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runError).toBeUndefined();
      controller.abort();
      await vi.waitFor(() => expect(runError).toMatchObject({ name: 'AbortError' }));
      await run;
      gate.release();
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
    });

    it('a caller whose signal was aborted before it joins ends at once', async () => {
      // Plan step 11I (U7, decision of 2026-10-08): changed setup, the helper run is runImage (before: a step of
      // WorkspaceHelper with the aborted signal).
      const helper = stateHelper();
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      await expect(helper.ensureImageUse({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
      await expect(helper.runImage({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
      gate.release();
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
    });

    // Review round 6 of PR #64, R6-5: renamed to what it covers (prebuildImage awaits usesLocalEngine first, so the open
    // creates the shared promise and the prebuild joins it); the test below covers the prebuild that owns the promise.
    // Plan step 6, PR D: prebuildImage no longer awaits usesLocalEngine (it goes to the shared ensure at once); the
    // expectations stay: one build, and every caller that joins before or after its start gets its progress.
    it('a prebuild that joins an open that has not started its build yet; a later open gets create', async () => {
      const helper = stateHelper();
      const gate = blockingBuild();
      const own: string[] = [];
      const pre = helper.prebuildImage({ signal: new AbortController().signal, onBuild: (kind) => own.push(kind) });
      // Joins before the build started (the Dockerfile is not read yet).
      const early: string[] = [];
      const first = helper.ensureImageUse({ onBuild: (kind) => early.push(kind) });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      // Joins after the build started.
      const late: string[] = [];
      const second = helper.ensureImageUse({ onBuild: (kind) => late.push(kind) });
      await vi.waitFor(() => expect(late).toEqual(['create']));
      gate.release();
      await pre;
      await first;
      await second;
      expect(own).toEqual(['create']);
      expect(early).toEqual(['create']);
      expect(late).toEqual(['create']);
      expect(docker.builds).toHaveLength(1);
      // A caller that reuses the result later gets no progress.
      const after: string[] = [];
      await helper.ensureImageUse({ onBuild: (kind) => after.push(kind) });
      expect(after).toEqual([]);
    });

    // Review round 6 of PR #64, R6-5: the prebuild owns the shared promise (it waits for the digest of the base image);
    // an open that joins it before the build started gets create when the build starts, and does not start its own.
    it('an open that joins the promise of the prebuild before its build started gets create when it starts', async () => {
      let asked = false;
      let releaseDigest: (digest: string) => void = () => undefined;
      const helper = new HelperImages({
        docker,
        logger,
        dockerfilePath: path.join(dir, 'Dockerfile'),
        env: {},
        platform: 'darwin',
        clock: { now: () => Date.parse('2026-09-24T12:00:00Z') },
        statePath: statePath(),
        baseDigest: () => {
          asked = true;
          return new Promise<string>((resolve) => (releaseDigest = resolve));
        },
      });
      const gate = blockingBuild();
      const controller = new AbortController();
      const pre = helper.prebuildImage({ signal: controller.signal });
      await vi.waitFor(() => expect(asked).toBe(true));
      const early: string[] = [];
      const open = helper.ensureImageUse({ onBuild: (kind) => early.push(kind) });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(early).toEqual([]);
      releaseDigest('sha256:' + 'a'.repeat(64));
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      // The build is the one of the prebuild.
      expect(docker.builds[0].signal).toBe(controller.signal);
      await vi.waitFor(() => expect(early).toEqual(['create']));
      gate.release();
      await pre;
      await open;
      expect(docker.builds).toHaveLength(1);
    });

    it('a prebuild that joins the build of an open gets its progress', async () => {
      const helper = createImages();
      const gate = blockingBuild();
      const open = helper.ensureImageUse();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const kinds: string[] = [];
      const pre = helper.prebuildImage({ signal: new AbortController().signal, onBuild: (kind) => kinds.push(kind) });
      await vi.waitFor(() => expect(kinds).toEqual(['create']));
      gate.release();
      await open;
      await pre;
      expect(docker.builds).toHaveLength(1);
    });

    // Review round 20 of PR #64 (B-R20-5e): the cleanup of a caller that joined the shared build.
    it('a caller that cancelled its wait before the build started gets no progress of that build', async () => {
      let releaseDigest: (digest: string) => void = () => undefined;
      let asked = false;
      const helper = new HelperImages({
        docker,
        logger,
        dockerfilePath: path.join(dir, 'Dockerfile'),
        env: {},
        platform: 'darwin',
        clock: { now: () => Date.parse('2026-09-24T12:00:00Z') },
        statePath: statePath(),
        baseDigest: () => {
          asked = true;
          return new Promise<string>((resolve) => (releaseDigest = resolve));
        },
      });
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(asked).toBe(true));
      const controller = new AbortController();
      const kinds: string[] = [];
      const open = helper.ensureImageUse({ signal: controller.signal, onBuild: (kind) => kinds.push(kind) }).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      expect(await open).toMatchObject({ name: 'AbortError' });
      releaseDigest('sha256:' + 'a'.repeat(64));
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      gate.release();
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(kinds).toEqual([]);
    });

    it('a helper run that joined the prebuild leaves no abort listener on its signal', async () => {
      // Plan step 11I (U7, decision of 2026-10-08): changed expectation, the helper run is runImage and gets the image
      // of the prebuild (before: a step of WorkspaceHelper that got its image from it, and ran with exit code 0).
      const helper = stateHelper();
      const gate = blockingBuild();
      const pre = helper.prebuildImage({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const controller = new AbortController();
      const run = helper.runImage({ signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 20));
      gate.release();
      await pre;
      expect(await run).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    });

    it('a caller that joins a promise that only finds the existing tag gets no onBuild', async () => {
      docker.images.add(TAG);
      const helper = stateHelper();
      const kinds: string[] = [];
      const pre = helper.prebuildImage({ signal: new AbortController().signal, onBuild: (kind) => kinds.push(kind) });
      const open = helper.ensureImageUse({ onBuild: (kind) => kinds.push(kind) });
      expect(await pre).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(kinds).toEqual([]);
      expect(docker.builds).toEqual([]);
    });
  });
});

describe('HelperImages: the helper runs in a new window (implementation notes 7)', () => {
  const START = Date.parse('2026-09-24T12:00:00Z');
  const DIGEST_A = `sha256:${'a'.repeat(64)}`;
  const DIGEST_B = `sha256:${'b'.repeat(64)}`;

  function newWindow() {
    let now = START;
    const lookups: string[] = [];
    const checks: Array<Promise<void>> = [];
    const statePath = path.join(dir, 'storage', 'helper.json');
    const helper = new HelperImages({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'darwin',
      clock: { now: () => now },
      statePath,
      baseDigest: async (reference) => {
        lookups.push(reference);
        return DIGEST_B;
      },
      onBaseImageCheck: (check) => checks.push(check),
    });
    const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();
    return {
      helper,
      lookups,
      iso,
      advance: (ms: number) => {
        now += ms;
      },
      state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState,
      settled: () => Promise.all(checks.splice(0)),
      /** The helper exists, its weekly check and the cleanup are 8 days overdue, and its base image changed. */
      overdue: () => {
        docker.images.add(TAG);
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        const old = iso(-8 * 24 * 60 * 60 * 1000);
        const record = { baseImage: 'node:22-bookworm-slim', baseDigest: DIGEST_A, builtAt: old, checkedAt: old, lastUsedAt: old };
        fs.writeFileSync(statePath, JSON.stringify({ version: 1, images: { [TAG]: record }, lastCleanupAt: old }));
      },
    };
  }

  // 2026-10-01: the Switch branch command was dropped (user decision).
  it('never checks, rebuilds, or cleans up in the first helper run (a stop, a delete)', async () => {
    // Plan step 11I (U7, decision of 2026-10-08): changed expectation, the helper run is runImage and gets the existing
    // image (before: a step of WorkspaceHelper that got its image from it, and ran once with exit code 0).
    const w = newWindow();
    w.overdue();
    expect(await w.helper.runImage({})).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    await w.settled();
    expect(w.lookups).toEqual([]);
    expect(docker.builds).toEqual([]);
    expect(docker.listCalls).toBe(0);
    expect(docker.removals).toEqual([]);
    expect(w.state().images[TAG].lastUsedAt).toBe(w.iso());
    expect(w.state().images[TAG].checkedAt).toBe(w.iso(-8 * 24 * 60 * 60 * 1000));

    // The open pipeline (ensureImage) in the same window does the maintenance: the check (in the background) and the
    // cleanup. The rebuild that the check asks for comes with the next ensureImage.
    await w.helper.ensureImage();
    await w.settled();
    expect(w.lookups).toHaveLength(1);
    expect(docker.listCalls).toBe(1);
    expect(w.state().images[TAG].latestBaseDigest).toBe(DIGEST_B);
    w.advance(HELPER_IMAGE_RECHECK_MS);
    await w.helper.ensureImage();
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ pull: true, noCache: true });
  });

  it('builds a missing tag once in the first helper run, and the open pipeline then maintains without a second build', async () => {
    // Plan step 11I (U7, decision of 2026-10-08): changed expectation, the helper run is runImage and gets the built
    // image (before: a step of WorkspaceHelper that got its image from it, and ran with exit code 0).
    const w = newWindow();
    let release: () => void = () => undefined;
    docker.buildHandler = () => new Promise<void>((resolve) => (release = resolve));
    const run = w.helper.runImage({});
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const ensured = w.helper.ensureImage();
    release();
    expect(await run).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(await ensured).toBe(TAG);
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ pull: true });
    // ensureImage ran ensureHelperImage again, with the maintenance: the cleanup is due in a new state file.
    expect(docker.listCalls).toBe(1);
  });
});

describe('Docker access of the helper runs', () => {
  it('does not reuse the helper image of another engine (the Docker context changed)', async () => {
    let engine: HelperEngine = { key: '' };
    const statePath = path.join(dir, 'helper.json');
    const helper = new HelperImages({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'linux',
      statePath,
      engine: async () => engine,
    });
    await helper.ensureImage();
    expect(docker.builds).toHaveLength(1);
    // The remote engine does not have the image: it is built there, with its own state file.
    docker.images.clear();
    engine = { key: 'box', socket: '/var/run/docker.sock' };
    await helper.ensureImage();
    expect(docker.builds).toHaveLength(2);
    expect(fs.existsSync(helperStatePathFor(statePath, 'box'))).toBe(true);
    // The same engine again: reused.
    await helper.ensureImage();
    expect(docker.builds).toHaveLength(2);
  });
});

// PR #74 review round 1, A-R1-1: the helper image before the environment lock (Stop, Delete) only makes sure that the
// tag exists on the engine of the operation (local or remote alike); it does no maintenance.
describe('HelperImages.ensureImagePresent (PR #74 review round 1, A-R1-1)', () => {
  const statePath = () => path.join(dir, 'storage', 'helper.json');
  const REMOTE: HelperEngine = { key: 'ssh://build-box', socket: '/var/run/docker.sock' };

  function helperOn(engine: HelperEngine, baseDigest?: BaseDigestLookup): HelperImages {
    return new HelperImages({
      docker,
      logger,
      dockerfilePath: path.join(dir, 'Dockerfile'),
      env: {},
      platform: 'linux',
      clock: { now: () => Date.parse('2026-09-24T12:00:00Z') },
      statePath: statePath(),
      engine: async () => engine,
      baseDigest,
    });
  }

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])('on %s, a recorded new base digest rebuilds nothing, checks nothing, and cleans up nothing', async (_name, engine) => {
    docker.images.add(TAG);
    const file = helperStatePathFor(statePath(), engine.key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = '2026-09-01T12:00:00.000Z';
    const record = {
      baseImage: 'node:22-bookworm-slim',
      baseDigest: `sha256:${'a'.repeat(64)}`,
      latestBaseDigest: `sha256:${'b'.repeat(64)}`,
      builtAt: old,
      checkedAt: old,
      lastUsedAt: old,
      imageId: fakeImageId(TAG),
      generation: HELPER_GENERATION,
    };
    fs.writeFileSync(file, JSON.stringify({ version: 1, images: { [TAG]: record }, lastCleanupAt: old }));
    // A `--pull --no-cache` rebuild would never end here, so a Stop that waited for it would hang.
    docker.buildHandler = () => new Promise<void>(() => {});
    const lookup = vi.fn<BaseDigestLookup>(async () => `sha256:${'c'.repeat(64)}`);
    const helper = helperOn(engine, lookup);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
    expect(docker.listCalls).toBe(0);
    expect(docker.removals).toEqual([]);
  });

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])('on %s, builds a missing tag', async (_name, engine) => {
    const helper = helperOn(engine);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({ tag: TAG });
  });

  // Plan step 5, PR D (rule D1 of 2026-09-30): the helper image makes the state for the worker consistent. Plan step
  // 11I1, PR B2: changed expectation (before: each check and build also ran in the scope of the worker preparation,
  // workerPreparation.ts, which kept them from the routing through the worker; both are gone): the checks and builds
  // themselves are still counted.
  it('checks and builds the helper image, also for an open', async () => {
    const calls: string[] = [];
    const imageId = docker.imageId.bind(docker);
    docker.imageId = async (reference: string) => {
      calls.push('check');
      return imageId(reference);
    };
    docker.buildHandler = async () => {
      calls.push('build');
    };
    const helper = helperOn(REMOTE);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(1);
    // PR #76 review round 1 (B-R1-1): with a warm cache, the cached image is checked again.
    const warm = calls.length;
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(calls.length).toBeGreaterThan(warm);
    docker.images.delete(TAG);
    await helper.ensureImageUse();
    expect(docker.builds).toHaveLength(2);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.filter((call) => call === 'build')).toHaveLength(2);
  });

  // PR #76 review round 1 (A-R1-1, A-R1-2): the refresh of the sidebar only checks the helper tag: it never builds it and
  // never waits for a pending build. Plan step 11I1, PR B2: changed expectation (before: its check also ran in the scope
  // of the worker preparation, which is gone with the routing through the worker): the checks are still counted.
  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])('on %s, checkImagePresent checks the tag, never builds it, and never waits for a pending build', async (_name, engine) => {
    const helper = helperOn(engine);
    let checks = 0;
    const imageId = docker.imageId.bind(docker);
    docker.imageId = async (reference: string) => {
      checks++;
      return imageId(reference);
    };
    await expect(helper.checkImagePresent()).rejects.toMatchObject({ code: 'helperFailed' });
    expect(docker.builds).toHaveLength(0);
    const finish = heldBuild();
    const open = helper.ensureImageUse();
    await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
    const settled = helper.checkImagePresent().then(() => 'resolved', (error: unknown) => (isUserFacingError(error) ? error.code : 'other'));
    expect(await orHung(settled, 200)).toBe('helperFailed');
    finish();
    await open;
    await expect(helper.checkImagePresent()).resolves.toBeUndefined();
    expect(docker.builds).toHaveLength(1);
    expect(checks).toBeGreaterThanOrEqual(3);
  });

  it('builds the tag again when it was deleted after it was cached (by itself or by an open)', async () => {
    const helper = helperOn(REMOTE);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    docker.images.delete(TAG);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(2);
    expect(docker.images.has(TAG)).toBe(true);

    await helper.ensureImageUse();
    docker.images.delete(TAG);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(docker.builds).toHaveLength(3);
    expect(logger.lines.join('\n')).toContain(`The workspace helper image ${TAG} was removed. It is prepared again.`);
  });

  it('fails like ensureImage when the missing tag cannot be built', async () => {
    docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'failed to solve: node:22-bookworm-slim: not found');
    };
    const helper = helperOn(REMOTE);
    await expect(helper.ensureImagePresent()).rejects.toMatchObject({ code: 'helperFailed' });
    expect(docker.images.has(TAG)).toBe(false);
  });

  // Review round 4 of PR #85 (A-R4-1): the heartbeats back off only a build that started and failed (onBuild), never an
  // engine that does not answer; within the wait they check the tag only (presentImage), which never builds.
  it('reports a build that it starts (onBuild), not a failure before it; presentImage never builds', async () => {
    const helper = helperOn(REMOTE);
    const imageId = docker.imageId.bind(docker);
    docker.imageId = async () => {
      throw new CommandError('docker image inspect', 255, '', 'ssh: connect to host build-box port 22: Connection refused');
    };
    const unreachable = vi.fn();
    await expect(helper.ensureImagePresent({ onBuild: unreachable })).rejects.toBeDefined();
    expect(unreachable).not.toHaveBeenCalled();
    expect(await helper.presentImage()).toBeUndefined();
    docker.imageId = imageId;
    expect(await helper.presentImage()).toBeUndefined();
    expect(docker.builds).toEqual([]);
    docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'no space left on device');
    };
    const failing = vi.fn();
    await expect(helper.ensureImagePresent({ onBuild: failing })).rejects.toMatchObject({ code: 'helperFailed' });
    expect(failing).toHaveBeenCalledWith('create');
    docker.buildHandler = async () => undefined;
    const built = vi.fn();
    expect(await helper.ensureImagePresent({ onBuild: built })).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(built).toHaveBeenCalledTimes(1);
    expect(await helper.presentImage()).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    const builds = docker.builds.length;
    const present = vi.fn();
    expect(await helper.ensureImagePresent({ onBuild: present })).toEqual({ tag: TAG, id: fakeImageId(TAG) });
    expect(present).not.toHaveBeenCalled();
    expect(docker.builds).toHaveLength(builds);
  });

  // Review round 5 of PR #85 (B-R5-4, B-R5-5): presentImage checks the tag, and an aborted signal ends it with an
  // AbortError. Plan step 11I1, PR B2: changed expectation (before: the check also ran in the scope of the worker
  // preparation, which is gone with the routing through the worker): the check is still counted.
  it('presentImage checks the tag, and passes the abort of its signal through', async () => {
    const helper = helperOn(REMOTE);
    let checks = 0;
    const imageId = docker.imageId.bind(docker);
    docker.imageId = async (reference: string) => {
      checks++;
      return imageId(reference);
    };
    expect(await helper.presentImage()).toBeUndefined();
    expect(checks).toBeGreaterThanOrEqual(1);
    const aborted = new AbortController();
    aborted.abort();
    await expect(helper.presentImage({ signal: aborted.signal })).rejects.toSatisfy(isAbortError);
    expect(docker.builds).toEqual([]);
  });

  // PR #74 review round 2, A-R2-1: a pending maintaining ensure of an open in the same window (a `--pull --no-cache`
  // rebuild, the cleanup) is not joined when the tag exists: the Stop could not cancel that wait.
  const NEW_ID = `sha256:${'e'.repeat(64)}`;

  /** A helper.json on `engine` that asks the next maintaining ensure for a `--pull --no-cache` rebuild of TAG. */
  function recordNewBaseDigest(engine: HelperEngine): void {
    const file = helperStatePathFor(statePath(), engine.key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = '2026-09-01T12:00:00.000Z';
    const record = {
      baseImage: 'node:22-bookworm-slim',
      baseDigest: `sha256:${'a'.repeat(64)}`,
      latestBaseDigest: `sha256:${'b'.repeat(64)}`,
      builtAt: old,
      checkedAt: old,
      lastUsedAt: old,
      imageId: fakeImageId(TAG),
      generation: HELPER_GENERATION,
    };
    fs.writeFileSync(file, JSON.stringify({ version: 1, images: { [TAG]: record }, lastCleanupAt: old }));
  }

  /**
   * A build that ends only when the returned function is called (with an error, or with success). After a failure, each
   * later build (the retry without `--pull`) fails at once with the same error.
   */
  function heldBuild(): (error?: Error) => void {
    let finish: ((error?: Error) => void) | undefined;
    let failure: Error | undefined;
    docker.buildHandler = () =>
      failure !== undefined
        ? Promise.reject(failure)
        : new Promise<void>((resolve, reject) => {
            finish = (error) => (error ? reject(error) : resolve());
          });
    return (error) => {
      failure = error;
      finish?.(error);
    };
  }

  /** `promise`, or 'HUNG' when it has not settled after `ms`. */
  function orHung<T>(promise: Promise<T>, ms = 1000): Promise<T | 'HUNG'> {
    return Promise.race([promise, new Promise<'HUNG'>((resolve) => setTimeout(() => resolve('HUNG'), ms))]);
  }

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])(
    'on %s, uses the existing tag at once while a maintaining rebuild of an open hangs, and leaves that rebuild untouched (PR #74 review round 2, A-R2-1)',
    async (_name, engine) => {
      docker.images.add(TAG);
      recordNewBaseDigest(engine);
      const finish = heldBuild();
      const helper = helperOn(engine);
      const open = helper.ensureImageUse();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      expect(docker.builds[0]).toMatchObject({ tag: TAG, pull: true, noCache: true });

      // PR #74 review round 2, A-R2-1: resolves at once with the ID of the tag, without waiting for the rebuild.
      expect(await orHung(helper.ensureImagePresent())).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      // PR #74 review round 2, A-R2-1: the rebuild promise of the open is untouched: a second open joins it.
      const second = helper.ensureImageUse();
      docker.ids.set(TAG, NEW_ID);
      finish();
      expect(await open).toEqual({ tag: TAG, id: NEW_ID });
      expect(await second).toEqual({ tag: TAG, id: NEW_ID });
      expect(docker.builds).toHaveLength(1);
      // PR #74 review round 2, A-R2-1: afterwards, the cached result of the open is used.
      expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: NEW_ID });
      expect(docker.builds).toHaveLength(1);
    },
  );

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])(
    'on %s, joins a pending maintaining ensure when the tag is missing, and resolves when it does (PR #74 review round 2, A-R2-1)',
    async (_name, engine) => {
      const finish = heldBuild();
      const helper = helperOn(engine);
      const asked: string[] = [];
      const imageId = docker.imageId.bind(docker);
      docker.imageId = async (reference) => {
        asked.push(reference);
        return imageId(reference);
      };
      const open = helper.ensureImageUse();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const before = asked.length;
      const present = helper.ensureImagePresent();
      // PR #74 review round 2, A-R2-1: the tag is checked first; it is missing, so the pending ensure is joined.
      await vi.waitFor(() => expect(asked.slice(before)).toEqual([TAG]));
      expect(await orHung(present, 200)).toBe('HUNG');
      finish();
      expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(await present).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
    },
  );

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])(
    'on %s, a cancelled Delete stops waiting for the joined maintaining ensure at once, and the build goes on (PR #74 review round 3, B-R3-1)',
    async (_name, engine) => {
      const finish = heldBuild();
      const helper = helperOn(engine);
      const asked: string[] = [];
      const imageId = docker.imageId.bind(docker);
      docker.imageId = async (reference) => {
        asked.push(reference);
        return imageId(reference);
      };
      const open = helper.ensureImageUse();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      const before = asked.length;
      const controller = new AbortController();
      const present = helper.ensureImagePresent({ signal: controller.signal });
      // PR #74 review round 3, B-R3-1: the tag is missing, so the pending ensure is joined; the abort ends that wait.
      await vi.waitFor(() => expect(asked.slice(before)).toEqual([TAG]));
      const settled = present.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.name : 'other'),
      );
      controller.abort();
      expect(await orHung(settled, 200)).toBe('AbortError');
      finish();
      expect(await open).toEqual({ tag: TAG, id: fakeImageId(TAG) });
      expect(docker.builds).toHaveLength(1);
    },
  );

  it.each([
    ['the local Docker', { key: '' }],
    ['a remote engine', REMOTE],
  ])(
    'on %s, joins the pending maintaining ensure when the tag cannot be checked, and fails (D1) when that ensure fails, without a fallback (PR #74 review round 2, A-R2-1)',
    async (_name, engine) => {
      const finish = heldBuild();
      const helper = helperOn(engine);
      const open = helper.ensureImageUse();
      await vi.waitFor(() => expect(docker.builds).toHaveLength(1));
      // PR #74 review round 2, A-R2-1: a failing imageId is no answer: the pending ensure is joined, not bypassed.
      docker.imageId = async () => {
        throw new CommandError('docker image inspect', 1, '', 'Cannot connect to the Docker daemon');
      };
      const present = helper.ensureImagePresent();
      await vi.waitFor(() => expect(logger.lines.join('\n')).toContain(`The workspace helper image ${TAG} could not be checked`));
      expect(await orHung(present, 200)).toBe('HUNG');
      finish(new CommandError('docker build', 1, '', 'failed to solve: node:22-bookworm-slim: not found'));
      await expect(open).rejects.toMatchObject({ code: 'helperFailed' });
      const builds = docker.builds.length;
      // PR #74 review round 2, A-R2-1: the D1 refusal: the failure of the joined ensure, no other image, no build of its own.
      await expect(present).rejects.toMatchObject({ code: 'helperFailed' });
      expect(docker.builds).toHaveLength(builds);
      expect(docker.images.has(TAG)).toBe(false);
    },
  );
});
