import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type { ContainerInfo } from '../core/docker/containerAdapter';
import { UserFacingError } from '../core/errors';
import { Actions, Messages } from '../core/messages';
import { CONTAINER_VERSION, GITHUB_TOKEN_FILE, LABEL_CONTAINER_VERSION } from '../core/names';
import type { OpenOptions, OpenResult, OperationOptions, RepositoryTarget } from '../core/pipeline/environmentService';
import { PipelineTexts } from '../core/pipeline/environmentService';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import { SessionFiles } from '../core/storage/sessionFiles';
import { EnvironmentClaims, availableEnvironments } from '../core/ownership';
import { silentLogger } from '../core/ports';
import type { Environment, ExtensionSettings, GitHubAccount, GitSummary, RepositoryInfo, WindowStatus } from '../core/types';
import { SIGNED_IN_CONTEXT_KEY } from './auth';
import { Commands } from './commands';
import { Controller, type ControllerDeps } from './controller';
import { ControllerTexts } from './controllerTexts';
import { DisconnectRequests } from './disconnectRequests';
import { DEFAULT_SETTINGS, SETTINGS_SECTION } from './settings';
import { LOADED_CONTEXT_KEY, LOAD_FAILED_CONTEXT_KEY } from './sidebar';
import { EventEmitter, fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const WINDOW_ID = 'window-1';
const OTHER_WINDOW_ID = 'window-2';
const OTHER_PID = 4242;
const ENV_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const CONTAINER = 'devenv-acme-api-3f2a9c1e';
/** The signed-in account; the environments of the tests belong to it unless a test names another owner. */
const ACCOUNT: GitHubAccount = { id: '1001', login: 'octo' };
const OTHER_ACCOUNT: GitHubAccount = { id: '2002', login: 'someone' };

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

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: ENV_ID,
    repository: 'acme/api',
    configPath: '.devcontainer/devcontainer.json',
    volumeName: CONTAINER,
    containerName: CONTAINER,
    createdAt: iso(NOW - 86_400_000),
    lastUsedAt: iso(NOW - 3_600_000),
    remoteWorkspaceFolder: '/workspaces/api',
    gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW - 3_600_000) },
    owner: ACCOUNT,
    ...overrides,
  };
}

function repositoryInfo(nameWithOwner: string, overrides: Partial<RepositoryInfo> = {}): RepositoryInfo {
  const [owner, name] = nameWithOwner.split('/');
  return {
    nameWithOwner,
    owner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: true,
    pushedAt: iso(NOW - 1000),
    defaultBranch: 'main',
    configPaths: ['.devcontainer/devcontainer.json'],
    ...overrides,
  };
}

/** The container of the environment as `docker.findContainer` gives it; `version` is its label devenv.container-version. */
function containerInfo(version: string | undefined): ContainerInfo {
  return {
    id: 'c0ffee',
    name: CONTAINER,
    state: 'running',
    rawState: 'running',
    image: 'devenv-acme-api:1',
    labels: version === undefined ? {} : { [LABEL_CONTAINER_VERSION]: version },
  };
}

function openResult(env: Environment): OpenResult {
  return { environment: env, containerName: env.containerName, remoteWorkspaceFolder: env.remoteWorkspaceFolder ?? '/workspaces/api' };
}

