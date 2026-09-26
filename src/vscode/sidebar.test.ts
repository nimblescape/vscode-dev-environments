// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { StateTexts } from '../core/messages';
import { EnvironmentClaims } from '../core/ownership';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { DiscoveryData, Environment, ExtensionSettings, GitHubAccount, RepositoryInfo, WindowStatus } from '../core/types';
import { LOADED_CONTEXT_KEY, LOAD_FAILED_CONTEXT_KEY, SLOW_GROUPING_MS, Sidebar, type SidebarDeps } from './sidebar';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import { parseRepositoryGroups } from './repositoryGroups';
import { buildGroupsPreview, entriesFromSetting } from './repositoryGroupsEditorModel';
import { TreeTexts, buildTreeModel, repositoryRows, type OwnerGroup, type RepositoryRow } from './treeModel';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const SETTINGS: ExtensionSettings = {
  reopenLastOnStartup: true,
  stopOnClose: true,
  waitingTimeSeconds: 30,
  updateImagesOnConnect: true,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: true,
  refreshIntervalMinutes: 60,
  hostAccessChecksOff: [],
};

const OCTO: GitHubAccount = { id: '1001', login: 'octo' };
const OTHER: GitHubAccount = { id: '2002', login: 'someone' };

/** An environment of the signed-in account OCTO, unless `overrides` names another owner. */
function environment(id: string, repository: string, overrides: Partial<Environment> = {}): Environment {
  const name = `devenv-${repository.replace('/', '-')}`;
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: name,
    containerName: name,
    createdAt: iso(NOW - 86_400_000),
    lastUsedAt: iso(NOW - 3_600_000),
    owner: OCTO,
    ...overrides,
  };
}

function info(nameWithOwner: string): RepositoryInfo {
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
  };
}

function data(repositories: RepositoryInfo[]): DiscoveryData {
  return { version: 1, fetchedAt: iso(NOW), viewerLogin: 'octo', organizations: ['acme'], repositories, hints: [] };
}

const API = '11111111-1111-4111-8111-111111111111';
const OLD = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';
const FAILS = '44444444-4444-4444-8444-444444444444';

interface Harness {
  root: string;
  registry: EnvironmentRegistry;
  sessionFiles: SessionFiles;
  sidebar: Sidebar;
  models: OwnerGroup[][];
  signedInFlags: boolean[];
  /** The Docker setup is required (the view gets an empty model). */
  setupRequired: { value: boolean };
  coordinator: { environmentId: string | null; otherActiveWindows: ReturnType<typeof vi.fn<() => Promise<WindowStatus[]>>> };
  service: { inspectStates: ReturnType<typeof vi.fn>; currentBranch: ReturnType<typeof vi.fn> };
  docker: { isInstalled: ReturnType<typeof vi.fn>; isRunning: ReturnType<typeof vi.fn> };
  discovery: { loadStored: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>; getRepository: ReturnType<typeof vi.fn> };
  auth: {
    getToken: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    getAccount: ReturnType<typeof vi.fn>;
    isSignedIn: ReturnType<typeof vi.fn>;
    updateContextKey: ReturnType<typeof vi.fn>;
  };
  /** The settings that the sidebar reads; a test can change them. */
  settings: ExtensionSettings;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  clock: { now: () => number };
}

