// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Decisions at the activation of a window (concept 7.9, 7.10, 7.14). No `vscode` import, so they are unit-tested.
import type { ExtensionSettings, PendingConnection, PendingOperation, ReopenRecord } from '../core/types';
import { PENDING_MAX_AGE_MS } from '../monitor/rules';

/** A pending operation older than this is stale: it is removed without running (its request is long forgotten). */
export const PENDING_OPERATION_MAX_AGE_MS = 10 * 60_000;
/**
 * Concept 7.10: the reopen record must be older than this. "Close Remote Connection" makes an empty window that
 * activates within 1 to 3 seconds; it must not reconnect the window that the user disconnected on purpose.
 * 5 seconds, not 30 (user decision 2026-09-26, "go with the proposal for closing"): the log showed a real reopen from the
 * macOS Dock that the 30-second rule blocked. A kept environment (Keep Running When Closed) follows the same rule.
 */
export const REOPEN_MIN_AGE_MS = 5_000;

/** The reason of `decideReopen` for a record younger than REOPEN_MIN_AGE_MS, derived from the constant. */
export const REOPEN_TOO_RECENT_REASON = `the last environment was closed less than ${formatSeconds(REOPEN_MIN_AGE_MS)} ago`;

/**
 * Role A (concept 7.10 #1): true if the open pipeline has just run for this window, which our own `vscode.openFolder`
 * opened. The pending connection file of the environment is then younger than 2 minutes (concept 7.9).
 */
export function pipelineJustRan(pending: PendingConnection | undefined, environmentId: string, now: number): boolean {
  if (!pending || pending.environmentId !== environmentId) return false;
  const createdAt = Date.parse(pending.createdAt);
  return Number.isFinite(createdAt) && Math.abs(now - createdAt) <= PENDING_MAX_AGE_MS;
}

/**
 * Role B (concept 7.14 step 4): the pending operations in the order to run them (oldest first), and the stale ones
 * (older than 10 minutes, or with a time far in the future after a clock change), which are removed without running.
 */
export function sortPendingOperations(
  operations: readonly PendingOperation[],
  now: number,
): { runnable: PendingOperation[]; stale: PendingOperation[] } {
  const runnable: Array<{ operation: PendingOperation; time: number }> = [];
  const stale: PendingOperation[] = [];
  for (const operation of operations) {
    const time = Date.parse(operation.requestedAt);
    if (!Number.isFinite(time) || Math.abs(now - time) > PENDING_OPERATION_MAX_AGE_MS) stale.push(operation);
    else runnable.push({ operation, time });
  }
  runnable.sort((a, b) => a.time - b.time || compare(a.operation.environmentId, b.operation.environmentId));
  return { runnable: runnable.map((entry) => entry.operation), stale };
}

export interface ReopenInput {
  settings: Pick<ExtensionSettings, 'reopenLastOnStartup'>;
  /** The window is local and has no folder and no workspace (`ConnectionAdapter.isEmptyWindow`). */
  emptyWindow: boolean;
  /** Number of other live, active windows (SessionCoordinator.otherActiveWindows). */
  otherActiveWindows: number;
  /** How many of them are connected to an environment (in development, only these count). Default: all of them. */
  otherConnectedWindows?: number;
  /** Number of pending operations that were found (whether this window ran them or not). */
  pendingOperations: number;
  record: ReopenRecord | undefined;
  /** IDs of the environments in the registry that the signed-in account may use (concept 7.5). */
  environmentIds: ReadonlySet<string>;
  now: number;
  /**
   * The window is an Extension Development Host (a debug run of this extension, ExtensionMode.Development). A new debug
   * run follows the end of the previous one within seconds, and the window with the source code stays open: the
   * age rule of REOPEN_MIN_AGE_MS does not apply there, and only other windows that are connected to an environment count. Cost: a
   * "Close Remote Connection" in a debug run connects the window again once (Cancel on the progress stops it); VS Code
   * gives no way to tell that reload from a new debug run. A window that is still connecting has no environment in
   * its status yet and does not count either; the busy mark of the environment keeps a second pipeline waiting.
   */
  development?: boolean;
}

export type ReopenDecision = { reopen: true; environmentId: string } | { reopen: false; reason: string };

/** Concept 7.10 #2 (decision D-5, option a): open the last used environment in an empty window at start. */
export function decideReopen(input: ReopenInput): ReopenDecision {
  if (!input.settings.reopenLastOnStartup) return { reopen: false, reason: 'the setting reopenLastOnStartup is off' };
  if (!input.emptyWindow) return { reopen: false, reason: 'the window is not empty' };
  const others = input.development ? (input.otherConnectedWindows ?? input.otherActiveWindows) : input.otherActiveWindows;
  if (others > 0) return { reopen: false, reason: 'another window is open' };
  if (input.pendingOperations > 0) return { reopen: false, reason: 'an operation is pending' };
  const record = input.record;
  if (!record) return { reopen: false, reason: 'no environment was open before' };
  if (!input.environmentIds.has(record.environmentId)) {
    return { reopen: false, reason: 'the last environment does not exist anymore' };
  }
  const closedAt = Date.parse(record.closedAt);
  // A time in the future (clock change) does not count as old.
  const minAge = input.development ? 0 : REOPEN_MIN_AGE_MS;
  if (!Number.isFinite(closedAt) || closedAt > input.now || input.now - closedAt <= minAge) {
    return { reopen: false, reason: REOPEN_TOO_RECENT_REASON };
  }
  return { reopen: true, environmentId: record.environmentId };
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
