// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Which window a Start connects (concept 6.2, 8; user request 2026-09-26): the current window or a new one. No `vscode`
// import, so the decision is unit-tested.

/**
 * What the command asked for: `default` is plain Start (and the switcher, Search, and "Open environment" of Delete),
 * which follows the setting openInNewWindow; `newWindow` is Start in New Window; `currentWindow` is Start in Current
 * Window, and also Switch branch… and Select configuration…, which change what this window shows.
 */
export type WindowRequest = 'default' | 'newWindow' | 'currentWindow';

export interface WindowChoiceInput {
  request: WindowRequest;
  /** The setting devEnvLauncher.openInNewWindow. */
  openInNewWindow: boolean;
  /** The window is local and has no folder and no workspace (`ConnectionAdapter.isEmptyWindow`). */
  emptyWindow: boolean;
  /**
   * The environment of this window lost its container, and Start connects this window again (Reconnect, concept 7.12).
   * A new window for the folder of this window would only show this window again.
   */
  reconnecting: boolean;
}

/**
 * True if the environment opens in a new window, and the current window keeps what it has.
 *
 * - Reconnect of this window's own environment: always this window.
 * - Start in New Window: always a new window, also from an empty window (the user asked for it).
 * - Start in Current Window: this window.
 * - Plain Start: a new window when the setting openInNewWindow is on, except in an empty window, which has nothing to
 *   keep (a new window would leave an empty window behind).
 */
export function opensNewWindow(input: WindowChoiceInput): boolean {
  if (input.reconnecting) return false;
  switch (input.request) {
    case 'newWindow':
      return true;
    case 'currentWindow':
      return false;
    case 'default':
      return input.openInNewWindow && !input.emptyWindow;
  }
}
