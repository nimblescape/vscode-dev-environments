// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { DiscoveryData, Environment, RepositoryInfo } from '../core/types';
import { parseRepositoryGroups } from './repositoryGroups';
import {
  EditorLimits,
  GroupsEditorTexts,
  buildGroupsPreview,
  canSave,
  capturingGroups,
  checkEntries,
  editorHtml,
  editorState,
  entriesFromSetting,
  mergeRepositoryGroups,
  parseEditorRequest,
  sameSettingValue,
  testRepositoryName,
  toSettingValue,
  cloneableInput,
  runPreviewJob,
  type EditorEntry,
  type MergeChoices,
  type PreviewJobMessage,
  type PreviewNode,
} from './repositoryGroupsEditorModel';
import { buildTreeModel, type GroupNode, type HintRow, type RepositoryRow, type TreeInput } from './treeModel';

const EXAMPLE = String.raw`^(\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$`;
const T0 = '2026-09-24T17:00:00.000Z';

const entry = (pattern: string, name = '', flags = ''): EditorEntry => ({ name, pattern, flags });

function repo(nameWithOwner: string): RepositoryInfo {
  const [owner, name] = nameWithOwner.split('/');
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: T0,
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
  };
}

function environment(id: string, repository: string): Environment {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devenv-${id}`,
    containerName: `devenv-${id}`,
    createdAt: T0,
    lastUsedAt: T0,
  };
}

function discovery(repositories: RepositoryInfo[]): DiscoveryData {
  return { version: 1, fetchedAt: T0, viewerLogin: 'me', organizations: [], repositories, hints: [] };
}

const input_ = (overrides: Partial<TreeInput> = {}): TreeInput => input(overrides);

function input(overrides: Partial<TreeInput> = {}): TreeInput {
  return {
    discovery: undefined,
    settings: { owners: [], includeArchived: false, includeForks: true },
    environments: [],
    runtime: undefined,
    currentEnvironmentId: null,
    otherWindowEnvironmentIds: new Set(),
    busyEnvironmentIds: new Set(),
    liveBranches: new Map(),
    signedIn: true,
    formatTime: (value) => `T(${value})`,
    ...overrides,
  };
}

describe('serialization of the entries', () => {
  it('writes a string for an entry without name and flags, and an object otherwise', () => {
    expect(
      toSettingValue([
        entry('^a'),
        entry('^b', 'Courses'),
        entry('^c', '', 'si'),
        entry('^d', '  Named  ', 'ius'),
        entry('^e', '   '),
      ]),
    ).toEqual(['^a', { name: 'Courses', pattern: '^b' }, { pattern: '^c', flags: 'is' }, { name: 'Named', pattern: '^d', flags: 'ius' }, '^e']);
  });

  it('reads what it writes (round trip), with the index in the setting as origin', () => {
    const entries = [entry('^a'), entry('^b', 'Courses'), entry('^c', '', 'is'), entry(EXAMPLE, 'Students', 'u')];
    const value = toSettingValue(entries);
    const { entries: loaded, notices } = entriesFromSetting(value);
    expect(notices).toEqual([]);
    expect(loaded).toEqual(entries.map((item, origin) => ({ ...item, origin })));
    expect(toSettingValue(loaded)).toEqual(value);
    // The value survives the JSON of settings.json.
    expect(toSettingValue(entriesFromSetting(JSON.parse(JSON.stringify(value))).entries)).toEqual(value);
  });

  it('writes an object without name and flags as a string', () => {
    const { entries } = entriesFromSetting([{ pattern: '^a' }, { name: '', pattern: '^b', flags: '' }]);
    expect(toSettingValue(entries)).toEqual(['^a', '^b']);
  });

  it('leaves out entries of the wrong type and other flags, each with a notice, and keeps invalid patterns', () => {
    const { entries, notices } = entriesFromSetting([3, '(', { pattern: '^a', flags: 'gi' }, { name: 1, pattern: '^b' }, '']);
    expect(entries).toEqual([
      { name: '', pattern: '(', flags: '', origin: 1 },
      { name: '', pattern: '^a', flags: 'i', origin: 2 },
      { name: '', pattern: '', flags: '', origin: 4 },
    ]);
    expect(notices).toEqual([
      GroupsEditorTexts.wrongTypeLeftOut(1),
      GroupsEditorTexts.ignoredFlagsLeftOut(3, 'g'),
      GroupsEditorTexts.wrongTypeLeftOut(4),
    ]);
  });

  it('starts empty without a setting, and names a value that is not a list', () => {
    expect(entriesFromSetting(undefined)).toEqual({ entries: [], notices: [] });
    expect(entriesFromSetting({ pattern: '^a' })).toEqual({ entries: [], notices: [GroupsEditorTexts.notAList] });
  });

  it('compares setting values by content (a missing value is the empty list; key order does not count)', () => {
    expect(sameSettingValue(undefined, [])).toBe(true);
    expect(sameSettingValue([{ pattern: '^a', name: 'A' }], [{ name: 'A', pattern: '^a' }])).toBe(true);
    expect(sameSettingValue(['^a'], ['^b'])).toBe(false);
    expect(sameSettingValue(['^a', '^b'], ['^b', '^a'])).toBe(false);
  });
});

describe('checks of the entries', () => {
  it('names an empty and an invalid regular expression, with the error of JavaScript, as the sidebar does', () => {
    const checks = checkEntries([entry(''), entry('('), entry('[', 'Named', 'i')]);
    expect(checks[0]).toEqual({ error: GroupsEditorTexts.emptyPattern });
    expect(checks[1].error).toMatch(/^This regular expression is not valid: /);
    expect(checks[1].error).toContain('Unterminated group');
    expect(checks[2].error).toContain('not valid');
    expect(canSave(checks)).toBe(false);
    // The same entries are left out by the parser of the sidebar.
    expect(parseRepositoryGroups(toSettingValue([entry(''), entry('('), entry('[', 'Named', 'i')])).patterns).toEqual([]);
  });

  it('describes the capturing groups: the parser needs none (an entry without one only filters)', () => {
    const checks = checkEntries([entry('^web-'), entry('^web-(.+)$'), entry(EXAMPLE), entry('^(?:x)-(?<rest>.+)$')]);
    expect(checks).toEqual([
      { note: GroupsEditorTexts.noCapturingGroup },
      { note: GroupsEditorTexts.oneCapturingGroup },
      { note: GroupsEditorTexts.levels(3) },
      { note: GroupsEditorTexts.oneCapturingGroup },
    ]);
    expect(canSave(checks)).toBe(true);
    expect(GroupsEditorTexts.levels(3)).toBe('3 capturing groups: 2 levels, then the label of the row.');
  });

  // Review round 2 of PR #21, W2: the capturing groups are counted in the source; no regular expression of the draft
  // runs in the extension host.
  it('counts the capturing groups without running the regular expression', () => {
    const count = (pattern: string) => capturingGroups(pattern);
    expect(count('^a')).toBe(0);
    expect(count('^(a)(?:b)(?<name>c)(?=d)(?!e)(?<=f)(?<!g)$')).toBe(2);
    expect(count(String.raw`\(a\)[(](b)[\](]`)).toBe(1);
    expect(count(String.raw`[\]()](x)`)).toBe(1);
    expect(count(EXAMPLE)).toBe(3);
    // This one takes seconds when it runs on the empty text.
    const started = Date.now();
    expect(checkEntries([entry(String.raw`(?:(|)\1){26}x`)])).toEqual([{ note: GroupsEditorTexts.oneCapturingGroup }]);
    expect(Date.now() - started).toBeLessThan(500);
    // The count equals the one of the regular expression.
    for (const pattern of ['^(a)|(b)$', String.raw`(\()(?<n>[)(])`, EXAMPLE, '(?:x)', '((a)(b))']) {
      expect(count(pattern)).toBe((new RegExp(`${pattern}|`).exec('')?.length ?? 1) - 1);
    }
  });

  it('refuses a name or a pattern over the limits', () => {
    expect(checkEntries([entry('a'.repeat(EditorLimits.pattern + 1))])).toEqual([{ error: GroupsEditorTexts.patternTooLong }]);
    expect(checkEntries([entry('^a', 'n'.repeat(EditorLimits.name + 1))])).toEqual([{ error: GroupsEditorTexts.nameTooLong }]);
  });

  it('can save an empty list', () => {
    expect(canSave(checkEntries([]))).toBe(true);
    expect(toSettingValue([])).toEqual([]);
  });
});

describe('preview', () => {
  const STUDENTS = [
    repo('school/2026-3cWI-SWP-module-oop-EnesHA81'),
    repo('school/2026-3cWI-SWP-module-oop-felix-he021'),
    repo('school/2025-3bWI-SWP-module-oop-hailo'),
    repo('school/website'),
    repo('school/notes'),
    repo('acme/api'),
  ];

  type Shape = string | [string, Shape[]];
  const previewShape = (nodes: readonly PreviewNode[]): Shape[] =>
    nodes.map((node) => (node.kind === 'group' ? [node.label, previewShape(node.children ?? [])] : node.label));
  const modelShape = (children: ReadonlyArray<RepositoryRow | HintRow | GroupNode>): Shape[] =>
    children.map((child) => (child.kind === 'group' ? [child.label, modelShape(child.children)] : child.label));

  it('shows the tree of the sidebar for the example of the user, with counts, hidden repositories, and environments', () => {
    const base = input({ discovery: discovery(STUDENTS), environments: [environment('e1', 'school/notes')] });
    const entries = [entry(EXAMPLE)];
    const preview = buildGroupsPreview(base, entries);
    expect(preview.loaded).toBe(true);
    expect(preview.truncated).toBe(0);
    expect(preview.owners.map((owner) => owner.owner)).toEqual(['acme', 'school']);
    const [acme, school] = preview.owners;
    expect(acme).toMatchObject({ grouped: false, total: 1, counts: [0], unmatched: 1, hidden: [], keptWithEnvironment: [] });
    expect(previewShape(acme.tree)).toEqual(['api']);
    expect(school).toMatchObject({
      grouped: true,
      total: 5,
      counts: [3],
      unmatched: 2,
      hidden: ['website'],
      keptWithEnvironment: ['notes'],
    });
    expect(previewShape(school.tree)).toEqual([
      ['2025-3bWI-SWP', [['module-oop', ['hailo']]]],
      ['2026-3cWI-SWP', [['module-oop', ['EnesHA81', 'felix-he021']]]],
      'notes',
    ]);
    const felix = (school.tree[1].children ?? [])[0].children?.[1];
    expect(felix).toEqual({ kind: 'repository', label: 'felix-he021', detail: '2026-3cWI-SWP-module-oop-felix-he021' });
    expect(school.tree[2]).toEqual({ kind: 'repository', label: 'notes', environment: true });

    // The preview is the model of the sidebar after Save: buildTreeModel with the parsed setting value.
    const sidebar = buildTreeModel({ ...base, repositoryGroups: parseRepositoryGroups(toSettingValue(entries)).patterns });
    expect(preview.owners.map((owner) => [owner.owner, previewShape(owner.tree)])).toEqual(
      sidebar.map((group) => [group.owner, modelShape(group.children)]),
    );
  });

  it('shows a named root with its pattern, and counts per entry (the first entry that matches wins)', () => {
    const entries = [entry('^2026-(.+)$', 'This year'), entry(EXAMPLE), entry('(')];
    const preview = buildGroupsPreview(input({ discovery: discovery(STUDENTS) }), entries);
    const school = preview.owners[1];
    expect(school.counts).toEqual([2, 1, 0]);
    expect(school.tree[0]).toMatchObject({ kind: 'group', label: 'This year', detail: '^2026-(.+)$', expanded: true });
    const sidebar = buildTreeModel({
      ...input({ discovery: discovery(STUDENTS) }),
      repositoryGroups: parseRepositoryGroups(toSettingValue(entries)).patterns,
    });
    expect(preview.owners.map((owner) => previewShape(owner.tree))).toEqual(sidebar.map((group) => modelShape(group.children)));
  });

  it('without entries, shows the plain list; without a render of the sidebar, nothing', () => {
    const preview = buildGroupsPreview(input({ discovery: discovery(STUDENTS) }), []);
    expect(preview.owners.every((owner) => !owner.grouped && owner.hidden.length === 0)).toBe(true);
    expect(previewShape(preview.owners[1].tree)).toEqual([
      '2025-3bWI-SWP-module-oop-hailo',
      '2026-3cWI-SWP-module-oop-EnesHA81',
      '2026-3cWI-SWP-module-oop-felix-he021',
      'notes',
      'website',
    ]);
    expect(buildGroupsPreview(undefined, [entry(EXAMPLE)])).toEqual({ loaded: false, owners: [], truncated: 0 });
  });

  it('sends at most MAX_PREVIEW_NODES nodes and counts the rest', () => {
    const many = Array.from({ length: 2100 }, (_, index) => repo(`big/r${index}`));
    const preview = buildGroupsPreview(input({ discovery: discovery(many) }), []);
    expect(preview.owners[0].tree).toHaveLength(2000);
    expect(preview.truncated).toBe(100);
  });
});

describe('test of a repository name', () => {
  it('names the entry that matches and the place of the row', () => {
    expect(testRepositoryName([entry('^web-'), entry(EXAMPLE)], '2026-3cWI-SWP-module-oop-EnesHA81')).toEqual({
      matched: true,
      entryIndex: 1,
      text: GroupsEditorTexts.testMatch(2, undefined),
      path: ['2026-3cWI-SWP', 'module-oop', 'EnesHA81'],
    });
  });

  it('starts the path with the owner and the name of the entry', () => {
    expect(testRepositoryName([entry(EXAMPLE, 'Students')], ' school/2025-3bWI-SWP-module-oop-hailo ')).toMatchObject({
      matched: true,
      entryIndex: 0,
      text: 'Entry 1 ("Students") matches.',
      path: ['school', 'Students', '2025-3bWI-SWP', 'module-oop', 'hailo'],
    });
  });

  it('says when no entry matches, skips invalid entries, and ignores an empty text', () => {
    expect(testRepositoryName([entry('('), entry('^web-')], 'api')).toEqual({ matched: false, text: GroupsEditorTexts.testNoMatch, path: [] });
    expect(testRepositoryName([entry(EXAMPLE)], '   ')).toBeUndefined();
    expect(testRepositoryName([entry(EXAMPLE)], 'two words')).toEqual({ matched: false, text: GroupsEditorTexts.testInvalid, path: [] });
  });
});

describe('messages of the webview', () => {
  const context = { baseLength: 2, generation: 5 };
  const valid = { name: 'A', pattern: '^a', flags: 'is' };

  it('accepts exactly the messages of the editor', () => {
    expect(parseEditorRequest({ type: 'ready' }, context)).toEqual({ type: 'ready' });
    expect(parseEditorRequest({ type: 'reload' }, context)).toEqual({ type: 'reload' });
    expect(parseEditorRequest({ type: 'cancel' }, context)).toEqual({ type: 'cancel' });
    expect(parseEditorRequest({ type: 'update', seq: 3, generation: 5, entries: [valid, { ...valid, origin: 1 }], testName: 'x' }, context)).toEqual({
      type: 'update',
      seq: 3,
      generation: 5,
      entries: [valid, { ...valid, origin: 1 }],
      testName: 'x',
    });
    expect(parseEditorRequest({ type: 'save', seq: 0, generation: 5, entries: [] }, context)).toEqual({ type: 'save', seq: 0, generation: 5, entries: [] });
    // An update of an earlier load: its origins name another base.
    expect(parseEditorRequest({ type: 'save', seq: 0, generation: 4, entries: [{ ...valid, origin: 9 }] }, context)).toEqual({ type: 'stale' });
  });

  it.each<[string, unknown]>([
    ['not an object', 'save'],
    ['a list', [{ type: 'ready' }]],
    ['null', null],
    ['an unknown type', { type: 'write' }],
    ['an extra property', { type: 'ready', extra: 1 }],
    ['a missing property', { type: 'update', seq: 1, generation: 5, entries: [] }],
    ['a missing generation', { type: 'save', seq: 1, entries: [] }],
    ['a generation that is no number', { type: 'save', seq: 1, generation: '5', entries: [] }],
    ['a sequence that is no whole number', { type: 'save', seq: 1.5, generation: 5, entries: [] }],
    ['a negative sequence', { type: 'save', seq: -1, generation: 5, entries: [] }],
    ['entries that are no list', { type: 'save', seq: 1, generation: 5, entries: {} }],
    ['an entry that is a string', { type: 'save', seq: 1, generation: 5, entries: ['^a'] }],
    ['an entry with an extra property', { type: 'save', seq: 1, generation: 5, entries: [{ ...valid, regex: '^a' }] }],
    ['an entry without flags', { type: 'save', seq: 1, generation: 5, entries: [{ name: '', pattern: '^a' }] }],
    ['a pattern that is no text', { type: 'save', seq: 1, generation: 5, entries: [{ ...valid, pattern: 1 }] }],
    ['the flag g', { type: 'save', seq: 1, generation: 5, entries: [{ ...valid, flags: 'g' }] }],
    ['a repeated flag', { type: 'save', seq: 1, generation: 5, entries: [{ ...valid, flags: 'ii' }] }],
    ['an origin outside the loaded value', { type: 'save', seq: 1, generation: 5, entries: [{ ...valid, origin: 2 }] }],
    ['an origin twice', { type: 'save', seq: 1, generation: 5, entries: [{ ...valid, origin: 0 }, { ...valid, origin: 0 }] }],
    ['an origin that is no whole number', { type: 'save', seq: 1, generation: 5, entries: [{ ...valid, origin: '0' }] }],
    ['a pattern over the limit', { type: 'save', seq: 1, generation: 5, entries: [{ ...valid, pattern: 'a'.repeat(EditorLimits.pattern + 1) }] }],
    ['a name over the limit', { type: 'save', seq: 1, generation: 5, entries: [{ ...valid, name: 'a'.repeat(EditorLimits.name + 1) }] }],
    ['too many entries', { type: 'save', seq: 1, generation: 5, entries: Array.from({ length: EditorLimits.entries + 1 }, () => valid) }],
    ['a test name over the limit', { type: 'update', seq: 1, generation: 5, entries: [], testName: 'a'.repeat(EditorLimits.testName + 1) }],
    ['an object with another prototype', Object.assign(Object.create({ polluted: true }) as object, { type: 'ready' })],
  ])('refuses %s', (_case, raw) => {
    expect(parseEditorRequest(raw, context)).toBeUndefined();
  });

  it('sorts the flags of an entry', () => {
    const request = parseEditorRequest({ type: 'save', seq: 1, generation: 5, entries: [{ ...valid, flags: 'si' }] }, context);
    expect(request).toEqual({ type: 'save', seq: 1, generation: 5, entries: [{ ...valid, flags: 'is' }] });
  });
});

describe('state and HTML of the webview', () => {
  it('computes the checks, the dirty flag, the preview, and the test of a preview job for the webview', () => {
    const loaded = entriesFromSetting([EXAMPLE]).entries;
    const test = testRepositoryName(loaded, 'x');
    const state = editorState({
      seq: 4,
      entries: [...loaded, entry('(')],
      loaded,
      run: { preview: { loaded: false, owners: [], truncated: 0 }, ...(test ? { test } : {}) },
      changedOutside: true,
    });
    expect(state).toMatchObject({ type: 'state', seq: 4, canSave: false, dirty: true, changedOutside: true });
    expect(state.checks).toHaveLength(2);
    expect(state.test?.matched).toBe(false);
    expect(editorState({ seq: 0, entries: loaded, loaded, run: undefined, changedOutside: false })).toMatchObject({
      canSave: true,
      dirty: false,
      preview: { loaded: false },
    });
  });

  it('names the entry that was too slow, and keeps Save off', () => {
    const entries = [entry('^a-(.+)$'), entry(String.raw`^(\w+)+$`)];
    const state = editorState({ seq: 1, entries, loaded: [], run: { previewTooSlow: true, slowEntry: 1 }, changedOutside: false });
    expect(state.checks[0]).toEqual({ note: GroupsEditorTexts.oneCapturingGroup });
    expect(state.checks[1]).toEqual({ error: GroupsEditorTexts.entryTooSlow });
    expect(state.canSave).toBe(false);
    expect(state.preview).toEqual({ loaded: true, owners: [], truncated: 0, tooSlow: true });
    const slowTest = editorState({ seq: 1, entries, loaded: [], run: { preview: buildGroupsPreview(undefined, entries), testTooSlow: true }, changedOutside: false });
    expect(slowTest.test).toEqual({ matched: false, text: GroupsEditorTexts.testTooSlow, path: [] });
    expect(slowTest.canSave).toBe(true);
  });

  // Review round 2 of PR #21, W1: a failed run of the worker keeps Save off, as a stopped one does.
  it('keeps Save off when the worker failed', () => {
    const entries = [entry('^a-(.+)$')];
    expect(editorState({ seq: 1, entries, loaded: [], run: { failed: true }, changedOutside: false }).canSave).toBe(false);
    expect(editorState({ seq: 1, entries, loaded: [], run: { preview: buildGroupsPreview(undefined, entries) }, changedOutside: false }).canSave).toBe(
      true,
    );
  });

  it('has a strict Content Security Policy: nothing by default, the script only with the nonce, no remote content', () => {
    const html = editorHtml({
      cspSource: 'vscode-webview://abc',
      nonce: 'N0nce+/=',
      scriptUri: 'vscode-webview://abc/editor.js',
      styleUri: 'vscode-webview://abc/editor.css',
    });
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
    expect(csp).toBe(
      "default-src 'none'; style-src vscode-webview://abc; script-src 'nonce-N0nce+/='; base-uri 'none'; form-action 'none'",
    );
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/ style=/);
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script nonce="N0nce+/=" src="vscode-webview://abc/editor.js">']);
    expect(html).toContain('<label for="test-name">');
  });
});

describe('merge at Save (3-way)', () => {
  const BASE = ['^a', '^b', '^c'];
  const loaded = () => entriesFromSetting(BASE).entries;
  const merge = (ours: EditorEntry[], theirs: unknown, choices?: MergeChoices) => mergeRepositoryGroups(BASE, ours, theirs, choices);
  const mine = (index: number, choice: 'mine' | 'theirs' = 'mine'): MergeChoices => ({ entries: new Map([[index, choice]]) });
  const merged = (value: unknown[]) => ({ status: 'merged', value, conflicts: [], orderConflict: false });

  it('changes nothing when neither side changed', () => {
    expect(merge(loaded(), [...BASE])).toEqual(merged(BASE));
  });

  it('applies the changes of the editor alone: edit, removal, addition, and move', () => {
    const [a, b] = loaded();
    expect(merge([{ ...b, pattern: '^B' }, a, entry('^d', 'D')], [...BASE])).toEqual(
      merged(['^B', '^a', { name: 'D', pattern: '^d' }]),
    );
  });

  it('keeps the changes of settings.json alone', () => {
    const theirs = ['^x', '^a', { name: 'B', pattern: '^b' }, '^c', '^y'];
    expect(merge(loaded(), theirs)).toEqual(merged(theirs));
    expect(merge(loaded(), undefined)).toEqual(merged([]));
  });

  it('merges changes of different entries on both sides', () => {
    const [a, b, c] = loaded();
    expect(merge([{ ...a, pattern: '^A' }, b, c, entry('^mine')], ['^theirs', '^a', '^b', '^C'])).toEqual(
      merged(['^theirs', '^A', '^b', '^C', '^mine']),
    );
    // A removal in the editor and an edit of another entry in settings.json.
    expect(merge([a, c], ['^a', '^b', '^C2'])).toEqual(merged(['^a', '^C2']));
    // An addition in the editor stays after its predecessor when settings.json removed an entry.
    expect(merge([a, b, entry('^new'), c], ['^a', '^c'])).toEqual(merged(['^a', '^new', '^c']));
  });

  it('is no conflict when both sides changed an entry in the same way', () => {
    const [a, b, c] = loaded();
    expect(merge([a, { ...b, name: 'B' }, c], ['^a', { pattern: '^b', name: 'B' }, '^c'])).toEqual(
      merged(['^a', { pattern: '^b', name: 'B' }, '^c']),
    );
    // The same addition on both sides is written once.
    expect(merge([a, b, c, entry('^d')], ['^a', '^b', '^c', '^d'])).toMatchObject({ value: ['^a', '^b', '^c', '^d'] });
  });

  it('asks about an entry changed differently on both sides, and only about that entry', () => {
    const [a, b, c] = loaded();
    const ours = [{ ...a, pattern: '^A' }, { ...b, pattern: '^B1' }, c];
    const theirs = ['^a', '^B2', '^c', '^t'];
    expect(merge(ours, theirs)).toEqual({
      status: 'conflicts',
      conflicts: [{ baseIndex: 1, base: '^b', mine: '^B1', theirs: '^B2' }],
      orderConflict: false,
    });
    expect(merge(ours, theirs, mine(1))).toMatchObject({ status: 'merged', value: ['^A', '^B1', '^c', '^t'] });
    expect(merge(ours, theirs, mine(1, 'theirs'))).toMatchObject({ status: 'merged', value: ['^A', '^B2', '^c', '^t'] });
  });

  it('asks when the editor edits an entry that settings.json removed, and the other way', () => {
    const [a, b, c] = loaded();
    const ours = [a, { ...b, pattern: '^B' }, c];
    const theirs = ['^a', '^c'];
    expect(merge(ours, theirs)).toEqual({ status: 'conflicts', conflicts: [{ baseIndex: 1, base: '^b', mine: '^B' }], orderConflict: false });
    expect(merge(ours, theirs, mine(1))).toMatchObject({ status: 'merged', value: ['^a', '^B', '^c'] });
    expect(merge(ours, theirs, mine(1, 'theirs'))).toMatchObject({ status: 'merged', value: ['^a', '^c'] });
    expect(merge([a, c], ['^a', '^B2', '^c'])).toEqual({
      status: 'conflicts',
      conflicts: [{ baseIndex: 1, base: '^b', theirs: '^B2' }],
      orderConflict: false,
    });
  });

  it('merges a move on one side with an edit on the other', () => {
    const [a, b, c] = loaded();
    expect(merge([c, a, b], ['^A', '^b', '^c'])).toEqual(merged(['^c', '^A', '^b']));
    expect(merge([{ ...a, pattern: '^A' }, b, c], ['^c', '^a', '^b'])).toEqual(merged(['^c', '^A', '^b']));
  });

  // Review finding 1: an entry that settings.json only moved keeps its identity.
  it('applies a removal in the editor to an entry that settings.json moved', () => {
    const [, b, c] = loaded();
    expect(merge([b, c], ['^b', '^c', '^a'])).toEqual(merged(['^b', '^c']));
  });

  it('applies an edit in the editor to an entry that settings.json moved, without a question', () => {
    const [a, b, c] = loaded();
    expect(merge([{ ...a, pattern: '^A2' }, b, c], ['^b', '^c', '^a'])).toEqual(merged(['^b', '^c', '^A2']));
  });

  it('asks once about the order when both sides moved the entries differently', () => {
    const [a, b, c] = loaded();
    const ours = [c, a, b];
    const theirs = ['^b', '^a', '^c'];
    expect(merge(ours, theirs)).toEqual({ status: 'conflicts', conflicts: [], orderConflict: true });
    expect(merge(ours, theirs, { order: 'mine' })).toMatchObject({ status: 'merged', value: ['^c', '^a', '^b'], orderConflict: true });
    expect(merge(ours, theirs, { order: 'theirs' })).toMatchObject({ status: 'merged', value: ['^b', '^a', '^c'] });
    // The same move on both sides is no question.
    expect(merge([c, a, b], ['^c', '^a', '^b'])).toEqual(merged(['^c', '^a', '^b']));
  });

  // Review finding 2: settings.json edits an entry and adds another one next to it.
  it('recognizes an entry that settings.json edited next to an addition', () => {
    const base = [{ name: 'X', pattern: '^x-(.+)$' }, '^z'];
    const ours = entriesFromSetting(base).entries;
    const theirs = [{ name: 'X', pattern: '^xx-(.+)$' }, '^y', '^z'];
    expect(mergeRepositoryGroups(base, ours, theirs)).toEqual(merged(theirs));
    // An edit of the same entry in the editor asks, and the question shows the entry of settings.json.
    ours[0] = { ...ours[0], flags: 'i' };
    expect(mergeRepositoryGroups(base, ours, theirs)).toEqual({
      status: 'conflicts',
      conflicts: [{ baseIndex: 0, base: base[0], mine: { name: 'X', pattern: '^x-(.+)$', flags: 'i' }, theirs: theirs[0] }],
      orderConflict: false,
    });
    // An unnamed entry whose pattern changed, between the same neighbors, also next to an addition.
    expect(mergeRepositoryGroups(['^a', '^b', '^c'], loaded(), ['^a', '^b2', '^c'])).toEqual(merged(['^a', '^b2', '^c']));
    const [a, b, c] = loaded();
    expect(merge([a, b, c, entry('^mine')], ['^a', '^b2', '^y', '^c'])).toEqual(merged(['^a', '^b2', '^y', '^c', '^mine']));
    expect(merge([a, { ...b, name: 'B' }, c], ['^a', '^b2', '^y', '^c'])).toEqual({
      status: 'conflicts',
      conflicts: [{ baseIndex: 1, base: '^b', mine: { name: 'B', pattern: '^b' }, theirs: '^b2' }],
      orderConflict: false,
    });
  });

  it('matches objects of settings.json to the loaded entries by pattern or name when they were edited', () => {
    const base = [{ name: 'Courses', pattern: '^c-(.+)$' }, '^x'];
    const ours = entriesFromSetting(base).entries;
    ours[1] = { ...ours[1], pattern: '^X' };
    const theirs = ['^new', { name: 'Courses', pattern: '^c-(.+)$', flags: 'i' }, '^x'];
    expect(mergeRepositoryGroups(base, ours, theirs)).toEqual(merged(['^new', { name: 'Courses', pattern: '^c-(.+)$', flags: 'i' }, '^X']));
  });

  // Review finding 4: the editor writes the flags in the order ius; an untouched entry is not an edit.
  it('does not count another order of the flags as a change', () => {
    const base = [{ pattern: '^a', flags: 'si' }, '^b'];
    const ours = entriesFromSetting(base).entries;
    expect(ours[0].flags).toBe('is');
    const theirs = [{ pattern: '^a', flags: 'is', name: 'A' }, '^b'];
    expect(mergeRepositoryGroups(base, ours, theirs)).toEqual(merged(theirs));
  });

  // Review finding 5: duplicates keep their multiplicity.
  it('keeps an entry that settings.json added twice, also when the editor moved entries', () => {
    const [a, b, c] = loaded();
    // The additions follow their predecessor in settings.json (^c), in the order of the editor.
    expect(merge([c, a, b], ['^a', '^b', '^c', '^d', '^d'])).toEqual(merged(['^c', '^d', '^d', '^a', '^b']));
    expect(merge([a, b, c, entry('^d')], ['^a', '^b', '^c', '^d', '^d'])).toMatchObject({ value: ['^a', '^b', '^c', '^d', '^d'] });
    // A duplicate in the base: each copy is an entry of its own.
    const base = ['^a', '^a'];
    const ours = entriesFromSetting(base).entries;
    expect(mergeRepositoryGroups(base, [ours[0]], ['^a', '^a', '^n'])).toEqual(merged(['^a', '^n']));
  });

  it('removes the entries of the wrong type that the editor could not show, unless settings.json changed them', () => {
    const base = [3, '^a'];
    const ours = entriesFromSetting(base).entries;
    expect(mergeRepositoryGroups(base, ours, [3, '^a'])).toEqual(merged(['^a']));
  });

  // Review round 2 of PR #21, M2: equal entries are matched in order first, so an addition or removal in settings.json
  // next to an equal entry is no move.
  describe('matches equal entries in order first', () => {
    const load = (base: unknown[]) => entriesFromSetting(base).entries;

    it('does not take a copy that settings.json added before an entry for that entry', () => {
      const base = ['a', 'b'];
      const [a, b] = load(base);
      expect(mergeRepositoryGroups(base, [a, { ...b, pattern: 'b2' }], ['b', 'a', 'b'])).toEqual(merged(['b', 'a', 'b2']));
    });

    it('asks nothing about the order when settings.json only added a copy', () => {
      const base = ['a', 'b', 'c'];
      const [a, b, c] = load(base);
      expect(mergeRepositoryGroups(base, [b, a, c], ['c', 'a', 'b', 'c'])).toMatchObject({ status: 'merged', orderConflict: false });
    });

    it('asks nothing about the order when settings.json only removed the first of two equal entries', () => {
      const base = ['a', 'b', 'a', 'c'];
      const [a1, b, a2, c] = load(base);
      expect(mergeRepositoryGroups(base, [c, a1, b, a2], ['b', 'a', 'c'])).toEqual(merged(['c', 'b', 'a']));
    });

    it('keeps an edit of the last of two equal entries when settings.json removed the first', () => {
      const base = ['a', 'b', 'a'];
      const [a1, b, a2] = load(base);
      expect(mergeRepositoryGroups(base, [a1, b, { ...a2, pattern: 'a2' }], ['b', 'a'])).toEqual(merged(['b', 'a2']));
    });
  });

  // Review round 2 of PR #21, M3: a move is decided on the entries that both sides kept.
  it('asks nothing about the order when the only move of one side is of an entry that the other side removed', () => {
    const base4 = ['a', 'b', 'c', 'd'];
    const [a, b, c] = entriesFromSetting(base4).entries;
    expect(mergeRepositoryGroups(base4, [b, c, a], ['d', 'a', 'b', 'c'])).toEqual(merged(['b', 'c', 'a']));
    const base3 = ['a', 'b', 'c'];
    const [a3, b3, c3] = entriesFromSetting(base3).entries;
    expect(mergeRepositoryGroups(base3, [c3, a3, b3], ['b', 'a'])).toEqual(merged(['b', 'a']));
  });

  // Review round 2 of PR #21, F1: between the same neighbors, settings.json added an entry and edited another one.
  describe('does not guess which entry settings.json edited next to an addition', () => {
    const theirs = ['^a', '^y', '^b2', '^c'];

    it('asks about the edited entry when the editor removed it, and keeps the addition', () => {
      const [a, , c] = loaded();
      expect(merge([a, c], theirs)).toEqual({ status: 'conflicts', conflicts: [{ baseIndex: 1, base: '^b', theirs: '^b2' }], orderConflict: false });
      expect(merge([a, c], theirs, mine(1))).toMatchObject({ status: 'merged', value: ['^a', '^y', '^c'] });
      expect(merge([a, c], theirs, mine(1, 'theirs'))).toMatchObject({ status: 'merged', value: theirs });
    });

    it('asks about the edited entry when the editor edited it too, and keeps the addition', () => {
      const [a, b, c] = loaded();
      const ours = [a, { ...b, pattern: '^bm' }, c];
      expect(merge(ours, theirs)).toEqual({
        status: 'conflicts',
        conflicts: [{ baseIndex: 1, base: '^b', mine: '^bm', theirs: '^b2' }],
        orderConflict: false,
      });
      expect(merge(ours, theirs, mine(1))).toMatchObject({ status: 'merged', value: ['^a', '^y', '^bm', '^c'] });
      expect(merge(ours, theirs, mine(1, 'theirs'))).toMatchObject({ status: 'merged', value: theirs });
    });

    it('keeps settings.json when the editor did not change the entry', () => {
      expect(merge(loaded(), theirs)).toEqual(merged(theirs));
      const [a, b, c] = loaded();
      expect(merge([a, b, { ...c, pattern: '^cm' }], theirs)).toEqual(merged(['^a', '^y', '^b2', '^cm']));
    });

    it('counts an entry as removed and the others as added when no pattern is clearly the most similar', () => {
      const [a, b, c] = loaded();
      const other = ['^a', '^x', '^y', '^c'];
      // Nothing is dropped: the question is about the removal, and both additions stay.
      expect(merge([a, { ...b, pattern: '^bm' }, c], other)).toEqual({
        status: 'conflicts',
        conflicts: [{ baseIndex: 1, base: '^b', mine: '^bm' }],
        orderConflict: false,
      });
      expect(merge([a, { ...b, pattern: '^bm' }, c], other, mine(1))).toMatchObject({ status: 'merged', value: ['^a', '^bm', '^x', '^y', '^c'] });
      expect(merge([a, c], other)).toEqual(merged(other));
      expect(merge(loaded(), other)).toEqual(merged(other));
    });
  });

  // Review round 2 of PR #21, F2: of equal copies, the copy that both sides removed is the same copy.
  describe('removes a copy of a duplicate once when both sides removed one', () => {
    it('changes nothing when the editor and settings.json have the same entries', () => {
      const base = ['^d', '^d'];
      const [d1, d2] = entriesFromSetting(base).entries;
      expect(mergeRepositoryGroups(base, [d2], ['^d'])).toEqual(merged(['^d']));
      expect(mergeRepositoryGroups(base, [d1], ['^d'])).toEqual(merged(['^d']));
    });

    it('keeps the copy that the editor kept when the copies cannot be told apart', () => {
      const base = ['^d', '^d', '^e'];
      const [, d2, e] = entriesFromSetting(base).entries;
      expect(mergeRepositoryGroups(base, [d2, { ...e, pattern: '^e2' }], ['^d', '^e'])).toEqual(merged(['^d', '^e2']));
    });

    it('still removes both copies when the sides removed different copies that can be told apart', () => {
      const base = ['^a', '^b', '^a'];
      const [, b, a2] = entriesFromSetting(base).entries;
      expect(mergeRepositoryGroups(base, [b, a2], ['^a', '^b'])).toEqual(merged(['^b']));
    });
  });

  // Review round 2 of PR #21, F1: properties of the merge for random changes on both sides.
  describe('properties for random changes', () => {
    let seed = 20260926;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return Math.floor((seed / 0x80000000) * n);
    };
    const PATTERNS = ['^a', '^b', '^c', '^b2', '^bm', '^y', '^ab', '^abc', '^web-(.+)$', '^web2-(.+)$'];
    const NAMES = ['', '', 'N', 'M'];
    const randomEntry = (): unknown => {
      const pattern = PATTERNS[random(PATTERNS.length)];
      const name = NAMES[random(NAMES.length)];
      const flags = random(5) === 0 ? 'i' : '';
      return name === '' && flags === '' ? pattern : { ...(name ? { name } : {}), pattern, ...(flags ? { flags } : {}) };
    };
    // The meaning of an element: the form that the editor writes.
    const keyOf = (value: unknown) => JSON.stringify(toSettingValue(entriesFromSetting([value]).entries)[0]);
    const change = <T,>(list: T[], fresh: () => T, edit: (item: T) => T): T[] => {
      const result = [...list];
      for (let steps = random(4); steps > 0; steps--) {
        const step = random(4);
        if (step === 0 && result.length > 0) result.splice(random(result.length), 1);
        else if (step === 1) result.splice(random(result.length + 1), 0, fresh());
        else if (step === 2 && result.length > 1) result.splice(random(result.length), 0, ...result.splice(random(result.length), 1));
        else if (step === 3 && result.length > 0) {
          const at = random(result.length);
          result[at] = edit(result[at]);
        }
      }
      return result;
    };
    const changeTheirs = (base: unknown[]) => change<unknown>(base, randomEntry, () => randomEntry());
    const changeMine = (entries: EditorEntry[]) =>
      change<EditorEntry>(
        entries,
        () => entriesFromSetting([randomEntry()]).entries.map(({ origin: _origin, ...fresh }) => fresh)[0],
        (item) => ({ ...entriesFromSetting([randomEntry()]).entries[0], origin: item.origin }),
      );

    it('writes settings.json as it is when the editor changed nothing', () => {
      for (let round = 0; round < 3000; round++) {
        const base = Array.from({ length: random(6) }, randomEntry);
        const theirs = changeTheirs(base);
        const outcome = mergeRepositoryGroups(base, entriesFromSetting(base).entries, theirs);
        expect(outcome, JSON.stringify({ base, theirs })).toEqual(merged(theirs));
      }
    });

    it('keeps every change of settings.json that was not answered with Keep Mine', () => {
      for (let round = 0; round < 3000; round++) {
        const base = Array.from({ length: random(6) }, randomEntry);
        const theirs = changeTheirs(base);
        const ours = changeMine(entriesFromSetting(base).entries);
        const context = JSON.stringify({ base, ours, theirs });
        let outcome = mergeRepositoryGroups(base, ours, theirs);
        const keptMine = new Map<string, number>();
        if (outcome.status === 'conflicts') {
          const entries = new Map<number, 'mine' | 'theirs'>();
          for (const conflict of outcome.conflicts) {
            const choice = random(2) === 0 ? 'mine' : 'theirs';
            entries.set(conflict.baseIndex, choice);
            if (choice === 'mine' && conflict.theirs !== undefined) {
              keptMine.set(keyOf(conflict.theirs), (keptMine.get(keyOf(conflict.theirs)) ?? 0) + 1);
            }
          }
          outcome = mergeRepositoryGroups(base, ours, theirs, { entries, order: random(2) === 0 ? 'mine' : 'theirs' });
        }
        expect(outcome.status, context).toBe('merged');
        if (outcome.status !== 'merged') continue;
        const count = (list: unknown[], key: string) => list.filter((value) => keyOf(value) === key).length;
        const baseKeys = new Set(base.map(keyOf));
        for (const key of new Set(theirs.map(keyOf))) {
          if (baseKeys.has(key)) continue;
          const expected = count(theirs, key) - (keptMine.get(key) ?? 0);
          expect(count(outcome.value, key), `${key} in ${context} -> ${JSON.stringify(outcome.value)}`).toBeGreaterThanOrEqual(expected);
        }
      }
    });
  });

  // Review round 2 of PR #21, M5: a stored value that is not a list is never overwritten without a question.
  it('does not merge with a stored value that is not a list, and replaces it only when asked to', () => {
    const [a] = loaded();
    const ours = [a, entry('^new')];
    for (const theirs of [{ pattern: '^x' }, '^x', 42, true]) {
      expect(merge(ours, theirs)).toEqual({ status: 'notAList', theirs });
      expect(merge(ours, theirs, { replaceNotAList: true })).toEqual(merged(['^a', '^new']));
    }
    // A missing value is the empty list.
    expect(merge(ours, null)).toMatchObject({ status: 'merged' });
  });
});

describe('preview job (worker thread)', () => {
  it('reports each entry before it runs on the names, then the preview, then the test', () => {
    const messages: PreviewJobMessage[] = [];
    const entries = [entry('^x-'), entry('('), entry(EXAMPLE)];
    const input = cloneableInput(
      input_({ discovery: discovery([repo('school/2025-3bWI-SWP-module-oop-hailo')]), formatTime: () => 'never cloned' }),
    );
    expect(input && 'formatTime' in input).toBe(false);
    runPreviewJob({ id: 7, entries, testName: 'school/2026-3cWI-SWP-module-oop-EnesHA81', input }, (message) => messages.push(message));
    expect(messages.map((message) => [message.type, message.type === 'probe' ? message.entryIndex : undefined])).toEqual([
      ['probe', 0],
      ['probe', 2],
      ['preview', undefined],
      ['test', undefined],
    ]);
    expect(messages.every((message) => message.id === 7)).toBe(true);
    expect(messages[2]).toMatchObject({ preview: { loaded: true, owners: [{ owner: 'school', counts: [0, 0, 1] }] } });
    expect(messages[3]).toMatchObject({ test: { matched: true, path: ['school', '2026-3cWI-SWP', 'module-oop', 'EnesHA81'] } });
    // The messages can be sent to another thread (structured clone).
    expect(structuredClone(messages)).toEqual(messages);
  });

  it('without a render of the sidebar, runs no entry and reports no preview', () => {
    const messages: PreviewJobMessage[] = [];
    runPreviewJob({ id: 1, entries: [entry(EXAMPLE)], testName: '', input: undefined }, (message) => messages.push(message));
    expect(messages).toEqual([
      { type: 'preview', id: 1, preview: { loaded: false, owners: [], truncated: 0 } },
      { type: 'test', id: 1 },
    ]);
  });
});
