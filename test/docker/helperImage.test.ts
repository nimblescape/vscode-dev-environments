// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Refresh and cleanup of the workspace helper image (implementation notes 7) against the real Docker engine and the real
// registry, with a tiny helper Dockerfile of this run (so its own tag). The Docker adapter of the helper is limited to
// the images of the run, so the cleanup under test never sees or removes a helper image of the user. Plan step 11I (U7,
// decision of 2026-10-08): the helper image of a window is HelperImages' (the extension's), so the tests use it itself
// (before: through a WorkspaceHelper, which delegated to it and no longer has the helper image of the extension).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Plan step 11I2: the Docker CLI of the extension (BootstrapDocker) in place of the removed CLI adapter ContainerAdapter.
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import type { ImageInfo } from '../../src/core/docker/dockerObjects';
import {
  HELPER_CHECK_INTERVAL_MS,
  HELPER_CLEANUP_INTERVAL_MS,
  HELPER_UNUSED_LIMIT_MS,
  helperImageTag,
  registryBaseDigest,
  type BaseDigestLookup,
} from '../../src/core/helper/helperImage';
import { readHelperState, updateHelperState } from '../../src/core/helper/helperState';
import { HelperImages, type HelperImageDocker } from '../../src/core/helper/helperImages';
import { ImageChecker } from '../../src/core/imageCheck/imageCheck';
import { LABEL_HELPER } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { Timings, dockerTestContext, registryClient, registryDigest, registryTransport } from './harness';

