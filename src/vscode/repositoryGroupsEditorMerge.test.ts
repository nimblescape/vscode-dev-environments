// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Save of the repository groups editor as a patch (review round 3 of PR #21): the cases of the three review rounds, the
// properties for random changes on both sides, and the time for long lists.
import { describe, expect, it } from 'vitest';
import {
  entriesFromSetting,
  mergeRepositoryGroups,
  toSettingValue,
  type ConflictChoice,
  type EditorEntry,
  type MergeChoices,
  type MergeConflict,
  type MergeOutcome,
} from './repositoryGroupsEditorModel';

const load = (base: unknown[]) => entriesFromSetting(base).entries;
const merged = (value: unknown[]) => ({ status: 'merged', value, conflicts: [], orderConflict: false });
const answer = (entries: Array<[number, ConflictChoice]>, order?: ConflictChoice): MergeChoices => ({
  entries: new Map(entries),
  ...(order ? { order } : {}),
});

describe('cases of review round 3 of PR #21', () => {
  // N2: the same edit on both sides next to an addition was a question, and Keep Mine wrote the entry twice.
  it('N2: asks nothing when both sides made the same edit, also next to an addition', () => {
    const s1 = ['^c'];
    expect(mergeRepositoryGroups(s1, [{ ...load(s1)[0], pattern: '^abc' }], ['^abc', '^x'])).toEqual(merged(['^abc', '^x']));
    const s2 = ['^web-(.+)$'];
    expect(mergeRepositoryGroups(s2, [{ ...load(s2)[0], pattern: '^api-(.+)$' }], ['^api-(.+)$', '^x'])).toEqual(merged(['^api-(.+)$', '^x']));
    const s3 = [{ name: 'Web', pattern: '^web-' }, '^tools-'];
    const [web, tools] = load(s3);
    expect(mergeRepositoryGroups(s3, [{ ...web, name: 'Frontend', pattern: '^fe-' }, tools], [{ name: 'Frontend', pattern: '^fe-' }])).toEqual(
      merged([{ name: 'Frontend', pattern: '^fe-' }]),
    );
  });

  // N3: of equal copies, a removal of the editor came back without a question when settings.json changed a copy.
  describe('N3: asks when settings.json holds another number of copies of a removed entry', () => {
    it('D1: the editor removes the first of two copies, settings.json edits one', () => {
      const base = ['^a', '^a'];
      const [, copy] = load(base);
      const theirs = ['^a', '^a2'];
      expect(mergeRepositoryGroups(base, [copy], theirs)).toEqual({ status: 'conflicts', conflicts: [{ baseIndex: 0, base: '^a' }], orderConflict: false });
      expect(mergeRepositoryGroups(base, [copy], theirs, answer([[0, 'mine']]))).toMatchObject({ status: 'merged', value: ['^a2'] });
      expect(mergeRepositoryGroups(base, [copy], theirs, answer([[0, 'theirs']]))).toMatchObject({ status: 'merged', value: ['^a', '^a2'] });
    });

    it('D2: the editor removes the second of two copies, settings.json names one', () => {
      const base = ['^a', '^a'];
      const [copy] = load(base);
      const theirs = [{ name: 'M', pattern: '^a' }, '^a'];
      expect(mergeRepositoryGroups(base, [copy], theirs)).toEqual({ status: 'conflicts', conflicts: [{ baseIndex: 1, base: '^a' }], orderConflict: false });
      expect(mergeRepositoryGroups(base, [copy], theirs, answer([[1, 'mine']]))).toMatchObject({ value: [{ name: 'M', pattern: '^a' }] });
      expect(mergeRepositoryGroups(base, [copy], theirs, answer([[1, 'theirs']]))).toMatchObject({ value: theirs });
    });

    it('D3: the editor removes a copy and another entry, settings.json edits a copy', () => {
      const base = ['^abc', '^abc', '^ab'];
      const [copy] = load(base);
      const theirs = ['^b', '^abc', '^ab'];
      // ^ab is found and removed; the copy of ^abc cannot be told.
      expect(mergeRepositoryGroups(base, [copy], theirs)).toEqual({ status: 'conflicts', conflicts: [{ baseIndex: 1, base: '^abc' }], orderConflict: false });
      expect(mergeRepositoryGroups(base, [copy], theirs, answer([[1, 'mine']]))).toMatchObject({ value: ['^b'] });
      expect(mergeRepositoryGroups(base, [copy], theirs, answer([[1, 'theirs']]))).toMatchObject({ value: ['^b', '^abc'] });
    });

    it('duplicate on answer: Keep Mine writes each entry of the editor once', () => {
      const base = ['^a', '^a'];
      const [, copy] = load(base);
      const ours = [{ ...copy, pattern: '^m' }];
      const theirs = ['^a', '^a2'];
      expect(mergeRepositoryGroups(base, ours, theirs)).toEqual({
        status: 'conflicts',
        conflicts: [
          { baseIndex: 0, base: '^a' },
          { baseIndex: 1, base: '^a', mine: '^m' },
        ],
        orderConflict: false,
      });
      expect(mergeRepositoryGroups(base, ours, theirs, answer([[0, 'mine'], [1, 'mine']]))).toMatchObject({ value: ['^a2', '^m'] });
      expect(mergeRepositoryGroups(base, ours, theirs, answer([[0, 'theirs'], [1, 'mine']]))).toMatchObject({ value: ['^m', '^a2'] });
      expect(mergeRepositoryGroups(base, ours, theirs, answer([[0, 'theirs'], [1, 'theirs']]))).toMatchObject({ value: theirs });
    });

    it('P1: a removed copy asks, a removed entry that settings.json edited does not', () => {
      const base = ['^b2', '^b2', '^a'];
      const [, copy] = load(base);
      const theirs = ['^b2', '^abc'];
      expect(mergeRepositoryGroups(base, [copy], theirs)).toEqual({ status: 'conflicts', conflicts: [{ baseIndex: 0, base: '^b2' }], orderConflict: false });
      expect(mergeRepositoryGroups(base, [copy], theirs, answer([[0, 'mine']]))).toMatchObject({ value: ['^abc'] });
      expect(mergeRepositoryGroups(base, [copy], theirs, answer([[0, 'theirs']]))).toMatchObject({ value: theirs });
    });
  });

  // M4 of round 1: what loading did to an entry (other flags dropped, an entry of the wrong type left out) is applied
  // only where settings.json still has the entry, and never asks.
  it('applies what loading did only to entries that settings.json did not change', () => {
    const base = [{ pattern: 'a', flags: 'gi' }];
    expect(mergeRepositoryGroups(base, load(base), [{ name: 'N', pattern: 'a', flags: 'gi' }])).toEqual(merged([{ name: 'N', pattern: 'a', flags: 'gi' }]));
    expect(mergeRepositoryGroups(base, load(base), [])).toEqual(merged([]));
    expect(mergeRepositoryGroups(base, load(base), [{ pattern: 'a', flags: 'gi' }, 'b'])).toEqual(merged([{ pattern: 'a', flags: 'i' }, 'b']));
    const typed = [42, 'a'];
    expect(mergeRepositoryGroups(typed, load(typed), ['b', 'a'])).toEqual(merged(['b', 'a']));
    expect(mergeRepositoryGroups(typed, load(typed), [42, 'a', 'b'])).toEqual(merged(['a', 'b']));
  });
});

