// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Monitor cleanup, user decision 2026-09-29 ("monitor must delete outdated data, e.g. old heartbeats and the like that is
// not relevant anymore"): the sweep of the global storage folder. Plan step 8, PR C: each window runs it at activation
// and every hour (SessionCoordinator.cleanUpStorage); before, the local Session Monitor ran it. It removes only files that
// the windows wrote and that no reader uses any more:
//   R6  pending/<environment id>.json whose createdAt is more than an hour from now (readers ignore it after
//       PENDING_MAX_AGE_MS, 2 minutes);
//   R7  disconnect/<environment id>.json whose requestedAt is more than 10 minutes from now (readers ignore it after
//       DISCONNECT_REQUEST_MAX_AGE_MS, 1 minute);
//   R8  temporary files of the atomic writers (`.<name>.<pid>.<8 hex>.tmp`, atomicTemporaryPath in atomicJson.ts:
//       writeJsonAtomic, the heartbeat of SessionCoordinator and computerId.ts, and a leftover of the cut of monitor.log
//       of the removed local Session Monitor;
//       review round 8 of PR #63, R8-1, and review round 9, A4/B6) whose modification time is more than an hour from now (review
//       round 2 of PR #63, R2-9: either way, as R6 and R7), in the storage folder, sessions/, pending/, operations/ and
//       disconnect/ (a write that was killed between the write and the rename).
// Only regular files are removed, never a link or what it points to, never a folder; a folder that is a link is not
// entered. Every error is ignored (the next sweep tries again). No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { isStorageId, parseJson, type StoragePaths } from './paths';

/** R6: a pending connection file whose createdAt is further from now than this is removed. */
export const STALE_PENDING_MAX_AGE_MS = 60 * 60_000;
/** R7: a disconnect request whose requestedAt is further from now than this is removed. */
export const STALE_DISCONNECT_MAX_AGE_MS = 10 * 60_000;
/** R8: a temporary file of an atomic writer (atomicTemporaryPath, see ATOMIC_TEMPORARY_FILE) whose modification time is further from now than this is removed. */
export const STALE_TEMPORARY_MAX_AGE_MS = 60 * 60_000;
/** A window sweeps this often (plan step 8, PR C; before, the local Session Monitor, of its own run time). */
export const STORAGE_SWEEP_INTERVAL_MS = 60 * 60_000;
/**
 * The name of a temporary file of atomicTemporaryPath (atomicJson.ts), which all atomic writers of the storage folder use
 * (writeJsonAtomic, SessionCoordinator's heartbeat, computerId.ts; the log of the local Session Monitor until plan step 8, PR C).
 */
export const ATOMIC_TEMPORARY_FILE = /^\..+\.\d+\.[0-9a-f]{8}\.tmp$/;
/** A pending file or a disconnect request larger than this is not read (its modification time counts then). */
const MAX_READ_BYTES = 64 * 1024;

/** The files that a sweep removed, as paths relative to the storage folder. */
export interface StorageSweepResult {
  pending: string[];
  disconnect: string[];
  temporary: string[];
}

/** R6–R8 once. `now`: the wall clock (the times in the files are of it). Never throws. */
export async function sweepStorage(paths: StoragePaths, now: number): Promise<StorageSweepResult> {
  const result: StorageSweepResult = { pending: [], disconnect: [], temporary: [] };
  const relative = (file: string) => path.relative(paths.root, file);
  for (const file of await staleRecords(paths.pendingDir, 'createdAt', now, STALE_PENDING_MAX_AGE_MS)) result.pending.push(relative(file));
  for (const file of await staleRecords(paths.disconnectDir, 'requestedAt', now, STALE_DISCONNECT_MAX_AGE_MS)) result.disconnect.push(relative(file));
  for (const dir of [paths.root, paths.sessionsDir, paths.pendingDir, paths.operationsDir, paths.disconnectDir]) {
    for (const name of await namesOf(dir)) {
      if (!ATOMIC_TEMPORARY_FILE.test(name)) continue;
      const file = path.join(dir, name);
      const stat = await regularFile(file);
      if (stat && Math.abs(now - stat.mtimeMs) > STALE_TEMPORARY_MAX_AGE_MS && (await unlinkSame(file, stat))) result.temporary.push(relative(file));
    }
  }
  return result;
}

/**
 * The `<environment id>.json` files of `dir` whose time field `field` is further from now than `maxAgeMs` (both ways: a
 * time far in the future after a clock change counts too), removed. A file without a valid time counts by its
 * modification time.
 */
async function staleRecords(dir: string, field: string, now: number, maxAgeMs: number): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await namesOf(dir)) {
    if (!name.endsWith('.json') || !isStorageId(name.slice(0, -'.json'.length))) continue;
    const file = path.join(dir, name);
    const stat = await regularFile(file);
    if (!stat) continue;
    let time = stat.mtimeMs;
    if (stat.size <= MAX_READ_BYTES) {
      const value = await fs.promises.readFile(file, 'utf8').then(parseJson, () => undefined);
      const text = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[field] : undefined;
      const parsed = typeof text === 'string' ? Date.parse(text) : Number.NaN;
      if (Number.isFinite(parsed)) time = parsed;
    }
    if (Math.abs(now - time) > maxAgeMs && (await unlinkSame(file, stat))) removed.push(file);
  }
  return removed;
}

/** The names in `dir`; none when it is missing, not a folder, or a link. */
async function namesOf(dir: string): Promise<string[]> {
  try {
    if (!(await fs.promises.lstat(dir)).isDirectory()) return [];
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

/** The lstat of `file` when it is a regular file (not a link); undefined otherwise or on an error. */
async function regularFile(file: string): Promise<fs.Stats | undefined> {
  try {
    const stat = await fs.promises.lstat(file);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes `file` when it is still the file of `stat` (a window may have replaced it with a new one by a rename meanwhile).
 * True when it was removed. Exported for the tests (review round 1 of PR #63, B4).
 */
export async function unlinkSame(file: string, stat: fs.Stats): Promise<boolean> {
  const again = await regularFile(file);
  if (!again || again.ino !== stat.ino || again.mtimeMs !== stat.mtimeMs) return false;
  try {
    await fs.promises.unlink(file);
    return true;
  } catch {
    return false;
  }
}
