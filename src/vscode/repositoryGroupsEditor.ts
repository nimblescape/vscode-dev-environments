// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The editor of the setting `devEnvLauncher.repositoryGroups` (concept 6.2, 8): a webview panel, because the Settings
// editor of VS Code cannot edit a list of strings and objects. Thin glue: the checks, the preview, the merge at Save,
// and the checks of the webview messages are in repositoryGroupsEditorModel.ts (no `vscode` import, unit-tested).
// The webview is untrusted: every message is checked, and Save checks the entries again before it writes.
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';
import {
  GroupsEditorTexts,
  describeSettingEntry,
  checkEntries,
  canSave,
  editorHtml,
  editorState,
  entriesFromSetting,
  mergeRepositoryGroups,
  parseEditorRequest,
  sameSettingValue,
  type ConflictChoice,
  type EditorEntry,
  type EditorLoadMessage,
  type EditorStateMessage,
} from './repositoryGroupsEditorModel';
import { SETTINGS_SECTION } from './settings';
import { SLOW_GROUPING_MS } from './sidebar';
import type { TreeInput } from './treeModel';

const REPOSITORY_GROUPS_KEY = 'repositoryGroups';
const VIEW_TYPE = 'devEnvironments.repositoryGroupsEditor';
/** Folder of the style sheet and the script of the webview (package: resources/**). */
const ASSETS = ['resources', 'groupsEditor'];

export interface RepositoryGroupsEditorDeps {
  extensionUri: vscode.Uri;
  logger: Logger;
  /** The input of the last render of the sidebar (Sidebar.groupingInput): the preview asks GitHub nothing. */
  groupingInput: () => TreeInput | undefined;
  /** Fires after each render of the sidebar, so the preview follows the view. */
  onDidRender: vscode.Event<void>;
}

/** The session of one open panel. */
interface EditorSession {
  panel: vscode.WebviewPanel;
  /** The setting value that the entries were loaded from: the base of the merge at Save. */
  base: unknown;
  /** The entries as loaded (for `dirty`). */
  loaded: EditorEntry[];
  notices: string[];
  /** The entries of the webview (the draft); kept here, so a hidden and shown webview gets them back. */
  entries: EditorEntry[];
  testName: string;
  seq: number;
  saving: boolean;
}

export class RepositoryGroupsEditor implements vscode.Disposable {
  private session: EditorSession | undefined;

  constructor(private readonly deps: RepositoryGroupsEditorDeps) {}

