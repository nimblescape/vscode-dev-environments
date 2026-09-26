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
  checkEntries,
  editorHtml,
  editorState,
  entriesFromSetting,
  mergeRepositoryGroups,
  parseEditorRequest,
  sameSettingValue,
  testRepositoryName,
  toSettingValue,
  type EditorEntry,
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
  const context = { baseLength: 2 };
  const valid = { name: 'A', pattern: '^a', flags: 'is' };

  it('accepts exactly the messages of the editor', () => {
    expect(parseEditorRequest({ type: 'ready' }, context)).toEqual({ type: 'ready' });
    expect(parseEditorRequest({ type: 'reload' }, context)).toEqual({ type: 'reload' });
    expect(parseEditorRequest({ type: 'cancel' }, context)).toEqual({ type: 'cancel' });
    expect(parseEditorRequest({ type: 'update', seq: 3, entries: [valid, { ...valid, origin: 1 }], testName: 'x' }, context)).toEqual({
      type: 'update',
      seq: 3,
      entries: [valid, { ...valid, origin: 1 }],
      testName: 'x',
    });
    expect(parseEditorRequest({ type: 'save', seq: 0, entries: [] }, context)).toEqual({ type: 'save', seq: 0, entries: [] });
  });

  it.each<[string, unknown]>([
    ['not an object', 'save'],
    ['a list', [{ type: 'ready' }]],
    ['null', null],
    ['an unknown type', { type: 'write' }],
    ['an extra property', { type: 'ready', extra: 1 }],
    ['a missing property', { type: 'update', seq: 1, entries: [] }],
    ['a sequence that is no whole number', { type: 'save', seq: 1.5, entries: [] }],
    ['a negative sequence', { type: 'save', seq: -1, entries: [] }],
    ['entries that are no list', { type: 'save', seq: 1, entries: {} }],
    ['an entry that is a string', { type: 'save', seq: 1, entries: ['^a'] }],
    ['an entry with an extra property', { type: 'save', seq: 1, entries: [{ ...valid, regex: '^a' }] }],
    ['an entry without flags', { type: 'save', seq: 1, entries: [{ name: '', pattern: '^a' }] }],
    ['a pattern that is no text', { type: 'save', seq: 1, entries: [{ ...valid, pattern: 1 }] }],
    ['the flag g', { type: 'save', seq: 1, entries: [{ ...valid, flags: 'g' }] }],
    ['a repeated flag', { type: 'save', seq: 1, entries: [{ ...valid, flags: 'ii' }] }],
    ['an origin outside the loaded value', { type: 'save', seq: 1, entries: [{ ...valid, origin: 2 }] }],
    ['an origin twice', { type: 'save', seq: 1, entries: [{ ...valid, origin: 0 }, { ...valid, origin: 0 }] }],
    ['an origin that is no whole number', { type: 'save', seq: 1, entries: [{ ...valid, origin: '0' }] }],
    ['a pattern over the limit', { type: 'save', seq: 1, entries: [{ ...valid, pattern: 'a'.repeat(EditorLimits.pattern + 1) }] }],
    ['a name over the limit', { type: 'save', seq: 1, entries: [{ ...valid, name: 'a'.repeat(EditorLimits.name + 1) }] }],
    ['too many entries', { type: 'save', seq: 1, entries: Array.from({ length: EditorLimits.entries + 1 }, () => valid) }],
    ['a test name over the limit', { type: 'update', seq: 1, entries: [], testName: 'a'.repeat(EditorLimits.testName + 1) }],
    ['an object with another prototype', Object.assign(Object.create({ polluted: true }) as object, { type: 'ready' })],
  ])('refuses %s', (_case, raw) => {
    expect(parseEditorRequest(raw, context)).toBeUndefined();
  });

  it('sorts the flags of an entry', () => {
    const request = parseEditorRequest({ type: 'save', seq: 1, entries: [{ ...valid, flags: 'si' }] }, context);
    expect(request).toEqual({ type: 'save', seq: 1, entries: [{ ...valid, flags: 'is' }] });
  });
});