function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  const clock = { now: () => NOW };
  const paths = new StoragePaths(root);
  paths.ensureDirectoriesSync();
  const registry = new EnvironmentRegistry(paths, clock);
  const sessionFiles = new SessionFiles(paths, clock);
  const models: OwnerGroup[][] = [];
  const setupRequired = { value: false };
  const signedInFlags: boolean[] = [];
  const tree = {
    setModel: (groups: OwnerGroup[], options: { signedIn?: boolean }) => {
      models.push(groups);
      signedInFlags.push(options.signedIn ?? true);
    },
    getModel: () => models[models.length - 1] ?? [],
  };
  const coordinator = { environmentId: null as string | null, otherActiveWindows: vi.fn(async (): Promise<WindowStatus[]> => []) };
  const service = { inspectStates: vi.fn(async () => undefined), currentBranch: vi.fn(async () => undefined) };
  const docker = { isInstalled: vi.fn(() => true), isRunning: vi.fn(async () => true) };
  const discovery = {
    loadStored: vi.fn(async () => undefined),
    refresh: vi.fn(async () => data([info('acme/api')])),
    getRepository: vi.fn(async () => undefined),
  };
  const auth = {
    getToken: vi.fn(async () => 'gho_token'),
    // One session: the token and the account that getToken and getAccount give.
    getSession: vi.fn(async (): Promise<{ token: string; account: GitHubAccount } | undefined> => {
      const token = (await auth.getToken()) as string | undefined;
      const account = await auth.getAccount();
      return token !== undefined && account !== undefined ? { token, account } : undefined;
    }),
    getAccount: vi.fn(async (): Promise<GitHubAccount | undefined> => OCTO),
    isSignedIn: vi.fn(async () => true),
    updateContextKey: vi.fn(async () => true),
    renewToken: vi.fn(async () => undefined),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const getRepository = discovery.getRepository as unknown as (repository: string, token: string) => Promise<RepositoryInfo | undefined>;
  const claims = new EnvironmentClaims({ registry, getRepository: (repository, token) => getRepository(repository, token), logger });
  const settings: ExtensionSettings = { ...SETTINGS, owners: [...SETTINGS.owners] };
  const sidebar = new Sidebar({
    claims,
    logger,
    registry,
    sessionFiles,
    coordinator,
    service,
    docker,
    discovery,
    auth,
    tree,
    settings: () => settings,
    dockerSetupRequired: () => setupRequired.value,
    clock,
    isAlive: (pid: number) => pid === process.pid,
  } as unknown as SidebarDeps);
  return {
    root,
    registry,
    sessionFiles,
    sidebar,
    models,
    signedInFlags,
    setupRequired,
    coordinator,
    service,
    docker,
    discovery,
    auth,
    settings,
    logger,
    clock,
  };
}

let h: Harness;

beforeEach(() => {
  resetFakeVscode();
  fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: () => Promise<unknown>) => task());
  h = createHarness();
});

afterEach(() => {
  h.sidebar.dispose();
  fs.rmSync(h.root, { recursive: true, force: true });
});

function rows(): RepositoryRow[] {
  return repositoryRows(h.models[h.models.length - 1] ?? []);
}

/** The sidebar knows the signed-in account (activation) and has loaded its list. */
async function signedIn(): Promise<void> {
  await h.sidebar.initialize();
  await h.sidebar.refreshDiscovery();
}

function rowOf(repository: string): RepositoryRow {
  const found = rows().find((candidate) => candidate.repository === repository);
  if (!found) throw new Error(`No row for ${repository}: ${rows().map((candidate) => candidate.repository).join(', ')}`);
  return found;
}

