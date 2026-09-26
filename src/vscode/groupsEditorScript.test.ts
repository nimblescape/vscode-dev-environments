// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The script of the webview (resources/groupsEditor/editor.js) in a small stand-in of the DOM (review finding 7): a
// change that waits for its delay is sent when the tab is hidden, and a load restores the test name and the generation.
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it } from 'vitest';

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
  replaceChildren(...children: StubElement[]): void {
    this.children = children;
  }
  setAttribute(): void {}
  appendChild(child: StubElement): void {
    this.children.push(child);
  }
  focus(): void {}
}

function loadScript() {
  const elements = new Map<string, StubElement>();
  const document = Object.assign(new StubElement(), {
    visibilityState: 'visible',
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, new StubElement());
      return elements.get(id);
    },
    createElement: () => new StubElement(),
  });
  const window = new StubElement();
  const posted: Array<Record<string, unknown>> = [];
  const timers: Array<() => void> = [];
  const context = vm.createContext({
    document,
    window,
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message) }),
    setTimeout: (callback: () => void) => timers.push(callback),
    clearTimeout: () => {},
  });
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'groupsEditor', 'editor.js'), 'utf8');
  vm.runInContext(source, context);
  return { elements, document, window, posted, timers };
}

describe('editor.js', () => {
  it('asks for the load at the start, and restores the test name and the generation of a load', () => {
    const page = loadScript();
    expect(page.posted).toEqual([{ type: 'ready' }]);
    page.window.dispatch('message', { data: { type: 'load', generation: 3, entries: [], notices: [], testName: 'school/web-shop' } });
    expect(page.elements.get('test-name')?.value).toBe('school/web-shop');
    page.elements.get('save')?.dispatch('click');
    expect(page.posted[1]).toEqual({ type: 'save', seq: 1, generation: 3, entries: [] });
  });

  it('sends a waiting change at once when the tab is hidden or the page goes away', () => {
    const page = loadScript();
    page.window.dispatch('message', { data: { type: 'load', generation: 0, entries: [], notices: [], testName: '' } });
    const testName = page.elements.get('test-name');
    if (!testName) throw new Error('no test field');
    testName.value = 'web-shop';
    testName.dispatch('input');
    expect(page.posted).toHaveLength(1);
    page.document.visibilityState = 'hidden';
    page.document.dispatch('visibilitychange');
    expect(page.posted[1]).toEqual({ type: 'update', seq: 1, generation: 0, entries: [], testName: 'web-shop' });
    // Nothing waits any more: no second message.
    page.window.dispatch('pagehide');
    expect(page.posted).toHaveLength(2);
    testName.dispatch('input');
    page.window.dispatch('pagehide');
    expect(page.posted[2]).toMatchObject({ type: 'update', seq: 2 });
  });
});
