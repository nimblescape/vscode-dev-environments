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
    `Entry ${position} of devEnvLauncher.repositoryGroups was changed both in this editor and in settings.json. Which one do you want to keep?`,
  conflictDetail: (base: string, mine: string, theirs: string) =>
    `When the editor loaded it: ${base}\nThis editor: ${mine}\nsettings.json now: ${theirs}`,
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

// ---- Merge at Save ----------------------------------------------------------------------------------------------

/**
 * An element of the setting that both the editor and settings.json changed differently since the editor loaded it
 * (`mine` or `theirs` missing: removed on that side). Save asks which one to keep, for this element only.
 */
export interface MergeConflict {
  /** Index in the loaded value (the base). */
  baseIndex: number;
  base: unknown;
  mine?: unknown;
  theirs?: unknown;
}

export type ConflictChoice = 'mine' | 'theirs';

/** The answers to the questions of a merge: per base index, and for the order. */
export interface MergeChoices {
  entries?: ReadonlyMap<number, ConflictChoice>;
  order?: ConflictChoice;
  /** The value stored now is not a list, and the user chose to replace it with the entries of the editor. */
  replaceNotAList?: boolean;
}

export type MergeOutcome =
  | { status: 'merged'; value: unknown[]; conflicts: MergeConflict[]; orderConflict: boolean }
  /** Questions without an answer in the choices: the entries, and whether both sides moved entries differently. */
  | { status: 'conflicts'; conflicts: MergeConflict[]; orderConflict: boolean }
  /** The value stored now is not a list (nor missing): Save must ask before it replaces it (`choices.replaceNotAList`). */
  | { status: 'notAList'; theirs: unknown };

type SideState = { kind: 'unchanged' } | { kind: 'removed' } | { kind: 'edited'; value: unknown };

type Token = { kind: 'base'; index: number } | { kind: 'new'; value: unknown };

/**
 * Save never overwrites a change made in settings.json meanwhile: a 3-way merge of the setting value by the identity of
 * the entries. `base` is the value that the editor loaded (when it opened, or was last saved or loaded), `ours` the
 * entries of the editor (each with the `origin` it was loaded from, none when added), and `theirs` the value stored
 * now. The elements of `theirs` are matched to the base first in order, then over the whole list (alignToBase), so an
 * entry that settings.json only moved keeps its identity. Per identity: the change of the one side that changed it wins; the same
 * change on both sides is no conflict; different changes (also removed on one side and edited on the other) are a
 * conflict, answered in `choices.entries` by base index. Additions of both sides stay, with their multiplicity (an entry
 * that both sides added once is written once). The order: the order of the side that moved entries; when both moved
 * entries differently, a question (`orderConflict`, answered in `choices.order`); otherwise the order of settings.json.
 * Whether a side moved entries is decided on the entries that both sides kept. The entries that only the other side
 * has are placed after their predecessor on that side. A stored value that is not a list is never merged: the outcome
 * `notAList` asks first, and `choices.replaceNotAList` writes the entries of the editor instead.
 */