/** A row of the sidebar as the menus pass it. */
function row(repository: string, env?: Environment, info?: RepositoryInfo): unknown {
  return { kind: 'repository', id: `repo:${repository}`, repository, info, environment: env };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake of vscode.QuickPick for Switch branch…. */
class FakeQuickPick {
  items: Array<{ label: string; description?: string; branch: string }> = [];
  selectedItems: FakeQuickPick['items'] = [];
  activeItems: FakeQuickPick['items'] = [];
  value = '';
  title = '';
  placeholder = '';
  matchOnDescription = false;
  busy = false;
  shown = false;
  private readonly accept = new EventEmitter<void>();
  private readonly hideEmitter = new EventEmitter<void>();
  private readonly valueEmitter = new EventEmitter<string>();
  readonly onDidAccept = this.accept.event;
  readonly onDidHide = this.hideEmitter.event;
  readonly onDidChangeValue = this.valueEmitter.event;

  show(): void {
    this.shown = true;
  }

  hide(): void {
    this.hideEmitter.fire();
  }

  dispose(): void {}

  type(value: string): void {
    this.value = value;
    this.valueEmitter.fire(value);
  }

  pick(label: string): void {
    const item = this.items.find((candidate) => candidate.label === label);
    if (!item) throw new Error(`No item ${label}: ${this.items.map((candidate) => candidate.label).join(', ')}`);
    this.selectedItems = [item];
    this.accept.fire();
  }
}

/** Waits until the pending promise callbacks (file I/O included) have run. */
async function settle(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  root: string;
  paths: StoragePaths;
  registry: EnvironmentRegistry;
  sessionFiles: SessionFiles;
  disconnectRequests: DisconnectRequests;
  controller: Controller;
  commands: Map<string, (argument?: unknown) => Promise<void>>;
  docker: {
    isInstalled: ReturnType<typeof vi.fn>;
    isRunning: ReturnType<typeof vi.fn>;
    containerState: ReturnType<typeof vi.fn>;
    findContainer: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  };
  service: {
    open: ReturnType<typeof vi.fn<(target: RepositoryTarget, options: OpenOptions) => Promise<OpenResult>>>;
    openEnvironment: ReturnType<typeof vi.fn<(id: string, options: OpenOptions) => Promise<OpenResult>>>;
    stop: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
    safetyCheck: ReturnType<typeof vi.fn<(id: string, options: OperationOptions) => Promise<GitSummary | undefined>>>;
    delete: ReturnType<typeof vi.fn<(id: string, options: OperationOptions & { removeAdditionalVolumes: boolean }) => Promise<void>>>;
    switchBranch: ReturnType<typeof vi.fn<(id: string, branch: string, options: OperationOptions) => Promise<void>>>;
    configurationChanged: ReturnType<typeof vi.fn<(id: string, options: OperationOptions) => Promise<boolean>>>;
    listConfigurations: ReturnType<typeof vi.fn<(id: string, options: OperationOptions) => Promise<string[]>>>;
    currentBranch: ReturnType<typeof vi.fn<(id: string) => Promise<string | undefined>>>;
    reconcileFromVolumes: ReturnType<typeof vi.fn<() => Promise<number>>>;
  };
  connection: {
    open: ReturnType<typeof vi.fn<(containerName: string, folder: string) => Promise<void>>>;
    closeRemoteConnection: ReturnType<typeof vi.fn<() => Promise<void>>>;
    isEmptyWindow: ReturnType<typeof vi.fn<() => boolean>>;
    currentContainerName: ReturnType<typeof vi.fn<() => string | undefined>>;
  };
  coordinator: {
    windowId: string;
    writePending: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
    otherActiveWindows: ReturnType<typeof vi.fn<() => Promise<WindowStatus[]>>>;
    setEnvironment: ReturnType<typeof vi.fn>;
  };
  auth: {
    getToken: ReturnType<typeof vi.fn>;
    getAccount: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    isSignedIn: ReturnType<typeof vi.fn>;
    updateContextKey: ReturnType<typeof vi.fn>;
  };
  claims: { claim: ReturnType<typeof vi.fn> };
  ui: { configurationChanged: ReturnType<typeof vi.fn> };
  discovery: { listBranches: ReturnType<typeof vi.fn> };
  sidebar: {
    infos: Map<string, RepositoryInfo>;
    render: ReturnType<typeof vi.fn>;
    refreshStates: ReturnType<typeof vi.fn>;
    trustedOwner: ReturnType<typeof vi.fn>;
    onSessionChanged: ReturnType<typeof vi.fn>;
    refreshDiscovery: ReturnType<typeof vi.fn>;
  };
  statusBar: Record<'showConnected' | 'showNotConnected' | 'showBusy' | 'clearBusy' | 'showConnectionLost', ReturnType<typeof vi.fn>>;
  logger: Record<'info' | 'warn' | 'error' | 'output' | 'show', ReturnType<typeof vi.fn>>;
  quickPicks: FakeQuickPick[];
  progressTitles: string[];
  alive: Set<number>;
  settings: ExtensionSettings;
}

function createHarness(options: { handOffCheckMs?: number; leaveCheckMs?: number; disconnectAnswerMs?: number } = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  const clock = { now: () => NOW };
  const paths = new StoragePaths(root);
  paths.ensureDirectoriesSync();
  const registry = new EnvironmentRegistry(paths, clock);
  const sessionFiles = new SessionFiles(paths, clock);
  const disconnectRequests = new DisconnectRequests(root);
  const alive = new Set<number>([process.pid]);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn(), show: vi.fn() };
  const docker = {
    isInstalled: vi.fn(() => true),
    isRunning: vi.fn(async () => true),
    containerState: vi.fn(async (_name: string) => 'running'),
    // A container of the current setup (concept section 9), unless a test gives another label.
    findContainer: vi.fn(async (_id: string) => containerInfo(String(CONTAINER_VERSION))),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })),
  };
  const service: Harness['service'] = {
    open: vi.fn(async () => openResult(environment())),
    openEnvironment: vi.fn(async (id: string) => openResult((await registry.get(id)) ?? environment())),
    stop: vi.fn(async () => {}),
    safetyCheck: vi.fn(async () => undefined),
    delete: vi.fn(async () => {}),
    switchBranch: vi.fn(async () => {}),
    configurationChanged: vi.fn(async () => false),
    listConfigurations: vi.fn(async () => ['.devcontainer/devcontainer.json']),
    currentBranch: vi.fn(async () => undefined),
    reconcileFromVolumes: vi.fn(async () => 0),
  };
  const connection: Harness['connection'] = {
    open: vi.fn(async () => {}),
    closeRemoteConnection: vi.fn(async () => {}),
    isEmptyWindow: vi.fn(() => false),
    currentContainerName: vi.fn(() => undefined),
  };
  const coordinator: Harness['coordinator'] = {
    windowId: WINDOW_ID,
    writePending: vi.fn((id: string) => sessionFiles.writePending(id, WINDOW_ID)),
    otherActiveWindows: vi.fn(async () => []),
    setEnvironment: vi.fn(async () => {}),
  };
  const auth = {
    getToken: vi.fn(async () => 'gho_token'),
    getAccount: vi.fn(async (): Promise<GitHubAccount | undefined> => ACCOUNT),
    // One session: the token and the account that getToken and getAccount give, unless a test changes it.
    getSession: vi.fn(async (): Promise<{ token: string; account: GitHubAccount } | undefined> => {
      const [token, account] = [await auth.getToken(), await auth.getAccount()];
      return token && account ? { token, account } : undefined;
    }),
    isSignedIn: vi.fn(async () => true),
    updateContextKey: vi.fn(async () => true),
  };
  const claims = { claim: vi.fn(async (): Promise<string[]> => []) };
  const ui = { configurationChanged: vi.fn(async () => 'later') };
  const discovery = { listBranches: vi.fn(async () => ['main', 'feature-x']) };
  const infos = new Map<string, RepositoryInfo>();
  const sidebar = {
    infos,
    render: vi.fn(async () => {}),
    refreshStates: vi.fn(async () => {}),
    repositoryInfo: (repository: string) => infos.get(repository.toLowerCase()),
    liveBranch: () => undefined,
    repositoriesForPicker: vi.fn(async () => [...infos.values()]),
    availableEnvironments: vi.fn(async () => availableEnvironments(await registry.list(), await auth.getAccount())),
    model: () => [],
    trustedOwner: vi.fn(async () => true),
    refreshDiscovery: vi.fn(async () => undefined),
    onSessionChanged: vi.fn(async () => {}),
  };
  const statusBar = {
    showConnected: vi.fn(),
    showNotConnected: vi.fn(),
    showBusy: vi.fn(),
    clearBusy: vi.fn(),
    showConnectionLost: vi.fn(),
  };
  const settings = { ...SETTINGS };
  const deps = {
    logger,
    registry,
    registryNeedsRestore: () => registry.needsRestore(),
    sessionFiles,
    disconnectRequests,
    docker,
    service,
    discovery,
    auth,
    claims,
    ui,
    connection,
    coordinator,
    sidebar,
    statusBar,
    settings: () => settings,
    viewVisible: () => false,
    clock,
    isAlive: (pid: number) => alive.has(pid),
    timing: {
      handOffCheckMs: options.handOffCheckMs ?? 60_000,
      leaveCheckMs: options.leaveCheckMs ?? 60_000,
      reopenCheckDelayMs: 0,
      disconnectAnswerMs: options.disconnectAnswerMs ?? 60_000,
      busyPollMs: 5,
    },
  } as unknown as ControllerDeps;
  const controller = new Controller(deps);

  const commands = new Map<string, (argument?: unknown) => Promise<void>>();
  fakeVscode.commands.registerCommand.mockImplementation((id: string, handler: (argument?: unknown) => Promise<void>) => {
    commands.set(id, handler);
    return { dispose() {} };
  });
  controller.registerCommands();

  const progressTitles: string[] = [];
  fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
    task(
      { report: (value: { message?: string }) => progressTitles.push(value.message ?? '') },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    ),
  );
  const quickPicks: FakeQuickPick[] = [];
  fakeVscode.window.createQuickPick.mockImplementation(() => {
    const quickPick = new FakeQuickPick();
    quickPicks.push(quickPick);
    return quickPick;
  });

  return {
    root,
    paths,
    registry,
    sessionFiles,
    disconnectRequests,
    controller,
    commands,
    docker,
    service,
    connection,
    coordinator,
    auth,
    claims,
    ui,
    discovery,
    sidebar,
    statusBar,
    logger,
    quickPicks,
    progressTitles,
    alive,
    settings,
  };
}

let h: Harness;

beforeEach(() => {
  resetFakeVscode();
  h = createHarness();
});

afterEach(() => {
  h.controller.dispose();
  fs.rmSync(h.root, { recursive: true, force: true });
});

function run(command: keyof typeof Commands, argument?: unknown): Promise<void> {
  const handler = h.commands.get(Commands[command]);
  if (!handler) throw new Error(`Command ${command} is not registered`);
  return handler(argument);
}

/** Makes this window the window of `env` (role A after our own Start: the pipeline has just run). */
async function connectHere(env: Environment): Promise<void> {
  const reads = h.service.currentBranch.mock.calls.length;
  await h.controller.openAttachedWindow(env, env.containerName, { environmentId: env.id, windowId: WINDOW_ID, createdAt: iso(NOW - 5000) });
  // The window reads its connection state and branch in the background; wait for it, so tests start from a quiet state.
  await settle(() => h.service.currentBranch.mock.calls.length > reads, 'the branch of the window');
  h.service.openEnvironment.mockClear();
}

/** A live window 2 that holds a busy mark on `env`. */
async function otherWindowBusy(env: Environment): Promise<void> {
  h.alive.add(OTHER_PID);
  await h.sessionFiles.writeWindowStatus({
    windowId: OTHER_WINDOW_ID,
    pid: OTHER_PID,
    environmentId: null,
    state: 'active',
    updatedAt: iso(NOW - 5000),
  });
  await h.registry.updateEnvironment(env.id, (entry) => {
    entry.busy = { operation: 'update', since: iso(NOW - 60_000), pid: OTHER_PID, windowId: OTHER_WINDOW_ID };
  });
}

/** Window 2 is connected to `env` (its status file references it). */
function otherWindowConnected(environmentId = ENV_ID): void {
  h.coordinator.otherActiveWindows.mockResolvedValue([
    { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, environmentId, state: 'active', updatedAt: iso(NOW) },
  ]);
}

/** Lets the next progress notifications record their Cancel listener, so that a test can press Cancel. */
function cancellableProgress(): { cancel(): void } {
  const listeners: Array<() => void> = [];
  fakeVscode.window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
    task(
      { report: (value: { message?: string }) => h.progressTitles.push(value.message ?? '') },
      {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          listeners.push(listener);
          return { dispose() {} };
        },
      },
    ),
  );
  return {
    cancel: () => {
      for (const listener of listeners) listener();
    },
  };
}

function warningMessages(): string[] {
  return fakeVscode.window.showWarningMessage.mock.calls.map((call: unknown[]) => String(call[0]));
}

