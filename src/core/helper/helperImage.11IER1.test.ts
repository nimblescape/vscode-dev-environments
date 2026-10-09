// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #129 (reviewer B): probes for the mutants of helperImage.ts that survive the suite, on 1ce4600 as
// on the head (gaps before this PR, not lost tests):
// - HG07: recordHelperImageUse keeps the mark of a foreign tag within the hour (`&& !isForeign(record)` removed).
// - HG12: HELPER_LAST_USED_INTERVAL_MS is not an hour (the tests use the constant).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HELPER_LAST_USED_INTERVAL_MS, helperImageTag, recordHelperImageUse } from './helperImage';
import type { HelperState } from './helperState';

const TAG = helperImageTag('FROM node:22-bookworm-slim\n');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-11ier1-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('review round 1 of PR #129 (reviewer B): the record of the use of a helper tag', () => {
  it('writes lastUsedAt at most once per hour (HG12)', () => {
    expect(HELPER_LAST_USED_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it('clears the mark of a foreign tag at once, also within the hour of its lastUsedAt (HG07)', async () => {
    const statePath = path.join(dir, 'helper.json');
    const marked: HelperState = { version: 1, images: { [TAG]: { foreignSince: '2026-10-08T12:00:00.000Z', lastUsedAt: '2026-10-08T12:00:00.000Z' } } };
    fs.writeFileSync(statePath, JSON.stringify(marked));
    await recordHelperImageUse(statePath, TAG, { clock: { now: () => Date.parse('2026-10-08T12:10:00.000Z') } });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as HelperState;
    expect(state.images[TAG]).toEqual({ lastUsedAt: '2026-10-08T12:10:00.000Z' });
  });
});
