// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, "11H: the shared VS Code server and the Session Monitor's daily run", D2 to D4):
// the pure rules of the Session Monitor's background run (background.ts does the I/O): its stored state in the volume
// (the end of the last run, the last cleanup), when the cleanup of the shared VS Code server store is due (at most once a
// day), which qualities of the server it keeps new, and which server versions the cleanup removes. Pure; no I/O.
import type { VscodeQuality } from '../core/helperChannel/protocol';

/** Plan step 11H2 (D2): the cleanup of the store runs at most once a day. */
export const STORE_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
/** Plan step 11H2 (the brief): a server version that was not used for this long may be removed. */
export const SERVER_UNUSED_MS = 14 * 24 * 60 * 60_000;
/** Plan step 11H2 (the brief): the newest server versions of a quality and platform that always stay. */
export const KEPT_SERVER_VERSIONS = 2;

/** Plan step 11H2: the state of the background run in the volume of the monitor (CACHE_RUN_FILE). */
export interface CacheRunState {
  /** When the last run ended (ms since the epoch, the clock of the engine's host). */
  lastEndAt?: number;
  /** When the last cleanup of the store ran. */
  lastCleanupAt?: number;
}

/** Plan step 11H2: the stored state; an empty one for anything invalid (a field that is no time is left out). */
export function parseCacheRunState(text: string): CacheRunState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const time = (field: unknown) => (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined);
  const { lastEndAt, lastCleanupAt } = value as { lastEndAt?: unknown; lastCleanupAt?: unknown };
  const state: CacheRunState = {};
  if (time(lastEndAt) !== undefined) state.lastEndAt = time(lastEndAt);
  if (time(lastCleanupAt) !== undefined) state.lastCleanupAt = time(lastCleanupAt);
  return state;
}

/**
 * Plan step 11H2: a stored time more than this ahead of the clock is no time of the past: a clock that was far ahead
 * and then corrected (review round 4 of PR #57, L1, as the image schedule did). The schedule then goes on from now.
 */
export const CLOCK_RESET_MS = 60 * 60_000;

/**
 * Plan step 11H2 (D2): whether the cleanup of the store is due: never ran, ran at least STORE_CLEANUP_INTERVAL_MS ago, or
 * its stored time lies more than CLOCK_RESET_MS ahead of `now` (a clock that was corrected).
 */
export function cleanupDue(lastCleanupAt: number | undefined, now: number): boolean {
  return lastCleanupAt === undefined || now - lastCleanupAt >= STORE_CLEANUP_INTERVAL_MS || lastCleanupAt - now > CLOCK_RESET_MS;
}

/**
 * Plan step 11H2 (D3; the brief): the qualities whose newest server the run fetches: `stable` always, `insider` when
 * the store has a server of it (`storedQualities`, those with a ready server for the engine's platform).
 */
export function qualitiesToFetch(storedQualities: ReadonlySet<VscodeQuality>): VscodeQuality[] {
  return storedQualities.has('insider') ? ['stable', 'insider'] : ['stable'];
}

/** Plan step 11H2: a server version of the store as the cleanup sees it: its commit and its last use (markServerUsed). */
export interface StoredServer {
  commit: string;
  /** The modification time of its folder (ms). */
  usedAt: number;
}

/**
 * Plan step 11H2 (the brief): the commits of one quality and platform that the cleanup removes. The versions are ordered
 * newest first by `released` (the commits of the update service, newest first; a version that it does not name counts
 * as older than all that it names, and among those the one used last comes first); the KEPT_SERVER_VERSIONS newest stay,
 * and so does every version used within SERVER_UNUSED_MS of `now` (a time in the future counts as used now). Every other
 * version is removed.
 */
export function serversToRemove(stored: readonly StoredServer[], released: readonly string[], now: number): string[] {
  const rank = new Map(released.map((commit, index) => [commit, index]));
  const ordered = [...stored].sort((a, b) => {
    const byRelease = (rank.get(a.commit) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.commit) ?? Number.MAX_SAFE_INTEGER);
    return byRelease !== 0 ? byRelease : b.usedAt - a.usedAt;
  });
  return ordered
    .slice(KEPT_SERVER_VERSIONS)
    .filter((server) => now - server.usedAt >= SERVER_UNUSED_MS)
    .map((server) => server.commit);
}
