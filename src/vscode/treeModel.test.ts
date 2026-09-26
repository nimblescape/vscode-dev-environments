// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Messages, StateTexts } from '../core/messages';
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
  type GroupNode,
  type HintRow,
  type OwnerGroup,
  type RepositoryRow,
  type TreeInput,
} from './treeModel';
import { parseRepositoryGroups } from './repositoryGroups';

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
    // Unit 10: every repository row has the flag of its host access checks (on by default: hostAccessChecked).
    expect(view).toEqual([
      {
        owner: 'acme-university',
        rows: [
          ['api', 'connected', 'main (python)   Connected', 'repository;canStop;canDelete;canRebuild;multiConfig;onGitHub;hostAccessChecked'],
          ['docs', 'running', 'main   Running', 'repository;canStart;canStop;canDelete;canRebuild;onGitHub;hostAccessChecked'],
          ['infra', undefined, '', 'repository;canStart;onGitHub;hostAccessChecked'],
          ['web', 'stopped', 'feature-x   Stopped · 3 unpushed', 'repository;canStart;canDelete;canRebuild;onGitHub;hostAccessChecked'],
        ],
      },
      {
        owner: 'me',
        rows: [
          ['dotfiles', 'stopped', 'main   Stopped', 'repository;canStart;canDelete;canRebuild;onGitHub;hostAccessChecked'],
          ['website', undefined, '', 'repository;canStart;onGitHub;hostAccessChecked'],
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

  // User decision 2026-09-26: a repository with an environment keeps its alphabetical place (it was listed first before).
  it('sorts groups by owner and rows alphabetically, with or without an environment, case-insensitive and natural', () => {
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
    expect(rows([groups[0]]).map((entry) => entry.name)).toEqual(['beta', 'Charlie', 'repo2', 'repo10', 'yankee', 'zulu']);
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
    // Unit 10: the flag of the host access checks (on by default).
    expect(old.contextValue).toBe('repository;canStart;canDelete;canRebuild;hostAccessChecked');
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

    it('adds the Docker row first, above the sign-in row, when no Docker CLI is found and the view is not empty', () => {
      const groups = buildTreeModel(input({ signedIn: false, environments: [environment('e1', 'acme/api')] }));
      const docker = { kind: 'installDocker', id: 'installDocker', label: TreeTexts.installDocker, tooltip: TreeTexts.installDockerTooltip };
      const signIn = { kind: 'signIn', id: 'signIn', label: TreeTexts.signIn, tooltip: TreeTexts.signInTooltip };
      expect(rootNodes(groups, false, true)).toEqual([docker, signIn, ...groups]);
      expect(rootNodes(groups, true, true)).toEqual([docker, ...groups]);
      expect(rootNodes(groups, true, false)).toEqual(groups);
      // The welcome view shows the Install Docker button in an empty view.
      expect(rootNodes([], false, true)).toEqual([]);
      expect(rootNodes([], true, true)).toEqual([]);
    });

    it('uses the title of the command and the text of the welcome view for the Docker row', () => {
      expect(TreeTexts.installDocker).toBe('Install Docker…');
      expect(TreeTexts.installDockerTooltip).toBe('Dev Environments runs your environments in Docker, which is not installed on this computer.');
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
    // Unit 10: the flag of the host access checks (on by default).
    expect(rows(groups).map((entry) => [entry.repository, entry.description, entry.contextValue])).toEqual([
      ['acme/api', 'main   Stopped', 'repository;canStart;canDelete;canRebuild;hostAccessChecked'],
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
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/api', 'acme/archived-env', 'other/tool']);
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
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['acme/api', 'acme/web']);
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

describe('hint of an owner of the scan scope that GitHub does not return', () => {
  it('names the owner with the not-found text and opens its page', () => {
    const hints = [{ organization: 'Nobody-Here', kind: 'notFound' as const, url: 'https://github.com/Nobody-Here' }];
    const groups = buildTreeModel(
      input({
        settings: { owners: ['nobody-here', 'acme'], includeArchived: false, includeForks: true },
        discovery: discovery([repo('acme/api')], { hints }),
      }),
    );
    const group = groups.find((candidate) => candidate.owner === 'Nobody-Here');
    expect(group?.children).toEqual([
      {
        kind: 'hint',
        id: 'hint:nobody-here',
        organization: 'Nobody-Here',
        notFound: true,
        label: 'The organization Nobody-Here was not found or is not accessible.',
        url: 'https://github.com/Nobody-Here',
      },
    ]);
  });
});

describe('the switch of the host access checks in the rows (concept section 9 "Host access", unit 10)', () => {
  const settings = (hostAccessChecksOff: string[]) => ({ owners: [], includeArchived: false, includeForks: true, hostAccessChecksOff });

  it('marks a repository whose checks are off, with a warning in the tooltip, and offers Turn On', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('acme/api'), repo('acme/web'), repo('acme/docs')]),
        environments: [environment('e1', 'acme/api', { gitSummary: summary({ uncommittedFiles: 2 }) })],
        runtime: new Map<string, EnvironmentRuntime>([['e1', { container: 'stopped', volume: true }]]),
        settings: settings([' ACME/API ', 'acme/web']),
      }),
    );
    const api = findRowByRepository(groups, 'acme/api');
    expect(api?.hostAccessChecks).toBe('off');
    expect(api?.description).toBe(`main   Stopped · 2 uncommitted · ${StateTexts.hostAccessUnrestricted}`);
    expect(api?.tooltip.split('\n')).toContain(Messages.hostAccessUnrestrictedTooltip);
    expect(api?.contextValue.split(';')).toContain('hostAccessUnrestricted');
    expect(api?.contextValue.split(';')).not.toContain('hostAccessChecked');
    // A repository without environment.
    const web = findRowByRepository(groups, 'acme/web');
    expect(web?.description).toBe(StateTexts.hostAccessUnrestricted);
    expect(web?.tooltip.split('\n')).toContain(Messages.hostAccessUnrestrictedTooltip);
    expect(web?.contextValue).toBe('repository;canStart;onGitHub;hostAccessUnrestricted');
    // The checks of other repositories stay on: no marker, and Turn Off.
    const docs = findRowByRepository(groups, 'acme/docs');
    expect(docs?.hostAccessChecks).toBe('on');
    expect(docs?.description).toBe('');
    expect(docs?.tooltip).not.toContain(Messages.hostAccessUnrestrictedTooltip);
    expect(docs?.contextValue).toBe('repository;canStart;onGitHub;hostAccessChecked');
  });

  it('adds no flag of the switch to contextValue without it', () => {
    const actions = rowActions('stopped', repo('acme/api'));
    expect(contextValue(actions)).toBe('repository;canStart;canDelete;canRebuild;onGitHub');
    expect(contextValue(actions, 'on')).toBe('repository;canStart;canDelete;canRebuild;onGitHub;hostAccessChecked');
    expect(contextValue(actions, 'off')).toBe('repository;canStart;canDelete;canRebuild;onGitHub;hostAccessUnrestricted');
    // The when clauses of package.json tell the two flags apart.
    expect(/hostAccessChecked/.test('hostAccessUnrestricted')).toBe(false);
    expect(/hostAccessUnrestricted/.test('hostAccessChecked')).toBe(false);
  });
});

describe('setting repositoryGroups (unit 9)', () => {
  const EXAMPLE = String.raw`^(\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$`;
  const patterns = (...entries: unknown[]) => parseRepositoryGroups(entries).patterns;

  type Shape = string | [string, Shape[]];
  /** The tree as labels: a row is its label, a node is [label, children]; hints are `hint:<organization>`. */
  function shape(children: ReadonlyArray<OwnerGroup['children'][number]>): Shape[] {
    return children.map((child) => {
      if (child.kind === 'group') return [child.label, shape(child.children)];
      if (child.kind === 'hint') return `hint:${child.organization}`;
      return child.label;
    });
  }
  function tree(groups: OwnerGroup[]): Shape[] {
    return groups.map((group) => [group.owner, shape(group.children)]);
  }
  function allNodes(groups: OwnerGroup[]): Array<{ id: string; kind: string }> {
    const nodes: Array<{ id: string; kind: string }> = [];
    const walk = (children: ReadonlyArray<OwnerGroup['children'][number]>) => {
      for (const child of children) {
        nodes.push(child);
        if (child.kind === 'group') walk(child.children);
      }
    };
    for (const group of groups) {
      nodes.push(group);
      walk(group.children);
    }
    return nodes;
  }
  function node(groups: OwnerGroup[], id: string): GroupNode {
    const found = allNodes(groups).find((candidate) => candidate.id === id);
    if (!found || found.kind !== 'group') throw new Error(`No group node ${id}`);
    return found as GroupNode;
  }

  const STUDENTS = [
    repo('school/2026-3cWI-SWP-module-oop-felix-he021'),
    repo('school/2025-3bWI-SWP-module-oop-hailo'),
    repo('school/2026-3cWI-SWP-module-oop-EnesHA81'),
  ];

  it('shows the example of the user: the first group is the top level under the owner, the last group labels the row', () => {
    const groups = buildTreeModel(input({ discovery: discovery(STUDENTS), repositoryGroups: patterns(EXAMPLE) }));
    expect(tree(groups)).toEqual([
      [
        'school',
        [
          ['2025-3bWI-SWP', [['module-oop', ['hailo']]]],
          ['2026-3cWI-SWP', [['module-oop', ['EnesHA81', 'felix-he021']]]],
        ],
      ],
    ]);
    expect(row(groups, 'school/2026-3cWI-SWP-module-oop-EnesHA81').label).toBe('EnesHA81');
    expect(node(groups, 'group:school:-:2026-3cWI-SWP')).toMatchObject({ level: 1, owner: 'school', expanded: false });
    expect(node(groups, 'group:school:-:2026-3cWI-SWP/module-oop')).toMatchObject({ level: 2, label: 'module-oop' });
  });

  it('gives an entry with a name its own root node, expanded, with the pattern as tooltip', () => {
    const groups = buildTreeModel(
      input({ discovery: discovery(STUDENTS), repositoryGroups: patterns({ name: 'Courses', pattern: EXAMPLE }) }),
    );
    expect(tree(groups)).toEqual([
      [
        'school',
        [
          [
            'Courses',
            [
              ['2025-3bWI-SWP', [['module-oop', ['hailo']]]],
              ['2026-3cWI-SWP', [['module-oop', ['EnesHA81', 'felix-he021']]]],
            ],
          ],
        ],
      ],
    ]);
    expect(node(groups, 'group:school:0:')).toMatchObject({ level: 0, label: 'Courses', tooltip: EXAMPLE, expanded: true });
    expect(node(groups, 'group:school:0:2025-3bWI-SWP/module-oop').children).toHaveLength(1);
  });

  it('keeps the row fields except the label, with owner/name in the tooltip', () => {
    const plain = buildTreeModel(input({ discovery: discovery(STUDENTS), environments: [environment('e1', STUDENTS[0].nameWithOwner)] }));
    const grouped = buildTreeModel(
      input({
        discovery: discovery(STUDENTS),
        environments: [environment('e1', STUDENTS[0].nameWithOwner)],
        repositoryGroups: patterns(EXAMPLE),
      }),
    );
    for (const before of rows(plain)) {
      const after = row(grouped, before.repository);
      expect({ ...after, label: before.label }).toEqual(before);
      expect(after.tooltip.split('\n')[0]).toBe(before.repository);
    }
    expect(row(grouped, STUDENTS[0].nameWithOwner)).toMatchObject({
      id: 'repo:school/2026-3cwi-swp-module-oop-felix-he021',
      label: 'felix-he021',
      state: 'stopped',
    });
  });

  it('merges equal label paths of unnamed patterns into one node; a repository goes under the first matching pattern', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('o/web-shop'), repo('o/web-blog'), repo('o/api-core'), repo('o/lib-x')]),
        repositoryGroups: patterns('^(web)-(shop)$', '^(web|api)-(.+)$', { name: 'Libraries', pattern: '^lib-(.+)$' }, '^(web)-(.+)$'),
      }),
    );
    expect(tree(groups)).toEqual([['o', [['Libraries', ['x']], ['api', ['core']], ['web', ['blog', 'shop']]]]]);
    expect(allNodes(groups).filter((entry) => entry.id === 'group:o:-:web')).toHaveLength(1);
  });

  it('does not merge a named root with the nodes of other patterns', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('o/web-shop'), repo('o/web-blog')]),
        repositoryGroups: patterns({ name: 'Shop', pattern: '^(web)-(shop)$' }, '^(web)-(.+)$'),
      }),
    );
    expect(tree(groups)).toEqual([['o', [['Shop', [['web', ['shop']]]], ['web', ['blog']]]]]);
    expect(node(groups, 'group:o:0:web').label).toBe('web');
    expect(node(groups, 'group:o:-:web').label).toBe('web');
  });

  it('filters: hides repositories without environment that match no pattern in an owner with a match', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('a/web-shop'), repo('a/other'), repo('b/other')]),
        repositoryGroups: patterns('^(web)-(.+)$'),
      }),
    );
    // b has no match: its list is the plain list of today.
    expect(tree(groups)).toEqual([
      ['a', [['web', ['shop']]]],
      ['b', ['other']],
    ]);
  });

  describe('patterns apply per owner group', () => {
    const hint = (organization: string) => ({ organization, kind: 'saml' as const, url: `https://github.com/orgs/${organization}/sso` });

    it('groups an organization with a match and hides its repositories that match no pattern', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('a/web-x'), repo('a/other'), repo('a/more')], { hints: [hint('a')] }),
          repositoryGroups: patterns('^(web)-(.+)$'),
        }),
      );
      expect(tree(groups)).toEqual([['a', ['hint:a', ['web', ['x']]]]]);
    });

    it('keeps the plain list of today, with its hints, for an organization without any match', () => {
      const repositories = [repo('b/zeta'), repo('b/Alpha'), repo('b/other')];
      const environments = [environment('e1', 'b/zeta'), environment('e2', 'b/gone')];
      const today = buildTreeModel(input({ discovery: discovery(repositories, { hints: [hint('b')] }), environments }));
      const grouped = buildTreeModel(
        input({ discovery: discovery(repositories, { hints: [hint('b')] }), environments, repositoryGroups: patterns('^web-') }),
      );
      expect(grouped).toEqual(today);
      expect(tree(grouped)).toEqual([['b', ['hint:b', 'Alpha', 'gone', 'other', 'zeta']]]);
    });

    it('never hides an organization because of the patterns, also one with only a hint', () => {
      const data = discovery([repo('a/web-x')], { hints: [hint('c')] });
      const groups = buildTreeModel(input({ discovery: data, repositoryGroups: patterns('^(web)-(.+)$') }));
      expect(tree(groups)).toEqual([
        ['a', [['web', ['x']]]],
        ['c', ['hint:c']],
      ]);
    });

    it('treats each organization on its own in a setting with several patterns', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([
            repo('a/web-shop'),
            repo('a/lib-core'),
            repo('a/misc'),
            repo('b/lib-util'),
            repo('b/tools'),
            repo('c/misc'),
            repo('c/tools'),
          ]),
          environments: [environment('e1', 'a/misc'), environment('e2', 'c/tools')],
          repositoryGroups: patterns('^(web)-(.+)$', { name: 'Libraries', pattern: '^lib-(.+)$' }),
        }),
      );
      expect(tree(groups)).toEqual([
        ['a', [['Libraries', ['core']], ['web', ['shop']], 'misc']],
        ['b', [['Libraries', ['util']]]],
        ['c', ['misc', 'tools']],
      ]);
      expect(row(groups, 'a/misc').environment?.id).toBe('e1');
      expect(findRowByRepository(groups, 'b/tools')).toBeUndefined();
    });

    it('groups an organization whose only match is a repository with an environment', () => {
      const groups = buildTreeModel(
        input({
          discovery: discovery([repo('a/other')]),
          environments: [environment('e1', 'a/web-x')],
          repositoryGroups: patterns('^(web)-(.+)$'),
        }),
      );
      expect(tree(groups)).toEqual([['a', [['web', ['x']]]]]);
    });
  });

  it('lists repositories with an environment that match no pattern directly under the owner, after the nodes', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('a/web-shop'), repo('a/zeta'), repo('a/Beta'), repo('a/other')]),
        environments: [environment('e1', 'a/zeta'), environment('e2', 'a/Beta'), environment('e3', 'a/gone')],
        repositoryGroups: patterns({ name: 'Named', pattern: '^web-shop$' }, '^(web)-(.+)$'),
      }),
    );
    expect(tree(groups)).toEqual([['a', [['Named', ['web-shop']], 'Beta', 'gone', 'zeta']]]);
    expect(row(groups, 'a/gone').notOnGitHub).toBe(true);
  });

  it('puts hints first, then the named roots in the order of the setting, then the nodes, then the rows', () => {
    const hints = [{ organization: 'a', kind: 'saml' as const, url: 'https://github.com/orgs/a/sso' }];
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('a/z-1'), repo('a/y-1'), repo('a/b-1'), repo('a/a-1'), repo('a/solo'), repo('a/keep')], { hints }),
        environments: [environment('e1', 'a/keep')],
        repositoryGroups: patterns({ name: 'Zulu', pattern: '^z-' }, { name: 'Alpha', pattern: '^y-' }, '^(\\w)-(\\d)$', '^solo$'),
      }),
    );
    expect(tree(groups)).toEqual([
      ['a', ['hint:a', ['Zulu', ['z-1']], ['Alpha', ['y-1']], ['a', ['1']], ['b', ['1']], 'keep', 'solo']],
    ]);
  });

  it('shows a named root only in the owner groups where a repository matches it', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('a/lib-x'), repo('b/web-y')]),
        repositoryGroups: patterns({ name: 'Libraries', pattern: '^lib-(.+)$' }, { name: 'Web', pattern: '^web-(.+)$' }),
      }),
    );
    expect(tree(groups)).toEqual([
      ['a', [['Libraries', ['x']]]],
      ['b', [['Web', ['y']]]],
    ]);
    expect(node(groups, 'group:a:0:').id).not.toBe(node(groups, 'group:b:1:').id);
  });

  it('sorts at each level: nodes first in natural, case-insensitive order, then rows by label and repository', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([
          repo('o/c10-b'),
          repo('o/zz'),
          repo('o/c2-b'),
          repo('o/C1-a'),
          repo('o/c2-A'),
          repo('o/c2'),
          repo('o/aa'),
          repo('p/c2-a'),
        ]),
        repositoryGroups: patterns({ pattern: '^(c\\d+)(?:-(\\w))?$', flags: 'i' }, '^(?:aa|zz)$'),
      }),
    );
    // o/c2: the last group did not take part, so the row keeps its name under the node of its first group.
    expect(tree(groups)).toEqual([
      ['o', [['C1', ['a']], ['c2', ['A', 'b', 'c2']], ['c10', ['b']], 'aa', 'zz']],
      ['p', [['c2', ['a']]]],
    ]);
  });

  it('breaks ties between rows with the same label by the repository name', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('o/y-x-same'), repo('o/a-x-same')]),
        repositoryGroups: patterns('^\\w-(x)-(same)$'),
      }),
    );
    expect(rows(groups).map((entry) => entry.repository)).toEqual(['o/a-x-same', 'o/y-x-same']);
  });

  it('skips a level that did not take part or is empty (the row moves up one level)', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('o/2026-x-a'), repo('o/x-b')]),
        repositoryGroups: patterns('^(?:(\\d{4})-)?(\\w+)-(\\w+)$'),
      }),
    );
    expect(tree(groups)).toEqual([['o', [['2026', [['x', ['a']]]], ['x', ['b']]]]]);
  });

  it('uses unique, stable IDs with URI-encoded level values', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery([repo('Org/a b-x'), repo('Org/a%b-y'), repo('org2/a b-x')]),
        repositoryGroups: patterns('^(.+)-(.+)$'),
      }),
    );
    const ids = allNodes(groups).map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining(['owner:org', 'group:org:-:a%20b', 'group:org:-:a%25b', 'group:org2:-:a%20b', 'repo:org/a b-x']),
    );
    // The same input gives the same IDs.
    const again = buildTreeModel(
      input({
        discovery: discovery([repo('Org/a b-x'), repo('Org/a%b-y'), repo('org2/a b-x')]),
        repositoryGroups: patterns('^(.+)-(.+)$'),
      }),
    );
    expect(allNodes(again).map((entry) => entry.id)).toEqual(ids);
  });

  it('expands the nodes that hold the row of the environment of this window, and collapses the others', () => {
    const groups = buildTreeModel(
      input({
        discovery: discovery(STUDENTS),
        environments: [environment('e1', STUDENTS[1].nameWithOwner), environment('e2', STUDENTS[0].nameWithOwner)],
        currentEnvironmentId: 'e1',
        repositoryGroups: patterns({ name: 'Courses', pattern: EXAMPLE }),
      }),
    );
    expect(node(groups, 'group:school:0:').expanded).toBe(true);
    expect(node(groups, 'group:school:0:2025-3bWI-SWP').expanded).toBe(true);
    expect(node(groups, 'group:school:0:2025-3bWI-SWP/module-oop').expanded).toBe(true);
    expect(node(groups, 'group:school:0:2026-3cWI-SWP').expanded).toBe(false);
    expect(node(groups, 'group:school:0:2026-3cWI-SWP/module-oop').expanded).toBe(false);
  });

  it('applies the owners, archived, and forks filters first', () => {
    const groups = buildTreeModel(
      input({
        settings: { owners: ['a'], includeArchived: false, includeForks: false },
        discovery: discovery([
          repo('a/web-shop'),
          repo('a/web-old', { isArchived: true }),
          repo('a/web-fork', { isFork: true }),
          repo('b/web-x'),
        ]),
        repositoryGroups: patterns('^(web)-(.+)$'),
      }),
    );
    expect(tree(groups)).toEqual([['a', [['web', ['shop']]]]]);
  });

  it('finds the nested rows: repositoryRows, findRowByRepository, findRowByEnvironmentId, recentEnvironments', () => {
    const environments = [
      environment('e1', STUDENTS[1].nameWithOwner, { lastUsedAt: iso(T0 + 1000) }),
      environment('e2', 'other/kept'),
    ];
    const groups = buildTreeModel(
      input({ discovery: discovery(STUDENTS), environments, repositoryGroups: patterns({ name: 'C', pattern: EXAMPLE }) }),
    );
    // Owner groups in alphabetical order (other, school), then the rows in display order.
    expect(rows(groups).map((entry) => entry.label)).toEqual(['kept', 'hailo', 'EnesHA81', 'felix-he021']);
    expect(findRowByEnvironmentId(groups, 'e1')?.label).toBe('hailo');
    expect(findRowByRepository(groups, STUDENTS[0].nameWithOwner.toUpperCase())?.label).toBe('felix-he021');
    expect(findRowByRepository(groups, 'school/none')).toBeUndefined();
    expect(recentEnvironments(groups, environments).map((entry) => [entry.environmentId, entry.repository, entry.state])).toEqual([
      ['e1', STUDENTS[1].nameWithOwner, 'stopped'],
      ['e2', 'other/kept', 'stopped'],
    ]);
  });

  it('builds the same model as today with an empty setting, a missing one, or only invalid entries', () => {
    const base = input({
      discovery: discovery(STUDENTS, { hints: [{ organization: 'school', kind: 'saml', url: 'https://github.com/orgs/school/sso' }] }),
      environments: [environment('e1', STUDENTS[0].nameWithOwner), environment('e2', 'x/y')],
    });
    const today = JSON.stringify(buildTreeModel(base));
    expect(JSON.stringify(buildTreeModel({ ...base, repositoryGroups: [] }))).toBe(today);
    expect(JSON.stringify(buildTreeModel({ ...base, repositoryGroups: patterns('(', 3, { name: 'x' }) }))).toBe(today);
  });

  it('handles thousands of repositories', () => {
    const many = Array.from({ length: 5000 }, (_, i) => repo(`o/${2020 + (i % 7)}-c${i % 13}-SWP-module-m${i % 5}-student${i}`));
    const started = Date.now();
    const groups = buildTreeModel(input({ discovery: discovery(many), repositoryGroups: patterns(EXAMPLE) }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(rows(groups)).toHaveLength(5000);
    expect(groups[0].children).toHaveLength(7 * 13);
  });
});
