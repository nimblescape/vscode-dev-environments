// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Status bar item (concept 6.3): one item on the left side.
import * as vscode from 'vscode';
import { Actions } from '../core/messages';
import { SHOW_LOG_COMMAND } from './progress';

export const STATUS_BAR_ITEM_ID = 'devEnvironments.status';
const SWITCH_ENVIRONMENT_COMMAND = 'devEnvironments.switchEnvironment';
const START_COMMAND = 'devEnvironments.start';
// Left side, next to the remote indicator of VS Code.
const PRIORITY = 1000;

// User-visible texts that messages.ts lacks; to be moved there. The item texts are those of concept 6.3.
export const StatusBarTexts = {
  name: 'Dev Environments',
  openEnvironment: 'Open environment…',
  updating: (repository: string) => `Updating ${repository}…`,
  reconnect: (repository: string) => `Reconnect ${repository}`,
  connectedTooltip: (repository: string) => `Connected to ${repository}. Select to switch the environment.`,
  notConnectedTooltip: 'Select to open an environment in this window.',
  connectionLostTooltip: (repository: string) => `The connection to ${repository} was lost. Select to reconnect.`,
} as const;

type BaseState =
  | { kind: 'connected'; repository: string; branch?: string }
  | { kind: 'notConnected' }
  | { kind: 'connectionLost'; repository: string; environmentId: string };

/**
 * Shows the connected, not connected, or connection lost state. `showBusy` puts "Updating …" over this state until
 * `clearBusy`; the other methods change the state below it, so the order of calls does not matter.
 */
export class EnvironmentStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private base: BaseState = { kind: 'notConnected' };
  private busyRepository: string | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(STATUS_BAR_ITEM_ID, vscode.StatusBarAlignment.Left, PRIORITY);
    this.item.name = StatusBarTexts.name;
    this.render();
    this.item.show();
  }

  /** `$(vm) owner/name · branch`; select → switcher. */
  showConnected(repository: string, branch: string | undefined): void {
    this.base = { kind: 'connected', repository, branch: branch?.trim() || undefined };
    this.render();
  }

  /** `$(vm) Open environment…`; select → switcher. */
  showNotConnected(): void {
    this.base = { kind: 'notConnected' };
    this.render();
  }

  /** `$(sync~spin) Updating owner/name…`; select → log with the progress details. */
  showBusy(repository: string): void {
    this.busyRepository = repository;
    this.render();
  }

  /** Removes the busy state and shows the state below it again. */
  clearBusy(): void {
    this.busyRepository = undefined;
    this.render();
  }

  /** `$(warning) Reconnect owner/name`; select → `devEnvironments.start` with `{ environmentId }` (open pipeline). */
  showConnectionLost(repository: string, environmentId: string): void {
    this.base = { kind: 'connectionLost', repository, environmentId };
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    const item = this.item;
    item.backgroundColor = undefined;
    if (this.busyRepository !== undefined) {
      item.text = `$(sync~spin) ${StatusBarTexts.updating(this.busyRepository)}`;
      item.tooltip = Actions.showDetails;
      item.command = SHOW_LOG_COMMAND;
      return;
    }
    const state = this.base;
    switch (state.kind) {
      case 'connected':
        item.text = state.branch ? `$(vm) ${state.repository} · ${state.branch}` : `$(vm) ${state.repository}`;
        item.tooltip = StatusBarTexts.connectedTooltip(state.repository);
        item.command = SWITCH_ENVIRONMENT_COMMAND;
        return;
      case 'notConnected':
        item.text = `$(vm) ${StatusBarTexts.openEnvironment}`;
        item.tooltip = StatusBarTexts.notConnectedTooltip;
        item.command = SWITCH_ENVIRONMENT_COMMAND;
        return;
      case 'connectionLost':
        item.text = `$(warning) ${StatusBarTexts.reconnect(state.repository)}`;
        item.tooltip = StatusBarTexts.connectionLostTooltip(state.repository);
        item.command = {
          command: START_COMMAND,
          title: StatusBarTexts.reconnect(state.repository),
          arguments: [{ environmentId: state.environmentId }],
        };
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        return;
    }
  }
}