/** A new harness with other timings. */
function recreateHarness(options: Parameters<typeof createHarness>[0]): void {
  h.controller.dispose();
  fs.rmSync(h.root, { recursive: true, force: true });
  resetFakeVscode();
  h = createHarness(options);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Controller commands', () => {
  it('registers exactly the commands of package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }> };
    };
    const declared = manifest.contributes.commands.map((command) => command.command).sort();
    expect([...h.commands.keys()].sort()).toEqual(declared);
    expect(declared).toHaveLength(12);
  });

  it('uses the settings and the context keys of package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        configuration: { properties: Record<string, { default: unknown }> };
        viewsWelcome: Array<{ when: string }>;
      };
    };
    const defaults = Object.fromEntries(
      Object.entries(manifest.contributes.configuration.properties).map(([key, value]) => [
        key.replace(`${SETTINGS_SECTION}.`, ''),
        value.default,
      ]),
    );
    expect(defaults).toEqual({ ...DEFAULT_SETTINGS });
    const keys = new Set(manifest.contributes.viewsWelcome.flatMap((view) => view.when.match(/devEnvironments\.\w+/g) ?? []));
    // Exactly the keys that the extension sets.
    expect([...keys].sort()).toEqual([LOADED_CONTEXT_KEY, LOAD_FAILED_CONTEXT_KEY, SIGNED_IN_CONTEXT_KEY].sort());
  });

  it('shows "could not be loaded", not "no repository was found", after a failed first load (package.json)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { viewsWelcome: Array<{ contents: string; when: string }> };
    };
    // A small evaluator for the `when` clauses of the welcome views: `&&` of keys, each optionally negated.
    const shown = (context: Record<string, boolean>): string[] =>
      manifest.contributes.viewsWelcome
        .filter((view) =>
          view.when.split('&&').every((term) => {
            const text = term.trim();
            return text.startsWith('!') ? !context[text.slice(1)] : context[text] === true;
          }),
        )
        .map((view) => view.contents.split('\n')[0]);
    const signedIn = { [SIGNED_IN_CONTEXT_KEY]: true };
    expect(shown({ ...signedIn, [LOADED_CONTEXT_KEY]: true, [LOAD_FAILED_CONTEXT_KEY]: true })).toEqual([
      'The repository list could not be loaded. Check the internet connection and try again.',
    ]);
    expect(shown({ ...signedIn, [LOADED_CONTEXT_KEY]: true, [LOAD_FAILED_CONTEXT_KEY]: false })).toEqual([
      'No repository with a Dev Container configuration was found.',
    ]);
    expect(shown({ ...signedIn })).toEqual(['Loading your repositories…']);
    expect(shown({ [LOAD_FAILED_CONTEXT_KEY]: true })).toEqual([
      'Sign in with GitHub to see your repositories that have a Dev Container configuration.',
    ]);
  });

  it('shows the log', async () => {
    await run('showLog');
    expect(h.logger.show).toHaveBeenCalled();
  });
});

describe('Start', () => {
  it('creates the environment of a repository, then connects this window after the pending connection file', async () => {
    const info = repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] });
    h.sidebar.infos.set('acme/api', info);
    h.service.open.mockImplementation(async () => {
      const env = environment();
      await h.registry.add(env);
      return openResult(env);
    });

    await run('start', row('acme/api', undefined, info));

    expect(h.service.open).toHaveBeenCalledTimes(1);
    expect(h.service.open.mock.calls[0][0]).toEqual({
      repository: 'acme/api',
      defaultBranch: 'main',
      configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'],
      trusted: true,
    });
    expect(h.sidebar.trustedOwner).toHaveBeenCalledWith('acme');
    expect(h.coordinator.writePending).toHaveBeenCalledWith(ENV_ID);
    expect((await h.sessionFiles.readPendings()).map((pending) => pending.environmentId)).toEqual([ENV_ID]);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.progressTitles[0]).toContain(Messages.opening('acme/api'));
    expect(h.progressTitles.some((message) => message.includes('Connecting.'))).toBe(true);
  });

  it('opens an existing environment with the pipeline and connects this window (switch)', async () => {
    await h.registry.add(environment());
    await run('start', row('acme/api', environment()));
    expect(h.service.open).not.toHaveBeenCalled();
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ configPath: undefined }));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('only shows a message when this window is connected to the environment and its container runs', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await run('start', row('acme/api', env));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
  });

  it('reconnects when this window is connected but its container does not run (status bar Reconnect)', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.containerState.mockResolvedValue('stopped');
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('shows the other window instead of running the pipeline when another window is connected', async () => {
    const env = environment();
    await h.registry.add(env);
    h.coordinator.otherActiveWindows.mockResolvedValue([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, environmentId: ENV_ID, state: 'active', updatedAt: iso(NOW) },
    ]);
    await run('start', row('acme/api', env));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('starts the environment when the other window has lost its connection (the row shows Stopped)', async () => {
    const env = environment();
    await h.registry.add(env);
    otherWindowConnected();
    h.docker.containerState.mockResolvedValue('stopped');
    await run('start', row('acme/api', env));
    expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.coordinator.writePending).toHaveBeenCalledWith(ENV_ID);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('starts the environment when another window references it while Docker does not run', async () => {
    const env = environment();
    await h.registry.add(env);
    otherWindowConnected();
    h.docker.containerState.mockRejectedValue(new Error('Cannot connect to the Docker daemon'));
    await run('start', row('acme/api', env));
    expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('stays in this window when the user cancels after the pipeline finished its last step', async () => {
    const env = environment();
    await h.registry.add(env);
    const progress = cancellableProgress();
    h.service.openEnvironment.mockImplementation(async (id: string) => {
      // The pipeline wrote the pending connection file in its last step; then the user pressed Cancel.
      await h.sessionFiles.writePending(id, WINDOW_ID);
      progress.cancel();
      return openResult(env);
    });
    await run('start', row('acme/api', env));
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('runs one operation per environment at a time; a second Start is ignored', async () => {
    await h.registry.add(environment());
    const pipeline = deferred<OpenResult>();
    h.service.openEnvironment.mockReturnValueOnce(pipeline.promise);
    const first = run('start', row('acme/api', environment()));
    await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'the first pipeline');
    await run('start', row('acme/api', environment()));
    expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    pipeline.resolve(openResult(environment()));
    await first;
    expect(h.connection.open).toHaveBeenCalledTimes(1);
  });

  it('connects the environment that was selected last when two pipelines run in this window', async () => {
    const web = environment({
      id: 'b1c2d3e4-0000-4000-8000-000000000002',
      repository: 'acme/web',
      containerName: 'web',
      volumeName: 'web',
      remoteWorkspaceFolder: '/workspaces/web',
    });
    await h.registry.add(environment());
    await h.registry.add(web);
    const pipelines = new Map([
      [ENV_ID, deferred<OpenResult>()],
      [web.id, deferred<OpenResult>()],
    ]);
    h.service.openEnvironment.mockImplementation((id: string) => pipelines.get(id)!.promise);
    // For example the automatic reopen of acme/api, then the user's Start of acme/web.
    const first = run('start', row('acme/api', environment()));
    await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'the first pipeline');
    const second = run('start', row('acme/web', web));
    await settle(() => h.service.openEnvironment.mock.calls.length === 2, 'the second pipeline');

    pipelines.get(ENV_ID)!.resolve(openResult(environment()));
    await first;
    expect(h.connection.open).not.toHaveBeenCalled();
    pipelines.get(web.id)!.resolve(openResult(web));
    await second;
    expect(h.connection.open).toHaveBeenCalledTimes(1);
    expect(h.connection.open).toHaveBeenCalledWith('web', '/workspaces/web');
  });

  it('still connects the first environment when the newer pipeline was cancelled', async () => {
    const web = environment({ id: 'b1c2d3e4-0000-4000-8000-000000000002', repository: 'acme/web', containerName: 'web', volumeName: 'web' });
    await h.registry.add(environment());
    await h.registry.add(web);
    const api = deferred<OpenResult>();
    h.service.openEnvironment.mockImplementation(async (id: string) => {
      if (id === ENV_ID) return api.promise;
      throw new UserFacingError('cancelled', PipelineTexts.cancelled);
    });
    const first = run('start', row('acme/api', environment()));
    await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'the first pipeline');
    await run('start', row('acme/web', web));
    api.resolve(openResult(environment()));
    await first;
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('shows a failed pipeline with Show details and Try again, and does not connect', async () => {
    await h.registry.add(environment());
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
    await run('start', row('acme/api', environment()));
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(Messages.buildFailed, Actions.showDetails, Actions.tryAgain);
  });

  it('shows nothing when the user cancels', async () => {
    await h.registry.add(environment());
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('cancelled', PipelineTexts.cancelled));
    await run('start', row('acme/api', environment()));
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('asks with a Quick Pick when the Command Palette gives no repository', async () => {
    h.sidebar.infos.set('acme/web', repositoryInfo('acme/web'));
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ repository: RepositoryInfo }>) => items[0]);
    await run('start');
    expect(h.service.open.mock.calls[0][0].repository).toBe('acme/web');
  });
});

describe('Stop', () => {
  it('closes the remote connection and leaves a stop operation when this window is connected', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await run('stop', row('acme/api', env));
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
    const operations = await h.sessionFiles.readOperations();
    expect(operations).toEqual([
      expect.objectContaining({ environmentId: ENV_ID, operation: 'stop', reason: 'manual', requestedBy: WINDOW_ID }),
    ]);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('stops an environment of no window at once, and keeps the reopen record (concept 7.10 #2, D-5 option a)', async () => {
    await h.registry.add(environment());
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 10_000) });
    await run('stop', row('acme/api', environment()));
    expect(h.service.stop).toHaveBeenCalledWith(ENV_ID);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readReopen()).toEqual({ environmentId: ENV_ID, closedAt: iso(NOW - 10_000) });
  });

  it('asks before it stops an environment that another window is connected to, and stops nothing on Cancel', async () => {
    await h.registry.add(environment());
    otherWindowConnected();
    await run('stop', row('acme/api', environment()));
    expect(warningMessages()).toEqual([ControllerTexts.otherWindowClosesConnection('acme/api')]);
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(await h.disconnectRequests.read(ENV_ID)).toBeUndefined();
  });

  it('asks the other window to close its connection first; the stop continues there (concept 6.2)', async () => {
    await h.registry.add(environment());
    otherWindowConnected();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.stop);
    await run('stop', row('acme/api', environment()));
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(await h.disconnectRequests.read(ENV_ID)).toEqual({
      environmentId: ENV_ID,
      operation: 'stop',
      reason: 'manual',
      requestedAt: iso(NOW),
      requestedBy: WINDOW_ID,
    });
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.otherWindowContinues('acme/api'));
  });

  it('removes a request that the other window does not answer, and says that nothing was changed', async () => {
    h.controller.dispose();
    fs.rmSync(h.root, { recursive: true, force: true });
    resetFakeVscode();
    h = createHarness({ disconnectAnswerMs: 20 });
    await h.registry.add(environment());
    otherWindowConnected();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(ControllerTexts.stop);
    await run('stop', row('acme/api', environment()));
    expect(await h.disconnectRequests.read(ENV_ID)).toBeDefined();
    await settle(() => warningMessages().includes(ControllerTexts.otherWindowNoAnswer('acme/api')), 'the message');
    expect(await h.disconnectRequests.read(ENV_ID)).toBeUndefined();
    expect(h.service.stop).not.toHaveBeenCalled();
  });

  it('says that a repository without environment has nothing to stop', async () => {
    await run('stop', row('acme/web'));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.noEnvironment('acme/web'));
  });
});

