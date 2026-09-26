// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The editor of the setting `devEnvLauncher.repositoryGroups` (concept 6.2, 8): a webview panel, because the Settings
// editor of VS Code cannot edit a list of strings and objects. Thin glue: the checks, the preview, the merge at Save,
// and the checks of the webview messages are in repositoryGroupsEditorModel.ts (no `vscode` import, unit-tested); the
// regular expressions of the draft run in a worker thread with a time limit (groupsPreviewRunner.ts).
// The webview is untrusted: every message is checked, and Save checks the entries again before it writes.
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';
import type { PreviewRunner } from './groupsPreviewRunner';
import {
  GroupsEditorTexts,
  canSave,
  checkEntries,
  cloneableInput,
  describeSettingEntry,
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
  /** Runs the regular expressions of the draft outside the extension host, with a time limit. */
  previewRunner: PreviewRunner;
}

/** The session of one open panel. */
interface EditorSession {
  panel: vscode.WebviewPanel;
  /** The setting value that the entries were loaded from: the base of the merge at Save. */
  base: unknown;
  /** Counts the loads; updates and Saves of another load are ignored (their origins name another base). */
  generation: number;
  /** The entries as loaded (for `dirty`). */
  loaded: EditorEntry[];
  notices: string[];
  /** The entries of the webview (the draft); kept here, so a hidden and shown webview gets them back. */
  entries: EditorEntry[];
  testName: string;
  seq: number;
  saving: boolean;
  /** A state is being computed; `again`: compute once more afterwards. */
  computing: boolean;
  again: boolean;
  /** Text for the status line of the next state. */
  status?: string;
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
    const session: EditorSession = {
      panel,
      base,
      generation: 0,
      loaded: entries,
      notices,
      entries,
      testName: '',
      seq: 0,
      saving: false,
      computing: false,
      again: false,
    };
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
        if (event.affectsConfiguration(`${SETTINGS_SECTION}.${REPOSITORY_GROUPS_KEY}`)) this.refresh(session);
      }),
      this.deps.onDidRender(() => this.refresh(session)),
    ];
    panel.onDidDispose(() => {
      // Close or Cancel without Save: the draft is discarded.
      for (const listener of listeners) listener.dispose();
      if (this.session === session) this.session = undefined;
    });
  }

  dispose(): void {
    this.session?.panel.dispose();
    this.deps.previewRunner.dispose();
  }

  private async onMessage(session: EditorSession, raw: unknown): Promise<void> {
    const request = parseEditorRequest(raw, {
      baseLength: Array.isArray(session.base) ? session.base.length : 0,
      generation: session.generation,
    });
    if (!request) {
      this.deps.logger.warn('The repository groups editor sent a message that is not valid. It is ignored.');
      return;
    }
    switch (request.type) {
      case 'stale':
        return;
      case 'ready':
        this.postLoad(session);
        this.refresh(session);
        return;
      case 'update':
        // During Save, the draft stays as it was sent with Save; the written value replaces it afterwards.
        if (session.saving) return;
        session.entries = request.entries;
        session.testName = request.testName;
        session.seq = Math.max(session.seq, request.seq);
        this.refresh(session);
        return;
      case 'save':
        if (session.saving) return;
        session.entries = request.entries;
        session.seq = Math.max(session.seq, request.seq);
        await this.save(session);
        return;
      case 'reload':
        if (session.saving) return;
        this.load(session, readSettingValue());
        return;
      case 'cancel':
        session.panel.dispose();
        return;
    }
  }

  /**
   * Save: checks the entries again (the webview is not trusted), also against the time limit on the names of the view,
   * then merges the changes of the editor into the value stored now (mergeRepositoryGroups), asks only about entries
   * changed differently on both sides (and once about the order when both sides moved entries differently), and writes
   * the key in the user settings. `update` of one key changes only that key in settings.json; the other settings and the
   * comments stay. Afterwards the editor shows the written value (the new base).
   */
  private async save(session: EditorSession): Promise<void> {
    if (!canSave(checkEntries(session.entries))) {
      this.refresh(session, GroupsEditorTexts.invalidEntriesNotSaved);
      return;
    }
    session.saving = true;
    let status: string | undefined;
    let written: { value: unknown } | undefined;
    try {
      const run = await this.deps.previewRunner.run({
        entries: session.entries,
        testName: '',
        input: cloneableInput(this.deps.groupingInput()),
      });
      if (run.previewTooSlow) {
        status = GroupsEditorTexts.tooSlowNotSaved;
        return;
      }
      const entries = new Map<number, ConflictChoice>();
      let order: ConflictChoice | undefined;
      for (;;) {
        const current = readSettingValue();
        const outcome = mergeRepositoryGroups(session.base, session.entries, current, { entries, ...(order ? { order } : {}) });
        if (outcome.status === 'conflicts') {
          const [open] = outcome.conflicts;
          const answer = open
            ? await vscode.window.showWarningMessage(
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
              )
            : await vscode.window.showWarningMessage(
                GroupsEditorTexts.orderConflict,
                { modal: true, detail: GroupsEditorTexts.orderConflictDetail },
                GroupsEditorTexts.keepMine,
                GroupsEditorTexts.keepTheirs,
              );
          if (answer === undefined) {
            status = GroupsEditorTexts.saveCancelled;
            return;
          }
          const choice: ConflictChoice = answer === GroupsEditorTexts.keepMine ? 'mine' : 'theirs';
          if (open) entries.set(open.baseIndex, choice);
          else order = choice;
          continue;
        }
        const merged = outcome.value;
        const changedMeanwhile = !sameSettingValue(current, session.base);
        const value = merged.length > 0 ? merged : undefined;
        if (!sameSettingValue(merged, current)) {
          await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(REPOSITORY_GROUPS_KEY, value, vscode.ConfigurationTarget.Global);
        }
        this.deps.logger.info(`The setting devEnvLauncher.repositoryGroups was saved with ${merged.length} entries.`);
        written = { value };
        status = changedMeanwhile ? GroupsEditorTexts.savedMerged : GroupsEditorTexts.saved;
        return;
      }
    } catch (error) {
      this.deps.logger.error('The setting devEnvLauncher.repositoryGroups could not be saved.', error);
      void vscode.window.showErrorMessage(`The repository groups could not be saved: ${errorMessage(error)}`);
    } finally {
      session.saving = false;
      if (written) this.load(session, written.value, status);
      else this.refresh(session, status);
    }
  }

  /** Shows `value` in the editor as the new base; the draft is replaced. */
  private load(session: EditorSession, value: unknown, status?: string): void {
    const { entries, notices } = entriesFromSetting(value);
    session.base = value;
    session.generation += 1;
    session.loaded = entries;
    session.entries = entries;
    session.notices = notices;
    this.postLoad(session);
    this.refresh(session, status);
  }

  private postLoad(session: EditorSession): void {
    const message: EditorLoadMessage = {
      type: 'load',
      generation: session.generation,
      entries: session.entries,
      notices: session.notices,
      testName: session.testName,
    };
    this.post(session, message);
  }

  /**
   * Computes the state of the draft (the preview runs in the worker) and sends it; one computation at a time, and a
   * request during one computes again afterwards with the draft of then.
   */
  private refresh(session: EditorSession, status?: string): void {
    if (status !== undefined) session.status = status;
    if (session.computing) {
      session.again = true;
      return;
    }
    session.computing = true;
    const loop = async () => {
      do {
        session.again = false;
        await this.computeState(session);
      } while (session.again && this.session === session);
    };
    loop()
      .catch((error: unknown) => this.deps.logger.error('The preview of the repository groups could not be made.', error))
      .finally(() => {
        session.computing = false;
      });
  }

  private async computeState(session: EditorSession): Promise<void> {
    if (this.session !== session) return;
    const seq = session.seq;
    const entries = session.entries;
    const run = await this.deps.previewRunner.run({
      entries,
      testName: session.testName,
      input: cloneableInput(this.deps.groupingInput()),
    });
    if (run.failed) this.deps.logger.warn('The preview of the repository groups could not be made in its worker thread.');
    const status = session.status ?? (run.previewTooSlow ? GroupsEditorTexts.previewTooSlow : undefined);
    session.status = undefined;
    const message: EditorStateMessage = editorState({
      seq,
      entries,
      loaded: session.loaded,
      run,
      changedOutside: !sameSettingValue(readSettingValue(), session.base),
      ...(status !== undefined ? { status } : {}),
    });
    this.post(session, message);
  }

  private post(session: EditorSession, message: EditorLoadMessage | EditorStateMessage): void {
    if (this.session !== session) return;
    session.panel.webview.postMessage(message).then(undefined, (error: unknown) => {
      this.deps.logger.warn(`The repository groups editor could not be updated: ${errorMessage(error)}`);
    });
  }
}

/** The value in the user settings (scope `application`: no other value counts). */
function readSettingValue(): unknown {
  return vscode.workspace.getConfiguration(SETTINGS_SECTION).inspect<unknown>(REPOSITORY_GROUPS_KEY)?.globalValue;
}