describe('cases of review round 2 of PR #21', () => {
  const BASE = ['^a', '^b', '^c'];

  // F1: settings.json added ^y and edited ^b to ^b2, between the same neighbors.
  it('F1: keeps the addition and the edit of settings.json', () => {
    const [a, b, c] = load(BASE);
    const theirs = ['^a', '^y', '^b2', '^c'];
    // The editor removed ^b: it is gone from settings.json already.
    expect(mergeRepositoryGroups(BASE, [a, c], theirs)).toEqual(merged(theirs));
    // The editor edited ^b: a question, which shows the list of settings.json; nothing of it is lost.
    const ours = [a, { ...b, pattern: '^bm' }, c];
    expect(mergeRepositoryGroups(BASE, ours, theirs)).toEqual({
      status: 'conflicts',
      conflicts: [{ baseIndex: 1, base: '^b', mine: '^bm' }],
      orderConflict: false,
    });
    expect(mergeRepositoryGroups(BASE, ours, theirs, answer([[1, 'mine']]))).toMatchObject({ value: ['^a', '^y', '^b2', '^bm', '^c'] });
    expect(mergeRepositoryGroups(BASE, ours, theirs, answer([[1, 'theirs']]))).toMatchObject({ value: theirs });
  });

  it('F2 case 1: both sides removed a copy of ^d', () => {
    const base = ['^d', '^d'];
    const [d1, d2] = load(base);
    expect(mergeRepositoryGroups(base, [d2], ['^d'])).toEqual(merged(['^d']));
    expect(mergeRepositoryGroups(base, [d1], ['^d'])).toEqual(merged(['^d']));
  });
});

