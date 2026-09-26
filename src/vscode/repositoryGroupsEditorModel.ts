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
  testName: 300,
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
  notAList: 'The setting is not a list. The editor starts with no entries, and Save replaces the value.',
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
    const groups = capturingGroups(pattern.regex);
    const note =
      groups === 0 ? GroupsEditorTexts.noCapturingGroup : groups === 1 ? GroupsEditorTexts.oneCapturingGroup : GroupsEditorTexts.levels(groups);
    return { note };
  });
}

/** True when every entry can be saved. */
export function canSave(checks: readonly EntryCheck[]): boolean {
  return checks.every((check) => check.error === undefined);
}

/** Number of capturing groups of a regular expression (the empty alternative always matches). */
function capturingGroups(regex: RegExp): number {
  try {
    return (new RegExp(`${regex.source}|`, regex.flags).exec('')?.length ?? 1) - 1;
  } catch {
    return 0;
  }
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
  | { type: 'update'; seq: number; entries: EditorEntry[]; testName: string }
  | { type: 'save'; seq: number; entries: EditorEntry[] }
  | { type: 'reload' }
  | { type: 'cancel' };

/**
 * The message of the webview, or `undefined` when it is not one of EditorRequest exactly: unknown types or properties,
 * wrong types, flags other than i, u, and s, and texts or lists over EditorLimits are refused.
 */
export function parseEditorRequest(raw: unknown, context: { baseLength: number }): EditorRequest | undefined {
  if (!isPlainObject(raw)) return undefined;
  switch (raw.type) {
    case 'ready':
    case 'reload':
    case 'cancel':
      return hasOnlyKeys(raw, ['type']) ? { type: raw.type } : undefined;
    case 'update': {
      if (!hasOnlyKeys(raw, ['type', 'seq', 'entries', 'testName']) || !isSeq(raw.seq)) return undefined;
      const entries = parseEntries(raw.entries, context.baseLength);
      if (!entries || !isText(raw.testName, EditorLimits.testName)) return undefined;
      return { type: 'update', seq: raw.seq, entries, testName: raw.testName };
    }
    case 'save': {
      if (!hasOnlyKeys(raw, ['type', 'seq', 'entries']) || !isSeq(raw.seq)) return undefined;
      const entries = parseEntries(raw.entries, context.baseLength);
      return entries ? { type: 'save', seq: raw.seq, entries } : undefined;
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

export type MergeOutcome =
  | { status: 'merged'; value: unknown[]; conflicts: MergeConflict[] }
  | { status: 'conflicts'; conflicts: MergeConflict[] };

type SideState = { kind: 'unchanged' } | { kind: 'removed' } | { kind: 'edited'; value: unknown };

type Token = { kind: 'base'; index: number } | { kind: 'new'; value: unknown };

/**
 * Save never overwrites a change made in settings.json meanwhile: a 3-way merge of the setting value. `base` is the
 * value that the editor loaded (the value when it opened or was last saved or loaded), `ours` the entries of the editor
 * (each with the `origin` it was loaded from, none when added), and `theirs` the value stored now. The changes of the
 * editor (additions, removals, edits, and moves) are applied to `theirs`; entries that only settings.json added or
 * changed stay. An element changed on both sides in the same way is no conflict. An element changed differently on both
 * sides (also removed on one side and edited on the other) is a conflict: without a choice in `choices` (by base index)
 * the result lists the conflicts and no value. The elements of `theirs` are matched to the base by content (longest
 * common subsequence of the entries, then entries with the same pattern or name, then by position in the gaps). The
 * order: the order of the editor when it moved entries, otherwise the order of settings.json; the entries that only the
 * other side has are placed after their predecessor on that side.
 */
export function mergeRepositoryGroups(
  baseValue: unknown,
  ours: readonly EditorEntry[],
  theirsValue: unknown,
  choices: ReadonlyMap<number, ConflictChoice> = new Map(),
): MergeOutcome {
  const base = Array.isArray(baseValue) ? (baseValue as unknown[]) : [];
  const theirs = Array.isArray(theirsValue) ? (theirsValue as unknown[]) : [];
  const baseKeys = base.map(entryKey);

  // The editor: its entries with a valid origin are the base elements (possibly edited); the others are additions.
  const oursValues = toSettingValue(ours);
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

  // settings.json: its elements matched to the base by content.
  const theirsOrigins = alignToBase(base, theirs);
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

  // The decision per base element: its value, or `undefined` when it is removed.
  const conflicts: MergeConflict[] = [];
  let unresolved = false;
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
    conflicts.push({
      baseIndex: index,
      base: baseEntry,
      ...(mine.kind === 'edited' ? { mine: mine.value } : {}),
      ...(other.kind === 'edited' ? { theirs: other.value } : {}),
    });
    const choice = choices.get(index);
    if (choice === undefined) {
      unresolved = true;
      return decided.set(index, { keep: false });
    }
    return decided.set(index, choice === 'mine' ? valueOf(mine, oursByOrigin) : valueOf(other, theirsByOrigin));
  });
  if (unresolved) return { status: 'conflicts', conflicts };

  const kept = (token: Token) => token.kind === 'new' || decided.get(token.index)?.keep === true;
  const oursMoved = isReordered(oursTokens.filter(kept));
  const [skeleton, other] = oursMoved ? [oursTokens, theirsTokens] : [theirsTokens, oursTokens];
  const merged: Token[] = skeleton.filter(kept);
  const newKeys = new Set(merged.filter((token) => token.kind === 'new').map((token) => entryKey((token as { value: unknown }).value)));
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
      // Both sides added the same entry: once.
      const key = entryKey(token.value);
      if (newKeys.has(key)) {
        const at = merged.findIndex((placed) => placed.kind === 'new' && entryKey(placed.value) === key);
        if (at >= 0) last = at;
        continue;
      }
      newKeys.add(key);
    }
    merged.splice(last + 1, 0, token);
    last += 1;
  }
  const value = merged.map((token) => {
    if (token.kind === 'new') return token.value;
    const decision = decided.get(token.index);
    return decision?.keep ? decision.value : undefined;
  });
  return { status: 'merged', value, conflicts };
}

