// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Connection Adapter (concept 7.2, 7.8; implementation notes 11): connects the window to a running container through the
// Dev Containers extension, and finds out which container the window uses. The URI format lives in connection/authority.ts
// (the literal ATTACHED_CONTAINER in core/devContainers.ts, NFR-06); the command IDs of VS Code for this live here.
import * as vscode from 'vscode';
import { ATTACHED_CONTAINER } from '../core/devContainers';
import { silentLogger, type Logger } from '../core/ports';
import { containerNameOfUri, folderUriParts, REMOTE_SCHEME } from './connection/authority';

/** Opens a folder or workspace URI (built-in command of VS Code). */
export const OPEN_FOLDER_COMMAND = 'vscode.openFolder';
/** "Close Remote Connection" (implementation notes 11). */
export const CLOSE_REMOTE_COMMAND = 'workbench.action.remote.close';
/** "Developer: Reload Window". */
export const RELOAD_WINDOW_COMMAND = 'workbench.action.reloadWindow';

export class ConnectionAdapter {
  constructor(private readonly logger: Logger = silentLogger) {}

  /**
   * Container name (without the leading `/`) of this window, or `undefined` when the window is not attached to a
   * container. The name comes from the authority of the workspace file or of the first workspace folder. A window of
   * another remote type (`vscode.env.remoteName` set to something else) never has one.
   */
  currentContainerName(): string | undefined {
    const remoteName = vscode.env.remoteName;
    if (remoteName !== undefined && remoteName !== ATTACHED_CONTAINER) return undefined;
    const candidates: vscode.Uri[] = [];
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile) candidates.push(workspaceFile);
    const firstFolder = vscode.workspace.workspaceFolders?.[0];
    if (firstFolder) candidates.push(firstFolder.uri);
    for (const uri of candidates) {
      const name = containerNameOfUri(uri);
      if (name) return name;
    }
    return undefined;
  }

  /**
   * True for an empty local window: no remote, no folder, and no workspace (concept 7.10 #2, 7.14 step 3). A window of
   * a remote (SSH, WSL, a tunnel, an attached container) without a folder is not empty: the user opened it for that
   * remote, so the reopen rule and the pending operations do not take it over.
   */
  isEmptyWindow(): boolean {
    return (
      vscode.env.remoteName === undefined &&
      !vscode.workspace.workspaceFile &&
      (vscode.workspace.workspaceFolders?.length ?? 0) === 0
    );
  }

  /**
   * Connects this window to the running container: `vscode.openFolder` with the folder URI in the current window. VS Code
   * reloads the window; the returned promise may not settle before that.
   *
   * `forceReuseWindow` is set in addition to `forceNewWindow: false`, because without it the user setting
   * `window.openFoldersInNewWindow: "on"` would open a new window (concept 6.2: Start never opens a new window).
   *
   * When this window has exactly this folder open already (Reconnect after the connection was lost, concept 7.12),
   * `vscode.openFolder` would only focus the window, so the window is reloaded instead: the reload connects again.
   */
  async open(containerName: string, remoteWorkspaceFolder: string): Promise<void> {
    const parts = folderUriParts(containerName, remoteWorkspaceFolder);
    if (this.hasFolderOpen(parts)) {
      this.logger.info(`Reloading the window to connect it to ${containerName} again.`);
      await vscode.commands.executeCommand(RELOAD_WINDOW_COMMAND);
      return;
    }
    // Assumption (V-2): the Dev Containers extension attaches to the container of this URI without a prompt, and VS Code
    // shows an existing window instead when another window has the same folder open (concept 7.11).
    const uri = vscode.Uri.from(parts);
    this.logger.info(`Connecting the window to ${containerName} (${uri.toString()}).`);
    await vscode.commands.executeCommand(OPEN_FOLDER_COMMAND, uri, { forceNewWindow: false, forceReuseWindow: true });
  }

  /** "Close Remote Connection": the window becomes an empty local window, and the extension activates again in it. */
  async closeRemoteConnection(): Promise<void> {
    this.logger.info('Closing the remote connection of this window.');
    await vscode.commands.executeCommand(CLOSE_REMOTE_COMMAND);
  }

  /** The window shows exactly this folder of this container (a folder window, not a workspace). */
  private hasFolderOpen(target: { authority: string; path: string }): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (vscode.workspace.workspaceFile || folders?.length !== 1) return false;
    const current = folders[0].uri;
    const currentName = containerNameOfUri(current);
    return (
      currentName !== undefined &&
      currentName === containerNameOfUri({ scheme: REMOTE_SCHEME, authority: target.authority }) &&
      withoutTrailingSlash(current.path) === withoutTrailingSlash(target.path)
    );
  }
}

function withoutTrailingSlash(folder: string): string {
  return folder.replace(/\/+$/, '') || '/';
}
