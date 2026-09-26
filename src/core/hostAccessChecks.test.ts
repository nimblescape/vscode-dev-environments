// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { hostAccessChecks, isRepositoryEntry, parseHostAccessChecksOff, withHostAccessChecks } from './hostAccessChecks';

describe('the setting devEnvLauncher.hostAccessChecksOff (concept section 8)', () => {
  it.each<[string, unknown, string[], string[]]>([
    ['no value (the default)', undefined, [], []],
    ['null', null, [], []],
    ['an empty list', [], [], []],
    ['repositories', ['acme/api', 'me/dotfiles'], ['acme/api', 'me/dotfiles'], []],
    ['entries with spaces around them', [' acme/api ', '\tme/web'], ['acme/api', 'me/web'], []],
    ['the same repository in another case', ['acme/api', 'ACME/Api'], ['acme/api'], []],
    ['names with dots, underscores, and hyphens', ['my-org/a.b_c-d', 'x/.github'], ['my-org/a.b_c-d', 'x/.github'], []],
    ['entries that are no repository name', ['acme', 'acme/', '/api', 'acme/api/x', 'ac me/api', '-acme/api', 'acme/.', 'acme/..', ''], [], ['acme', 'acme/', '/api', 'acme/api/x', 'ac me/api', '-acme/api', 'acme/.', 'acme/..', '']],
    ['entries that are no text', ['acme/api', 3, null, { repository: 'x/y' }], ['acme/api'], ['3', 'null', '{"repository":"x/y"}']],
    ['a text in place of a list', 'acme/api', [], ['"acme/api"']],
    ['an object in place of a list', { 'acme/api': true }, [], ['{"acme/api":true}']],
  ])('%s', (_name, value, repositories, invalid) => {
    expect(parseHostAccessChecksOff(value)).toEqual({ repositories, invalid });
  });

  it('knows a repository name', () => {
    expect(isRepositoryEntry('acme/api')).toBe(true);
    expect(isRepositoryEntry(' acme/api')).toBe(false);
    expect(isRepositoryEntry('acme/api ')).toBe(false);
  });
});

describe('hostAccessChecks: the switch of one repository', () => {
  it('is on by default and for every repository that the setting does not list', () => {
    expect(hostAccessChecks('acme/api', { hostAccessChecksOff: [] })).toBe('on');
    expect(hostAccessChecks('acme/api', {})).toBe('on');
    expect(hostAccessChecks('acme/api', { hostAccessChecksOff: ['acme/web', 'acme/api-x', 'acme'] })).toBe('on');
  });

  it('is off for a listed repository, compared without case and surrounding spaces', () => {
    expect(hostAccessChecks('acme/api', { hostAccessChecksOff: ['acme/api'] })).toBe('off');
    expect(hostAccessChecks('Acme/API', { hostAccessChecksOff: ['acme/api'] })).toBe('off');
    expect(hostAccessChecks('acme/api', { hostAccessChecksOff: [' ACME/api '] })).toBe('off');
  });
});

describe('withHostAccessChecks: the new value of the setting after a command', () => {
  it('adds the repository for Turn Off, once', () => {
    expect(withHostAccessChecks(undefined, 'acme/api', 'off')).toEqual(['acme/api']);
    expect(withHostAccessChecks(['me/web'], 'acme/api', 'off')).toEqual(['me/web', 'acme/api']);
    expect(withHostAccessChecks(['ACME/api'], 'acme/api', 'off')).toEqual(['ACME/api']);
    expect(withHostAccessChecks('garbage', 'acme/api', 'off')).toEqual(['acme/api']);
  });

  it('removes every entry of the repository for Turn On, and keeps the other entries as they are', () => {
    expect(withHostAccessChecks(['acme/api', ' ACME/API ', 'me/web', 'not a name', 7], 'acme/api', 'on')).toEqual(['me/web', 'not a name', 7]);
    expect(withHostAccessChecks(undefined, 'acme/api', 'on')).toEqual([]);
  });
});
