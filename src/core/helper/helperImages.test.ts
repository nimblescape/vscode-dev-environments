// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F2: the helper image of the bootstrap on its own (HelperImages), as the extension uses it without the
// steps of the workspace helper. Its rules are tested in helperImages.rules.test.ts (plan step 11I, U7, decision of
// 2026-10-08: moved from workspaceHelper.test.ts, which tested them through the workspace helper while it delegated to
// HelperImages); here: that it works alone, on the Docker port of the bootstrap.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageInfo } from '../docker/dockerObjects';
import { isUserFacingError } from '../errors';
import { silentLogger } from '../ports';
import { helperImageTag } from './helperImage';
import { HelperImages, type HelperImageDocker } from './helperImages';

const DOCKERFILE = 'FROM node:22-bookworm-slim\n';
const TAG = helperImageTag(DOCKERFILE);
const ID = `sha256:${'a'.repeat(64)}`;

class FakeDocker implements HelperImageDocker {
  readonly images = new Set<string>();
  readonly builds: string[] = [];
  async imageExists(reference: string): Promise<boolean> {
    return this.images.has(reference);
  }
  async imageId(reference: string): Promise<string | undefined> {
    return this.images.has(reference) ? ID : undefined;
  }
  async buildImage(options: { tag: string }): Promise<string | undefined> {
    this.builds.push(options.tag);
    this.images.add(options.tag);
    return ID;
  }
  async listImagesByLabel(): Promise<ImageInfo[]> {
    return [...this.images].map((tag) => ({ id: ID, tags: [tag], createdAt: '' }));
  }
  async removeImage(): Promise<boolean> {
    return false;
  }
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-images-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function images(docker: FakeDocker, onImageBuilt?: () => void): HelperImages {
  return new HelperImages({ docker, logger: silentLogger, dockerfilePath: path.join(dir, 'Dockerfile'), onImageBuilt });
}

describe('HelperImages (plan step 11F2)', () => {
  it('builds a missing helper tag once and reports the build', async () => {
    const docker = new FakeDocker();
    let built = 0;
    const helper = images(docker, () => built++);
    expect(await helper.ensureImagePresent()).toEqual({ tag: TAG, id: ID });
    expect(await helper.prebuildImage({ signal: new AbortController().signal })).toEqual({ tag: TAG, id: ID });
    expect(docker.builds).toEqual([TAG]);
    expect(built).toBe(1);
  });

  it('checks the tag without a build: missing is a helperFailed error, present is fine', async () => {
    const docker = new FakeDocker();
    const helper = images(docker);
    const missing = await helper.checkImagePresent().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isUserFacingError(missing) && missing.code).toBe('helperFailed');
    expect(await helper.presentImage()).toBeUndefined();
    expect(docker.builds).toEqual([]);
    docker.images.add(TAG);
    await helper.checkImagePresent();
    expect(await helper.presentImage()).toEqual({ tag: TAG, id: ID });
  });

  // Review round 1 of PR #129 (A-L3): changed expectation: HelperImages no longer names a socket (socketPathFor is
  // removed: the steps of the workspace helper take the socket of the worker's own container, plan step 11I, U7).
  it('names the local engine without an engine of the operation', async () => {
    const helper = images(new FakeDocker());
    expect(await helper.engineKey()).toBe('');
    expect(await helper.currentEngine()).toEqual({ key: '' });
  });
});
