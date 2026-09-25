// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Test double of the part of the `vscode` API that the UI components use. Tests replace the module with
// `vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode)` and script the answers.
import { vi } from 'vitest';

export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => void>();

  readonly event = (listener: (event: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  accessibilityInformation?: unknown;

  constructor(
    readonly label: string,
    readonly collapsibleState?: number,
  ) {}
}

export const Uri = { parse: (value: string) => ({ scheme: value.split(':')[0], toString: () => value }) };

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const QuickPickItemKind = { Separator: -1, Default: 0 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export interface FakeStatusBarItem {
  id: string;
  alignment: number;
  priority: number;
  name?: string;
  text: string;
  tooltip?: string;
  command?: unknown;
  backgroundColor?: ThemeColor;
  visible: boolean;
  disposed: boolean;
  show(): void;
  dispose(): void;
}

export interface FakeOutputChannel {
  name: string;
  text: string;
  shown: number;
  disposed: boolean;
  append(value: string): void;
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

const sessionChanges = new EventEmitter<{ provider: { id: string; label: string } }>();

export const fakeVscode = {
  EventEmitter,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  Uri,
  ProgressLocation,
  StatusBarAlignment,
  TreeItemCollapsibleState,
  QuickPickItemKind,
  ConfigurationTarget,
  window: {
    createOutputChannel: vi.fn(),
    createStatusBarItem: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    createQuickPick: vi.fn(),
    withProgress: vi.fn(),
  },
  env: { openExternal: vi.fn() },
  commands: { executeCommand: vi.fn(), registerCommand: vi.fn() },
  workspace: { getConfiguration: vi.fn() },
  authentication: {
    getSession: vi.fn(),
    onDidChangeSessions: sessionChanges.event,
  },
  /** Test helper: fires `authentication.onDidChangeSessions`. */
  fireSessionChange(providerId: string): void {
    sessionChanges.fire({ provider: { id: providerId, label: providerId } });
  },
  statusBarItems: [] as FakeStatusBarItem[],
  outputChannels: [] as FakeOutputChannel[],
};

/** Restores the default behavior of every fake: messages are dismissed, quick picks cancelled. */
export function resetFakeVscode(): void {
  const { window } = fakeVscode;
  fakeVscode.statusBarItems.length = 0;
  fakeVscode.outputChannels.length = 0;
  for (const mock of [
    ...Object.values(window),
    fakeVscode.env.openExternal,
    fakeVscode.commands.executeCommand,
    fakeVscode.commands.registerCommand,
    fakeVscode.workspace.getConfiguration,
    fakeVscode.authentication.getSession,
  ]) {
    mock.mockReset();
  }
  window.showInformationMessage.mockResolvedValue(undefined);
  window.showWarningMessage.mockResolvedValue(undefined);
  window.showErrorMessage.mockResolvedValue(undefined);
  window.showQuickPick.mockResolvedValue(undefined);
  fakeVscode.env.openExternal.mockResolvedValue(true);
  fakeVscode.commands.executeCommand.mockResolvedValue(undefined);
  fakeVscode.commands.registerCommand.mockImplementation(() => ({ dispose() {} }));
  fakeVscode.authentication.getSession.mockResolvedValue(undefined);
  window.createOutputChannel.mockImplementation((name: string) => {
    const channel: FakeOutputChannel = {
      name,
      text: '',
      shown: 0,
      disposed: false,
      append(value) {
        channel.text += value;
      },
      appendLine(value) {
        channel.text += `${value}\n`;
      },
      show() {
        channel.shown++;
      },
      dispose() {
        channel.disposed = true;
      },
    };
    fakeVscode.outputChannels.push(channel);
    return channel;
  });
  window.createStatusBarItem.mockImplementation((id: string, alignment: number, priority: number) => {
    const item: FakeStatusBarItem = {
      id,
      alignment,
      priority,
      text: '',
      visible: false,
      disposed: false,
      show() {
        item.visible = true;
      },
      dispose() {
        item.disposed = true;
      },
    };
    fakeVscode.statusBarItems.push(item);
    return item;
  });
}

resetFakeVscode();