describe('cases of review round 1 of PR #21', () => {
  it('L: settings.json added a copy of the entry that the editor edits: a question, and the edit replaces one copy', () => {
    const base = ['a', 'b'];
    const [a, b] = load(base);
    const ours = [a, { ...b, pattern: 'b2' }];
    expect(mergeRepositoryGroups(base, ours, ['b', 'a', 'b'])).toEqual({
      status: 'conflicts',
      conflicts: [{ baseIndex: 1, base: 'b', mine: 'b2' }],
      orderConflict: false,
    });
    expect(mergeRepositoryGroups(base, ours, ['b', 'a', 'b'], answer([[1, 'mine']]))).toMatchObject({ value: ['b', 'a', 'b2'] });
  });

  it('M: settings.json added a copy, the editor moved entries: no question about the order', () => {
    const base = ['a', 'b', 'c'];
    const [a, b, c] = load(base);
    // ^c is not found (two copies now); the moved entries take the elements after them along.
    expect(mergeRepositoryGroups(base, [b, a, c], ['c', 'a', 'b', 'c'])).toEqual(merged(['c', 'b', 'c', 'a']));
  });

  it('B: settings.json removed the first of two copies, the editor moved an entry: no question about the order', () => {
    const base = ['a', 'b', 'a', 'c'];
    const [a1, b, a2, c] = load(base);
    expect(mergeRepositoryGroups(base, [c, a1, b, a2], ['b', 'a', 'c'])).toEqual(merged(['c', 'b', 'a']));
  });

  it('C: settings.json removed one of two copies, the editor edited the last: a question', () => {
    const base = ['a', 'b', 'a'];
    const [a1, b, a2] = load(base);
    const ours = [a1, b, { ...a2, pattern: 'a2' }];
    expect(mergeRepositoryGroups(base, ours, ['b', 'a'])).toEqual({
      status: 'conflicts',
      conflicts: [{ baseIndex: 2, base: 'a', mine: 'a2' }],
      orderConflict: false,
    });
    expect(mergeRepositoryGroups(base, ours, ['b', 'a'], answer([[2, 'mine']]))).toMatchObject({ value: ['b', 'a2'] });
    expect(mergeRepositoryGroups(base, ours, ['b', 'a'], answer([[2, 'theirs']]))).toMatchObject({ value: ['b', 'a'] });
  });

  it('H: the only move of the editor is of an entry that settings.json moved too, after removing another', () => {
    const base = ['a', 'b', 'c', 'd'];
    const [a, b, c] = load(base);
    expect(mergeRepositoryGroups(base, [b, c, a], ['d', 'a', 'b', 'c'])).toEqual(merged(['b', 'c', 'a']));
  });

  it('S: the only move of the editor is of an entry that settings.json removed: no question about the order', () => {
    const base = ['a', 'b', 'c'];
    const [a, b, c] = load(base);
    expect(mergeRepositoryGroups(base, [c, a, b], ['b', 'a'])).toEqual(merged(['b', 'a']));
  });
});

