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
import { GroupsEditorTexts, runPreviewJob, type PreviewJobMessage, type PreviewRun } from './repositoryGroupsEditorModel';

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
  return loads[loads.length - 1] as unknown as { entries: Array<{ name: string; pattern: string; flags: string; origin?: number }> };
}

describe('RepositoryGroupsEditor', () => {
  it('opens one panel with scripts from the extension only, and loads the user setting', async () => {
    const { editor, panel } = await openEditor();
    expect(panel.options).toMatchObject({ enableScripts: true, enableCommandUris: false, localResourceRoots: [expect.anything()] });
    expect(panel.webview.html).toContain("default-src 'none'");
    expect(panel.webview.html).toContain('webview:file:///ext/resources/groupsEditor/editor.js');
    expect(loaded(panel).entries).toEqual([
      { name: '', pattern: EXAMPLE, flags: '', origin: 0 },
      { name: 'Web', pattern: '^web-(.+)$', flags: '', origin: 1 },
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

  it('writes the user settings (Global) as strings and objects, and loads the written value as the new base', async () => {
    const { panel } = await openEditor();
    const [example] = loaded(panel).entries;
    panel.receive({ type: 'save', seq: 2, generation: gen(panel), entries: [example, { name: '', pattern: '^api-(.+)$', flags: 'i' }] });
    await flush();
    expect(update).toHaveBeenCalledWith('repositoryGroups', [EXAMPLE, { pattern: '^api-(.+)$', flags: 'i' }], fakeVscode.ConfigurationTarget.Global);
    expect(loaded(panel).entries).toEqual([
      { name: '', pattern: EXAMPLE, flags: '', origin: 0 },
      { name: '', pattern: '^api-(.+)$', flags: 'i', origin: 1 },
    ]);
    expect(panel.posted[panel.posted.length - 1]).toMatchObject({ type: 'state', status: GroupsEditorTexts.saved, dirty: false });
  });

  it('merges a change made in settings.json meanwhile instead of overwriting it', async () => {
    const { panel } = await openEditor();
    const [example, web] = loaded(panel).entries;
    hoisted.stored.value = ['^first', EXAMPLE, { name: 'Web', pattern: '^web-(.+)$' }];
    for (const listener of hoisted.configurationListeners) listener({ affectsConfiguration: () => true });
    // The state is computed with the preview job (asynchronous since the worker thread).
    await flush();
    expect(panel.posted[panel.posted.length - 1]).toMatchObject({ type: 'state', changedOutside: true });
    panel.receive({ type: 'save', seq: 3, generation: gen(panel), entries: [example, { ...web, pattern: '^www-(.+)$' }] });
    await flush();
    expect(update).toHaveBeenCalledWith(
      'repositoryGroups',
      ['^first', EXAMPLE, { name: 'Web', pattern: '^www-(.+)$' }],
      fakeVscode.ConfigurationTarget.Global,
    );
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(panel.posted[panel.posted.length - 1]).toMatchObject({ status: GroupsEditorTexts.savedMerged, changedOutside: false });
  });

  it('asks about a conflicting entry only, and saves nothing when the question is dismissed', async () => {
    const { panel } = await openEditor();
    const [example, web] = loaded(panel).entries;
    hoisted.stored.value = [EXAMPLE, { name: 'Web', pattern: '^w-(.+)$' }];
    const entries = [example, { ...web, pattern: '^www-(.+)$' }];
    panel.receive({ type: 'save', seq: 3, generation: gen(panel), entries });
    await flush();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(
      GroupsEditorTexts.conflict(2),
      expect.objectContaining({ modal: true }),
      GroupsEditorTexts.keepMine,
      GroupsEditorTexts.keepTheirs,
    );
    expect(update).not.toHaveBeenCalled();

    fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.keepMine);
    panel.receive({ type: 'save', seq: 4, generation: gen(panel), entries });
    await flush();
    expect(update).toHaveBeenCalledWith(
      'repositoryGroups',
      [EXAMPLE, { name: 'Web', pattern: '^www-(.+)$' }],
      fakeVscode.ConfigurationTarget.Global,
    );
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
    hoisted.stored.value = [EXAMPLE, { name: 'Web', pattern: '^w-(.+)$' }];
    fakeVscode.window.showWarningMessage.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const oldGeneration = gen(panel);
    panel.receive({ type: 'save', seq: 2, generation: oldGeneration, entries: [example, { ...web, pattern: '^www-(.+)$' }] });
    await flush();
    // While the question of Save is open, an update does not change the draft that Save writes.
    panel.receive({ type: 'update', seq: 3, generation: oldGeneration, entries: [], testName: 'school/web-shop' });
    answer(GroupsEditorTexts.keepMine);
    await flush();
    expect(update).toHaveBeenCalledWith('repositoryGroups', [EXAMPLE, { name: 'Web', pattern: '^www-(.+)$' }], fakeVscode.ConfigurationTarget.Global);
    const load = loaded(panel) as unknown as { generation: number; testName: string };
    expect(load.generation).toBe(oldGeneration + 1);
    expect(load.testName).toBe('school/web-shop');
    // An update of the earlier load names origins of another base: ignored without a warning.
    update.mockClear();
    panel.receive({ type: 'save', seq: 4, generation: oldGeneration, entries: [] });
    await flush();
    expect(update).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('asks once about the order when both sides moved entries differently', async () => {
    hoisted.stored.value = ['^a', '^b', '^c'];
    const { panel } = await openEditor();
    const [a, b, c] = loaded(panel).entries;
    hoisted.stored.value = ['^b', '^a', '^c'];
    fakeVscode.window.showWarningMessage.mockResolvedValue(GroupsEditorTexts.keepTheirs);
    panel.receive({ type: 'save', seq: 1, generation: gen(panel), entries: [c, a, b] });
    await flush();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(
      GroupsEditorTexts.orderConflict,
      expect.objectContaining({ modal: true }),
      GroupsEditorTexts.keepMine,
      GroupsEditorTexts.keepTheirs,
    );
    // Nothing else changed, so the stored value stays.
    expect(update).not.toHaveBeenCalled();
    expect(loaded(panel).entries.map((entry) => entry.pattern)).toEqual(['^b', '^a', '^c']);
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
});