  /** Opens the editor, or shows the one that is open. */
  async open(): Promise<void> {
    if (this.session) {
      this.session.panel.reveal();
      return;
    }
    const assets = vscode.Uri.joinPath(this.deps.extensionUri, ...ASSETS);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, GroupsEditorTexts.panelTitle, vscode.ViewColumn.Active, {
      enableScripts: true,
      enableCommandUris: false,
      enableForms: false,
      localResourceRoots: [assets],
    });
    const base = readSettingValue();
    const { entries, notices } = entriesFromSetting(base);
    const session: EditorSession = { panel, base, loaded: entries, notices, entries, testName: '', seq: 0, saving: false };
    this.session = session;
    const webview = panel.webview;
    webview.html = editorHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString('base64'),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(assets, 'editor.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(assets, 'editor.css')).toString(),
    });
    const listeners = [
      webview.onDidReceiveMessage((raw: unknown) => {
        this.onMessage(session, raw).catch((error: unknown) => this.deps.logger.error('The repository groups editor failed.', error));
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${SETTINGS_SECTION}.${REPOSITORY_GROUPS_KEY}`)) this.postState(session);
      }),
      this.deps.onDidRender(() => this.postState(session)),
    ];
    panel.onDidDispose(() => {
      // Close or Cancel without Save: the draft is discarded.
      for (const listener of listeners) listener.dispose();
      if (this.session === session) this.session = undefined;
    });
  }

  dispose(): void {
    this.session?.panel.dispose();
  }

  private async onMessage(session: EditorSession, raw: unknown): Promise<void> {
    const request = parseEditorRequest(raw, { baseLength: Array.isArray(session.base) ? session.base.length : 0 });
    if (!request) {
      this.deps.logger.warn('The repository groups editor sent a message that is not valid. It is ignored.');
      return;
    }
    switch (request.type) {
      case 'ready':
        this.postLoad(session);
        this.postState(session);
        return;
      case 'update':
        session.entries = request.entries;
        session.testName = request.testName;
        session.seq = Math.max(session.seq, request.seq);
        this.postState(session);
        return;
      case 'save':
        session.entries = request.entries;
        session.seq = Math.max(session.seq, request.seq);
        await this.save(session);
        return;
      case 'reload':
        this.load(session, readSettingValue());
        return;
      case 'cancel':
        session.panel.dispose();
        return;
    }
  }

  /**
   * Save: checks the entries again (the webview is not trusted), then merges the changes of the editor into the value
   * stored now (mergeRepositoryGroups), asks only about entries changed differently on both sides, and writes the key in
   * the user settings. `update` of one key changes only that key in settings.json; the other settings and the comments
   * stay. Afterwards the editor shows the written value (the new base).
   */
  private async save(session: EditorSession): Promise<void> {
    if (session.saving) return;
    if (!canSave(checkEntries(session.entries))) {
      this.postState(session, GroupsEditorTexts.invalidEntriesNotSaved);
      return;
    }
    session.saving = true;
    try {
      const choices = new Map<number, ConflictChoice>();
      for (;;) {
        const current = readSettingValue();
        const outcome = mergeRepositoryGroups(session.base, session.entries, current, choices);
        if (outcome.status === 'conflicts') {
          const open = outcome.conflicts.find((conflict) => !choices.has(conflict.baseIndex));
          if (!open) break;
          const answer = await vscode.window.showWarningMessage(
            GroupsEditorTexts.conflict(open.baseIndex + 1),
            {
              modal: true,
              detail: GroupsEditorTexts.conflictDetail(
                describeSettingEntry(open.base),
                describeSettingEntry(open.mine),
                describeSettingEntry(open.theirs),
              ),
            },
            GroupsEditorTexts.keepMine,
            GroupsEditorTexts.keepTheirs,
          );
          if (answer === undefined) {
            this.postState(session, GroupsEditorTexts.saveCancelled);
            return;
          }
          choices.set(open.baseIndex, answer === GroupsEditorTexts.keepMine ? 'mine' : 'theirs');
          continue;
        }
        const merged = outcome.value;
        const changedMeanwhile = !sameSettingValue(current, session.base);
        if (!sameSettingValue(merged, current)) {
          await vscode.workspace
            .getConfiguration(SETTINGS_SECTION)
            .update(REPOSITORY_GROUPS_KEY, merged.length > 0 ? merged : undefined, vscode.ConfigurationTarget.Global);
        }
        this.deps.logger.info(`The setting devEnvLauncher.repositoryGroups was saved with ${merged.length} entries.`);
        this.load(session, merged.length > 0 ? merged : undefined, changedMeanwhile ? GroupsEditorTexts.savedMerged : GroupsEditorTexts.saved);
        return;
      }
    } catch (error) {
      this.deps.logger.error('The setting devEnvLauncher.repositoryGroups could not be saved.', error);
      void vscode.window.showErrorMessage(`The repository groups could not be saved: ${errorMessage(error)}`);
    } finally {
      session.saving = false;
    }
  }

  /** Shows `value` in the editor as the new base; the draft is replaced. */
  private load(session: EditorSession, value: unknown, status?: string): void {
    const { entries, notices } = entriesFromSetting(value);
    session.base = value;
    session.loaded = entries;
    session.entries = entries;
    session.notices = notices;
    this.postLoad(session);
    this.postState(session, status);
  }

  private postLoad(session: EditorSession): void {
    const message: EditorLoadMessage = { type: 'load', entries: session.entries, notices: session.notices };
    this.post(session, message);
  }

  private postState(session: EditorSession, status?: string): void {
    if (this.session !== session) return;
    const started = Date.now();
    const message: EditorStateMessage = editorState({
      seq: session.seq,
      entries: session.entries,
      loaded: session.loaded,
      testName: session.testName,
      input: this.deps.groupingInput(),
      changedOutside: !sameSettingValue(readSettingValue(), session.base),
      ...(status !== undefined ? { status } : {}),
    });
    // The patterns run in the extension host, as in the sidebar: a slow one is named at once.
    const elapsed = Date.now() - started;
    if (elapsed >= SLOW_GROUPING_MS && message.status === undefined) message.status = GroupsEditorTexts.slow(elapsed);
    this.post(session, message);
  }

  private post(session: EditorSession, message: EditorLoadMessage | EditorStateMessage): void {
    session.panel.webview.postMessage(message).then(undefined, (error: unknown) => {
      this.deps.logger.warn(`The repository groups editor could not be updated: ${errorMessage(error)}`);
    });
  }
}

/** The value in the user settings (scope `application`: no other value counts). */
function readSettingValue(): unknown {
  return vscode.workspace.getConfiguration(SETTINGS_SECTION).inspect<unknown>(REPOSITORY_GROUPS_KEY)?.globalValue;
}