describe('Sidebar', () => {
  // User decision 2026-09-26: "when no remote docker is configured and local docker is not available, the repositories
  // shall not be shown, instead, the side view shall show the install docker wizard".
  it('gives the view an empty model while the Docker setup is required, and the full model once Docker is found', async () => {
    h.setupRequired.value = true;
    await signedIn();
    await h.sidebar.render();
    // The discovery ran in the background, but the view has no rows at all: VS Code shows the welcome view.
    expect(h.discovery.refresh).toHaveBeenCalled();
    expect(h.models.length).toBeGreaterThan(0);
    expect(h.models.every((groups) => groups.length === 0)).toBe(true);
    // The Command Palette (switcher) still gets the repositories.
    expect(repositoryRows(h.sidebar.model()).map((row) => row.repository)).toEqual(['acme/api']);
    // Docker is found: DockerSetup calls render (onDidChangeInstalled), and the list appears at once.
    h.setupRequired.value = false;
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
    // Lost again: the view is empty again.
    h.setupRequired.value = true;
    await h.sidebar.render();
    expect(h.models[h.models.length - 1]).toEqual([]);
    expect(h.docker.isRunning).not.toHaveBeenCalled();
    expect(h.docker.isInstalled).not.toHaveBeenCalled();
  });

  it('shows the stored list at once and marks the view as loaded, then refreshes in the background', async () => {
    h.discovery.loadStored.mockResolvedValue(data([info('acme/web')]));
    await h.sidebar.initialize();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOADED_CONTEXT_KEY, true);
    expect(rows().map((row) => row.repository)).toEqual(['acme/web']);
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(h.discovery.refresh).toHaveBeenCalledTimes(1);
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
  });

  it('keeps the stored list when the refresh fails, and still ends "Loading"', async () => {
    h.discovery.refresh.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));
    h.discovery.loadStored.mockResolvedValue(data([info('acme/web')]));
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/web']);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOADED_CONTEXT_KEY, true);
    // A stored list is shown: the view does not say that the list could not be loaded.
    expect(fakeVscode.commands.executeCommand).not.toHaveBeenCalledWith('setContext', LOAD_FAILED_CONTEXT_KEY, true);
  });

  it('says that the list could not be loaded when the first refresh fails without a stored list', async () => {
    h.discovery.refresh.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.github.com'));
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOADED_CONTEXT_KEY, true);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOAD_FAILED_CONTEXT_KEY, true);

    // The next refresh succeeds: the view shows the list (or "No repository … was found").
    await h.sidebar.refreshDiscovery({ again: true });
    expect(fakeVscode.commands.executeCommand).toHaveBeenLastCalledWith('setContext', LOAD_FAILED_CONTEXT_KEY, false);
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
  });

  it('runs one refresh at a time and reuses the running one', async () => {
    let finish!: (value: DiscoveryData) => void;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    const first = h.sidebar.refreshDiscovery();
    const second = h.sidebar.refreshDiscovery();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    finish(data([]));
    await Promise.all([first, second]);
    expect(h.discovery.refresh).toHaveBeenCalledTimes(1);
  });

  it('asks GitHub for the repositories of environments that the list lacks, and marks only missing ones', async () => {
    await h.registry.add(environment(API, 'acme/api'));
    await h.registry.add(environment(OLD, 'acme/old'));
    await h.registry.add(environment(GONE, 'acme/gone'));
    await h.registry.add(environment(FAILS, 'acme/fails'));
    h.discovery.getRepository.mockImplementation(async (repository: string) => {
      if (repository === 'acme/old') return info('acme/old');
      if (repository === 'acme/fails') throw new Error('timeout');
      return undefined;
    });
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();

    expect(h.discovery.getRepository.mock.calls.map((call) => call[0]).sort()).toEqual(['acme/fails', 'acme/gone', 'acme/old']);
    expect(rowOf('acme/api').notOnGitHub).toBe(false);
    expect(rowOf('acme/old').notOnGitHub).toBe(false);
    expect(rowOf('acme/old').contextValue).toContain('onGitHub');
    expect(h.sidebar.repositoryInfo('ACME/old')?.url).toBe('https://github.com/acme/old');
    expect(rowOf('acme/gone').notOnGitHub).toBe(true);
    expect(rowOf('acme/gone').description).toContain(StateTexts.notOnGitHub);
    expect(rowOf('acme/fails').notOnGitHub).toBe(false);
  });

  it('shows every environment as stopped when Docker does not run, so a lost connection is not shown as Connected', async () => {
    await h.registry.add(environment(API, 'acme/api'));
    h.coordinator.environmentId = API;
    await signedIn();
    await h.sidebar.render();
    expect(rowOf('acme/api').state).toBe('connected');

    h.service.inspectStates.mockResolvedValue(undefined);
    h.docker.isRunning.mockResolvedValue(false);
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').state).toBe('stopped');
    expect(rowOf('acme/api').contextValue).toContain('canStart');
  });

  it('falls back to the states of the registry when Docker runs but its answer could not be read', async () => {
    await h.registry.add(environment(API, 'acme/api'));
    await signedIn();
    h.service.inspectStates.mockResolvedValueOnce(new Map([[API, { container: 'running', volume: true }]]));
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').state).toBe('running');
    h.service.inspectStates.mockResolvedValueOnce(undefined);
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').state).toBe('stopped');
  });

  it('reads the branch of running containers when it refreshes the states', async () => {
    await h.registry.add(environment(API, 'acme/api', { gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) } }));
    await signedIn();
    h.service.inspectStates.mockResolvedValue(new Map([[API, { container: 'running', volume: true }]]));
    h.service.currentBranch.mockResolvedValue('feature-x');
    const refreshed = vi.fn();
    h.sidebar.onDidRefreshStates(refreshed);
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').branch).toBe('feature-x');
    expect(h.sidebar.liveBranch(API)).toBe('feature-x');
    expect(refreshed).toHaveBeenCalled();
  });

  it('shows Updating only for busy marks of live windows with a recent status file', async () => {
    await h.registry.add(
      environment(API, 'acme/api', { busy: { operation: 'rebuild', since: iso(NOW - 1000), pid: process.pid, windowId: 'w1' } }),
    );
    await h.registry.add(
      environment(OLD, 'acme/old', { busy: { operation: 'rebuild', since: iso(NOW - 1000), pid: 999_999, windowId: 'w2' } }),
    );
    await h.sessionFiles.writeWindowStatus({ windowId: 'w1', pid: process.pid, environmentId: null, state: 'active', updatedAt: iso(NOW) });
    await signedIn();
    await h.sidebar.render();
    expect(rowOf('acme/api').state).toBe('updating');
    expect(rowOf('acme/api').contextValue).not.toContain('canStop');
    expect(rowOf('acme/old').state).toBe('stopped');
  });

  it('shows nothing but the sign-in when the user is not signed in: no environment is available (concept 7.5)', async () => {
    await h.registry.add(environment(API, 'acme/api'));
    h.auth.updateContextKey.mockResolvedValue(false);
    h.auth.getAccount.mockResolvedValue(undefined);
    await h.sidebar.initialize();
    expect(h.signedInFlags[h.signedInFlags.length - 1]).toBe(false);
    expect(rows()).toEqual([]);
    h.auth.getAccount.mockResolvedValue(OCTO);
    await h.sidebar.onSessionChanged();
    await h.sidebar.render();
    expect(h.signedInFlags[h.signedInFlags.length - 1]).toBe(true);
    expect(rows().map((row) => row.repository)).toContain('acme/api');
  });

  it('trusts an owner only with a list of the current account', async () => {
    h.discovery.loadStored.mockResolvedValue({ ...data([]), viewerLogin: 'someone-else' });
    await h.sidebar.initialize();
    h.discovery.refresh.mockResolvedValue(data([]));
    expect(await h.sidebar.trustedOwner('acme')).toBe(true);
    expect(await h.sidebar.trustedOwner('stranger')).toBe(false);
  });

  it('shows only the environments of the signed-in account, and names no other (concept 7.5)', async () => {
    await h.registry.add(environment(API, 'acme/api'));
    await h.registry.add(environment(OLD, 'majikmate/module-ts', { owner: OTHER }));
    await h.registry.add(environment(GONE, 'majikmate/legacy', { owner: undefined }));
    h.discovery.refresh.mockResolvedValue(data([info('acme/api')]));
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
    const shown = JSON.stringify(h.models);
    expect(shown).not.toContain('module-ts');
    expect(shown).not.toContain('majikmate');
    // Search and the switcher list the same.
    expect((await h.sidebar.repositoriesForPicker()).map((repository) => repository.nameWithOwner)).toEqual(['acme/api']);
    expect((await h.sidebar.availableEnvironments()).map((entry) => entry.id)).toEqual([API]);
    // No lookup on GitHub for a hidden environment, and no branch read in its container.
    expect(h.discovery.getRepository.mock.calls.map((call) => call[0])).toEqual(['majikmate/legacy']);
    h.service.inspectStates.mockResolvedValue(new Map([[OLD, { container: 'running', volume: true }], [API, { container: 'running', volume: true }]]));
    await h.sidebar.refreshStates();
    expect(h.service.currentBranch.mock.calls.map((call) => call[0])).toEqual([API]);
  });

  it('offers Start for a listed repository that has an environment of another account, and names it nowhere (D-3)', async () => {
    await h.registry.add(environment(OLD, 'majikmate/module-ts', { owner: OTHER }));
    // An entry of an older version is not counted: this account may still claim it.
    await h.registry.add(environment(GONE, 'acme/legacy', { owner: undefined }));
    h.discovery.refresh.mockResolvedValue(data([info('majikmate/module-ts'), info('acme/legacy'), info('acme/api')]));
    await signedIn();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api', 'acme/legacy', 'majikmate/module-ts']);
    expect(rowOf('majikmate/module-ts').environment).toBeUndefined();
    expect(rowOf('majikmate/module-ts').actions.canStart).toBe(true);
    expect(rowOf('majikmate/module-ts').description).toBe('');
    expect(rowOf('majikmate/module-ts').tooltip).toContain(TreeTexts.noEnvironment);
    expect(JSON.stringify(h.models)).not.toContain(OLD);
    expect(rowOf('acme/legacy').actions.canStart).toBe(true);
    expect(rowOf('acme/api').actions.canStart).toBe(true);
  });

  it('claims an environment of an older version after a refresh only when it can belong to this account alone', async () => {
    // Without a question (EnvironmentClaims mode `auto`): a private repository of the account itself that it can push to.
    await h.registry.add(environment(OLD, 'octo/module-ts', { owner: undefined }));
    await h.registry.add(environment(GONE, 'majikmate/no-access', { owner: undefined }));
    await h.registry.add(environment(FAILS, 'majikmate/shared', { owner: undefined }));
    h.discovery.getRepository.mockImplementation(async (repository: string) => {
      if (repository === 'octo/module-ts') return { ...info(repository), isPrivate: true, viewerPermission: 'WRITE' };
      // Other members of the organization can access it too: it stays hidden until a command confirms it.
      if (repository === 'majikmate/shared') return { ...info(repository), isPrivate: true, viewerPermission: 'WRITE' };
      return undefined;
    });
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect((await h.registry.get(OLD))?.owner).toEqual(OCTO);
    expect((await h.registry.get(GONE))?.owner).toBeUndefined();
    expect((await h.registry.get(FAILS))?.owner).toBeUndefined();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api', 'octo/module-ts']);
  });

  it('keeps an environment of an older version hidden when GitHub cannot be asked', async () => {
    await h.registry.add(environment(OLD, 'majikmate/module-ts', { owner: undefined }));
    h.discovery.getRepository.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect((await h.registry.get(OLD))?.owner).toBeUndefined();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
  });

  it('shows the list and the environments of the new account after an account change, never those of the previous one', async () => {
    await h.registry.add(environment(API, 'acme/api'));
    await h.registry.add(environment(OLD, 'staussh/tools', { owner: OTHER }));
    h.discovery.loadStored.mockImplementation(async (accountId: string) =>
      accountId === OCTO.id ? data([info('scalarion/private')]) : data([info('staussh/public')]),
    );
    h.discovery.refresh.mockImplementation(() => new Promise(() => undefined));
    await h.sidebar.initialize();
    expect(rows().map((row) => row.repository).sort()).toEqual(['acme/api', 'scalarion/private']);

    h.auth.getAccount.mockResolvedValue(OTHER);
    void h.sidebar.onSessionChanged();
    await vi.waitFor(() => expect(h.sidebar.currentAccount).toEqual(OTHER));
    await h.sidebar.render();
    expect(h.discovery.loadStored).toHaveBeenLastCalledWith(OTHER.id);
    expect(rows().map((row) => row.repository).sort()).toEqual(['staussh/public', 'staussh/tools']);
    expect(JSON.stringify(h.models[h.models.length - 1])).not.toContain('scalarion');
  });

  it('refreshes and claims with the token and the account of one session', async () => {
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    // Separate reads would give OCTO's token with OTHER's account after a switch between them.
    h.auth.getSession.mockResolvedValue({ token: 'gho_other', account: OTHER });
    await h.sidebar.refreshDiscovery({ again: true });
    expect(h.discovery.refresh).toHaveBeenLastCalledWith('gho_other', OTHER.id);
  });

  it('refreshes with the ID of the account, so the list is stored for that account', async () => {
    await h.sidebar.initialize();
    await h.sidebar.refreshDiscovery();
    expect(h.discovery.refresh).toHaveBeenCalledWith('gho_token', OCTO.id);
  });
});

