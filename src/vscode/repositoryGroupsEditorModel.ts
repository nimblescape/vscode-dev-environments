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
  changedMeanwhile: 'devEnvLauncher.repositoryGroups was changed in settings.json while this editor was open.',
  changedMeanwhileDetail: (theirs: string) =>
    `settings.json now:${theirs}\n\nLoad settings.json shows this list in the editor and drops your unsaved edits. Save Mine replaces it with the entries of this editor. Cancel changes nothing.`,
  loadTheirs: 'Load settings.json',
  saveMine: 'Save Mine',
  saveCancelled: 'Nothing was saved. Your edits are still in the editor.',
  saved: 'Saved to the user settings.',
  savedReplaced: 'Saved to the user settings. Your entries replaced the value that settings.json had.',
  loadedTheirs: 'Loaded the setting from settings.json. Your unsaved edits were dropped. Nothing was saved.',
  loaded: 'Loaded the setting from settings.json.',
  alreadySaved: 'Saved: settings.json already holds these entries, so nothing had to be written.',
  staleKept: 'settings.json changed while you were editing; your edits are kept, press Save again.',
  refusedMessage:
    'The editor sent entries that cannot be used; they were not taken over, and the preview shows the entries before. Nothing was saved.',
  entryTooSlow:
    'This regular expression takes too long for the repository names of the view (for example a nested repetition such as (a+)+). It would make VS Code stop responding. Change it before you save.',
  previewTooSlow: 'The preview was stopped: the regular expressions took more than 1 second for the repository names of the view.',
  testTooSlow: 'The test was stopped: the regular expressions took more than 1 second for this name.',
  tooSlowNotSaved: 'A regular expression takes too long for the repository names of the view. Nothing was saved.',
  previewFailed: 'The preview could not check these regular expressions; Save is not possible.',
  notAListConflict: 'settings.json holds a value for devEnvLauncher.repositoryGroups that is not a list.',
  notAListDetail: (theirs: string) =>
    `The value in settings.json is not a list: ${theirs}\n\nLoad settings.json shows the editor for that value (with no entries) and drops your unsaved edits. Save Mine replaces that value with the entries of this editor. Cancel changes nothing.`,
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
      entries.push({ name: '', pattern: entry, flags: '' });
      return;
    }
    const { name, pattern, flags } = entry as { name?: string; pattern: string; flags?: string };
    entries.push({ name: name ?? '', pattern, flags: normalizeFlags(flags ?? '') });
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
  | { type: 'save'; seq: number; generation: number; entries: EditorEntry[]; testName: string }
  /** Load settings.json; `testName` is the text of the test field, which the load keeps. */
  | { type: 'reload'; testName: string }
  | { type: 'cancel' }
  /**
   * An update or Save for entries of an earlier load (edited from another value): nothing is written, and the editor
   * keeps these entries with a status (unless Load settings.json replaced that load).
   */
  | { type: 'stale'; seq: number; generation: number; entries: EditorEntry[]; testName: string };

/**
 * The message of the webview, or `undefined` when it is not one of EditorRequest exactly: unknown types or properties,
 * wrong types, flags other than i, u, and s, and texts or lists over EditorLimits are refused. `generation` counts the
 * loads of the editor; an update or Save of another load is `stale` (its entries were edited from another value).
 */
export function parseEditorRequest(raw: unknown, context: { generation: number }): EditorRequest | undefined {
  if (!isPlainObject(raw)) return undefined;
  switch (raw.type) {
    case 'ready':
    case 'cancel':
      return hasOnlyKeys(raw, ['type']) ? { type: raw.type } : undefined;
    case 'reload':
      return hasOnlyKeys(raw, ['type', 'testName']) && isText(raw.testName, EditorLimits.testName)
        ? { type: 'reload', testName: raw.testName }
        : undefined;
    case 'update':
    case 'save': {
      if (!hasOnlyKeys(raw, ['type', 'seq', 'generation', 'entries', 'testName']) || !isSeq(raw.seq) || !isSeq(raw.generation)) return undefined;
      const entries = parseEntries(raw.entries);
      if (!entries || !isText(raw.testName, EditorLimits.testName)) return undefined;
      const message = { seq: raw.seq, generation: raw.generation, entries, testName: raw.testName };
      if (raw.generation !== context.generation) return { type: 'stale', ...message };
      return { type: raw.type, ...message };
    }
    default:
      return undefined;
  }
}

