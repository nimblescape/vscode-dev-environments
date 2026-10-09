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
  /**
   * Review round 1 of 11H2 (A-L4): the server versions (serverVersionName) whose last fetch by the run failed, with the
   * time of that failure; the run tries such a version again only after FETCH_RETRY_MS (fetchRetryDue).
   */
  failedFetches?: Record<string, number>;
}

/** Review round 1 of 11H2 (A-L4): a version whose fetch by the run failed is tried again after this long (a day). */
export const FETCH_RETRY_MS = 24 * 60 * 60_000;
/** Review round 1 of 11H2 (A-L4): the most failed fetches that the state keeps (the newest of each quality and platform). */
export const MAX_FAILED_FETCHES = 16;
/** A server version as serverVersionName writes it. */
const SERVER_VERSION = /^(stable|insider)-(linux-x64|linux-arm64)-[0-9a-f]{40}$/;

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
  const { lastEndAt, lastCleanupAt, failedFetches } = value as { lastEndAt?: unknown; lastCleanupAt?: unknown; failedFetches?: unknown };
  const state: CacheRunState = {};
  if (time(lastEndAt) !== undefined) state.lastEndAt = time(lastEndAt);
  if (time(lastCleanupAt) !== undefined) state.lastCleanupAt = time(lastCleanupAt);
  // Review round 1 of 11H2 (A-L4): only names of server versions with a time, at most MAX_FAILED_FETCHES; else none.
  if (typeof failedFetches === 'object' && failedFetches !== null && !Array.isArray(failedFetches)) {
    const entries = Object.entries(failedFetches as Record<string, unknown>);
    if (entries.length <= MAX_FAILED_FETCHES && entries.every(([version, at]) => SERVER_VERSION.test(version) && time(at) !== undefined)) {
      state.failedFetches = Object.fromEntries(entries) as Record<string, number>;
    }
  }
  return state;
}

/**
 * Review round 1 of 11H2 (A-L4): whether the run may fetch a version whose last fetch by the run failed at `failedAt`
 * (undefined: none failed): at least FETCH_RETRY_MS later, or when that time lies more than CLOCK_RESET_MS ahead of
 * `now` (a clock that was corrected). An open's own fetch never waits for it.
 */
export function fetchRetryDue(failedAt: number | undefined, now: number): boolean {
  return failedAt === undefined || now - failedAt >= FETCH_RETRY_MS || failedAt - now > CLOCK_RESET_MS;
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
 * Plan step 11H2 (D3; the brief), review round 1 (A-M1): the qualities whose newest server the run fetches: `stable`
 * always, `insider` only while an open used an insider version (for the engine's platform) within SERVER_UNUSED_MS of
 * `now` (`opened`: the times of the markers of markServerOpened; a time in the future counts as now). The monitor's own
 * fetches and links never count, so one Insiders open does not make it fetch every Insiders build for ever.
 */
export function qualitiesToFetch(opened: readonly { quality: VscodeQuality; at: number }[], now: number): VscodeQuality[] {
  return opened.some((use) => use.quality === 'insider' && now - use.at < SERVER_UNUSED_MS) ? ['stable', 'insider'] : ['stable'];
}

/** Plan step 11H2: a server version of the store as the cleanup sees it: its commit and its last use by an open. */
export interface StoredServer {
  commit: string;
  /**
   * Review round 1 of 11H2 (A-M1): the time of its marker (markServerOpened); undefined: no open used it. Review round 2
   * (A2-L2): the cleanup gives the time of the folder of a version without a marker (cleanupUsedAt of background.ts).
   */
  usedAt: number | undefined;
}

/**
 * Plan step 11H2 (the brief): the commits of one quality and platform that the cleanup removes. The versions are ordered
 * newest first by `released` (the commits of the update service, newest first; a version that it does not name counts
 * as older than all that it names, and among those the one used last comes first); the KEPT_SERVER_VERSIONS newest stay,
 * and so does every version used by an open within SERVER_UNUSED_MS of `now` (a time in the future counts as used now).
 * Review round 1 of 11H2 (A-M1, A-M2): a version that no open used counts as unused; one that a running container runs
 * (`inUse`, its commit) always stays. Every other version is removed.
 */
export function serversToRemove(stored: readonly StoredServer[], released: readonly string[], now: number, inUse: ReadonlySet<string> = new Set()): string[] {
  const rank = new Map(released.map((commit, index) => [commit, index]));
  const used = (server: StoredServer) => server.usedAt ?? Number.NEGATIVE_INFINITY;
  const ordered = [...stored].sort((a, b) => {
    const byRelease = (rank.get(a.commit) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.commit) ?? Number.MAX_SAFE_INTEGER);
    return byRelease !== 0 ? byRelease : used(b) - used(a) || 0;
  });
  return ordered
    .slice(KEPT_SERVER_VERSIONS)
    .filter((server) => serverUnused(server.usedAt, now) && !inUse.has(server.commit))
    .map((server) => server.commit);
}

/** Review round 1 of 11H2: a version that an open last used at `usedAt` counts as unused at `now` (serversToRemove). */
export function serverUnused(usedAt: number | undefined, now: number): boolean {
  return usedAt === undefined || now - usedAt >= SERVER_UNUSED_MS;
}

/**
 * Review round 1 of 11H2 (A-M2): the server commits that the processes of a running container name (each line of `GET
 * /containers/<id>/top`): every 40-hex string that stands alone in a field (not part of a longer hex string), as in
 * `~/.vscode-server/bin/<commit>/node …`, `…/server/<quality>/<platform>/<commit>/…` of the store, or
 * `~/.vscode-server/cli/servers/Stable-<commit>/…`. Deliberately wide: a commit kept by mistake only stays a day longer.
 */
export function commitsInProcesses(processes: readonly (readonly string[])[]): Set<string> {
  const found = new Set<string>();
  for (const row of processes) {
    for (const field of row) {
      for (const match of field.matchAll(/(?<![0-9a-fA-F])[0-9a-f]{40}(?![0-9a-fA-F])/g)) found.add(match[0]);
    }
  }
  return found;
}
