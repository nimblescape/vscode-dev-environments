// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { isOwnerInScope, isRepositoryInScope, normalizeScope, sameScope, scopeLogins } from './scope';

describe('scopeLogins', () => {
  it.each<[string, unknown[] | undefined, string[]]>([
    ['no setting', undefined, []],
    ['an empty list', [], []],
    ['trims and drops empty entries', [' acme ', '', '  '], ['acme']],
    ['drops entries that are not text', ['acme', 3, null, { login: 'x' }], ['acme']],
    ['keeps the order and the first spelling of a duplicate', ['Octo', 'acme', 'OCTO', 'Acme'], ['Octo', 'acme']],
  ])('%s', (_name, owners, expected) => {
    expect(scopeLogins(owners)).toEqual(expected);
  });
});

describe('normalizeScope', () => {
  it.each<[string, unknown[] | undefined, string[]]>([
    ['no setting: all repositories', undefined, []],
    ['lower case, sorted, without duplicates', ['Octo', ' acme', 'ACME'], ['acme', 'octo']],
  ])('%s', (_name, owners, expected) => {
    expect(normalizeScope(owners)).toEqual(expected);
  });
});

describe('sameScope', () => {
  it.each<[string, unknown[] | undefined, unknown[] | undefined, boolean]>([
    ['a missing scope is the empty scope', undefined, [], true],
    ['order and case do not matter', ['Acme', 'octo'], ['OCTO', 'acme'], true],
    ['an added owner is another scope', ['acme'], ['acme', 'octo'], false],
    ['the empty scope differs from a configured one', [], ['acme'], false],
    ['another owner', ['acme'], ['beta'], false],
  ])('%s', (_name, a, b, expected) => {
    expect(sameScope(a, b)).toBe(expected);
    expect(sameScope(b, a)).toBe(expected);
  });
});

describe('isOwnerInScope and isRepositoryInScope', () => {
  it.each<[string, unknown[], string, boolean]>([
    ['the empty scope includes every owner', [], 'anyone/x', true],
    ['a configured owner, case-insensitive', ['Acme'], 'ACME/api', true],
    ['an owner outside the scope', ['acme'], 'octo/dotfiles', false],
    ['a prefix of an owner is another owner', ['acme'], 'acme-university/api', false],
  ])('%s', (_name, owners, repository, expected) => {
    expect(isRepositoryInScope(owners, repository)).toBe(expected);
    expect(isOwnerInScope(owners, repository.split('/')[0])).toBe(expected);
  });
});