/** The base indices of the tokens that come from the base are not in increasing order: the entries were moved. */
function isReordered(tokens: readonly Token[]): boolean {
  let previous = -1;
  for (const token of tokens) {
    if (token.kind !== 'base') continue;
    if (token.index < previous) return true;
    previous = token.index;
  }
  return false;
}

/**
 * For each element of `theirs`, the index of the base element it stems from, or `undefined` for an addition: equal
 * entries by the longest common subsequence; in each gap between them, the entries with the same pattern or the same
 * name, then the rest by position when both sides of the gap have the same number of entries.
 */
function alignToBase(base: readonly unknown[], theirs: readonly unknown[]): Array<number | undefined> {
  const a = base.map(entryKey);
  const b = theirs.map(entryKey);
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const origins = new Array<number | undefined>(theirs.length).fill(undefined);
  const pairGap = (baseGap: number[], theirsGap: number[]) => {
    const restBase: number[] = [];
    const used = new Set<number>();
    for (const i of baseGap) {
      const fields = entryFieldsOf(base[i]);
      const j = theirsGap.find((candidate) => {
        if (used.has(candidate)) return false;
        const other = entryFieldsOf(theirs[candidate]);
        if (!fields || !other) return false;
        return fields.pattern === other.pattern || (fields.name !== undefined && fields.name === other.name);
      });
      if (j === undefined) restBase.push(i);
      else {
        used.add(j);
        origins[j] = i;
      }
    }
    const restTheirs = theirsGap.filter((j) => !used.has(j));
    if (restBase.length === restTheirs.length) restBase.forEach((i, k) => (origins[restTheirs[k]] = i));
  };
  let i = 0;
  let j = 0;
  let baseGap: number[] = [];
  let theirsGap: number[] = [];
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairGap(baseGap, theirsGap);
      baseGap = [];
      theirsGap = [];
      origins[j] = i;
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      baseGap.push(i++);
    } else {
      theirsGap.push(j++);
    }
  }
  while (i < a.length) baseGap.push(i++);
  while (j < b.length) theirsGap.push(j++);
  pairGap(baseGap, theirsGap);
  return origins;
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
  return { ...(trimmed ? { name: trimmed } : {}), pattern, ...(flags ? { flags } : {}) };
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

// ---- State of the webview ---------------------------------------------------------------------------------------

/** Message to the webview: the entries to show (at the start, and after Load Setting). */
export interface EditorLoadMessage {
  type: 'load';
  entries: EditorEntry[];
  notices: string[];
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

/** The state for the webview: checks, preview, and the test of the name. */
export function editorState(options: {
  seq: number;
  entries: readonly EditorEntry[];
  loaded: readonly EditorEntry[];
  testName: string;
  input: TreeInput | undefined;
  changedOutside: boolean;
  status?: string;
}): EditorStateMessage {
  const checks = checkEntries(options.entries);
  const test = testRepositoryName(options.entries, options.testName);
  return {
    type: 'state',
    seq: options.seq,
    checks,
    canSave: canSave(checks),
    dirty: !sameSettingValue(toSettingValue(options.entries), toSettingValue(options.loaded)),
    changedOutside: options.changedOutside,
    preview: buildGroupsPreview(options.input, options.entries),
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
