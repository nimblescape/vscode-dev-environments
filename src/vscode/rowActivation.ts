// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Double-click on a repository row runs Start (concept 6.2; user request 2026-09-27, "double-clicking a repo shall start
// the machine"). VS Code has no double-click event for tree views: it runs the command of a row (`TreeItem.command`) on
// each click, Enter, and Space while the setting `workbench.list.openMode` is `singleClick` (the default), and only on a
// double-click and Enter while it is `doubleClick`. No `vscode` import, so the rules are unit-tested.
import type { Clock } from '../core/ports';

/** Two activations of the same row within this time are a double-click. */
export const DOUBLE_CLICK_INTERVAL_MS = 500;

/** The values of the VS Code setting `workbench.list.openMode`. */
export type ListOpenMode = 'singleClick' | 'doubleClick';

/** A value of `workbench.list.openMode`; anything else is the default of VS Code, `singleClick`. */
export function normalizeListOpenMode(value: unknown): ListOpenMode {
  return value === 'doubleClick' ? 'doubleClick' : 'singleClick';
}

/**
 * The row of an activation: the argument of the row command is the RepositoryRow (treeView.ts). `canStart` is false when
 * the row shows no Start (its flag in RowActions). `undefined` for anything else.
 */
export function activatedRow(argument: unknown): { id: string; canStart: boolean } | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined;
  const row = argument as { kind?: unknown; id?: unknown; actions?: { canStart?: unknown } | null };
  if (row.kind !== 'repository' || typeof row.id !== 'string' || row.id === '') return undefined;
  return { id: row.id, canStart: row.actions?.canStart !== false };
}

/**
 * Tells a double-click from a single click. In `singleClick` mode a double-click arrives as two activations of the same
 * row; the second one within DOUBLE_CLICK_INTERVAL_MS completes the double-click, and the tracker starts over, so that a
 * triple-click starts once (its third click begins a new pair). Enter and Space arrive as one activation, so they only
 * select, as a single click does. In `doubleClick` mode VS Code already filters: every activation counts.
 */
export class RowActivationTracker {
  private last: { rowId: string; at: number } | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly intervalMs = DOUBLE_CLICK_INTERVAL_MS,
  ) {}

  /** Records an activation of the row `rowId`. True when it completes a double-click. */
  activate(rowId: string, openMode: ListOpenMode): boolean {
    if (openMode === 'doubleClick') {
      this.last = undefined;
      return true;
    }
    const now = this.clock.now();
    const last = this.last;
    // A clock that went back never makes a double-click.
    if (last && last.rowId === rowId && now >= last.at && now - last.at <= this.intervalMs) {
      this.last = undefined;
      return true;
    }
    this.last = { rowId, at: now };
    return false;
  }
}