// ---- Properties for random changes -------------------------------------------------------------------------------

/** A seeded generator of numbers in [0, 1) (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An element of a side with its identity: the base index it stems from, or none for an addition. */
interface Item {
  origin?: number;
  value: unknown;
}

/** The meaning of an element: the form that the editor writes. */
const keyOf = (value: unknown) => JSON.stringify(toSettingValue(entriesFromSetting([value]).entries)[0]);

function countKeys(values: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(keyOf(value), (counts.get(keyOf(value)) ?? 0) + 1);
  return counts;
}

interface Scenario {
  base: unknown[];
  theirsItems: Item[];
  mineItems: Item[];
}

/** Random changes: removals, additions, moves, and edits (an edit keeps the identity). */
function change(random: () => number, list: Item[], fresh: () => unknown): Item[] {
  const pick = (n: number) => Math.floor(random() * n);
  const result = [...list];
  for (let steps = pick(5); steps > 0; steps--) {
    const step = pick(4);
    if (step === 0 && result.length > 0) result.splice(pick(result.length), 1);
    else if (step === 1) result.splice(pick(result.length + 1), 0, { value: fresh() });
    else if (step === 2 && result.length > 1) result.splice(pick(result.length), 0, ...result.splice(pick(result.length), 1));
    else if (step === 3 && result.length > 0) {
      const at = pick(result.length);
      result[at] = { origin: result[at].origin, value: fresh() };
    }
  }
  return result;
}

/** Scenarios with few different values, so equal entries, copies, and equal changes on both sides are frequent. */
function collidingScenario(random: () => number): Scenario {
  const pick = (n: number) => Math.floor(random() * n);
  const PATTERNS = ['^a', '^b', '^c', '^b2', '^ab', '^abc', '^web-(.+)$', '^web2-(.+)$'];
  const NAMES = ['', '', 'N', 'M'];
  const entry = (): unknown => {
    const pattern = PATTERNS[pick(PATTERNS.length)];
    const name = NAMES[pick(NAMES.length)];
    const flags = pick(6) === 0 ? 'i' : '';
    return name === '' && flags === '' ? pattern : { ...(name ? { name } : {}), pattern, ...(flags ? { flags } : {}) };
  };
  const base = Array.from({ length: pick(7) }, entry);
  const items = base.map((value, origin) => ({ origin, value }));
  return {
    base,
    theirsItems: pick(5) === 0 ? items : change(random, items, entry),
    mineItems: pick(5) === 0 ? items : change(random, items, entry),
  };
}

/**
 * Scenarios with distinct values, and new values that are not in the base, plus the same changes on both sides (the
 * same edit or removal of an entry, the same addition): the cases in which Save must not ask.
 */
function distinctScenario(random: () => number): Scenario {
  const pick = (n: number) => Math.floor(random() * n);
  let next = 0;
  const fresh = (): unknown => (pick(3) === 0 ? { name: `N${next}`, pattern: `^n${next++}` } : `^n${next++}`);
  const base = Array.from({ length: pick(8) }, (_, index) => (index % 3 === 1 ? { name: `B${index}`, pattern: `^p${index}` } : `^p${index}`));
  const items = base.map((value, origin) => ({ origin, value }));
  let theirsItems = pick(6) === 0 ? items : change(random, items, fresh);
  let mineItems = pick(6) === 0 ? items : change(random, items, fresh);
  // The same change on both sides.
  for (let shared = pick(3); shared > 0 && base.length > 0; shared--) {
    const origin = pick(base.length);
    const kind = pick(3);
    if (kind === 0) {
      theirsItems = theirsItems.filter((item) => item.origin !== origin);
      mineItems = mineItems.filter((item) => item.origin !== origin);
    } else if (kind === 1) {
      const value = fresh();
      const edit = (list: Item[]) => list.map((item) => (item.origin === origin ? { origin, value } : item));
      theirsItems = edit(theirsItems);
      mineItems = edit(mineItems);
    } else {
      const value = fresh();
      theirsItems = [...theirsItems];
      mineItems = [...mineItems];
      theirsItems.splice(pick(theirsItems.length + 1), 0, { value });
      mineItems.splice(pick(mineItems.length + 1), 0, { value });
    }
  }
  return { base, theirsItems, mineItems };
}

