// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePanel {
  webview: {
    html: string;
    cspSource: string;
    options?: unknown;
    asWebviewUri: (uri: { toString(): string }) => { toString(): string };
    postMessage: ReturnType<typeof vi.fn>;
    onDidReceiveMessage: (listener: (message: unknown) => void) => { dispose(): void };
  };
  options: unknown;
  reveal: ReturnType<typeof vi.fn>;
  dispose: () => void;
  onDidDispose: (listener: () => void) => { dispose(): void };
  receive: (message: unknown) => void;
  posted: Array<{ type: string; [key: string]: unknown }>;
  disposed: boolean;
}

const hoisted = vi.hoisted(() => ({
  panels: [] as unknown[],
  stored: { value: undefined as unknown },
  configurationListeners: [] as Array<(event: { affectsConfiguration(key: string): boolean }) => void>,
}));

vi.mock('vscode', async () => {
  const { fakeVscode } = await import('./testing/fakeVscode');
  const createWebviewPanel = (_viewType: string, _title: string, _column: number, options: unknown) => {
    const messageListeners: Array<(message: unknown) => void> = [];
    const disposeListeners: Array<() => void> = [];
    const panel: FakePanel = {
      webview: {
        html: '',
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri) => ({ toString: () => `webview:${uri.toString()}` }),
        postMessage: vi.fn(async (message: { type: string }) => {
          panel.posted.push(message);
          return true;
        }),
        onDidReceiveMessage: (listener) => {
          messageListeners.push(listener);
          return { dispose() {} };
        },
      },
      options,
      reveal: vi.fn(),
      dispose: () => {
        if (panel.disposed) return;
        panel.disposed = true;
        for (const listener of disposeListeners) listener();
      },
      onDidDispose: (listener) => {
        disposeListeners.push(listener);
        return { dispose() {} };
      },
      receive: (message) => {
        for (const listener of messageListeners) listener(message);
      },
      posted: [],
      disposed: false,
    };
    hoisted.panels.push(panel);
    return panel;
  };
  return {
    ...fakeVscode,
    ViewColumn: { Active: -1 },
    Uri: { ...fakeVscode.Uri, joinPath: (base: { toString(): string }, ...parts: string[]) => ({ toString: () => [base.toString(), ...parts].join('/') }) },
    window: { ...fakeVscode.window, createWebviewPanel },
    workspace: {
      ...fakeVscode.workspace,
      onDidChangeConfiguration: (listener: (event: { affectsConfiguration(key: string): boolean }) => void) => {
        hoisted.configurationListeners.push(listener);
        return { dispose() {} };
      },
    },
  };
});

import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import { RepositoryGroupsEditor } from './repositoryGroupsEditor';
import type { PreviewRunner } from './groupsPreviewRunner';
import { GroupsEditorTexts, describeSettingList, runPreviewJob, type PreviewJobMessage, type PreviewRun } from './repositoryGroupsEditorModel';
import { SETTINGS_SECTION } from './settings';

/** Runs the job in this thread, as the worker does; `next` replaces the result of the next job. */
function inlineRunner(): PreviewRunner & { next: PreviewRun | undefined; run: ReturnType<typeof vi.fn> } {
  const runner = {
    next: undefined as PreviewRun | undefined,
    run: vi.fn(async (job: Parameters<PreviewRunner['run']>[0]): Promise<PreviewRun> => {
      if (runner.next) {
        const next = runner.next;
        runner.next = undefined;
        return next;
      }
      const run: PreviewRun = {};
      runPreviewJob({ ...job, id: 1 }, (message: PreviewJobMessage) => {
        if (message.type === 'preview') run.preview = message.preview;
        if (message.type === 'test' && message.test) run.test = message.test;
      });
      return run;
    }),
    dispose: vi.fn(),
  };
  return runner;
}

const EXAMPLE = String.raw`^(\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$`;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
let update: ReturnType<typeof vi.fn>;
let runner: ReturnType<typeof inlineRunner>;

beforeEach(() => {
  resetFakeVscode();
  hoisted.panels.length = 0;
  hoisted.configurationListeners.length = 0;
  hoisted.stored.value = [EXAMPLE, { name: 'Web', pattern: '^web-(.+)$' }];
  update = vi.fn(async (_key: string, value: unknown) => {
    hoisted.stored.value = value;
  });
  fakeVscode.workspace.getConfiguration.mockImplementation(() => ({
    inspect: () => ({ globalValue: hoisted.stored.value, workspaceValue: ['^workspace'] }),
    update,
  }));
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  runner = inlineRunner();
});

async function openEditor(): Promise<{ editor: RepositoryGroupsEditor; panel: FakePanel }> {
  const editor = new RepositoryGroupsEditor({
    extensionUri: fakeVscode.Uri.file('/ext') as never,
    logger: logger as never,
    groupingInput: () => undefined,
    onDidRender: () => ({ dispose() {} }),
    previewRunner: runner,
  });
  await editor.open();
  const panel = hoisted.panels[hoisted.panels.length - 1] as FakePanel;
  panel.receive({ type: 'ready' });
  await flush();
  return { editor, panel };
}

/** The generation of the last load, which the webview sends back. */
function gen(panel: FakePanel): number {
  return (loaded(panel) as unknown as { generation: number }).generation;
}

