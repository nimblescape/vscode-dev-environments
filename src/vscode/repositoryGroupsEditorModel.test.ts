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
  describeSettingEntry,
  describeSettingList,
  MAX_SHOWN_ENTRY,
  MAX_SHOWN_LINES,
  parseEditorRequest,
  sameSettingValue,
  testRepositoryName,
  toSettingValue,
  cloneableInput,
  runPreviewJob,
  type EditorEntry,
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

  it('reads what it writes (round trip)', () => {
    const entries = [entry('^a'), entry('^b', 'Courses'), entry('^c', '', 'is'), entry(EXAMPLE, 'Students', 'u')];
    const value = toSettingValue(entries);
    const { entries: loaded, notices } = entriesFromSetting(value);
    expect(notices).toEqual([]);
    expect(loaded).toEqual(entries);
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
      { name: '', pattern: '(', flags: '' },
      { name: '', pattern: '^a', flags: 'i' },
      { name: '', pattern: '', flags: '' },
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
  const context = { generation: 5 };
  const valid = { name: 'A', pattern: '^a', flags: 'is' };

  it('accepts exactly the messages of the editor', () => {
    expect(parseEditorRequest({ type: 'ready' }, context)).toEqual({ type: 'ready' });
    expect(parseEditorRequest({ type: 'reload' }, context)).toEqual({ type: 'reload' });
    expect(parseEditorRequest({ type: 'cancel' }, context)).toEqual({ type: 'cancel' });
    expect(parseEditorRequest({ type: 'update', seq: 3, generation: 5, entries: [valid, valid], testName: 'x' }, context)).toEqual({
      type: 'update',
      seq: 3,
      generation: 5,
      entries: [valid, valid],
      testName: 'x',
    });
    expect(parseEditorRequest({ type: 'save', seq: 0, generation: 5, entries: [] }, context)).toEqual({ type: 'save', seq: 0, generation: 5, entries: [] });
    // An update of an earlier load: its entries were edited from another value.
    expect(parseEditorRequest({ type: 'save', seq: 0, generation: 4, entries: [valid] }, context)).toEqual({ type: 'stale' });
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
    // The merge that used an origin is gone (user decision A, 2026-09-26): an entry has no other property.
    ['an entry with an origin', { type: 'save', seq: 1, generation: 5, entries: [{ ...valid, origin: 0 }] }],
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

describe('text of settings.json in the question of Save', () => {
  it('shows the list one entry per line', () => {
    expect(describeSettingList(['^a', { name: 'B', pattern: '^b' }])).toBe('\n1. "^a"\n2. {"name":"B","pattern":"^b"}');
    expect(describeSettingList([])).toBe('(no entries)');
    expect(describeSettingList(undefined)).toBe('(no entries)');
  });

  it('cuts each long entry, and never hides the whole list', () => {
    const long = 'a'.repeat(5000);
    const text = describeSettingList([long, long, '^short']);
    const lines = text.split('\n').filter((line) => line !== '');
    expect(lines[0]).toBe(`1. "${'a'.repeat(MAX_SHOWN_ENTRY - 1)}… (5002 characters)`);
    // Each entry is cut, so all three fit.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('3. "^short"');
    expect(describeSettingEntry(long).length).toBeLessThan(MAX_SHOWN_ENTRY + 30);
  });

  it('counts the entries after MAX_SHOWN_LINES', () => {
    const value = Array.from({ length: MAX_SHOWN_LINES + 5 }, (_, index) => `^e${index}`);
    const lines = describeSettingList(value).split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(MAX_SHOWN_LINES + 1);
    expect(lines[MAX_SHOWN_LINES]).toBe('… and 5 more entries');
  });

  it('describes a value that is not a list, cut as well', () => {
    expect(describeSettingList({ pattern: '^x' })).toBe('{"pattern":"^x"}');
    expect(describeSettingEntry(42)).toBe('42');
    expect(describeSettingEntry({ pattern: 'x'.repeat(1000) })).toMatch(/… \(1014 characters\)$/);
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