/** The entries of the editor for the items of the editor: loaded from the value, with the origin of the item. */
function editorEntries(items: readonly Item[]): EditorEntry[] {
  return items.map((item) => {
    const { origin: _origin, ...entry } = entriesFromSetting([item.value]).entries[0];
    return item.origin === undefined ? entry : { ...entry, origin: item.origin };
  });
}

const isIncreasing = (values: readonly number[]) => values.every((value, index) => index === 0 || value > values[index - 1]);

/**
 * Save must not ask about the entries when the sides touched different entries or made the same change, as far as the
 * values tell: the values are distinct on each side, and no side made a value of the base anew. Returns whether that
 * holds, and whether Save may ask about the order (both sides moved the entries that both kept, differently).
 */
function expectsNoEntryQuestion(scenario: Scenario): { applies: boolean; orderMayAsk: boolean } {
  const { base, theirsItems, mineItems } = scenario;
  const baseKeys = base.map(keyOf);
  const distinct = (keys: string[]) => new Set(keys).size === keys.length;
  const baseKeySet = new Set(baseKeys);
  const changedTo = (items: Item[]) =>
    items.filter((item) => item.origin === undefined || keyOf(item.value) !== baseKeys[item.origin]).map((item) => keyOf(item.value));
  let applies =
    distinct(baseKeys) &&
    distinct(theirsItems.map((item) => keyOf(item.value))) &&
    distinct(mineItems.map((item) => keyOf(item.value))) &&
    [...changedTo(theirsItems), ...changedTo(mineItems)].every((key) => !baseKeySet.has(key));
  const state = (items: Item[], origin: number) => {
    const item = items.find((candidate) => candidate.origin === origin);
    return item === undefined ? 'removed' : keyOf(item.value) === baseKeys[origin] ? 'unchanged' : `edited:${keyOf(item.value)}`;
  };
  base.forEach((_value, origin) => {
    const theirs = state(theirsItems, origin);
    const mine = state(mineItems, origin);
    if (theirs !== 'unchanged' && mine !== 'unchanged' && theirs !== mine) applies = false;
  });
  const keptByBoth = (items: Item[], other: Item[]) =>
    items.flatMap((item) => (item.origin !== undefined && other.some((candidate) => candidate.origin === item.origin) ? [item.origin] : []));
  const mineOrder = keptByBoth(mineItems, theirsItems);
  const theirsOrder = keptByBoth(theirsItems, mineItems);
  const orderMayAsk = !isIncreasing(mineOrder) && !isIncreasing(theirsOrder) && mineOrder.join() !== theirsOrder.join();
  return { applies, orderMayAsk };
}