export function mergeRepositoryGroups(
  baseValue: unknown,
  ours: readonly EditorEntry[],
  theirsValue: unknown,
  choices: MergeChoices = {},
): MergeOutcome {
  const base = Array.isArray(baseValue) ? (baseValue as unknown[]) : [];
  if (theirsValue !== undefined && theirsValue !== null && !Array.isArray(theirsValue)) {
    // Not a list: nothing to merge with, and never overwritten without a question.
    if (!choices.replaceNotAList) return { status: 'notAList', theirs: theirsValue };
    return { status: 'merged', value: toSettingValue(ours), conflicts: [], orderConflict: false };
  }
  const theirs = Array.isArray(theirsValue) ? (theirsValue as unknown[]) : [];
  const baseKeys = base.map(entryKey);
  const oursValues = toSettingValue(ours);
  // Both sides have the same entries in the same order: nothing to merge, settings.json stays as it is (review round 2
  // of PR #21, F2).
  if (oursValues.length === theirs.length && oursValues.every((value, position) => entryKey(value) === entryKey(theirs[position]))) {
    return { status: 'merged', value: [...theirs], conflicts: [], orderConflict: false };
  }

  // The editor: its entries with a valid origin are the base elements (possibly edited); the others are additions.
  const oursTokens: Token[] = [];
  const oursByOrigin = new Map<number, unknown>();
  ours.forEach((entry, position) => {
    const origin = entry.origin;
    if (origin !== undefined && Number.isInteger(origin) && origin >= 0 && origin < base.length && !oursByOrigin.has(origin)) {
      oursByOrigin.set(origin, oursValues[position]);
      oursTokens.push({ kind: 'base', index: origin });
    } else {
      oursTokens.push({ kind: 'new', value: oursValues[position] });
    }
  });

  // settings.json: its elements matched to the base by content, over the whole list. Of equal copies in the base, the
  // ones that the editor kept are preferred, so a copy that both sides removed is the same copy (review round 2 of
  // PR #21, F2).
  const theirsOrigins = alignToBase(base, theirs, new Set(oursByOrigin.keys()));
  const theirsByOrigin = new Map<number, unknown>();
  const theirsTokens: Token[] = theirs.map((value, position) => {
    const origin = theirsOrigins[position];
    if (origin === undefined) return { kind: 'new', value };
    theirsByOrigin.set(origin, value);
    return { kind: 'base', index: origin };
  });

  const state = (side: Map<number, unknown>, index: number): SideState => {
    if (!side.has(index)) return { kind: 'removed' };
    const value = side.get(index);
    return entryKey(value) === baseKeys[index] ? { kind: 'unchanged' } : { kind: 'edited', value };
  };

  const conflicts: MergeConflict[] = [];
  const unresolved: MergeConflict[] = [];
  const decided = new Map<number, { keep: true; value: unknown } | { keep: false }>();
  base.forEach((baseEntry, index) => {
    const mine = state(oursByOrigin, index);
    const other = state(theirsByOrigin, index);
    const valueOf = (side: SideState, values: Map<number, unknown>) =>
      side.kind === 'removed' ? ({ keep: false } as const) : ({ keep: true, value: values.get(index) } as const);
    if (mine.kind === 'unchanged') return decided.set(index, valueOf(other, theirsByOrigin));
    if (other.kind === 'unchanged') return decided.set(index, valueOf(mine, oursByOrigin));
    if (mine.kind === 'removed' && other.kind === 'removed') return decided.set(index, { keep: false });
    if (mine.kind === 'edited' && other.kind === 'edited' && entryKey(mine.value) === entryKey(other.value)) {
      return decided.set(index, { keep: true, value: other.value });
    }
    const conflict: MergeConflict = {
      baseIndex: index,
      base: baseEntry,
      ...(mine.kind === 'edited' ? { mine: mine.value } : {}),
      ...(other.kind === 'edited' ? { theirs: other.value } : {}),
    };
    conflicts.push(conflict);
    const choice = choices.entries?.get(index);
    if (choice === undefined) {
      unresolved.push(conflict);
      return decided.set(index, { keep: false });
    }
    return decided.set(index, choice === 'mine' ? valueOf(mine, oursByOrigin) : valueOf(other, theirsByOrigin));
  });

  // The order: of the side that moved entries; a question when both moved them differently. Whether a side moved
  // entries is decided on the entries that both sides kept, against their order in the base: an entry that one side
  // removed does not make a move of the other side (review round 2 of PR #21, M3).
  const inOurs = new Set(oursByOrigin.keys());
  const inTheirs = new Set(theirsByOrigin.keys());
  const common = (tokens: Token[], other: Set<number>) =>
    tokens.flatMap((token) => (token.kind === 'base' && other.has(token.index) ? [token.index] : []));
  const oursCommon = common(oursTokens, inTheirs);
  const theirsCommon = common(theirsTokens, inOurs);
  const oursMoved = isReordered(oursCommon);
  const theirsMoved = isReordered(theirsCommon);
  let orderConflict = false;
  let skeletonSide: ConflictChoice = oursMoved ? 'mine' : 'theirs';
  if (oursMoved && theirsMoved) {
    orderConflict = oursCommon.join(',') !== theirsCommon.join(',');
    if (orderConflict) skeletonSide = choices.order ?? 'mine';
  }
  const orderUnresolved = orderConflict && choices.order === undefined;
  if (unresolved.length > 0 || orderUnresolved) return { status: 'conflicts', conflicts: unresolved, orderConflict: orderUnresolved };

  const kept = (token: Token) => token.kind === 'new' || decided.get(token.index)?.keep === true;
  const [skeleton, other] = skeletonSide === 'mine' ? [oursTokens, theirsTokens] : [theirsTokens, oursTokens];
  const merged: Token[] = skeleton.filter(kept);
  // Additions of the skeleton side, per entry: an equal addition of the other side is the same entry.
  const unmatchedNew = new Map<string, number>();
  for (const token of merged) {
    if (token.kind === 'new') unmatchedNew.set(entryKey(token.value), (unmatchedNew.get(entryKey(token.value)) ?? 0) + 1);
  }
  let last = -1;
  for (const token of other) {
    if (token.kind === 'base') {
      const at = merged.findIndex((placed) => placed.kind === 'base' && placed.index === token.index);
      if (at >= 0) {
        last = at;
        continue;
      }
      if (!kept(token)) continue;
    } else {
      const key = entryKey(token.value);
      const left = unmatchedNew.get(key) ?? 0;
      if (left > 0) {
        unmatchedNew.set(key, left - 1);
        last = merged.findIndex((placed) => placed.kind === 'new' && entryKey(placed.value) === key);
        continue;
      }
    }
    merged.splice(last + 1, 0, token);
    last += 1;
  }
  const value = merged.map((token) => {
    if (token.kind === 'new') return token.value;
    const decision = decided.get(token.index);
    return decision?.keep ? decision.value : undefined;
  });
  return { status: 'merged', value, conflicts, orderConflict };
}