describe('Sidebar and the scan scope (setting owners, concept 7.4)', () => {
  const scoped = (repositories: RepositoryInfo[], scope: string[]): DiscoveryData => ({ ...data(repositories), scope });

  it('does not show a stored list of another scope, and shows the list of the refresh with the current scope', async () => {
    h.settings.owners = ['acme'];
    // A list of an older version: all repositories.
    h.discovery.loadStored.mockResolvedValue(data([info('acme/web'), info('octo/dotfiles')]));
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await h.sidebar.render();
    expect(rows()).toEqual([]);
    expect(h.sidebar.discoveryData).toBeUndefined();
    expect(fakeVscode.commands.executeCommand).not.toHaveBeenCalledWith('setContext', LOADED_CONTEXT_KEY, true);
    expect(h.discovery.refresh).toHaveBeenCalledTimes(1);

    finish(scoped([info('acme/api')], ['acme']));
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOADED_CONTEXT_KEY, true);
  });

  it('shows a stored list of the same scope at once, whatever the order and case of the setting', async () => {
    h.settings.owners = ['Beta', 'ACME'];
    h.discovery.loadStored.mockResolvedValue(scoped([info('acme/web')], ['acme', 'beta']));
    h.discovery.refresh.mockImplementation(() => new Promise(() => undefined));
    await h.sidebar.initialize();
    expect(rows().map((row) => row.repository)).toEqual(['acme/web']);
  });

  it('rescans at once after a change of the setting, and hides the list of the previous scope meanwhile', async () => {
    h.discovery.refresh.mockResolvedValue(scoped([info('acme/api'), info('octo/dotfiles')], []));
    await signedIn();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository).sort()).toEqual(['acme/api', 'octo/dotfiles']);

    h.settings.owners = ['acme'];
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    const changed = h.sidebar.onScopeChanged();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(2));
    await h.sidebar.render();
    expect(rows()).toEqual([]);
    expect(fakeVscode.commands.executeCommand).toHaveBeenLastCalledWith('setContext', LOADED_CONTEXT_KEY, false);

    finish(scoped([info('acme/api')], ['acme']));
    await changed;
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
  });

  it('does not show a list whose scope changed while it loaded', async () => {
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.settings.owners = ['acme'];
    finish(scoped([info('acme/api'), info('octo/dotfiles')], []));
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(h.sidebar.discoveryData).toBeUndefined();
    expect(rows()).toEqual([]);
  });

  it('asks GitHub only about unlisted repositories of the scope, and keeps the others without `not on GitHub`', async () => {
    h.settings.owners = ['acme'];
    await h.registry.add(environment(API, 'acme/api'));
    await h.registry.add(environment(OLD, 'acme/unlisted'));
    await h.registry.add(environment(GONE, 'octo/outside'));
    h.discovery.refresh.mockResolvedValue(scoped([info('acme/api')], ['acme']));
    await signedIn();
    await h.sidebar.render();
    expect(h.discovery.getRepository.mock.calls.map((call) => call[0])).toEqual(['acme/unlisted']);
    expect(rowOf('acme/unlisted').notOnGitHub).toBe(true);
    // Listed per the account rules, without a lookup and without the label.
    expect(rowOf('octo/outside').notOnGitHub).toBe(false);
    expect(rowOf('octo/outside').environment?.id).toBe(GONE);
  });
});

