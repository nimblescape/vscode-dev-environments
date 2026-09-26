// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The script of the webview (resources/groupsEditor/editor.js) in a small stand-in of the DOM (review finding 7): a load
// restores the test name, the generation, and the `seq` of the extension; a change of settings.json only shows the banner
// (the draft stays); Save and Load settings.json make the form read-only; Add stops at the limit.
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it } from 'vitest';
import { EditorLimits } from './repositoryGroupsEditorModel';

type Listener = (event?: unknown) => void;

class StubElement {
  value = '';
  hidden = false;
  disabled = false;
  textContent = '';
  children: StubElement[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  readonly attributes = new Map<string, string>();
  replaceChildren(...children: StubElement[]): void {
    this.children = children;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'disabled') this.disabled = true;
  }
  appendChild(child: StubElement): void {
    this.children.push(child);
  }
  focus(): void {}
}

function loadScript() {
  const elements = new Map<string, StubElement>();
  /** The elements that the script created, newest last (the rows of the entries). */
  const created: StubElement[] = [];
  const document = Object.assign(new StubElement(), {
    visibilityState: 'visible',
    getElementById: (id: string) => {
      const made = created.filter((element) => element.attributes.get('id') === id).pop();
      if (made) return made;
      if (!elements.has(id)) elements.set(id, new StubElement());
      return elements.get(id);
    },
    createElement: () => {
      const element = new StubElement();
      created.push(element);
      return element;
    },
  });
  const window = new StubElement();
  const posted: Array<Record<string, unknown>> = [];
  /** The callbacks of the timers that wait; a cleared timer is removed. */
  const timers: Array<() => void> = [];
  const context = vm.createContext({
    document,
    window,
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message) }),
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return callback;
    },
    clearTimeout: (handle: unknown) => {
      const index = timers.indexOf(handle as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'groupsEditor', 'editor.js'), 'utf8');
  vm.runInContext(source, context);
  const byId = (id: string): StubElement => document.getElementById(id) as StubElement;
  const receive = (data: unknown) => window.dispatch('message', { data });
  return { elements, document, window, posted, timers, byId, receive };
}

const ENTRY = { name: 'Web', pattern: '^web-(.+)$', flags: '' };
const THEIRS = { name: '', pattern: '^theirs-(.+)$', flags: '' };

/** A state of the extension that answers the update `seq`. */
function state(seq: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'state',
    seq,
    checks: [{}],
    canSave: true,
    dirty: true,
    changedOutside: false,
    saving: false,
    preview: { loaded: false, owners: [], truncated: 0 },
    ...extra,
  };
}