/** The base indices are not in increasing order: the entries were moved. */
function isReordered(indices: readonly number[]): boolean {
  return indices.some((index, position) => position > 0 && index < indices[position - 1]);
}

/**
 * For each element of `theirs`, the index of the base element it stems from, or `undefined` for an addition. First the
 * equal entries in order (a longest common subsequence of both lists), so an entry that settings.json added or removed
 * next to an equal one does not look like a move (review round 2 of PR #21, M2). Then the rest over the whole list, so a
 * moved entry keeps its identity: equal entries (each base entry once, so duplicates keep their multiplicity), then
 * entries with the same pattern, then with the same name; last, the remaining entries after the same matched neighbor
 * (an entry whose pattern and name both changed, also next to an addition): in order when both sides have as many,
 * otherwise only the pairs whose patterns are clearly the most similar (`similarPairs`); the rest count as removed and
 * added, so no entry of settings.json is dropped for a wrong guess (review round 2 of PR #21, F1). Of equal copies in
 * the base, the `preferred` ones (that the editor kept) are matched first (F2).
 */
function alignToBase(base: readonly unknown[], theirs: readonly unknown[], preferred: ReadonlySet<number>): Array<number | undefined> {
  const origins = new Array<number | undefined>(theirs.length).fill(undefined);
  const used = new Set<number>();
  const pass = (same: (baseIndex: number, theirsIndex: number) => boolean) => {
    theirs.forEach((_value, j) => {
      if (origins[j] !== undefined) return;
      const free = (candidate: number) => !used.has(candidate) && same(candidate, j);
      let i = base.findIndex((_entry, candidate) => preferred.has(candidate) && free(candidate));
      if (i < 0) i = base.findIndex((_entry, candidate) => free(candidate));
      if (i < 0) return;
      origins[j] = i;
      used.add(i);
    });
  };
  const baseKeys = base.map(entryKey);
  const theirsKeys = theirs.map(entryKey);
  const baseFields = base.map(entryFieldsOf);
  const theirsFields = theirs.map(entryFieldsOf);
  for (const [i, j] of commonSubsequence(baseKeys, theirsKeys, (i) => preferred.has(i))) {
    origins[j] = i;
    used.add(i);
  }
  pass((i, j) => baseKeys[i] === theirsKeys[j]);
  pass((i, j) => baseFields[i] !== undefined && baseFields[i]?.pattern === theirsFields[j]?.pattern);
  pass((i, j) => baseFields[i]?.name !== undefined && baseFields[i]?.name === theirsFields[j]?.name);

  // Neighbors: the position in `theirs` of the nearest matched entry before.
  const theirsPositionOf = new Map<number, number>();
  origins.forEach((origin, j) => origin !== undefined && theirsPositionOf.set(origin, j));
  const baseAnchor = (i: number) => {
    for (let k = i - 1; k >= 0; k--) if (theirsPositionOf.has(k)) return theirsPositionOf.get(k) ?? -1;
    return -1;
  };
  const theirsAnchor = (j: number) => {
    for (let k = j - 1; k >= 0; k--) if (origins[k] !== undefined) return k;
    return -1;
  };
  const leftBase = new Map<number, number[]>();
  base.forEach((_entry, i) => {
    if (used.has(i)) return;
    const anchor = baseAnchor(i);
    leftBase.set(anchor, [...(leftBase.get(anchor) ?? []), i]);
  });
  const leftTheirs = new Map<number, number[]>();
  theirs.forEach((_value, j) => {
    if (origins[j] !== undefined) return;
    const anchor = theirsAnchor(j);
    leftTheirs.set(anchor, [...(leftTheirs.get(anchor) ?? []), j]);
  });
  const textOf = (entry: unknown) => entryFieldsOf(entry)?.pattern ?? entryKey(entry);
  for (const [anchor, baseIndices] of leftBase) {
    const theirsIndices = leftTheirs.get(anchor) ?? [];
    if (baseIndices.length === theirsIndices.length) {
      // As many entries on both sides between the same neighbors: each one was edited in place.
      baseIndices.forEach((i, k) => (origins[theirsIndices[k]] = i));
      continue;
    }
    // Otherwise the pairing in order would be a guess (review round 2 of PR #21, F1): only an entry whose pattern is
    // clearly the most similar one on both sides is the same entry; the others count as removed and added.
    for (const [i, j] of similarPairs(
      baseIndices.map((i) => textOf(base[i])),
      theirsIndices.map((j) => textOf(theirs[j])),
    )) {
      origins[theirsIndices[j]] = baseIndices[i];
    }
  }
  return origins;
}

