// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { DOUBLE_CLICK_INTERVAL_MS, RowActivationTracker, activatedRow, normalizeListOpenMode } from './rowActivation';
import { rowActions } from './treeModel';

describe('RowActivationTracker (double-click on a repository row)', () => {
  /** A tracker whose activations name their time. */
  function tracker(): { activate: (rowId: string, at: number) => boolean } {
    let time = 0;
    const rows = new RowActivationTracker({ now: () => time });
    return {
      activate: (rowId, at) => {
        time = at;
        return rows.activate(rowId, 'singleClick');
      },
    };
  }

  it('waits 500 ms for the second click', () => {
    expect(DOUBLE_CLICK_INTERVAL_MS).toBe(500);
  });

  it('counts a single click as no double-click', () => {
    expect(tracker().activate('repo:acme/api', 1000)).toBe(false);
  });

  it('counts a second activation of the same row within the interval as a double-click', () => {
    const rows = tracker();
    expect(rows.activate('repo:acme/api', 1000)).toBe(false);
    expect(rows.activate('repo:acme/api', 1000 + DOUBLE_CLICK_INTERVAL_MS)).toBe(true);
  });

  it('counts no double-click across rows, or slower than the interval', () => {
    const rows = tracker();
    expect(rows.activate('repo:acme/api', 1000)).toBe(false);
    expect(rows.activate('repo:acme/web', 1100)).toBe(false);
    expect(rows.activate('repo:acme/api', 1200)).toBe(false);
    expect(rows.activate('repo:acme/api', 1201 + DOUBLE_CLICK_INTERVAL_MS)).toBe(false);
    // A clock that went back.
    expect(rows.activate('repo:acme/api', 1000)).toBe(false);
  });

  it('starts over after a double-click, so a triple click is one double-click', () => {
    const rows = tracker();
    expect([100, 200, 300].map((at) => rows.activate('repo:acme/api', at))).toEqual([false, true, false]);
    // The third click begins a new pair.
    expect(rows.activate('repo:acme/api', 400)).toBe(true);
  });

  it('counts every activation in the mode doubleClick, where VS Code sends only double-clicks and Enter', () => {
    const rows = new RowActivationTracker({ now: () => 0 });
    expect(rows.activate('repo:acme/api', 'doubleClick')).toBe(true);
    expect(rows.activate('repo:acme/api', 'doubleClick')).toBe(true);
    // A single click after a switch to singleClick starts a new pair.
    expect(rows.activate('repo:acme/api', 'singleClick')).toBe(false);
  });
});

describe('normalizeListOpenMode', () => {
  it('reads doubleClick, and everything else as the default singleClick', () => {
    expect(normalizeListOpenMode('doubleClick')).toBe('doubleClick');
    for (const value of ['singleClick', undefined, null, 'DoubleClick', 2]) expect(normalizeListOpenMode(value)).toBe('singleClick');
  });
});

describe('activatedRow', () => {
  it('takes the id and the Start flag of a repository row', () => {
    const row = { kind: 'repository', id: 'repo:acme/api', repository: 'acme/api' };
    expect(activatedRow({ ...row, actions: rowActions('stopped', undefined) })).toEqual({ id: 'repo:acme/api', canStart: true });
    expect(activatedRow({ ...row, actions: rowActions('connected', undefined) })).toEqual({ id: 'repo:acme/api', canStart: false });
    expect(activatedRow({ ...row, actions: rowActions('updating', undefined) })).toEqual({ id: 'repo:acme/api', canStart: false });
    expect(activatedRow(row)).toEqual({ id: 'repo:acme/api', canStart: true });
  });

  it('ignores everything else', () => {
    for (const argument of [undefined, null, 'repo:acme/api', { kind: 'owner', id: 'owner:acme' }, { kind: 'repository', id: '' }, { kind: 'repository' }]) {
      expect(activatedRow(argument)).toBeUndefined();
    }
  });
});