const DAY_MS = 24 * 60 * 60 * 1000;
const FAKE_DIGEST = `sha256:${'0'.repeat(64)}`;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** A helper tag of another extension version: `devenv-helper:<12 hex characters>`, random, so no image has it yet. */
function otherHelperTag(): string {
  return `devenv-helper:${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * The real BootstrapDocker (plan step 11I2: was ContainerAdapter), limited to the images of this run: the listing of the
 * helper images shows only images with the label devenv-test.run=<run ID>, and the removal of any other image fails (the
 * helper logs the failure; the test checks that none was tried). It records the builds and the removals. Plan step 11I
 * (U7, decision of 2026-10-08): the Docker port of HelperImages (before: of WorkspaceHelper, with its `run`).
 */
class RunScopedDocker implements HelperImageDocker {
  readonly builds: Array<{ tag: string; pull: boolean; noCache: boolean }> = [];
  readonly removals: string[] = [];
  readonly refused: string[] = [];

  constructor(
    private readonly docker: BootstrapDocker,
    private readonly runLabel: string,
  ) {}

  imageExists(reference: string): Promise<boolean> {
    return this.docker.imageExists(reference);
  }

  imageId(reference: string): Promise<string | undefined> {
    return this.docker.imageId(reference);
  }

  async buildImage(options: Parameters<BootstrapDocker['buildImage']>[0]): Promise<string | undefined> {
    this.builds.push({ tag: options.tag, pull: options.pull === true, noCache: options.noCache === true });
    // Review round 3 of PR #64 (P4): the ID of the built image (found by its build label, review round 4 of PR #64, R4-2/R4-3).
    return this.docker.buildImage(options);
  }

  async listImagesByLabel(label: string): Promise<ImageInfo[]> {
    const own = new Set((await this.ownImages()).map((image) => image.id));
    return (await this.docker.listImagesByLabel(label)).filter((image) => own.has(image.id));
  }

  async removeImage(reference: string): Promise<boolean> {
    const own = await this.ownImages();
    if (!own.some((image) => image.id === reference || image.tags.includes(reference))) {
      this.refused.push(reference);
      throw new Error(`${reference} is not an image of this test run.`);
    }
    this.removals.push(reference);
    return this.docker.removeImage(reference);
  }

  private ownImages(): Promise<ImageInfo[]> {
    return this.docker.listImagesByLabel(this.runLabel);
  }
}

describe('workspace helper image: weekly refresh and daily cleanup', () => {
  const { run, env, cli, log } = dockerTestContext('helperImage');
  const runner = new NodeProcessRunner();
  const docker = new RunScopedDocker(new BootstrapDocker(runner, run.dockerPath, env, log), `${TEST_RUN_LABEL}=${run.runId}`);
  const client = registryClient(registryTransport, runner, env, log);
  const digestChecker = new ImageChecker(client, log);
  const lookUp = registryBaseDigest(client);
  const lookups: string[] = [];
  const baseDigest: BaseDigestLookup = (reference, signal) => {
    lookups.push(reference);
    return lookUp(reference, signal);
  };
  const dockerfilePath = path.join(run.runDir, 'tiny-helper', 'Dockerfile');
  // The label makes the tag unique to the run; RUN gives each build without cache a new image.
  const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, 'RUN date > /built-at', `LABEL ${TEST_RUN_LABEL}=${run.runId}`, ''].join('\n');
  const tag = helperImageTag(dockerfile);
  const statePath = path.join(run.runDir, 'helper-state', 'helper.json');
  const timings = new Timings();
  let userHelperImages: string[] = [];
  /** Checks of the base image that the helpers started in the background. */
  const checks: Array<Promise<void>> = [];

  /** The helper image of a new window: nothing cached. Plan step 11I (U7): HelperImages (before: a WorkspaceHelper). */
  function newWindowHelper(): HelperImages {
    return new HelperImages({ docker, logger: log, dockerfilePath, env, statePath, baseDigest, onBaseImageCheck: (check) => checks.push(check) });
  }

  /** Waits for the checks of the base image in the background. */
  async function settled(): Promise<void> {
    await Promise.all(checks.splice(0));
  }

  /** IDs of the helper images that are not images of this run. */
  function otherHelperImages(): string[] {
    const own = new Set(cli.lines(['image', 'ls', '-a', '-q', '--no-trunc', '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`]));
    const helpers = cli.lines(['image', 'ls', '-a', '-q', '--no-trunc', '--filter', `label=${LABEL_HELPER}=true`]);
    return [...new Set(helpers.filter((id) => !own.has(id)))].sort();
  }

  /** A helper image of this run without layers, tagged `tag` (dangling without). Returns its ID. */
  function dummyHelperImage(name: string, dummyTag?: string): string {
    const args = ['build', '-q', '--label', `${LABEL_HELPER}=true`, '--label', `${TEST_RUN_LABEL}=${run.runId}`];
    if (dummyTag) args.push('-t', dummyTag);
    return cli.ok([...args, '-'], `FROM scratch\nLABEL devenv-test.dummy=${name}\n`);
  }

  beforeAll(() => {
    fs.mkdirSync(path.dirname(dockerfilePath), { recursive: true });
    fs.writeFileSync(dockerfilePath, dockerfile);
    userHelperImages = otherHelperImages();
  });

  afterAll(() => {
    timings.print(`Timings of the helper image scenarios (${tag}):`);
    removeRunObjects(cli, run.runId);
    expect(cli.image(tag)).toBeUndefined();
    expect(otherHelperImages()).toEqual(userHelperImages);
  });

  it('a missing tag is built with --pull, and the digest of its base image is recorded', async () => {
    const started = Date.now();
    expect(await timings.measure('first build (--pull)', () => newWindowHelper().ensureImage())).toBe(tag);

    expect(docker.builds).toEqual([{ tag, pull: true, noCache: false }]);
    expect(lookups).toEqual([TEST_BASE_IMAGE]);
    expect(cli.image(tag)?.Config.Labels).toMatchObject({ [LABEL_HELPER]: 'true', [TEST_RUN_LABEL]: run.runId });
    const state = await readHelperState(statePath);
    expect(state.images[tag]).toMatchObject({
      baseImage: TEST_BASE_IMAGE,
      baseDigest: await registryDigest(digestChecker, TEST_BASE_IMAGE),
    });
    for (const time of [state.images[tag]?.builtAt, state.images[tag]?.checkedAt, state.images[tag]?.lastUsedAt, state.lastCleanupAt]) {
      expect(Date.parse(time ?? '')).toBeGreaterThanOrEqual(started - 1000);
    }
    expect(docker.removals).toEqual([]);
  });

  it('another window uses the image without a check and without a build', async () => {
    const imageId = cli.image(tag)?.Id;
    const state = await readHelperState(statePath);
    await timings.measure('ensure in a new window (nothing due)', () => newWindowHelper().ensureImage());

    expect(docker.builds).toHaveLength(1);
    expect(lookups).toHaveLength(1);
    expect(cli.image(tag)?.Id).toBe(imageId);
    expect(await readHelperState(statePath)).toEqual(state);
  });

  it('a changed digest of the base image rebuilds the same tag with --pull --no-cache at the next open, and removes the previous image', async () => {
    const previousId = cli.image(tag)?.Id;
    expect(previousId).toBeDefined();
    await updateHelperState(statePath, (state) => {
      state.images[tag] = { ...state.images[tag], baseDigest: FAKE_DIGEST, checkedAt: ago(HELPER_CHECK_INTERVAL_MS + DAY_MS) };
    });
    // The weekly check runs in the background: the open does not wait for it, and it asks the next open for a rebuild.
    await timings.measure('weekly check, base image changed (in the background)', async () => {
      await newWindowHelper().ensureImage();
      await settled();
    });
    expect(docker.builds).toHaveLength(1);
    expect(lookups).toHaveLength(2);
    expect((await readHelperState(statePath)).images[tag]?.latestBaseDigest).toBe(await registryDigest(digestChecker, TEST_BASE_IMAGE));

    const started = Date.now();
    await timings.measure('next open: rebuild (--pull --no-cache)', () => newWindowHelper().ensureImage());
    await settled();

    expect(docker.builds).toEqual([
      { tag, pull: true, noCache: false },
      { tag, pull: true, noCache: true },
    ]);
    expect(lookups).toHaveLength(2);
    const currentId = cli.image(tag)?.Id;
    expect(currentId).toBeDefined();
    expect(currentId).not.toBe(previousId);
    // With the classic image store, the previous image is dangling now and the helper removes it; the containerd image
    // store removes it itself when the tag moves.
    expect(cli.image(previousId!)).toBeUndefined();
    const record = (await readHelperState(statePath)).images[tag];
    expect(record?.baseDigest).toBe(await registryDigest(digestChecker, TEST_BASE_IMAGE));
    expect(record?.latestBaseDigest).toBeUndefined();
    expect(Date.parse(record?.builtAt ?? '')).toBeGreaterThanOrEqual(started - 1000);
    expect(Date.parse(record?.checkedAt ?? '')).toBeGreaterThanOrEqual(started - 1000);
    expect(docker.refused).toEqual([]);
  });

  it('the daily cleanup removes unused and dangling helper images, keeps the others, and gives unknown tags a grace period', async () => {
    const currentId = cli.image(tag)?.Id;
    const unused = otherHelperTag();
    const recent = otherHelperTag();
    const unknown = otherHelperTag();
    const otherRepository = `devenv-test-other-${run.runId}:1`;
    const unusedId = dummyHelperImage('unused', unused);
    dummyHelperImage('recent', recent);
    dummyHelperImage('unknown', unknown);
    dummyHelperImage('other-repository', otherRepository);
    const danglingId = dummyHelperImage('dangling');
    const recentlyUsed = ago(DAY_MS);
    await updateHelperState(statePath, (state) => {
      state.images[unused] = { lastUsedAt: ago(HELPER_UNUSED_LIMIT_MS + DAY_MS) };
      state.images[recent] = { lastUsedAt: recentlyUsed };
      state.lastCleanupAt = ago(HELPER_CLEANUP_INTERVAL_MS + DAY_MS);
    });
    const started = Date.now();
    await timings.measure('daily cleanup', () => newWindowHelper().ensureImage());

    expect(cli.image(unusedId)).toBeUndefined();
    expect(cli.image(danglingId)).toBeUndefined();
    for (const kept of [recent, unknown, otherRepository]) expect(cli.image(kept), kept).toBeDefined();
    expect(cli.image(tag)?.Id).toBe(currentId);
    const state = await readHelperState(statePath);
    // A tombstone: if another installation builds the tag again, it stays.
    expect(Object.keys(state.images[unused] ?? {})).toEqual(['removedAt']);
    expect(state.images[recent]?.lastUsedAt).toBe(recentlyUsed);
    // The grace period of a tag that the state did not know (a foreign tag) starts now.
    expect(Date.parse(state.images[unknown]?.lastUsedAt ?? '')).toBeGreaterThanOrEqual(started - 1000);
    expect(state.images[unknown]?.foreignSince).toBe(state.images[unknown]?.lastUsedAt);
    expect(Date.parse(state.lastCleanupAt ?? '')).toBeGreaterThanOrEqual(started - 1000);
    expect(docker.builds).toHaveLength(2);
    expect(docker.refused).toEqual([]);
  });

  it('a new tag that cannot be built fails with helperFailed and uses no other helper image', async () => {
    // user decision 2026-09-29: no previous helper image. Changed expectation: before, the helper image that this run
    // built was used as the previous helper and recorded as the previous tag. The helper Dockerfile of an "extension
    // update" whose build fails (as offline), in its own folder, so its tag differs from `tag`.
    const updatedPath = path.join(run.runDir, 'tiny-helper-update', 'Dockerfile');
    const updated = [`FROM ${TEST_BASE_IMAGE}`, 'RUN exit 1', `LABEL ${TEST_RUN_LABEL}=${run.runId}`, ''].join('\n');
    fs.mkdirSync(path.dirname(updatedPath), { recursive: true });
    fs.writeFileSync(updatedPath, updated);
    const updatedTag = helperImageTag(updated);
    expect(updatedTag).not.toBe(tag);
    const currentId = cli.image(tag)?.Id;
    expect((await readHelperState(statePath)).images[tag]?.imageId).toBe(currentId);
    // Plan step 11I (U7, decision of 2026-10-08): HelperImages (before: a WorkspaceHelper).
    const helper = new HelperImages({ docker, logger: log, dockerfilePath: updatedPath, env, statePath, baseDigest, onBaseImageCheck: (check) => checks.push(check) });

    const failure = await timings.measure('failed build', () => helper.ensureImage().catch((error: unknown) => error));
    await settled();
    expect(failure).toMatchObject({ code: 'helperFailed' });
    expect(cli.image(updatedTag)).toBeUndefined();
    expect(docker.builds.slice(-2).map((build) => build.tag)).toEqual([updatedTag, updatedTag]);
    const state = await readHelperState(statePath);
    expect(state).not.toHaveProperty('previousTag');
    expect(state.images[updatedTag]).toBeUndefined();
    expect(cli.image(tag)?.Id).toBe(currentId);
    expect(docker.refused).toEqual([]);
  });
});
