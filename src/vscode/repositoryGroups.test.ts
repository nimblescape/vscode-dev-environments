// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { matchRepositoryGroup, parseRepositoryGroups, RepositoryGroupTexts } from './repositoryGroups';

const EXAMPLE = String.raw`^(\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$`;

describe('parseRepositoryGroups', () => {
  it.each<[string, unknown, { name?: string; source: string; flags: string }]>([
    ['a string is the pattern', '^a', { source: '^a', flags: '' }],
    ['an object with a pattern', { pattern: '^a' }, { source: '^a', flags: '' }],
    ['an object with a name', { name: 'Courses', pattern: '^a' }, { name: 'Courses', source: '^a', flags: '' }],
    ['a name is trimmed', { name: '  Courses ', pattern: '^a' }, { name: 'Courses', source: '^a', flags: '' }],
    ['an empty name gives no root node', { name: '  ', pattern: '^a' }, { source: '^a', flags: '' }],
    ['the flags i, u, and s', { pattern: '^a', flags: 'ius' }, { source: '^a', flags: 'isu' }],
    ['a repeated flag counts once', { pattern: '^a', flags: 'ii' }, { source: '^a', flags: 'i' }],
    ['other properties are ignored', { pattern: '^a', other: 1 }, { source: '^a', flags: '' }],
  ])('reads a valid entry: %s', (_case, entry, expected) => {
    const { patterns, problems } = parseRepositoryGroups([entry]);
    expect(problems).toEqual([]);
    expect(patterns).toHaveLength(1);
    const [pattern] = patterns;
    expect(pattern.index).toBe(0);
    expect(pattern.name).toBe(expected.name);
    expect(pattern.source).toBe(expected.source);
    expect(pattern.regex.source).toBe(expected.source);
    expect(pattern.regex.flags).toBe(expected.flags);
  });

  it.each<[string, unknown, string]>([
    ['a number', 3, RepositoryGroupTexts.wrongType('3')],
    ['null', null, RepositoryGroupTexts.wrongType('null')],
    ['a list', ['^a'], RepositoryGroupTexts.wrongType('["^a"]')],
    ['an object without pattern', { name: 'A' }, RepositoryGroupTexts.wrongType('{"name":"A"}')],
    ['a pattern that is not a text', { pattern: 1 }, RepositoryGroupTexts.wrongType('{"pattern":1}')],
    ['a name that is not a text', { name: 1, pattern: '^a' }, RepositoryGroupTexts.wrongType('{"name":1,"pattern":"^a"}')],
    ['flags that are not a text', { pattern: '^a', flags: 1 }, RepositoryGroupTexts.wrongType('{"pattern":"^a","flags":1}')],
    ['an empty pattern', '', RepositoryGroupTexts.empty('""')],
    ['an empty pattern in an object', { pattern: '' }, RepositoryGroupTexts.empty('{"pattern":""}')],
  ])('leaves out an entry of the wrong type: %s', (_case, entry, message) => {
    expect(parseRepositoryGroups([entry])).toEqual({ patterns: [], problems: [{ index: 0, message }] });
  });

  it('leaves out a regular expression that is not valid, and names the entry and the error', () => {
    const { patterns, problems } = parseRepositoryGroups(['(', { pattern: '[' }]);
    expect(patterns).toEqual([]);
    expect(problems.map((problem) => problem.index)).toEqual([0, 1]);
    expect(problems[0].message).toMatch(/^The repository group "\(" in the setting devEnvLauncher\.repositoryGroups is ignored: /);
    expect(problems[0].message).toContain('not valid');
    // The error of JavaScript is part of the text.
    expect(problems[0].message).toContain('Unterminated group');
    expect(problems[1].message).toContain('{"pattern":"["}');
  });

  it('ignores other flags with a problem and uses the entry without them', () => {
    const { patterns, problems } = parseRepositoryGroups([{ pattern: '^a', flags: 'gimyi' }]);
    expect(patterns.map((pattern) => pattern.regex.flags)).toEqual(['i']);
    expect(problems).toEqual([
      { index: 0, message: RepositoryGroupTexts.ignoredFlags('{"pattern":"^a","flags":"gimyi"}', 'gmy') },
    ]);
  });

  it('keeps the index of each entry in the setting, also after invalid entries', () => {
    const { patterns, problems } = parseRepositoryGroups(['(', '^a', 5, { name: 'B', pattern: '^b' }]);
    expect(patterns.map((pattern) => [pattern.index, pattern.name, pattern.source])).toEqual([
      [1, undefined, '^a'],
      [3, 'B', '^b'],
    ]);
    expect(problems.map((problem) => problem.index)).toEqual([0, 2]);
  });

  it('reads a missing or empty setting as no patterns', () => {
    expect(parseRepositoryGroups(undefined)).toEqual({ patterns: [], problems: [] });
    expect(parseRepositoryGroups([])).toEqual({ patterns: [], problems: [] });
  });
});

