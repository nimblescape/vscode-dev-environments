// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, D2 to D4): the pure rules of the Session Monitor's background run.
import { describe, expect, it } from 'vitest';
import {
  CLOCK_RESET_MS,
  KEPT_SERVER_VERSIONS,
  SERVER_UNUSED_MS,
  STORE_CLEANUP_INTERVAL_MS,
  cleanupDue,
  parseCacheRunState,
  qualitiesToFetch,
  serversToRemove,
} from './backgroundRules';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-10-09T12:00:00Z');
const commit = (n: number) => n.toString(16).padStart(40, '0');

describe('the state of the background run (plan step 11H2)', () => {
  it('reads the end of the last run and the last cleanup; anything invalid is left out', () => {
    expect(parseCacheRunState(JSON.stringify({ lastEndAt: 5, lastCleanupAt: 7 }))).toEqual({ lastEndAt: 5, lastCleanupAt: 7 });
    expect(parseCacheRunState(JSON.stringify({ lastEndAt: -1, lastCleanupAt: '7' }))).toEqual({});
    expect(parseCacheRunState(JSON.stringify({ lastEndAt: 1.5 }))).toEqual({});
    expect(parseCacheRunState('not json')).toEqual({});
    expect(parseCacheRunState('[1]')).toEqual({});
    expect(parseCacheRunState('null')).toEqual({});
  });
});

describe('the cleanup of the store, at most once a day (plan step 11H2, D2)', () => {
  it('is due when it never ran or ran a day ago, not before', () => {
    expect(STORE_CLEANUP_INTERVAL_MS).toBe(DAY);
    expect(cleanupDue(undefined, NOW)).toBe(true);
    expect(cleanupDue(NOW - DAY, NOW)).toBe(true);
    expect(cleanupDue(NOW - DAY + 1, NOW)).toBe(false);
    expect(cleanupDue(NOW, NOW)).toBe(false);
  });

  it('is due when its time lies more than an hour ahead (a corrected clock), not for a small step', () => {
    expect(cleanupDue(NOW + CLOCK_RESET_MS + 1, NOW)).toBe(true);
    expect(cleanupDue(NOW + CLOCK_RESET_MS, NOW)).toBe(false);
  });
});

describe('the qualities of the newest server (plan step 11H2, D3)', () => {
  // Review round 1 of 11H2 (A-M1): changed expectation, insider only while an open used an insider version within 14 days
  // (before: whenever the store had a ready insider server, which the monitor's own fetches kept true for ever).
  it('stable always, insider only while an open used an insider version within 14 days', () => {
    expect(qualitiesToFetch([], NOW)).toEqual(['stable']);
    expect(qualitiesToFetch([{ quality: 'stable', at: NOW }], NOW)).toEqual(['stable']);
    expect(qualitiesToFetch([{ quality: 'insider', at: NOW - 14 * DAY + 1 }], NOW)).toEqual(['stable', 'insider']);
    expect(qualitiesToFetch([{ quality: 'stable', at: NOW }, { quality: 'insider', at: NOW + DAY }], NOW)).toEqual(['stable', 'insider']);
    expect(qualitiesToFetch([{ quality: 'insider', at: NOW - 14 * DAY }], NOW)).toEqual(['stable']);
    expect(qualitiesToFetch([{ quality: 'insider', at: NOW - 100 * DAY }, { quality: 'stable', at: NOW }], NOW)).toEqual(['stable']);
  });
});

describe('the server versions that the cleanup removes (plan step 11H2)', () => {
  const released = [commit(5), commit(4), commit(3), commit(2), commit(1)];
  const old = NOW - SERVER_UNUSED_MS;

  it('keeps the two newest releases, also unused ones, and removes older ones unused for 14 days', () => {
    expect(KEPT_SERVER_VERSIONS).toBe(2);
    const stored = [1, 2, 3, 4, 5].map((n) => ({ commit: commit(n), usedAt: old }));
    expect(serversToRemove(stored, released, NOW).sort()).toEqual([commit(1), commit(2), commit(3)]);
  });

  it('keeps a version used within 14 days, whatever its age, and one used in the future', () => {
    const stored = [
      { commit: commit(5), usedAt: old },
      { commit: commit(4), usedAt: old },
      { commit: commit(3), usedAt: old + 1 },
      { commit: commit(2), usedAt: NOW + DAY },
      { commit: commit(1), usedAt: old },
    ];
    expect(serversToRemove(stored, released, NOW)).toEqual([commit(1)]);
  });

  it('orders by the releases, not by the use: the newest release stays although another was used later', () => {
    const stored = [
      { commit: commit(5), usedAt: old - DAY },
      { commit: commit(4), usedAt: old - DAY },
      { commit: commit(1), usedAt: old },
    ];
    expect(serversToRemove(stored, released, NOW)).toEqual([commit(1)]);
  });

  it('a version that the releases do not name is older than all that they name; among those, the last used stays first', () => {
    const unknownA = 'a'.repeat(40);
    const unknownB = 'b'.repeat(40);
    expect(serversToRemove([{ commit: unknownA, usedAt: old }, { commit: commit(1), usedAt: old }, { commit: commit(2), usedAt: old }], released, NOW)).toEqual([unknownA]);
    // No release known of either: the one used last is newer.
    expect(serversToRemove([{ commit: unknownA, usedAt: old - 2 }, { commit: unknownB, usedAt: old - 1 }, { commit: commit(1), usedAt: old }], [], NOW)).toEqual([unknownA]);
  });

  it('removes nothing with two versions or fewer', () => {
    expect(serversToRemove([{ commit: commit(1), usedAt: 0 }, { commit: commit(2), usedAt: 0 }], released, NOW)).toEqual([]);
    expect(serversToRemove([], released, NOW)).toEqual([]);
  });
});