describe('Delete', () => {
  it('names the unsaved changes, and deletes after Delete anyway while keeping the additional volumes on Keep', async () => {
    await h.registry.add(environment({ additionalVolumes: ['api-db'] }));
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 2, unpushedCommits: 3, stashes: 0, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.deleteAnyway).mockResolvedValueOnce(Actions.keep);
    await run('delete', row('acme/api', environment()));
    const calls = fakeVscode.window.showWarningMessage.mock.calls;
    expect(calls[0]).toEqual([
      Messages.deleteUnsaved('acme/api', '2 uncommitted · 3 unpushed'),
      { modal: true },
      Actions.openEnvironment,
      Actions.deleteAnyway,
    ]);
    expect(calls[1]).toEqual([Messages.deleteAdditionalVolumes('api-db'), { modal: true }, Actions.remove, Actions.keep]);
    expect(h.service.delete).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ removeAdditionalVolumes: false }));
  });

  it('opens the environment instead when the user selects Open environment', async () => {
    await h.registry.add(environment());
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 1, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.openEnvironment);
    await run('delete', row('acme/api', environment()));
    expect(h.service.delete).not.toHaveBeenCalled();
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.connection.open).toHaveBeenCalled();
  });

  it('asks for the plain confirmation when there are no changes or the volume is missing, and stops on Cancel', async () => {
    await h.registry.add(environment());
    await run('delete', row('acme/api', environment()));
    expect(warningMessages()).toEqual([Messages.deleteConfirm('acme/api')]);
    expect(h.service.delete).not.toHaveBeenCalled();
  });

  it('asks the connected other window to close its connection first; the delete continues there (concept 7.14)', async () => {
    await h.registry.add(environment({ additionalVolumes: ['api-db'] }));
    otherWindowConnected();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete).mockResolvedValueOnce(Actions.remove);
    await run('delete', row('acme/api', environment()));
    expect(warningMessages()[0]).toBe(
      `${Messages.deleteConfirm('acme/api')} ${ControllerTexts.otherWindowClosesConnection('acme/api')}`,
    );
    expect(h.service.delete).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(await h.disconnectRequests.read(ENV_ID)).toEqual(
      expect.objectContaining({ operation: 'delete', reason: 'manual', removeAdditionalVolumes: true, requestedBy: WINDOW_ID }),
    );
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.otherWindowContinues('acme/api'));
  });

  it('waits for the update of another window, then deletes (concept 7.15: Delete in every state)', async () => {
    const env = environment();
    await h.registry.add(env);
    await otherWindowBusy(env);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    const command = run('delete', row('acme/api', env));
    await settle(() => h.progressTitles.some((title) => title.includes(ControllerTexts.waitingForOtherWindow('acme/api'))), 'the wait');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.service.delete).not.toHaveBeenCalled();
    // The other window finishes its update.
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      delete entry.busy;
    });
    await command;
    expect(h.service.delete).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ removeAdditionalVolumes: false }));
  });

  it('does not wait and deletes nothing when the user cancels the wait', async () => {
    const env = environment();
    await h.registry.add(env);
    await otherWindowBusy(env);
    const progress = cancellableProgress();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    const command = run('delete', row('acme/api', env));
    await settle(() => h.progressTitles.some((title) => title.includes(ControllerTexts.waitingForOtherWindow('acme/api'))), 'the wait');
    progress.cancel();
    await command;
    expect(h.service.delete).not.toHaveBeenCalled();
    expect((await h.registry.get(ENV_ID))?.busy?.windowId).toBe(OTHER_WINDOW_ID);
  });

  it('says that another window deletes the environment already', async () => {
    const env = environment();
    await h.registry.add(env);
    await otherWindowBusy(env);
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      entry.busy = { operation: 'delete', since: iso(NOW - 1000), pid: OTHER_PID, windowId: OTHER_WINDOW_ID };
    });
    await run('delete', row('acme/api', env));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyDeleting('acme/api'));
    expect(h.service.safetyCheck).not.toHaveBeenCalled();
    expect(h.service.delete).not.toHaveBeenCalled();
  });

  it('hands the delete of the connected environment to the reloaded window', async () => {
    const env = environment({ additionalVolumes: ['api-db'] });
    await h.registry.add(env);
    await connectHere(env);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete).mockResolvedValueOnce(Actions.remove);
    await run('delete', row('acme/api', env));
    expect(h.service.delete).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([
      expect.objectContaining({ environmentId: ENV_ID, operation: 'delete', removeAdditionalVolumes: true }),
    ]);
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(
      expect.objectContaining({ operation: 'delete', windowId: WINDOW_ID, pid: process.pid }),
    );
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
  });
});