/** Runs Save with random answers and checks the properties (a) to (f); returns what was checked. */
function checkScenario(scenario: Scenario, random: () => number): { asked: boolean; noQuestionCase: boolean } {
  const { base, theirsItems, mineItems } = scenario;
  const theirs = theirsItems.map((item) => item.value);
  const ours = editorEntries(mineItems);
  const mine = toSettingValue(ours);
  const context = JSON.stringify({ base, mine, origins: ours.map((entry) => entry.origin ?? null), theirs });

  const first = mergeRepositoryGroups(base, ours, theirs);
  expect(first.status, context).not.toBe('notAList');
  if (first.status === 'notAList') return { asked: false, noQuestionCase: false };
  const choices = new Map<number, ConflictChoice>();
  let order: ConflictChoice | undefined;
  let outcome: MergeOutcome = first;
  if (first.status === 'conflicts') {
    for (const conflict of first.conflicts) choices.set(conflict.baseIndex, random() < 0.5 ? 'mine' : 'theirs');
    if (first.orderConflict) order = random() < 0.5 ? 'mine' : 'theirs';
    outcome = mergeRepositoryGroups(base, ours, theirs, { entries: choices, ...(order ? { order } : {}) });
  }
  expect(outcome.status, context).toBe('merged');
  if (outcome.status !== 'merged') return { asked: false, noQuestionCase: false };
  // The questions of the answered run are the questions that were asked.
  if (first.status === 'conflicts') {
    expect(outcome.conflicts, context).toEqual(first.conflicts);
    expect(outcome.orderConflict, context).toBe(first.orderConflict);
  }
  const result = outcome.value;
  const detail = `${context} -> ${JSON.stringify(result)} answers ${JSON.stringify([...choices])} order ${order}`;

  // (a) The editor changed nothing: settings.json exactly.
  const untouched = mineItems.length === base.length && mineItems.every((item, index) => item.origin === index && item.value === base[index]);
  if (untouched) expect(first, detail).toEqual({ status: 'merged', value: theirs, conflicts: [], orderConflict: false });
  // (b) settings.json is as loaded: the entries of the editor exactly.
  if (theirsItems.length === base.length && theirsItems.every((item, index) => item.origin === index && item.value === base[index])) {
    expect(first, detail).toEqual({ status: 'merged', value: mine, conflicts: [], orderConflict: false });
  }

  // (c), (d), (e) on the number of copies of each value. Per side and value: the entries that the side made with it
  // (added, or edited to it), and the base entries with it that the side removed or edited to another value. A change
  // of the editor answered with Keep settings.json is not one. Additions of the same value on both sides may be one
  // (Save does not add an entry that settings.json already added). Two sides that changed a base entry with a value
  // that the base holds once changed the same entry; of a value with copies in the base, which copy a side changed
  // cannot be told, so both readings count.
  const baseKeys = base.map(keyOf);
  const b = countKeys(base);
  const m = countKeys(mine);
  const t = countKeys(theirs);
  const r = countKeys(result);
  const keptMine = new Set(
    (outcome.conflicts as MergeConflict[]).filter((conflict) => choices.get(conflict.baseIndex) === 'theirs').map((conflict) => conflict.baseIndex),
  );
  const sideChanges = (items: Item[], undone: ReadonlySet<number>) => {
    const made = new Map<string, number>();
    const consumed = new Set<number>();
    const stays = new Set<number>();
    for (const item of items) {
      if (item.origin !== undefined && undone.has(item.origin)) {
        stays.add(item.origin);
        continue;
      }
      if (item.origin !== undefined && keyOf(item.value) === baseKeys[item.origin]) {
        stays.add(item.origin);
        continue;
      }
      if (item.origin !== undefined) stays.add(item.origin), consumed.add(item.origin);
      made.set(keyOf(item.value), (made.get(keyOf(item.value)) ?? 0) + 1);
    }
    base.forEach((_value, origin) => {
      if (!stays.has(origin) && !undone.has(origin)) consumed.add(origin);
    });
    return { made, consumed };
  };
  const theirsSide = sideChanges(theirsItems, new Set());
  const mineSide = sideChanges(mineItems, keptMine);
  // settings.json removed an entry and made one with the same value: in its value, nothing changed.
  const sameValue = (key: string) =>
    Math.min(theirsSide.made.get(key) ?? 0, [...theirsSide.consumed].filter((origin) => baseKeys[origin] === key).length);
  // The same edit of the same entry on both sides, where the entry can be told: made once.
  const editedBoth = new Map<string, number>();
  for (const item of mineItems) {
    if (item.origin === undefined || keptMine.has(item.origin) || keyOf(item.value) === baseKeys[item.origin]) continue;
    const other = theirsItems.find((candidate) => candidate.origin === item.origin);
    const from = baseKeys[item.origin];
    if (!other || keyOf(other.value) !== keyOf(item.value) || (b.get(from) ?? 0) > 1 || sameValue(from) > 0 || sameValue(keyOf(item.value)) > 0) continue;
    editedBoth.set(keyOf(item.value), (editedBoth.get(keyOf(item.value)) ?? 0) + 1);
  }
  for (const key of new Set([...b.keys(), ...m.keys(), ...t.keys(), ...r.keys()])) {
    const inBase = b.get(key) ?? 0;
    const ofKey = (consumed: Set<number>) => [...consumed].filter((origin) => baseKeys[origin] === key);
    const goneTheirs = ofKey(theirsSide.consumed);
    const goneM = ofKey(mineSide.consumed);
    const same = sameValue(key);
    const madeT = (theirsSide.made.get(key) ?? 0) - same;
    const goneT = goneTheirs.length - same;
    const madeM = mineSide.made.get(key) ?? 0;
    const both = goneTheirs.filter((origin) => goneM.includes(origin)).length;
    const told = inBase <= 1 && same === 0;
    const leastBoth = told ? both : Math.max(0, goneT + goneM.length - inBase);
    const mostBoth = told ? both : Math.min(goneT, goneM.length);
    const fewest = inBase - (goneT + goneM.length - leastBoth);
    const most = inBase - (goneT + goneM.length - mostBoth) + madeT + madeM - (editedBoth.get(key) ?? 0);
    const got = r.get(key) ?? 0;
    const at = `${key}: base ${inBase}, settings.json made ${madeT} and removed ${goneT}, the editor made ${madeM} and removed ${
      goneM.length
    } (${both} the same), result ${got} in ${detail}`;
    // (c) Every change of settings.json survives: what it made, and what it removed.
    expect(got, `(c) made: ${at}`).toBeGreaterThanOrEqual(fewest + madeT);
    expect(got, `(c) removed: ${at}`).toBeLessThanOrEqual(inBase - goneT + madeT + madeM);
    // (d) Every change of the editor survives, unless answered with Keep settings.json.
    expect(got, `(d) made: ${at}`).toBeGreaterThanOrEqual(fewest + madeM);
    expect(got, `(d) removed: ${at}`).toBeLessThanOrEqual(inBase - goneM.length + madeT + madeM);
    // (e) Nothing that neither side has, and no more copies than the base and both sides make together.
    if (got > 0) expect((m.get(key) ?? 0) + (t.get(key) ?? 0), `(e) ${at}`).toBeGreaterThan(0);
    expect(got, `(e) ${at}`).toBeLessThanOrEqual(most);
  }

  // (f) No question when the sides touched different entries or made the same change.
  const { applies, orderMayAsk } = expectsNoEntryQuestion(scenario);
  if (applies) {
    const firstConflicts = first.status === 'conflicts' ? first.conflicts : [];
    expect(firstConflicts, `(f) ${detail}`).toEqual([]);
    if (!orderMayAsk) expect(first.status === 'conflicts' && first.orderConflict, `(f) ${detail}`).toBe(false);
  }
  return { asked: first.status === 'conflicts', noQuestionCase: applies };
}

