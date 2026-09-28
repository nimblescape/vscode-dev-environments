// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { silentLogger } from '../core/ports';
import type { Environment, RepositoryInfo } from '../core/types';
import { fakeVscode, resetFakeVscode, type ThemeIcon, type TreeItem } from './testing/fakeVscode';
import { parseRepositoryGroups } from './repositoryGroups';
import { buildTreeModel, type GroupNode, type HintRow, type OwnerGroup, type RepositoryRow } from './treeModel';
import { DOCKER_HOST_ROW_ID, DockerHostRowTexts, RepositoriesTreeProvider, type TreeNode } from './treeView';

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
  owner: { id: '1001', login: 'me' },
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
      scope: [],
      withoutConfiguration: [],
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
      // Unit 10: the flag of the host access checks (on by default). Unit 26: Keep Running When Closed (off by default).
      // Unit 7, PR 2: Close and Keep Running for the environment of this window.
      contextValue: 'repository;canStop;canDelete;canRebuild;onGitHub;hostAccessChecked;canKeepRunning;canCloseAndKeepRunning',
    });
    // User requests 2026-09-28: without the root of the extension, the codicon of the monitor with the remote sign.
    expect((apiItem.iconPath as ThemeIcon).id).toBe('vm-connect');
    // With it, the filled monitor with the connection sign of resources/icons, in a light and a dark variant.
    const withIcons = new RepositoriesTreeProvider(silentLogger, fakeVscode.Uri.file('/ext') as never);
    withIcons.setModel(groups);
    const iconPath = (withIcons.getTreeItem(api) as unknown as TreeItem).iconPath as { light: { fsPath: string }; dark: { fsPath: string } };
    expect(iconPath.light.fsPath).toBe('/ext/resources/icons/monitor-connected-light.svg');
    expect(iconPath.dark.fsPath).toBe('/ext/resources/icons/monitor-connected-dark.svg');
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

  // User report 2026-09-28 ("remote connection is not shown anymore"): the list names the remote Docker host.
  it('shows the remote Docker host as the first row above a list, never in an empty view', () => {
    const provider = new RepositoriesTreeProvider(silentLogger);
    let changes = 0;
    provider.onDidChangeTreeData(() => changes++);
    provider.setDockerHost({ kind: 'remote', host: 'htldvmhn' });
    provider.setModel([], { signedIn: true });
    expect(provider.getChildren()).toEqual([]);
    const groups = model();
    provider.setModel(groups, { signedIn: false });
    const [host, signIn, ...rest] = provider.getChildren();
    expect(host).toEqual({ kind: 'dockerHost', id: DOCKER_HOST_ROW_ID, host: { kind: 'remote', host: 'htldvmhn' } });
    expect(signIn).toMatchObject({ kind: 'signIn' });
    expect(rest).toEqual(groups);
    const item = provider.getTreeItem(host) as unknown as TreeItem;
    expect(item.label).toBe('Remote Docker host: htldvmhn');
    // User request 2026-09-28 ("use the remote monitor icon"): the monitor with the remote badge (it was `remote`).
    expect((item.iconPath as ThemeIcon).id).toBe('remote-explorer');
    expect(item.command).toMatchObject({ command: 'devEnvironments.chooseDockerHost' });
    expect(item.contextValue).toBe('dockerHost');
    expect(provider.getParent(host)).toBeUndefined();
    expect(provider.getChildren(host)).toEqual([]);
    const before = changes;
    provider.setDockerHost({ kind: 'remote', host: 'htldvmhn' });
    expect(changes).toBe(before);
    // Not known (yet): no row.
    provider.setDockerHost(undefined);
    expect(changes).toBe(before + 1);
    expect(provider.getChildren()[0]).toMatchObject({ kind: 'signIn' });
    provider.dispose();
  });

  // User request 2026-09-28 ("the headline shall be shown also in local mode"; "the icon can then go away"): the first
  // row names the local Docker too (it used to show nothing there), and opens the same choice of the Docker host.
  it('shows the local Docker and an endpoint that is not supported as the first row too', () => {
    const provider = new RepositoriesTreeProvider(silentLogger);
    provider.setModel(model(), { signedIn: true });
    provider.setDockerHost({ kind: 'local', host: '' });
    const [local] = provider.getChildren();
    const localItem = provider.getTreeItem(local) as unknown as TreeItem;
    expect(localItem.label).toBe('Local Docker');
    expect(localItem.label).toBe(DockerHostRowTexts.label({ kind: 'local', host: '' }));
    expect((localItem.iconPath as ThemeIcon).id).toBe('vm');
    expect(localItem.command).toMatchObject({ command: 'devEnvironments.chooseDockerHost' });
    expect(localItem.tooltip).toBe('Docker runs on this computer. Click to use a remote Docker host.');
    provider.setDockerHost({ kind: 'unsupported', host: 'tcp://192.0.2.10:2376' });
    const unsupportedItem = provider.getTreeItem(provider.getChildren()[0]) as unknown as TreeItem;
    expect(unsupportedItem.label).toBe('Docker endpoint not supported: tcp://192.0.2.10:2376');
    expect((unsupportedItem.iconPath as ThemeIcon).id).toBe('warning');
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
        scope: [],
        withoutConfiguration: [],
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

  it('gives only repository rows the command that starts on a double-click (user request 2026-09-27)', () => {
    const provider = new RepositoriesTreeProvider(silentLogger);
    const rowCommands = (node: TreeNode): string[] => {
      const command = (provider.getTreeItem(node) as unknown as TreeItem).command as { command: string } | undefined;
      return [command?.command ?? '', ...provider.getChildren(node).flatMap(rowCommands)];
    };
    provider.setModel(model(), { signedIn: false });
    const [signIn, owner] = provider.getChildren();
    const [hint, api] = provider.getChildren(owner) as [HintRow, RepositoryRow];
    // The row itself is the argument, as for the row actions of package.json.
    expect((provider.getTreeItem(api) as unknown as TreeItem).command).toEqual({
      command: 'devEnvironments.rowActivated',
      title: 'Start',
      arguments: [api],
    });
    expect(rowCommands(owner)).toEqual(['', 'vscode.open', 'devEnvironments.rowActivated', 'devEnvironments.rowActivated']);
    expect(rowCommands(signIn)).toEqual(['devEnvironments.signIn']);
    expect((provider.getTreeItem(hint) as unknown as TreeItem).command).toMatchObject({ command: 'vscode.open' });
    provider.setModel(groupedModel());
    const [school] = provider.getChildren();
    const [courses] = provider.getChildren(school) as GroupNode[];
    expect((provider.getTreeItem(courses) as unknown as TreeItem).command).toBeUndefined();
    // Every node below: owners and group nodes have no command, repository rows have the command of the row.
    const walk = (node: TreeNode): TreeNode[] => [node, ...provider.getChildren(node).flatMap(walk)];
    const nodes = walk(school);
    expect(nodes.some((node) => node.kind === 'repository')).toBe(true);
    for (const node of nodes) {
      const command = ((provider.getTreeItem(node) as unknown as TreeItem).command as { command: string } | undefined)?.command;
      expect(command).toBe(node.kind === 'repository' ? 'devEnvironments.rowActivated' : undefined);
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