describe('Rebuild', () => {
  it('marks the connected environment as busy, leaves a rebuild operation, and closes the remote connection', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await run('rebuild', row('acme/api', env));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([
      expect.objectContaining({ environmentId: ENV_ID, operation: 'rebuild', reason: 'manual' }),
    ]);
    expect((await h.registry.get(ENV_ID))?.busy?.operation).toBe('rebuild');
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
  });

  it('asks the connected other window to close its connection; it rebuilds and connects again (concept 7.14)', async () => {
    await h.registry.add(environment());
    otherWindowConnected();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.rebuildNow);
    await run('rebuild', row('acme/api', environment()));
    expect(warningMessages()).toEqual([ControllerTexts.otherWindowClosesConnection('acme/api')]);
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(await h.disconnectRequests.read(ENV_ID)).toEqual(
      expect.objectContaining({ operation: 'rebuild', reason: 'manual', requestedBy: WINDOW_ID }),
    );
  });

  it('passes the selected configuration to the other window', async () => {
    await h.registry.add(environment());
    otherWindowConnected();
    h.service.listConfigurations.mockResolvedValue(['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json']);
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: unknown[]) => items[1]);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.rebuildNow);
    await run('selectConfiguration', row('acme/api', environment()));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(await h.disconnectRequests.read(ENV_ID)).toEqual(
      expect.objectContaining({
        operation: 'rebuild',
        reason: 'configurationSelected',
        configPath: '.devcontainer/python/devcontainer.json',
      }),
    );
  });

  it('rebuilds an environment of no window without connecting this window', async () => {
    await h.registry.add(environment());
    await run('rebuild', row('acme/api', environment()));
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ forceRebuild: true }));
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('refuses to hand off while another live window changes the environment', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await otherWindowBusy(env);
    await run('rebuild', row('acme/api', env));
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(
      PipelineTexts.environmentBusy('acme/api'),
      Actions.showDetails,
    );
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([]);
    expect((await h.registry.get(ENV_ID))?.busy?.windowId).toBe(OTHER_WINDOW_ID);
  });

  it('takes over a mark of a window that does not run anymore', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await otherWindowBusy(env);
    h.alive.delete(OTHER_PID);
    await run('rebuild', row('acme/api', env));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
    expect((await h.registry.get(ENV_ID))?.busy?.windowId).toBe(WINDOW_ID);
  });

  it('cancels the hand-off when the window keeps its connection', async () => {
    h.controller.dispose();
    fs.rmSync(h.root, { recursive: true, force: true });
    resetFakeVscode();
    h = createHarness({ handOffCheckMs: 20 });
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await run('rebuild', row('acme/api', env));
    expect(await h.sessionFiles.readOperations()).toHaveLength(1);
    await settle(() => h.logger.info.mock.calls.some((call) => String(call[0]).includes('pending operation is cancelled')), 'the cancel');
    await settle(() => fs.readdirSync(h.paths.operationsDir).length === 0, 'the removal');
    await settle(() => h.sidebar.render.mock.calls.length > 0, 'the render');
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });
});

describe('Select configuration…', () => {
  it('rebuilds an environment of no window with the selected configuration', async () => {
    await h.registry.add(environment());
    h.service.listConfigurations.mockResolvedValue(['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json']);
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ label: string; description: string }>) => {
      expect(items.map((item) => [item.label, item.description])).toEqual([
        ['default', '.devcontainer/devcontainer.json · current'],
        ['python', '.devcontainer/python/devcontainer.json'],
      ]);
      return items[1];
    });
    await run('selectConfiguration', row('acme/api', environment()));
    expect(h.service.openEnvironment).toHaveBeenCalledWith(
      ENV_ID,
      expect.objectContaining({ configPath: '.devcontainer/python/devcontainer.json', forceRebuild: true }),
    );
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('hands off a rebuild with the configuration when this window is connected', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.listConfigurations.mockResolvedValue(['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json']);
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: unknown[]) => items[1]);
    await run('selectConfiguration', row('acme/api', env));
    expect(await h.sessionFiles.readOperations()).toEqual([
      expect.objectContaining({
        operation: 'rebuild',
        reason: 'configurationSelected',
        configPath: '.devcontainer/python/devcontainer.json',
      }),
    ]);
  });

  it('creates the environment with the selected configuration when the repository has none', async () => {
    const info = repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/go/devcontainer.json'] });
    h.sidebar.infos.set('acme/api', info);
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: unknown[]) => items[1]);
    await run('selectConfiguration', row('acme/api', undefined, info));
    expect(h.service.listConfigurations).not.toHaveBeenCalled();
    expect(h.service.open).toHaveBeenCalledWith(
      expect.objectContaining({ repository: 'acme/api' }),
      expect.objectContaining({ configPath: '.devcontainer/go/devcontainer.json' }),
    );
  });
});

describe('Switch branch…', () => {
  it('switches the branch of the connected environment and offers the rebuild when the configuration changed', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.configurationChanged.mockResolvedValue(true);
    h.ui.configurationChanged.mockResolvedValue('rebuildNow');
    const command = run('switchBranch', row('acme/api', env));
    await settle(() => h.quickPicks.length === 1 && h.quickPicks[0].items.length === 2, 'the branch list');
    expect(h.quickPicks[0].items.map((item) => [item.label, item.description])).toEqual([
      ['main', 'current'],
      ['feature-x', ''],
    ]);
    h.quickPicks[0].pick('feature-x');
    await command;
    expect(h.service.switchBranch).toHaveBeenCalledWith(ENV_ID, 'feature-x', expect.anything());
    expect(h.ui.configurationChanged).toHaveBeenCalledWith('acme/api');
    expect(await h.sessionFiles.readOperations()).toEqual([
      expect.objectContaining({ operation: 'rebuild', reason: 'configChanged' }),
    ]);
    expect(h.connection.closeRemoteConnection).toHaveBeenCalled();
    expect(h.statusBar.showConnected).toHaveBeenLastCalledWith('acme/api', 'feature-x');
  });

  it('creates the environment on a typed branch when the repository has none', async () => {
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    const command = run('switchBranch', row('acme/api'));
    await settle(() => h.quickPicks.length === 1 && h.quickPicks[0].items.length === 2, 'the branch list');
    h.quickPicks[0].type('release/2.0');
    h.quickPicks[0].pick('release/2.0');
    await command;
    expect(h.service.open).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ branch: 'release/2.0' }));
  });

  it('switches and connects an environment that this window is not connected to', async () => {
    await h.registry.add(environment());
    const command = run('switchBranch', row('acme/api', environment()));
    await settle(() => h.quickPicks.length === 1 && h.quickPicks[0].items.length === 2, 'the branch list');
    h.quickPicks[0].pick('feature-x');
    await command;
    expect(h.service.switchBranch).toHaveBeenCalled();
    expect(h.service.configurationChanged).not.toHaveBeenCalled();
    expect(h.service.openEnvironment).toHaveBeenCalled();
    expect(h.connection.open).toHaveBeenCalled();
  });

  it('shows the message of Git when the switch fails', async () => {
    await h.registry.add(environment());
    const message = Messages.gitSwitchFailed('feature-x', 'error: Your local changes would be overwritten.');
    h.service.switchBranch.mockRejectedValue(new UserFacingError('gitSwitchFailed', message));
    const command = run('switchBranch', row('acme/api', environment()));
    await settle(() => h.quickPicks.length === 1 && h.quickPicks[0].items.length === 2, 'the branch list');
    h.quickPicks[0].pick('feature-x');
    await command;
    expect(warningMessages()).toContain(message);
    expect(h.connection.open).not.toHaveBeenCalled();
  });
});

describe('Show on GitHub', () => {
  it('opens the page of the repository', async () => {
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    await run('showOnGitHub', row('acme/api'));
    expect(fakeVscode.env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ toString: expect.any(Function) }));
    expect(String(fakeVscode.env.openExternal.mock.calls[0][0])).toBe('https://github.com/acme/api');
  });
});

describe('Sign in and Refresh', () => {
  it('signs in, updates the context key, and loads the list', async () => {
    await run('signIn');
    expect(h.auth.getToken).toHaveBeenCalledWith({ interactive: true });
    expect(h.auth.updateContextKey).toHaveBeenCalled();
    expect(h.sidebar.onSessionChanged).toHaveBeenCalledWith({ again: false });
  });

  it('refreshes the list, restores a lost registry while Docker runs, and reads the states', async () => {
    await run('refresh');
    expect(h.sidebar.refreshDiscovery).toHaveBeenCalledWith({ again: true });
    expect(h.service.reconcileFromVolumes).toHaveBeenCalled();
    expect(h.sidebar.refreshStates).toHaveBeenCalled();
  });

  it('restores the environments from the volumes when registry.json exists but cannot be read as a registry', async () => {
    fs.writeFileSync(h.paths.registry, '{ "version": 1, "environments": [ { "id": ');
    await run('refresh');
    expect(h.service.reconcileFromVolumes).toHaveBeenCalledTimes(1);
  });

  it('does not restore from the volumes while registry.json is valid', async () => {
    await h.registry.add(environment());
    await run('refresh');
    expect(h.service.reconcileFromVolumes).not.toHaveBeenCalled();
  });

  it('signs in on Refresh when the user is not signed in', async () => {
    h.auth.isSignedIn.mockResolvedValue(false);
    await run('refresh');
    expect(h.auth.getToken).toHaveBeenCalledWith({ interactive: true });
    expect(h.sidebar.refreshDiscovery).not.toHaveBeenCalled();
  });
});

