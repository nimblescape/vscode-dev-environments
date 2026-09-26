// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Pure part of the editor of the setting `devEnvLauncher.repositoryGroups` (concept 6.2, 8): the entries as the editor
// shows them, their checks, the value that Save writes, the messages of the webview (checked, never trusted), the
// preview of the sidebar, and the test of one repository name. This module never imports `vscode`; the preview uses the
// same functions as the sidebar (parseRepositoryGroups, matchRepositoryGroup, buildTreeModel), so it shows what the
// sidebar will show. repositoryGroupsEditor.ts is the thin webview glue.
import { checkRepositoryGroupEntry, matchRepositoryGroup, parseRepositoryGroups } from './repositoryGroups';
import { buildTreeModel, repositoryRows, type GroupNode, type HintRow, type RepositoryRow, type TreeInput } from './treeModel';

/** The flags that the editor offers, in this order (the only flags that parseRepositoryGroups keeps). */
export const EDITOR_FLAGS = ['i', 'u', 's'] as const;

/** Limits of the webview messages; longer input is refused. */
export const EditorLimits = {
  entries: 200,
  name: 200,
  pattern: 5000,
  /** An owner (39 characters at most on GitHub), a slash, and a repository name (100 at most). */
  testName: 140,
} as const;

/** At most this many nodes of the tree are sent to the preview, over all owners; the rest is counted. */
export const MAX_PREVIEW_NODES = 2000;

/** One entry of the setting as the editor shows it. */
export interface EditorEntry {
  /** Optional name of the root node; empty for none. */
  name: string;
  pattern: string;
  /** Subset of `ius`, in that order. */
  flags: string;
  /**
   * Index of the element of the setting value that the editor loaded this entry from (the base of the merge at Save);
   * missing for an entry added in the editor.
   */
  origin?: number;
}

// User-visible texts that messages.ts lacks; to be moved there.
export const GroupsEditorTexts = {
  panelTitle: 'Repository Groups',
  wrongTypeLeftOut: (position: number) =>
    `Entry ${position} of the setting is neither a regular expression nor an object with "pattern" and optional "name" and "flags" texts. The editor does not show it, and Save removes it.`,
  ignoredFlagsLeftOut: (position: number, flags: string) =>
    `Entry ${position} of the setting uses the flags "${flags}", which are ignored (only i, u, and s are allowed). Save removes them.`,
  notAList: 'The setting is not a list. The editor starts with no entries, and Save asks before it replaces the value.',
  emptyPattern: 'Enter a regular expression.',
  invalidPattern: (error: string) => `This regular expression is not valid: ${error}`,
  patternTooLong: `The regular expression is longer than ${EditorLimits.pattern} characters.`,
  nameTooLong: `The name is longer than ${EditorLimits.name} characters.`,
  noCapturingGroup: 'No capturing group: this entry only filters. Its rows keep their names.',
  oneCapturingGroup: 'One capturing group: it is the label of the row. The entry makes no levels.',
  levels: (count: number) => `${count} capturing groups: ${count - 1} ${count - 1 === 1 ? 'level' : 'levels'}, then the label of the row.`,
  testNoMatch:
    'No entry matches. In an owner where another repository matches an entry, this repository is hidden, unless it has an environment.',
  testMatch: (position: number, name: string | undefined) =>
    `Entry ${position}${name !== undefined ? ` ("${name}")` : ''} matches.`,
  testInvalid: 'Enter the repository name without spaces, for example 2026-3cWI-SWP-module-oop-EnesHA81 or owner/name.',
  invalidEntriesNotSaved: 'Correct the entries with an error first. Nothing was saved.',
  conflict: (position: number) =>
    `Entry ${position} of devEnvLauncher.repositoryGroups was changed in this editor, but settings.json no longer has it unchanged. Which one do you want to keep?`,
  conflictDetail: (base: string, mine: string, theirs: string) =>
    `This editor: ${mine}\nsettings.json no longer has ${base} unchanged.\nsettings.json now: ${theirs}\nKeep Mine applies the change of this editor to that list; Keep settings.json leaves the list as it is.`,
  keepMine: 'Keep Mine',
  keepTheirs: 'Keep settings.json',
  saveCancelled: 'Nothing was saved.',
  saved: 'Saved to the user settings.',
  entryTooSlow:
    'This regular expression takes too long for the repository names of the view (for example a nested repetition such as (a+)+). It would make VS Code stop responding. Change it before you save.',
  previewTooSlow: 'The preview was stopped: the regular expressions took more than 1 second for the repository names of the view.',
  testTooSlow: 'The test was stopped: the regular expressions took more than 1 second for this name.',
  tooSlowNotSaved: 'A regular expression takes too long for the repository names of the view. Nothing was saved.',
  previewFailed: 'The preview could not check these regular expressions; Save is not possible.',
  notAListConflict: 'settings.json holds a value for devEnvLauncher.repositoryGroups that is not a list.',
  notAListDetail: (theirs: string) =>
    `settings.json now: ${theirs}\nReplace with Mine writes the entries of this editor instead of that value. Cancel saves nothing.`,
  replaceWithMine: 'Replace with Mine',
  orderConflict:
    'The entries of devEnvLauncher.repositoryGroups were moved both in this editor and in settings.json. Which order do you want to keep?',
  orderConflictDetail: 'The other changes of both sides are kept either way.',
  savedMerged: 'Saved to the user settings, together with the changes made in settings.json meanwhile.',
  slow: (milliseconds: number) =>
    `Grouping took ${milliseconds} ms. A regular expression may be slow, for example one with a nested repetition such as (a+)+.`,
} as const;

