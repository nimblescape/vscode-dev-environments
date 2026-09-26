// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The editor of the setting `devEnvLauncher.repositoryGroups` (concept 6.2, 8): a webview panel, because the Settings
// editor of VS Code cannot edit a list of strings and objects. Thin glue: the checks, the preview, the value that Save
// writes, and the checks of the webview messages are in repositoryGroupsEditorModel.ts (no `vscode` import,
// unit-tested); the regular expressions of the draft run in a worker thread with a time limit (groupsPreviewRunner.ts).
// The webview is untrusted: every message is checked, and Save checks the entries again before it writes.
//
// Save writes only this one setting, as the user decided (A, 2026-09-26):
// > A. Only this setting is written. Save reads settings.json, replaces just the value of devEnvLauncher.repositoryGroups,
// > and leaves every other setting and comment untouched. If that one value was also changed in settings.json while the
// > editor was open, the editor shows it and asks: Load settings.json (your unsaved edits are dropped) or Save mine
// > (replaces that one value). No merging of individual entries.
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
  describeSettingList,
  editorHtml,
  editorState,
  entriesFromSetting,
  parseEditorRequest,
  sameSettingValue,
  toSettingValue,
  type EditorEntry,
  type EditorExternalMessage,
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
  /**
   * The setting value that the entries were loaded from (or that Save wrote last): Save writes without a question only
   * while settings.json still holds it.
   */
  base: unknown;
  /** The generation of the entries of the webview; an update or Save of another one is stale (edited from another value). */
  generation: number;
  /** The last generation handed out, for a load or an offer. */
  issued: number;
  /**
   * The values of settings.json offered to the webview (`external`) by generation. The base changes only when the
   * webview accepts one: until then, it may still hold keystrokes that the extension has not seen.
   */
  offers: Map<number, unknown>;
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
      issued: 0,
      offers: new Map(),
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
        if (event.affectsConfiguration(`${SETTINGS_SECTION}.${REPOSITORY_GROUPS_KEY}`)) this.onSettingChanged(session);
      }),
      this.deps.onDidRender(() => this.refresh(session)),
    ];
    panel.onDidDispose(() => {
      // Close or Cancel without Save: the draft is discarded.
      for (const listener of listeners) listener.dispose();
      if (this.session === session) this.session = undefined;
      // The worker of the preview is not needed until the editor opens again (the next run starts a new one).
      this.deps.previewRunner.dispose();
    });
  }

  dispose(): void {
    this.session?.panel.dispose();
    this.deps.previewRunner.dispose();
  }

  private async onMessage(session: EditorSession, raw: unknown): Promise<void> {
    const request = parseEditorRequest(raw, { generation: session.generation });
    if (!request) {
      this.deps.logger.warn('The repository groups editor sent a message that is not valid. It is ignored.');
      return;
    }
    switch (request.type) {
      case 'stale':
        // Edited from an earlier load (the generation does not change during Save, and the webview is read-only then).
        // Nothing is written; the entries become the draft again, with the current generation, and the status says so.
        if (session.saving) return;
        session.entries = request.entries;
        if (request.testName !== undefined) session.testName = request.testName;
        session.seq = Math.max(session.seq, request.seq);
        this.postLoad(session);
        this.refresh(session, GroupsEditorTexts.staleKept);
        return;
      case 'ready':
        this.postLoad(session);
        // A new page has no unsent edits: a changed value without edits is offered to it again.
        this.onSettingChanged(session);
        return;
      case 'accept':
        this.accept(session, request.generation);
        return;
      case 'update':
        // During Save, the draft stays as it was sent with Save (the webview is read-only then); the written value
        // replaces it afterwards.
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
        this.load(session, readSettingValue(), GroupsEditorTexts.loaded);
        return;
      case 'cancel':
        session.panel.dispose();
        return;
    }
  }

  /**
   * The setting changed (in settings.json, or by Save). A draft with edits stays, and the state shows the banner
   * "settings.json changed this setting" (changedOutside). A draft without edits here is offered the stored value
   * (`external`): the webview may still hold keystrokes that are not sent yet (the update waits 150 ms), so it decides.
   * It shows the value and answers `accept`, or keeps its draft, shows the banner, and sends the draft.
   */
  private onSettingChanged(session: EditorSession): void {
    if (this.session !== session) return;
    const stored = readSettingValue();
    if (session.saving || sameSettingValue(stored, session.base) || isEdited(session)) {
      this.refresh(session);
      return;
    }
    const generation = ++session.issued;
    session.offers.set(generation, stored);
    const { entries, notices } = entriesFromSetting(stored);
    const message: EditorExternalMessage = { type: 'external', generation, entries, notices };
    this.post(session, message);
  }

  /** The webview shows the offered value of `generation`: it is the new base. An offer that a load replaced is ignored. */
  private accept(session: EditorSession, generation: number): void {
    if (session.saving || !session.offers.has(generation)) return;
    const value = session.offers.get(generation);
    for (const offered of session.offers.keys()) if (offered <= generation) session.offers.delete(offered);
    const { entries, notices } = entriesFromSetting(value);
    session.base = value;
    session.generation = generation;
    session.loaded = entries;
    session.entries = entries;
    session.notices = notices;
    this.refresh(session);
  }

  /**
   * Save: checks the entries again (the webview is not trusted), also against the time limit on the names of the view
   * (a run of the worker that failed or was stopped saves nothing). Then it reads the stored value: while it is still
   * the base, it writes the draft. Otherwise (and for a stored value that is not a list) it asks: Load settings.json
   * (the draft is dropped and nothing is written), Save Mine (the draft replaces that value), or Cancel (nothing is
   * written, the draft stays). The value is read again after the question; when it changed during the question, Save
   * asks again with the new value. `update` of this one key changes only that key in settings.json; the other settings
   * and the comments stay. Afterwards the editor shows the written value (the new base). After a closed panel, nothing
   * is written.
   */
  private async save(session: EditorSession): Promise<void> {
    if (!canSave(checkEntries(session.entries))) {
      this.refresh(session, GroupsEditorTexts.invalidEntriesNotSaved);
      return;
    }
    session.saving = true;
    let status: string | undefined;
    let reload: { value: unknown } | undefined;
    const closed = () => this.session !== session;
    try {
      const run = await this.deps.previewRunner.run({
        entries: session.entries,
        testName: '',
        input: cloneableInput(this.deps.groupingInput()),
      });
      if (closed()) return;
      if (run.previewTooSlow) {
        status = GroupsEditorTexts.tooSlowNotSaved;
        return;
      }
      if (run.failed) {
        status = GroupsEditorTexts.previewFailed;
        return;
      }
      const mine = toSettingValue(session.entries);
      const value = mine.length > 0 ? mine : undefined;
      /** The stored value that the user answered Save Mine for; the draft may replace only that value. */
      let confirmed: { theirs: unknown } | undefined;
      for (;;) {
        const current = readSettingValue();
        const notAList = current !== undefined && current !== null && !Array.isArray(current);
        const unchanged = !notAList && sameSettingValue(current, session.base);
        if (unchanged || (confirmed && sameSettingValue(confirmed.theirs, current))) {
          // Nothing awaits between the read above and this write, so it replaces exactly the value that was checked.
          if (!sameSettingValue(value, current)) {
            await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(REPOSITORY_GROUPS_KEY, value, vscode.ConfigurationTarget.Global);
          }
          this.deps.logger.info(`The setting devEnvLauncher.repositoryGroups was saved with ${mine.length} entries.`);
          reload = { value };
          status = unchanged ? GroupsEditorTexts.saved : GroupsEditorTexts.savedReplaced;
          return;
        }
        if (sameSettingValue(value, current)) {
          // settings.json already holds the draft: nothing to write and nothing to ask; it is the new base.
          this.deps.logger.info('The setting devEnvLauncher.repositoryGroups already held the entries of the editor.');
          reload = { value: current };
          status = GroupsEditorTexts.alreadySaved;
          return;
        }
        const changed = !sameSettingValue(current, session.base);
        const answer = await vscode.window.showWarningMessage(
          changed ? GroupsEditorTexts.changedMeanwhile : GroupsEditorTexts.notAListConflict,
          {
            modal: true,
            detail: notAList
              ? GroupsEditorTexts.notAListDetail(describeSettingEntry(current))
              : GroupsEditorTexts.changedMeanwhileDetail(describeSettingList(current)),
          },
          GroupsEditorTexts.loadTheirs,
          GroupsEditorTexts.saveMine,
        );
        if (closed()) return;
        if (answer === GroupsEditorTexts.loadTheirs) {
          reload = { value: readSettingValue() };
          status = GroupsEditorTexts.loadedTheirs;
          return;
        }
        if (answer !== GroupsEditorTexts.saveMine) {
          status = GroupsEditorTexts.saveCancelled;
          return;
        }
        // Save Mine counts for the value that the question showed; the loop reads it again and asks again if it changed.
        confirmed = { theirs: current };
      }
    } catch (error) {
      this.deps.logger.error('The setting devEnvLauncher.repositoryGroups could not be saved.', error);
      void vscode.window.showErrorMessage(`The repository groups could not be saved: ${errorMessage(error)}`);
    } finally {
      session.saving = false;
      if (reload) this.load(session, reload.value, status);
      else this.refresh(session, status);
    }
  }

  /** Shows `value` in the editor as the new base; the draft is replaced. */
  private load(session: EditorSession, value: unknown, status?: string): void {
    const { entries, notices } = entriesFromSetting(value);
    session.base = value;
    session.generation = ++session.issued;
    session.offers.clear();
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
    // The panel was closed meanwhile: the runner was disposed, so the run failed on purpose, and nobody sees the state.
    if (this.session !== session) return;
    if (run.failed) this.deps.logger.warn('The preview of the repository groups could not be made in its worker thread.');
    const status =
      session.status ??
      (run.previewTooSlow ? GroupsEditorTexts.previewTooSlow : run.failed ? GroupsEditorTexts.previewFailed : undefined);
    session.status = undefined;
    const message: EditorStateMessage = editorState({
      seq,
      entries,
      loaded: session.loaded,
      run,
      changedOutside: !sameSettingValue(readSettingValue(), session.base),
      saving: session.saving,
      ...(status !== undefined ? { status } : {}),
    });
    this.post(session, message);
  }

  private post(session: EditorSession, message: EditorLoadMessage | EditorExternalMessage | EditorStateMessage): void {
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

/** The draft differs from the entries as loaded (the webview shows it as not saved). */
function isEdited(session: EditorSession): boolean {
  return !sameSettingValue(toSettingValue(session.entries), toSettingValue(session.loaded));
}
