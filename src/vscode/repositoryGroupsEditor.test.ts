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
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [{ name: '', pattern: '^a', flags: 'g' }] });
    await flush();
    expect(update).not.toHaveBeenCalled();
    expect(panel.posted).toHaveLength(before);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('checks the entries again before it saves', async () => {
    const { panel } = await openEditor();
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [{ name: '', pattern: '(', flags: '' }] });
    await flush();
    expect(update).not.toHaveBeenCalled();
    const state = panel.posted[panel.posted.length - 1];
    expect(state).toMatchObject({ type: 'state', status: GroupsEditorTexts.invalidEntriesNotSaved });
  });

  it('writes the user settings (Global) as strings and objects without a question while settings.json holds the loaded value', async () => {
    const { panel } = await openEditor();
    const [example] = loaded(panel).entries;
    panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries: [example, { name: '', pattern: '^api-(.+)$', flags: 'i' }] });
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
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [example] });
    await flush();
    panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries: [] });
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

    // Review of PR #21, F1: the webview may hold keystrokes that the extension has not seen yet (150 ms delay), so the
    // extension only offers the new value (`external`); the webview takes it (`accept`) only without such edits.
    it('offers the new value to a draft without edits, and shows it when the webview accepts it', async () => {
      const { panel } = await openEditor();
      const before = gen(panel);
      changeStored(THEIRS);
      await flush();
      expect(loadCount(panel)).toBe(1);
      const offer = panel.posted[panel.posted.length - 1] as unknown as { type: string; generation: number; entries: Array<{ pattern: string }> };
      expect(offer).toMatchObject({ type: 'external', notices: [] });
      expect(offer.entries.map((entry) => entry.pattern)).toEqual(THEIRS);
      expect(offer.generation).toBeGreaterThan(before);
      panel.receive({ type: 'accept', generation: offer.generation });
      await flush();
      expect(lastState(panel)).toMatchObject({ changedOutside: false, dirty: false });
      // The accepted value is the new base: Save of an edit writes without a question.
      panel.receive({ type: 'save', seq: 1, generation: offer.generation, entries: [{ name: '', pattern: '^mine', flags: '' }] });
      await flush();
      expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
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
      panel.receive({ type: 'save', seq: 2, generation: before, entries });
      await flush();
      expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(...changedQuestion(THEIRS));
      expect(update).toHaveBeenCalledWith('repositoryGroups', [EXAMPLE, { name: 'Web', pattern: '^www-(.+)$' }], fakeVscode.ConfigurationTarget.Global);
    });

    it('offers the new value again to a webview that starts again (a hidden tab that was shown)', async () => {
      const { panel } = await openEditor();
      changeStored(THEIRS);
      await flush();
      const first = panel.posted[panel.posted.length - 1] as unknown as { generation: number };
      panel.receive({ type: 'ready' });
      await flush();
      expect(loaded(panel).entries.map((entry) => entry.pattern)).toEqual([EXAMPLE, '^web-(.+)$']);
      const again = panel.posted[panel.posted.length - 1] as unknown as { type: string; generation: number };
      expect(again.type).toBe('external');
      expect(again.generation).toBeGreaterThan(first.generation);
    });

    it('ignores an accept of an offer that a later load replaced', async () => {
      const { panel } = await openEditor();
      changeStored(THEIRS);
      await flush();
      const offer = panel.posted[panel.posted.length - 1] as unknown as { generation: number };
      panel.receive({ type: 'reload' });
      await flush();
      const current = gen(panel);
      panel.receive({ type: 'accept', generation: offer.generation });
      await flush();
      panel.receive({ type: 'save', seq: 1, generation: current, entries: [] });
      await flush();
      expect(update).toHaveBeenCalledWith('repositoryGroups', undefined, fakeVscode.ConfigurationTarget.Global);
    });

    // Review of PR #21, F1: a Save or update of an earlier load does not vanish: its entries stay, with a status.
    it('keeps the entries of a stale Save and says so', async () => {
      const { panel } = await openEditor();
      const old = gen(panel);
      panel.receive({ type: 'reload' });
      await flush();
      const mine = [{ name: '', pattern: '^mine-(.+)$', flags: 'i' }];
      panel.receive({ type: 'save', seq: 3, generation: old, entries: mine });
      await flush();
      expect(update).not.toHaveBeenCalled();
      const load = loaded(panel) as unknown as { generation: number; entries: unknown };
      expect(load.entries).toEqual(mine);
      expect(load.generation).toBe(gen(panel));
      expect(lastState(panel)).toMatchObject({ seq: 3, dirty: true, status: GroupsEditorTexts.staleKept });
      expect(logger.warn).not.toHaveBeenCalled();
      // Save again writes them.
      panel.receive({ type: 'save', seq: 4, generation: load.generation, entries: mine });
      await flush();
      expect(update).toHaveBeenCalledWith('repositoryGroups', [{ pattern: '^mine-(.+)$', flags: 'i' }], fakeVscode.ConfigurationTarget.Global);
    });

    it('keeps the entries of a stale update and says so', async () => {
      const { panel } = await openEditor();
      const old = gen(panel);
      panel.receive({ type: 'reload' });
      await flush();
      const mine = [{ name: '', pattern: '^mine-(.+)$', flags: '' }];
      panel.receive({ type: 'update', seq: 2, generation: old, entries: mine, testName: 'mine-x' });
      await flush();
      expect(loaded(panel)).toMatchObject({ entries: mine, testName: 'mine-x' });
      expect(lastState(panel)).toMatchObject({ seq: 2, dirty: true, status: GroupsEditorTexts.staleKept });
    });

    // Nit of the review of PR #21: settings.json already holds the draft.
    it('writes nothing and asks nothing when settings.json already holds the draft, and counts it as saved', async () => {
      const { panel, entries } = await editedDraft();
      changeStored([EXAMPLE, { name: 'Web', pattern: '^www-(.+)$' }]);
      await flush();
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries });
      await flush();
      expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(loaded(panel).entries).toEqual(entries);
      expect(lastState(panel)).toMatchObject({ dirty: false, changedOutside: false, status: GroupsEditorTexts.alreadySaved });
    });

    it('Load settings.json of the banner shows the stored value and drops the draft', async () => {
      const { panel } = await editedDraft();
      panel.receive({ type: 'reload' });
      await flush();
      expect(loaded(panel).entries.map((entry) => entry.pattern)).toEqual(THEIRS);
      expect(lastState(panel)).toMatchObject({ changedOutside: false, dirty: false, status: GroupsEditorTexts.loaded });
      expect(update).not.toHaveBeenCalled();
    });

    it('Save asks with the current list of settings.json; Load settings.json reloads, writes nothing, and drops the draft', async () => {
      const { panel, entries } = await editedDraft();
      fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.loadTheirs);
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries });
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
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries });
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
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries });
      await flush();
      expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
      expect(loadCount(panel)).toBe(1);
      expect(lastState(panel)).toMatchObject({ dirty: true, changedOutside: true, status: GroupsEditorTexts.saveCancelled });
      // The draft is still the one that Save writes after Save Mine.
      fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.saveMine);
      panel.receive({ type: 'save', seq: 3, generation: gen(panel), entries });
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
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries });
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
      panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries });
      await flush();
      const detail = (fakeVscode.window.showWarningMessage.mock.calls[0][1] as { detail: string }).detail;
      expect(detail).toContain('2. "^short"');
      expect(detail.length).toBeLessThan(1000);
    });
  });

  it('removes the setting when the list is empty, and discards the draft with Cancel', async () => {
    const { editor, panel } = await openEditor();
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [] });
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
    panel.receive({ type: 'save', seq: 2, generation: oldGeneration, entries: [example, { ...web, pattern: '^www-(.+)$' }] });
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
    panel.receive({ type: 'save', seq: 4, generation: oldGeneration, entries: [] });
    await flush();
    expect(update).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not save a regular expression that is too slow for the names of the view, and names it', async () => {
    const { panel } = await openEditor();
    const [example] = loaded(panel).entries;
    runner.next = { previewTooSlow: true, slowEntry: 1 };
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [example, { name: '', pattern: String.raw`^(\w+)+$`, flags: '' }] });
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
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [example, { name: '', pattern: '(?:(?:a?){10000}){3000}', flags: '' }] });
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
    panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries: [example] });
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
    panel.receive({ type: 'save', seq: 3, generation: gen(panel), entries: [example] });
    await flush();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith('repositoryGroups', [EXAMPLE], fakeVscode.ConfigurationTarget.Global);
  });

  it('asks also when the value was not a list already when the editor loaded it; Load settings.json keeps it', async () => {
    hoisted.stored.value = { pattern: '^typed-by-hand' };
    const { panel } = await openEditor();
    expect(loaded(panel).entries).toEqual([]);
    fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.loadTheirs);
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [{ name: '', pattern: '^new', flags: '' }] });
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
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [example, { ...web, pattern: '^cancelled-(.+)$' }] });
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
      second.panel.receive({ type: 'save', seq: 2, generation: gen(second.panel), entries });
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
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [] });
    await flush();
    changeStored(['^during']);
    await flush();
    expect(lastState(panel)).toMatchObject({ seq: 1, saving: true, changedOutside: true });
    release({});
    await flush();
    await flush();
    expect(lastState(panel)).toMatchObject({ seq: 1, saving: false });
  });

  // Review round 2 of PR #21, W6: the worker of the preview stops with the panel.
  it('stops the worker of the preview when the panel is closed', async () => {
    const { panel } = await openEditor();
    expect(runner.dispose).not.toHaveBeenCalled();
    panel.dispose();
    expect(runner.dispose).toHaveBeenCalledTimes(1);
  });
});
