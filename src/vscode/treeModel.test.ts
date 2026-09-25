// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { DiscoveryData, Environment, EnvironmentState, GitSummary, RepositoryInfo } from '../core/types';
import {
  buildTreeModel,
  contextValue,
  environmentState,
  findRowByEnvironmentId,
  findRowByRepository,
  recentEnvironments,
  repositoriesForPicker,
  repositoryRows,
  rootNodes,
  rowActions,
  stateIcon,
  stateText,
  TreeTexts,
  type EnvironmentRuntime,
  type HintRow,
  type OwnerGroup,
  type RepositoryRow,
  type TreeInput,
} from './treeModel';

const T0 = Date.parse('2026-09-24T17:00:00.000Z');
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
    pushedAt: iso(T0),
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
    ...overrides,
  };
}

function summary(overrides: Partial<GitSummary> = {}): GitSummary {
  return { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(T0), ...overrides };
}

function environment(id: string, repository: string, overrides: Partial<Environment> = {}): Environment {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devenv-${id}`,
    containerName: `devenv-${id}`,
    createdAt: iso(T0 - 3_600_000),
    lastUsedAt: iso(T0),
    gitSummary: summary(),
    ...overrides,
  };
}

function discovery(repositories: RepositoryInfo[], overrides: Partial<DiscoveryData> = {}): DiscoveryData {
  return {
    version: 1,
    fetchedAt: iso(T0),
    viewerLogin: 'me',
    organizations: ['acme-university'],
    repositories,
    hints: [],
    ...overrides,
  };
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

function runtime(entries: Record<string, EnvironmentRuntime>): Map<string, EnvironmentRuntime> {
  return new Map(Object.entries(entries));
}

function rows(groups: OwnerGroup[]): RepositoryRow[] {
  return repositoryRows(groups);
}

function row(groups: OwnerGroup[], repository: string): RepositoryRow {
  const found = findRowByRepository(groups, repository);
  if (!found) throw new Error(`No row for ${repository}`);
  return found;
}

function flags(value: string): string[] {
  return value.split(';');
}

describe('environmentState', () => {
  const env = environment('e1', 'acme-university/api');
  const state = (overrides: Partial<TreeInput>): EnvironmentState => environmentState(env, input(overrides));

  it('is updating while a live busy mark exists, before every other state', () => {
    expect(
      state({
        busyEnvironmentIds: new Set(['e1']),
        currentEnvironmentId: 'e1',
        runtime: runtime({ e1: { container: 'missing', volume: false } }),
      }),
    ).toBe('updating');
  });

  it('is files missing when Docker reports no volume, also for the connected environment', () => {
    expect(state({ runtime: runtime({ e1: { container: 'running', volume: false } }), currentEnvironmentId: 'e1' })).toBe(
      'filesMissing',
    );
  });

  it('is connected for this window and connected · other window for another window', () => {
    expect(state({ currentEnvironmentId: 'e1', otherWindowEnvironmentIds: new Set(['e1']) })).toBe('connected');
    expect(state({ otherWindowEnvironmentIds: new Set(['e1']) })).toBe('connectedOtherWindow');
    expect(state({ currentEnvironmentId: 'e1', runtime: runtime({ e1: { container: 'running', volume: true } }) })).toBe(
      'connected',
    );
  });

  it('shows the container state when a referenced container does not run (connection lost)', () => {
    expect(state({ currentEnvironmentId: 'e1', runtime: runtime({ e1: { container: 'stopped', volume: true } }) })).toBe(
      'stopped',
    );
    expect(
      state({ otherWindowEnvironmentIds: new Set(['e1']), runtime: runtime({ e1: { container: 'missing', volume: true } }) }),
    ).toBe('noContainer');
  });

  it('maps the container state', () => {
    expect(state({ runtime: runtime({ e1: { container: 'running', volume: true } }) })).toBe('running');
    expect(state({ runtime: runtime({ e1: { container: 'stopped', volume: true } }) })).toBe('stopped');
    expect(state({ runtime: runtime({ e1: { container: 'missing', volume: true } }) })).toBe('noContainer');
  });

  it('is stopped without runtime data, or when the runtime data lacks the environment', () => {
    expect(state({ runtime: undefined })).toBe('stopped');
    expect(state({ runtime: runtime({ other: { container: 'running', volume: true } }) })).toBe('stopped');
  });

  it('ignores busy marks and windows of other environments', () => {
    expect(
      state({
        busyEnvironmentIds: new Set(['e2']),
        currentEnvironmentId: 'e2',
        otherWindowEnvironmentIds: new Set(['e3']),
        runtime: runtime({ e1: { container: 'running', volume: true } }),
      }),
    ).toBe('running');
  });
});

describe('row actions and contextValue', () => {
  const info = repo('acme-university/api');
  const multi = repo('acme-university/api', {
    configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'],
  });

  it.each<[EnvironmentState | undefined, string]>([
    [undefined, 'repository;canStart;onGitHub'],
    ['connected', 'repository;canStop;canDelete;canRebuild;onGitHub'],
    ['connectedOtherWindow', 'repository;canStart;canStop;canDelete;canRebuild;onGitHub'],
    ['running', 'repository;canStart;canStop;canDelete;canRebuild;onGitHub'],
    ['stopped', 'repository;canStart;canDelete;canRebuild;onGitHub'],
    ['noContainer', 'repository;canStart;canDelete;canRebuild;onGitHub'],
    ['filesMissing', 'repository;canStart;canDelete;canRebuild;onGitHub'],
    ['updating', 'repository;canDelete;onGitHub'],
  ])('state %s → %s', (state, expected) => {
    expect(contextValue(rowActions(state, info))).toBe(expected);
  });

  it('offers Delete while the environment is updating, except while it is being deleted (concept 7.15)', () => {
    for (const operation of ['create', 'update', 'rebuild', 'switchBranch'] as const) {
      expect(contextValue(rowActions('updating', info, operation))).toBe('repository;canDelete;onGitHub');
    }
    expect(contextValue(rowActions('updating', info, 'delete'))).toBe('repository;onGitHub');
    // The operation of a mark matters only while the state is updating.
    expect(flags(contextValue(rowActions('stopped', info, 'delete')))).toContain('canDelete');
  });

  it('takes the operation of the busy mark of the environment for the row', () => {
    const mark = (operation: 'rebuild' | 'delete') =>
      environment('e1', 'acme/api', { busy: { operation, since: iso(T0), pid: 4242, windowId: 'window-2' } });
    const rowFor = (env: Environment) =>
      row(buildTreeModel(input({ environments: [env], busyEnvironmentIds: new Set(['e1']) })), 'acme/api');
    expect(rowFor(mark('rebuild')).actions.canDelete).toBe(true);
    expect(rowFor(mark('delete')).actions.canDelete).toBe(false);
    expect(rowFor(mark('rebuild')).actions.canStart).toBe(false);
  });

  it('adds multiConfig only for more than one configuration, and onGitHub only with discovery data', () => {
    expect(flags(contextValue(rowActions('stopped', multi)))).toContain('multiConfig');
    expect(flags(contextValue(rowActions('stopped', info)))).not.toContain('multiConfig');
    expect(flags(contextValue(rowActions('stopped', undefined)))).not.toContain('onGitHub');
    expect(flags(contextValue(rowActions('stopped', undefined)))).not.toContain('multiConfig');
  });

  it('matches the when clauses of package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { menus: Record<string, Array<{ command?: string; submenu?: string; when?: string }>> };
    };
    const menus = manifest.contributes.menus;
    const whenOf = (menu: string, command: string) =>
      menus[menu].filter((item) => item.command === command).map((item) => item.when ?? '');
    const matches = (when: string, value: string) => {
      const regex = /viewItem =~ \/(.+?)\//.exec(when);
      return regex ? new RegExp(regex[1]).test(value) : true;
    };
    const cases: Array<[string, keyof ReturnType<typeof rowActions>]> = [
      ['devEnvironments.start', 'canStart'],
      ['devEnvironments.stop', 'canStop'],
      ['devEnvironments.delete', 'canDelete'],
      ['devEnvironments.rebuild', 'canRebuild'],
      ['devEnvironments.selectConfiguration', 'multiConfig'],
      ['devEnvironments.showOnGitHub', 'onGitHub'],
    ];
    const states: Array<EnvironmentState | undefined> = [
      undefined,
      'connected',
      'connectedOtherWindow',
      'running',
      'stopped',
      'noContainer',
      'filesMissing',
      'updating',
    ];
    for (const state of states) {
      for (const information of [info, multi, undefined]) {
        const actions = rowActions(state, information);
        const value = contextValue(actions);
        for (const [command, flag] of cases) {
          const clauses = [...whenOf('view/item/context', command), ...whenOf('devEnvironments.more', command)];
          expect(clauses.length).toBeGreaterThan(0);
          for (const when of clauses) {
            expect(matches(when, value), `${command} for ${state ?? 'no environment'}: ${value}`).toBe(actions[flag]);
          }
        }
        // The ⋯ submenu and Switch branch… appear on every repository row.
        const submenu = menus['view/item/context'].find((item) => item.submenu === 'devEnvironments.more');
        expect(matches(submenu?.when ?? '', value)).toBe(true);
        for (const when of whenOf('view/item/context', 'devEnvironments.switchBranch')) {
          expect(matches(when, value)).toBe(true);
        }
      }
    }
  });
});

describe('buildTreeModel', () => {
  it('shows the mockup of concept 6.2', () => {
    const multi = ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'];
    const groups = buildTreeModel(
      input({
        discovery: discovery([
          repo('acme-university/api', { configPaths: multi }),
          repo('acme-university/docs'),
          repo('acme-university/web'),
          repo('acme-university/infra'),
          repo('me/dotfiles'),
          repo('me/website'),
        ]),
        environments: [
          environment('e-api', 'acme-university/api', { configPath: '.devcontainer/python/devcontainer.json' }),
          environment('e-docs', 'acme-university/docs'),
          environment('e-web', 'acme-university/web', {
            gitSummary: summary({ branch: 'feature-x', unpushedCommits: 3 }),
          }),
          environment('e-dot', 'me/dotfiles'),
        ],
        runtime: runtime({
          'e-api': { container: 'running', volume: true },
          'e-docs': { container: 'running', volume: true },
          'e-web': { container: 'stopped', volume: true },
          'e-dot': { container: 'stopped', volume: true },
        }),
        currentEnvironmentId: 'e-api',
        liveBranches: new Map([
          ['e-api', 'main'],
          ['e-docs', 'main'],
        ]),
      }),
    );

    expect(groups.map((group) => group.owner)).toEqual(['acme-university', 'me']);
    const view = groups.map((group) => ({
      owner: group.owner,
      rows: rows([group]).map((entry) => [entry.label, entry.state, entry.description, entry.contextValue]),
    }));
    expect(view).toEqual([
      {
        owner: 'acme-university',
        rows: [
          ['api', 'connected', 'main (python)   Connected', 'repository;canStop;canDelete;canRebuild;multiConfig;onGitHub'],
          ['docs', 'running', 'main   Running', 'repository;canStart;canStop;canDelete;canRebuild;onGitHub'],
          ['web', 'stopped', 'feature-x   Stopped · 3 unpushed', 'repository;canStart;canDelete;canRebuild;onGitHub'],
          ['infra', undefined, '', 'repository;canStart;onGitHub'],
        ],
      },
      {
        owner: 'me',
        rows: [
          ['dotfiles', 'stopped', 'main   Stopped', 'repository;canStart;canDelete;canRebuild;onGitHub'],
          ['website', undefined, '', 'repository;canStart;onGitHub'],
        ],
      },
    ]);
  });

  it('uses stable IDs and fills the row fields', () => {
    const info = repo('Acme/API');
    const env = environment('e1', 'Acme/API');
    const groups = buildTreeModel(input({ discovery: discovery([info]), environments: [env] }));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'owner', id: 'owner:acme', owner: 'Acme' });
    const entry = row(groups, 'acme/api');
    expect(entry).toMatchObject({
      kind: 'repository',
      id: 'repo:acme/api',
      repository: 'Acme/API',
      owner: 'Acme',
      name: 'API',
      label: 'API',
      info,
      environment: env,
      state: 'stopped',
      branch: 'main',
      notOnGitHub: false,
    });
  });

  it('sorts groups by owner and rows alphabetically, environments first, case-insensitive and natural', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([
          repo('zeta/one'),
          repo('Alpha/zulu'),
          repo('alpha-2/x'),
          repo('Alpha/beta'),
          repo('Alpha/repo10'),
          repo('Alpha/repo2'),
          repo('Alpha/Charlie'),
          repo('Alpha/yankee'),
        ]),
        environments: [environment('e1', 'Alpha/yankee'), environment('e2', 'Alpha/Charlie')],
      }),
    );
    expect(groups.map((group) => group.owner)).toEqual(['Alpha', 'alpha-2', 'zeta']);
    expect(rows([groups[0]]).map((entry) => entry.name)).toEqual(['Charlie', 'yankee', 'beta', 'repo2', 'repo10', 'zulu']);
  });

  it('lists an environment whose repository GitHub does not list, with "not on GitHub"', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api')]),
        environments: [
          environment('e1', 'acme/old', { gitSummary: summary({ branch: 'dev', uncommittedFiles: 2 }) }),
          environment('e2', 'lost/repo'),
        ],
      }),
    );
    const old = row(groups, 'acme/old');
    expect(old.notOnGitHub).toBe(true);
    expect(old.description).toBe('dev   Stopped · 2 uncommitted · not on GitHub');
    expect(old.contextValue).toBe('repository;canStart;canDelete;canRebuild');
    expect(old.tooltip).toContain(TreeTexts.notListedOnGitHub);
    expect(row(groups, 'lost/repo').description).toBe('main   Stopped · not on GitHub');
    expect(groups.map((group) => group.owner)).toEqual(['acme', 'lost']);
  });

  describe('with single repository lookups (repositories without a configuration on the default branch)', () => {
    it('uses a found repository: no "not on GitHub", Show on GitHub, and its configurations', () => {
      const found = repo('acme/old', { configPaths: [], defaultBranch: 'trunk', url: 'https://github.com/Acme/old' });
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('acme/api')]),
          environments: [environment('e1', 'acme/old')],
          repositoryLookups: new Map([['acme/old', found]]),
        }),
      );
      const entry = row(groups, 'acme/old');
      expect(entry.notOnGitHub).toBe(false);
      expect(entry.info).toBe(found);
      expect(entry.description).toBe('main   Stopped');
      expect(flags(entry.contextValue)).toContain('onGitHub');
      expect(flags(entry.contextValue)).not.toContain('multiConfig');
    });

    it('shows "not on GitHub" only for a repository that the lookup did not find', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('acme/api')]),
          environments: [environment('e1', 'acme/gone'), environment('e2', 'acme/unknown')],
          repositoryLookups: new Map([['acme/gone', null]]),
        }),
      );
      expect(row(groups, 'acme/gone').notOnGitHub).toBe(true);
      expect(row(groups, 'acme/gone').description).toBe('main   Stopped · not on GitHub');
      // Not looked up yet, or the lookup failed: unknown, so no claim.
      expect(row(groups, 'acme/unknown').notOnGitHub).toBe(false);
      expect(row(groups, 'acme/unknown').description).toBe('main   Stopped');
      expect(flags(row(groups, 'acme/unknown').contextValue)).not.toContain('onGitHub');
    });

    it('prefers the discovery over a lookup and adds no rows for looked-up repositories without environment', () => {
      const listed = repo('acme/api', { configPaths: ['.devcontainer/a/devcontainer.json', '.devcontainer/b/devcontainer.json'] });
      const groups = buildTreeModel(
        input({
          discovery: discovery([listed]),
          environments: [environment('e1', 'acme/api')],
          repositoryLookups: new Map([
            ['acme/api', repo('acme/api')],
            ['acme/extra', repo('acme/extra')],
          ]),
        }),
      );
      expect(row(groups, 'acme/api').info).toBe(listed);
      expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/api']);
    });
  });

  describe('rootNodes', () => {
    it('adds the sign-in row first when not signed in and the view is not empty', () => {
      const groups = buildTreeModel(input({ signedIn: false, environments: [environment('e1', 'acme/api')] }));
      const nodes = rootNodes(groups, false);
      expect(nodes[0]).toEqual({ kind: 'signIn', id: 'signIn', label: TreeTexts.signIn, tooltip: TreeTexts.signInTooltip });
      expect(nodes.slice(1)).toEqual(groups);
    });

    it('adds no sign-in row when signed in or when the view is empty', () => {
      const groups = buildTreeModel(input({ environments: [environment('e1', 'acme/api')] }));
      expect(rootNodes(groups, true)).toEqual(groups);
      expect(rootNodes([], false)).toEqual([]);
    });
  });

  it('shows only the environments when the user is not signed in, without "not on GitHub"', () => {
    const groups = buildTreeModel(
      input({
        signedIn: false,
        discovery: discovery([repo('acme/api'), repo('acme/web')], {
          hints: [{ organization: 'acme', kind: 'saml', url: 'https://github.com/orgs/acme/sso' }],
        }),
        environments: [environment('e1', 'acme/api'), environment('e2', 'gone/repo')],
      }),
    );
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/api', 'gone/repo']);
    expect(groups.flatMap((group) => group.children).some((child) => child.kind === 'hint')).toBe(false);
    expect(row(groups, 'gone/repo').notOnGitHub).toBe(false);
    expect(row(groups, 'gone/repo').description).toBe('main   Stopped');
    // The stored list still knows the repository, so Show on GitHub works.
    expect(flags(row(groups, 'acme/api').contextValue)).toContain('onGitHub');
  });

  it('shows the environments without "not on GitHub" while no repository list is loaded', () => {
    const groups = buildTreeModel(input({ discovery: undefined, environments: [environment('e1', 'acme/api')] }));
    expect(rows(groups).map((entry) => [entry.repository, entry.description, entry.contextValue])).toEqual([
      ['acme/api', 'main   Stopped', 'repository;canStart;canDelete;canRebuild'],
    ]);
  });

  it('returns no groups without environments and without a repository list', () => {
    expect(buildTreeModel(input())).toEqual([]);
    expect(buildTreeModel(input({ discovery: discovery([]) }))).toEqual([]);
  });

  it('applies the settings filters to repositories without environment only', () => {
    const groups = buildTreeModel(
      input({
        settings: { owners: [' ACME '], includeArchived: false, includeForks: false },
        discovery: discovery([
          repo('acme/api'),
          repo('acme/archived', { isArchived: true }),
          repo('acme/fork', { isFork: true }),
          repo('other/lib'),
          repo('other/tool'),
          repo('acme/archived-env', { isArchived: true }),
        ]),
        environments: [environment('e1', 'other/tool'), environment('e2', 'acme/archived-env')],
      }),
    );
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/archived-env', 'acme/api', 'other/tool']);
    expect(row(groups, 'other/tool').notOnGitHub).toBe(false);
    expect(row(groups, 'acme/archived-env').tooltip).toContain(TreeTexts.archived);
  });

  it('shows archived repositories and forks when the settings include them', () => {
    const groups = buildTreeModel(
      input({
        settings: { owners: [], includeArchived: true, includeForks: true },
        discovery: discovery([repo('acme/archived', { isArchived: true }), repo('acme/fork', { isFork: true })]),
      }),
    );
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/archived', 'acme/fork']);
  });

  it('matches environments to discovered repositories case-insensitively and uses the GitHub case', () => {
    const groups = buildTreeModel(
      input({ discovery: discovery([repo('Acme-University/API')]), environments: [environment('e1', 'acme-university/api')] }),
    );
    expect(rows(groups)).toHaveLength(1);
    const entry = rows(groups)[0];
    expect(entry.repository).toBe('Acme-University/API');
    expect(entry.environment?.id).toBe('e1');
    expect(entry.notOnGitHub).toBe(false);
    expect(groups[0].owner).toBe('Acme-University');
  });

  it('puts organization hints into the group of their organization, first, and respects the owners filter', () => {
    const hints = [
      { organization: 'acme', kind: 'saml' as const, url: 'https://github.com/orgs/acme/sso' },
      { organization: 'ACME', kind: 'saml' as const, url: 'https://github.com/orgs/acme/sso' },
      { organization: 'secret-org', kind: 'oauthRestricted' as const, url: 'https://github.com/settings/connections/applications/x' },
    ];
    const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api')], { hints }) }));
    expect(groups.map((group) => group.owner)).toEqual(['acme', 'secret-org']);
    const acme = groups[0].children;
    expect(acme.map((child) => child.kind)).toEqual(['hint', 'repository']);
    const hint = acme[0] as HintRow;
    expect(hint).toEqual({
      kind: 'hint',
      id: 'hint:acme',
      organization: 'acme',
      label: 'Access to the organization acme is not authorized.',
      url: 'https://github.com/orgs/acme/sso',
    });
    expect(groups[1].children).toEqual([
      {
        kind: 'hint',
        id: 'hint:secret-org',
        organization: 'secret-org',
        label: 'Access to the organization secret-org is not authorized.',
        url: 'https://github.com/settings/connections/applications/x',
      },
    ]);

    const filtered = buildTreeModel(
      input({
        settings: { owners: ['acme'], includeArchived: false, includeForks: true },
        discovery: discovery([repo('acme/api')], { hints }),
      }),
    );
    expect(filtered.map((group) => group.owner)).toEqual(['acme']);
  });

  it('shows the configuration name only when the repository has more than one configuration', () => {
    const configs = ['.devcontainer/devcontainer.json', '.devcontainer.json', '.devcontainer/node/devcontainer.json'];
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/multi', { configPaths: configs }), repo('acme/single')]),
        environments: [
          environment('e1', 'acme/multi', { configPath: '.devcontainer/node/devcontainer.json' }),
          environment('e2', 'acme/single', { configPath: '.devcontainer/devcontainer.json' }),
          environment('e3', 'acme/root', { configPath: '.devcontainer.json' }),
        ],
      }),
    );
    expect(row(groups, 'acme/multi').description).toBe('main (node)   Stopped');
    expect(row(groups, 'acme/multi').configurationName).toBe('node');
    expect(row(groups, 'acme/multi').tooltip).toContain(TreeTexts.configuration('node'));
    expect(row(groups, 'acme/single').description).toBe('main   Stopped');
    expect(row(groups, 'acme/single').configurationName).toBeUndefined();

    const defaultConfig = buildTreeModel(
      input({
        discovery: discovery([repo('acme/multi', { configPaths: configs })]),
        environments: [environment('e1', 'acme/multi', { configPath: '.devcontainer.json' })],
      }),
    );
    expect(row(defaultConfig, 'acme/multi').description).toBe('main (default)   Stopped');
  });

  it('uses the live branch while the container runs, and the recorded branch otherwise', () => {
    const env = environment('e1', 'acme/api', { gitSummary: summary({ branch: 'recorded', unpushedCommits: 1 }) });
    const base = { discovery: discovery([repo('acme/api')]), environments: [env], liveBranches: new Map([['e1', 'live']]) };

    const running = buildTreeModel(input({ ...base, runtime: runtime({ e1: { container: 'running', volume: true } }) }));
    expect(row(running, 'acme/api').description).toBe('live   Running');
    const connected = buildTreeModel(input({ ...base, currentEnvironmentId: 'e1' }));
    expect(row(connected, 'acme/api').description).toBe('live   Connected');
    const other = buildTreeModel(input({ ...base, otherWindowEnvironmentIds: new Set(['e1']) }));
    expect(row(other, 'acme/api').description).toBe('live   Connected · other window');
    const stopped = buildTreeModel(input({ ...base, runtime: runtime({ e1: { container: 'stopped', volume: true } }) }));
    expect(row(stopped, 'acme/api').description).toBe('recorded   Stopped · 1 unpushed');

    const noLive = buildTreeModel(
      input({ ...base, liveBranches: new Map(), runtime: runtime({ e1: { container: 'running', volume: true } }) }),
    );
    expect(row(noLive, 'acme/api').description).toBe('recorded   Running');
  });

  it('shows no branch when none is known (detached HEAD or no summary)', () => {
    const groups = buildTreeModel(
      input({
        environments: [
          environment('e1', 'acme/detached', { gitSummary: summary({ branch: null }) }),
          environment('e2', 'acme/new', { gitSummary: undefined }),
        ],
      }),
    );
    expect(row(groups, 'acme/detached').description).toBe('Stopped');
    expect(row(groups, 'acme/detached').branch).toBeUndefined();
    expect(row(groups, 'acme/new').description).toBe('Stopped');
  });

  it('shows the change counts only while the container does not run and the files exist', () => {
    const env = environment('e1', 'acme/api', {
      gitSummary: summary({ uncommittedFiles: 2, unpushedCommits: 3, stashes: 1 }),
    });
    const description = (overrides: Partial<TreeInput>) =>
      row(buildTreeModel(input({ environments: [env], ...overrides })), 'acme/api').description;
    expect(description({ runtime: runtime({ e1: { container: 'stopped', volume: true } }) })).toBe(
      'main   Stopped · 2 uncommitted · 3 unpushed · 1 stashed',
    );
    expect(description({ runtime: runtime({ e1: { container: 'missing', volume: true } }) })).toBe(
      'main   No container · 2 uncommitted · 3 unpushed · 1 stashed',
    );
    expect(description({ runtime: runtime({ e1: { container: 'running', volume: true } }) })).toBe('main   Running');
    expect(description({ runtime: runtime({ e1: { container: 'missing', volume: false } }) })).toBe('main   Files missing');
    expect(description({ busyEnvironmentIds: new Set(['e1']) })).toBe('main   Updating');
  });

  it('writes the tooltip with the time of the last use', () => {
    const env = environment('e1', 'acme/api', {
      lastUsedAt: '2026-09-24T17:10:00.000Z',
      gitSummary: summary({ branch: 'main', unpushedCommits: 3 }),
    });
    const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api')]), environments: [env] }));
    expect(row(groups, 'acme/api').tooltip).toBe(
      ['acme/api', 'Stopped · 3 unpushed', 'Branch: main', 'Last used: T(2026-09-24T17:10:00.000Z)'].join('\n'),
    );
  });

  it('formats the time of the last use with the default formatter when none is given', () => {
    const groups = buildTreeModel({ ...input({ environments: [environment('e1', 'acme/api')] }), formatTime: undefined });
    expect(row(groups, 'acme/api').tooltip).toContain(`Last used: ${new Date(T0).toLocaleString()}`);
  });

  it('leaves out an unknown time of the last use', () => {
    const groups = buildTreeModel(
      input({ environments: [environment('e1', 'acme/api', { lastUsedAt: new Date(0).toISOString() })] }),
    );
    expect(row(groups, 'acme/api').tooltip).not.toContain('Last used');
  });

  it('describes a repository without environment in its tooltip', () => {
    const groups = buildTreeModel(input({ discovery: discovery([repo('acme/api', { defaultBranch: 'trunk' })]) }));
    const entry = row(groups, 'acme/api');
    expect(entry.state).toBeUndefined();
    expect(entry.environment).toBeUndefined();
    expect(entry.description).toBe('');
    expect(entry.tooltip).toBe(['acme/api', TreeTexts.noEnvironment, 'Default branch: trunk'].join('\n'));
  });

  it('offers no Start for a repository with an environment of another account (concept 7.5, D-3)', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([
          repo('majikmate/module-ts', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/b/devcontainer.json'] }),
          repo('acme/api'),
        ]),
        lockedRepositories: new Set(['majikmate/module-ts']),
      }),
    );
    const locked = row(groups, 'majikmate/module-ts');
    expect(locked.environment).toBeUndefined();
    expect(locked.actions).toEqual({
      canStart: false,
      canStop: false,
      canDelete: false,
      canRebuild: false,
      multiConfig: false,
      onGitHub: true,
    });
    expect(locked.contextValue).toBe('repository;onGitHub');
    expect(locked.description).toBe(TreeTexts.otherAccountEnvironment);
    expect(locked.tooltip).toBe(['majikmate/module-ts', TreeTexts.otherAccountEnvironmentTooltip, 'Default branch: main'].join('\n'));
    expect(row(groups, 'acme/api').contextValue).toBe('repository;canStart;onGitHub');
  });

  it('keeps tree item IDs unique if the registry holds two environments of one repository', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api')]),
        environments: [
          environment('older', 'acme/api', { lastUsedAt: iso(T0 - 1000) }),
          environment('newer', 'ACME/api', { lastUsedAt: iso(T0) }),
        ],
      }),
    );
    const ids = rows(groups).map((entry) => entry.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(findRowByEnvironmentId(groups, 'newer')?.id).toBe('repo:acme/api');
    expect(findRowByEnvironmentId(groups, 'older')?.id).toBe('repo:acme/api#older');
  });

  it('never repeats a tree item ID, also with duplicate discovery entries', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api'), repo('ACME/API'), repo('acme/web')], {
          hints: [{ organization: 'acme', kind: 'other', url: 'https://github.com/acme' }],
        }),
        environments: [environment('e1', 'acme/web')],
      }),
    );
    const ids = groups.flatMap((group) => [group.id, ...group.children.map((child) => child.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/web', 'acme/api']);
  });

  it('tolerates an invalid repository name in the registry', () => {
    const groups = buildTreeModel(input({ environments: [environment('e1', 'broken')] }));
    expect(rows(groups)).toHaveLength(1);
    expect(rows(groups)[0]).toMatchObject({ owner: 'broken', name: 'broken', id: 'repo:broken' });
  });

  it('finds rows by environment ID and by repository', () => {
    const groups = buildTreeModel(
      input({ discovery: discovery([repo('acme/api'), repo('acme/web')]), environments: [environment('e1', 'acme/api')] }),
    );
    expect(findRowByEnvironmentId(groups, 'e1')?.repository).toBe('acme/api');
    expect(findRowByEnvironmentId(groups, 'missing')).toBeUndefined();
    expect(findRowByRepository(groups, 'ACME/WEB')?.repository).toBe('acme/web');
    expect(findRowByRepository(groups, 'acme/none')).toBeUndefined();
  });
});

describe('state texts and icons', () => {
  it('uses the state texts of concept 6.2', () => {
    expect(stateText('connected')).toBe('Connected');
    expect(stateText('connectedOtherWindow')).toBe('Connected · other window');
    expect(stateText('running')).toBe('Running');
    expect(stateText('stopped')).toBe('Stopped');
    expect(stateText('updating')).toBe('Updating');
    expect(stateText('noContainer')).toBe('No container');
    expect(stateText('filesMissing')).toBe('Files missing');
  });

  it('maps every state to a codicon', () => {
    expect(stateIcon('connected')).toEqual({ id: 'circle-filled', color: 'charts.green' });
    expect(stateIcon('connectedOtherWindow')).toEqual({ id: 'circle-filled', color: 'charts.green' });
    expect(stateIcon('running').id).toBe('color-mode');
    expect(stateIcon('stopped').id).toBe('circle-outline');
    expect(stateIcon('updating').id).toBe('sync~spin');
    expect(stateIcon('noContainer').id).toBe('circle-large-outline');
    expect(stateIcon('filesMissing').id).toBe('warning');
  });
});

describe('switcher helpers', () => {
  it('lists the environments most recently used first, with the state and description of their row', () => {
    const environments = [
      environment('old', 'acme/web', { lastUsedAt: iso(T0 - 60_000) }),
      environment('new', 'acme/api', { lastUsedAt: iso(T0) }),
      environment('gone', 'lost/repo', { lastUsedAt: iso(T0 - 120_000) }),
    ];
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api'), repo('acme/web')]),
        environments,
        currentEnvironmentId: 'new',
        liveBranches: new Map([['new', 'dev']]),
      }),
    );
    expect(recentEnvironments(groups, environments)).toEqual([
      { environmentId: 'new', repository: 'acme/api', state: 'connected', description: 'dev   Connected' },
      { environmentId: 'old', repository: 'acme/web', state: 'stopped', description: 'main   Stopped' },
      { environmentId: 'gone', repository: 'lost/repo', state: 'stopped', description: 'main   Stopped · not on GitHub' },
    ]);
  });

  it('falls back to the registry entry when the model has no row', () => {
    const environments = [environment('e1', 'acme/api')];
    expect(recentEnvironments([], environments)).toEqual([
      { environmentId: 'e1', repository: 'acme/api', state: undefined, description: '' },
    ]);
    expect(recentEnvironments([], [])).toEqual([]);
  });

  it('orders the repositories of the picker by the last push, then by name', () => {
    const ordered = repositoriesForPicker([
      repo('acme/b', { pushedAt: iso(T0 - 1000) }),
      repo('acme/none', { pushedAt: null }),
      repo('acme/a', { pushedAt: iso(T0 - 1000) }),
      repo('acme/new', { pushedAt: iso(T0) }),
    ]);
    expect(ordered.map((entry) => entry.nameWithOwner)).toEqual(['acme/new', 'acme/a', 'acme/b', 'acme/none']);
  });
});
