// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #101 (B, mutation probes): the cleanup checks every monitor tag of an image, removes the monitor
// tag of an expired helper tag only from that tag's own image, keeps a helper tag whose monitor tag stays (A2-L1) and
// goes on with the next helper tag; a rebuild removes every monitor tag of the previous image.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImageInfo } from '../docker/dockerObjects';
import type { Logger } from '../ports';
import { ensureHelperImageUse, helperImageTag, type HelperImageDocker } from './helperImage';
import type { HelperImageRecord, HelperState } from './helperState';

const BASE = 'node:24-trixie-slim';
const DOCKERFILE = `ARG BASE_IMAGE=${BASE}\nFROM \${BASE_IMAGE}\nLABEL nimblescape.devenv.helper=true\n`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const NOW = Date.parse('2026-09-24T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ISO = new Date(NOW).toISOString();
const EXPIRED = new Date(NOW - 8 * DAY).toISOString();

const CURRENT_ID = `sha256:${'1'.repeat(64)}`;
const OLD_ID = `sha256:${'2'.repeat(64)}`;
const NEW_ID = `sha256:${'3'.repeat(64)}`;
const ORPHAN_ID = `sha256:${'4'.repeat(64)}`;
const X = 'devenv-helper:0123456789ab';
const Y = 'devenv-helper:abcdef012345';
const monitorOf = (helperTag: string) => helperTag.replace('devenv-helper:', 'devenv-monitor:');

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

/**
 * Helper images in listing order. removeImage untags like Docker (false for a reference that does not exist, and for
 * one in `refused`); a build moves the tag to NEW_ID.
 */
function setup(images: Array<{ id: string; tags: string[] }>, records: Record<string, HelperImageRecord> = {}, options: { cleanedUp?: boolean; latest?: string } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-tagR2-'));
  folders.push(folder);
  const file = path.join(folder, 'Dockerfile');
  fs.writeFileSync(file, DOCKERFILE);
  const tag = helperImageTag(DOCKERFILE);
  const statePath = path.join(folder, 'storage', 'helper.json');
  const own: HelperImageRecord = { baseImage: BASE, baseDigest: DIGEST, checkedAt: ISO, lastUsedAt: ISO };
  if (options.latest !== undefined) own.latestBaseDigest = options.latest;
  const state: HelperState = { version: 1, images: { [tag]: own, ...records } };
  if (options.cleanedUp) state.lastCleanupAt = ISO;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
  const removals: string[] = [];
  const refused = new Set<string>();
  const lines: string[] = [];
  const idOf = (reference: string) => images.find((image) => image.id === reference || image.tags.includes(reference))?.id;
  const docker: HelperImageDocker = {
    imageExists: async (reference) => idOf(reference) !== undefined,
    imageId: async (reference) => idOf(reference),
    buildImage: async () => {
      for (const image of images) image.tags = image.tags.filter((t) => t !== tag);
      images.push({ id: NEW_ID, tags: [tag] });
      return NEW_ID;
    },
    listImagesByLabel: async (): Promise<ImageInfo[]> =>
      images.filter((image) => image.tags.length > 0).map((image) => ({ id: image.id, tags: [...image.tags], createdAt: '2026-09-01 10:00:00 +0200 CEST' })),
    removeImage: async (reference) => {
      removals.push(reference);
      if (refused.has(reference)) return false;
      const image = images.find((candidate) => candidate.tags.includes(reference));
      if (image === undefined) return false;
      image.tags = image.tags.filter((t) => t !== reference);
      return true;
    },
  };
  const logger: Logger = {
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
    output: () => {},
  };
  const ensure = async () => (await ensureHelperImageUse(docker, file, { statePath, baseDigest: async () => DIGEST_B, clock: { now: () => NOW }, logger })).tag;
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState;
  return { tag, removals, refused, lines, ensure, readState };
}

describe('the monitor tags of the helper cleanup (review round 2 of PR #101, B)', () => {
  it('checks every monitor tag of an image: an orphan after one whose helper tag is there is removed', async () => {
    const tag = helperImageTag(DOCKERFILE);
    const images = [
      { id: CURRENT_ID, tags: [tag] },
      { id: OLD_ID, tags: [X, monitorOf(X), monitorOf(Y)] },
    ];
    const s = setup(images, { [X]: { lastUsedAt: ISO } });
    expect(await s.ensure()).toBe(tag);
    expect(s.removals).toEqual([monitorOf(Y)]);
    expect(images[1].tags).toEqual([X, monitorOf(X)]);
  });

  it('removes the monitor tag of an expired helper tag only from its own image', async () => {
    const tag = helperImageTag(DOCKERFILE);
    const images = [
      { id: CURRENT_ID, tags: [tag] },
      { id: ORPHAN_ID, tags: [monitorOf(X), 'mine:keep'] },
      { id: OLD_ID, tags: [X] },
    ];
    const s = setup(images, { [X]: { lastUsedAt: EXPIRED } });
    expect(await s.ensure()).toBe(tag);
    // The orphan goes in the loop of its own image; the helper tag X has no monitor tag on its image.
    expect(s.removals).toEqual([monitorOf(X), X]);
    expect(images[2].tags).toEqual([]);
    expect(s.readState().images[X]).toEqual({ removedAt: ISO });
  });

  it('A2-L1: keeps a helper tag whose monitor tag stays, and goes on with the next helper tag of the image', async () => {
    const tag = helperImageTag(DOCKERFILE);
    const images = [
      { id: CURRENT_ID, tags: [tag] },
      { id: OLD_ID, tags: [X, Y, monitorOf(X), monitorOf(Y)] },
    ];
    const s = setup(images, { [X]: { lastUsedAt: EXPIRED }, [Y]: { lastUsedAt: EXPIRED } });
    s.refused.add(monitorOf(X));
    expect(await s.ensure()).toBe(tag);
    expect(s.removals).toEqual([monitorOf(X), monitorOf(Y), Y]);
    expect(images[1].tags).toEqual([X, monitorOf(X)]);
    const state = s.readState();
    expect(state.images[X]?.removedAt).toBeUndefined();
    expect(state.images[Y]).toEqual({ removedAt: ISO });
  });

  it('a rebuild removes every monitor tag left on the previous image', async () => {
    const tag = helperImageTag(DOCKERFILE);
    const images = [{ id: CURRENT_ID, tags: [tag, monitorOf(tag), monitorOf(X)] }];
    // The cleanup is not due: only the rebuild removes.
    const s = setup(images, {}, { cleanedUp: true, latest: DIGEST_B });
    expect(await s.ensure()).toBe(tag);
    expect(s.removals).toEqual([monitorOf(tag), monitorOf(X)]);
    expect(images[0].tags).toEqual([]);
  });
});