describe('state and HTML of the webview', () => {
  it('computes the checks, the dirty flag, and the test for the webview', () => {
    const loaded = entriesFromSetting([EXAMPLE]).entries;
    const state = editorState({
      seq: 4,
      entries: [...loaded, entry('(')],
      loaded,
      testName: 'x',
      input: undefined,
      changedOutside: true,
    });
    expect(state).toMatchObject({ type: 'state', seq: 4, canSave: false, dirty: true, changedOutside: true });
    expect(state.checks).toHaveLength(2);
    expect(state.test?.matched).toBe(false);
    expect(editorState({ seq: 0, entries: loaded, loaded, testName: '', input: undefined, changedOutside: false })).toMatchObject({
      canSave: true,
      dirty: false,
    });
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
  const merge = (ours: EditorEntry[], theirs: unknown, choices?: Map<number, 'mine' | 'theirs'>) =>
    mergeRepositoryGroups(BASE, ours, theirs, choices);

  it('changes nothing when neither side changed', () => {
    expect(merge(loaded(), [...BASE])).toEqual({ status: 'merged', value: BASE, conflicts: [] });
  });

  it('applies the changes of the editor alone: edit, removal, addition, and move', () => {
    const [a, b, c] = loaded();
    expect(merge([{ ...b, pattern: '^B' }, a, entry('^d', 'D')], [...BASE])).toEqual({
      status: 'merged',
      value: ['^B', '^a', { name: 'D', pattern: '^d' }],
      conflicts: [],
    });
    expect(c.origin).toBe(2);
  });

  it('keeps the changes of settings.json alone', () => {
    const theirs = ['^x', '^a', { name: 'B', pattern: '^b' }, '^c', '^y'];
    expect(merge(loaded(), theirs)).toEqual({ status: 'merged', value: theirs, conflicts: [] });
    expect(merge(loaded(), undefined)).toEqual({ status: 'merged', value: [], conflicts: [] });
  });

  it('merges changes of different entries on both sides', () => {
    const [a, b, c] = loaded();
    const ours = [{ ...a, pattern: '^A' }, b, c, entry('^mine')];
    const theirs = ['^theirs', '^a', '^b', '^C'];
    expect(merge(ours, theirs)).toEqual({
      status: 'merged',
      value: ['^theirs', '^A', '^b', '^C', '^mine'],
      conflicts: [],
    });
    // A removal in the editor and an edit of another entry in settings.json.
    expect(merge([a, c], ['^a', '^b', '^C2'])).toEqual({ status: 'merged', value: ['^a', '^C2'], conflicts: [] });
    // An addition in the editor stays after its predecessor when settings.json removed an entry.
    expect(merge([a, b, entry('^new'), c], ['^a', '^c'])).toEqual({ status: 'merged', value: ['^a', '^new', '^c'], conflicts: [] });
  });

  it('is no conflict when both sides changed an entry in the same way', () => {
    const [a, b, c] = loaded();
    expect(merge([a, { ...b, name: 'B' }, c], ['^a', { pattern: '^b', name: 'B' }, '^c'])).toEqual({
      status: 'merged',
      value: ['^a', { pattern: '^b', name: 'B' }, '^c'],
      conflicts: [],
    });
    // The same addition on both sides is written once.
    expect(merge([a, b, c, entry('^d')], ['^a', '^b', '^c', '^d'])).toMatchObject({ value: ['^a', '^b', '^c', '^d'] });
  });

  it('asks about an entry changed differently on both sides, and only about that entry', () => {
    const [a, b, c] = loaded();
    const ours = [{ ...a, pattern: '^A' }, { ...b, pattern: '^B1' }, c];
    const theirs = ['^a', '^B2', '^c', '^t'];
    const outcome = merge(ours, theirs);
    expect(outcome).toEqual({ status: 'conflicts', conflicts: [{ baseIndex: 1, base: '^b', mine: '^B1', theirs: '^B2' }] });
    expect(merge(ours, theirs, new Map([[1, 'mine']]))).toMatchObject({ status: 'merged', value: ['^A', '^B1', '^c', '^t'] });
    expect(merge(ours, theirs, new Map([[1, 'theirs']]))).toMatchObject({ status: 'merged', value: ['^A', '^B2', '^c', '^t'] });
  });

  it('asks when the editor edits an entry that settings.json removed', () => {
    const [a, b, c] = loaded();
    const ours = [a, { ...b, pattern: '^B' }, c];
    const theirs = ['^a', '^c'];
    expect(merge(ours, theirs)).toEqual({ status: 'conflicts', conflicts: [{ baseIndex: 1, base: '^b', mine: '^B' }] });
    expect(merge(ours, theirs, new Map([[1, 'mine']]))).toMatchObject({ status: 'merged', value: ['^a', '^B', '^c'] });
    expect(merge(ours, theirs, new Map([[1, 'theirs']]))).toMatchObject({ status: 'merged', value: ['^a', '^c'] });
    // And the other way: removed in the editor, edited in settings.json.
    expect(merge([a, c], ['^a', '^B2', '^c'])).toEqual({ status: 'conflicts', conflicts: [{ baseIndex: 1, base: '^b', theirs: '^B2' }] });
  });

  it('merges a move on one side with an edit on the other', () => {
    const [a, b, c] = loaded();
    // Moved in the editor, edited in settings.json.
    expect(merge([c, a, b], ['^A', '^b', '^c'])).toEqual({ status: 'merged', value: ['^c', '^A', '^b'], conflicts: [] });
    // Moved in settings.json, edited in the editor.
    expect(merge([{ ...a, pattern: '^A' }, b, c], ['^c', '^a', '^b'])).toEqual({
      status: 'merged',
      value: ['^c', '^A', '^b'],
      conflicts: [],
    });
  });

  it('matches objects of settings.json to the loaded entries by pattern or name when they were edited', () => {
    const base = [{ name: 'Courses', pattern: '^c-(.+)$' }, '^x'];
    const ours = entriesFromSetting(base).entries;
    ours[1] = { ...ours[1], pattern: '^X' };
    const theirs = ['^new', { name: 'Courses', pattern: '^c-(.+)$', flags: 'i' }, '^x'];
    expect(mergeRepositoryGroups(base, ours, theirs)).toEqual({
      status: 'merged',
      value: ['^new', { name: 'Courses', pattern: '^c-(.+)$', flags: 'i' }, '^X'],
      conflicts: [],
    });
  });

  it('removes the entries of the wrong type that the editor could not show, unless settings.json changed them', () => {
    const base = [3, '^a'];
    const ours = entriesFromSetting(base).entries;
    expect(mergeRepositoryGroups(base, ours, [3, '^a'])).toEqual({ status: 'merged', value: ['^a'], conflicts: [] });
  });
});
