// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { DiscoveryData, RepositoryInfo } from '../types';
import type { GraphQLError } from './githubApi';
import { checkedRepository, needsConfigurationLookup, nodesWithErrors, storedDetections } from './incremental';

function info(nameWithOwner: string, pushedAt: string | null, configPaths: string[]): RepositoryInfo {
  const [owner, name] = nameWithOwner.split('/');
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt,
    defaultBranch: 'main',
    configPaths,
  };
}

describe('needsConfigurationLookup', () => {
  type State = { pushedAt: string | null; defaultBranch: string | null };
  const stored: State = { pushedAt: '2026-09-20T10:00:00Z', defaultBranch: 'main' };
  it.each<[string, State, State | undefined, boolean]>([
    ['a new repository', stored, undefined, true],
    ['an unchanged repository', { ...stored }, stored, false],
    ['a new push', { ...stored, pushedAt: '2026-09-21T08:00:00Z' }, stored, true],
    ['another default branch', { ...stored, defaultBranch: 'develop' }, stored, true],
    ['an empty repository that is still empty', { pushedAt: null, defaultBranch: null }, { pushedAt: null, defaultBranch: null }, false],
    ['a first push into an empty repository', stored, { pushedAt: null, defaultBranch: null }, true],
  ])('%s', (_name, listed, previous, expected) => {
    expect(needsConfigurationLookup(listed, previous)).toBe(expected);
  });
});

describe('storedDetections', () => {
  it('is empty without a stored list', () => {
    expect(storedDetections(undefined).size).toBe(0);
  });

  it('reads the repositories with and without configuration, by lower-case name', () => {
    const data: DiscoveryData = {
      version: 1,
      fetchedAt: '2026-09-25T12:00:00Z',
      viewerLogin: 'octo',
      organizations: [],
      repositories: [info('Acme/API', '2026-09-20T10:00:00Z', ['.devcontainer.json'])],
      hints: [],
      withoutConfiguration: [{ nameWithOwner: 'acme/empty', pushedAt: '2026-09-19T10:00:00Z', defaultBranch: 'main' }],
    };
    expect([...storedDetections(data)]).toEqual([
      ['acme/empty', { pushedAt: '2026-09-19T10:00:00Z', defaultBranch: 'main', configPaths: [] }],
      ['acme/api', { pushedAt: '2026-09-20T10:00:00Z', defaultBranch: 'main', configPaths: ['.devcontainer.json'] }],
    ]);
  });

  it('reads a list of an older version, which has no repositories without configuration', () => {
    const data: DiscoveryData = { version: 1, fetchedAt: '', viewerLogin: 'octo', organizations: [], repositories: [], hints: [] };
    expect(storedDetections(data).size).toBe(0);
  });
});

describe('nodesWithErrors', () => {
  it.each<[string, GraphQLError[], number[]]>([
    ['no errors', [], []],
    ['an error in a node of the full list', [{ message: 'x', path: ['viewer', 'repositories', 'nodes', 3, 'folder'] }], [3]],
    ['an error in a node of an owner', [{ message: 'x', path: ['repositoryOwner', 'repositories', 'nodes', 0] }], [0]],
    ['an error outside of the nodes', [{ message: 'x', path: ['viewer', 'organizations', 'nodes', 1] }, { message: 'y' }], []],
  ])('%s', (_name, errors, expected) => {
    expect([...nodesWithErrors(errors)]).toEqual(expected);
  });
});

describe('checkedRepository', () => {
  it('keeps only the name and the state of GitHub', () => {
    expect(checkedRepository(info('acme/empty', null, []))).toEqual({ nameWithOwner: 'acme/empty', pushedAt: null, defaultBranch: 'main' });
  });
});