function loaded(panel: FakePanel) {
  const loads = panel.posted.filter((message) => message.type === 'load');
  return loads[loads.length - 1] as unknown as { entries: Array<{ name: string; pattern: string; flags: string }> };
}

function lastState(panel: FakePanel) {
  return panel.posted.filter((message) => message.type === 'state').pop();
}

function loadCount(panel: FakePanel): number {
  return panel.posted.filter((message) => message.type === 'load').length;
}

/** settings.json changes the setting while the editor is open. */
function changeStored(value: unknown): void {
  hoisted.stored.value = value;
  for (const listener of hoisted.configurationListeners) listener({ affectsConfiguration: () => true });
}

/** The question of Save for a list that settings.json changed. */
function changedQuestion(theirs: unknown): unknown[] {
  return [
    GroupsEditorTexts.changedMeanwhile,
    { modal: true, detail: GroupsEditorTexts.changedMeanwhileDetail(describeSettingList(theirs)) },
    GroupsEditorTexts.loadTheirs,
    GroupsEditorTexts.saveMine,
  ];
}

describe('RepositoryGroupsEditor', () => {
  it('opens one panel with scripts from the extension only, and loads the user setting', async () => {
    const { editor, panel } = await openEditor();
    expect(panel.options).toMatchObject({ enableScripts: true, enableCommandUris: false, localResourceRoots: [expect.anything()] });
    // Review round 6 of PR #21, finding 1: a hidden tab keeps its page (its seq, its timer, and its draft).
    expect(panel.options).toMatchObject({ retainContextWhenHidden: true });
    expect(panel.webview.html).toContain("default-src 'none'");
    expect(panel.webview.html).toContain('webview:file:///ext/resources/groupsEditor/editor.js');
    expect(loaded(panel).entries).toEqual([
      { name: '', pattern: EXAMPLE, flags: '' },
      { name: 'Web', pattern: '^web-(.+)$', flags: '' },
    ]);
    expect(panel.posted.some((message) => message.type === 'state')).toBe(true);
    // A second open shows the same panel.
    await editor.open();
    expect(hoisted.panels).toHaveLength(1);
    expect(panel.reveal).toHaveBeenCalled();
  });

  it('ignores a message that is not valid', async () => {
    const { panel } = await openEditor();
    const before = panel.posted.length;
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [{ name: '', pattern: '^a', flags: 'g' }], testName: '' });
    await flush();
    expect(update).not.toHaveBeenCalled();
    expect(panel.posted.slice(before).map((message) => message.type)).toEqual(['state']);
    expect(logger.warn).toHaveBeenCalled();
  });

  // Review round 6 of PR #21, finding 2: the webview is read-only after its Save until a state answers it, so every
  // refused update or Save is answered with a state of the draft that the extension has (its seq, if it has a valid one).
  it('answers a refused update or Save with a state of the current draft, so the webview unlocks', async () => {
    const { panel } = await openEditor();
    const draft = loaded(panel).entries;
    const tooMany = Array.from({ length: 201 }, () => ({ name: '', pattern: '^a', flags: '' }));
    panel.receive({ type: 'save', seq: 5, generation: gen(panel), entries: tooMany, testName: '' });
    await flush();
    expect(update).not.toHaveBeenCalled();
    expect(lastState(panel)).toMatchObject({ seq: 5, saving: false, dirty: false, status: GroupsEditorTexts.refusedMessage });
    expect((lastState(panel) as unknown as { checks: unknown[] }).checks).toHaveLength(draft.length);
    panel.receive({ type: 'update', seq: 6, generation: gen(panel), entries: tooMany, testName: '' });
    await flush();
    expect(lastState(panel)).toMatchObject({ seq: 6, status: GroupsEditorTexts.refusedMessage });
    // Without a valid seq, the state has the current one.
    panel.receive({ type: 'update', seq: -1, generation: gen(panel), entries: [], testName: '' });
    await flush();
    expect(lastState(panel)).toMatchObject({ seq: 6, status: GroupsEditorTexts.refusedMessage });
    expect(loadCount(panel)).toBe(1);
  });

  // Review round 6 of PR #21, finding 1: a load carries the seq of the extension, which a new page continues.
  it('sends its seq with a load', async () => {
    const { panel } = await openEditor();
    expect(loaded(panel)).toMatchObject({ seq: 0 });
    panel.receive({ type: 'update', seq: 40, generation: gen(panel), entries: loaded(panel).entries, testName: '' });
    await flush();
    panel.receive({ type: 'ready' });
    await flush();
    expect(loaded(panel)).toMatchObject({ seq: 40 });
  });

  it('checks the entries again before it saves', async () => {
    const { panel } = await openEditor();
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [{ name: '', pattern: '(', flags: '' }], testName: '' });
    await flush();
    expect(update).not.toHaveBeenCalled();
    const state = panel.posted[panel.posted.length - 1];
    expect(state).toMatchObject({ type: 'state', status: GroupsEditorTexts.invalidEntriesNotSaved });
  });

  it('writes the user settings (Global) as strings and objects without a question while settings.json holds the loaded value', async () => {
    const { panel } = await openEditor();
    const [example] = loaded(panel).entries;
    panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries: [example, { name: '', pattern: '^api-(.+)$', flags: 'i' }], testName: '' });
    await flush();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('repositoryGroups', [EXAMPLE, { pattern: '^api-(.+)$', flags: 'i' }], fakeVscode.ConfigurationTarget.Global);
    expect(loaded(panel).entries).toEqual([
      { name: '', pattern: EXAMPLE, flags: '' },
      { name: '', pattern: '^api-(.+)$', flags: 'i' },
    ]);
    expect(panel.posted[panel.posted.length - 1]).toMatchObject({ type: 'state', status: GroupsEditorTexts.saved, dirty: false });
  });

  // User decision A (2026-09-26): only this one setting is written; the other settings and the comments stay.
  it('changes only the key repositoryGroups of the section devEnvLauncher, in the user settings', async () => {
    const { panel } = await openEditor();
    const [example] = loaded(panel).entries;
    changeStored(['^theirs']);
    fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.saveMine);
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [example], testName: '' });
    await flush();
    panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries: [], testName: '' });
    await flush();
    expect(update.mock.calls).toEqual([
      ['repositoryGroups', [EXAMPLE], fakeVscode.ConfigurationTarget.Global],
      ['repositoryGroups', undefined, fakeVscode.ConfigurationTarget.Global],
    ]);
    for (const call of fakeVscode.workspace.getConfiguration.mock.calls) expect(call).toEqual([SETTINGS_SECTION]);
  });

  describe('when settings.json changed the setting while the editor was open', () => {
    const THEIRS = ['^first', EXAMPLE];
    async function editedDraft() {
      const opened = await openEditor();
      const [example, web] = loaded(opened.panel).entries;
      const entries = [example, { ...web, pattern: '^www-(.+)$' }];
      opened.panel.receive({ type: 'update', seq: 1, generation: gen(opened.panel), entries, testName: '' });
      await flush();
      changeStored(THEIRS);
      await flush();
      return { ...opened, entries };
    }

    it('shows the banner and keeps the draft', async () => {
      const { panel } = await editedDraft();
      expect(lastState(panel)).toMatchObject({ changedOutside: true, dirty: true });
      expect(loadCount(panel)).toBe(1);
    });

    // round 7: no automatic reload (orchestrator decision). A draft without edits is not replaced either: the state
    // shows the banner, the base stays, and Save of an edit asks.
    it('keeps a draft without edits as well, shows the banner, and keeps the base, so Save asks', async () => {
      const { panel } = await openEditor();
      const before = panel.posted.length;
      changeStored(THEIRS);
      await flush();
      expect(panel.posted.slice(before).map((message) => message.type)).toEqual(['state']);
      expect(loadCount(panel)).toBe(1);
      expect(loaded(panel).entries.map((entry) => entry.pattern)).toEqual([EXAMPLE, '^web-(.+)$']);
      expect(lastState(panel)).toMatchObject({ changedOutside: true, dirty: false });
      fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.saveMine);
      panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [{ name: '', pattern: '^mine', flags: '' }], testName: '' });
      await flush();
      expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(...changedQuestion(THEIRS));
      expect(update).toHaveBeenCalledWith('repositoryGroups', ['^mine'], fakeVscode.ConfigurationTarget.Global);
    });

    it('keeps the base when the webview keeps its draft: its update is not stale, and Save asks', async () => {
      const { panel } = await openEditor();
      const [example, web] = loaded(panel).entries;
      const before = gen(panel);
      changeStored(THEIRS);
      await flush();
      // The webview had a keystroke waiting: it keeps the draft and sends it with the generation of its load.
      const entries = [example, { ...web, pattern: '^www-(.+)$' }];
      panel.receive({ type: 'update', seq: 1, generation: before, entries, testName: '' });
      await flush();
      expect(lastState(panel)).toMatchObject({ seq: 1, changedOutside: true, dirty: true });
      expect(lastState(panel)).not.toHaveProperty('status');
      fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.saveMine);
      panel.receive({ type: 'save', seq: 2, generation: before, entries, testName: '' });
      await flush();
      expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(...changedQuestion(THEIRS));
      expect(update).toHaveBeenCalledWith('repositoryGroups', [EXAMPLE, { name: 'Web', pattern: '^www-(.+)$' }], fakeVscode.ConfigurationTarget.Global);
    });

    // round 7: no automatic reload (orchestrator decision). A page that starts again gets the draft and the banner.
    it('gives a webview that starts again (a hidden tab that was shown) the draft and the banner', async () => {
      const { panel } = await openEditor();
      changeStored(THEIRS);
      await flush();
      panel.receive({ type: 'ready' });
      await flush();
      expect(loaded(panel).entries.map((entry) => entry.pattern)).toEqual([EXAMPLE, '^web-(.+)$']);
      expect(panel.posted[panel.posted.length - 1]).toMatchObject({ type: 'state', changedOutside: true, dirty: false });
      expect(panel.posted.every((message) => message.type === 'load' || message.type === 'state')).toBe(true);
    });

    // Review of PR #21, F1: a Save or update of an earlier load does not vanish: its entries stay, with a status.
    // Round 7: the later load comes from a Save (there is no accepted offer any more).
    async function savedOnce() {
      const opened = await openEditor();
      const old = gen(opened.panel);
      opened.panel.receive({ type: 'save', seq: 1, generation: old, entries: [{ name: '', pattern: '^first-(.+)$', flags: '' }], testName: '' });
      await flush();
      expect(gen(opened.panel)).toBeGreaterThan(old);
      update.mockClear();
      return { ...opened, old };
    }

    it('keeps the entries of a stale Save and says so', async () => {
      const { panel, old } = await savedOnce();
      const mine = [{ name: '', pattern: '^mine-(.+)$', flags: 'i' }];
      panel.receive({ type: 'save', seq: 3, generation: old, entries: mine, testName: '' });
      await flush();
      expect(update).not.toHaveBeenCalled();
      const load = loaded(panel) as unknown as { generation: number; entries: unknown };
      expect(load.entries).toEqual(mine);
      expect(load.generation).toBe(gen(panel));
      expect(lastState(panel)).toMatchObject({ seq: 3, dirty: true, status: GroupsEditorTexts.staleKept });
      expect(logger.warn).not.toHaveBeenCalled();
      // Save again writes them.
      panel.receive({ type: 'save', seq: 4, generation: load.generation, entries: mine, testName: '' });
      await flush();
      expect(update).toHaveBeenCalledWith('repositoryGroups', [{ pattern: '^mine-(.+)$', flags: 'i' }], fakeVscode.ConfigurationTarget.Global);
    });

    it('keeps the entries of a stale update and says so', async () => {
      const { panel, old } = await savedOnce();
      const mine = [{ name: '', pattern: '^mine-(.+)$', flags: '' }];
      panel.receive({ type: 'update', seq: 2, generation: old, entries: mine, testName: 'mine-x' });
      await flush();
      expect(loaded(panel)).toMatchObject({ entries: mine, testName: 'mine-x' });
      expect(lastState(panel)).toMatchObject({ seq: 2, dirty: true, status: GroupsEditorTexts.staleKept });
    });

    // Review round 6 of PR #21, finding 3: Load settings.json drops the draft; a late update does not bring it back.
    it('ignores an update or Save of a generation before a processed Load settings.json', async () => {
      const { panel } = await editedDraft();
      const old = gen(panel);
      panel.receive({ type: 'reload', testName: '' });
      await flush();
      const loads = loadCount(panel);
      panel.receive({ type: 'update', seq: 2, generation: old, entries: [{ name: '', pattern: '^old-(.+)$', flags: '' }], testName: '' });
      await flush();
      panel.receive({ type: 'save', seq: 3, generation: old, entries: [{ name: '', pattern: '^old-(.+)$', flags: '' }], testName: '' });
      await flush();
      expect(update).not.toHaveBeenCalled();
      expect(loadCount(panel)).toBe(loads);
      expect(loaded(panel).entries.map((entry) => entry.pattern)).toEqual(THEIRS);
      // The webview still gets an answer, for the draft of settings.json.
      expect(lastState(panel)).toMatchObject({ seq: 3, dirty: false, changedOutside: false });
      // Save of the current generation writes the draft of settings.json.
      panel.receive({ type: 'save', seq: 4, generation: gen(panel), entries: loaded(panel).entries, testName: '' });
      await flush();
      expect(lastState(panel)).toMatchObject({ seq: 4, status: GroupsEditorTexts.saved });
    });

    // Nit of the review of PR #21: settings.json already holds the draft.
    it('writes nothing and asks nothing when settings.json already holds the draft, and counts it as saved', async () => {
      const { panel, entries } = await editedDraft();
      changeStored([EXAMPLE, { name: 'Web', pattern: '^www-(.+)$' }]);
      await flush();
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries, testName: '' });
      await flush();
      expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(loaded(panel).entries).toEqual(entries);
      expect(lastState(panel)).toMatchObject({ dirty: false, changedOutside: false, status: GroupsEditorTexts.alreadySaved });
    });

    it('Load settings.json of the banner shows the stored value and drops the draft', async () => {
      const { panel } = await editedDraft();
      panel.receive({ type: 'reload', testName: '' });
      await flush();
      expect(loaded(panel).entries.map((entry) => entry.pattern)).toEqual(THEIRS);
      expect(lastState(panel)).toMatchObject({ changedOutside: false, dirty: false, status: GroupsEditorTexts.loaded });
      expect(update).not.toHaveBeenCalled();
    });

    it('Save asks with the current list of settings.json; Load settings.json reloads, writes nothing, and drops the draft', async () => {
      const { panel, entries } = await editedDraft();
      fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.loadTheirs);
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries, testName: '' });
      await flush();
      expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(...changedQuestion(THEIRS));
      expect(update).not.toHaveBeenCalled();
      expect(hoisted.stored.value).toEqual(THEIRS);
      expect(loaded(panel).entries.map((entry) => entry.pattern)).toEqual(THEIRS);
      expect(lastState(panel)).toMatchObject({ dirty: false, changedOutside: false, status: GroupsEditorTexts.loadedTheirs });
    });

    it('Save Mine replaces the value with the draft', async () => {
      const { panel, entries } = await editedDraft();
      fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.saveMine);
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries, testName: '' });
      await flush();
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(
        'repositoryGroups',
        [EXAMPLE, { name: 'Web', pattern: '^www-(.+)$' }],
        fakeVscode.ConfigurationTarget.Global,
      );
      expect(lastState(panel)).toMatchObject({ dirty: false, changedOutside: false, status: GroupsEditorTexts.savedReplaced });
    });

    it('Cancel writes nothing and keeps the draft', async () => {
      const { panel, entries } = await editedDraft();
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries, testName: '' });
      await flush();
      expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
      expect(loadCount(panel)).toBe(1);
      expect(lastState(panel)).toMatchObject({ dirty: true, changedOutside: true, status: GroupsEditorTexts.saveCancelled });
      // The draft is still the one that Save writes after Save Mine.
      fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.saveMine);
      panel.receive({ type: 'save', seq: 3, generation: gen(panel), entries, testName: '' });
      await flush();
      expect(update).toHaveBeenCalledWith('repositoryGroups', [EXAMPLE, { name: 'Web', pattern: '^www-(.+)$' }], fakeVscode.ConfigurationTarget.Global);
    });

    it('asks again when settings.json changes the value again while the question is open', async () => {
      const { panel, entries } = await editedDraft();
      const details: string[] = [];
      fakeVscode.window.showWarningMessage.mockImplementation(async (_message: string, options: { detail: string }) => {
        details.push(options.detail);
        if (details.length === 1) changeStored(['^again']);
        return GroupsEditorTexts.saveMine;
      });
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries, testName: '' });
      await flush();
      await flush();
      expect(details).toEqual([
        GroupsEditorTexts.changedMeanwhileDetail(describeSettingList(THEIRS)),
        GroupsEditorTexts.changedMeanwhileDetail(describeSettingList(['^again'])),
      ]);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith('repositoryGroups', [EXAMPLE, { name: 'Web', pattern: '^www-(.+)$' }], fakeVscode.ConfigurationTarget.Global);
    });

    it('shows a long list of settings.json cut per entry', async () => {
      const long = ['a'.repeat(5000), '^short'];
      const { panel, entries } = await editedDraft();
      changeStored(long);
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries, testName: '' });
      await flush();
      const detail = (fakeVscode.window.showWarningMessage.mock.calls[0][1] as { detail: string }).detail;
      expect(detail).toContain('2. "^short"');
      expect(detail.length).toBeLessThan(1000);
    });
  });

  it('removes the setting when the list is empty, and discards the draft with Cancel', async () => {
    const { editor, panel } = await openEditor();
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [], testName: '' });
    await flush();
    expect(update).toHaveBeenCalledWith('repositoryGroups', undefined, fakeVscode.ConfigurationTarget.Global);
    panel.receive({ type: 'update', seq: 2, generation: gen(panel), entries: [{ name: '', pattern: '^x', flags: '' }], testName: '' });
    panel.receive({ type: 'cancel' });
    await flush();
    expect(panel.disposed).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    await editor.open();
    expect(hoisted.panels).toHaveLength(2);
  });
  it('ignores updates of an earlier load and during Save, and gives the test name back with a load', async () => {
    const { panel } = await openEditor();
    const [example, web] = loaded(panel).entries;
    panel.receive({ type: 'update', seq: 1, generation: gen(panel), entries: [example, web], testName: 'school/web-shop' });
    await flush();
    let answer: (value: unknown) => void = () => {};
    // Set without the event, so the draft without edits is not reloaded before Save.
    hoisted.stored.value = [EXAMPLE, { name: 'Web', pattern: '^w-(.+)$' }];
    fakeVscode.window.showWarningMessage.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const oldGeneration = gen(panel);
    panel.receive({ type: 'save', seq: 2, generation: oldGeneration, entries: [example, { ...web, pattern: '^www-(.+)$' }], testName: 'school/web-shop' });
    await flush();
    // While the question of Save is open, an update does not change the draft that Save writes.
    panel.receive({ type: 'update', seq: 3, generation: oldGeneration, entries: [], testName: 'school/web-shop' });
    answer(GroupsEditorTexts.saveMine);
    await flush();
    expect(update).toHaveBeenCalledWith('repositoryGroups', [EXAMPLE, { name: 'Web', pattern: '^www-(.+)$' }], fakeVscode.ConfigurationTarget.Global);
    const load = loaded(panel) as unknown as { generation: number; testName: string };
    expect(load.generation).toBe(oldGeneration + 1);
    expect(load.testName).toBe('school/web-shop');
    // An update of the earlier load was edited from another value: ignored without a warning.
    update.mockClear();
    panel.receive({ type: 'save', seq: 4, generation: oldGeneration, entries: [], testName: '' });
    await flush();
    expect(update).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not save a regular expression that is too slow for the names of the view, and names it', async () => {
    const { panel } = await openEditor();
    const [example] = loaded(panel).entries;
    runner.next = { previewTooSlow: true, slowEntry: 1 };
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [example, { name: '', pattern: String.raw`^(\w+)+$`, flags: '' }], testName: '' });
    await flush();
    expect(update).not.toHaveBeenCalled();
    const states = panel.posted.filter((message) => message.type === 'state');
    expect(states[states.length - 1]).toMatchObject({ status: GroupsEditorTexts.tooSlowNotSaved });
  });
  // Review round 2 of PR #21, W1: Save needs a run of the worker that checked the entries.
  it('does not save when the worker could not check the regular expressions', async () => {
    const { panel } = await openEditor();
    const [example] = loaded(panel).entries;
    runner.next = { failed: true };
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [example, { name: '', pattern: '(?:(?:a?){10000}){3000}', flags: '' }], testName: '' });
    await flush();
    expect(update).not.toHaveBeenCalled();
    const states = panel.posted.filter((message) => message.type === 'state');
    expect(states[states.length - 1]).toMatchObject({ status: GroupsEditorTexts.previewFailed });
    // The state of a failed run keeps Save off and says why.
    runner.next = { failed: true };
    panel.receive({ type: 'update', seq: 2, generation: gen(panel), entries: [example], testName: '' });
    await flush();
    const last = panel.posted.filter((message) => message.type === 'state').pop();
    expect(last).toMatchObject({ seq: 2, canSave: false, status: GroupsEditorTexts.previewFailed });
  });

  // Review round 2 of PR #21, M5: a stored value that is not a list is replaced only after a question.
  it('asks before it replaces a stored value that is not a list, and saves nothing without the answer', async () => {
    const { panel } = await openEditor();
    const [example] = loaded(panel).entries;
    panel.receive({ type: 'update', seq: 1, generation: gen(panel), entries: [example], testName: '' });
    await flush();
    changeStored({ pattern: '^typed-by-hand' });
    panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries: [example], testName: '' });
    await flush();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(
      GroupsEditorTexts.changedMeanwhile,
      { modal: true, detail: GroupsEditorTexts.notAListDetail('{"pattern":"^typed-by-hand"}') },
      GroupsEditorTexts.loadTheirs,
      GroupsEditorTexts.saveMine,
    );
    expect(update).not.toHaveBeenCalled();
    expect(hoisted.stored.value).toEqual({ pattern: '^typed-by-hand' });

    fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.saveMine);
    panel.receive({ type: 'save', seq: 3, generation: gen(panel), entries: [example], testName: '' });
    await flush();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith('repositoryGroups', [EXAMPLE], fakeVscode.ConfigurationTarget.Global);
  });

  it('asks also when the value was not a list already when the editor loaded it; Load settings.json keeps it', async () => {
    hoisted.stored.value = { pattern: '^typed-by-hand' };
    const { panel } = await openEditor();
    expect(loaded(panel).entries).toEqual([]);
    fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.loadTheirs);
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [{ name: '', pattern: '^new', flags: '' }], testName: '' });
    await flush();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(
      GroupsEditorTexts.notAListConflict,
      { modal: true, detail: GroupsEditorTexts.notAListDetail('{"pattern":"^typed-by-hand"}') },
      GroupsEditorTexts.loadTheirs,
      GroupsEditorTexts.saveMine,
    );
    expect(update).not.toHaveBeenCalled();
    expect(lastState(panel)).toMatchObject({ dirty: false, status: GroupsEditorTexts.loadedTheirs });
  });

  // Review round 2 of PR #21, W7: after Cancel or a closed panel, a Save in progress writes nothing.
  it('writes nothing when the panel is closed while Save waits for the worker or for an answer', async () => {
    const { panel } = await openEditor();
    const [example, web] = loaded(panel).entries;
    let release: (run: PreviewRun) => void = () => {};
    runner.run.mockImplementationOnce(() => new Promise<PreviewRun>((resolve) => (release = resolve)));
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [example, { ...web, pattern: '^cancelled-(.+)$' }], testName: '' });
    await flush();
    panel.receive({ type: 'cancel' });
    await flush();
    expect(panel.disposed).toBe(true);
    release({});
    await flush();
    expect(update).not.toHaveBeenCalled();

    for (const choice of [GroupsEditorTexts.saveMine, GroupsEditorTexts.loadTheirs]) {
      hoisted.stored.value = [EXAMPLE, { name: 'Web', pattern: '^web-(.+)$' }];
      const second = await openEditor();
      const [example2, web2] = loaded(second.panel).entries;
      const entries = [example2, { ...web2, pattern: '^www-(.+)$' }];
      second.panel.receive({ type: 'update', seq: 1, generation: gen(second.panel), entries, testName: '' });
      await flush();
      changeStored([EXAMPLE, { name: 'Web', pattern: '^w-(.+)$' }]);
      let answer: (value: unknown) => void = () => {};
      fakeVscode.window.showWarningMessage.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      second.panel.receive({ type: 'save', seq: 2, generation: gen(second.panel), entries, testName: '' });
      await flush();
      expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      const posted = second.panel.posted.length;
      second.panel.dispose();
      answer(choice);
      await flush();
      expect(update).not.toHaveBeenCalled();
      expect(second.panel.posted).toHaveLength(posted);
      fakeVscode.window.showWarningMessage.mockClear();
    }
  });

  // Review round 3 of PR #21: a run that failed because the panel was closed (the runner was disposed) is not logged.
  it('does not log a failed preview when the panel was closed meanwhile', async () => {
    const { panel } = await openEditor();
    let release: (run: PreviewRun) => void = () => {};
    runner.run.mockImplementationOnce(() => new Promise<PreviewRun>((resolve) => (release = resolve)));
    panel.receive({ type: 'update', seq: 1, generation: gen(panel), entries: [], testName: '' });
    await flush();
    panel.dispose();
    release({ failed: true });
    await flush();
    expect(logger.warn).not.toHaveBeenCalled();
    // While the panel is open, a failed run is logged.
    const second = await openEditor();
    runner.next = { failed: true };
    second.panel.receive({ type: 'update', seq: 1, generation: gen(second.panel), entries: [], testName: '' });
    await flush();
    expect(logger.warn).toHaveBeenCalledWith('The preview of the repository groups could not be made in its worker thread.');
  });

  // Review of PR #21, F2: the state tells the webview whether Save still runs; the webview stays read-only until then.
  it('marks the states during Save, and the state after it', async () => {
    const { panel } = await openEditor();
    let release: (run: PreviewRun) => void = () => {};
    runner.run.mockImplementationOnce(() => new Promise<PreviewRun>((resolve) => (release = resolve)));
    expect(lastState(panel)).toMatchObject({ saving: false });
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [], testName: '' });
    await flush();
    changeStored(['^during']);
    await flush();
    expect(lastState(panel)).toMatchObject({ seq: 1, saving: true, changedOutside: true });
    release({});
    await flush();
    await flush();
    expect(lastState(panel)).toMatchObject({ seq: 1, saving: false });
  });

  // Review round 7 of PR #21, F1: a refused update, then a change of settings.json: the extension never replaces the
  // draft on its own (round 7: no automatic reload, orchestrator decision). It only sends a state with the banner.
  it('keeps the draft after a refused update and a change of settings.json, and shows the banner', async () => {
    const { panel } = await openEditor();
    const loads = loadCount(panel);
    const long = { name: '', pattern: 'a'.repeat(6000), flags: '' };
    panel.receive({ type: 'update', seq: 1, generation: gen(panel), entries: [long], testName: '' });
    await flush();
    expect(lastState(panel)).toMatchObject({ seq: 1, status: GroupsEditorTexts.refusedMessage });
    const before = panel.posted.length;
    changeStored(['^theirs']);
    await flush();
    expect(panel.posted.slice(before).map((message) => message.type)).toEqual(['state']);
    expect(lastState(panel)).toMatchObject({ seq: 1, changedOutside: true, dirty: false });
    expect(loadCount(panel)).toBe(loads);
  });

  // Review round 7 of PR #21, F2: Save and Load settings.json carry the test name; the load after them keeps it.
  it('takes the test name of Save and of Load settings.json, and gives it back with the load after them', async () => {
    const { panel } = await openEditor();
    const entries = loaded(panel).entries;
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries, testName: 'school/web-shop' });
    await flush();
    expect(loaded(panel)).toMatchObject({ testName: 'school/web-shop' });
    expect(lastState(panel)).toMatchObject({ seq: 1, test: { matched: true, path: ['school', 'Web', 'shop'] } });
    panel.receive({ type: 'reload', testName: 'web-api' });
    await flush();
    expect(loaded(panel)).toMatchObject({ testName: 'web-api' });
    // A test name over the limit is refused like that of an update.
    panel.receive({ type: 'reload', testName: 'a'.repeat(141) });
    await flush();
    expect(loaded(panel)).toMatchObject({ testName: 'web-api' });
    expect(lastState(panel)).toMatchObject({ status: GroupsEditorTexts.refusedMessage });
  });

  // Review round 7 of PR #21, hardening: a second page (for example after Developer: Reload Webviews) during a Save gets
  // an answer to each message, and its Load settings.json runs after the Save, so its form is never left read-only.
  it('answers every message of another page during Save, and runs its Load settings.json afterwards', async () => {
    const { panel } = await openEditor();
    const entries = loaded(panel).entries;
    let release: (run: PreviewRun) => void = () => {};
    runner.run.mockImplementationOnce(() => new Promise<PreviewRun>((resolve) => (release = resolve)));
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [entries[0]], testName: '' });
    await flush();
    const current = gen(panel);
    panel.receive({ type: 'ready' });
    await flush();
    panel.receive({ type: 'update', seq: 5, generation: current, entries, testName: '' });
    await flush();
    expect(lastState(panel)).toMatchObject({ seq: 5, saving: true });
    panel.receive({ type: 'save', seq: 6, generation: current, entries, testName: '' });
    await flush();
    expect(lastState(panel)).toMatchObject({ seq: 6, saving: true });
    panel.receive({ type: 'update', seq: 7, generation: current + 5, entries, testName: '' });
    await flush();
    expect(lastState(panel)).toMatchObject({ seq: 7, saving: true });
    const loads = loadCount(panel);
    panel.receive({ type: 'reload', testName: 'web-x' });
    await flush();
    expect(loadCount(panel)).toBe(loads);
    // settings.json changes during Save: the queued Load settings.json loads the value of then.
    hoisted.stored.value = ['^theirs'];
    release({});
    await flush();
    await flush();
    expect(update).not.toHaveBeenCalled();
    expect(loaded(panel)).toMatchObject({ seq: 7, testName: 'web-x', entries: [{ name: '', pattern: '^theirs', flags: '' }] });
    expect(lastState(panel)).toMatchObject({ seq: 7, saving: false, dirty: false, changedOutside: false, status: GroupsEditorTexts.loaded });
  });

  // Review round 8 of PR #21, finding 1: a page that starts during a Save gets `saving` with its load (it locks at once),
  // and a Save or update that the extension ignores because a Save runs is never reported as saved.
  it('sends saving with the load of a page that starts during Save, and never reports its ignored Save as saved', async () => {
    const { panel } = await openEditor();
    const entries = loaded(panel).entries;
    expect(loaded(panel)).toMatchObject({ saving: false });
    let release: (run: PreviewRun) => void = () => {};
    runner.run.mockImplementationOnce(() => new Promise<PreviewRun>((resolve) => (release = resolve)));
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [entries[0]], testName: '' });
    await flush();
    panel.receive({ type: 'ready' });
    await flush();
    expect(loaded(panel)).toMatchObject({ saving: true });
    panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries, testName: '' });
    await flush();
    expect(lastState(panel)).toMatchObject({ seq: 2, saving: true, status: GroupsEditorTexts.saveRunning });
    release({});
    await flush();
    await flush();
    // The first Save wrote its draft; the state that unlocks the second page does not say that its Save was done.
    expect(update).toHaveBeenCalledWith('repositoryGroups', [EXAMPLE], fakeVscode.ConfigurationTarget.Global);
    expect(loaded(panel)).toMatchObject({ saving: false });
    expect(lastState(panel)).toMatchObject({ seq: 2, saving: false, status: GroupsEditorTexts.notTakenDuringSave });
    for (const state of panel.posted.filter((message) => message.type === 'state' && (message.seq as number) >= 2)) {
      expect(state.status).not.toBe(GroupsEditorTexts.saved);
    }
  });

  // Review round 8 of PR #21, finding 2: the status of Save stays until the next edit, also when the write of Save makes
  // settings.json send its change event (a state computed meanwhile repeats it).
  it('keeps the status of Save in later states until the next edit', async () => {
    const { panel } = await openEditor();
    update.mockImplementation(async (_key: string, value: unknown) => changeStored(value));
    const entries = loaded(panel).entries;
    const inner = runner.run.getMockImplementation()!;
    runner.run.mockImplementation(async (job: never) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return inner(job);
    });
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [entries[0]], testName: '' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lastState(panel)).toMatchObject({ seq: 1, saving: false, dirty: false, status: GroupsEditorTexts.saved });
    changeStored([EXAMPLE]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lastState(panel)).toMatchObject({ seq: 1, status: GroupsEditorTexts.saved });
    // An update without a change of the entries (the test field) keeps it; an edit ends it.
    panel.receive({ type: 'update', seq: 2, generation: gen(panel), entries: [entries[0]], testName: 'web-shop' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lastState(panel)).toMatchObject({ seq: 2, status: GroupsEditorTexts.saved });
    panel.receive({ type: 'update', seq: 3, generation: gen(panel), entries, testName: 'web-shop' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lastState(panel)).toMatchObject({ seq: 3, dirty: true });
    expect(lastState(panel)?.status).toBeUndefined();
  });

  // Review round 8 of PR #21, finding 2: a state computed for the entries before a load is not sent after that load.
  it('sends no state for the entries before a load after that load', async () => {
    const { panel } = await openEditor();
    let release: (run: PreviewRun) => void = () => {};
    runner.run.mockImplementationOnce(() => new Promise<PreviewRun>((resolve) => (release = resolve)));
    const three = [
      { name: '', pattern: '^a', flags: '' },
      { name: '', pattern: '^b', flags: '' },
      { name: '', pattern: '^c', flags: '' },
    ];
    panel.receive({ type: 'update', seq: 1, generation: gen(panel), entries: three, testName: '' });
    await flush();
    panel.receive({ type: 'reload', testName: '' });
    await flush();
    const loadIndex = panel.posted.lastIndexOf(loaded(panel) as never);
    release({});
    await flush();
    await flush();
    const after = panel.posted.slice(loadIndex + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const state of after) {
      expect(state).toMatchObject({ type: 'state', status: GroupsEditorTexts.loaded, dirty: false });
      expect(state.checks).toHaveLength(loaded(panel).entries.length);
    }
  });

  // Review round 8 of PR #21, finding 3: Load settings.json in the question of Save drops the draft like the banner: an
  // update or Save of the load before it stays dropped.
  it('ignores an update of the load before Load settings.json of the question of Save', async () => {
    const { panel } = await openEditor();
    const entries = loaded(panel).entries;
    const before = gen(panel);
    changeStored(['^theirs']);
    await flush();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(GroupsEditorTexts.loadTheirs as never);
    panel.receive({ type: 'save', seq: 1, generation: before, entries: [entries[0]], testName: '' });
    for (let i = 0; i < 4; i++) await flush();
    expect(loaded(panel).entries).toEqual([{ name: '', pattern: '^theirs', flags: '' }]);
    const loads = loadCount(panel);
    panel.receive({ type: 'update', seq: 2, generation: before, entries: [{ name: '', pattern: '^mine', flags: '' }], testName: '' });
    for (let i = 0; i < 4; i++) await flush();
    expect(loadCount(panel)).toBe(loads);
    expect(lastState(panel)).toMatchObject({ seq: 2, dirty: false });
    expect(lastState(panel)?.status).not.toBe(GroupsEditorTexts.staleKept);
    expect(update).not.toHaveBeenCalled();
  });

  // Review round 2 of PR #21, W6: the worker of the preview stops with the panel.
  it('stops the worker of the preview when the panel is closed', async () => {
    const { panel } = await openEditor();
    expect(runner.dispose).not.toHaveBeenCalled();
    panel.dispose();
    expect(runner.dispose).toHaveBeenCalledTimes(1);
  });
});