describe('Sidebar progressive display (concept 7.4)', () => {
  const part = (repositories: RepositoryInfo[], accountId = OCTO.id) => ({ accountId, data: { ...data(repositories), scope: [] } });

  it('shows the repositories as they arrive during the first load, then the complete list', async () => {
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));

    h.sidebar.onPartialResult(part([info('acme/api')]));
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
    expect(h.sidebar.repositoryInfo('acme/api')?.nameWithOwner).toBe('acme/api');
    h.sidebar.onPartialResult(part([info('acme/api'), info('acme/web')]));
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api', 'acme/web']);
    // The trust of an owner still waits for the complete list.
    expect(h.sidebar.discoveryData).toBeUndefined();

    finish(data([info('acme/api'), info('acme/web'), info('acme/zeta')]));
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api', 'acme/web', 'acme/zeta']);
  });

  it('replaces a shown list only when the refresh is complete', async () => {
    h.discovery.loadStored.mockResolvedValue(data([info('acme/old')]));
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.sidebar.onPartialResult(part([info('acme/api')]));
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/old']);
    finish(data([info('acme/api')]));
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['acme/api']);
  });

  it('never shows the part of the first load of one account to another account (concept section 9)', async () => {
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>(() => undefined));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.sidebar.onPartialResult(part([info('octo/private-a')]));
    await h.sidebar.render();
    expect(rows().map((row) => row.repository)).toEqual(['octo/private-a']);
    // Another account signs in while the first load of OCTO still runs; it has no stored list.
    h.auth.getAccount.mockResolvedValue(OTHER);
    // The refresh of OTHER waits behind the running one; the view changes at once.
    void h.sidebar.onSessionChanged();
    await vi.waitFor(() => expect(h.sidebar.currentAccount?.id).toBe(OTHER.id));
    await h.sidebar.render();
    expect(rows()).toEqual([]);
    expect(h.sidebar.repositoryInfo('octo/private-a')).toBeUndefined();
  });

  it('stops showing the part of the first load when the scope changes', async () => {
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>(() => undefined));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.sidebar.onPartialResult(part([info('octo/private-a'), info('acme/api')]));
    h.settings.owners = ['acme'];
    void h.sidebar.onScopeChanged();
    await h.sidebar.render();
    expect(rows()).toEqual([]);
    expect(h.sidebar.repositoryInfo('octo/private-a')).toBeUndefined();
    expect(h.sidebar.repositoryInfo('acme/api')).toBeUndefined();
  });

  it('ignores a part of another account, of another scope, and after the refresh', async () => {
    let finish: (value: DiscoveryData) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((resolve) => (finish = resolve)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.sidebar.onPartialResult(part([info('staussh/secret')], OTHER.id));
    h.sidebar.onPartialResult({ accountId: OCTO.id, data: { ...data([info('acme/api')]), scope: ['acme'] } });
    await h.sidebar.render();
    expect(rows()).toEqual([]);

    finish(data([]));
    await h.sidebar.refreshDiscovery();
    h.sidebar.onPartialResult(part([info('acme/late')]));
    await h.sidebar.render();
    expect(rows()).toEqual([]);
  });

  it('groups the rows with the setting repositoryGroups, and warns once per session about each invalid entry', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop'), info('acme/api')]));
    h.settings.repositoryGroups = ['(', { pattern: '^(web)-(.+)$', flags: 'g' }];
    await signedIn();
    await h.sidebar.render();
    const [group] = h.models[h.models.length - 1];
    expect(group.children.map((child) => [child.kind, child.label])).toEqual([['group', 'web']]);
    expect(rows().map((row) => [row.repository, row.label])).toEqual([['acme/web-shop', 'shop']]);

    const warnings = fakeVscode.window.showWarningMessage.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('The repository group "(" in the setting devEnvLauncher.repositoryGroups is ignored');
    expect(warnings[1]).toContain('uses the flags "g", which are ignored');
    for (const warning of warnings) expect(h.logger.warn).toHaveBeenCalledWith(warning);

    // Each render compiles the patterns again, but a problem is shown only once.
    await h.sidebar.render();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    // Another invalid entry is a new problem.
    h.settings.repositoryGroups = ['(', '['];
    await h.sidebar.render();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(3);
    // Without valid entries, the view lists the repositories as without the setting.
    expect(rows().map((row) => row.label)).toEqual(['api', 'web-shop']);
  });

  it('gives the input of its last render, so the preview of the groups editor equals the view (unit 16)', async () => {
    const example = String.raw`^(\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$`;
    h.discovery.refresh.mockResolvedValue(
      data([
        info('school/2026-3cWI-SWP-module-oop-EnesHA81'),
        info('school/2026-3cWI-SWP-module-oop-felix-he021'),
        info('school/2025-3bWI-SWP-module-oop-hailo'),
        info('school/website'),
      ]),
    );
    expect(h.sidebar.groupingInput()).toBeUndefined();
    const rendered = vi.fn();
    h.sidebar.onDidRender(rendered);
    h.settings.repositoryGroups = [example];
    await signedIn();
    await h.sidebar.render();
    expect(rendered).toHaveBeenCalled();
    const input = h.sidebar.groupingInput();
    expect(input?.repositoryGroups).toBeUndefined();
    const shown = h.models[h.models.length - 1];
    // The view is buildTreeModel of that input with the patterns of the setting.
    expect(buildTreeModel({ ...input!, repositoryGroups: parseRepositoryGroups(h.settings.repositoryGroups).patterns })).toEqual(shown);
    // The preview of the editor for the same setting shows the same tree and hides what the view hides.
    const preview = buildGroupsPreview(input, entriesFromSetting(h.settings.repositoryGroups).entries);
    const labels = (nodes: ReadonlyArray<{ label: string; children?: unknown }>): unknown[] =>
      nodes.map((node) => (Array.isArray(node.children) ? [node.label, labels(node.children as never)] : node.label));
    expect(preview.owners.map((owner) => [owner.owner, labels(owner.tree)])).toEqual(shown.map((group) => [group.owner, labels(group.children as never)]));
    expect(preview.owners[0].hidden).toEqual(['website']);
  });

  // Review round 2 of PR #21, W1: an entry that throws while it is matched does not break the view, and is logged once.
  it('renders when an entry of repositoryGroups throws while it is matched, and logs that once', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop'), info('acme/aaaa')]));
    h.settings.repositoryGroups = ['(?:(?:a?){10000}){3000}', '^(web)-(.+)$'];
    await signedIn();
    // The stack overflow of that pattern, without the time it takes.
    const original = RegExp.prototype.exec;
    const exec = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, text: string) {
      if (this.source.startsWith('(?:(?:a?)')) throw new RangeError('Maximum call stack size exceeded');
      return original.call(this, text);
    });
    try {
      await h.sidebar.render();
      await h.sidebar.render();
    } finally {
      exec.mockRestore();
    }
    expect(rows().map((row) => [row.repository, row.label])).toEqual([['acme/web-shop', 'shop']]);
    const failed = h.logger.warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('failed while it was matched'));
    expect(failed).toHaveLength(1);
    expect(String(failed[0][0])).toContain('Maximum call stack size exceeded');
  });

  it('names the setting repositoryGroups once when grouping is slow, and never without patterns', async () => {
    h.discovery.refresh.mockResolvedValue(data([info('acme/web-shop')]));
    await signedIn();
    let now = 0;
    const clockNow = vi.spyOn(h.clock, 'now').mockImplementation(() => (now += SLOW_GROUPING_MS));
    const slow = () =>
      fakeVscode.window.showWarningMessage.mock.calls.filter((call: unknown[]) => String(call[0]).includes('took'));
    // Without patterns, a slow render is not about the setting.
    await h.sidebar.render();
    expect(slow()).toHaveLength(0);
    h.settings.repositoryGroups = ['^(web)-(.+)$'];
    await h.sidebar.render();
    expect(slow()).toHaveLength(1);
    expect(String(slow()[0][0])).toContain('devEnvLauncher.repositoryGroups');
    expect(h.logger.warn).toHaveBeenCalledWith(slow()[0][0]);
    await h.sidebar.render();
    expect(slow()).toHaveLength(1);
    clockNow.mockRestore();
  });

  it('shows no part of a first load that failed', async () => {
    let fail: (error: Error) => void = () => undefined;
    h.discovery.refresh.mockImplementation(() => new Promise<DiscoveryData>((_resolve, reject) => (fail = reject)));
    await h.sidebar.initialize();
    await vi.waitFor(() => expect(h.discovery.refresh).toHaveBeenCalledTimes(1));
    h.sidebar.onPartialResult(part([info('acme/api')]));
    await h.sidebar.render();
    expect(rows()).toHaveLength(1);
    fail(new Error('getaddrinfo ENOTFOUND api.github.com'));
    await h.sidebar.refreshDiscovery();
    await h.sidebar.render();
    expect(rows()).toEqual([]);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', LOAD_FAILED_CONTEXT_KEY, true);
  });
});
