// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C2a (decision of 2026-10-04, one operations interface in both directions): the busy mark of an environment
// (concept 7.9 rule 1) as two specific operations, `mark` and `clear`. The window that runs the operation decides them
// with its own clock and its own view of the windows, under its registry lock: the pipeline of the extension calls them
// directly, the pipeline of the worker sends them as the requests `record markBusy` and `record clearBusy`, which the
// extension answers with the same function. Pure over its deps; no `vscode`.
import { isBlockingBusyMark } from '../busy';
import { errorMessage } from '../errors';
import { isoTime, type Clock, type Logger } from '../ports';
import type { BusyMark, BusyOperation, Environment, WindowStatus } from '../types';
import type { EnvironmentRegistry } from '../storage/registry';

/** The kinds of operations that set a busy mark (BusyOperation), for the checks of a request. */
export const BUSY_OPERATIONS: readonly BusyOperation[] = ['create', 'update', 'rebuild', 'delete'];

/**
 * The result of `mark`: the entry with the new mark, the live mark of another window that keeps it (the entry is
 * unchanged), or `undefined` when the environment is not in the registry.
 */
export type BusyMarkResult = { environment: Environment } | { conflict: BusyMark } | undefined;

/** The busy marks of the window that runs the operation. */
export interface EnvironmentBusyMarks {
  /**
   * Sets the mark of this window for `operation`, unless a live mark of another window keeps the environment. Plan step
   * 11E4b: `onReplaced` hears the mark that the new mark replaced, once it is written.
   */
  mark(environmentId: string, operation: BusyOperation, onReplaced?: (mark: BusyMark) => void): Promise<BusyMarkResult>;
  /** Removes the mark of this window; a mark of another window stays. */
  clear(environmentId: string): Promise<void>;
}

export interface BusyMarkView {
  /** The window that runs the operation, and its extension host. */
  owner: { windowId: string; pid: number };
  clock: Clock;
  isAlive: (pid: number) => boolean;
  /** The window status files of this computer (a mark of a window without a recent one is not live). */
  windowStatuses?: () => Promise<readonly WindowStatus[]>;
  logger: Logger;
}

/** The busy marks over the registry of this computer (the extension's side). */
export function registryBusyMarks(registry: Pick<EnvironmentRegistry, 'updateEnvironment'>, view: BusyMarkView): EnvironmentBusyMarks {
  const isOwnMark = (mark: BusyMark) => mark.windowId === view.owner.windowId && mark.pid === view.owner.pid;
  return {
    async mark(environmentId, operation, onReplaced) {
      let windowStatuses: readonly WindowStatus[] | undefined;
      if (view.windowStatuses) {
        try {
          windowStatuses = await view.windowStatuses();
        } catch (error) {
          view.logger.warn(`The window status files could not be read: ${errorMessage(error)}`);
        }
      }
      const now = view.clock.now();
      const mark: BusyMark = { operation, since: isoTime(view.clock), pid: view.owner.pid, windowId: view.owner.windowId };
      let conflict: BusyMark | undefined;
      let replaced: BusyMark | undefined;
      // Read before the lock: the mutator does no I/O.
      const updated = await registry.updateEnvironment(environmentId, (entry) => {
        if (entry.busy && !isOwnMark(entry.busy) && isBlockingBusyMark(entry.busy, view.owner, { now, isAlive: view.isAlive, windowStatuses })) {
          conflict = entry.busy;
          return;
        }
        replaced = entry.busy === undefined ? undefined : { ...entry.busy };
        entry.busy = mark;
      });
      if (updated === undefined) return undefined;
      if (conflict === undefined && replaced !== undefined) onReplaced?.(replaced);
      return conflict !== undefined ? { conflict } : { environment: updated };
    },
    async clear(environmentId) {
      await registry.updateEnvironment(environmentId, (entry) => {
        if (entry.busy && isOwnMark(entry.busy)) delete entry.busy;
      });
    },
  };
}
