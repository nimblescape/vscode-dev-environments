// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { silentLogger } from '../core/ports';
import type { Environment, RepositoryInfo } from '../core/types';
import { resetFakeVscode, type ThemeIcon, type TreeItem } from './testing/fakeVscode';
import { parseRepositoryGroups } from './repositoryGroups';
import { buildTreeModel, type GroupNode, type HintRow, type OwnerGroup, type RepositoryRow } from './treeModel';
import { RepositoriesTreeProvider } from './treeView';

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
    pushedAt: null,
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
  };
}

const env: Environment = {
  id: 'e1',
  repository: 'acme/api',
  configPath: '.devcontainer/devcontainer.json',
  volumeName: 'v',
  containerName: 'c',
  createdAt: '2026-09-24T15:00:00.000Z',
  lastUsedAt: '2026-09-24T17:00:00.000Z',
  gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: '' },
};

function model(): OwnerGroup[] {
  return buildTreeModel({
    discovery: {
      version: 1,
      fetchedAt: '',
      viewerLogin: 'me',
      organizations: ['acme'],
      repositories: [repo('acme/api'), repo('acme/web')],
      hints: [{ organization: 'acme', kind: 'saml', url: 'https://github.com/orgs/acme/sso' }],
    },
    settings: { owners: [], includeArchived: false, includeForks: true },
    environments: [env],
    runtime: new Map([['e1', { container: 'running', volume: true }]]),
    currentEnvironmentId: 'e1',
    otherWindowEnvironmentIds: new Set(),
    busyEnvironmentIds: new Set(),
    liveBranches: new Map([['e1', 'main']]),
    signedIn: true,
  });
}

describe('RepositoriesTreeProvider', () => {
  beforeEach(() => resetFakeVscode());

  it('maps the model to tree items and fires a change on each new model', () => {
    const provider = new RepositoriesTreeProvider(silentLogger);
    const changes = vi.fn();
    provider.onDidChangeTreeData(changes);
    const groups = model();
    provider.setModel(groups);
    expect(changes).toHaveBeenCalledTimes(1);

    const [group] = provider.getChildren() as OwnerGroup[];
    const groupItem = provider.getTreeItem(group) as unknown as TreeItem;
    expect(groupItem).toMatchObject({ label: 'acme', id: 'owner:acme', contextValue: 'owner' });

    const [hint, api, web] = provider.getChildren(group) as [HintRow, RepositoryRow, RepositoryRow];
    const hintItem = provider.getTreeItem(hint) as unknown as TreeItem;
    expect(hintItem).toMatchObject({ label: 'Access to the organization acme is not authorized.', description: 'Authorize' });
    expect(hintItem.command).toMatchObject({ command: 'vscode.open' });

    const apiItem = provider.getTreeItem(api) as unknown as TreeItem;
    expect(apiItem).toMatchObject({
      label: 'api',
      id: 'repo:acme/api',
      description: 'main   Connected',
      // Unit 10: the flag of the host access checks (on by default).
      contextValue: 'repository;canStop;canDelete;canRebuild;onGitHub;hostAccessChecked',
    });
    expect((apiItem.iconPath as ThemeIcon).id).toBe('circle-filled');
    // A repository without environment has no state symbol.
    expect(((provider.getTreeItem(web) as unknown as TreeItem).iconPath as ThemeIcon).id).toBe('blank');

    expect(provider.getParent(api)).toBe(group);
    expect(provider.getParent(group)).toBeUndefined();
    expect(provider.getChildren(api)).toEqual([]);
    provider.dispose();
  });

  it('shows the sign-in row first when the user is not signed in and the view lists environments', () => {
    const provider = new RepositoriesTreeProvider(silentLogger);
    const groups = model();
    provider.setModel(groups, { signedIn: false });
    const [first, ...rest] = provider.getChildren();
    expect(first).toMatchObject({ kind: 'signIn', id: 'signIn' });
    expect(rest).toEqual(groups);
    const item = provider.getTreeItem(first) as unknown as TreeItem;
    expect(item).toMatchObject({ label: 'Sign in with GitHub', id: 'signIn', contextValue: 'signIn' });
    expect(item.command).toMatchObject({ command: 'devEnvironments.signIn' });
    expect((item.iconPath as ThemeIcon).id).toBe('account');
    expect(provider.getParent(first)).toBeUndefined();
    expect(provider.getChildren(first)).toEqual([]);
    // The model for the switcher never contains the sign-in row.
    expect(provider.getModel()).toEqual(groups);
    provider.dispose();
  });

  // Replaces the test of the Docker row. User decision 2026-09-26: "when no remote docker is configured and local docker
  // is not available, the repositories shall not be shown, instead, the side view shall show the install docker wizard".
  // The sidebar passes an empty model while the setup is required (sidebar.test.ts): the view has no rows at all, so
  // VS Code shows the welcome view with the setup; with a list, the view shows no Docker row.
  it('shows no rows for the empty model of the Docker setup, and no Docker row above a list', () => {
    const provider = new RepositoriesTreeProvider(silentLogger);
    provider.setModel([], { signedIn: false });
    expect(provider.getChildren()).toEqual([]);
    const groups = model();
    provider.setModel(groups, { signedIn: false });
    const [first, ...rest] = provider.getChildren();
    expect(first).toMatchObject({ kind: 'signIn', id: 'signIn' });
    expect(rest).toEqual(groups);
    provider.setModel(groups, { signedIn: true });
    expect(provider.getChildren()).toEqual(groups);
    provider.dispose();
  });

  it('shows no sign-in row in an empty view (the welcome view shows the sign-in button)', () => {
    const provider = new RepositoriesTreeProvider(silentLogger);
    provider.setModel([], { signedIn: false });
    expect(provider.getChildren()).toEqual([]);
    provider.setModel(model(), { signedIn: true });
    expect((provider.getChildren() as OwnerGroup[]).every((node) => node.kind === 'owner')).toBe(true);
    provider.dispose();
  });
});