/**
 * Pairs texts of `a` and `b` that are similar (more than half of the longer text in common, as a subsequence) and the
 * single most similar one for each other (the smallest edit distance by insertions and deletions, without a tie).
 */
function similarPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const distance = a.map((x) =>
    b.map((y) => {
      const common = commonSubsequence([...x], [...y]).length;
      return 2 * common > Math.max(x.length, y.length) ? x.length + y.length - 2 * common : Infinity;
    }),
  );
  const pairs: Array<[number, number]> = [];
  const freeA = new Set(a.keys());
  const freeB = new Set(b.keys());
  const nearest = (candidates: Set<number>, distanceTo: (k: number) => number): number | undefined => {
    let best: number | undefined;
    let tie = false;
    for (const k of candidates) {
      const d = distanceTo(k);
      if (d === Infinity) continue;
      if (best === undefined || d < distanceTo(best)) {
        best = k;
        tie = false;
      } else if (d === distanceTo(best)) {
        tie = true;
      }
    }
    return tie ? undefined : best;
  };
  for (let found = true; found; ) {
    found = false;
    for (const i of freeA) {
      const j = nearest(freeB, (k) => distance[i][k]);
      if (j === undefined || nearest(freeA, (k) => distance[k][j]) !== i) continue;
      pairs.push([i, j]);
      freeA.delete(i);
      freeB.delete(j);
      found = true;
    }
  }
  return pairs;
}

/**
 * The index pairs of a longest common subsequence of `a` and `b`, in order. Of the longest ones, the one with the most
 * elements of `a` that are `preferred`, then the first of equal choices.
 */
function commonSubsequence(
  a: readonly string[],
  b: readonly string[],
  preferred: (i: number) => boolean = () => false,
): Array<[number, number]> {
  const width = b.length + 1;
  // A match counts more than all preferred elements together.
  const weight = (i: number) => a.length + 1 + (preferred(i) ? 1 : 0);
  // lengths[i * width + j]: the weight of a best common subsequence of a[i..] and b[j..].
  const lengths = new Float64Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const skip = Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      lengths[i * width + j] = a[i] === b[j] ? Math.max(skip, weight(i) + lengths[(i + 1) * width + j + 1]) : skip;
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j] && weight(i) + lengths[(i + 1) * width + j + 1] === lengths[i * width + j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
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
  return stableJson(entryFieldsOf(entry) ?? { invalid: entry ?? null });
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
<span>The setting was changed in settings.json after this editor loaded it. Save adds your changes to it and asks only about entries that were changed on both sides. Load Setting shows the current setting and discards your changes.</span>
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
