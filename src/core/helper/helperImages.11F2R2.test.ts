// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review 11F2 R2 (mutation testing): HelperImages.runImage, the helper image of a step of the workspace helper. It only
// builds a missing tag (no maintenance), and the caller's options reach that build: its output, its progress (onBuild)
// and its signal.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageInfo } from '../docker/dockerObjects';
import { silentLogger } from '../ports';
import { helperImageTag } from './helperImage';
import { HelperImages, type HelperImageDocker } from './helperImages';

const DOCKERFILE = 'FROM node:22-bookworm-slim\n';
const TAG = helperImageTag(DOCKERFILE);
const ID = `sha256:${'c'.repeat(64)}`;

class BuildingDocker implements HelperImageDocker {
  readonly images = new Set<string>();
  readonly builds: { tag: string; signal?: AbortSignal; pull?: boolean; noCache?: boolean }[] = [];
  async imageExists(reference: string): Promise<boolean> {
    return this.images.has(reference);
  }
  async imageId(reference: string): Promise<string | undefined> {
    return this.images.has(reference) ? ID : undefined;
  }
  async buildImage(options: { tag: string; onOutput?: (text: string) => void; signal?: AbortSignal; pull?: boolean; noCache?: boolean }): Promise<string | undefined> {
    this.builds.push({ tag: options.tag, signal: options.signal, pull: options.pull, noCache: options.noCache });
    options.onOutput?.('Step 1/1 : FROM node\n');
    this.images.add(options.tag);
    return ID;
  }
  async listImagesByLabel(): Promise<ImageInfo[]> {
    return [...this.images].map((tag) => ({ id: ID, tags: [tag], createdAt: '' }));
  }
  async removeImage(): Promise<boolean> {
    throw new Error('a helper run removes no image');
  }
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-images-r2-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function images(docker: BuildingDocker): HelperImages {
  return new HelperImages({ docker, logger: silentLogger, dockerfilePath: path.join(dir, 'Dockerfile') });
}

describe('HelperImages.runImage (review 11F2 R2)', () => {
  it('builds a missing tag with the output, the progress and the signal of the caller', async () => {
    const docker = new BuildingDocker();
    const output: string[] = [];
    const kinds: string[] = [];
    const signal = new AbortController().signal;
    expect(await images(docker).runImage({ onOutput: (text) => output.push(text), onBuild: (kind) => kinds.push(kind), signal })).toEqual({ tag: TAG, id: ID });
    expect(docker.builds.map((build) => build.tag)).toEqual([TAG]);
    expect(docker.builds[0].signal).toBe(signal);
    expect(output.join('')).toContain('Step 1/1');
    expect(kinds).toEqual(['create']);
  });

  it('uses an existing tag without a build, a pull or a cleanup', async () => {
    const docker = new BuildingDocker();
    docker.images.add(TAG);
    expect(await images(docker).runImage({})).toEqual({ tag: TAG, id: ID });
    expect(docker.builds).toEqual([]);
  });
});