describe('editor.js', () => {
  it('asks for the load at the start, and restores the test name and the generation of a load', () => {
    const page = loadScript();
    expect(page.posted).toEqual([{ type: 'ready' }]);
    page.window.dispatch('message', { data: { type: 'load', generation: 3, entries: [], notices: [], testName: 'school/web-shop' } });
    expect(page.elements.get('test-name')?.value).toBe('school/web-shop');
    page.elements.get('save')?.dispatch('click');
    expect(page.posted[1]).toEqual({ type: 'save', seq: 1, generation: 3, entries: [], testName: 'school/web-shop' });
  });

  // Review of PR #21, F1: settings.json changes the setting while a keystroke still waits for its delay.
  // round 7: no automatic reload (orchestrator decision): the state says `changedOutside`, and the page only shows the banner.
  describe('when settings.json changed the setting', () => {
    function typed() {
      const page = loadScript();
      page.receive({ type: 'load', generation: 1, entries: [ENTRY], notices: [], testName: '' });
      const pattern = page.byId('entry-0-pattern');
      pattern.value = '^www-(.+)$';
      pattern.dispatch('input');
      return page;
    }

    // round 7: no automatic reload (orchestrator decision)
    it('keeps a draft with a waiting keystroke and shows the banner; the keystroke is sent after its delay', () => {
      const page = typed();
      page.byId('changed').hidden = true;
      page.receive(state(0, { dirty: false, changedOutside: true }));
      expect(page.byId('entry-0-pattern').value).toBe('^www-(.+)$');
      expect(page.byId('changed').hidden).toBe(false);
      expect(page.posted).toHaveLength(1);
      page.timers.shift()!();
      expect(page.posted.slice(1)).toEqual([
        { type: 'update', seq: 1, generation: 1, entries: [{ ...ENTRY, pattern: '^www-(.+)$' }], testName: '' },
      ]);
      // The generation stays that of the draft: Save is not stale.
      page.byId('save').dispatch('click');
      expect(page.posted[2]).toMatchObject({ type: 'save', generation: 1, entries: [{ ...ENTRY, pattern: '^www-(.+)$' }] });
    });

    // round 7: no automatic reload (orchestrator decision)
    it('keeps a draft whose update the extension has not answered yet, and shows the banner', () => {
      const page = typed();
      page.timers.shift()!();
      expect(page.posted).toHaveLength(2);
      page.receive(state(0, { dirty: false, changedOutside: true }));
      expect(page.byId('entry-0-pattern').value).toBe('^www-(.+)$');
      expect(page.byId('changed').hidden).toBe(false);
      expect(page.posted).toHaveLength(2);
    });

    // round 7: no automatic reload (orchestrator decision)
    it('keeps the draft also when every edit was answered, and shows the banner until Load settings.json', () => {
      const page = typed();
      page.timers.shift()!();
      expect(page.posted[1]).toMatchObject({ type: 'update', seq: 1 });
      page.receive(state(1));
      page.receive(state(1, { changedOutside: true }));
      expect(page.byId('entry-0-pattern').value).toBe('^www-(.+)$');
      expect(page.byId('changed').hidden).toBe(false);
      expect(page.posted).toHaveLength(2);
      page.byId('save').dispatch('click');
      expect(page.posted[2]).toMatchObject({ type: 'save', generation: 1, entries: [{ ...ENTRY, pattern: '^www-(.+)$' }] });
    });

    // Round 7: the banner is the only sign of the change, so an older state that the page otherwise drops still shows it.
    it('shows the banner of a state that answers an older update', () => {
      const page = typed();
      page.byId('changed').hidden = true;
      page.byId('add').dispatch('click');
      expect(page.posted[1]).toMatchObject({ type: 'update', seq: 1 });
      page.receive(state(0, { changedOutside: true }));
      expect(page.byId('changed').hidden).toBe(false);
      expect(page.byId('entry-1-pattern').value).toBe('');
    });

    it('Load settings.json drops a waiting keystroke instead of sending it after the reload', () => {
      const page = typed();
      page.byId('reload').dispatch('click');
      for (const timer of page.timers.splice(0)) timer();
      expect(page.posted.slice(1)).toEqual([{ type: 'reload', testName: '' }]);
    });

    // Review round 6 of PR #21, finding 3: Load settings.json is read-only until its load, the same way as Save.
    it('Load settings.json makes the form read-only until the load of that reload', () => {
      const page = typed();
      page.receive(state(0));
      const form = page.byId('form');
      expect(form.disabled).toBe(false);
      page.byId('reload').dispatch('click');
      expect(form.disabled).toBe(true);
      expect(page.timers).toHaveLength(0);
      // A state computed before the reload keeps it read-only, and a change of settings.json does not replace the draft
      // meanwhile (round 7: no automatic reload, orchestrator decision).
      page.receive(state(0));
      page.receive(state(0, { changedOutside: true }));
      expect(form.disabled).toBe(true);
      expect(page.byId('entry-0-pattern').value).toBe('^www-(.+)$');
      expect(page.posted.slice(1)).toEqual([{ type: 'reload', testName: '' }]);
      page.receive({ type: 'load', seq: 0, generation: 3, entries: [THEIRS], notices: [], testName: '' });
      expect(form.disabled).toBe(false);
      expect(page.byId('entry-0-pattern').value).toBe('^theirs-(.+)$');
    });
  });

  // Review of PR #21, F2: while Save waits for the worker or for an answer, the editor takes no edits.
  it('is read-only from Save until the state of that Save', () => {
    const page = loadScript();
    page.receive({ type: 'load', generation: 1, entries: [ENTRY], notices: [], testName: '' });
    page.receive(state(0));
    const form = page.byId('form');
    expect(form.disabled).toBe(false);
    page.byId('save').dispatch('click');
    expect(page.posted[1]).toMatchObject({ type: 'save', seq: 1 });
    expect(form.disabled).toBe(true);
    // A state computed before the Save, or during it, keeps it read-only.
    page.receive(state(0));
    page.receive(state(1, { saving: true }));
    expect(form.disabled).toBe(true);
    // The load of the written value, then the state of the finished Save.
    page.receive({ type: 'load', generation: 2, entries: [ENTRY], notices: [], testName: '' });
    expect(form.disabled).toBe(true);
    page.receive(state(1, { dirty: false, status: 'Saved to the user settings.' }));
    expect(form.disabled).toBe(false);
    expect(page.byId('status').textContent).toBe('Saved to the user settings.');
  });

  // Review round 6 of PR #21, finding 1: a page that starts again (or any load) takes the `seq` of the extension.
  describe('takes the seq of the extension from a load', () => {
    function restarted() {
      const page = loadScript();
      page.receive({ type: 'load', seq: 40, generation: 2, entries: [ENTRY], notices: [], testName: '' });
      page.receive(state(40, { dirty: false }));
      const pattern = page.byId('entry-0-pattern');
      pattern.value = '^web-x(.+)$';
      pattern.dispatch('input');
      page.timers.shift()!();
      expect(page.posted[1]).toMatchObject({ type: 'update', seq: 41 });
      return page;
    }

    it('a state computed before Save does not end the read-only form', () => {
      const page = restarted();
      page.byId('save').dispatch('click');
      expect(page.posted[2]).toMatchObject({ type: 'save', seq: 42 });
      page.receive(state(41));
      expect(page.byId('form').disabled).toBe(true);
      page.receive(state(42, { dirty: false }));
      expect(page.byId('form').disabled).toBe(false);
    });

    // round 7: no automatic reload (orchestrator decision)
    it('an update without its state keeps the draft when settings.json changes, and shows the banner', () => {
      const page = restarted();
      page.receive(state(40, { dirty: false, changedOutside: true }));
      expect(page.byId('entry-0-pattern').value).toBe('^web-x(.+)$');
      expect(page.byId('changed').hidden).toBe(false);
      expect(page.posted).toHaveLength(2);
    });

    it('a state with saving: true makes the form read-only until a state without it', () => {
      const page = loadScript();
      page.receive({ type: 'load', seq: 7, generation: 2, entries: [ENTRY], notices: [], testName: '' });
      page.receive(state(7, { saving: true }));
      expect(page.byId('form').disabled).toBe(true);
      page.receive(state(7));
      expect(page.byId('form').disabled).toBe(false);
    });
  });

  // Review round 7 of PR #21, F1 (the repro of the review): the extension refused an update of the page and answered with
  // a state of its own draft; then settings.json changed. The page keeps its draft and shows the banner (round 7: no
  // automatic reload, orchestrator decision); a message `external` of the removed protocol changes nothing.
  it('keeps its draft after a refused update and a change of settings.json, and shows the banner', () => {
    const page = loadScript();
    const long = { name: '', pattern: 'a'.repeat(EditorLimits.pattern + 1000), flags: '' };
    page.receive({ type: 'load', seq: 0, generation: 0, entries: [long, ENTRY], notices: [], testName: '' });
    const pattern = page.byId('entry-1-pattern');
    pattern.value = '^www-(.+)$';
    pattern.dispatch('input');
    for (const timer of page.timers.splice(0)) timer();
    page.receive(state(1, { checks: [{ error: 'too long' }, {}], canSave: false, dirty: false, status: 'refused' }));
    page.receive({ type: 'external', generation: 1, entries: [THEIRS], notices: [] });
    page.receive(state(1, { checks: [{ error: 'too long' }, {}], canSave: false, dirty: false, changedOutside: true }));
    expect(page.byId('entry-0-pattern').value).toBe(long.pattern);
    expect(page.byId('entry-1-pattern').value).toBe('^www-(.+)$');
    expect(page.byId('changed').hidden).toBe(false);
    expect(page.posted.filter((message) => message.type === 'accept')).toEqual([]);
  });

  // Review round 7 of PR #21, F1: an entry over the limits of the extension (for example loaded from settings.json) makes
  // the extension refuse every update. The page names it at its own entry, keeps Save off, keeps the edits, and says why.
  it('names an entry over the limits at that entry, keeps Save off and the edits, and sends no update the extension refuses', () => {
    const page = loadScript();
    const long = { name: '', pattern: 'a'.repeat(EditorLimits.pattern + 1), flags: '' };
    page.receive({ type: 'load', seq: 0, generation: 0, entries: [long, ENTRY], notices: [], testName: '' });
    // The state of the extension for the loaded entries.
    page.receive(state(0, { checks: [{ error: 'too long' }, { note: 'One capturing group' }], canSave: false, dirty: false }));
    expect(page.byId('entry-0-error').textContent).not.toBe('');
    // Down: the long entry is the second one now; its error moves with it.
    page.byId('entry-0-down').dispatch('click');
    expect(page.byId('entry-0-pattern').value).toBe(ENTRY.pattern);
    expect(page.byId('entry-0-error').textContent).toBe('');
    expect(page.byId('entry-1-error').textContent).toContain(`longer than ${EditorLimits.pattern} characters`);
    expect(page.byId('save').disabled).toBe(true);
    expect(page.byId('status').textContent).toContain('Entry 2');
    // Edits stay in the page; nothing is sent that the extension would refuse.
    const pattern = page.byId('entry-0-pattern');
    pattern.value = '^www-(.+)$';
    pattern.dispatch('input');
    for (const timer of page.timers.splice(0)) timer();
    expect(page.posted.slice(1)).toEqual([]);
    expect(page.byId('entry-0-pattern').value).toBe('^www-(.+)$');
    page.byId('save').dispatch('click');
    expect(page.posted.slice(1)).toEqual([]);
    expect(page.byId('form').disabled).toBe(false);
    // Removing the long entry sends the draft again.
    page.byId('entry-1-remove').dispatch('click');
    expect(page.posted.slice(1)).toEqual([
      { type: 'update', seq: 1, generation: 0, entries: [{ ...ENTRY, pattern: '^www-(.+)$' }], testName: '' },
    ]);
    page.receive(state(1));
    expect(page.byId('save').disabled).toBe(false);
    expect(page.byId('status').textContent).toBe('Not saved.');
  });

  // Review round 7 of PR #21, F2: a test name that still waits for its delay goes with Save and with Load settings.json,
  // and the load after them does not reset the field.
  it('sends a waiting test name with Save and with Load settings.json, and keeps the field at the load after them', () => {
    const page = loadScript();
    page.receive({ type: 'load', seq: 0, generation: 1, entries: [ENTRY], notices: [], testName: 'old' });
    const testName = page.byId('test-name');
    testName.value = 'school/web-shop';
    testName.dispatch('input');
    page.byId('save').dispatch('click');
    expect(page.posted[1]).toEqual({ type: 'save', seq: 1, generation: 1, entries: [ENTRY], testName: 'school/web-shop' });
    page.receive({ type: 'load', seq: 1, generation: 2, entries: [ENTRY], notices: [], testName: 'old' });
    expect(testName.value).toBe('school/web-shop');
    page.receive(state(1, { dirty: false }));
    testName.value = 'web-api';
    testName.dispatch('input');
    page.byId('reload').dispatch('click');
    expect(page.posted[2]).toEqual({ type: 'reload', testName: 'web-api' });
    page.receive({ type: 'load', seq: 1, generation: 3, entries: [ENTRY], notices: [], testName: 'old' });
    expect(testName.value).toBe('web-api');
  });

  // Review round 8 of PR #21, finding 1: a page that starts during a Save locks at once with its load, not only at its
  // first state, so it sends no Save that the extension would drop.
  it('is read-only from a load with saving: true until a state without it', () => {
    const page = loadScript();
    page.receive({ type: 'load', seq: 3, generation: 1, entries: [ENTRY], notices: [], testName: '', saving: true });
    expect(page.byId('form').disabled).toBe(true);
    page.receive(state(3, { saving: true }));
    expect(page.byId('form').disabled).toBe(true);
    page.receive(state(3, { dirty: false }));
    expect(page.byId('form').disabled).toBe(false);
    // A load without a running Save unlocks too.
    page.receive(state(3, { saving: true }));
    page.receive({ type: 'load', seq: 3, generation: 2, entries: [ENTRY], notices: [], testName: '', saving: false });
    expect(page.byId('form').disabled).toBe(false);
  });

  // Review round 8 of PR #21, finding 5: while the draft is over the limits, no update is sent, so the test field waits.
  it('says that the test is paused while the draft is over the limits', () => {
    const page = loadScript();
    const long = { name: '', pattern: 'a'.repeat(EditorLimits.pattern + 1), flags: '' };
    page.receive({ type: 'load', seq: 0, generation: 0, entries: [long, ENTRY], notices: [], testName: '' });
    page.receive(state(0, { checks: [{ error: 'too long' }, {}], canSave: false, dirty: false }));
    const paused = 'The test is paused until the entries are within the limits.';
    expect(page.byId('test-paused').textContent).toBe(paused);
    const testName = page.byId('test-name');
    testName.value = 'web-shop';
    testName.dispatch('input');
    for (const timer of page.timers.splice(0)) timer();
    expect(page.posted.slice(1)).toEqual([]);
    expect(page.byId('test-paused').textContent).toBe(paused);
    // Shortening the entry sends the draft again, and the test runs again.
    const pattern = page.byId('entry-0-pattern');
    pattern.value = '^a';
    pattern.dispatch('input');
    for (const timer of page.timers.splice(0)) timer();
    expect(page.posted.slice(1)).toMatchObject([{ type: 'update', seq: 1, testName: 'web-shop' }]);
    expect(page.byId('test-paused').textContent).toBe('');
    // Adding an entry over the limits again (a load) pauses it; removing that entry ends the pause at once.
    page.receive({ type: 'load', seq: 1, generation: 1, entries: [long, ENTRY], notices: [], testName: '' });
    expect(page.byId('test-paused').textContent).toBe(paused);
    page.byId('entry-0-remove').dispatch('click');
    expect(page.byId('test-paused').textContent).toBe('');
  });

  // Review round 6 of PR #21, finding 2: the extension refuses more entries than EditorLimits.entries.
  it(`disables Add at ${EditorLimits.entries} entries`, () => {
    const page = loadScript();
    const entries = Array.from({ length: EditorLimits.entries - 1 }, (_value, index) => ({ name: '', pattern: `^e${index}`, flags: '' }));
    page.receive({ type: 'load', seq: 0, generation: 1, entries, notices: [], testName: '' });
    const add = page.byId('add');
    expect(add.disabled).toBe(false);
    add.dispatch('click');
    expect(page.posted[1]).toMatchObject({ type: 'update', seq: 1 });
    expect((page.posted[1].entries as unknown[]).length).toBe(EditorLimits.entries);
    expect(add.disabled).toBe(true);
    add.dispatch('click');
    expect(page.posted).toHaveLength(2);
    // Remove enables it again.
    page.byId(`entry-0-remove`).dispatch('click');
    expect(add.disabled).toBe(false);
  });
});