/** The `seq` of a message that parseEditorRequest refused, when it has a valid one (to answer it with a state). */
export function refusedRequestSeq(raw: unknown): number | undefined {
  return isPlainObject(raw) && isSeq(raw.seq) ? raw.seq : undefined;
}

/** The entries of a message. */
function parseEntries(value: unknown): EditorEntry[] | undefined {
  if (!Array.isArray(value) || value.length > EditorLimits.entries) return undefined;
  const entries: EditorEntry[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || !hasOnlyKeys(item, ['name', 'pattern', 'flags'])) return undefined;
    const { name, pattern, flags } = item;
    if (!isText(name, EditorLimits.name) || !isText(pattern, EditorLimits.pattern)) return undefined;
    if (typeof flags !== 'string' || !/^[ius]{0,3}$/.test(flags) || normalizeFlags(flags).length !== flags.length) return undefined;
    entries.push({ name, pattern, flags: normalizeFlags(flags) });
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

// ---- Save: the question when settings.json changed the setting ----------------------------------------------------

/** At most this many characters of one element of the setting are shown in a question; the rest is cut. */
export const MAX_SHOWN_ENTRY = 200;
/** At most this many elements of the list of settings.json are shown in a question; the rest is counted. */
export const MAX_SHOWN_LINES = 20;
/** At most this many characters of the list of settings.json are shown in a question (the first element always). */
const MAX_SHOWN_LIST = 2000;

/**
 * A short text of the list of settings.json for the question of Save: one element per line, each cut after
 * MAX_SHOWN_ENTRY characters; after MAX_SHOWN_LINES elements or MAX_SHOWN_LIST characters the rest is counted. The
 * first element is always shown, so the list is never hidden as a whole.
 */
export function describeSettingList(value: unknown): string {
  if (value === undefined || value === null) return '(no entries)';
  if (!Array.isArray(value)) return describeSettingEntry(value);
  if (value.length === 0) return '(no entries)';
  let text = '';
  for (const [index, entry] of value.entries()) {
    const line = `\n${index + 1}. ${describeSettingEntry(entry)}`;
    if (index > 0 && (index >= MAX_SHOWN_LINES || text.length + line.length > MAX_SHOWN_LIST)) {
      const more = value.length - index;
      return `${text}\n… and ${more} more ${more === 1 ? 'entry' : 'entries'}`;
    }
    text += line;
  }
  return text;
}

/** A short text of an element (or of a value that is not a list) of the setting for the question of Save, cut after MAX_SHOWN_ENTRY characters. */
export function describeSettingEntry(entry: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(entry) ?? String(entry);
  } catch {
    text = String(entry);
  }
  return text.length > MAX_SHOWN_ENTRY ? `${text.slice(0, MAX_SHOWN_ENTRY)}… (${text.length} characters)` : text;
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

/** Message to the webview: the entries to show (at the start, after Load settings.json or Save, and after a stale Save or update). */
export interface EditorLoadMessage {
  type: 'load';
  /** Counts the loads; the webview sends it back with its updates. */
  generation: number;
  /** The highest `seq` that the extension has seen: the webview continues from it (also a page that starts again). */
  seq: number;
  entries: EditorEntry[];
  notices: string[];
  /** The text of the test field, so a page that starts again shows the text of its result (a running page keeps its own). */
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
  /**
   * The setting was changed outside the editor since it was loaded (or last saved): the page shows the banner
   * "settings.json changed this setting." with Load settings.json. The draft is never replaced without that button or
   * the question of Save.
   */
  changedOutside: boolean;
  /** A Save runs: the webview stays read-only until a state with the `seq` of its Save and `saving: false`. */
  saving: boolean;
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
  saving?: boolean;
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
    saving: options.saving === true,
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
<fieldset id="form" class="form">
<div id="changed" class="banner" role="alert" hidden>
<span>settings.json changed this setting.</span>
<button type="button" id="reload" class="secondary">Load settings.json</button>
</div>
<section aria-labelledby="entries-heading">
<h2 id="entries-heading">Entries</h2>
<p id="no-entries" class="muted" hidden>No entries: the view shows the plain list of each owner.</p>
<ol id="entries"></ol>
<button type="button" id="add">Add Entry</button>
<p id="entries-full" class="muted" hidden>The editor takes at most ${EditorLimits.entries} entries.</p>
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
</fieldset>
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
