// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { ownerChoices, ownersFiltered, OwnerTexts, selectedOwners } from './ownerChoices';

describe('ownerChoices', () => {
  it('lists the account first, then its organizations in alphabetical order, and selects the owners of the setting', () => {
    expect(ownerChoices({ viewerLogin: 'octo', organizations: ['zeta', 'Acme', 'beta'], owners: ['ACME', 'octo'] })).toEqual([
      { login: 'octo', label: 'octo', description: OwnerTexts.yourAccount, picked: true },
      { login: 'Acme', label: 'Acme', picked: true },
      { login: 'beta', label: 'beta', picked: false },
      { login: 'zeta', label: 'zeta', picked: false },
    ]);
    expect(OwnerTexts.yourAccount).toBe('your account');
  });

  it('keeps the owners of the setting that are in neither list, selected, so that they can be removed', () => {
    expect(ownerChoices({ viewerLogin: 'octo', organizations: ['acme'], owners: ['torvalds', ' Acme ', 'TORVALDS'] })).toEqual([
      { login: 'octo', label: 'octo', description: 'your account', picked: false },
      { login: 'acme', label: 'acme', picked: true },
      { login: 'torvalds', label: 'torvalds', description: OwnerTexts.fromSettings, picked: true },
    ]);
  });

  it.each<[string, string[], string[]]>([
    ['nothing selected when the setting is empty', [], []],
    ['an organization that is also the account is listed once', ['octo'], ['octo']],
  ])('%s', (_name, owners, picked) => {
    const choices = ownerChoices({ viewerLogin: 'octo', organizations: ['OCTO', 'acme'], owners });
    expect(choices.map((choice) => choice.login)).toEqual(['octo', 'acme']);
    expect(choices.filter((choice) => choice.picked).map((choice) => choice.login)).toEqual(picked);
  });
});

describe('selectedOwners', () => {
  it.each<[string, string[], string[]]>([
    ['an empty selection means all repositories', [], []],
    ['the logins of the selection, each once', ['octo', 'acme', 'ACME'], ['octo', 'acme']],
  ])('%s', (_name, logins, expected) => {
    expect(selectedOwners(logins.map((login) => ({ login })))).toEqual(expected);
  });
});

describe('ownersFiltered', () => {
  it.each<[unknown[], boolean]>([
    [[], false],
    [['', '  '], false],
    [['acme'], true],
  ])('%j gives %s', (owners, expected) => {
    expect(ownersFiltered(owners)).toBe(expected);
  });
});