describe('Window roles', () => {
  it('role A: runs the open pipeline before the restored window connects', async () => {
    const env = environment();
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.not.objectContaining({ forceRebuild: true }));
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.statusBar.showConnected).toHaveBeenCalledWith('acme/api', 'main');
  });

  it('role A: does not run the pipeline again when it has just run for this window', async () => {
    const env = environment();
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, { environmentId: ENV_ID, windowId: 'old', createdAt: iso(NOW - 30_000) });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
  });

  it('role A: does not show Reconnect for a container that the running pipeline has not started yet', async () => {
    const env = environment();
    await h.registry.add(env);
    const pipeline = deferred<OpenResult>();
    h.service.openEnvironment.mockImplementationOnce(() => pipeline.promise);
    h.docker.containerState.mockResolvedValue('stopped');
    const opening = h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'the pipeline');
    // Heartbeats while the pipeline starts Docker and the container.
    h.controller.onHeartbeat();
    h.controller.onHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.docker.containerState).not.toHaveBeenCalled();

    h.docker.containerState.mockResolvedValue('running');
    pipeline.resolve(openResult(env));
    await opening;
    await settle(() => h.service.currentBranch.mock.calls.length > 0, 'the branch of the window');
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
    expect(h.statusBar.showConnected).toHaveBeenLastCalledWith('acme/api', 'main');
  });

  it('role A: shows Reconnect when the pipeline fails', async () => {
    const env = environment();
    await h.registry.add(env);
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('dockerStartFailed', Messages.dockerStartFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(Messages.dockerStartFailed, Actions.showDetails, Actions.tryAgain);
  });

  it('role A: leaves the environment and closes the connection when "Delete environment" removed it', async () => {
    const env = environment();
    await h.registry.add(env);
    h.service.openEnvironment.mockImplementationOnce(async () => {
      // Concept 7.12: the files are missing, and the user selected "Delete environment".
      await h.registry.remove(ENV_ID);
      throw new UserFacingError('cancelled', PipelineTexts.cancelled);
    });
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(h.coordinator.setEnvironment).toHaveBeenCalledWith(null);
    expect(h.statusBar.showNotConnected).toHaveBeenCalled();
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
    expect(h.service.currentBranch).not.toHaveBeenCalled();
  });

  it('role A: still shows Reconnect after a plain cancel', async () => {
    const env = environment();
    await h.registry.add(env);
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('cancelled', PipelineTexts.cancelled));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    expect(h.coordinator.setEnvironment).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  it('role A: keeps a container of the current version attached when the host access policy refuses the configuration', async () => {
    // The container passed the policy when it was made; the user can change the configuration in it.
    const env = environment();
    await h.registry.add(env);
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('hostAccess', Messages.hostAccess('privileged mode')));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  for (const [code, message] of [
    ['hostAccess', Messages.hostAccess('privileged mode')],
    ['cancelled', PipelineTexts.cancelled],
    ['helperFailed', Messages.helperFailed],
  ] as const) {
    it(`role A: closes the connection to a container of an older version that the failed pipeline did not make again (${code})`, async () => {
      // Concept section 9: that container uses the Git of the computer; the window must not attach to it.
      const env = environment();
      await h.registry.add(env);
      h.docker.findContainer.mockResolvedValue(containerInfo(code === 'cancelled' ? undefined : '1'));
      h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError(code, message));
      await h.controller.openAttachedWindow(env, CONTAINER, undefined);
      await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
      expect(h.docker.findContainer).toHaveBeenCalledWith(ENV_ID);
      expect(h.coordinator.setEnvironment).toHaveBeenCalledWith(null);
      expect(h.statusBar.showNotConnected).toHaveBeenCalled();
      expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
      expect(warningMessages()).toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
      expect(h.service.currentBranch).not.toHaveBeenCalled();
      // Start from the status bar does not say "already connected" to the old container.
      await run('start', { environmentId: ENV_ID });
      expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
    });
  }

  it('Start: leaves a running container of an older version instead of saying that the window is connected', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.findContainer.mockResolvedValue(containerInfo('1'));
    await run('start', row('acme/api', env));
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
    // The pipeline does not replace the container under this window; a Start from the empty window makes a new one.
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(h.coordinator.setEnvironment).toHaveBeenLastCalledWith(null);
    expect(warningMessages()).toEqual([ControllerTexts.outdatedContainerClosed('acme/api')]);
  });

  it('Reconnect: leaves the environment and closes the connection when "Delete environment" removed it', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.containerState.mockResolvedValue('stopped');
    h.service.openEnvironment.mockImplementationOnce(async () => {
      await h.registry.remove(ENV_ID);
      throw new UserFacingError('cancelled', PipelineTexts.cancelled);
    });
    await run('start', { environmentId: ENV_ID });
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(h.coordinator.setEnvironment).toHaveBeenCalledWith(null);
    expect(h.statusBar.showNotConnected).toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('role B: runs a pending stop and keeps the reopen record; a later start reopens the environment (D-5 a)', async () => {
    await h.registry.add(environment());
    h.connection.isEmptyWindow.mockReturnValue(true);
    // The window that closed its connection for the Stop wrote the reopen record in its deactivate().
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 5000) });
    await h.sessionFiles.writeOperation({
      environmentId: ENV_ID,
      operation: 'stop',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.stop).toHaveBeenCalledWith(ENV_ID);
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readReopen()).toEqual({ environmentId: ENV_ID, closedAt: iso(NOW - 5000) });

    // The next start of VS Code, later: the record is older than 30 seconds.
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 60_000) });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('role B: runs a pending rebuild, removes the operation, and connects the window again', async () => {
    await h.registry.add(environment());
    await h.sessionFiles.writeOperation({
      environmentId: ENV_ID,
      operation: 'rebuild',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'configurationSelected',
      configPath: '.devcontainer/python/devcontainer.json',
    });
    h.connection.isEmptyWindow.mockReturnValue(true);
    let operationsAtConnect: number | undefined;
    h.connection.open.mockImplementation(async () => {
      operationsAtConnect = fs.readdirSync(h.paths.operationsDir).length;
    });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openEnvironment).toHaveBeenCalledWith(
      ENV_ID,
      expect.objectContaining({ forceRebuild: true, configPath: '.devcontainer/python/devcontainer.json' }),
    );
    expect(operationsAtConnect).toBe(0);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('role B: runs a pending delete and a pending stop', async () => {
    await h.registry.add(environment());
    await h.registry.add(environment({ id: 'b1c2d3e4-0000-4000-8000-000000000002', repository: 'acme/web', containerName: 'web', volumeName: 'web' }));
    await h.sessionFiles.writeOperation({
      environmentId: ENV_ID,
      operation: 'delete',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'manual',
      removeAdditionalVolumes: true,
    });
    await h.sessionFiles.writeOperation({
      environmentId: 'b1c2d3e4-0000-4000-8000-000000000002',
      operation: 'stop',
      requestedAt: iso(NOW - 4000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.delete).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ removeAdditionalVolumes: true }));
    expect(h.service.stop).toHaveBeenCalledWith('b1c2d3e4-0000-4000-8000-000000000002');
    expect(fs.readdirSync(h.paths.operationsDir)).toEqual([]);
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('role B: drops a pending operation older than 10 minutes without running it', async () => {
    await h.registry.add(environment());
    await h.sessionFiles.writeOperation({
      environmentId: ENV_ID,
      operation: 'rebuild',
      requestedAt: iso(NOW - 11 * 60_000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([]);
  });

  it('role B: opens the last environment when the reopen rule allows it', async () => {
    await h.registry.add(environment());
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 60_000) });
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.progressTitles[0]).toContain(Messages.opening('acme/api'));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('role B: does not reopen after Close Remote Connection, with another window, or when the setting is off', async () => {
    await h.registry.add(environment());
    h.connection.isEmptyWindow.mockReturnValue(true);
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 10_000) });
    await h.controller.runEmptyWindowTasks();

    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 60_000) });
    h.coordinator.otherActiveWindows.mockResolvedValueOnce([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, environmentId: null, state: 'active', updatedAt: iso(NOW) },
    ]);
    await h.controller.runEmptyWindowTasks();

    h.settings.reopenLastOnStartup = false;
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
  });
});