describe('matchRepositoryGroup', () => {
  const match = (entries: unknown[], name: string) => {
    const result = matchRepositoryGroup(parseRepositoryGroups(entries).patterns, name);
    return result && { index: result.pattern.index, levels: result.levels, label: result.label };
  };

  it.each<[string, unknown[], string, { index: number; levels: string[]; label: string } | undefined]>([
    ['no match', ['^x'], 'api', undefined],
    ['0 groups: filter only, the name is the label', ['^a'], 'api', { index: 0, levels: [], label: 'api' }],
    ['1 group: the label, no level', ['^a(.*)$'], 'api', { index: 0, levels: [], label: 'pi' }],
    ['2 groups: one level and the label', ['^(\\w+)-(.+)$'], 'web-shop', { index: 0, levels: ['web'], label: 'shop' }],
    [
      'the example of the user',
      [EXAMPLE],
      '2026-3cWI-SWP-module-oop-felix-he021',
      { index: 0, levels: ['2026-3cWI-SWP', 'module-oop'], label: 'felix-he021' },
    ],
    [
      'a group that did not take part is skipped',
      ['^(x-)?(\\w+)-(.+)$'],
      'web-shop',
      { index: 0, levels: ['web'], label: 'shop' },
    ],
    ['an empty group is skipped', ['^(x*)(\\w+)-(.+)$'], 'web-shop', { index: 0, levels: ['web'], label: 'shop' }],
    ['an empty last group gives the name', ['^(\\w+)-shop(.*)$'], 'web-shop', { index: 0, levels: ['web'], label: 'web-shop' }],
    ['a last group that did not take part gives the name', ['^(\\w+)-shop(-x)?$'], 'web-shop', { index: 0, levels: ['web'], label: 'web-shop' }],
    [
      'named groups count in their numeric position',
      ['^(?<top>\\w+)-(\\w+)-(?<leaf>.+)$'],
      'a-b-c',
      { index: 0, levels: ['a', 'b'], label: 'c' },
    ],
    ['the first matching pattern wins', ['^x', '^(a)(.*)$', '^a'], 'api', { index: 1, levels: ['a'], label: 'pi' }],
    ['a later pattern when the first does not match', ['^x', '^a'], 'api', { index: 1, levels: [], label: 'api' }],
    ['case matters without the flag i', ['^API$'], 'api', undefined],
    ['the flag i ignores case', [{ pattern: '^API$', flags: 'i' }], 'api', { index: 0, levels: [], label: 'api' }],
    ['no anchor: a match anywhere in the name', ['pi'], 'api', { index: 0, levels: [], label: 'api' }],
  ])('%s', (_case, entries, name, expected) => {
    expect(match(entries, name)).toEqual(expected);
  });

  it('gives the same result when a pattern is used many times (no state between matches)', () => {
    const { patterns } = parseRepositoryGroups([{ pattern: '^(\\w)', flags: 'gy' }]);
    for (let i = 0; i < 3; i++) expect(matchRepositoryGroup(patterns, 'abc')?.label).toBe('a');
  });
});
