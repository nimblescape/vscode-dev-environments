// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { availableEnvironments, isAvailableTo, ownerOf } from './ownership';
import type { Environment, GitHubAccount } from './types';

const SCALARION: GitHubAccount = { id: '1001', login: 'scalarion' };
const STAUSSH: GitHubAccount = { id: '2002', login: 'staussh' };
const OTHER: GitHubAccount = { id: '3003', login: 'other' };

function environment(id: string, repository: string, owner: GitHubAccount): Environment {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devenv-${id}`,
    containerName: `devenv-${id}`,
    createdAt: '2026-09-24T10:00:00.000Z',
    lastUsedAt: '2026-09-24T10:00:00.000Z',
    owner,
  };
}

describe('isAvailableTo (concept 7.5, section 9 "Accounts")', () => {
  it.each([
    ['the owner', { owner: SCALARION }, SCALARION, true],
    ['the owner with another login (renamed on GitHub)', { owner: { id: '1001', login: 'old-name' } }, SCALARION, true],
    ['an owner restored from a volume label (no login yet)', { owner: { id: '1001', login: '' } }, SCALARION, true],
    ['another account', { owner: SCALARION }, STAUSSH, false],
    ['another account with the same login', { owner: SCALARION }, { id: '3003', login: 'scalarion' }, false],
    ['nobody signed in', { owner: SCALARION }, undefined, false],
  ])('%s', (_name, environment: Pick<Environment, 'owner'>, account: GitHubAccount | undefined, expected) => {
    expect(isAvailableTo(environment, account)).toBe(expected);
  });

  it('keeps only the environments of the account, in their order', () => {
    const list = [environment('a', 'o/a', SCALARION), environment('b', 'o/b', STAUSSH), environment('c', 'o/c', OTHER), environment('d', 'o/d', SCALARION)];
    expect(availableEnvironments(list, SCALARION).map((entry) => entry.id)).toEqual(['a', 'd']);
    expect(availableEnvironments(list, STAUSSH).map((entry) => entry.id)).toEqual(['b']);
    expect(availableEnvironments(list, undefined)).toEqual([]);
  });

  it('stores the ID and the login of the account as the owner', () => {
    expect(ownerOf({ ...SCALARION, extra: 1 } as GitHubAccount)).toEqual(SCALARION);
  });
});