describe('properties of Save for random changes on both sides', () => {
  it.each([
    ['few different values (copies and equal changes)', collidingScenario, 20260926],
    ['distinct values and the same changes on both sides', distinctScenario, 4242],
  ])('holds for 3000 scenarios with %s', (_name, scenario, seed) => {
    const random = mulberry32(seed);
    let asked = 0;
    let noQuestionCases = 0;
    for (let round = 0; round < 3000; round++) {
      const checked = checkScenario(scenario(random), random);
      if (checked.asked) asked += 1;
      if (checked.noQuestionCase) noQuestionCases += 1;
    }
    // The scenarios reach both kinds of cases.
    expect(asked).toBeGreaterThan(100);
    expect(noQuestionCases).toBeGreaterThan(300);
  }, 30_000);

  it('writes settings.json as it is when the editor changed nothing, and the editor exactly when settings.json is as loaded', () => {
    const random = mulberry32(7);
    for (let round = 0; round < 3000; round++) {
      const { base, theirsItems, mineItems } = collidingScenario(random);
      const theirs = theirsItems.map((item) => item.value);
      expect(mergeRepositoryGroups(base, load(base), theirs), JSON.stringify({ base, theirs })).toEqual(merged(theirs));
      const ours = editorEntries(mineItems);
      expect(mergeRepositoryGroups(base, ours, [...base]), JSON.stringify({ base, ours })).toEqual(merged(toSettingValue(ours)));
    }
  });
});

