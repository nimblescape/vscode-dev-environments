import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { StateTexts } from '../core/messages';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { DiscoveryData, Environment, ExtensionSettings, RepositoryInfo, WindowStatus } from '../core/types';
import { LOADED_CONTEXT_KEY, LOAD_FAILED_CONTEXT_KEY, Sidebar, type SidebarDeps } from './sidebar';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import { repositoryRows, type OwnerGroup, type RepositoryRow } from './treeModel';

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
};

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
  coordinator: { environmentId: string | null; otherActiveWindows: ReturnType<typeof vi.fn<() => Promise<WindowStatus[]>>> };
  service: { inspectStates: ReturnType<typeof vi.fn>; currentBranch: ReturnType<typeof vi.fn> };
  docker: { isInstalled: ReturnType<typeof vi.fn>; isRunning: ReturnType<typeof vi.fn> };
  discovery: { loadStored: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>; getRepository: ReturnType<typeof vi.fn> };
  auth: { getToken: ReturnType<typeof vi.fn>; isSignedIn: ReturnType<typeof vi.fn>; updateContextKey: ReturnType<typeof vi.fn> };
}

function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  const clock = { now: () => NOW };
  const paths = new StoragePaths(root);
  paths.ensureDirectoriesSync();
  const registry = new EnvironmentRegistry(paths, clock);
  const sessionFiles = new SessionFiles(paths, clock);
  const models: OwnerGroup[][] = [];
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
    isSignedIn: vi.fn(async () => true),
    updateContextKey: vi.fn(async () => true),
    renewToken: vi.fn(async () => undefined),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const sidebar = new Sidebar({
    logger,
    registry,
    sessionFiles,
    coordinator,
    service,
    docker,
    discovery,
    auth,
    tree,
    settings: () => SETTINGS,
    clock,
    isAlive: (pid: number) => pid === process.pid,
  } as unknown as SidebarDeps);
  return { root, registry, sessionFiles, sidebar, models, signedInFlags, coordinator, service, docker, discovery, auth };
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

function rowOf(repository: string): RepositoryRow {
  const found = rows().find((candidate) => candidate.repository === repository);
  if (!found) throw new Error(`No row for ${repository}: ${rows().map((candidate) => candidate.repository).join(', ')}`);
  return found;
}

describe('Sidebar', () => {
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
    h.service.inspectStates.mockResolvedValueOnce(new Map([[API, { container: 'running', volume: true }]]));
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').state).toBe('running');
    h.service.inspectStates.mockResolvedValueOnce(undefined);
    await h.sidebar.refreshStates();
    expect(rowOf('acme/api').state).toBe('stopped');
  });

  it('reads the branch of running containers when it refreshes the states', async () => {
    await h.registry.add(environment(API, 'acme/api', { gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) } }));
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
    await h.sidebar.render();
    expect(rowOf('acme/api').state).toBe('updating');
    expect(rowOf('acme/api').contextValue).not.toContain('canStop');
    expect(rowOf('acme/old').state).toBe('stopped');
  });

  it('adds the sign-in row only when the user is not signed in', async () => {
    await h.registry.add(environment(API, 'acme/api'));
    h.auth.updateContextKey.mockResolvedValue(false);
    await h.sidebar.initialize();
    expect(h.signedInFlags[h.signedInFlags.length - 1]).toBe(false);
    h.auth.isSignedIn.mockResolvedValue(true);
    await h.sidebar.onSessionChanged();
    await h.sidebar.render();
    expect(h.signedInFlags[h.signedInFlags.length - 1]).toBe(true);
  });

  it('trusts an owner only with a list of the current account', async () => {
    fakeVscode.authentication.getSession.mockResolvedValue({ account: { label: 'octo' } });
    h.discovery.loadStored.mockResolvedValue({ ...data([]), viewerLogin: 'someone-else' });
    await h.sidebar.initialize();
    h.discovery.refresh.mockResolvedValue(data([]));
    expect(await h.sidebar.trustedOwner('acme')).toBe(true);
    expect(await h.sidebar.trustedOwner('stranger')).toBe(false);
  });
});