describe('Connection of this window', () => {
  it('shows Reconnect when the container stops, and Connected when it runs again', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.containerState.mockResolvedValue('stopped');
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length === 1, 'Reconnect');
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);

    h.docker.containerState.mockResolvedValue('running');
    const connectedCalls = h.statusBar.showConnected.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnected.mock.calls.length > connectedCalls, 'Connected');
  });

  it('closes its connection for the request of another window, and leaves the operation to its empty window', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await h.disconnectRequests.write({
      environmentId: ENV_ID,
      operation: 'delete',
      requestedAt: iso(NOW - 2000),
      requestedBy: OTHER_WINDOW_ID,
      reason: 'manual',
      removeAdditionalVolumes: true,
    });
    h.controller.onHeartbeat();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(await h.sessionFiles.readOperations()).toEqual([
      expect.objectContaining({ environmentId: ENV_ID, operation: 'delete', requestedBy: WINDOW_ID, removeAdditionalVolumes: true }),
    ]);
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(expect.objectContaining({ operation: 'delete', windowId: WINDOW_ID }));
    expect(await h.disconnectRequests.read(ENV_ID)).toBeUndefined();
    expect(h.service.delete).not.toHaveBeenCalled();
  });

  it('hands off a requested rebuild with its configuration, and a requested stop without a busy mark', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await h.disconnectRequests.write({
      environmentId: ENV_ID,
      operation: 'rebuild',
      requestedAt: iso(NOW - 2000),
      requestedBy: OTHER_WINDOW_ID,
      reason: 'configurationSelected',
      configPath: '.devcontainer/python/devcontainer.json',
    });
    h.controller.onHeartbeat();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(await h.sessionFiles.readOperations()).toEqual([
      expect.objectContaining({
        operation: 'rebuild',
        reason: 'configurationSelected',
        configPath: '.devcontainer/python/devcontainer.json',
      }),
    ]);
    expect((await h.registry.get(ENV_ID))?.busy?.operation).toBe('rebuild');
  });

  it('answers a request at once through the watched folder', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    const watcher = h.controller.watchDisconnectRequests();
    try {
      await h.disconnectRequests.write({
        environmentId: ENV_ID,
        operation: 'stop',
        requestedAt: iso(NOW - 1000),
        requestedBy: OTHER_WINDOW_ID,
        reason: 'manual',
      });
      await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
      expect(await h.sessionFiles.readOperations()).toEqual([expect.objectContaining({ operation: 'stop' })]);
      expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
    } finally {
      watcher.dispose();
    }
  });

  it('drops a request that is too old, and ignores requests for other environments', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await h.disconnectRequests.write({
      environmentId: ENV_ID,
      operation: 'stop',
      requestedAt: iso(NOW - 5 * 60_000),
      requestedBy: OTHER_WINDOW_ID,
      reason: 'manual',
    });
    const other = 'b1c2d3e4-0000-4000-8000-000000000002';
    await h.disconnectRequests.write({
      environmentId: other,
      operation: 'stop',
      requestedAt: iso(NOW - 1000),
      requestedBy: OTHER_WINDOW_ID,
      reason: 'manual',
    });
    h.controller.onHeartbeat();
    await settle(() => fs.readdirSync(path.join(h.root, 'disconnect')).length === 1, 'the removal');
    expect(await h.disconnectRequests.read(other)).toBeDefined();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([]);
  });

  it('shows Updating while a pipeline runs, and the state below it afterwards', () => {
    h.controller.onBusyChanged({ busy: true, title: 'Opening acme/api…', repository: 'acme/api' });
    expect(h.statusBar.showBusy).toHaveBeenCalledWith('acme/api');
    h.controller.onBusyChanged({ busy: true, title: 'Stopping acme/web…' });
    h.controller.onBusyChanged({ busy: false });
    expect(h.statusBar.clearBusy).toHaveBeenCalledTimes(2);
  });

  it('checks once that Docker is installed when the view shows', () => {
    h.docker.isInstalled.mockReturnValue(false);
    h.controller.onViewVisible();
    h.controller.onViewVisible();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(Messages.dockerNotInstalled, Actions.openDownloadPage);
  });
});

