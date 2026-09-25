// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { DiscoveryData, Environment, RepositoryInfo } from '../core/types';
import { ControllerTexts } from './controllerTexts';
import { dockerStoppedRuntime, environmentIdsOf, liveBusyEnvironmentIds } from './sidebarData';
import {
  branchChoices,
  configurationChoices,
  findRepositoryInfo,
  gitHubUrl,
  isPlausibleBranchName,
  ownerTrust,
  parseCommandArgument,
  pickerRepositories,
  placeholderRepositoryInfo,
  repositoriesToLookUp,
  repositoryKey,
  repositoryTarget,
} from './targets';
import { buildTreeModel, type RepositoryRow } from './treeModel';

const NOW = Date.parse('2026-09-25T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function repo(nameWithOwner: string, overrides: Partial<RepositoryInfo> = {}): RepositoryInfo {
  const [owner, name] = nameWithOwner.split('/');
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: iso(NOW),
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
    ...overrides,
  };
}

function environment(id: string, repository: string, overrides: Partial<Environment> = {}): Environment {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devenv-${id}`,
    containerName: `devenv-${id}`,
    createdAt: iso(NOW),
    lastUsedAt: iso(NOW),
    ...overrides,
  };
}

function discovery(repositories: RepositoryInfo[], overrides: Partial<DiscoveryData> = {}): DiscoveryData {
  return { version: 1, fetchedAt: iso(NOW), viewerLogin: 'me', organizations: ['acme'], repositories, hints: [], ...overrides };
}

const settings = { owners: [], includeArchived: false, includeForks: true };

describe('parseCommandArgument', () => {
  it('reads a row of the sidebar', () => {
    const groups = buildTreeModel({
      discovery: discovery([repo('acme/api'), repo('acme/web')]),
      settings,
      environments: [environment('e1', 'acme/api')],
      runtime: undefined,
      currentEnvironmentId: null,
      otherWindowEnvironmentIds: new Set(),
      busyEnvironmentIds: new Set(),
      liveBranches: new Map(),
      signedIn: true,
    });
    const rows = groups[0].children as RepositoryRow[];
    expect(parseCommandArgument(rows[0])).toEqual({ kind: 'row', repository: 'acme/api', info: rows[0].info, environmentId: 'e1' });
    expect(parseCommandArgument(rows[1])).toEqual({ kind: 'row', repository: 'acme/web', info: rows[1].info, environmentId: undefined });
  });

  it('reads the argument of the status bar item Reconnect', () => {
    expect(parseCommandArgument({ environmentId: 'e1' })).toEqual({ kind: 'environment', environmentId: 'e1' });
  });

  it.each([undefined, null, 'acme/api', 42, [], {}, { environmentId: '' }, { kind: 'owner', id: 'owner:acme' }, { kind: 'hint' }, { kind: 'repository', repository: 'noslash' }])(
    'treats %j as no argument',
    (value) => {
      expect(parseCommandArgument(value)).toEqual({ kind: 'none' });
    },
  );
});

describe('repositoryTarget', () => {
  it('takes the default branch and the configurations from the discovery', () => {
    const info = repo('Acme/API', { configPaths: ['.devcontainer/a/devcontainer.json', '.devcontainer/b/devcontainer.json'] });
    expect(repositoryTarget('acme/api', info, true)).toEqual({
      repository: 'Acme/API',
      defaultBranch: 'main',
      configPaths: ['.devcontainer/a/devcontainer.json', '.devcontainer/b/devcontainer.json'],
      trusted: true,
    });
  });

  it('works for an unknown repository: the pipeline finds the configuration after the clone', () => {
    expect(repositoryTarget('x/y', undefined, false)).toEqual({ repository: 'x/y', defaultBranch: null, configPaths: [], trusted: false });
  });
});

describe('ownerTrust', () => {
  const data = discovery([], { viewerLogin: 'Me', organizations: ['Acme'] });

  it('trusts the account and its organizations when the data belongs to the account', () => {
    expect(ownerTrust(data, 'me', 'ME')).toBe('trusted');
    expect(ownerTrust(data, 'me', 'acme')).toBe('trusted');
    expect(ownerTrust(data, 'me', 'stranger')).toBe('untrusted');
  });

  it('is unknown without data, without an account, or when the data belongs to another account', () => {
    expect(ownerTrust(undefined, 'me', 'me')).toBe('unknown');
    expect(ownerTrust(data, undefined, 'me')).toBe('unknown');
    expect(ownerTrust(data, 'someone-else', 'acme')).toBe('unknown');
  });
});

describe('repository lists', () => {
  it('builds a placeholder for a repository that only the registry knows', () => {
    expect(placeholderRepositoryInfo('lost/repo')).toEqual({
      nameWithOwner: 'lost/repo',
      owner: 'lost',
      name: 'repo',
      url: 'https://github.com/lost/repo',
      isArchived: false,
      isFork: false,
      isPrivate: false,
      pushedAt: null,
      defaultBranch: null,
      configPaths: [],
    });
    expect(gitHubUrl('a b/c')).toBe('https://github.com/a%20b/c');
    expect(repositoryKey('Acme/API')).toBe('acme/api');
  });

  it('finds a repository in the discovery, then in the lookups (case-insensitive)', () => {
    const listed = repo('Acme/API');
    const looked = repo('acme/old', { configPaths: [] });
    const lookups = new Map<string, RepositoryInfo | null>([
      ['acme/old', looked],
      ['acme/gone', null],
    ]);
    expect(findRepositoryInfo('acme/api', discovery([listed]), lookups)).toBe(listed);
    expect(findRepositoryInfo('ACME/old', discovery([listed]), lookups)).toBe(looked);
    expect(findRepositoryInfo('acme/gone', discovery([listed]), lookups)).toBeUndefined();
    expect(findRepositoryInfo('acme/api', undefined, new Map())).toBeUndefined();
  });

  it('lists the filtered discovery plus the repository of every environment, once each', () => {
    const result = pickerRepositories({
      data: discovery([repo('acme/api'), repo('acme/archived', { isArchived: true }), repo('acme/archived-env', { isArchived: true })]),
      settings,
      environments: [
        environment('e1', 'ACME/api'),
        environment('e2', 'acme/archived-env'),
        environment('e3', 'acme/old'),
        environment('e4', 'lost/repo'),
      ],
      lookups: new Map([['acme/old', repo('acme/old', { configPaths: [] })]]),
    });
    expect(result.map((info) => info.nameWithOwner)).toEqual(['acme/api', 'acme/archived-env', 'acme/old', 'lost/repo']);
    expect(result[3].defaultBranch).toBeNull();
  });

  it('looks up the repositories of environments that the discovery does not list, each once', () => {
    const environments = [
      environment('e1', 'acme/api'),
      environment('e2', 'acme/old'),
      environment('e3', 'ACME/OLD'),
      environment('e4', 'lost/repo'),
    ];
    expect(repositoriesToLookUp(environments, [repo('Acme/Api')])).toEqual(['acme/old', 'lost/repo']);
    expect(repositoriesToLookUp([], [repo('acme/api')])).toEqual([]);
  });

  it.each<[string, string[], string[]]>([
    ['the empty scope looks up every unlisted repository', [], ['acme/old', 'lost/repo']],
    ['a scope looks up only repositories of its owners', ['ACME'], ['acme/old']],
    ['a scope without these owners looks up nothing', ['beta'], []],
  ])('with a scan scope: %s', (_name, owners, expected) => {
    const environments = [environment('e1', 'acme/api'), environment('e2', 'acme/old'), environment('e4', 'lost/repo')];
    expect(repositoriesToLookUp(environments, [repo('acme/api')], owners)).toEqual(expected);
  });
});

describe('configurationChoices', () => {
  it('names each configuration, shows its path, and marks the current one', () => {
    expect(
      configurationChoices(
        ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json', '.devcontainer/python/devcontainer.json'],
        '.devcontainer/python/devcontainer.json',
      ),
    ).toEqual([
      { configPath: '.devcontainer/devcontainer.json', label: 'default', description: '.devcontainer/devcontainer.json', current: false },
      {
        configPath: '.devcontainer/python/devcontainer.json',
        label: 'python',
        description: `.devcontainer/python/devcontainer.json · ${ControllerTexts.current}`,
        current: true,
      },
    ]);
  });
});

describe('branchChoices', () => {
  it('marks the current and the default branch', () => {
    expect(branchChoices(['main', 'dev', 'dev', ''], { current: 'dev', defaultBranch: 'main' })).toEqual([
      { branch: 'main', description: ControllerTexts.defaultBranch },
      { branch: 'dev', description: ControllerTexts.current },
    ]);
  });

  it('adds the current branch when GitHub does not list it', () => {
    expect(branchChoices(['main'], { current: 'local-only' }).map((choice) => choice.branch)).toEqual(['local-only', 'main']);
  });

  it('puts a typed name that is not listed first, if it can be a branch name', () => {
    expect(branchChoices(['main'], { typed: ' feature/x ' })[0]).toEqual({ branch: 'feature/x', description: ControllerTexts.typedBranch });
    expect(branchChoices(['main'], { typed: 'main' }).map((choice) => choice.branch)).toEqual(['main']);
    expect(branchChoices(['main'], { typed: '-rf' }).map((choice) => choice.branch)).toEqual(['main']);
  });

  it.each(['main', 'feature/x', 'release-1.2', 'fix_ü'])('accepts the branch name %s', (name) => {
    expect(isPlausibleBranchName(name)).toBe(true);
  });

  it.each(['', '-b', '--orphan', 'a b', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'x.lock', 'a/', '/a', 'a.', 'a//b', 'a@{1}', '@', 'tab\tname'])(
    'rejects the branch name %j',
    (name) => {
      expect(isPlausibleBranchName(name)).toBe(false);
    },
  );
});

describe('sidebar data', () => {
  it('marks every environment as stopped with its volume when Docker does not run', () => {
    expect(dockerStoppedRuntime([environment('e1', 'a/b'), environment('e2', 'c/d')])).toEqual(
      new Map([
        ['e1', { container: 'stopped', volume: true }],
        ['e2', { container: 'stopped', volume: true }],
      ]),
    );
  });

  it('keeps only live busy marks', () => {
    const since = iso(NOW - 60_000);
    const environments = [
      environment('live', 'a/live', { busy: { operation: 'update', since, pid: 1, windowId: 'w1' } }),
      environment('dead', 'a/dead', { busy: { operation: 'update', since, pid: 2, windowId: 'w2' } }),
      environment('old', 'a/old', { busy: { operation: 'update', since: iso(NOW - 7 * 3_600_000), pid: 1, windowId: 'w1' } }),
      environment('other', 'a/other', { busy: { operation: 'update', since, pid: 1, windowId: 'w-gone' } }),
      environment('idle', 'a/idle'),
    ];
    const windowStatuses = [{ windowId: 'w1', pid: 1, environmentId: null, state: 'active' as const, updatedAt: iso(NOW) }];
    expect(liveBusyEnvironmentIds(environments, { now: NOW, isAlive: (pid) => pid === 1 })).toEqual(new Set(['live', 'other']));
    expect(liveBusyEnvironmentIds(environments, { now: NOW, isAlive: (pid) => pid === 1, windowStatuses })).toEqual(new Set(['live']));
  });

  it('collects the environments of windows', () => {
    const status = (windowId: string, environmentId: string | null) => ({
      windowId,
      pid: 1,
      environmentId,
      state: 'active' as const,
      updatedAt: iso(NOW),
    });
    expect(environmentIdsOf([status('w1', 'e1'), status('w2', null), status('w3', 'e1'), status('w4', 'e2')])).toEqual(
      new Set(['e1', 'e2']),
    );
  });
});