/** The flags of `flags` that the editor offers, once each, in the order `ius`. */
export function normalizeFlags(flags: string): string {
  return EDITOR_FLAGS.filter((flag) => flags.includes(flag)).join('');
}

/**
 * The entries of the setting value (the user settings) for the editor. Entries of the wrong type are left out, and flags
 * other than i, u, and s are dropped, each with a notice (the sidebar ignores them too). Entries with an empty or invalid
 * pattern are kept, so the user can correct them.
 */
export function entriesFromSetting(value: unknown): { entries: EditorEntry[]; notices: string[] } {
  if (value === undefined || value === null) return { entries: [], notices: [] };
  if (!Array.isArray(value)) return { entries: [], notices: [GroupsEditorTexts.notAList] };
  const entries: EditorEntry[] = [];
  const notices: string[] = [];
  value.forEach((entry: unknown, index) => {
    const { issues } = checkRepositoryGroupEntry(entry, index);
    if (issues.some((issue) => issue.kind === 'wrongType')) {
      notices.push(GroupsEditorTexts.wrongTypeLeftOut(index + 1));
      return;
    }
    const ignored = issues.find((issue) => issue.kind === 'ignoredFlags');
    if (ignored) notices.push(GroupsEditorTexts.ignoredFlagsLeftOut(index + 1, ignored.detail ?? ''));
    if (typeof entry === 'string') {
      entries.push({ name: '', pattern: entry, flags: '', origin: index });
      return;
    }
    const { name, pattern, flags } = entry as { name?: string; pattern: string; flags?: string };
    entries.push({ name: name ?? '', pattern, flags: normalizeFlags(flags ?? ''), origin: index });
  });
  return { entries, notices };
}

/**
 * The setting value that Save writes: a string for an entry without name and flags, otherwise an object with `pattern`
 * and only the `name` (trimmed) and `flags` that it has. Every entry gives one element, in order, so the index of an
 * entry in the editor is its index in the setting.
 */
export function toSettingValue(entries: readonly EditorEntry[]): Array<string | { name?: string; pattern: string; flags?: string }> {
  return entries.map((entry) => {
    const name = entry.name.trim();
    const flags = normalizeFlags(entry.flags);
    if (name === '' && flags === '') return entry.pattern;
    return { ...(name !== '' ? { name } : {}), pattern: entry.pattern, ...(flags !== '' ? { flags } : {}) };
  });
}

/** Result of the check of one entry: `error` keeps it from being saved; `note` describes it. */
export interface EntryCheck {
  error?: string;
  note?: string;
}

/**
 * Checks each entry with the rules of the sidebar (checkRepositoryGroupEntry, as parseRepositoryGroups does). The
 * parser does not need capturing groups: an entry without one only filters, which the note says.
 */
export function checkEntries(entries: readonly EditorEntry[]): EntryCheck[] {
  const values = toSettingValue(entries);
  return entries.map((entry, index) => {
    if (entry.pattern.length > EditorLimits.pattern) return { error: GroupsEditorTexts.patternTooLong };
    if (entry.name.length > EditorLimits.name) return { error: GroupsEditorTexts.nameTooLong };
    const { pattern, issues } = checkRepositoryGroupEntry(values[index], index);
    const problem = issues.find((issue) => issue.kind !== 'ignoredFlags');
    if (!pattern || problem) {
      if (problem?.kind === 'empty') return { error: GroupsEditorTexts.emptyPattern };
      return { error: GroupsEditorTexts.invalidPattern(problem?.detail ?? problem?.message ?? '') };
    }
    const groups = capturingGroups(pattern.source);
    const note =
      groups === 0 ? GroupsEditorTexts.noCapturingGroup : groups === 1 ? GroupsEditorTexts.oneCapturingGroup : GroupsEditorTexts.levels(groups);
    return { note };
  });
}

/** True when every entry can be saved. */
export function canSave(checks: readonly EntryCheck[]): boolean {
  return checks.every((check) => check.error === undefined);
}

/**
 * Number of capturing groups of a regular expression, counted in its source without running it (no regular expression
 * of the draft runs in the extension host): each `(` that is not escaped, not in a character class, and not followed by
 * `?`, except a named group `(?<name>`. The source is valid (checkRepositoryGroupEntry compiled it); the flags are i, u,
 * and s only, so a character class does not nest.
 */
export function capturingGroups(source: string): number {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') {
      i += 1;
    } else if (inClass) {
      if (char === ']') inClass = false;
    } else if (char === '[') {
      inClass = true;
    } else if (char === '(') {
      if (source[i + 1] !== '?') count += 1;
      else if (source[i + 2] === '<' && source[i + 3] !== '=' && source[i + 3] !== '!') count += 1;
    }
  }
  return count;
}

/** Two values of the setting are the same (a missing value is the empty list; key order does not count). */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  return stableJson(a ?? []) === stableJson(b ?? []);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ---- Messages of the webview ------------------------------------------------------------------------------------

/** Messages of the webview. Every message is checked with parseEditorRequest; anything else is dropped. */
export type EditorRequest =
  | { type: 'ready' }
  | { type: 'update'; seq: number; generation: number; entries: EditorEntry[]; testName: string }
  | { type: 'save'; seq: number; generation: number; entries: EditorEntry[] }
  | { type: 'reload' }
  | { type: 'cancel' }
  /** An update or Save for entries of an earlier load (their origins name another base): ignored. */
  | { type: 'stale' };

/**
 * The message of the webview, or `undefined` when it is not one of EditorRequest exactly: unknown types or properties,
 * wrong types, flags other than i, u, and s, and texts or lists over EditorLimits are refused. `generation` counts the
 * loads of the editor; an update or Save of another load is `stale`.
 */
