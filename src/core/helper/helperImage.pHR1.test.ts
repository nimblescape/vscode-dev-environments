// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR H (reviewer B): the log line of a check of the base image that finds the image built from the
// local base image (recordCheck, rebuildReason 'unpulled') names the next maintaining ensure, as the line of a changed
// base image does (helperImage.test.ts, "weekly check of the base image"). Kills B43 (that line back to "at the next
// open."; the assertion of helperImage.test.ts that names this case matches the line of the rebuild itself, whose prefix
// is the same).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImageInfo } from '../docker/dockerObjects';
import type { Logger } from '../ports';
import { ensureHelperImage, helperImageTag, type HelperImageDocker } from './helperImage';

const BASE = 'node:24-trixie-slim';
const DOCKERFILE = `FROM ${BASE}\n`;
const TAG = helperImageTag(DOCKERFILE);
const ID = `sha256:${'1'.repeat(64)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const OLD = '2026-09-01T12:00:00.000Z';

/** The engine has the image of the tag; nothing is built or removed. */
class FakeDocker implements HelperImageDocker {
  readonly builds: unknown[] = [];
  async imageExists(reference: string): Promise<boolean> {
    return reference === TAG || reference === ID;
  }
  async imageId(reference: string): Promise<string | undefined> {
    return reference === TAG || reference === ID ? ID : undefined;
  }
  async buildImage(options: Parameters<HelperImageDocker['buildImage']>[0]): Promise<string | undefined> {
    this.builds.push(options);
    return ID;
  }
  async listImagesByLabel(): Promise<ImageInfo[]> {
    return [{ id: ID, tags: [TAG], createdAt: '' }];
  }
  async removeImage(): Promise<boolean> {
    return false;
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the log of a check of the base image (review round 1 of PR H, reviewer B)', () => {
  it('names the next maintaining ensure for an image that was built from the local base image (B43)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-phr1-'));
    dirs.push(dir);
    const file = path.join(dir, 'Dockerfile');
    fs.writeFileSync(file, DOCKERFILE);
    const statePath = path.join(dir, 'storage', 'helper.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    // Built without --pull, never checked: the weekly check is due; the cleanup ran today.
    const record = { baseImage: BASE, builtAt: OLD, builtWithoutPull: OLD, lastUsedAt: OLD };
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, images: { [TAG]: record }, lastCleanupAt: new Date(NOW).toISOString() }));
    const lines: string[] = [];
    const logger: Logger = {
      info: (message) => lines.push(`info ${message}`),
      warn: (message) => lines.push(`warn ${message}`),
      error: (message) => lines.push(`error ${message}`),
      output: () => {},
    };
    const checks: Promise<void>[] = [];
    const docker = new FakeDocker();
    expect(
      await ensureHelperImage(docker, file, {
        statePath,
        baseDigest: async () => DIGEST,
        clock: { now: () => NOW },
        logger,
        onBaseImageCheck: (check) => checks.push(check),
      }),
    ).toBe(TAG);
    expect(checks).toHaveLength(1);
    await Promise.all(checks);
    expect(lines).toContain(
      `info The workspace helper image ${TAG} was built from the local base image. It is built again from the current base image when a window starts or a worker is set up for an open.`,
    );
    // The check builds nothing itself: it asks the next maintaining ensure for the rebuild.
    expect(docker.builds).toEqual([]);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { images: Record<string, { latestBaseDigest?: string }> };
    expect(state.images[TAG]?.latestBaseDigest).toBe(DIGEST);
  });
});
