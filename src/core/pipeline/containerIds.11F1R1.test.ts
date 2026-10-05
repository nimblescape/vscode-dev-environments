// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F1, review B round 1 (mutation probes): the comparison of container IDs (containerIds.ts). An empty ID
// never matches; a short ID matches its full ID in either order; two different full IDs never match.
import { describe, expect, it } from 'vitest';
import { sameContainer, sameContainerId } from './containerIds';

const FULL = 'a1b2c3d4e5f6'.padEnd(64, '0');
const OTHER_FULL = 'a1b2c3d4e5f6'.padEnd(63, '0') + '1';

describe('containerIds, review B round 1 of plan step 11F1', () => {
  it('an empty ID never matches', () => {
    expect(sameContainerId('', FULL)).toBe(false);
    expect(sameContainerId(FULL, '')).toBe(false);
    expect(sameContainerId('', '')).toBe(false);
    expect(sameContainer('', FULL)).toBe(false);
    expect(sameContainer(FULL, '')).toBe(false);
  });

  it('a short ID matches its full ID in either order, of any short length', () => {
    for (const length of [12, 20, 40]) {
      const short = FULL.slice(0, length);
      expect(sameContainerId(short, FULL), `${length}`).toBe(true);
      expect(sameContainerId(FULL, short), `${length}`).toBe(true);
      expect(sameContainer(short, FULL), `${length}`).toBe(true);
      expect(sameContainer(FULL, short), `${length}`).toBe(true);
    }
  });

  it('two different full IDs never match, nor two different short ones', () => {
    expect(sameContainer(FULL, OTHER_FULL)).toBe(false);
    expect(sameContainer(FULL.slice(0, 12), 'ffffffffffff')).toBe(false);
    expect(sameContainer(FULL, FULL)).toBe(true);
  });
});