export function parseEditorRequest(raw: unknown, context: { baseLength: number; generation: number }): EditorRequest | undefined {
  if (!isPlainObject(raw)) return undefined;
  switch (raw.type) {
    case 'ready':
    case 'reload':
    case 'cancel':
      return hasOnlyKeys(raw, ['type']) ? { type: raw.type } : undefined;
    case 'update':
    case 'save': {
      const keys = raw.type === 'update' ? ['type', 'seq', 'generation', 'entries', 'testName'] : ['type', 'seq', 'generation', 'entries'];
      if (!hasOnlyKeys(raw, keys) || !isSeq(raw.seq) || !isSeq(raw.generation)) return undefined;
      if (raw.generation !== context.generation) return { type: 'stale' };
      const entries = parseEntries(raw.entries, context.baseLength);
      if (!entries) return undefined;
      if (raw.type === 'save') return { type: 'save', seq: raw.seq, generation: raw.generation, entries };
      if (!isText(raw.testName, EditorLimits.testName)) return undefined;
      return { type: 'update', seq: raw.seq, generation: raw.generation, entries, testName: raw.testName };
    }
    default:
      return undefined;
  }
}

/** The entries of a message; an `origin` must be an index of the loaded setting value, at most once. */
function parseEntries(value: unknown, baseLength: number): EditorEntry[] | undefined {
  if (!Array.isArray(value) || value.length > EditorLimits.entries) return undefined;
  const entries: EditorEntry[] = [];
  const origins = new Set<number>();
  for (const item of value) {
    if (!isPlainObject(item)) return undefined;
    const keys = 'origin' in item ? ['name', 'pattern', 'flags', 'origin'] : ['name', 'pattern', 'flags'];
    if (!hasOnlyKeys(item, keys)) return undefined;
    const { name, pattern, flags, origin } = item;
    if (!isText(name, EditorLimits.name) || !isText(pattern, EditorLimits.pattern)) return undefined;
    if (typeof flags !== 'string' || !/^[ius]{0,3}$/.test(flags) || normalizeFlags(flags).length !== flags.length) return undefined;
    if (origin !== undefined) {
      if (!isSeq(origin) || origin >= baseLength || origins.has(origin)) return undefined;
      origins.add(origin);
    }
    entries.push({ name, pattern, flags: normalizeFlags(flags), ...(origin !== undefined ? { origin } : {}) });
  }
  return entries;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.every((key) => keys.includes(key)) && keys.every((key) => own.includes(key));
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// ---- Save: the changes of the editor as a patch -----------------------------------------------------------------

/**
 * A change of the editor that Save cannot apply without a question: settings.json no longer has the entry that the
 * editor edited or removed unchanged (it changed or removed it meanwhile, or it holds another number of equal copies,
 * so the copy cannot be told). The question shows the current list of settings.json.
 */
export interface MergeConflict {
  /** Index in the loaded value (the base). */
  baseIndex: number;
  /** The entry as the editor loaded it. */
  base: unknown;
  /** The entry of the editor; missing when the editor removed it. */
  mine?: unknown;
}

export type ConflictChoice = 'mine' | 'theirs';

/** The answers to the questions of Save: per base index, and for the order. */
export interface MergeChoices {
  entries?: ReadonlyMap<number, ConflictChoice>;
  order?: ConflictChoice;
  /** The value stored now is not a list, and the user chose to replace it with the entries of the editor. */
  replaceNotAList?: boolean;
}

export type MergeOutcome =
  /** `conflicts` and `orderConflict`: the questions that the choices answered. */
  | { status: 'merged'; value: unknown[]; conflicts: MergeConflict[]; orderConflict: boolean }
  /** Questions without an answer in the choices: the changes of entries, and whether both sides moved entries differently. */
  | { status: 'conflicts'; conflicts: MergeConflict[]; orderConflict: boolean }
  /** The value stored now is not a list (nor missing): Save must ask before it replaces it (`choices.replaceNotAList`). */
  | { status: 'notAList'; theirs: unknown };

/** An edit (`to` set) or a removal of the editor, of the base entry `baseIndex`. */
interface EditorChange {
  baseIndex: number;
  /** Position of the edited entry in the editor. */
  position?: number;
  to?: unknown;
  toKey?: string;
  /**
   * Only what loading did to the entry (flags other than i, u, and s dropped, an entry of the wrong type left out), not
   * a change of the user: applied when the entry is found in settings.json, otherwise dropped without a question.
   */
  loading: boolean;
}

/** One element of the stored value (settings.json) while the patch is applied. */
interface Cell {
  value: unknown;
  /** The base entry that this element is (located by its value, step 1 of mergeRepositoryGroups). */
  base?: number;
  removed?: boolean;
  /** An element that a Keep Mine answer already changed. */
  taken?: boolean;
  /** Entries of the editor inserted after this element, in order. */
  after: Item[];
}

interface Item {
  value: unknown;
}

/**
 * Save never overwrites settings.json. As the user put it: "it shall not overwrite, but read the settings and insert
 * the part that we want to change". So Save applies the changes of the editor as a patch to the value stored now; it
 * never guesses which element of settings.json is which entry of the editor.
 *
 * `base` is the value that the editor loaded (when it opened, or was last saved or loaded), `ours` the entries of the
 * editor, each with the `origin` it was loaded from (none when added), and `theirs` the value stored now. The patch is
 * the difference of the editor to the base: an edit or a removal of a base entry, an addition after the nearest entry
 * of the editor before it that has an origin, and a move (the entries with an origin are not in the order of the base).
 *
 * 1. Each base entry is located in `theirs` by its value (pattern, name, and flags as the editor compares them): the
 *    k-th copy of a value in the base is the k-th copy in `theirs`, but only when `theirs` has as many copies as the
 *    base; otherwise the entry is not located.
 * 2. An edit or removal of a located entry is applied in place.
 * 3. An edit or removal of an entry that is not located: when `theirs` made the same change (a removed value is gone
 *    from `theirs`; for an edit, `theirs` has one copy less of the old value and one more of the new value than the
 *    base), nothing is left to do. Otherwise it is a conflict, answered in `choices.entries` by base index: Keep Mine
 *    applies the change to a copy of the old value that `theirs` still holds (the nearest to the place of the entry:
 *    after the nearest located base entry before it), and otherwise inserts the new value as an addition is inserted;
 *    Keep settings.json drops the change.
 * 4. An addition goes after the nearest entry of the editor before it that is in the result (after the elements that
 *    settings.json holds right after that entry and that are not located); without one, at the start when an entry of
 *    the editor that is located follows it, otherwise at the end. An addition that `theirs` already made (it has more
 *    copies of the value than the base, not yet used by another change) is not added twice. No question.
 * 5. A move: when the editor has the located entries in another order than the base, and `theirs` still has them in
 *    the order of the base, they are put into the order of the editor; each takes along the elements that follow it in
 *    `theirs` up to the next such entry. When `theirs` has them in the order of the editor, nothing is to do. When
 *    `theirs` moved them too, one question (`orderConflict`, answered in `choices.order`).
 * 6. A stored value that is not a list is never patched: the outcome `notAList` asks first, and
 *    `choices.replaceNotAList` writes the entries of the editor instead.
 * 7. Without changes in the editor, the result is `theirs` as it is; when `theirs` equals the base, it is the entries
 *    of the editor exactly.
 *
 * The time is linear in the number of entries for the lookups by value (maps), plus the number of insertions times the
 * number of entries for their places; no two texts are compared for similarity.
 */
export function mergeRepositoryGroups(
  baseValue: unknown,
  ours: readonly EditorEntry[],
  theirsValue: unknown,
  choices: MergeChoices = {},
): MergeOutcome {
  const base = Array.isArray(baseValue) ? (baseValue as unknown[]) : [];
  if (theirsValue !== undefined && theirsValue !== null && !Array.isArray(theirsValue)) {
    // Not a list: nothing to patch, and never overwritten without a question.
    if (!choices.replaceNotAList) return { status: 'notAList', theirs: theirsValue };
    return { status: 'merged', value: toSettingValue(ours), conflicts: [], orderConflict: false };
  }
  const theirs = Array.isArray(theirsValue) ? (theirsValue as unknown[]) : [];
  const mine = toSettingValue(ours);
  const baseKeys = base.map(entryKey);
  const theirsKeys = theirs.map(entryKey);
  const mineKeys = mine.map(entryKey);
  const merged = (value: unknown[], conflicts: MergeConflict[] = [], orderConflict = false): MergeOutcome => ({
    status: 'merged',
    value,
    conflicts,
    orderConflict,
  });
  // settings.json is as the editor loaded it: the entries of the editor, exactly.
  if (sameKeys(theirsKeys, baseKeys)) return merged(mine);
  // settings.json already holds the entries of the editor (review round 2 of PR #21, F2): nothing to write.
  if (sameKeys(mineKeys, theirsKeys)) return merged([...theirs]);

  // The patch of the editor.
  const origins = ours.map((entry) => entry.origin);
  const positionOf = new Map<number, number>();
  origins.forEach((origin, position) => {
    if (origin !== undefined && Number.isInteger(origin) && origin >= 0 && origin < base.length && !positionOf.has(origin)) {
      positionOf.set(origin, position);
    } else {
      origins[position] = undefined;
    }
  });
  const changes: EditorChange[] = [];
  base.forEach((entry, baseIndex) => {
    const position = positionOf.get(baseIndex);
    if (position === undefined) {
      changes.push({ baseIndex, loading: loadedKey(entry) === undefined });
    } else if (mineKeys[position] !== baseKeys[baseIndex]) {
      changes.push({ baseIndex, position, to: mine[position], toKey: mineKeys[position], loading: mineKeys[position] === loadedKey(entry) });
    }
  });
  const additions = origins.flatMap((origin, position) => (origin === undefined ? [position] : []));
  const originOrder = origins.filter((origin): origin is number => origin !== undefined);
  if (changes.length === 0 && additions.length === 0 && isIncreasing(originOrder)) return merged([...theirs]);

  // 1. Locate the base entries in settings.json by value.
  const baseCount = countKeys(baseKeys);
  const theirsCount = countKeys(theirsKeys);
  const theirsPositions = new Map<string, number[]>();
  theirsKeys.forEach((key, position) => {
    const positions = theirsPositions.get(key);
    if (positions) positions.push(position);
    else theirsPositions.set(key, [position]);
  });
  const cells: Cell[] = theirs.map((value) => ({ value, after: [] }));
  const located = new Array<number | undefined>(base.length).fill(undefined);
  const copiesSeen = new Map<string, number>();
  baseKeys.forEach((key, baseIndex) => {
    const copy = copiesSeen.get(key) ?? 0;
    copiesSeen.set(key, copy + 1);
    if (baseCount.get(key) !== theirsCount.get(key)) return;
    const position = (theirsPositions.get(key) ?? [])[copy];
    located[baseIndex] = position;
    cells[position].base = baseIndex;
  });
  // The last element of the run of elements that are not located after each element.
  const runEnd = new Array<number>(cells.length);
  for (let position = cells.length - 1; position >= 0; position--) {
    runEnd[position] = position + 1 < cells.length && cells[position + 1].base === undefined ? runEnd[position + 1] : position;
  }
  // The place in settings.json of each base entry: after the run of the nearest located base entry before it.
  const basePlace = new Array<number>(base.length);
  let place = -0.5;
  base.forEach((_entry, baseIndex) => {
    basePlace[baseIndex] = place;
    const position = located[baseIndex];
    if (position !== undefined) place = runEnd[position] + 0.5;
  });

  // Copies of a value that settings.json added or removed, not yet used by a change of the editor that it also made.
  const used = { added: new Map<string, number>(), removed: new Map<string, number>() };
  const left = (kind: 'added' | 'removed', key: string) => {
    const delta = (theirsCount.get(key) ?? 0) - (baseCount.get(key) ?? 0);
    return (kind === 'added' ? delta : -delta) - (used[kind].get(key) ?? 0);
  };
  const use = (kind: 'added' | 'removed', key: string) => used[kind].set(key, (used[kind].get(key) ?? 0) + 1);
  /** The copy of `key` in settings.json nearest to `at`, that no answer changed yet. */
  const nearestCopy = (key: string, at: number): number | undefined => {
    let best: number | undefined;
    for (const position of theirsPositions.get(key) ?? []) {
      if (cells[position].removed || cells[position].taken) continue;
      if (best === undefined || Math.abs(position - at) <= Math.abs(best - at)) best = position;
    }
    return best;
  };

  // 2. and 3. Edits and removals.
  const conflicts: MergeConflict[] = [];
  const open: MergeConflict[] = [];
  const placedCell = new Map<number, number>();
  const insertLater = new Set<number>();
  origins.forEach((origin, position) => {
    if (origin !== undefined && located[origin] !== undefined) placedCell.set(position, located[origin] as number);
  });
  for (const change of changes) {
    const at = located[change.baseIndex];
    if (at !== undefined) {
      if (change.position === undefined) cells[at].removed = true;
      else cells[at].value = change.to;
      continue;
    }
    // settings.json changed or removed an entry that loading changed: its value stays.
    if (change.loading) continue;
    const from = baseKeys[change.baseIndex];
    if (change.position === undefined) {
      if (!theirsCount.has(from)) continue;
    } else if (change.toKey !== undefined && left('removed', from) > 0 && left('added', change.toKey) > 0) {
      use('removed', from);
      use('added', change.toKey);
      continue;
    }
    const conflict: MergeConflict = {
      baseIndex: change.baseIndex,
      base: base[change.baseIndex],
      ...(change.position !== undefined ? { mine: change.to } : {}),
    };
    conflicts.push(conflict);
    const choice = choices.entries?.get(change.baseIndex);
    if (choice === undefined) {
      open.push(conflict);
      continue;
    }
    if (choice === 'theirs') continue;
    const copy = nearestCopy(from, basePlace[change.baseIndex]);
    if (change.position === undefined) {
      if (copy !== undefined) cells[copy].removed = true;
    } else if (copy !== undefined) {
      cells[copy].value = change.to;
      cells[copy].taken = true;
      placedCell.set(change.position, copy);
    } else {
      insertLater.add(change.position);
    }
  }

  // 5. The order (decided before the questions are returned, so they are asked together).
  const moved = origins.flatMap((origin, position) =>
    origin !== undefined && located[origin] !== undefined ? [{ position, base: origin, cell: located[origin] as number }] : [],
  );
  const byCell = [...moved].sort((a, b) => a.cell - b.cell);
  let orderConflict = false;
  let reorder = false;
  if (!isIncreasing(moved.map((entry) => entry.base)) && byCell.some((entry, index) => entry !== moved[index])) {
    if (isIncreasing(byCell.map((entry) => entry.base))) {
      reorder = true;
    } else {
      orderConflict = true;
      reorder = choices.order === 'mine';
    }
  }
  const orderOpen = orderConflict && choices.order === undefined;
  if (open.length > 0 || orderOpen) return { status: 'conflicts', conflicts: open, orderConflict: orderOpen };

  // 4. Additions (and edits answered with Keep Mine whose entry settings.json no longer has), in the order of the editor.
  const start: Item[] = [];
  const end: Item[] = [];
  const placedItem = new Map<number, { list: Item[]; item: Item }>();
  const cellAfter = new Array<boolean>(ours.length + 1).fill(false);
  for (let position = ours.length - 1; position >= 0; position--) cellAfter[position] = cellAfter[position + 1] || placedCell.has(position);
  const insert = (position: number) => {
    const item: Item = { value: mine[position] };
    for (let before = position - 1; before >= 0; before--) {
      const cell = placedCell.get(before);
      if (cell !== undefined) {
        const list = cells[runEnd[cell]].after;
        list.push(item);
        placedItem.set(position, { list, item });
        return;
      }
      const anchor = placedItem.get(before);
      if (anchor) {
        anchor.list.splice(anchor.list.indexOf(anchor.item) + 1, 0, item);
        placedItem.set(position, { list: anchor.list, item });
        return;
      }
    }
    const list = cellAfter[position + 1] ? start : end;
    list.push(item);
    placedItem.set(position, { list, item });
  };
  ours.forEach((_entry, position) => {
    if (origins[position] === undefined) {
      if (left('added', mineKeys[position]) > 0) use('added', mineKeys[position]);
      else insert(position);
    } else if (insertLater.has(position)) {
      insert(position);
    }
  });

  const value: unknown[] = start.map((item) => item.value);
  const append = (from: number, to: number) => {
    for (let position = from; position < to; position++) {
      if (!cells[position].removed) value.push(cells[position].value);
      for (const item of cells[position].after) value.push(item.value);
    }
  };
  if (!reorder) {
    append(0, cells.length);
  } else {
    // Each located entry of the editor with the elements after it, up to the next one; in the order of the editor.
    append(0, byCell[0].cell);
    const until = new Map(byCell.map((entry, index) => [entry.cell, index + 1 < byCell.length ? byCell[index + 1].cell : cells.length]));
    for (const entry of moved) append(entry.cell, until.get(entry.cell) ?? cells.length);
  }
  for (const item of end) value.push(item.value);
  return merged(value, conflicts, orderConflict);
}

function isIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function countKeys(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/** The key of an element of the setting as the editor loads it (flags other than i, u, and s dropped); `undefined` for one that it leaves out. */
function loadedKey(entry: unknown): string | undefined {
  const fields = entryFieldsOf(entry);
  if (!fields) return undefined;
  return entryKey(toSettingValue([{ name: fields.name ?? '', pattern: fields.pattern, flags: normalizeFlags(fields.flags ?? '') }])[0]);
}

/** The name (trimmed, if any) and pattern of an element of the setting, or `undefined` for one of the wrong type. */
function entryFieldsOf(entry: unknown): { name?: string; pattern: string; flags?: string } | undefined {
  if (typeof entry === 'string') return { pattern: entry };
  if (!isPlainObject(entry)) return undefined;
  const { name, pattern, flags } = entry;
  if (typeof pattern !== 'string') return undefined;
  if (name !== undefined && typeof name !== 'string') return undefined;
  if (flags !== undefined && typeof flags !== 'string') return undefined;
  const trimmed = name?.trim();
  // The order of the flags and a repeated flag do not change the meaning ('si' is 'is').
  const sorted = [...new Set(flags ?? '')].sort().join('');
  return { ...(trimmed ? { name: trimmed } : {}), pattern, ...(sorted ? { flags: sorted } : {}) };
}

/**
 * Compares elements of the setting by what they mean: a string and `{ "pattern" }` with the same text are equal, a
 * name is trimmed, and an empty name or flags text counts as none. Elements of the wrong type compare as JSON.
 */
function entryKey(entry: unknown): string {
  const fields = entryFieldsOf(entry);
  if (!fields) return `invalid:${stableJson(entry ?? null)}`;
  // The texts with their lengths (unambiguous): no JSON of long patterns, so Save of long lists stays fast.
  const name = fields.name ?? '';
  return `${fields.pattern.length}:${fields.pattern}${name.length}:${name}${fields.flags ?? ''}`;
}

/** At most this many characters of the list of settings.json are shown in a question. */
const MAX_SHOWN_LIST = 2000;

/** A short text of the list of settings.json for the conflict question: one element per line, cut after MAX_SHOWN_LIST characters. */
export function describeSettingList(value: unknown): string {
  if (!Array.isArray(value)) return describeSettingEntry(value);
  if (value.length === 0) return '(no entries)';
  let text = '';
  for (const [index, entry] of value.entries()) {
    const line = `\n${index + 1}. ${describeSettingEntry(entry)}`;
    if (text.length + line.length > MAX_SHOWN_LIST) return `${text}\n… (${value.length - index} more)`;
    text += line;
  }
  return text;
}

/** A short text of an element of the setting for the conflict question. */
export function describeSettingEntry(entry: unknown): string {
  if (entry === undefined) return '(removed)';
  if (typeof entry === 'string') return JSON.stringify(entry);
  try {
    return JSON.stringify(entry) ?? String(entry);
  } catch {
    return String(entry);
  }
}

// ---- Preview ----------------------------------------------------------------------------------------------------

/** One node of the preview tree. */
export interface PreviewNode {
  kind: 'group' | 'repository' | 'hint';
  label: string;
  /** A row whose label is a capturing group: the repository name. A named root: its pattern. */
  detail?: string;
  /** A row with an environment. */
  environment?: boolean;
  /** A group node: expanded in the sidebar at first. */
  expanded?: boolean;
  children?: PreviewNode[];
}

export interface OwnerPreview {
  owner: string;
  /** A repository of the owner matches an entry: the owner is grouped and filtered; otherwise it keeps the plain list. */
  grouped: boolean;
  /** Repositories of the owner in the sidebar without the setting. */
  total: number;
  /** Per entry (index of the editor): the repositories that it takes (the first entry that matches wins). */
  counts: number[];
  /** Repositories that match no entry. */
  unmatched: number;
  /** Names of the repositories that the setting hides. */
  hidden: string[];
  /** Names of the repositories that match no entry but stay, because they have an environment (only when grouped). */
  keptWithEnvironment: string[];
  /** The children of the owner in the sidebar with the setting. */
  tree: PreviewNode[];
}

export interface GroupsPreview {
  /** False while the sidebar has no model input (not rendered yet). */
  loaded: boolean;
  owners: OwnerPreview[];
  /** Nodes left out after MAX_PREVIEW_NODES. */
  truncated: number;
  /** The regular expressions took longer than the time limit on the loaded names: no preview (PreviewRun). */
  tooSlow?: boolean;
}

/**
 * The sidebar with the entries of the editor, per owner: the counts per entry, the tree, and the repositories that are
 * hidden. `input` is the input of the last sidebar render (Sidebar.groupingInput): the repositories already loaded, no
 * GitHub request. The tree is buildTreeModel with the valid entries (parseRepositoryGroups of the value that Save
 * writes), exactly what the sidebar builds after Save.
 */
export function buildGroupsPreview(input: TreeInput | undefined, entries: readonly EditorEntry[]): GroupsPreview {
  if (!input) return { loaded: false, owners: [], truncated: 0 };
  const { patterns } = parseRepositoryGroups(toSettingValue(entries));
  const plain = buildTreeModel({ ...input, repositoryGroups: [] });
  const grouped = new Map(buildTreeModel({ ...input, repositoryGroups: patterns }).map((group) => [group.id, group]));
  const budget = { left: MAX_PREVIEW_NODES, truncated: 0 };
  const owners = plain.map((plainGroup): OwnerPreview => {
    const groupedGroup = grouped.get(plainGroup.id) ?? plainGroup;
    const rows = plainGroup.children.filter((child): child is RepositoryRow => child.kind === 'repository');
    const counts = entries.map(() => 0);
    let unmatched = 0;
    const unmatchedWithEnvironment: string[] = [];
    for (const row of rows) {
      const match = matchRepositoryGroup(patterns, row.name);
      if (match) {
        counts[match.pattern.index] += 1;
      } else {
        unmatched += 1;
        if (row.environment) unmatchedWithEnvironment.push(row.name);
      }
    }
    const isGrouped = unmatched < rows.length;
    const shown = new Set(repositoryRows([groupedGroup]).map((row) => row.id));
    return {
      owner: plainGroup.owner,
      grouped: isGrouped,
      total: rows.length,
      counts,
      unmatched,
      hidden: rows.filter((row) => !shown.has(row.id)).map((row) => row.name),
      keptWithEnvironment: isGrouped ? unmatchedWithEnvironment : [],
      tree: previewNodes(groupedGroup.children, budget),
    };
  });
  return { loaded: true, owners, truncated: budget.truncated };
}

function previewNodes(
  children: ReadonlyArray<RepositoryRow | HintRow | GroupNode>,
  budget: { left: number; truncated: number },
): PreviewNode[] {
  const nodes: PreviewNode[] = [];
  for (const child of children) {
    if (budget.left <= 0) {
      budget.truncated += countNodes(child);
      continue;
    }
    budget.left -= 1;
    if (child.kind === 'hint') {
      nodes.push({ kind: 'hint', label: child.label });
    } else if (child.kind === 'group') {
      nodes.push({
        kind: 'group',
        label: child.label,
        ...(child.tooltip !== undefined ? { detail: child.tooltip } : {}),
        expanded: child.expanded,
        children: previewNodes(child.children, budget),
      });
    } else {
      nodes.push({
        kind: 'repository',
        label: child.label,
        ...(child.label !== child.name ? { detail: child.name } : {}),
        ...(child.environment ? { environment: true } : {}),
      });
    }
  }
  return nodes;
}

function countNodes(node: RepositoryRow | HintRow | GroupNode): number {
  return node.kind === 'group' ? 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0) : 1;
}

// ---- Test of one name -------------------------------------------------------------------------------------------

export interface NameTest {
  matched: boolean;
  /** Index of the entry that matches (the first one). */
  entryIndex?: number;
  /** What the test says, for example `Entry 1 matches.` */
  text: string;
  /** The place of the row: the owner (when given), the name of the entry, the levels, and the label of the row. */
  path: string[];
}

/**
 * The entry that matches a repository name, with matchRepositoryGroup (first match wins), and the place of its row.
 * `owner/name` is accepted: the owner starts the path, and only the name is matched (as in the sidebar).
 * `undefined` for an empty text.
 */
export function testRepositoryName(entries: readonly EditorEntry[], text: string): NameTest | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const slash = trimmed.lastIndexOf('/');
  const owner = slash > 0 ? trimmed.slice(0, slash) : undefined;
  const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  if (name === '' || /\s/.test(name) || (owner !== undefined && /\s|\//.test(owner))) {
    return { matched: false, text: GroupsEditorTexts.testInvalid, path: [] };
  }
  const { patterns } = parseRepositoryGroups(toSettingValue(entries));
  const match = matchRepositoryGroup(patterns, name);
  if (!match) return { matched: false, text: GroupsEditorTexts.testNoMatch, path: [] };
  const path = [
    ...(owner !== undefined ? [owner] : []),
    ...(match.pattern.name !== undefined ? [match.pattern.name] : []),
    ...match.levels,
    match.label,
  ];
  return {
    matched: true,
    entryIndex: match.pattern.index,
    text: GroupsEditorTexts.testMatch(match.pattern.index + 1, match.pattern.name),
    path,
  };
}

// ---- Preview job (runs in a worker thread) ----------------------------------------------------------------------

/**
 * The work of the preview and the test field, which runs the regular expressions of the draft. It runs in a worker
 * thread (groupsPreviewWorker.ts) with a time limit (groupsPreviewRunner.ts), because a regular expression with a nested
 * repetition such as `(\w+)+$` can take seconds for one name and would stop the extension host.
 */
export interface PreviewJob {
  id: number;
  entries: EditorEntry[];
  testName: string;
  /** The sidebar input without functions (cloneableInput), or `undefined` before the first render. */
  input: TreeInput | undefined;
}

/** Messages of the worker: `probe` before each entry runs on all names, then the preview, then the test. */
export type PreviewJobMessage =
  | { type: 'probe'; id: number; entryIndex: number }
  | { type: 'preview'; id: number; preview: GroupsPreview }
  | { type: 'test'; id: number; test?: NameTest };

/** The result of a preview job for the editor: what finished within the time limit. */
export interface PreviewRun {
  preview?: GroupsPreview;
  test?: NameTest;
  /** The names of the view took too long: no preview; `slowEntry` is the entry that ran when the limit was reached. */
  previewTooSlow?: boolean;
  slowEntry?: number;
  /** The test name took too long (the preview finished). */
  testTooSlow?: boolean;
  /** The worker failed. */
  failed?: boolean;
}

/** The input of the sidebar for a worker message: without `formatTime`, which a structured clone cannot copy. */
export function cloneableInput(input: TreeInput | undefined): TreeInput | undefined {
  if (!input) return undefined;
  const { formatTime: _formatTime, ...rest } = input;
  return rest;
}

/**
 * Runs a preview job and reports each step through `post`: before an entry runs on all names of the view a `probe`
 * (so a stopped worker names the slow entry), then the preview, then the test of the name.
 */
export function runPreviewJob(job: PreviewJob, post: (message: PreviewJobMessage) => void): void {
  if (job.input) {
    const { patterns } = parseRepositoryGroups(toSettingValue(job.entries));
    const names = [...new Set(repositoryRows(buildTreeModel({ ...job.input, repositoryGroups: [] })).map((row) => row.name))];
    for (const pattern of patterns) {
      post({ type: 'probe', id: job.id, entryIndex: pattern.index });
      for (const name of names) pattern.regex.exec(name);
    }
  }
  post({ type: 'preview', id: job.id, preview: buildGroupsPreview(job.input, job.entries) });
  const test = testRepositoryName(job.entries, job.testName);
  post({ type: 'test', id: job.id, ...(test ? { test } : {}) });
}

// ---- State of the webview ---------------------------------------------------------------------------------------

/** Message to the webview: the entries to show (at the start, and after Load Setting or Save). */
export interface EditorLoadMessage {
  type: 'load';
  /** Counts the loads; the webview sends it back with its updates. */
  generation: number;
  entries: EditorEntry[];
  notices: string[];
  /** The text of the test field, so a restored webview shows the text of its result. */
  testName: string;
}

/** Message to the webview: everything the extension computes for the entries of the webview. */
export interface EditorStateMessage {
  type: 'state';
  /** The `seq` of the update that this state answers; the webview ignores older answers. */
  seq: number;
  checks: EntryCheck[];
  canSave: boolean;
  /** The entries differ from those that were loaded. */
  dirty: boolean;
  /** The setting was changed outside the editor since it was loaded. */
  changedOutside: boolean;
  preview: GroupsPreview;
  test?: NameTest;
  /** A text for the status line, for example after Save. */
  status?: string;
}

/** The state for the webview: the checks, and the preview and the test of a preview job (PreviewRun). */
export function editorState(options: {
  seq: number;
  entries: readonly EditorEntry[];
  loaded: readonly EditorEntry[];
  run: PreviewRun | undefined;
  changedOutside: boolean;
  status?: string;
}): EditorStateMessage {
  const run = options.run ?? {};
  const checks = checkEntries(options.entries).map((check, index) =>
    run.previewTooSlow && run.slowEntry === index && check.error === undefined ? { error: GroupsEditorTexts.entryTooSlow } : check,
  );
  const preview: GroupsPreview = run.previewTooSlow
    ? { loaded: true, owners: [], truncated: 0, tooSlow: true }
    : (run.preview ?? { loaded: false, owners: [], truncated: 0 });
  const test: NameTest | undefined = run.testTooSlow ? { matched: false, text: GroupsEditorTexts.testTooSlow, path: [] } : run.test;
  return {
    type: 'state',
    seq: options.seq,
    checks,
    // Save needs a run of the worker that checked these entries: a stopped or failed worker keeps it off.
    canSave: canSave(checks) && !run.previewTooSlow && !run.failed,
    dirty: !sameSettingValue(toSettingValue(options.entries), toSettingValue(options.loaded)),
    changedOutside: options.changedOutside,
    preview,
    ...(test ? { test } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
  };
}

/**
 * The HTML of the webview: a strict Content Security Policy (nothing by default; the style sheet and the script of the
 * extension only, the script only with the nonce), no remote content, no inline style or script.
 */
export function editorHtml(options: { cspSource: string; nonce: string; scriptUri: string; styleUri: string }): string {
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttribute(options.styleUri)}">
<title>${GroupsEditorTexts.panelTitle}</title>
</head>
<body>
<main>
<h1>${GroupsEditorTexts.panelTitle}</h1>
<p class="intro">Regular expressions (JavaScript syntax) that filter and group the repositories of the Dev Environments view. Each one is matched against the repository name without the owner; a repository goes under the first entry that matches. The capturing groups are the levels of the tree; the last one is the label of the row. In an owner where a repository matches, the repositories that match none are hidden, except those with an environment.</p>
<div id="notices" role="status" aria-live="polite"></div>
<div id="changed" class="banner" role="alert" hidden>
<span>The setting was changed in settings.json after this editor loaded it. Save applies your changes to the current setting. It asks only where settings.json changed or removed an entry that you changed too, or where both moved entries differently. Load Setting shows the current setting and discards your changes.</span>
<button type="button" id="reload" class="secondary">Load Setting</button>
</div>
<section aria-labelledby="entries-heading">
<h2 id="entries-heading">Entries</h2>
<p id="no-entries" class="muted" hidden>No entries: the view shows the plain list of each owner.</p>
<ol id="entries"></ol>
<button type="button" id="add">Add Entry</button>
</section>
<div class="actions">
<button type="button" id="save">Save</button>
<button type="button" id="cancel" class="secondary">Cancel</button>
<span id="status" role="status" aria-live="polite"></span>
</div>
<section aria-labelledby="test-heading">
<h2 id="test-heading">Test a Repository Name</h2>
<label for="test-name">Repository name (or owner/name)</label>
<input type="text" id="test-name" spellcheck="false" autocomplete="off" maxlength="${EditorLimits.testName}">
<div id="test-result" role="status" aria-live="polite"></div>
</section>
<section aria-labelledby="preview-heading">
<h2 id="preview-heading">Preview</h2>
<p class="muted">The repositories that the Dev Environments view has loaded, grouped with these entries. Repositories with an environment are always shown.</p>
<div id="preview"></div>
</section>
</main>
<script nonce="${escapeAttribute(options.nonce)}" src="${escapeAttribute(options.scriptUri)}"></script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
