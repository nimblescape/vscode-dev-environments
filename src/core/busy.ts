// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Liveness of busy marks (concept 7.9 rule 1: "The registry marks the environment as busy"). One rule for the windows
// (sidebar, environment service) and the Session Monitor, so that they never disagree about a mark.
import type { BusyMark, WindowStatus } from './types';

/**
 * A busy mark older than this does not protect its environment, even when a process with the owner's ID exists: the ID
 * may belong to another program by now (process IDs are reused, for example after a restart of the computer). No update,
 * rebuild, or delete takes this long.
 */
export const BUSY_MARK_MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * With window status files: the owner window writes its status file every 15 seconds. A status file that was not
 * updated for this time belongs to a window that does not work anymore (or to a process ID from before a restart).
 * Longer than the 60 seconds of rule 1, so that a short delay of the owner (computer sleep) does not end its mark.
 */
export const BUSY_OWNER_STATUS_MAX_AGE_MS = 2 * 60_000;

export interface BusyMarkLivenessInput {
  /** Milliseconds since the epoch. */
  now: number;
  /** `process.kill(pid, 0)` does not fail with ESRCH (see `isProcessAlive`). */
  isAlive: (pid: number) => boolean;
  /**
   * All window status files. When given, the owner window must also have a status file with the process ID of the
   * mark, updated at most BUSY_OWNER_STATUS_MAX_AGE_MS ago. This detects a reused process ID within the 6 hours.
   */
  windowStatuses?: readonly WindowStatus[];
  /**
   * With `windowStatuses`: the owner window must still have a status file of the process of the mark, but its age does
   * not matter. For the sleep grace of the Session Monitor (concept 7.9 "Computer sleep"): after a gap, the owner may
   * not have written its file since the computer woke up.
   */
  ignoreOwnerStatusAge?: boolean;
}

/**
 * True if the busy mark still protects its environment: its owner process exists, and the mark is younger than
 * BUSY_MARK_MAX_AGE_MS (a `since` that cannot be parsed does not end the mark). With `windowStatuses`, the owner window
 * must also have a recent status file of the same process (see BusyMarkLivenessInput; `ignoreOwnerStatusAge` drops only
 * the "recent").
 */
export function isBusyMarkLive(mark: BusyMark, input: BusyMarkLivenessInput): boolean {
  if (!input.isAlive(mark.pid)) return false;
  const since = Date.parse(mark.since);
  if (Number.isFinite(since) && input.now - since > BUSY_MARK_MAX_AGE_MS) return false;
  if (input.windowStatuses) {
    const owner = input.windowStatuses.find((status) => status.windowId === mark.windowId);
    if (!owner || owner.pid !== mark.pid) return false;
    if (input.ignoreOwnerStatusAge) return true;
    const updatedAt = Date.parse(owner.updatedAt);
    if (!Number.isFinite(updatedAt) || input.now - updatedAt > BUSY_OWNER_STATUS_MAX_AGE_MS) return false;
  }
  return true;
}

/**
 * True if the mark keeps the window `owner` from changing the environment: it is a live mark (`isBusyMarkLive`) of
 * another process. A mark of the same process (this window, or an earlier activation of it) never blocks.
 */
export function isBlockingBusyMark(
  mark: BusyMark,
  owner: { windowId: string; pid: number },
  input: BusyMarkLivenessInput,
): boolean {
  if (mark.pid === owner.pid) return false;
  return isBusyMarkLive(mark, input);
}