describe('time of Save for long lists', () => {
  it('merges 1000 entries of 1000 characters in less than 50 ms', () => {
    const random = mulberry32(99);
    const pick = (n: number) => Math.floor(random() * n);
    const text = (label: string) => `^${label}-` + 'x'.repeat(1000 - label.length - 2);
    const base = Array.from({ length: 1000 }, (_, index) => (index % 4 === 0 ? { name: `Group ${index}`, pattern: text(`g${index}`) } : text(`g${index}`)));
    // settings.json: every third entry edited, 100 added, 50 removed, and 20 moved.
    const theirs: unknown[] = base.map((value, index) => (index % 3 === 0 ? text(`t${index}`) : value));
    for (let count = 0; count < 100; count++) theirs.splice(pick(theirs.length + 1), 0, text(`added-t${count}`));
    for (let count = 0; count < 50; count++) theirs.splice(pick(theirs.length), 1);
    for (let count = 0; count < 20; count++) theirs.splice(pick(theirs.length), 0, ...theirs.splice(pick(theirs.length), 1));
    // The editor: every fifth entry edited, 100 added, 50 removed, and 20 moved.
    const entries: EditorEntry[] = load(base).map((entry, index) => (index % 5 === 0 ? { ...entry, pattern: text(`m${index}`) } : entry));
    for (let count = 0; count < 100; count++) entries.splice(pick(entries.length + 1), 0, { name: '', pattern: text(`added-m${count}`), flags: '' });
    for (let count = 0; count < 50; count++) entries.splice(pick(entries.length), 1);
    for (let count = 0; count < 20; count++) entries.splice(pick(entries.length), 0, ...entries.splice(pick(entries.length), 1));
    // Warm up the code of the merge, then take the slowest of the runs.
    mergeRepositoryGroups(base.slice(0, 10), entries.filter((entry) => (entry.origin ?? 0) < 10), theirs.slice(0, 10));
    let slowest = 0;
    const timed = (stored: unknown[], choices?: MergeChoices) => {
      const started = performance.now();
      const outcome = mergeRepositoryGroups(base, entries, stored, choices);
      slowest = Math.max(slowest, performance.now() - started);
      return outcome;
    };
    // As stored, and the reversed list (moved on both sides).
    for (const stored of [theirs, [...theirs].reverse()]) {
      const questions = timed(stored);
      expect(questions.status).toBe('conflicts');
      if (questions.status !== 'conflicts') continue;
      for (const choice of ['mine', 'theirs'] as const) {
        const entryChoices = new Map(questions.conflicts.map((conflict) => [conflict.baseIndex, choice]));
        expect(timed(stored, { entries: entryChoices, order: choice }).status).toBe('merged');
      }
    }
    expect(slowest).toBeLessThan(50);
  });
});