describe('Accounts (concept 7.5)', () => {
  it('refuses Start, Stop, Delete, Rebuild, Switch branch, and Select configuration of an environment of another account', async () => {
    const env = environment({ owner: OTHER_ACCOUNT });
    await h.registry.add(env);
    for (const command of ['start', 'stop', 'delete', 'rebuild', 'switchBranch', 'selectConfiguration'] as const) {
      await run(command, row('acme/api', env));
    }
    // A stale row without the environment, and a repository row: the registry names the hidden environment.
    await run('start', row('acme/api'));
    // The status bar item Reconnect.
    await run('start', { environmentId: ENV_ID });
    expect(warningMessages()).toEqual(Array(8).fill(ControllerTexts.otherAccount('acme/api')));
    for (const call of Object.values(h.service)) expect(call).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.quickPicks).toEqual([]);
  });

  it('asks for a sign-in for an environment when nobody is signed in', async () => {
    await h.registry.add(environment());
    h.auth.getAccount.mockResolvedValue(undefined);
    await run('start', row('acme/api', environment()));
    expect(warningMessages()).toEqual([Messages.signInRequired]);
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
  });

  it('claims an environment of an older version when the account can access its repository, then starts it', async () => {
    await h.registry.add(environment({ owner: undefined }));
    h.claims.claim.mockImplementation(async (account: GitHubAccount, _token: string, options: { environmentIds: string[] }) => {
      await h.registry.updateEnvironment(ENV_ID, (entry) => {
        entry.owner = account;
      });
      return options.environmentIds;
    });
    await run('start', row('acme/api', environment({ owner: undefined })));
    expect(h.claims.claim).toHaveBeenCalledWith(ACCOUNT, 'gho_token', { mode: 'interactive', environmentIds: [ENV_ID] });
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
  });

  it.each<[string, boolean]>([
    ['Assign', true],
    ['Not now', false],
  ])(
    'asks before Start assigns an environment of an older version of a public repository, and claims it only after %s',
    async (_answer, assign) => {
      // A public repository of an organization: GitHub returns it to every account, so only the user can decide.
      await h.registry.add(environment({ owner: undefined }));
      const confirm = vi.fn(async () => assign);
      const claims = new EnvironmentClaims({
        registry: h.registry,
        getRepository: async (repository) => ({
          nameWithOwner: repository,
          owner: 'acme',
          name: 'api',
          url: `https://github.com/${repository}`,
          isArchived: false,
          isFork: false,
          isPrivate: false,
          viewerPermission: 'WRITE',
          pushedAt: null,
          defaultBranch: 'main',
          configPaths: [],
        }),
        confirm,
        logger: silentLogger,
      });
      h.claims.claim.mockImplementation((account: GitHubAccount, token: string, options: object) => claims.claim(account, token, options));
      await run('start', row('acme/api', environment({ owner: undefined })));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ id: ENV_ID }), ACCOUNT);
      expect((await h.registry.get(ENV_ID))?.owner).toEqual(assign ? ACCOUNT : undefined);
      if (assign) {
        expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
      } else {
        expect(h.service.openEnvironment).not.toHaveBeenCalled();
        expect(warningMessages()).toEqual([Messages.olderEnvironmentNotAssigned('acme/api')]);
      }
    },
  );

  it('keeps an environment of an older version hidden when the claim fails, without calling it one of another account', async () => {
    // For example without internet access: GitHub cannot confirm the access, and nobody owns the entry.
    await h.registry.add(environment({ owner: undefined }));
    await run('start', row('acme/api'));
    expect(warningMessages()).toEqual([Messages.olderEnvironmentNotAssigned('acme/api')]);
    expect(warningMessages()).not.toContain(ControllerTexts.otherAccount('acme/api'));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
  });

  it('lists only the environments of the account in the pickers', async () => {
    await h.registry.add(environment({ owner: OTHER_ACCOUNT }));
    await run('stop');
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.noEnvironments);
    expect(fakeVscode.window.showQuickPick).not.toHaveBeenCalled();
    await run('switchEnvironment');
    expect(fakeVscode.window.showInformationMessage).toHaveBeenLastCalledWith(ControllerTexts.noRepositories);
  });

  it('role A: a restored window of another account runs no pipeline and closes its connection', async () => {
    const env = environment({ owner: OTHER_ACCOUNT });
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.coordinator.setEnvironment).toHaveBeenCalledWith(null);
    expect(warningMessages()).toEqual([Messages.otherAccountConnection('acme/api')]);
    expect(h.statusBar.showNotConnected).toHaveBeenCalled();
  });

  it('role A: without a sign-in, the window closes its connection', async () => {
    const env = environment();
    await h.registry.add(env);
    h.auth.getAccount.mockResolvedValue(undefined);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(h.auth.getAccount).toHaveBeenCalledWith({ interactive: true });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([ControllerTexts.signedOutConnection('acme/api')]);
  });

  it('role A: claims the environment of an older version first, then runs the pipeline', async () => {
    const env = environment({ owner: undefined });
    await h.registry.add(env);
    h.claims.claim.mockImplementation(async (account: GitHubAccount) => {
      await h.registry.updateEnvironment(ENV_ID, (entry) => {
        entry.owner = account;
      });
      return [ENV_ID];
    });
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  it('closes the connection at once when the signed-in account changes to one that may not use the environment', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await h.controller.onSessionChanged();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();

    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(h.coordinator.setEnvironment).toHaveBeenLastCalledWith(null);
    expect(warningMessages()).toContain(Messages.otherAccountConnection('acme/api'));
    // The window has no environment anymore: the Session Monitor stops the container after the waiting time.
    await run('stop');
    expect(h.service.stop).not.toHaveBeenCalled();
  });

  it('role B: runs no pending operation of another account, and does not reopen its environment', async () => {
    await h.registry.add(environment({ owner: OTHER_ACCOUNT }));
    await h.sessionFiles.writeOperation({
      environmentId: ENV_ID,
      operation: 'delete',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.controller.runEmptyWindowTasks();
    expect(h.service.delete).not.toHaveBeenCalled();
    // The operation stays until it expires (10 minutes), like an operation that no window takes.
    expect(fs.readdirSync(h.paths.operationsDir)).toEqual([`${ENV_ID}.json`]);

    await h.sessionFiles.removeOperation(ENV_ID);
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 60_000) });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
  });

  it('closes the connection with a sign-in message when nobody is signed in anymore', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.auth.getAccount.mockResolvedValue(undefined);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(h.coordinator.setEnvironment).toHaveBeenLastCalledWith(null);
    expect(warningMessages()).toEqual([ControllerTexts.signedOutConnection('acme/api')]);
    expect(warningMessages()).not.toContain(Messages.otherAccountConnection('acme/api'));
  });

  it('takes the token of the owner out of the running container when the account changes, not on a hand-off', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await run('stop', row('acme/api', env));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(h.docker.exec).not.toHaveBeenCalled();

    recreateHarness({});
    await h.registry.add(env);
    await connectHere(env);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.docker.exec.mock.calls.length > 0, 'the removal of the token');
    expect(h.docker.exec).toHaveBeenCalledWith(CONTAINER, ['rm', '-f', GITHUB_TOKEN_FILE], expect.objectContaining({ user: 'root' }));
  });

  it('role A: takes the token out of a running container of another account, and asks nothing of a stopped one', async () => {
    const env = environment({ owner: OTHER_ACCOUNT });
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.docker.exec.mock.calls.length > 0, 'the removal of the token');
    expect(h.docker.exec).toHaveBeenCalledWith(CONTAINER, ['rm', '-f', GITHUB_TOKEN_FILE], expect.objectContaining({ user: 'root' }));

    recreateHarness({});
    await h.registry.add(env);
    h.docker.containerState.mockResolvedValue('stopped');
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    await pause(20);
    expect(h.docker.exec).not.toHaveBeenCalled();
  });

  it('closes the connection again when the window kept it after an account change (Cancel on unsaved files)', async () => {
    recreateHarness({ leaveCheckMs: 20 });
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    // This extension host still runs after the close: the window is still attached to the container.
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length >= 2, 'the second close');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(ControllerTexts.stillConnected('acme/api'), { modal: true });
    // The token is taken out again with each close.
    await settle(() => h.docker.exec.mock.calls.length >= 2, 'the second removal of the token');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('role A: closes the connection again when a restored window of another account kept it', async () => {
    recreateHarness({ leaveCheckMs: 20 });
    const env = environment({ owner: OTHER_ACCOUNT });
    await h.registry.add(env);
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length >= 2, 'the second close');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(ControllerTexts.stillConnected('acme/api'), { modal: true });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
  });

  it('does not close the connection again when the window has left the container, or after dispose', async () => {
    recreateHarness({ leaveCheckMs: 20 });
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    // currentContainerName gives no container: the window is not attached anymore.
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    await pause(80);
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(warningMessages()).not.toContain(ControllerTexts.stillConnected('acme/api'));

    recreateHarness({ leaveCheckMs: 20 });
    await h.registry.add(env);
    await connectHere(env);
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    h.controller.dispose();
    await pause(80);
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
  });

  it('reloads the window instead of closing it again when the owner account signs in again before the check', async () => {
    recreateHarness({ leaveCheckMs: 100 });
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    // The user kept the connection, then signed in with the owner account again.
    h.auth.getAccount.mockResolvedValue(ACCOUNT);
    await h.controller.onSessionChanged();
    // The reload runs the open pipeline of role A, which writes the token again.
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    await pause(150);
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(warningMessages()).not.toContain(ControllerTexts.stillConnected('acme/api'));
  });

  it('reloads the window at the check when the owner account is signed in again', async () => {
    recreateHarness({ leaveCheckMs: 100 });
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    h.auth.getAccount.mockResolvedValue(ACCOUNT);
    await settle(() => h.connection.open.mock.calls.length === 1, 'the reload');
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
  });

  it('does not connect when the account changed while the pipeline ran (concept 7.5)', async () => {
    const env = environment();
    await h.registry.add(env);
    const pipeline = deferred<OpenResult>();
    h.service.openEnvironment.mockImplementationOnce(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      return pipeline.promise;
    });
    const start = run('start', row('acme/api', env));
    await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'the pipeline');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    pipeline.resolve(openResult(env));
    await start;
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    // Without the pending connection file, the Session Monitor stops the container after the waiting time.
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(warningMessages()).toEqual([ControllerTexts.otherAccount('acme/api')]);
  });

  it('does not connect a first open when the account changed while the pipeline ran', async () => {
    const info = repositoryInfo('acme/api');
    h.sidebar.infos.set('acme/api', info);
    const pipeline = deferred<OpenResult>();
    h.service.open.mockImplementationOnce(async () => {
      await h.registry.add(environment());
      return pipeline.promise;
    });
    const start = run('start', row('acme/api', undefined, info));
    await settle(() => h.service.open.mock.calls.length === 1, 'the pipeline');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    pipeline.resolve(openResult(environment()));
    await start;
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([ControllerTexts.otherAccount('acme/api')]);
  });

  it('does not connect when nobody is signed in anymore at the end of the pipeline', async () => {
    const env = environment();
    await h.registry.add(env);
    const pipeline = deferred<OpenResult>();
    h.service.openEnvironment.mockReturnValueOnce(pipeline.promise);
    const start = run('start', row('acme/api', env));
    await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'the pipeline');
    h.auth.getAccount.mockResolvedValue(undefined);
    pipeline.resolve(openResult(env));
    await start;
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(Messages.signInRequired, Actions.signIn);
  });

  it('role B: does not connect after a pending rebuild when the account changed while it ran', async () => {
    await h.registry.add(environment());
    await h.sessionFiles.writeOperation({
      environmentId: ENV_ID,
      operation: 'rebuild',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    h.connection.isEmptyWindow.mockReturnValue(true);
    const pipeline = deferred<OpenResult>();
    h.service.openEnvironment.mockReturnValueOnce(pipeline.promise);
    const tasks = h.controller.runEmptyWindowTasks();
    await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'the pipeline');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    pipeline.resolve(openResult(environment()));
    await tasks;
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([ControllerTexts.otherAccount('acme/api')]);
  });

  it('claims nothing when the session changed between the read of the account and the claim', async () => {
    await h.registry.add(environment({ owner: undefined }));
    h.auth.getSession.mockResolvedValue({ token: 'gho_other', account: OTHER_ACCOUNT });
    await run('start', row('acme/api', environment({ owner: undefined })));
    expect(h.claims.claim).not.toHaveBeenCalled();
    expect((await h.registry.get(ENV_ID))?.owner).toBeUndefined();
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([Messages.olderEnvironmentNotAssigned('acme/api')]);
  });

  it('role A: claims nothing when the session changed, and closes the connection', async () => {
    const env = environment({ owner: undefined });
    await h.registry.add(env);
    h.auth.getSession.mockResolvedValue({ token: 'gho_other', account: OTHER_ACCOUNT });
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(h.claims.claim).not.toHaveBeenCalled();
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect((await h.registry.get(ENV_ID))?.owner).toBeUndefined();
  });

  it('role A: an environment of an older version that GitHub did not confirm closes with a message that says so', async () => {
    // For example a restored window before the network is up: nobody owns the entry yet.
    const env = environment({ owner: undefined });
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    // Before the connection of a restored window, no question: only an unambiguous claim.
    expect(h.claims.claim).toHaveBeenCalledWith(ACCOUNT, 'gho_token', { mode: 'auto', environmentIds: [ENV_ID] });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([ControllerTexts.ownerNotConfirmedConnection('acme/api')]);
  });
});