describe('nodes of the setting repositoryGroups', () => {
  beforeEach(() => resetFakeVscode());

  function groupedModel(): OwnerGroup[] {
    const names = ['2026-3cWI-SWP-module-oop-EnesHA81', '2026-3cWI-SWP-module-oop-felix-he021', '2025-3bWI-SWP-module-oop-hailo'];
    return buildTreeModel({
      discovery: {
        version: 1,
        fetchedAt: '',
        viewerLogin: 'me',
        organizations: ['school'],
        repositories: names.map((name) => repo(`school/${name}`)),
        hints: [],
      },
      settings: { owners: [], includeArchived: false, includeForks: true },
      environments: [{ ...env, repository: 'school/2026-3cWI-SWP-module-oop-EnesHA81' }],
      runtime: new Map([['e1', { container: 'running', volume: true }]]),
      currentEnvironmentId: 'e1',
      otherWindowEnvironmentIds: new Set(),
      busyEnvironmentIds: new Set(),
      liveBranches: new Map(),
      signedIn: true,
      repositoryGroups: parseRepositoryGroups([{ name: 'Courses', pattern: String.raw`^(\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$` }])
        .patterns,
    });
  }

  it('maps the nested nodes to tree items, with parents, children, and the initial collapsible state', () => {
    const provider = new RepositoriesTreeProvider(silentLogger);
    provider.setModel(groupedModel());
    const [owner] = provider.getChildren() as OwnerGroup[];
    const [root] = provider.getChildren(owner) as GroupNode[];
    expect(provider.getTreeItem(root)).toMatchObject({
      label: 'Courses',
      id: 'group:school:0:',
      contextValue: 'group',
      collapsibleState: 2,
      tooltip: String.raw`^(\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$`,
    });
    const [y2025, y2026] = provider.getChildren(root) as GroupNode[];
    // Collapsed, except the node that holds the row of the environment of this window.
    expect(provider.getTreeItem(y2025)).toMatchObject({ label: '2025-3bWI-SWP', collapsibleState: 1 });
    expect(provider.getTreeItem(y2026)).toMatchObject({ label: '2026-3cWI-SWP', collapsibleState: 2 });
    const [module] = provider.getChildren(y2026) as GroupNode[];
    const [enes, felix] = provider.getChildren(module) as RepositoryRow[];
    const item = provider.getTreeItem(enes) as unknown as TreeItem;
    expect(item).toMatchObject({ label: 'EnesHA81', id: 'repo:school/2026-3cwi-swp-module-oop-enesha81', collapsibleState: 0 });
    expect(item.tooltip).toContain('school/2026-3cWI-SWP-module-oop-EnesHA81');
    expect((item.accessibilityInformation as { label: string }).label).toContain('school/2026-3cWI-SWP-module-oop-EnesHA81');
    expect((provider.getTreeItem(felix) as unknown as TreeItem).label).toBe('felix-he021');
    // Reveal walks up from any row to the owner group.
    expect(provider.getParent(enes)).toBe(module);
    expect(provider.getParent(module)).toBe(y2026);
    expect(provider.getParent(y2026)).toBe(root);
    expect(provider.getParent(root)).toBe(owner);
    expect(provider.getParent(owner)).toBeUndefined();
    provider.dispose();
  });

  it('gives group nodes a contextValue that no row action of package.json matches', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { menus: Record<string, Array<{ when?: string }>> };
    };
    const provider = new RepositoriesTreeProvider(silentLogger);
    const [owner] = groupedModel();
    const value = (provider.getTreeItem(owner.children[0]) as unknown as TreeItem).contextValue ?? '';
    for (const menu of ['view/item/context', 'devEnvironments.more']) {
      for (const { when } of manifest.contributes.menus[menu]) {
        for (const regex of (when ?? '').matchAll(/viewItem =~ \/(.+?)\//g)) expect(new RegExp(regex[1]).test(value)).toBe(false);
      }
    }
    provider.dispose();
  });
});

describe('hint row of an owner that GitHub does not return', () => {
  beforeEach(() => resetFakeVscode());

  it('offers no authorization, only the page of the owner', () => {
    const provider = new RepositoriesTreeProvider(silentLogger);
    const hint: HintRow = {
      kind: 'hint',
      id: 'hint:nobody',
      organization: 'nobody',
      notFound: true,
      label: 'The organization nobody was not found or is not accessible.',
      url: 'https://github.com/nobody',
    };
    const item = provider.getTreeItem(hint) as unknown as TreeItem;
    expect(item.label).toBe('The organization nobody was not found or is not accessible.');
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBe('Open: https://github.com/nobody');
    expect(item.command).toMatchObject({ command: 'vscode.open', title: 'Open' });
  });
});
