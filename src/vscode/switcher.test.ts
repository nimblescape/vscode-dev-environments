import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type { Environment, RepositoryInfo } from '../core/types';
import { pickRepository, showSwitcher } from './switcher';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import { buildTreeModel } from './treeModel';

const T0 = Date.parse('2026-09-24T17:00:00.000Z');

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
    pushedAt: new Date(T0).toISOString(),
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
    ...overrides,
  };
}

function environment(id: string, repository: string, lastUsedAt: number): Environment {
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: `devenv-${id}`,
    containerName: `devenv-${id}`,
    createdAt: new Date(T0 - 3_600_000).toISOString(),
    lastUsedAt: new Date(lastUsedAt).toISOString(),
    gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: new Date(T0).toISOString() },
  };
}

interface Item {
  label: string;
  description?: string;
  kind?: number;
  choice?: unknown;
  repository?: RepositoryInfo;
}

describe('switcher (concept 6.4)', () => {
  beforeEach(() => resetFakeVscode());
  const { showQuickPick } = fakeVscode.window;

  const repositories = [repo('acme/api'), repo('acme/web', { isFork: true }), repo('acme/old', { isArchived: true })];
  const environments = [environment('e-web', 'acme/web', T0 - 60_000), environment('e-api', 'acme/api', T0)];
  const groups = buildTreeModel({
    discovery: { version: 1, fetchedAt: '', viewerLogin: 'me', organizations: [], repositories, hints: [] },
    settings: { owners: [], includeArchived: true, includeForks: true },
    environments,
    runtime: undefined,
    currentEnvironmentId: 'e-api',
    otherWindowEnvironmentIds: new Set(),
    busyEnvironmentIds: new Set(),
    liveBranches: new Map(),
    signedIn: true,
  });

  it('lists the recent environments with their state, then Open repository…', async () => {
    showQuickPick.mockImplementationOnce(async (items: Item[]) => items[2]);
    await expect(showSwitcher({ groups, environments, repositories })).resolves.toEqual({
      kind: 'environment',
      environmentId: 'e-web',
    });
    const items = showQuickPick.mock.calls[0][0] as Item[];
    expect(items.map((item) => [item.label, item.description ?? ''])).toEqual([
      ['Recent environments', ''],
      ['$(circle-filled) acme/api', 'main   Connected'],
      ['$(circle-outline) acme/web', 'main   Stopped'],
      ['', ''],
      ['$(repo) Open repository…', ''],
    ]);
    expect(items[0].kind).toBe(fakeVscode.QuickPickItemKind.Separator);
  });

  it('shows all repositories with a text search after Open repository…', async () => {
    showQuickPick
      .mockImplementationOnce(async (items: Item[]) => items[items.length - 1])
      .mockImplementationOnce(async (items: Item[]) => items.find((item) => item.label === 'acme/old'));
    await expect(showSwitcher({ groups, environments, repositories })).resolves.toEqual({
      kind: 'repository',
      repository: repositories[2],
    });
    const [items, options] = showQuickPick.mock.calls[1] as [Item[], { matchOnDescription?: boolean }];
    expect(items.map((item) => item.label).sort()).toEqual(['acme/api', 'acme/old', 'acme/web']);
    expect(items.find((item) => item.label === 'acme/web')?.description).toBe('main · fork');
    expect(options.matchOnDescription).toBe(true);
  });

  it('returns nothing when the user closes a list', async () => {
    await expect(showSwitcher({ groups, environments, repositories })).resolves.toBeUndefined();
    showQuickPick.mockImplementationOnce(async (items: Item[]) => items[items.length - 1]);
    await expect(showSwitcher({ groups, environments, repositories })).resolves.toBeUndefined();
    await expect(pickRepository(repositories)).resolves.toBeUndefined();
  });

  it('titles the repository list "Open repository…" only when the pick opens the repository', async () => {
    await pickRepository(repositories, 'Select a repository to open');
    await pickRepository(repositories, 'Select a repository to show on GitHub', null);
    const titles = showQuickPick.mock.calls.map((call: unknown[]) => (call[1] as { title?: string }).title);
    expect(titles).toEqual(['Open repository…', undefined]);
  });

  it('opens the repository list at once when no environment exists', async () => {
    showQuickPick.mockImplementationOnce(async (items: Item[]) => items[0]);
    const choice = await showSwitcher({ groups: [], environments: [], repositories: [repositories[0]] });
    expect(choice).toEqual({ kind: 'repository', repository: repositories[0] });
    expect(showQuickPick).toHaveBeenCalledTimes(1);
  });
});
