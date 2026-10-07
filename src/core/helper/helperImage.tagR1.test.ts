// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #101 (B, mutation probes): the cleanup removes a monitor tag whose helper tag is on another image
// (moved by a rebuild), says so, and leaves the monitor tags of the current image alone.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImageInfo } from '../docker/dockerObjects';
import type { Logger } from '../ports';
import { ensureHelperImage, helperImageTag, type HelperImageDocker } from './helperImage';
import type { HelperState } from './helperState';

const BASE = 'node:24-trixie-slim';
const DOCKERFILE = `ARG BASE_IMAGE=${BASE}\nFROM \${BASE_IMAGE}\nLABEL nimblescape.devenv.helper=true\n`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = Date.parse('2026-09-24T12:00:00Z');

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

/** Helper images in listing order; removeImage records and untags. */
function setup(images: Array<{ id: string; tags: string[] }>) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-tagR1-'));
  folders.push(folder);
  const file = path.join(folder, 'Dockerfile');
  fs.writeFileSync(file, DOCKERFILE);
  const tag = helperImageTag(DOCKERFILE);
  const statePath = path.join(folder, 'storage', 'helper.json');
  const iso = new Date(NOW).toISOString();
  const state: HelperState = { version: 1, images: { [tag]: { baseImage: BASE, baseDigest: DIGEST, checkedAt: iso, lastUsedAt: iso } } };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
  const removals: string[] = [];
  const lines: string[] = [];
  const idOf = (reference: string) => images.find((image) => image.id === reference || image.tags.includes(reference))?.id;
  const docker: HelperImageDocker = {
    imageExists: async (reference) => idOf(reference) !== undefined,
    imageId: async (reference) => idOf(reference),
    buildImage: async () => {
      throw new Error('No build.');
    },
    listImagesByLabel: async (): Promise<ImageInfo[]> => images.map((image) => ({ id: image.id, tags: [...image.tags], createdAt: '2026-09-01 10:00:00 +0200 CEST' })),
    removeImage: async (reference) => {
      removals.push(reference);
      for (const image of images) image.tags = image.tags.filter((t) => t !== reference);
      return true;
    },
  };
  const logger: Logger = {
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
    output: () => {},
  };
  const ensure = () => ensureHelperImage(docker, file, { statePath, baseDigest: async () => DIGEST, clock: { now: () => NOW }, logger });
  return { tag, removals, lines, ensure };
}

const monitorOf = (helperTag: string) => helperTag.replace('devenv-helper:', 'devenv-monitor:');
const CURRENT_ID = `sha256:${'1'.repeat(64)}`;
const OLD_ID = `sha256:${'2'.repeat(64)}`;

describe('the cleanup of monitor tags (review round 1 of PR #101, B)', () => {
  it('removes a monitor tag whose helper tag moved to another image (listed before it), with an info line', async () => {
    const tag = helperImageTag(DOCKERFILE);
    const images = [
      { id: CURRENT_ID, tags: [tag] },
      { id: OLD_ID, tags: [monitorOf(tag), 'mine:keep'] },
    ];
    const s = setup(images);
    expect(await s.ensure()).toBe(tag);
    expect(s.removals).toEqual([monitorOf(tag)]);
    expect(images[1].tags).toEqual(['mine:keep']);
    expect(s.lines).toContain(`info The tag ${monitorOf(tag)} of the Session Monitor is no longer on its workspace helper image. It is removed.`);
  });

  it('leaves a monitor tag of the current image alone, without a log line', async () => {
    const tag = helperImageTag(DOCKERFILE);
    const images = [{ id: CURRENT_ID, tags: [tag, 'devenv-monitor:fedcba987654'] }];
    const s = setup(images);
    expect(await s.ensure()).toBe(tag);
    expect(s.removals).toEqual([]);
    expect(images[0].tags).toEqual([tag, 'devenv-monitor:fedcba987654']);
    expect(s.lines.filter((line) => line.includes('devenv-monitor:'))).toEqual([]);
  });
});
