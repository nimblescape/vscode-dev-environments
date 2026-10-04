// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteCheck as runDeleteCheck, type DeleteDecision } from '../core/pipeline/deleteCheck';
import { VsCodePipelineUi } from './pipelineUi';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type { ContainerInfo } from '../core/docker/containerAdapter';
import { containerIsCurrent, isUnrestrictedContainer } from '../core/pipeline/pipelineRules';
import { hostAccessChecks } from '../core/policy/hostAccessChecks';
import type { WindowStateValue } from '../core/helperChannel/protocol';
import { DockerContextKeys } from '../core/docker/dockerSetup';
import { UserFacingError } from '../core/errors';
import { Actions, Messages } from '../core/messages';
import { CONTAINER_VERSION, HOST_ACCESS_UNRESTRICTED, LABEL_CONTAINER_VERSION, LABEL_HOST_ACCESS } from '../core/names';
import { OP_TOKEN_REMOVE } from '../core/helperChannel/protocol';
import type { OpenOptions, OpenResult, OperationOptions, RepositoryTarget } from '../core/pipeline/environmentService';
import { PipelineTexts } from '../core/pipeline/environmentService';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import { SessionFiles } from '../core/storage/sessionFiles';
import { availableEnvironments } from '../core/ownership';
import { dockerTargetOf, ownContextDescription, remoteContextNames, type DockerTarget } from '../core/docker/dockerHost';
import { DockerTargets, operationDockerTarget, runWithDockerTarget } from '../core/docker/dockerTargets';
import { silentLogger } from '../core/ports';
import type { Environment, ExtensionSettings, GitHubAccount, GitSummary, RepositoryInfo, WindowStatus } from '../core/types';
import { SIGNED_IN_CONTEXT_KEY } from './auth';
import { Commands } from './commands';
import { CONNECTED_CONTEXT_KEY, Controller, type ControllerDeps } from './controller';
import { ControllerTexts } from './controllerTexts';
import { DisconnectRequests } from './disconnectRequests';
import { DOUBLE_CLICK_INTERVAL_MS, type ListOpenMode } from './rowActivation';
import { DEFAULT_SETTINGS, SETTINGS_SECTION } from './settings';
import { LOADED_CONTEXT_KEY, LOAD_FAILED_CONTEXT_KEY } from './sidebar';
import { contextValue as treeContextValue, rowActions } from './treeModel';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const WINDOW_ID = 'window-1';
const OTHER_WINDOW_ID = 'window-2';
const OTHER_PID = 4242;
const ENV_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const OTHER_ENV_ID = '7c1d2e3f-0000-4000-8000-000000000002';
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
  hostAccessChecksOff: [],
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

/**
 * The container of the environment as `docker.findContainer` gives it; `version` is its label
 * nimblescape.devenv.container-version.
 */
/**
 * Plan step 11B1: changed (before: the runs of TOKEN_REMOVE_SCRIPT through docker.exec): the token removal is a flow of
 * the worker, so the controller sends the operation `tokenRemove` (concept 7.5).
 */
function tokenRemovals(): number {
  return h.flow.mock.calls.filter((call) => call[0] === OP_TOKEN_REMOVE).length;
}

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

/** Waits until the pending promise callbacks (file I/O included) have run. */
async function settle(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  /** Plan step 11B1: the flows that the controller sends to the worker (the token removal). */
  flow: ReturnType<typeof vi.fn>;
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
    volumeExists: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    processEnv: ReturnType<typeof vi.fn>;
  };
  service: {
    open: ReturnType<typeof vi.fn<(target: RepositoryTarget, options: OpenOptions) => Promise<OpenResult>>>;
    openEnvironment: ReturnType<typeof vi.fn<(id: string, options: OpenOptions) => Promise<OpenResult>>>;
    stop: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
    safetyCheck: ReturnType<typeof vi.fn<(id: string, options: OperationOptions) => Promise<GitSummary | undefined>>>;
    /** Review round 11 (G3, G4). */
    repositoryServiceData: ReturnType<typeof vi.fn<(id: string) => Promise<string[]>>>;
    deleteInWorker: ReturnType<typeof vi.fn<(id: string, options: OperationOptions & { additionalVolumesToRemove: readonly string[] }) => Promise<void>>>;
    /** Plan step 11C2b: the check of Delete and its questions in the worker (the fake runs deleteCheck.ts, below). */
    deleteCheckInWorker: ReturnType<typeof vi.fn<(id: string, options: OperationOptions & { repository: string; otherWindow: boolean }) => Promise<DeleteDecision>>>;
    // Plan step 11B3b (user decision of 2026-10-04): the controller lists through the worker (listConfigurationsInWorker).
    listConfigurationsInWorker: ReturnType<typeof vi.fn<(id: string, options: OperationOptions) => Promise<string[]>>>;
    /** Plan step 11C1: the branch that the fake worker reads (windowStateInWorker with `branch`). */
    currentBranch: ReturnType<typeof vi.fn<(id: string) => Promise<string | undefined>>>;
    windowStateInWorker: ReturnType<typeof vi.fn<(environment: Environment, containerName: string, options?: { branch?: boolean; signal?: AbortSignal }) => Promise<WindowStateValue | undefined>>>;
    // Plan step 11C3: changed, the restore runs in the worker (reconcileInWorker).
    reconcileInWorker: ReturnType<typeof vi.fn<(options: { passive: boolean }) => Promise<number>>>;
    removableAdditionalVolumes: ReturnType<typeof vi.fn<(id: string) => Promise<string[]>>>;
    removableServiceDataVolumes: ReturnType<typeof vi.fn<(id: string) => Promise<string[]>>>;
    possibleServiceDataVolumes: ReturnType<typeof vi.fn<(id: string) => Promise<string[]>>>;
  };
  connection: {
    open: ReturnType<typeof vi.fn<(containerName: string, folder: string) => Promise<void>>>;
    openInNewWindow: ReturnType<typeof vi.fn<(containerName: string, folder: string) => Promise<void>>>;
    closeRemoteConnection: ReturnType<typeof vi.fn<() => Promise<void>>>;
    closeWindow: ReturnType<typeof vi.fn<() => Promise<void>>>;
    isEmptyWindow: ReturnType<typeof vi.fn<() => boolean>>;
    currentContainerName: ReturnType<typeof vi.fn<() => string | undefined>>;
    currentDockerContext: ReturnType<typeof vi.fn<() => string | undefined>>;
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
  dockerSetup: Record<'install' | 'start' | 'installWsl' | 'show', ReturnType<typeof vi.fn>>;
  repositoryGroupsEditor: { open: ReturnType<typeof vi.fn> };
  sidebar: {
    infos: Map<string, RepositoryInfo>;
    render: ReturnType<typeof vi.fn>;
    refreshStates: ReturnType<typeof vi.fn>;
    trustedOwner: ReturnType<typeof vi.fn>;
    onSessionChanged: ReturnType<typeof vi.fn>;
    refreshDiscovery: ReturnType<typeof vi.fn>;
  };
  statusBar: Record<'showConnected' | 'showNotConnected' | 'showBusy' | 'clearBusy' | 'showConnectionLost' | 'showStateUnknown', ReturnType<typeof vi.fn>>;
  logger: Record<'info' | 'warn' | 'error' | 'output' | 'show', ReturnType<typeof vi.fn>>;
  progressTitles: string[];
  alive: Set<number>;
  settings: ExtensionSettings;
  /** The clock of the controller, the registry and the session files; a test may replace `now`. */
  clock: { now: () => number };
  /** The VS Code setting workbench.list.openMode (double-click on a row); a test may change it. */
  listOpenMode: { value: ListOpenMode };
}

function createHarness(
  options: {
    handOffCheckMs?: number;
    leaveCheckMs?: number;
    disconnectAnswerMs?: number;
    /** Unit 7: the current Docker host and the remote Docker commands. Default: none (the local Docker). */
    dockerTargets?: ControllerDeps['dockerTargets'];
    remoteDocker?: ControllerDeps['remoteDocker'];
    /** Unit 7, PR 2: the heartbeat of Close and Keep Running (plan step 8, PR A: on every engine). */
    sessionMonitor?: ControllerDeps['sessionMonitor'];
    /** User decision 2026-09-28: the pause between the checks of the container (default 0). */
    readyPollMs?: number;
    /** Plan step 11B1 (review round 1, A-R1-9): a window that runs no flow in a worker. */
    noFlow?: boolean;
  } = {},
): Harness {
  const listOpenMode: Harness['listOpenMode'] = { value: 'singleClick' };
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
    volumeExists: vi.fn(async (_name: string) => true),
    // The Docker calls of the attach diagnostics (user request 2026-09-28): answered, never failing.
    run: vi.fn(async (_args: readonly string[]) => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })),
    processEnv: vi.fn(() => ({})),
  };
  const service: Harness['service'] = {
    open: vi.fn(async () => openResult(environment())),
    openEnvironment: vi.fn(async (id: string) => openResult((await registry.get(id)) ?? environment())),
    stop: vi.fn(async () => {}),
    safetyCheck: vi.fn(async () => undefined),
    repositoryServiceData: vi.fn(async () => []),
    // Plan step 11C2a: the controller sends Delete to the worker (deleteInWorker; before: delete). The expectations on it
    // in this file are renamed only, nothing else changed.
    deleteInWorker: vi.fn(async () => {}),
    listConfigurationsInWorker: vi.fn(async () => ['.devcontainer/devcontainer.json']),
    currentBranch: vi.fn(async () => undefined),
    // Plan step 11C1: the reads of the window as the worker answers them, over the Docker fakes of this harness; a read
    // that fails is unknown (undefined, decision of 2026-10-04).
    windowStateInWorker: vi.fn(async (env: Environment, containerName: string, options: { branch?: boolean } = {}) => {
      try {
        const state = (await docker.containerState(containerName)) as WindowStateValue['state'];
        const value: WindowStateValue = { state };
        const container = (await (docker.findContainer as (id: string, name: string) => Promise<unknown>)(env.id, env.containerName)) as ContainerInfo | undefined;
        const checks = hostAccessChecks(env.repository, settings);
        if (container !== undefined && !containerIsCurrent(container.labels, true, checks)) {
          value.outdated = containerIsCurrent(container.labels, true, 'off') && isUnrestrictedContainer(container.labels) ? 'hostAccess' : 'version';
        }
        if (options.branch) {
          const branch = await service.currentBranch(env.id);
          if (branch !== undefined) value.branch = branch;
        }
        return value;
      } catch {
        return undefined;
      }
    }),
    reconcileInWorker: vi.fn(async (_options: { passive: boolean }) => 0),
    // By default, Delete could remove every recorded volume (their labels make them the environment's own).
    removableAdditionalVolumes: vi.fn(async (id: string) => (await registry.get(id))?.additionalVolumes ?? []),
    // No volumes of a Docker Compose project, unless a test gives them (D-19).
    removableServiceDataVolumes: vi.fn(async () => []),
    // Plan step 11C2b: the check of Delete runs in the worker; this fake runs the same function there (deleteCheck.ts)
    // over the reads of this fake service and the questions of VsCodePipelineUi, so the tests of the dialogs of Delete
    // below stay as they were (before: the controller asked them itself).
    deleteCheckInWorker: vi.fn(async (id: string, options: OperationOptions & { repository: string; otherWindow: boolean }): Promise<DeleteDecision> => {
      const entry = await registry.get(id);
      if (!entry) return { decision: 'cancel' };
      return runDeleteCheck(
        {
          summary: () => service.safetyCheck(id, options),
          environment: () => registry.get(id),
          repositoryServiceData: () => service.repositoryServiceData(id),
          removableAdditionalVolumes: () => service.removableAdditionalVolumes(id),
          removableServiceDataVolumes: () => service.removableServiceDataVolumes(id),
          possibleServiceDataVolumes: () => service.possibleServiceDataVolumes(id),
          ui: new VsCodePipelineUi({} as never, silentLogger, () => {}),
        },
        entry,
        options.repository,
        options.otherWindow,
      );
    }),
    // Review round 3 (P3-4): none of an environment whose services are not known, unless a test gives them.
    possibleServiceDataVolumes: vi.fn(async () => []),
  };
  const connection: Harness['connection'] = {
    open: vi.fn(async () => {}),
    openInNewWindow: vi.fn(async () => {}),
    closeRemoteConnection: vi.fn(async () => {}),
    closeWindow: vi.fn(async () => {}),
    isEmptyWindow: vi.fn(() => false),
    currentContainerName: vi.fn(() => undefined),
    currentDockerContext: vi.fn(() => undefined),
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
  const dockerSetup = {
    install: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    installWsl: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
  };
  const repositoryGroupsEditor = { open: vi.fn(async () => {}) };
  const discovery = {};
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
    showStateUnknown: vi.fn(),
  };
  const settings = { ...SETTINGS };
  const flow = vi.fn(async (op: string, _params: unknown): Promise<unknown> => (op === OP_TOKEN_REMOVE ? { outcome: 'removed', container: 'c0ffeec0ffee' } : {}));
  const deps = {
    logger,
    registry,
    registryNeedsRestore: () => registry.needsRestore(),
    sessionFiles,
    disconnectRequests,
    docker,
    // Plan step 11B1: the flows that run in the worker (the token removal); the flow itself is tested in
    // src/core/worker/tokenRemoveFlow.test.ts.
    flow: options.noFlow === true ? undefined : flow,
    service,
    discovery,
    auth,
    connection,
    coordinator,
    sidebar,
    statusBar,
    settings: () => settings,
    dockerSetup,
    repositoryGroupsEditor,
    viewVisible: () => false,
    dockerTargets: options.dockerTargets,
    remoteDocker: options.remoteDocker,
    sessionMonitor: options.sessionMonitor,
    listOpenMode: () => listOpenMode.value,
    clock,
    isAlive: (pid: number) => alive.has(pid),
    timing: {
      handOffCheckMs: options.handOffCheckMs ?? 60_000,
      leaveCheckMs: options.leaveCheckMs ?? 60_000,
      reopenCheckDelayMs: 0,
      disconnectAnswerMs: options.disconnectAnswerMs ?? 60_000,
      busyPollMs: 5,
      readyPollMs: options.readyPollMs ?? 0,
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

  return {
    root,
    paths,
    registry,
    sessionFiles,
    disconnectRequests,
    controller,
    commands,
    docker,
    flow,
    service,
    connection,
    coordinator,
    auth,
    dockerSetup,
    repositoryGroupsEditor,
    sidebar,
    statusBar,
    logger,
    progressTitles,
    alive,
    settings,
    clock,
    listOpenMode,
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

/**
 * The pipeline starts the container: after openEnvironment, Docker reports it as running (user decision 2026-09-28:
 * the window connects only to a container that runs).
 */
function pipelineStartsContainer(): void {
  const start = h.service.openEnvironment.getMockImplementation();
  h.service.openEnvironment.mockImplementation(async (id: string, options: OpenOptions) => {
    const result = await start!(id, options);
    h.docker.containerState.mockResolvedValue('running');
    return result;
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

function welcomeManifest(): {
  contributes: {
    commands: Array<{ command: string; title: string; category: string }>;
    viewsWelcome: Array<{ view: string; contents: string; when: string }>;
  };
} {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
}

/**
 * The contents of the welcome view entries that VS Code shows, in order. A small evaluator for the `when` clauses:
 * `&&` of keys (context keys and the platform keys isMac, isWindows, isLinux), each optionally negated.
 */
function shownWelcome(context: Record<string, boolean>): string[] {
  return welcomeManifest()
    .contributes.viewsWelcome.filter((view) =>
      view.when.split('&&').every((term) => {
        const text = term.trim();
        return text.startsWith('!') ? !context[text.slice(1)] : context[text] === true;
      }),
    )
    .map((view) => view.contents);
}

describe('Controller commands', () => {
  it('registers exactly the commands of package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }> };
    };
    const declared = manifest.contributes.commands.map((command) => command.command).sort();
    expect([...h.commands.keys()].sort()).toEqual(declared);
    // 20 since unit 10: Turn Off Host Access Checks… and Turn On Host Access Checks (the switch per repository).
    // 24 since unit 14 (spec: open in a new window): Start in New Window, Start in Current Window, and the switcher for
    // a new window and for the current window.
    // 25 since unit 16 (spec: settings UI for the repository groups): Edit Repository Groups….
    // 27 since unit 26 (user decision 2026-09-26, "go with the proposal for closing"): Keep Running When Closed and
    // Stop When Closed.
    // 26 since the Docker setup walkthrough was removed (user decision 2026-09-27): no Install Docker… command.
    // 27 with Show Docker Setup (hidden), the action Install Docker… of an error: it looks for the CLI, then shows the view.
    // 29 since unit 7: Use a Remote Docker Host… and Use the Local Docker.
    // 30 since unit 7, PR 2: Close and Keep Running.
    // 31 with the command of a repository row (hidden): a double-click runs Start (user request 2026-09-27).
    // 32 with the link Show details of a progress notification (hidden), which also closes it (user decision 2026-09-28).
    // 33 with the choice of the Docker host, the command of the first row of the view (user requests 2026-09-28).
    // 34 with Ask Again Before Changing the Docker Host (user decision 2026-09-28: "Don't Ask Again" for all questions).
    // 2026-10-01: the Switch branch command was dropped (user decision). 33 without it.
    expect(declared).toHaveLength(33);
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
    expect([...keys].sort()).toEqual(
      [DockerContextKeys.setupRequired, DockerContextKeys.wslReady, LOADED_CONTEXT_KEY, LOAD_FAILED_CONTEXT_KEY, SIGNED_IN_CONTEXT_KEY].sort(),
    );
    // The other terms are the platform keys of VS Code.
    const others = new Set(
      manifest.contributes.viewsWelcome.flatMap((view) =>
        view.when.split('&&').map((term) => term.trim().replace(/^!/, '')).filter((term) => !term.startsWith('devEnvironments.')),
      ),
    );
    expect([...others].sort()).toEqual(['isLinux', 'isMac', 'isWindows']);
  });

  it('shows "could not be loaded", not "no repository was found", after a failed first load (package.json)', () => {
    const shown = (context: Record<string, boolean>): string[] => shownWelcome(context).map((contents) => contents.split('\n')[0]);
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
    // A missing CLI alone (a remote Docker host, unit 7) does not show the setup: the list entries as usual.
    expect(shown({ ...signedIn, [DockerContextKeys.missing]: true, isMac: true })).toEqual(['Loading your repositories…']);
  });

  // User decision 2026-09-26: "when no remote docker is configured and local docker is not available, the repositories
  // shall not be shown, instead, the side view shall show the install docker wizard". The sidebar then has no rows
  // (sidebar.test.ts), so the view shows these entries: the steps of the Docker setup, each with its button, then the
  // sign-in while not signed in.
  describe('Docker setup in the sidebar (package.json viewsWelcome)', () => {
    const setup = { [DockerContextKeys.missing]: true, [DockerContextKeys.setupRequired]: true };
    const intro = 'Dev Environments needs Docker, which is not installed on this computer.';
    const after = 'Your repositories appear here once Docker is installed. Dev Environments starts Docker when needed.';
    // Docker Engine on Linux is not started by the extension: it needs administrator rights.
    const afterLinux =
      'Your repositories appear here once Docker is installed. Dev Environments asks to start Docker Engine when needed.';
    const signIn =
      'Sign in with GitHub to see your repositories that have a Dev Container configuration.\n[Sign in with GitHub](command:devEnvironments.signIn)';
    const installWsl =
      '1. Install WSL 2, which Docker Desktop needs. Windows asks for administrator permission; restart afterwards.\n[Install WSL 2](command:devEnvironments.dockerSetup.installWsl)';
    const wslInstalled = '1. ✓ WSL 2 is installed.';
    const installMac =
      'Install Docker Desktop with Homebrew or Docker\'s installer. You see the commands before anything runs. Docker Desktop is free for personal use, education, non-commercial open source, and small businesses; larger companies need a [paid subscription](https://www.docker.com/legal/docker-subscription-service-agreement/).\n[Install Docker](command:devEnvironments.dockerSetup.install)';
    const installWindows =
      '2. Install Docker Desktop with winget or Docker\'s installer. You see the commands before anything runs. Docker Desktop is free for personal use, education, non-commercial open source, and small businesses; larger companies need a [paid subscription](https://www.docker.com/legal/docker-subscription-service-agreement/).\n[Install Docker](command:devEnvironments.dockerSetup.install)';
    const installLinux =
      'Install Docker Engine from Docker\'s package repository. You see the commands before anything runs.\n[Install Docker](command:devEnvironments.dockerSetup.install)';

    it('shows the steps of macOS, then the sign-in', () => {
      expect(shownWelcome({ ...setup, isMac: true })).toEqual([intro, installMac, after, signIn]);
    });

    it('shows the steps of Windows with WSL 2 first, and a check mark instead of its button once WSL 2 is ready', () => {
      expect(shownWelcome({ ...setup, isWindows: true })).toEqual([intro, installWsl, installWindows, after, signIn]);
      expect(shownWelcome({ ...setup, isWindows: true, [DockerContextKeys.wslReady]: true })).toEqual([
        intro,
        wslInstalled,
        installWindows,
        after,
        signIn,
      ]);
    });

    it('shows the steps of Linux', () => {
      expect(shownWelcome({ ...setup, isLinux: true })).toEqual([intro, installLinux, afterLinux, signIn]);
    });

    // User decision 2026-09-27: numbers only where there is more than one step (Windows: WSL 2, then Docker Desktop).
    it('numbers the steps 1, 2, … only on the platform with two steps', () => {
      const cases = <Array<[Record<string, boolean>, number]>>[
        [{ isMac: true }, 0],
        [{ isLinux: true }, 0],
        [{ isWindows: true }, 2],
        [{ isWindows: true, [DockerContextKeys.wslReady]: true }, 2],
      ];
      for (const [platform, count] of cases) {
        const numbers = shownWelcome({ ...setup, ...platform })
          .map((contents) => /^(\d+)\. /.exec(contents)?.[1])
          .filter((number) => number !== undefined)
          .map(Number);
        expect(numbers).toEqual(numbers.map((_number, index) => index + 1));
        expect(numbers).toHaveLength(count);
      }
    });

    it('shows no list entry under the setup, also when signed in, loaded, or after a failed load', () => {
      const signedIn = { ...setup, isMac: true, [SIGNED_IN_CONTEXT_KEY]: true };
      expect(shownWelcome(signedIn)).toEqual([intro, installMac, after]);
      expect(shownWelcome({ ...signedIn, [LOADED_CONTEXT_KEY]: true })).toEqual([intro, installMac, after]);
      expect(shownWelcome({ ...signedIn, [LOADED_CONTEXT_KEY]: true, [LOAD_FAILED_CONTEXT_KEY]: true })).toEqual([intro, installMac, after]);
      expect(shownWelcome({ ...signedIn, [LOAD_FAILED_CONTEXT_KEY]: true })).toEqual([intro, installMac, after]);
      // Every entry but the sign-in either belongs to the setup or is hidden under it.
      for (const view of welcomeManifest().contributes.viewsWelcome) {
        if (view.when === '!devEnvironments.signedIn') continue;
        const terms = view.when.split('&&').map((term) => term.trim());
        expect(terms.includes(DockerContextKeys.setupRequired) || terms.includes(`!${DockerContextKeys.setupRequired}`)).toBe(true);
      }
    });

    it('uses only commands of contributes.commands in the welcome view', () => {
      const manifest = welcomeManifest();
      const declared = new Set(manifest.contributes.commands.map((command) => command.command));
      const used = manifest.contributes.viewsWelcome.flatMap((view) => [...view.contents.matchAll(/\(command:([\w.]+)\)/g)].map((match) => match[1]));
      expect(used).toEqual(
        expect.arrayContaining([
          'devEnvironments.dockerSetup.install',
          'devEnvironments.dockerSetup.installWsl',
          'devEnvironments.signIn',
        ]),
      );
      for (const command of used) expect(declared.has(command), command).toBe(true);
    });
  });

  it('shows the log', async () => {
    await run('showLog');
    expect(h.logger.show).toHaveBeenCalled();
  });

  it('shows the log for the link Show details of a progress notification, also with an unknown operation (user decision 2026-09-28)', async () => {
    await run('showProgressDetails', 12345);
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
    pipelineStartsContainer(); // User decision 2026-09-28: the window connects only to a running container.
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

  // Review round 4 (test gap): a local environment never names a context, also when the other window's status has one.
  it('shows the other window of a local environment without a context', async () => {
    await h.registry.add(environment());
    h.coordinator.otherActiveWindows.mockResolvedValue([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, environmentId: ENV_ID, state: 'active', updatedAt: iso(NOW), dockerContext: 'devenv-remote-11111111' },
    ]);
    await run('start', row('acme/api', environment()));
    expect(h.connection.open.mock.calls).toEqual([[CONTAINER, '/workspaces/api']]);
  });

  it('starts the environment when the other window has lost its connection (the row shows Stopped)', async () => {
    const env = environment();
    await h.registry.add(env);
    otherWindowConnected();
    h.docker.containerState.mockResolvedValue('stopped');
    pipelineStartsContainer(); // User decision 2026-09-28: the window connects only to a running container.
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
    pipelineStartsContainer(); // User decision 2026-09-28: the window connects only to a running container.
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

  // Review round 1 (F1): Cancel while the container is checked before the window connects.
  it('stays in this window when the user cancels while the container is checked', async () => {
    const env = environment();
    await h.registry.add(env);
    const progress = cancellableProgress();
    h.service.openEnvironment.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      return openResult(env);
    });
    h.docker.containerState.mockImplementation(async () => {
      progress.cancel();
      return 'stopped';
    });
    await run('start', row('acme/api', env));
    expect(h.docker.containerState).toHaveBeenCalledTimes(1);
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  // Review round 2 (G3): Cancel ends a pause between the checks of the container (not only the checks themselves).
  it('stays in this window when the user cancels during a pause between the checks of the container', async () => {
    recreateHarness({ readyPollMs: 60_000 });
    const env = environment();
    await h.registry.add(env);
    const progress = cancellableProgress();
    h.docker.containerState.mockImplementation(async () => {
      setTimeout(() => progress.cancel(), 10);
      return 'stopped';
    });
    await run('start', row('acme/api', env));
    expect(h.docker.containerState).toHaveBeenCalledTimes(1);
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
  });

  // Review round 2 (G1): a Cancel during the check itself skips the following pause.
  it('does not wait for the next pause when the user cancels during a check of the container', async () => {
    recreateHarness({ readyPollMs: 60_000 });
    const env = environment();
    await h.registry.add(env);
    const progress = cancellableProgress();
    h.docker.containerState.mockImplementation(async () => {
      progress.cancel();
      return 'stopped';
    });
    await run('start', row('acme/api', env));
    expect(h.docker.containerState).toHaveBeenCalledTimes(1);
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  // Review round 2 (G3): the newest request wins also when it arrives while the container of the older one is checked.
  it('does not connect an older request whose container check ends after a newer request started', async () => {
    const web = environment({ id: 'b1c2d3e4-0000-4000-8000-000000000002', repository: 'acme/web', containerName: 'web', volumeName: 'web', remoteWorkspaceFolder: '/workspaces/web' });
    await h.registry.add(environment());
    await h.registry.add(web);
    const webPipeline = deferred<OpenResult>();
    h.service.openEnvironment.mockImplementation(async (id: string) => (id === ENV_ID ? openResult(environment()) : webPipeline.promise));
    const apiState = deferred<string>();
    h.docker.containerState.mockImplementation(async (name: string) => (name === CONTAINER ? apiState.promise : 'running'));
    const first = run('start', row('acme/api', environment()));
    await settle(() => h.docker.containerState.mock.calls.some(([name]) => name === CONTAINER), 'the check of the first container');
    const second = run('start', row('acme/web', web));
    await settle(() => h.service.openEnvironment.mock.calls.length === 2, 'the second pipeline');
    apiState.resolve('running');
    await first;
    expect(h.connection.open).not.toHaveBeenCalled();
    webPipeline.resolve(openResult(web));
    await second;
    expect(h.connection.open).toHaveBeenCalledTimes(1);
    expect(h.connection.open).toHaveBeenCalledWith('web', '/workspaces/web');
  });

  // Review round 2 (G3): the lines about the Docker of the attach are in the log before the window switches.
  it('logs the Docker of the attach before the window connects', async () => {
    await h.registry.add(environment());
    h.docker.run.mockImplementation(async () => {
      await pause(20);
      return { exitCode: 0, stdout: 'x', stderr: '', timedOut: false };
    });
    let loggedAtOpen: string[] = [];
    h.connection.open.mockImplementation(async () => {
      loggedAtOpen = h.logger.info.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('Before the window connects:'));
    });
    await run('start', row('acme/api', environment()));
    expect(h.connection.open).toHaveBeenCalledTimes(1);
    expect(loggedAtOpen.length).toBeGreaterThanOrEqual(4);
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

  // Plan step 5, PR D (rule D1 of 2026-09-30): window status files that cannot be read are not "no other window".
  // PR #76 review round 1 (B-R1-2): Start too.
  it('refuses Start, Stop, Rebuild and Delete when the other windows cannot be read, and changes nothing', async () => {
    await h.registry.add(environment());
    h.coordinator.otherActiveWindows.mockRejectedValue(Object.assign(new Error("EACCES: permission denied, scandir 'sessions'"), { code: 'EACCES' }));
    await run('stop', row('acme/api', environment()));
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(ControllerTexts.otherWindowsUnknown, Actions.showDetails);
    await run('rebuild', row('acme/api', environment()));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    // PR #76 review round 1 (B-R1-2): an Open never replaces a container under a window that cannot be read.
    await run('start', row('acme/api', environment()));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.delete);
    await run('delete', row('acme/api', environment()));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(ControllerTexts.otherWindowsUnknown, Actions.showDetails, Actions.tryAgain);
    expect(await h.disconnectRequests.read(ENV_ID)).toBeUndefined();
  });

  // PR #76 review round 1 (B-R1-3): Delete reads the other windows again after the confirmation; when they cannot be read
  // then, nothing is deleted.
  it('deletes nothing when the other windows cannot be read at the check after the confirmation', async () => {
    await h.registry.add(environment());
    h.coordinator.otherActiveWindows
      .mockResolvedValueOnce([])
      .mockRejectedValue(Object.assign(new Error("EACCES: permission denied, scandir 'sessions'"), { code: 'EACCES' }));
    fakeVscode.window.showWarningMessage.mockResolvedValue(Actions.delete);
    await run('delete', row('acme/api', environment()));
    expect(h.coordinator.otherActiveWindows.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(ControllerTexts.otherWindowsUnknown, Actions.showDetails, Actions.tryAgain);
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

// User decision 2026-09-26, "go with the proposal for closing": Keep Running When Closed per environment, stored in the
// registry. The Session Monitor never stops a kept environment; only the user's Stop or Delete does.
describe('Keep Running When Closed and Stop When Closed (unit 26)', () => {
  it('Keep Running When Closed writes the switch into the registry, renders the sidebar, and says so', async () => {
    await h.registry.add(environment());
    await run('keepRunning', row('acme/api', environment()));
    expect((await h.registry.get(ENV_ID))?.keepRunning).toBe(true);
    expect(h.sidebar.render).toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.keptRunning('acme/api'));
    expect(h.service.stop).not.toHaveBeenCalled();
  });

  it('Stop When Closed removes the switch, renders the sidebar, and says so', async () => {
    await h.registry.add(environment({ keepRunning: true }));
    await run('stopWhenClosed', row('acme/api', environment({ keepRunning: true })));
    const stored = await h.registry.get(ENV_ID);
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty('keepRunning');
    expect(h.sidebar.render).toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.stopsWhenClosed('acme/api'));
    expect(h.service.stop).not.toHaveBeenCalled();
  });

  it('Stop When Closed says that all environments keep running while the setting stopOnClose is off', async () => {
    await h.registry.add(environment({ keepRunning: true }));
    h.settings.stopOnClose = false;
    await run('stopWhenClosed', row('acme/api', environment({ keepRunning: true })));
    expect((await h.registry.get(ENV_ID))?.keepRunning).toBeUndefined();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.keepAllRunning);
  });

  it('Stop still stops a kept environment, and the switch stays set', async () => {
    await h.registry.add(environment({ keepRunning: true }));
    await run('stop', row('acme/api', environment({ keepRunning: true })));
    expect(h.service.stop).toHaveBeenCalledWith(ENV_ID);
    expect((await h.registry.get(ENV_ID))?.keepRunning).toBe(true);
  });

  it('says that a repository without environment has nothing to keep running, and changes nothing', async () => {
    await run('keepRunning', row('acme/web'));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.noEnvironment('acme/web'));
    expect(await h.registry.list()).toEqual([]);
  });

  // Plan step 8, PR A: the Session Monitor of the engine (here the local Docker) learns the choice at once.
  it('sends a heartbeat for the environment after the switch was stored, on the local Docker too', async () => {
    const flags: Array<boolean | undefined> = [];
    const sendHeartbeat = vi.fn(async (id: string) => {
      flags.push((await h.registry.get(id))?.keepRunning);
      return { ok: true as const };
    });
    recreateHarness({ sessionMonitor: { sendHeartbeat } });
    await h.registry.add(environment());
    await run('keepRunning', row('acme/api', environment()));
    await run('stopWhenClosed', row('acme/api', environment({ keepRunning: true })));
    expect(sendHeartbeat.mock.calls).toEqual([[ENV_ID], [ENV_ID]]);
    expect(flags).toEqual([true, undefined]);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.keptRunning('acme/api'));
  });

  it('keeps the switch and warns when the Session Monitor cannot be told', async () => {
    const sendHeartbeat = vi.fn(async () => ({ ok: false as const, detail: 'No such container: devenv-session-monitor' }));
    recreateHarness({ sessionMonitor: { sendHeartbeat } });
    await h.registry.add(environment());
    await run('keepRunning', row('acme/api', environment()));
    expect((await h.registry.get(ENV_ID))?.keepRunning).toBe(true);
    expect(warningMessages()).toContain(ControllerTexts.keepRunningNotSent('acme/api'));
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('No such container'));
    // Review round 1 of PR #85 (mutant C03): no message of success after the warning.
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalledWith(ControllerTexts.keptRunning('acme/api'));
  });

  it('offers exactly one of the two commands in the context menu, by the flag of the row, and both with a picker in the Command Palette', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: Array<{ command: string; title: string }>;
        menus: Record<string, Array<{ command?: string; when?: string }>>;
      };
    };
    const title = (command: string) => manifest.contributes.commands.find((entry) => entry.command === command)?.title;
    expect(title(Commands.keepRunning)).toBe('Keep Running When Closed');
    expect(title(Commands.stopWhenClosed)).toBe('Stop When Closed');
    const menus = manifest.contributes.menus;
    const when = (menu: string, command: string) => menus[menu].filter((item) => item.command === command).map((item) => item.when);
    expect(when('view/item/context', Commands.keepRunning)).toEqual(['view == devEnvironments.repositories && viewItem =~ /;canKeepRunning(;|$)/']);
    expect(when('view/item/context', Commands.stopWhenClosed)).toEqual(['view == devEnvironments.repositories && viewItem =~ /;kept(;|$)/']);
    expect(when('devEnvironments.more', Commands.keepRunning)).toEqual(['viewItem =~ /;canKeepRunning(;|$)/']);
    expect(when('devEnvironments.more', Commands.stopWhenClosed)).toEqual(['viewItem =~ /;kept(;|$)/']);
    // Like Stop: in the Command Palette, with a picker of the environments.
    expect(when('commandPalette', Commands.keepRunning)).toEqual([]);
    expect(when('commandPalette', Commands.stopWhenClosed)).toEqual([]);
    expect(when('commandPalette', Commands.stop)).toEqual([]);

    // The when clauses against the contextValue of rows (treeModel.contextValue): exactly one of the two matches a row with
    // an environment, and none a row without one.
    const matches = (clause: string, value: string) => new RegExp(clause.match(/viewItem =~ \/(.*)\/$/)![1]).test(value);
    const keepClause = when('devEnvironments.more', Commands.keepRunning)[0]!;
    const stopClause = when('devEnvironments.more', Commands.stopWhenClosed)[0]!;
    const actions = rowActions('running', undefined);
    const notKept = treeContextValue(actions, 'on', false);
    const kept = treeContextValue(actions, 'on', true);
    const none = treeContextValue(rowActions(undefined, undefined), 'on');
    expect([matches(keepClause, notKept), matches(stopClause, notKept)]).toEqual([true, false]);
    expect([matches(keepClause, kept), matches(stopClause, kept)]).toEqual([false, true]);
    expect([matches(keepClause, none), matches(stopClause, none)]).toEqual([false, false]);
  });

  it('picks the environment in the Command Palette, as Stop does', async () => {
    await h.registry.add(environment());
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: unknown) => {
      const list = (await items) as Array<{ environmentId?: string }>;
      return list[0];
    });
    await run('keepRunning');
    expect(fakeVscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ placeHolder: ControllerTexts.selectEnvironmentToKeepRunning }),
    );
    expect((await h.registry.get(ENV_ID))?.keepRunning).toBe(true);
  });
});

describe('Delete', () => {
  // user decision 2026-10-02: Delete runs no Git ("we may flag uncommitted changes though, but that does not hinder
  // deletion."): the dialog names the numbers of the recorded (possibly refreshed) state and always lets the user delete.
  it('user decision 2026-10-02: recorded changes are named with their numbers, and Delete anyway deletes', async () => {
    await h.registry.add(environment());
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 2, unpushedCommits: 1, stashes: 3, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.deleteAnyway);
    await run('delete', row('acme/api', environment()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]).toEqual([
      Messages.deleteUnsaved('acme/api', '2 uncommitted · 1 unpushed · 3 stashed'),
      { modal: true },
      Actions.openEnvironment,
      Actions.deleteAnyway,
    ]);
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
  });

  it('user decision 2026-10-02: with nothing recorded, the plain confirmation follows and Delete deletes', async () => {
    await h.registry.add(environment());
    h.service.safetyCheck.mockResolvedValue(undefined);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', environment()));
    const call = fakeVscode.window.showWarningMessage.mock.calls[0];
    expect(call).toEqual([Messages.deleteConfirm('acme/api'), { modal: true }, Actions.delete]);
    expect(call).not.toContain(Actions.deleteAnyway);
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.anything());
  });

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
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: [] }));
  });

  it('names every folder that the containers of the services may mount in the confirmation of Delete (review round 10, D10-1)', async () => {
    const record = {
      builtAt: iso(NOW),
      environmentImage: 'devenv-3f2a9c1e:1',
      buildNumber: 1,
      configPath: '.devcontainer/devcontainer.json',
      configHash: 'sha256:x',
      images: {},
      features: {},
    };
    const env = environment({ buildRecord: record, serviceFolders: ['/workspaces/api/pgdata', '/workspaces/api/data/postgres'] });
    await h.registry.add(env);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', env));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(
      `${Messages.deleteConfirm('acme/api')} ${Messages.deleteRepositoryServiceData('./pgdata, ./data/postgres')}`,
    );
  });

  it('names the service data in folders of the repository in the confirmation (review round 9, D9-2)', async () => {
    const record = {
      builtAt: iso(NOW),
      environmentImage: 'devenv-3f2a9c1e:1',
      buildNumber: 1,
      configPath: '.devcontainer/devcontainer.json',
      configHash: 'sha256:x',
      images: {},
      features: {},
    };
    const serviceFolders = ['/workspaces/api/data/postgres', '/workspaces/api/init.sql', '/workspaces/other/x'];
    await h.registry.add(environment({ buildRecord: record, serviceFolders }));
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', environment({ buildRecord: record, serviceFolders })));
    // Before: only Messages.deleteConfirm: the data of the database went with the volume without a word.
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]).toEqual([
      `${Messages.deleteConfirm('acme/api')} ${Messages.deleteRepositoryServiceData('./data/postgres, ./init.sql')}`,
      { modal: true },
      Actions.delete,
    ]);
    expect(Messages.deleteRepositoryServiceData('./data/postgres')).toBe('Service data in the repository will be deleted: ./data/postgres.');
    expect(h.service.deleteInWorker).toHaveBeenCalled();

    // With unsaved changes too.
    fakeVscode.window.showWarningMessage.mockReset();
    h.service.safetyCheck.mockResolvedValueOnce({ branch: 'main', uncommittedFiles: 1, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', environment({ buildRecord: record, serviceFolders })));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(
      `${Messages.deleteUnsaved('acme/api', '1 uncommitted')} ${Messages.deleteRepositoryServiceData('./data/postgres, ./init.sql')}`,
    );
  });

  it('names the paths that the containers of the services mount also without a record (review round 11, G3, G4)', async () => {
    const env = environment({ serviceFolders: ['/workspaces/api/pgdata'] });
    await h.registry.add(env);
    // For example an entry restored from its volumes, whose db container mounts ./data/pg (EnvironmentService.repositoryServiceData).
    h.service.repositoryServiceData.mockResolvedValueOnce(['./pgdata', './data/pg']);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', env));
    // Before: only the recorded ./pgdata.
    expect(h.service.repositoryServiceData).toHaveBeenCalledWith(ENV_ID);
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(
      `${Messages.deleteConfirm('acme/api')} ${Messages.deleteRepositoryServiceData('./pgdata, ./data/pg')}`,
    );
    // Without an answer of Docker, the recorded paths.
    fakeVscode.window.showWarningMessage.mockReset();
    h.service.repositoryServiceData.mockRejectedValueOnce(new Error('Docker is not running'));
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', env));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(`${Messages.deleteConfirm('acme/api')} ${Messages.deleteRepositoryServiceData('./pgdata')}`);
  });

  it('offers only the additional volumes that Delete would remove, and asks nothing when there are none', async () => {
    await h.registry.add(environment({ additionalVolumes: ['api-db', 'legacy-cache'] }));
    h.service.removableAdditionalVolumes.mockResolvedValueOnce(['api-db']);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete).mockResolvedValueOnce(Actions.remove);
    await run('delete', row('acme/api', environment()));
    expect(h.service.removableAdditionalVolumes).toHaveBeenCalledWith(ENV_ID);
    expect(fakeVscode.window.showWarningMessage.mock.calls[1]).toEqual([Messages.deleteAdditionalVolumes('api-db'), { modal: true }, Actions.remove, Actions.keep]);
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: ['api-db'] }));

    fakeVscode.window.showWarningMessage.mockReset();
    h.service.deleteInWorker.mockClear();
    h.service.removableAdditionalVolumes.mockResolvedValueOnce([]);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', environment()));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: [] }));
  });

  // Unit 6, D-19: the volumes of a Docker Compose project (the data of its services) are asked about apart, none ticked.
  describe('the data of the services of a Docker Compose environment', () => {
    const DATA = ['devenv-3f2a9c1e_pgdata', 'devenv-3f2a9c1e_cache'];

    async function deleteWithServiceData(pick: (items: Array<{ label: string; picked?: boolean }>) => unknown): Promise<void> {
      await h.registry.add(environment({ additionalVolumes: ['api-db', ...DATA] }));
      h.service.removableAdditionalVolumes.mockResolvedValueOnce(['api-db']);
      h.service.removableServiceDataVolumes.mockResolvedValueOnce([...DATA]);
      fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete).mockResolvedValueOnce(Actions.remove);
      fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ label: string; picked?: boolean }>) => pick(items));
      await run('delete', row('acme/api', environment()));
    }

    it('lists them with nothing ticked and keeps them when none is ticked', async () => {
      await deleteWithServiceData((items) => {
        expect(items.map((item) => item.label)).toEqual(DATA);
        expect(items.every((item) => item.picked === false)).toBe(true);
        return [];
      });
      expect(fakeVscode.window.showQuickPick).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ canPickMany: true, title: Messages.deleteServiceDataTitle, placeHolder: Messages.deleteServiceDataPlaceholder }),
      );
      expect(h.service.removableServiceDataVolumes).toHaveBeenCalledWith(ENV_ID);
      expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: ['api-db'] }));
    });

    it('names the volumes of an environment whose services are not known as possible data (review round 3, P3-4)', async () => {
      h.service.possibleServiceDataVolumes.mockResolvedValueOnce([DATA[1]]);
      await deleteWithServiceData((items) => {
        expect(items).toEqual([
          { label: DATA[0], description: Messages.deleteServiceDataItem, picked: false },
          { label: DATA[1], description: Messages.deleteServiceDataPossibleItem, picked: false },
        ]);
        return [];
      });
      expect(fakeVscode.window.showQuickPick).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ placeHolder: Messages.deleteServiceDataPossiblePlaceholder }),
      );
      expect(h.service.possibleServiceDataVolumes).toHaveBeenCalledWith(ENV_ID);
      expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: ['api-db'] }));
    });

    it('removes the ticked ones', async () => {
      await deleteWithServiceData((items) => [items[0]]);
      expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: ['api-db', DATA[0]] }));
    });

    it('cancels the Delete on Escape', async () => {
      await deleteWithServiceData(() => undefined);
      expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    });

    it('asks nothing when the environment has none', async () => {
      await h.registry.add(environment());
      fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
      await run('delete', row('acme/api', environment()));
      expect(fakeVscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(h.service.deleteInWorker).toHaveBeenCalled();
    });
  });

  it('opens the environment instead when the user selects Open environment', async () => {
    await h.registry.add(environment());
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 1, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.openEnvironment);
    await run('delete', row('acme/api', environment()));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.connection.open).toHaveBeenCalled();
  });

  // Review round 6 of PR #84 (B-R6-1): only Delete anyway deletes after the warning about changes; Escape (undefined)
  // and any other answer cancel the Delete without opening the environment.
  it('review round 6 of PR #84 (B-R6-1): Escape on the warning about changes neither deletes nor opens the environment', async () => {
    await h.registry.add(environment());
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 1, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', environment()));
    expect(warningMessages()).toHaveLength(1);
    expect(warningMessages()[0]).toBe(Messages.deleteUnsaved('acme/api', '1 uncommitted'));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('review round 6 of PR #84 (B-R6-1): an answer other than Delete anyway on the warning about changes does not delete', async () => {
    await h.registry.add(environment());
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 0, unpushedCommits: 2, stashes: 0, recordedAt: iso(NOW) });
    for (const answer of [Actions.delete, 'Something else']) {
      fakeVscode.window.showWarningMessage.mockResolvedValueOnce(answer);
      await run('delete', row('acme/api', environment()));
    }
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
  });

  it('asks for the plain confirmation when there are no changes or the volume is missing, and stops on Cancel', async () => {
    await h.registry.add(environment());
    await run('delete', row('acme/api', environment()));
    expect(warningMessages()).toEqual([Messages.deleteConfirm('acme/api')]);
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
  });

  it('asks the connected other window to close its connection first; the delete continues there (concept 7.14)', async () => {
    await h.registry.add(environment({ additionalVolumes: ['api-db'] }));
    otherWindowConnected();
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete).mockResolvedValueOnce(Actions.remove);
    await run('delete', row('acme/api', environment()));
    expect(warningMessages()[0]).toBe(
      `${Messages.deleteConfirm('acme/api')} ${ControllerTexts.otherWindowClosesConnection('acme/api')}`,
    );
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(await h.disconnectRequests.read(ENV_ID)).toEqual(
      expect.objectContaining({ operation: 'delete', reason: 'manual', additionalVolumesToRemove: ['api-db'], requestedBy: WINDOW_ID }),
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
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    // The other window finishes its update.
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      delete entry.busy;
    });
    await command;
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: [] }));
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
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
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
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
  });

  it('hands the delete of the connected environment to the reloaded window', async () => {
    const env = environment({ additionalVolumes: ['api-db'] });
    await h.registry.add(env);
    await connectHere(env);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete).mockResolvedValueOnce(Actions.remove);
    await run('delete', row('acme/api', env));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readOperations()).toEqual([
      expect.objectContaining({ environmentId: ENV_ID, operation: 'delete', additionalVolumesToRemove: ['api-db'] }),
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
    h.service.listConfigurationsInWorker.mockResolvedValue(['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json']);
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

  // PR #76 review round 4 (A-R4-1): an operation file of another environment that cannot be read does not keep the
  // hand-off; this environment's own file that cannot be read keeps it and the busy mark (rule D1: its owner is not known).
  it('cancels the hand-off when an operation file of another environment cannot be read (PR #76 review round 4, A-R4-1)', async () => {
    const env = await handOffWithUnreadable(() => h.paths.operationFile(OTHER_ENV_ID), async () => {
      await settle(() => h.logger.info.mock.calls.some((call) => String(call[0]).includes('pending operation is cancelled')), 'the cancel');
      await settle(() => h.sidebar.render.mock.calls.length > 0, 'the render');
    });
    expect(fs.existsSync(h.paths.operationFile(ENV_ID))).toBe(false);
    expect(fs.existsSync(h.paths.operationFile(OTHER_ENV_ID))).toBe(true);
    expect((await h.registry.get(env.id))?.busy).toBeUndefined();
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('keeps the hand-off and its busy mark when its own operation file cannot be read (PR #76 review round 4, A-R4-1)', async () => {
    const env = await handOffWithUnreadable(() => h.paths.operationFile(ENV_ID), async () => {
      await settle(() => h.logger.error.mock.calls.some((call) => String(call[0]).includes('check the pending operation')), 'the failed check');
    });
    expect(fs.existsSync(h.paths.operationFile(ENV_ID))).toBe(true);
    expect((await h.registry.get(env.id))?.busy).toMatchObject({ operation: 'rebuild', windowId: WINDOW_ID });
  });

  async function handOffWithUnreadable(unreadable: () => string, waitFor: () => Promise<void>): Promise<Environment> {
    h.controller.dispose();
    fs.rmSync(h.root, { recursive: true, force: true });
    resetFakeVscode();
    h = createHarness({ handOffCheckMs: 20 });
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    fs.mkdirSync(h.paths.operationsDir, { recursive: true });
    fs.writeFileSync(h.paths.operationFile(OTHER_ENV_ID), '{}');
    const denied = unreadable();
    const readFile = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.promises.readFile);
    try {
      await run('rebuild', row('acme/api', env));
      h.sidebar.render.mockClear();
      await waitFor();
    } finally {
      spy.mockRestore();
    }
    return env;
  }
});

describe('Select configuration…', () => {
  it('rebuilds an environment of no window with the selected configuration', async () => {
    await h.registry.add(environment());
    h.service.listConfigurationsInWorker.mockResolvedValue(['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json']);
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
    h.service.listConfigurationsInWorker.mockResolvedValue(['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json']);
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
    // Plan step 11B3b: changed expectation, the listing goes through the worker.
    expect(h.service.listConfigurationsInWorker).not.toHaveBeenCalled();
    expect(h.service.open).toHaveBeenCalledWith(
      expect.objectContaining({ repository: 'acme/api' }),
      expect.objectContaining({ configPath: '.devcontainer/go/devcontainer.json' }),
    );
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
    // Plan step 11C3: changed, by the worker, made ready in full (the user asked for the refresh).
    expect(h.service.reconcileInWorker).toHaveBeenCalledWith({ passive: false });
    expect(h.sidebar.refreshStates).toHaveBeenCalled();
  });

  it('restores the environments from the volumes when registry.json exists but cannot be read as a registry', async () => {
    fs.writeFileSync(h.paths.registry, '{ "version": 1, "environments": [ { "id": ');
    await run('refresh');
    expect(h.service.reconcileInWorker).toHaveBeenCalledTimes(1);
  });

  it('leaves the check of the Docker target and of a running Docker to the restore itself (review, D2)', async () => {
    // Before, the controller asked `docker info` first, on any endpoint (also one that is neither local nor SSH).
    fs.writeFileSync(h.paths.registry, '{ "version": 1, "environments": [ { "id": ');
    h.docker.isRunning.mockClear();
    let runningAsked = 0;
    h.service.reconcileInWorker.mockImplementation(async () => {
      runningAsked = h.docker.isRunning.mock.calls.length;
      return 0;
    });
    await run('refresh');
    expect(h.service.reconcileInWorker).toHaveBeenCalledTimes(1);
    expect(runningAsked).toBe(0);
  });

  it('does not restore from the volumes while registry.json is valid', async () => {
    await h.registry.add(environment());
    await run('refresh');
    expect(h.service.reconcileInWorker).not.toHaveBeenCalled();
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
      // Concept section 9: that container lacks the current setup; the window must not attach to it.
      // Versions reset to 1 (user decision 2026-09-27): an older setup is a label other than 1 below it, or none.
      const env = environment();
      await h.registry.add(env);
      h.docker.findContainer.mockResolvedValue(containerInfo(code === 'cancelled' ? undefined : '0'));
      h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError(code, message));
      await h.controller.openAttachedWindow(env, CONTAINER, undefined);
      await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
      // Review round 1 (D2): the lookup gets the name of the environment too.
      expect(h.docker.findContainer).toHaveBeenCalledWith(ENV_ID, env.containerName);
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

  // Review round 1 of 11C1 (A-R1-2, missing test): the decision of 2026-10-04 (unknown: the window never leaves its
  // container because the worker could not read it): an outdated state that could not be read leaves nothing.
  it('role A: keeps the window attached with Reconnect when the failed pipeline is followed by a read that is unknown', async () => {
    const env = environment();
    await h.registry.add(env);
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    await pause(20);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(warningMessages()).not.toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
  });

  it('Start: leaves a running container of an older version instead of saying that the window is connected', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    // Versions reset to 1 (user decision 2026-09-27).
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
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

  it('role B (PR #76 review round 5, A-R5-1): an unreadable operation file of another environment is reported and does not block this one', async () => {
    await h.registry.add(environment());
    h.connection.isEmptyWindow.mockReturnValue(true);
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 60_000) });
    await h.sessionFiles.writeOperation({ environmentId: ENV_ID, operation: 'stop', requestedAt: iso(NOW - 5000), requestedBy: 'old-window', reason: 'manual' });
    const denied = h.paths.operationFile(OTHER_ENV_ID);
    fs.writeFileSync(denied, '{}');
    const readFile = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.promises.readFile);
    try {
      await h.controller.runEmptyWindowTasks();
    } finally {
      spy.mockRestore();
    }
    expect(h.service.stop).toHaveBeenCalledWith(ENV_ID);
    expect(fs.existsSync(h.paths.operationFile(ENV_ID))).toBe(false);
    expect(fs.existsSync(denied)).toBe(true);
    expect(warningMessages()).toContainEqual(expect.stringContaining(`${OTHER_ENV_ID}.json: EACCES`));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
  });

  it('role B (PR #76 review round 5, A-R5-1): an unreadable operation file alone is reported, not dropped, and the window is not reopened', async () => {
    await h.registry.add(environment());
    h.connection.isEmptyWindow.mockReturnValue(true);
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 60_000) });
    await h.sessionFiles.writeOperation({ environmentId: ENV_ID, operation: 'stop', requestedAt: iso(NOW - 5000), requestedBy: 'old-window', reason: 'manual' });
    const denied = h.paths.operationFile(ENV_ID);
    const readFile = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.promises.readFile);
    try {
      await h.controller.runEmptyWindowTasks();
    } finally {
      spy.mockRestore();
    }
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(fs.existsSync(denied)).toBe(true);
    expect(warningMessages()).toContainEqual(expect.stringContaining(`${ENV_ID}.json: EACCES`));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('role B (PR #76 review round 6, B-R6-1): a pending-operations folder that cannot be read is reported, runs nothing, and the window is not reopened', async () => {
    await h.registry.add(environment());
    h.connection.isEmptyWindow.mockReturnValue(true);
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 60_000) });
    await h.sessionFiles.writeOperation({ environmentId: ENV_ID, operation: 'stop', requestedAt: iso(NOW - 5000), requestedBy: 'old-window', reason: 'manual' });
    const readdir = fs.promises.readdir;
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (dir: fs.PathLike, ...rest: unknown[]) => {
      if (String(dir) === h.paths.operationsDir) throw Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' });
      return (readdir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
    }) as typeof fs.promises.readdir);
    try {
      await expect(h.controller.runEmptyWindowTasks()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(fs.existsSync(h.paths.operationFile(ENV_ID))).toBe(true);
    expect(warningMessages()).toContainEqual(expect.stringContaining('EIO'));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
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

    // The next start of VS Code, later: the record is older than 5 seconds (REOPEN_MIN_AGE_MS).
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
      additionalVolumesToRemove: ['api-db'],
    });
    await h.sessionFiles.writeOperation({
      environmentId: 'b1c2d3e4-0000-4000-8000-000000000002',
      operation: 'stop',
      requestedAt: iso(NOW - 4000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.deleteInWorker).toHaveBeenCalledWith(ENV_ID, expect.objectContaining({ additionalVolumesToRemove: ['api-db'] }));
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

  // User decision 2026-09-26, "go with the proposal for closing": a reopen from the macOS Dock a few seconds after the
  // quit was blocked by the 30-second rule. With the 5-second guard, 6 seconds reopen and 4 seconds do not.
  it('role B: reopens a record older than 5 seconds, and not one of 4 seconds', async () => {
    await h.registry.add(environment());
    h.connection.isEmptyWindow.mockReturnValue(true);
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 4_000) });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 6_000) });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
  });

  // Review finding F1: the age of the reopen record is measured at activation, not after the awaits (ready, the stale
  // claims, the operations, the GitHub account) and the pause of REOPEN_CHECK_DELAY_MS. Otherwise a Close Remote
  // Connection whose empty window activates 3 seconds later is checked at about 6 seconds and reconnects.
  it('role B: measures the age of the reopen record at activation, not after the awaits and the pause', async () => {
    await h.registry.add(environment());
    h.connection.isEmptyWindow.mockReturnValue(true);
    let now = NOW;
    h.clock.now = () => now;
    const advancing = (): void => {
      // The status file (ready), the GitHub account, and the pause before the check each take time.
      h.controller.setReady(Promise.resolve().then(() => (now += 500)));
      h.auth.getAccount.mockImplementationOnce(async () => {
        now += 1_000;
        return ACCOUNT;
      });
      h.coordinator.otherActiveWindows.mockImplementationOnce(async () => {
        now += 1_500;
        return [];
      });
    };

    // 3 seconds old at activation (Close Remote Connection), 6 seconds old at the check: no reopen.
    advancing();
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(now - 3_000) });
    await h.controller.runEmptyWindowTasks();
    expect(now - Date.parse((await h.sessionFiles.readReopen())!.closedAt)).toBe(6_000);
    expect(h.service.openEnvironment).not.toHaveBeenCalled();

    // 6 seconds old at activation: a reopen.
    advancing();
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(now - 6_000) });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
  });

  it('role B: does not reopen after Close Remote Connection, with another window, or when the setting is off', async () => {
    await h.registry.add(environment());
    h.connection.isEmptyWindow.mockReturnValue(true);
    // Close Remote Connection brings up the empty window within 1 to 3 seconds. The guard is 5 seconds since the user
    // decision 2026-09-26, "go with the proposal for closing" (it was 30 seconds, and this record was 10 seconds old).
    h.sessionFiles.writeReopenSync({ environmentId: ENV_ID, closedAt: iso(NOW - 3_000) });
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

  // Decision of 2026-10-04 ("unknown"): a state that the worker cannot read changes nothing; a Reconnect of the user then
  // is tried, and its failure leaves the window disconnected.
  it('keeps its state when the state of the container cannot be read, and a Reconnect of the user then is tried', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    const connectedCalls = h.statusBar.showConnected.mock.calls.length;
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read of the state');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
    // Review round 1 of 11C1 (A-R1-3): changed expectation (before: the status bar was not touched): it shows the same
    // connected state again, with the tooltip that the state could not be read.
    expect(h.statusBar.showConnected.mock.calls.slice(connectedCalls)).toEqual([h.statusBar.showConnected.mock.calls[connectedCalls - 1]]);
    expect(h.statusBar.showStateUnknown).toHaveBeenLastCalledWith(true);
    // Review round 2 of 11C1 (A-R2-M1): every read is passive in windowStateInWorker (environmentService.listInWorker.test).
    expect(h.service.windowStateInWorker.mock.calls.slice(reads).map((call) => call[2])).toEqual([undefined]);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    // Review round 3 of 11C1 (A-R3-M1): changed expectation (before: the Start took the unknown state as "not running" and
    // ran the pipeline): it reads again with the worker made ready in full; still unknown, it fails, and the window is
    // disconnected (decision of 2026-10-04), without a pipeline that could replace the container under it.
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.signal instanceof AbortSignal)).toBe(true);
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(ControllerTexts.containerStateUnreadable('acme/api'), expect.anything(), expect.anything());
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
  });

  // Review round 3 of 11C1 (A-R3-M1): the read again finds the container running: no pipeline under this window.
  it('a Start whose first read is unknown and whose read in the operation finds the container running and outdated leaves it', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(warningMessages()).toEqual([ControllerTexts.outdatedContainerClosed('acme/api')]);
  });

  it('a Start whose first read is unknown and whose read in the operation finds the container running and current is connected', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  // Review round 3 of 11C1 (A-R3-M1b): a failed Reconnect leaves a container that must not be used as it is.
  it('a Reconnect that fails leaves a container of an older version that it did not make again', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.containerState.mockResolvedValue('stopped');
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('hostAccess', Messages.hostAccess('privileged mode')));
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(warningMessages()).toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
  });

  // Review round 3 of 11C1 (A-R3-M2): an outdated check that was unknown when the window attached is read again.
  it('leaves an outdated container when the check of the connection can read it after the window attached unknown', async () => {
    const env = environment();
    await h.registry.add(env);
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    // The reads of the window after its open (the connection and the branch) end before the heartbeat.
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.branch === true), 'the branch read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    h.service.windowStateInWorker.mockResolvedValue({ state: 'running', outdated: 'hostAccess' });
    h.controller.onHeartbeat();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(warningMessages()).toContain(ControllerTexts.unrestrictedContainerClosed('acme/api'));
  });

  // Review round 4 of 11C1 (A-R4-M2): the host access checks turned on after the window attached apply from the next
  // open: the check that reads the container later does not leave it for them.
  it('does not leave a container that was current at the unknown attach when the host access checks are turned on later', async () => {
    const env = environment();
    await h.registry.add(env);
    h.settings.hostAccessChecksOff = ['acme/api'];
    h.docker.findContainer.mockResolvedValue({ ...containerInfo(String(CONTAINER_VERSION)), labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), [LABEL_HOST_ACCESS]: HOST_ACCESS_UNRESTRICTED } });
    const read = h.service.windowStateInWorker.getMockImplementation()!;
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.branch === true), 'the branch read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    h.settings.hostAccessChecksOff = [];
    h.service.windowStateInWorker.mockImplementation(read);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  // Review round 4 of 11C1 (A-R4-M1): a Start while the open pipeline of the restored window runs reads and leaves nothing.
  it('a Start during the open pipeline of the restored window neither leaves its container nor shows Reconnect', async () => {
    const env = environment();
    await h.registry.add(env);
    const pipeline = deferred<OpenResult>();
    h.service.openEnvironment.mockImplementationOnce(() => pipeline.promise);
    h.docker.containerState.mockResolvedValue('stopped');
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    const opening = h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'the pipeline');
    await run('start', { environmentId: ENV_ID });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closes = h.connection.closeRemoteConnection.mock.calls.length;
    const lost = h.statusBar.showConnectionLost.mock.calls.length;
    h.docker.containerState.mockResolvedValue('running');
    h.docker.findContainer.mockResolvedValue(containerInfo(String(CONTAINER_VERSION)));
    pipeline.resolve(openResult(env));
    await opening;
    expect({ closes, lost }).toEqual({ closes: 0, lost: 0 });
  });

  // Review round 4 of 11C1 (A-R4-M1): also a running container of an older version, which the pipeline may replace.
  it('a Start during the open pipeline of the restored window reads nothing, also when its container runs', async () => {
    const env = environment();
    await h.registry.add(env);
    const pipeline = deferred<OpenResult>();
    h.service.openEnvironment.mockImplementationOnce(() => pipeline.promise);
    h.docker.findContainer.mockResolvedValue(containerInfo('0'));
    const opening = h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'the pipeline');
    const reads = h.service.windowStateInWorker.mock.calls.length;
    await run('start', { environmentId: ENV_ID });
    expect(h.service.windowStateInWorker.mock.calls.length).toBe(reads);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    h.docker.findContainer.mockResolvedValue(containerInfo(String(CONTAINER_VERSION)));
    pipeline.resolve(openResult(env));
    await opening;
  });

  // Review round 4 of 11C1 (B-R4): the gaps of the mutation tests of round 3's changes.
  it('a Start whose first read finds the container running ends Reconnect, and shows it connected again (B-R4 L5)', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'stopped' });
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length > 0, 'Reconnect');
    const lostCalls = h.statusBar.showConnectionLost.mock.calls.length;
    const connectedCalls = h.statusBar.showConnected.mock.calls.length;
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'running' });
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.statusBar.showConnectionLost.mock.calls.length).toBe(lostCalls);
    expect(h.statusBar.showConnected.mock.calls.length).toBeGreaterThan(connectedCalls);
    expect(h.statusBar.showConnected).toHaveBeenLastCalledWith('acme/api', expect.anything());
  });

  it('a Start whose read in the operation finds the container running ends Reconnect (B-R4 T13)', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'stopped' });
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length > 0, 'Reconnect');
    const lostCalls = h.statusBar.showConnectionLost.mock.calls.length;
    const connectedCalls = h.statusBar.showConnected.mock.calls.length;
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'running' });
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.statusBar.showConnectionLost.mock.calls.length).toBe(lostCalls);
    expect(h.statusBar.showConnected.mock.calls.length).toBeGreaterThan(connectedCalls);
  });

  it('a Start whose read in the operation finds the container running removes the hint of an unknown state (B-R4 T14, T15)', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showStateUnknown.mock.lastCall?.[0] === true, 'the hint');
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'running' });
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.statusBar.showStateUnknown).toHaveBeenLastCalledWith(false);
  });

  it('the read in the operation of Start reads the container of the folder of the window (B-R4 T18)', async () => {
    const env = environment();
    await h.registry.add(env);
    const reads = h.service.currentBranch.mock.calls.length;
    await h.controller.openAttachedWindow(env, 'devenv-old', { environmentId: env.id, windowId: WINDOW_ID, createdAt: iso(NOW - 5000) });
    await settle(() => h.service.currentBranch.mock.calls.length > reads, 'the branch of the window');
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    await run('start', { environmentId: ENV_ID });
    expect(h.service.windowStateInWorker.mock.calls.filter((call) => call[2]?.signal !== undefined).map((call) => call[1])).toEqual(['devenv-old']);
  });

  it('a Cancel during the read in the operation of Start shows no error (B-R4 T4)', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    const progress = cancellableProgress();
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.service.windowStateInWorker.mockImplementationOnce(async () => {
      progress.cancel();
      return undefined;
    });
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('the check of the connection shows Reconnect when Docker is not installed (B-R4 K7)', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.isInstalled.mockReturnValue(false);
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length > 0, 'Reconnect');
  });

  it('a check of the connection that read the container current ends the pending outdated check (B-R4 K3)', async () => {
    const env = environment();
    await h.registry.add(env);
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.branch === true), 'the branch read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.service.windowStateInWorker.mockResolvedValue({ state: 'running' });
    let reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.service.windowStateInWorker.mockResolvedValue({ state: 'running', outdated: 'hostAccess' });
    reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  it('a failed Reconnect that read the container current sets no pending outdated check (B-R4 O3)', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'stopped' });
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'stopped' });
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.service.windowStateInWorker.mockResolvedValue({ state: 'running', outdated: 'hostAccess' });
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  // Review round 5 of 11C1 (A-R5 missing tests): the pending outdated check and the reads of Start.
  async function attachUnknown(env: Environment): Promise<void> {
    h.service.windowStateInWorker.mockResolvedValue(undefined);
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.branch === true), 'the branch read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  }

  async function heartbeatRead(value: WindowStateValue): Promise<void> {
    h.service.windowStateInWorker.mockResolvedValue(value);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('the pending outdated check leaves a container of an older version, also when the host access checks changed (A-R5)', async () => {
    const env = environment();
    await h.registry.add(env);
    await attachUnknown(env);
    h.settings.hostAccessChecksOff = ['acme/api'];
    await heartbeatRead({ state: 'running', outdated: 'version' });
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(warningMessages()).toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
  });

  it('a Start whose first read finds the container current ends the pending outdated check (A-R5, A-R4-L2)', async () => {
    const env = environment();
    await h.registry.add(env);
    await attachUnknown(env);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'running' });
    await run('start', { environmentId: ENV_ID });
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
    await heartbeatRead({ state: 'running', outdated: 'hostAccess' });
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  // Review round 5 of 11C1 (B-R5 K2): the read in the operation of Start is a known read too.
  it('a Start whose read in the operation finds the container current ends the pending outdated check', async () => {
    const env = environment();
    await h.registry.add(env);
    await attachUnknown(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'running' });
    await run('start', { environmentId: ENV_ID });
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
    await heartbeatRead({ state: 'running', outdated: 'hostAccess' });
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  it('a first read of Start that ends after the window left its environment leaves nothing more (A-R5-2)', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    const read = deferred<WindowStateValue | undefined>();
    h.service.windowStateInWorker.mockImplementationOnce(() => read.promise);
    const starting = run('start', { environmentId: ENV_ID });
    await settle(() => h.service.windowStateInWorker.mock.calls.length > 0 && h.service.windowStateInWorker.mock.lastCall?.[2] === undefined, 'the read of Start');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    read.resolve({ state: 'running', outdated: 'version' });
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(warningMessages()).not.toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
  });

  it('a read in the operation of Start that ends after the window left its environment says nothing (A-R5, A-R4-L1)', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    const read = deferred<WindowStateValue | undefined>();
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.service.windowStateInWorker.mockImplementationOnce(() => read.promise);
    const starting = run('start', { environmentId: ENV_ID });
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.signal !== undefined), 'the read in the operation');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    read.resolve({ state: 'running', outdated: 'version' });
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(warningMessages()).not.toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
  });

  // Review round 3 of 11C1 (A-R3-M2): a container read as current when the window attached is not left by the check.
  it('does not leave a container that was current when the window attached, also when the check reads it outdated', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValue({ state: 'running', outdated: 'hostAccess' });
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });

  // Review round 1 of 11C1 (A-R1-3, missing test): a read that succeeds again removes the hint; a Reconnect of the user
  // from the unknown state that succeeds leaves the window connected.
  it('removes the hint of an unknown state when the state can be read again, and a Reconnect from it that succeeds connects', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showStateUnknown.mock.calls.some((call) => call[0] === true), 'the hint');
    // The Start of the user reads unknown once more; review round 3 (A-R3-M1): changed expectation, its read in the
    // operation finds the container stopped, and the pipeline reconnects, which succeeds.
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.docker.containerState.mockResolvedValueOnce('stopped');
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    h.docker.containerState.mockResolvedValue('running');
    expect(h.service.windowStateInWorker.mock.calls.length).toBeGreaterThan(reads);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showStateUnknown.mock.lastCall?.[0] === false, 'the hint removed');
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
    expect(h.statusBar.showConnected).toHaveBeenLastCalledWith('acme/api', expect.anything());
  });

  // Review round 1 of 11C1 (B-R1-7): the window reads its own container (from its folder URI), not the one of the record.
  it('reads the container of its folder, also when the record names another one', async () => {
    const env = environment();
    await h.registry.add(env);
    const reads = h.service.currentBranch.mock.calls.length;
    await h.controller.openAttachedWindow(env, 'devenv-old', { environmentId: env.id, windowId: WINDOW_ID, createdAt: iso(NOW - 5000) });
    await settle(() => h.service.currentBranch.mock.calls.length > reads, 'the branch of the window');
    const before = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > before, 'the read of the state');
    expect(h.service.windowStateInWorker.mock.calls.slice(before).map((call) => call[1])).toEqual(['devenv-old']);
    // Review round 3 of 11C1 (B-R3 R9): the branch read too.
    expect(h.service.windowStateInWorker.mock.calls.filter((call) => call[2]?.branch === true).map((call) => call[1])).toEqual(['devenv-old']);
    h.docker.containerState.mockResolvedValue('running');
    await run('start', { environmentId: ENV_ID });
    expect(h.service.windowStateInWorker.mock.lastCall?.[1]).toBe('devenv-old');
    expect(env.containerName).not.toBe('devenv-old');
  });

  // Review round 2 of 11C1 (B-R2 C32): a read that ends after the window left its environment changes nothing.
  it('ignores a read of the state that ends after the window left its environment', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    const read = deferred<WindowStateValue | undefined>();
    h.service.windowStateInWorker.mockImplementationOnce(() => read.promise);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read in the background');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close');
    read.resolve({ state: 'stopped' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.logger.info.mock.calls.some(([line]) => String(line) === 'The container of acme/api does not run.')).toBe(false);
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
  });

  // Review round 3 of 11C1 (B-R3 L3, L5): a Start that reads the container running ends "Connection lost" at once.
  it('a Start that reads the container running while the window shows Reconnect shows it connected, without the pipeline', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce({ state: 'stopped' });
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length > 0, 'Reconnect');
    const lostCalls = h.statusBar.showConnectionLost.mock.calls.length;
    h.docker.containerState.mockResolvedValue('running');
    await run('start', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.statusBar.showConnectionLost.mock.calls.length).toBe(lostCalls);
    expect(h.statusBar.showConnected).toHaveBeenLastCalledWith('acme/api', expect.anything());
    // Review round 3 of 11C1 (B-R3 R7): the read of Start asks for no branch.
    expect(h.service.windowStateInWorker).toHaveBeenLastCalledWith(expect.objectContaining({ id: ENV_ID }), env.containerName);
  });

  // Review round 3 of 11C1 (B-R3 R3): the window reads its state at once after its open, not at the first heartbeat.
  it('shows Reconnect after its open when its container does not run, without a heartbeat', async () => {
    const env = environment();
    await h.registry.add(env);
    h.docker.containerState.mockResolvedValue('stopped');
    h.service.openEnvironment.mockResolvedValueOnce(openResult(env));
    await h.controller.openAttachedWindow(env, CONTAINER, { environmentId: env.id, windowId: WINDOW_ID, createdAt: iso(NOW - 5000) });
    await settle(() => h.statusBar.showConnectionLost.mock.calls.length > 0, 'Reconnect');
  });

  // Review round 3 of 11C1 (B-R3 R2): a branch read that ends after the window left its environment changes nothing.
  it('ignores a branch read that ends after the window left its environment', async () => {
    const env = environment();
    await h.registry.add(env);
    const read = deferred<WindowStateValue | undefined>();
    h.service.windowStateInWorker.mockImplementation(async (_env, _name, options = {}) => (options.branch ? read.promise : { state: 'running' }));
    await h.controller.openAttachedWindow(env, CONTAINER, { environmentId: env.id, windowId: WINDOW_ID, createdAt: iso(NOW - 5000) });
    await settle(() => h.service.windowStateInWorker.mock.calls.some((call) => call[2]?.branch === true), 'the branch read');
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updates = h.statusBar.showNotConnected.mock.calls.length + h.statusBar.showConnected.mock.calls.length;
    read.resolve({ state: 'running', branch: 'feature/late' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.statusBar.showNotConnected.mock.calls.length + h.statusBar.showConnected.mock.calls.length).toBe(updates);
  });

  // Review round 2 of 11C1 (A-R2-L1): a Start whose read finds the container running removes the hint at once.
  it('removes the hint of an unknown state when a Start of the user reads that the container runs', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.service.windowStateInWorker.mockResolvedValueOnce(undefined);
    h.controller.onHeartbeat();
    await settle(() => h.statusBar.showStateUnknown.mock.lastCall?.[0] === true, 'the hint');
    h.docker.containerState.mockResolvedValue('running');
    await run('start', { environmentId: ENV_ID });
    expect(h.statusBar.showStateUnknown).toHaveBeenLastCalledWith(false);
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
  });

  // Review round 1 of 11C1 (A-R1-4): a read that ends after an operation of the environment started changes nothing.
  it('ignores a read of the state that ends after an operation of its environment started', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    const read = deferred<WindowStateValue | undefined>();
    h.service.windowStateInWorker.mockImplementationOnce(() => read.promise);
    const reads = h.service.windowStateInWorker.mock.calls.length;
    h.controller.onHeartbeat();
    await settle(() => h.service.windowStateInWorker.mock.calls.length > reads, 'the read in the background');
    // A Start of the user meanwhile: the container does not run, the pipeline reconnects and is still running.
    const pipeline = deferred<Awaited<ReturnType<typeof h.service.openEnvironment>>>();
    h.service.openEnvironment.mockImplementationOnce(() => pipeline.promise);
    h.docker.containerState.mockResolvedValue('stopped');
    const starting = run('start', { environmentId: ENV_ID });
    await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'the pipeline');
    read.resolve({ state: 'stopped' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
    expect(h.logger.info.mock.calls.some(([line]) => String(line) === 'The container of acme/api does not run.')).toBe(false);
    pipeline.reject(new UserFacingError('cancelled', PipelineTexts.cancelled));
    await starting;
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
      additionalVolumesToRemove: ['api-db'],
    });
    h.controller.onHeartbeat();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(await h.sessionFiles.readOperations()).toEqual([
      expect.objectContaining({ environmentId: ENV_ID, operation: 'delete', requestedBy: WINDOW_ID, additionalVolumesToRemove: ['api-db'] }),
    ]);
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(expect.objectContaining({ operation: 'delete', windowId: WINDOW_ID }));
    expect(await h.disconnectRequests.read(ENV_ID)).toBeUndefined();
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
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

  it('opens the editor of the repository groups with Edit Repository Groups…', async () => {
    await run('editRepositoryGroups');
    expect(h.repositoryGroupsEditor.open).toHaveBeenCalledTimes(1);
  });

  it('runs the buttons of the Docker setup in the sidebar, and Show Docker Setup of the action Install Docker…', async () => {
    await run('dockerSetupInstall');
    await run('dockerSetupStart');
    await run('dockerSetupInstallWsl');
    await run('dockerSetupShow');
    expect(h.dockerSetup.install).toHaveBeenCalledTimes(1);
    expect(h.dockerSetup.start).toHaveBeenCalledTimes(1);
    expect(h.dockerSetup.installWsl).toHaveBeenCalledTimes(1);
    expect(h.dockerSetup.show).toHaveBeenCalledTimes(1);
  });

  it('shows an error of a Docker setup command (concept 6.5)', async () => {
    h.dockerSetup.start.mockRejectedValue(new UserFacingError('dockerStartFailed', Messages.dockerStartFailed));
    await run('dockerSetupStart');
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(Messages.dockerStartFailed, Actions.showDetails);
  });
});

describe('Accounts (concept 7.5)', () => {
  // 2026-10-01: the Switch branch command was dropped (user decision). Its row is gone (6 warnings, before 7).
  it('refuses Start, Stop, Delete, Rebuild, and Select configuration of an environment of another account', async () => {
    const env = environment({ owner: OTHER_ACCOUNT });
    await h.registry.add(env);
    for (const command of ['start', 'stop', 'delete', 'rebuild', 'selectConfiguration'] as const) {
      await run(command, row('acme/api', env));
    }
    // The status bar item Reconnect.
    await run('start', { environmentId: ENV_ID });
    expect(warningMessages()).toEqual(Array(6).fill(Messages.otherAccount('acme/api')));
    for (const call of Object.values(h.service)) expect(call).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(fakeVscode.window.createQuickPick).not.toHaveBeenCalled();
  });

  it('starts the own environment of the account for a repository that has an environment of another account (D-3)', async () => {
    await h.registry.add(environment({ owner: OTHER_ACCOUNT }));
    const own = environment({ id: 'c1d2e3f4-0000-4000-8000-000000000003', containerName: 'devenv-octo-api-c1d2e3f4' });
    h.service.open.mockImplementation(async () => {
      await h.registry.add(own);
      return openResult(own);
    });
    // A stale row without the environment, and a repository row: the environment of the other account is not named.
    await run('start', row('acme/api'));
    expect(h.service.open).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.anything());
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(warningMessages()).toEqual([]);
    expect(h.connection.open).toHaveBeenCalledWith(own.containerName, '/workspaces/api');
  });

  it.each<[string, boolean]>([
    ['a repository row', false],
    ['a row that names the environment', true],
  ])('Try again after an account change: %s', async (_name, named) => {
    await h.registry.add(environment());
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
    // The user signs in with another account while the error shows, then presses Try again.
    fakeVscode.window.showErrorMessage.mockImplementationOnce(async () => {
      h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
      return Actions.tryAgain;
    });
    const own = environment({ id: 'c1d2e3f4-0000-4000-8000-000000000003', containerName: 'devenv-acme-api-c1d2e3f4', owner: OTHER_ACCOUNT });
    h.service.open.mockImplementation(async () => {
      await h.registry.add(own);
      return openResult(own);
    });
    await run('start', named ? row('acme/api', environment()) : row('acme/api'));
    if (named) {
      // An environment that the command named stays that environment (the service refuses it: another account).
      await settle(() => h.service.openEnvironment.mock.calls.length === 2, 'the second open');
      expect(h.service.openEnvironment.mock.calls.map((call) => call[0])).toEqual([ENV_ID, ENV_ID]);
      expect(h.service.open).not.toHaveBeenCalled();
    } else {
      // A repository gets the environment of the account that is signed in now: its first open (D-3).
      await settle(() => h.connection.open.mock.calls.length === 1, 'the connection of the other account');
      expect(h.service.open).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.anything());
      expect(h.connection.open).toHaveBeenCalledWith(own.containerName, '/workspaces/api');
      expect(warningMessages()).toEqual([]);
      expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    }
  });

  it('Try again of a named environment (the status bar item) keeps that environment, also twice and after an account change', async () => {
    await h.registry.add(environment());
    h.service.openEnvironment.mockRejectedValue(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
    let answers = 0;
    fakeVscode.window.showErrorMessage.mockImplementation(async () => {
      answers++;
      if (answers === 1) h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
      return answers <= 2 ? Actions.tryAgain : undefined;
    });
    await run('start', { environmentId: ENV_ID });
    await settle(() => h.service.openEnvironment.mock.calls.length === 3, 'the second Try again');
    expect(h.service.openEnvironment.mock.calls.map((call) => call[0])).toEqual([ENV_ID, ENV_ID, ENV_ID]);
    expect(h.service.open).not.toHaveBeenCalled();
  });

  it('asks for a sign-in for an environment when nobody is signed in', async () => {
    await h.registry.add(environment());
    h.auth.getAccount.mockResolvedValue(undefined);
    await run('start', row('acme/api', environment()));
    expect(warningMessages()).toEqual([Messages.signInRequired]);
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

  it('role A: a restored window leaves when its open pipeline refuses the environment after an account change', async () => {
    const env = environment();
    await h.registry.add(env);
    // The account changes while the pipeline runs; the session event is not handled yet when the pipeline fails.
    h.service.openEnvironment.mockImplementationOnce(async () => {
      h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
      throw new UserFacingError('otherAccount', Messages.otherAccount('acme/api'));
    });
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    await settle(() => tokenRemovals() > 0, 'the removal of the token');
    expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { environmentId: env.id, containerName: CONTAINER }, { timeoutMs: 60_000 });
    expect(h.statusBar.showConnectionLost).not.toHaveBeenCalled();
  });

  // Review round 2 of 11C3 (A-R2-M1): a window whose container the registry did not know at activation takes its
  // environment also when the registry was restored already, or the restore added nothing.
  it('adopt: the window takes its restored environment when the registry was restored already', async () => {
    const env = environment();
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.docker.findContainer.mockResolvedValue(containerInfo(String(CONTAINER_VERSION)));
    await h.registry.add(env);
    await h.controller.reconcileIfRegistryLost({ passive: true });
    expect(h.coordinator.setEnvironment).not.toHaveBeenCalled();
    await h.controller.reconcileIfRegistryLost({ passive: true, adopt: true });
    expect(h.service.reconcileInWorker).not.toHaveBeenCalled();
    expect(h.coordinator.setEnvironment).toHaveBeenCalledWith(env.id);
  });

  it('adopt: the window takes its environment when the restore added none (another window restored it)', async () => {
    const env = environment();
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    h.docker.findContainer.mockResolvedValue(containerInfo(String(CONTAINER_VERSION)));
    fs.rmSync(h.paths.registry, { force: true });
    h.service.reconcileInWorker.mockImplementation(async () => {
      await h.registry.add(env);
      return 0;
    });
    await h.controller.reconcileIfRegistryLost({ passive: false, adopt: true });
    expect(h.service.reconcileInWorker).toHaveBeenCalledWith({ passive: false });
    expect(h.coordinator.setEnvironment).toHaveBeenCalledWith(env.id);
  });

  it('role A: a window adopted after a restore of the registry leaves when the account changed during its checks', async () => {
    const env = environment();
    h.connection.currentContainerName.mockReturnValue(CONTAINER);
    // registry.json is missing; the restore adds the entry of this window.
    fs.rmSync(h.paths.registry, { force: true });
    h.service.reconcileInWorker.mockImplementation(async () => {
      await h.registry.add(env);
      return 1;
    });
    // OTHER_ACCOUNT signs in while the window checks the version of the container.
    h.docker.findContainer.mockImplementation(async () => {
      h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
      await h.controller.onSessionChanged();
      return containerInfo(String(CONTAINER_VERSION));
    });
    await h.controller.reconcileIfRegistryLost();
    // Plan step 11C3: in the background, the worker is made ready passively.
    expect(h.service.reconcileInWorker).toHaveBeenCalledWith({ passive: true });
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(warningMessages()).toEqual([Messages.otherAccountConnection('acme/api')]);
    await settle(() => tokenRemovals() > 0, 'the removal of the token');
    expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { environmentId: env.id, containerName: CONTAINER }, { timeoutMs: 60_000 });
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
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
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

  it('takes the token of the owner out of the container when the account changes, not on a hand-off', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await run('stop', row('acme/api', env));
    expect(h.connection.closeRemoteConnection).toHaveBeenCalledTimes(1);
    expect(tokenRemovals()).toBe(0);

    recreateHarness({});
    await h.registry.add(env);
    await connectHere(env);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => tokenRemovals() > 0, 'the removal of the token');
    expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { environmentId: env.id, containerName: CONTAINER }, { timeoutMs: 60_000 });
  });

  // Greenfield (user decision 2026-09-27): the token is only in the memory of the dev container; there is no removal
  // from the volume any more. Plan step 11B1: changed, the removal is a flow of the worker (the flow itself:
  // src/core/worker/tokenRemoveFlow.test.ts); the controller sends it and logs what it answered.
  describe('the removal of the token from the running container (concept 7.5)', () => {
    const VOLUME = 'devenv-acme-api-volume';

    async function takeTokenOut(): Promise<void> {
      const env = environment({ owner: OTHER_ACCOUNT, volumeName: VOLUME });
      await h.registry.add(env);
      await h.controller.openAttachedWindow(env, CONTAINER, undefined);
      await settle(() => tokenRemovals() > 0, 'the removal of the token');
    }

    it('sends the flow to the worker of the engine, with the environment and the container', async () => {
      await takeTokenOut();
      expect(h.flow).toHaveBeenCalledTimes(1);
      // Review round 1 of plan step 11B1 (A-R1-5): the removal is bounded, as the docker exec was before.
      expect(h.flow).toHaveBeenCalledWith(OP_TOKEN_REMOVE, { environmentId: ENV_ID, containerName: CONTAINER }, { timeoutMs: 60_000 });
      expect(h.docker.exec).not.toHaveBeenCalled();
      expect(h.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('GitHub token could not be removed'));
    });

    it('warns when the flow fails, and when it answers with an invalid value', async () => {
      h.flow.mockRejectedValueOnce(new Error('/run/devenv/github-token could not be removed.'));
      await takeTokenOut();
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^The GitHub token could not be removed from the container ${CONTAINER}: .*github-token could not be removed`)),
      );
      recreateHarness({});
      h.flow.mockResolvedValueOnce({ outcome: 'maybe' });
      await takeTokenOut();
      expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('answered the token removal with an invalid value'));
    });

    it('takes `notRunning` as an answer, without a warning (review round 1 of 11B1, B-R1-16)', async () => {
      h.flow.mockResolvedValueOnce({ outcome: 'notRunning' });
      await takeTokenOut();
      expect(h.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('GitHub token could not be removed'));
    });

    it('warns when this window runs no flow (review round 1 of 11B1, A-R1-9)', async () => {
      recreateHarness({ noFlow: true });
      const env = environment({ owner: OTHER_ACCOUNT, volumeName: VOLUME });
      await h.registry.add(env);
      await h.controller.openAttachedWindow(env, CONTAINER, undefined);
      await settle(() => h.logger.warn.mock.calls.some((call) => String(call[0]).includes('runs no flow in a worker')), 'the warning');
    });

    it('runs no flow on another Docker host', async () => {
      recreateHarness({
        dockerTargets: {
          current: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }),
          resolve: async () => ({ kind: 'remote', host: 'build-box', endpoint: 'ssh://build-box' }),
          withOperation: async (_target: unknown, run: () => Promise<unknown>) => run(),
        } as unknown as NonNullable<Parameters<typeof createHarness>[0]>['dockerTargets'],
      });
      const env = environment({ owner: OTHER_ACCOUNT, volumeName: VOLUME });
      await h.registry.add(env);
      await h.controller.openAttachedWindow(env, CONTAINER, undefined);
      await settle(() => h.logger.info.mock.calls.some((call) => String(call[0]).includes('is on another Docker host')), 'the log line');
      expect(h.flow).not.toHaveBeenCalled();
    });
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
    await settle(() => tokenRemovals() >= 2, 'the second removal of the token');
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
    expect(warningMessages()).toEqual([Messages.otherAccount('acme/api')]);
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
    expect(warningMessages()).toEqual([Messages.otherAccount('acme/api')]);
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
    expect(warningMessages()).toEqual([Messages.otherAccount('acme/api')]);
  });

  describe('a repository command while GitHub rejects the token, when another account signs in at the new sign-in', () => {
    // The rejected session still names ACCOUNT (auth.ts: getAccount asks for no new sign-in); the session with a working
    // token, which the new sign-in gives, belongs to OTHER_ACCOUNT.
    beforeEach(async () => {
      await h.registry.add(environment());
      h.auth.getSession.mockImplementation(async (options?: { interactive: boolean }) => {
        if (!options?.interactive) return { token: 'gho_rejected', account: ACCOUNT };
        h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
        h.auth.getToken.mockResolvedValue('gho_other');
        return { token: 'gho_other', account: OTHER_ACCOUNT };
      });
      // The pipeline creates the environment of the account of its session.
      h.service.open.mockResolvedValue(openResult(environment({ id: OTHER_ENV_ID, owner: OTHER_ACCOUNT })));
    });

    it('Start of the repository uses the environment of the new account, not the one of the account before', async () => {
      await run('start', row('acme/api'));
      expect(h.auth.getSession).toHaveBeenCalledWith({ interactive: true });
      expect(h.service.openEnvironment).not.toHaveBeenCalled();
      expect(h.service.open).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.anything());
      expect(warningMessages()).not.toContain(Messages.otherAccount('acme/api'));
    });

    it('Search does the same', async () => {
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
      fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ repository: RepositoryInfo }>) => items[0]);
      await run('search');
      expect(h.service.openEnvironment).not.toHaveBeenCalled();
      expect(h.service.open).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.anything());
    });

    it('the repository choice of the switcher does the same', async () => {
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
      fakeVscode.window.showQuickPick.mockImplementation(
        async (items: Array<{ choice?: { kind: string }; repository?: RepositoryInfo }>) =>
          items.find((item) => item.choice?.kind === 'openRepository') ?? items.find((item) => item.repository?.nameWithOwner === 'acme/api'),
      );
      await run('switchEnvironment');
      expect(h.auth.getSession).toHaveBeenCalledWith({ interactive: true });
      expect(h.service.openEnvironment).not.toHaveBeenCalled();
      expect(h.service.open).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.anything());
      expect(warningMessages()).not.toContain(Messages.otherAccount('acme/api'));
    });

    it('Select configuration… of the repository creates the environment of the new account with the configuration', async () => {
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] }));
      fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ configPath: string }>) =>
        items.find((item) => item.configPath === '.devcontainer/python/devcontainer.json'),
      );
      await run('selectConfiguration', row('acme/api'));
      // Plan step 11B3b: changed expectation, the listing goes through the worker.
      expect(h.service.listConfigurationsInWorker).not.toHaveBeenCalled();
      expect(h.service.openEnvironment).not.toHaveBeenCalled();
      expect(h.service.open).toHaveBeenCalledWith(
        expect.objectContaining({ repository: 'acme/api' }),
        expect.objectContaining({ configPath: '.devcontainer/python/devcontainer.json' }),
      );
      expect(warningMessages()).not.toContain(Messages.otherAccount('acme/api'));
    });

    it('Try again of a Start that failed asks for the new sign-in before it chooses the environment', async () => {
      // The first try: the token works, the session belongs to ACCOUNT, and the pipeline fails.
      h.auth.getSession.mockImplementation(async () => ({ token: 'gho_token', account: ACCOUNT }));
      h.auth.getAccount.mockResolvedValue(ACCOUNT);
      h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
      // While the message shows, GitHub starts to reject the token; at the new sign-in, OTHER_ACCOUNT signs in.
      fakeVscode.window.showErrorMessage.mockImplementationOnce(async () => {
        h.auth.getSession.mockImplementation(async (options?: { interactive: boolean }) => {
          if (!options?.interactive) return { token: 'gho_rejected', account: ACCOUNT };
          h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
          return { token: 'gho_other', account: OTHER_ACCOUNT };
        });
        return Actions.tryAgain;
      });
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
      fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ repository: RepositoryInfo }>) => items[0]);
      await run('search');
      await settle(() => h.service.open.mock.calls.length === 1, 'Try again');
      expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
      expect(h.service.open).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/api' }), expect.anything());
      expect(warningMessages()).not.toContain(Messages.otherAccount('acme/api'));
    });

    it('Stop of the repository asks for no new sign-in (it needs no token)', async () => {
      await run('stop', row('acme/api'));
      expect(h.auth.getSession).not.toHaveBeenCalledWith({ interactive: true });
    });
  });

  // 2026-10-01: the Switch branch command was dropped (user decision).
  describe('Try again of a first open of Select configuration… after the account changed', () => {
    const OTHER_ENV = () =>
      environment({ id: OTHER_ENV_ID, owner: OTHER_ACCOUNT, containerName: 'devenv-acme-api-7c1d2e3f', volumeName: 'devenv-acme-api-7c1d2e3f' });

    beforeEach(async () => {
      // ACCOUNT has no environment of acme/api; OTHER_ACCOUNT has one.
      await h.registry.add(OTHER_ENV());
      h.sidebar.infos.set('acme/api', repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] }));
      h.service.open.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
      // While the message shows, OTHER_ACCOUNT signs in; then the user selects Try again.
      fakeVscode.window.showErrorMessage.mockImplementationOnce(async () => {
        h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
        h.auth.getToken.mockResolvedValue('gho_other');
        return Actions.tryAgain;
      });
    });

    it('rebuilds the environment of the account signed in now with the selected configuration', async () => {
      fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ configPath: string }>) =>
        items.find((item) => item.configPath === '.devcontainer/python/devcontainer.json'),
      );
      await run('selectConfiguration', row('acme/api'));
      await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'Try again');
      expect(h.service.openEnvironment).toHaveBeenCalledWith(
        OTHER_ENV_ID,
        expect.objectContaining({ configPath: '.devcontainer/python/devcontainer.json', forceRebuild: true }),
      );
    });
  });

  it('Try again of a first open of Select configuration… with the configuration of the environment of the new account already does nothing more', async () => {
    await h.registry.add(environment({ id: OTHER_ENV_ID, owner: OTHER_ACCOUNT, containerName: 'devenv-acme-api-7c1d2e3f', volumeName: 'devenv-acme-api-7c1d2e3f' }));
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api', { configPaths: ['.devcontainer/devcontainer.json', '.devcontainer/python/devcontainer.json'] }));
    h.service.open.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
    let retried = false;
    fakeVscode.window.showErrorMessage.mockImplementationOnce(async () => {
      h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
      h.auth.getToken.mockResolvedValue('gho_other');
      retried = true;
      return Actions.tryAgain;
    });
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ configPath: string }>) =>
      items.find((item) => item.configPath === '.devcontainer/devcontainer.json'),
    );
    await run('selectConfiguration', row('acme/api'));
    await settle(() => retried && h.logger.info.mock.calls.some((call: unknown[]) => String(call[0]).includes('uses the configuration')), 'Try again');
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.service.open).toHaveBeenCalledTimes(1);
  });

  it('offers no Try again of the command itself for an error', async () => {
    // Refresh has no Try again of its own: a failure reaches the error display of the command.
    h.sidebar.refreshDiscovery.mockRejectedValueOnce(new UserFacingError('helperFailed', Messages.helperFailed));
    await run('refresh');
    expect(fakeVscode.window.showErrorMessage.mock.calls).toEqual([[Messages.helperFailed, Actions.showDetails]]);
    expect(h.sidebar.refreshDiscovery).toHaveBeenCalledTimes(1);
  });
});

describe('the switch of the host access checks (concept section 9 "Host access", unit 10)', () => {
  /** The user settings of the section devEnvLauncher: `globalValue` of hostAccessChecksOff, and the writes. */
  function userSettings(globalValue?: unknown): { update: ReturnType<typeof vi.fn>; inspect: ReturnType<typeof vi.fn> } {
    const configuration = {
      inspect: vi.fn(() => ({ key: `${SETTINGS_SECTION}.hostAccessChecksOff`, globalValue, workspaceValue: ['acme/api'] })),
      update: vi.fn(async () => undefined),
    };
    fakeVscode.workspace.getConfiguration.mockReturnValue(configuration);
    return configuration;
  }

  it('Turn Off Host Access Checks… asks with a modal warning that names what becomes possible, then writes the user setting', async () => {
    const settings = userSettings(['me/dotfiles']);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.turnOffChecks);
    await run('turnOffHostAccessChecks', row('acme/api'));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]).toEqual([
      Messages.hostAccessChecksOffConfirm('acme/api'),
      { modal: true, detail: Messages.hostAccessChecksOffDetail },
      Actions.turnOffChecks,
    ]);
    for (const possible of ['bind mounts', 'Docker socket', 'privileged mode', 'devices and GPUs', 'all network addresses', 'volumes of other programs']) {
      expect(Messages.hostAccessChecksOffDetail).toContain(possible);
    }
    expect(fakeVscode.workspace.getConfiguration).toHaveBeenCalledWith(SETTINGS_SECTION);
    // Only the user value counts (the workspace value is not copied).
    expect(settings.update).toHaveBeenCalledWith('hostAccessChecksOff', ['me/dotfiles', 'acme/api'], fakeVscode.ConfigurationTarget.Global);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.hostAccessChecksTurnedOff('acme/api'));
  });

  it('Turn Off Host Access Checks… changes nothing when the warning is dismissed', async () => {
    const settings = userSettings(undefined);
    await run('turnOffHostAccessChecks', row('acme/api'));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(settings.update).not.toHaveBeenCalled();
  });

  it('Turn Off Host Access Checks… asks nothing when the checks are off already', async () => {
    const settings = userSettings(['acme/api']);
    h.settings.hostAccessChecksOff = ['acme/api'];
    await run('turnOffHostAccessChecks', row('acme/api'));
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(settings.update).not.toHaveBeenCalled();
  });

  it('Turn On Host Access Checks writes the user setting without a question', async () => {
    const settings = userSettings(['ACME/api', 'me/dotfiles']);
    h.settings.hostAccessChecksOff = ['ACME/api', 'me/dotfiles'];
    await run('turnOnHostAccessChecks', row('acme/api'));
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(settings.update).toHaveBeenCalledWith('hostAccessChecksOff', ['me/dotfiles'], fakeVscode.ConfigurationTarget.Global);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.hostAccessChecksTurnedOn('acme/api'));

    // The last entry: the user value is removed.
    const last = userSettings(['acme/api']);
    await run('turnOnHostAccessChecks', row('acme/api', environment()));
    expect(last.update).toHaveBeenCalledWith('hostAccessChecksOff', undefined, fakeVscode.ConfigurationTarget.Global);
  });

  it('Turn On Host Access Checks removes every name of a renamed repository: the name on GitHub and the registry name (A1)', async () => {
    // alice/tool was transferred to bob/tool on GitHub: the row shows bob/tool, the registry (and the pipeline) keep alice/tool.
    const env = environment({ repository: 'alice/tool' });
    await h.registry.add(env);
    const settings = userSettings(['alice/tool', 'me/dotfiles', 'Bob/Tool']);
    h.settings.hostAccessChecksOff = ['alice/tool', 'me/dotfiles', 'Bob/Tool'];
    await run('turnOnHostAccessChecks', row('bob/tool', env));
    expect(settings.update).toHaveBeenCalledWith('hostAccessChecksOff', ['me/dotfiles'], fakeVscode.ConfigurationTarget.Global);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(Messages.hostAccessChecksTurnedOn('bob/tool'));

    // Only the registry name is listed: it is removed as well.
    const registryOnly = userSettings(['alice/tool']);
    await run('turnOnHostAccessChecks', row('bob/tool', env));
    expect(registryOnly.update).toHaveBeenCalledWith('hostAccessChecksOff', undefined, fakeVscode.ConfigurationTarget.Global);
  });

  it('Turn Off Host Access Checks… on a renamed repository writes the registry name, which the open pipeline reads (A1)', async () => {
    const env = environment({ repository: 'alice/tool' });
    await h.registry.add(env);
    const settings = userSettings(undefined);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.turnOffChecks);
    await run('turnOffHostAccessChecks', row('bob/tool', env));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]?.[0]).toBe(Messages.hostAccessChecksOffConfirm('bob/tool'));
    expect(settings.update).toHaveBeenCalledWith('hostAccessChecksOff', ['alice/tool'], fakeVscode.ConfigurationTarget.Global);
  });

  // Review finding R2-1: "already off" is decided under the pipeline key (the registry name) only; it was "either name"
  // after finding A1, which answered "already off" while the pipeline still had the checks on.
  it('Turn Off Host Access Checks… decides "already off" by the registry name of a renamed repository (A1, R2-1)', async () => {
    const env = environment({ repository: 'alice/tool' });
    await h.registry.add(env);
    let settings = userSettings(['alice/tool']);
    h.settings.hostAccessChecksOff = ['alice/tool'];
    await run('turnOffHostAccessChecks', row('bob/tool', env));
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(settings.update).not.toHaveBeenCalled();

    // Only the GitHub name is listed: the pipeline has the checks on, so Turn Off asks and writes the registry name.
    settings = userSettings(['bob/tool']);
    h.settings.hostAccessChecksOff = ['bob/tool'];
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.turnOffChecks);
    await run('turnOffHostAccessChecks', row('bob/tool', env));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(settings.update).toHaveBeenCalledTimes(1);
    expect(settings.update.mock.calls[0]?.[1]).toEqual(['bob/tool', 'alice/tool']);
  });

  it('needs a row: without an argument, nothing is written', async () => {
    const settings = userSettings(undefined);
    await run('turnOffHostAccessChecks');
    await run('turnOnHostAccessChecks');
    expect(settings.update).not.toHaveBeenCalled();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('offers the commands in the context menu of repository rows only by their flags, and not in the Command Palette', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        menus: Record<string, Array<{ command?: string; when?: string }>>;
        configuration: { properties: Record<string, { scope?: string; default?: unknown }> };
      };
    };
    const menus = manifest.contributes.menus;
    const when = (menu: string, command: string) => menus[menu].filter((item) => item.command === command).map((item) => item.when);
    expect(when('view/item/context', Commands.turnOffHostAccessChecks)).toEqual(['view == devEnvironments.repositories && viewItem =~ /hostAccessChecked/']);
    expect(when('view/item/context', Commands.turnOnHostAccessChecks)).toEqual(['view == devEnvironments.repositories && viewItem =~ /hostAccessUnrestricted/']);
    expect(when('devEnvironments.more', Commands.turnOffHostAccessChecks)).toEqual(['viewItem =~ /hostAccessChecked/']);
    expect(when('devEnvironments.more', Commands.turnOnHostAccessChecks)).toEqual(['viewItem =~ /hostAccessUnrestricted/']);
    expect(when('commandPalette', Commands.turnOffHostAccessChecks)).toEqual(['false']);
    expect(when('commandPalette', Commands.turnOnHostAccessChecks)).toEqual(['false']);
    // A workspace or folder setting cannot turn a check off.
    expect(manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.hostAccessChecksOff`]).toMatchObject({ scope: 'application', default: [] });
  });

  const unrestricted: ContainerInfo = {
    ...containerInfo(String(CONTAINER_VERSION)),
    labels: { [LABEL_CONTAINER_VERSION]: String(CONTAINER_VERSION), 'nimblescape.devenv.host-access': 'unrestricted' },
  };

  it('role A: closes the connection to a container of the checks-off time when the checks are on and the pipeline refused', async () => {
    const env = environment();
    await h.registry.add(env);
    h.docker.findContainer.mockResolvedValue(unrestricted);
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('hostAccess', Messages.hostAccess('privileged mode')));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    expect(warningMessages()).toContain(ControllerTexts.unrestrictedContainerClosed('acme/api'));
    expect(warningMessages()).not.toContain(ControllerTexts.outdatedContainerClosed('acme/api'));
  });

  it('role A: keeps a container of the checks-off time while the checks stay off', async () => {
    h.settings.hostAccessChecksOff = ['acme/api'];
    const env = environment();
    await h.registry.add(env);
    h.docker.findContainer.mockResolvedValue(unrestricted);
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('hostAccess', Messages.hostAccess('variable GH_TOKEN in containerEnv')));
    await h.controller.openAttachedWindow(env, CONTAINER, undefined);
    expect(h.statusBar.showConnectionLost).toHaveBeenCalledWith('acme/api', ENV_ID);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
  });
});

describe('Start in a new window (unit 14, concept 6.2, 7.9, 8)', () => {
  const web = (): Environment =>
    environment({
      id: 'b1c2d3e4-0000-4000-8000-000000000002',
      repository: 'acme/web',
      containerName: 'web',
      volumeName: 'web',
      remoteWorkspaceFolder: '/workspaces/web',
    });

  it('Start in New Window runs the pipeline, writes the pending connection file of this window, and opens a new window', async () => {
    const env = environment();
    await h.registry.add(env);
    await run('startInNewWindow', row('acme/api', env));
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.coordinator.writePending).toHaveBeenCalledWith(ENV_ID);
    // The window that ran the pipeline wrote the pending connection file: the container is in use until the new window
    // has written its status file.
    expect(await h.sessionFiles.readPendings()).toEqual([{ environmentId: ENV_ID, windowId: WINDOW_ID, createdAt: iso(NOW) }]);
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('keeps the environment of this window: this window does not take the new environment as its own', async () => {
    const own = environment();
    await h.registry.add(own);
    await h.registry.add(web());
    await connectHere(own);
    h.coordinator.setEnvironment.mockClear();
    h.statusBar.showConnected.mockClear();
    await run('startInNewWindow', row('acme/web', web()));
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith('web', '/workspaces/web');
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    expect(h.coordinator.setEnvironment).not.toHaveBeenCalled();
    expect(h.statusBar.showConnected).not.toHaveBeenCalled();
    // A later Start of the own environment in this window still finds it connected here.
    await run('start', row('acme/api', own));
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
  });

  it('opens a new repository (first open) in a new window', async () => {
    const info = repositoryInfo('acme/api');
    h.sidebar.infos.set('acme/api', info);
    h.service.open.mockImplementation(async () => {
      const env = environment();
      await h.registry.add(env);
      return openResult(env);
    });
    await run('startInNewWindow', row('acme/api', undefined, info));
    expect(h.service.open).toHaveBeenCalledTimes(1);
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('opens a new window also from an empty window, because the user asked for it', async () => {
    await h.registry.add(environment());
    h.connection.isEmptyWindow.mockReturnValue(true);
    await run('startInNewWindow', row('acme/api', environment()));
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('plain Start uses this window by default', async () => {
    await h.registry.add(environment());
    await run('start', row('acme/api', environment()));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
  });

  it('with the setting openInNewWindow, plain Start opens a new window and Start in Current Window uses this one', async () => {
    h.settings.openInNewWindow = true;
    await h.registry.add(environment());
    await h.registry.add(web());
    await run('start', row('acme/api', environment()));
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.open).not.toHaveBeenCalled();
    await run('startInCurrentWindow', row('acme/web', web()));
    expect(h.connection.open).toHaveBeenCalledWith('web', '/workspaces/web');
    expect(h.connection.openInNewWindow).toHaveBeenCalledTimes(1);
  });

  it('with the setting openInNewWindow, plain Start in an empty window uses the empty window', async () => {
    h.settings.openInNewWindow = true;
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.registry.add(environment());
    await run('start', row('acme/api', environment()));
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
  });

  it('shows the other window instead of a second connection when another window uses the environment', async () => {
    const env = environment();
    await h.registry.add(env);
    otherWindowConnected();
    await run('startInNewWindow', row('acme/api', env));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    // Review of unit 14: a request for a new window never uses the current window, also here. VS Code shows the window
    // that has this folder open (concept 7.11); if it did not find it, a new window opens and this one stays.
    expect(h.connection.open).not.toHaveBeenCalled();
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('shows the other window with the current-window call for plain Start', async () => {
    const env = environment();
    await h.registry.add(env);
    otherWindowConnected();
    await run('start', row('acme/api', env));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('opens no second window for the environment of this window', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await run('startInNewWindow', row('acme/api', env));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.alreadyConnected('acme/api'));
  });

  it('reconnects this window when its own container does not run, also with the setting openInNewWindow', async () => {
    h.settings.openInNewWindow = true;
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    h.docker.containerState.mockResolvedValue('stopped');
    pipelineStartsContainer(); // User decision 2026-09-28: the window connects only to a running container.
    await run('startInNewWindow', { environmentId: ENV_ID });
    expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
  });

  it('a new window neither skips nor is skipped by the connection of this window', async () => {
    await h.registry.add(environment());
    await h.registry.add(web());
    const api = deferred<OpenResult>();
    h.service.openEnvironment.mockImplementation(async (id: string) => (id === ENV_ID ? api.promise : openResult(web())));
    const first = run('start', row('acme/api', environment()));
    await settle(() => h.service.openEnvironment.mock.calls.length === 1, 'the first pipeline');
    await run('startInNewWindow', row('acme/web', web()));
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith('web', '/workspaces/web');
    api.resolve(openResult(environment()));
    await first;
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('removes the pending connection file and opens no window when the user cancels', async () => {
    const env = environment();
    await h.registry.add(env);
    const progress = cancellableProgress();
    h.service.openEnvironment.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      progress.cancel();
      return openResult(env);
    });
    await run('startInNewWindow', row('acme/api', env));
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
    expect(await h.sessionFiles.readPendings()).toEqual([]);
  });

  it('Try again after a failure opens a new window again', async () => {
    await h.registry.add(environment());
    h.service.openEnvironment.mockRejectedValueOnce(new UserFacingError('buildFailed', Messages.buildFailed, 'log'));
    fakeVscode.window.showErrorMessage.mockResolvedValueOnce(Actions.tryAgain);
    await run('startInNewWindow', row('acme/api', environment()));
    await settle(() => h.connection.openInNewWindow.mock.calls.length === 1, 'the new window of Try again');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('the switcher for a new window opens the selected environment in a new window', async () => {
    await h.registry.add(environment());
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ choice?: { kind: string } }>) =>
      items.find((item) => item.choice?.kind === 'environment'),
    );
    await run('switchEnvironmentInNewWindow');
    const options = fakeVscode.window.showQuickPick.mock.calls[0][1] as { placeHolder?: string };
    expect(options.placeHolder).toBe('Select an environment to open in a new window');
    expect(h.connection.openInNewWindow).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('with the setting openInNewWindow, the switcher for the current window uses this window', async () => {
    h.settings.openInNewWindow = true;
    await h.registry.add(environment());
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ choice?: { kind: string } }>) =>
      items.find((item) => item.choice?.kind === 'environment'),
    );
    await run('switchEnvironmentInCurrentWindow');
    const options = fakeVscode.window.showQuickPick.mock.calls[0][1] as { placeHolder?: string };
    expect(options.placeHolder).toBe('Select an environment to open in this window');
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
    expect(h.connection.openInNewWindow).not.toHaveBeenCalled();
  });

  it('role A in the new window: the pending connection file of the window that ran the pipeline means no second pipeline', async () => {
    const env = environment();
    await h.registry.add(env);
    // The file names the window that ran the pipeline, not this (new) window.
    await h.controller.openAttachedWindow(env, CONTAINER, { environmentId: ENV_ID, windowId: OTHER_WINDOW_ID, createdAt: iso(NOW - 5000) });
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.statusBar.showConnected).toHaveBeenCalled();
  });

  it('offers Start in New Window next to Start, or Start in Current Window while the setting is on (package.json)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
        configuration: { properties: Record<string, { scope?: string; default?: unknown; type?: string }> };
      };
    };
    const menus = manifest.contributes.menus;
    const entries = (menu: string, command: string) =>
      menus[menu].filter((item) => item.command === command).map((item) => [item.when, item.group]);
    // Review of unit 14: right after Start (1_actions@1), in a fixed order.
    expect(entries('view/item/context', Commands.startInNewWindow)).toEqual([
      ['view == devEnvironments.repositories && viewItem =~ /canStart/ && !config.devEnvLauncher.openInNewWindow', '1_actions@2'],
    ]);
    expect(entries('view/item/context', Commands.startInCurrentWindow)).toEqual([
      ['view == devEnvironments.repositories && viewItem =~ /canStart/ && config.devEnvLauncher.openInNewWindow', '1_actions@2'],
    ]);
    expect(entries('devEnvironments.more', Commands.startInNewWindow)).toEqual([
      ['viewItem =~ /canStart/ && !config.devEnvLauncher.openInNewWindow', '0_start@1'],
    ]);
    expect(entries('commandPalette', Commands.startInNewWindow)).toEqual([['!config.devEnvLauncher.openInNewWindow', undefined]]);
    expect(entries('commandPalette', Commands.startInCurrentWindow)).toEqual([['config.devEnvLauncher.openInNewWindow', undefined]]);
    expect(entries('commandPalette', Commands.switchEnvironmentInNewWindow)).toEqual([['!config.devEnvLauncher.openInNewWindow', undefined]]);
    expect(entries('commandPalette', Commands.switchEnvironmentInCurrentWindow)).toEqual([['config.devEnvLauncher.openInNewWindow', undefined]]);
    // Only the user settings decide which window a Start uses.
    expect(manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.openInNewWindow`]).toMatchObject({
      type: 'boolean',
      scope: 'application',
      default: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Unit 7: Docker on another computer through the Docker context.

describe('the Docker host of the current Docker context (unit 7)', () => {
  const REMOTE_ENV_ID = 'a1b2c3d4-0000-4000-8000-00000000000b';
  let current: DockerTarget;
  let operations: DockerTarget[];
  let resolves: number;
  let depth = 0;
  let remote: {
    useRemoteHost: ReturnType<typeof vi.fn>;
    useLocalDocker: ReturnType<typeof vi.fn>;
    chooseDockerHost: ReturnType<typeof vi.fn>;
    askAgain: ReturnType<typeof vi.fn>;
    offerSwitchBack: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    h.controller.dispose();
    fs.rmSync(h.root, { recursive: true, force: true });
    current = dockerTargetOf('unix:///var/run/docker.sock', 'default');
    operations = [];
    resolves = 0;
    depth = 0;
    remote = {
      useRemoteHost: vi.fn(async () => {}),
      useLocalDocker: vi.fn(async () => {}),
      chooseDockerHost: vi.fn(async () => {}),
      askAgain: vi.fn(async () => {}),
      offerSwitchBack: vi.fn(async () => false),
    };
    const dockerTargets = {
      resolve: vi.fn(async () => {
        resolves++;
        return current;
      }),
      // As DockerTargets.current: the target of the running operation, else a fresh read.
      current: vi.fn(async () => (depth > 0 ? operations[operations.length - 1] : current)),
      // As DockerTargets.withOperation: a nested operation keeps the target of the outer one, and the calls of the
      // operation see its target (runWithDockerTarget; review round 1, F4).
      withOperation: vi.fn(async <T,>(fn: () => Promise<T>): Promise<T> => {
        if (depth > 0) return fn();
        const target = current;
        operations.push(target);
        depth++;
        try {
          return await runWithDockerTarget(target, fn);
        } finally {
          depth--;
        }
      }),
    };
    h = createHarness({ dockerTargets: dockerTargets as unknown as ControllerDeps['dockerTargets'], remoteDocker: remote });
  });

  function remoteEnvironment(overrides: Partial<Environment> = {}): Environment {
    return environment({
      id: REMOTE_ENV_ID,
      containerName: 'devenv-acme-api-a1b2c3d4',
      volumeName: 'devenv-acme-api-a1b2c3d4',
      dockerHost: 'build-box',
      ...overrides,
    });
  }

  it('registers both commands and runs them without an operation of their own', async () => {
    await run('useRemoteDockerHost');
    await run('useLocalDocker');
    expect(remote.useRemoteHost).toHaveBeenCalledTimes(1);
    expect(remote.useLocalDocker).toHaveBeenCalledTimes(1);
    expect(operations).toEqual([]);
  });

  // User requests 2026-09-28: the choice of the Docker host (the command of the first row of the view); since "the icon
  // can then go away", no icon of the Docker host in the view's title bar.
  it('runs the choice of the Docker host without an operation, and shows no icon of the Docker host in the title bar', async () => {
    await run('chooseDockerHost');
    expect(remote.chooseDockerHost).toHaveBeenCalledTimes(1);
    // User decision 2026-09-28: Ask Again Before Changing the Docker Host, also without an operation.
    await run('askAgainDockerHost');
    expect(remote.askAgain).toHaveBeenCalledTimes(1);
    expect(operations).toEqual([]);
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: Array<{ command: string; icon?: string }>;
        menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
      };
    };
    const title = manifest.contributes.menus['view/title'];
    // User request 2026-09-28 ("the icon can then go away"): the first row of the list chooses the Docker host; the
    // title bar has no icon of the Docker host anymore, and the commands no icon.
    expect(title.filter((entry) => entry.command === 'devEnvironments.useRemoteDockerHost' || entry.command === 'devEnvironments.chooseDockerHost')).toEqual([]);
    const icons = Object.fromEntries(manifest.contributes.commands.map((command) => [command.command, command.icon]));
    expect(icons['devEnvironments.useRemoteDockerHost']).toBeUndefined();
    expect(icons['devEnvironments.chooseDockerHost']).toBeUndefined();
    expect(manifest.contributes.menus.commandPalette).toContainEqual({ command: 'devEnvironments.chooseDockerHost', when: 'false' });
  });

  it('runs every other command as one operation on the host that is current when it starts', async () => {
    await h.registry.add(environment());
    await run('stop', row('acme/api', environment()));
    expect(operations).toHaveLength(1);
    expect(h.service.stop).toHaveBeenCalledWith(ENV_ID);
  });

  it('Start of a repository uses the environment of the current host only (D-3 with the Docker host)', async () => {
    await h.registry.add(remoteEnvironment());
    h.sidebar.infos.set('acme/api', repositoryInfo('acme/api'));
    await run('start', row('acme/api', undefined, repositoryInfo('acme/api')));
    // The local Docker is current: the service opens the repository (a new environment), not the one on build-box.
    expect(h.service.open).toHaveBeenCalledTimes(1);
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
  });

  it('a restored window of the current host opens as before, without a question', async () => {
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    const env = remoteEnvironment();
    await h.registry.add(env);
    await h.controller.openAttachedWindow(env, env.containerName, undefined);
    expect(remote.offerSwitchBack).not.toHaveBeenCalled();
    expect(h.service.openEnvironment).toHaveBeenCalledWith(REMOTE_ENV_ID, expect.anything());
    expect(operations.map((target) => target.host)).toEqual(['build-box']);
  });

  // Round 2 (B1): the operation's context does not replace a context that the window names already (a user-made one).
  it('a restored window that names another working context keeps it, also inside the operation', async () => {
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    const env = remoteEnvironment();
    await h.registry.add(env);
    h.connection.currentContainerName.mockReturnValue(env.containerName);
    h.connection.currentDockerContext.mockReturnValue('my-build-box');
    await h.controller.openAttachedWindow(env, env.containerName, undefined);
    expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    // Greenfield, drop migration logic, user decision 2026-09-28: no check of reopenWithDockerContext (removed).
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('a restored window that names the context already stays as it is', async () => {
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    const env = remoteEnvironment();
    await h.registry.add(env);
    h.connection.currentContainerName.mockReturnValue(env.containerName);
    h.connection.currentDockerContext.mockReturnValue('devenv-remote-11111111');
    await h.controller.openAttachedWindow(env, env.containerName, undefined);
    // Greenfield, drop migration logic, user decision 2026-09-28: no check of reopenWithDockerContext (removed).
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  // Round 2 (B2): the status of the other window is read once; it closing meanwhile does not drop the context.
  it('uses the status of the other window that it decided on, not a second read', async () => {
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    await h.registry.add(remoteEnvironment());
    // Round 3 (C3): a context other than the operation's, and no pipeline, so only the other-window branch can pass.
    h.coordinator.otherActiveWindows.mockResolvedValueOnce([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, environmentId: REMOTE_ENV_ID, state: 'active', updatedAt: iso(NOW), dockerContext: 'my-build-box' },
    ]);
    h.coordinator.otherActiveWindows.mockResolvedValue([]);
    await run('start', row('acme/api', remoteEnvironment()));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.connection.open.mock.calls).toEqual([['devenv-acme-api-a1b2c3d4', '/workspaces/api', 'my-build-box']]);
  });

  // Review of the attach context (A2): the other window is shown by exactly its URI, with the context of its status file.
  it('shows the other window of a remote environment with the context that its status file names, or none', async () => {
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    await h.registry.add(remoteEnvironment());
    h.coordinator.otherActiveWindows.mockResolvedValue([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, environmentId: REMOTE_ENV_ID, state: 'active', updatedAt: iso(NOW), dockerContext: 'my-build-box' },
    ]);
    await run('start', row('acme/api', remoteEnvironment()));
    h.coordinator.otherActiveWindows.mockResolvedValue([
      { windowId: OTHER_WINDOW_ID, pid: OTHER_PID, environmentId: REMOTE_ENV_ID, state: 'active', updatedAt: iso(NOW) },
    ]);
    await run('start', row('acme/api', remoteEnvironment()));
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.connection.open.mock.calls).toEqual([
      ['devenv-acme-api-a1b2c3d4', '/workspaces/api', 'my-build-box'],
      ['devenv-acme-api-a1b2c3d4', '/workspaces/api'],
    ]);
  });

  /** DockerTargets as in the beforeEach: the operation runs on the target that is current when it starts. */
  function pinnedTargets(): ControllerDeps['dockerTargets'] {
    return {
      resolve: vi.fn(async () => current),
      current: vi.fn(async () => current),
      withOperation: vi.fn(async <T,>(fn: () => Promise<T>): Promise<T> => runWithDockerTarget(current, fn)),
    } as unknown as ControllerDeps['dockerTargets'];
  }

  // Review round 4 (test gaps): each step of windowArgs decides on its own.
  it('names the context of the operation, not the current one, when both are on the host', async () => {
    current = dockerTargetOf('ssh://build-box', 'my-build-box');
    await h.registry.add(remoteEnvironment());
    h.service.openEnvironment.mockImplementation(async (id: string) => {
      current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
      return openResult((await h.registry.get(id))!);
    });
    await run('start', row('acme/api', remoteEnvironment()));
    expect(h.connection.open).toHaveBeenCalledWith('devenv-acme-api-a1b2c3d4', '/workspaces/api', 'my-build-box');
  });

  it('the reload for the owner account keeps the context of the window (outside an operation)', async () => {
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    recreateHarness({ leaveCheckMs: 100, dockerTargets: pinnedTargets(), remoteDocker: remote });
    const env = remoteEnvironment();
    await h.registry.add(env);
    h.connection.currentContainerName.mockReturnValue(env.containerName);
    h.connection.currentDockerContext.mockReturnValue('my-build-box');
    await connectHere(env);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    h.auth.getAccount.mockResolvedValue(ACCOUNT);
    await h.controller.onSessionChanged();
    expect(h.connection.open).toHaveBeenCalledWith('devenv-acme-api-a1b2c3d4', '/workspaces/api', 'my-build-box');
  });

  it('the reload for the owner account names the created context when the current one is on another host', async () => {
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    recreateHarness({ leaveCheckMs: 100, dockerTargets: pinnedTargets(), remoteDocker: remote });
    const env = remoteEnvironment();
    await h.registry.add(env);
    h.connection.currentContainerName.mockReturnValue(env.containerName);
    h.connection.currentDockerContext.mockReturnValue('devenv-remote-11111111');
    await connectHere(env);
    h.connection.currentDockerContext.mockReturnValue(undefined);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    current = dockerTargetOf('unix:///var/run/docker.sock', 'default');
    h.auth.getAccount.mockResolvedValue(ACCOUNT);
    await h.controller.onSessionChanged();
    // User decisions 2026-10-03: the context named after the host (before: remoteContextName).
    expect(h.connection.open).toHaveBeenCalledWith('devenv-acme-api-a1b2c3d4', '/workspaces/api', remoteContextNames('build-box')[0]);
  });

  // Review of the attach context (A1): outside an operation, the context comes from this window's own authority, then
  // from the current context on that host, then from "Use a Remote Docker Host…". The own-authority step and the created
  // context are covered by the owner-account reload tests above.
  // Greenfield, drop migration logic, user decision 2026-09-28: checked through the reload for the owner account (before:
  // through the reopen of a restored window without a context, reopenWithDockerContext, which is removed).
  it('outside an operation names the current context on the host when the window names none', async () => {
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    recreateHarness({ leaveCheckMs: 100, dockerTargets: pinnedTargets(), remoteDocker: remote });
    const env = remoteEnvironment();
    await h.registry.add(env);
    h.connection.currentContainerName.mockReturnValue(env.containerName);
    await connectHere(env);
    h.connection.currentDockerContext.mockReturnValue(undefined);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    h.auth.getAccount.mockResolvedValue(ACCOUNT);
    await h.controller.onSessionChanged();
    expect(h.connection.open).toHaveBeenCalledWith('devenv-acme-api-a1b2c3d4', '/workspaces/api', 'devenv-remote-11111111');
  });

  // Greenfield, drop migration logic, user decision 2026-09-28: checked through the reload for the owner account (before:
  // through reopenWithDockerContext, which is removed).
  it('without a Docker target names the context that "Use a Remote Docker Host…" creates for the host', async () => {
    recreateHarness({ leaveCheckMs: 100 });
    const env = remoteEnvironment();
    await h.registry.add(env);
    h.connection.currentContainerName.mockReturnValue(env.containerName);
    await connectHere(env);
    h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
    await h.controller.onSessionChanged();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
    h.auth.getAccount.mockResolvedValue(ACCOUNT);
    await h.controller.onSessionChanged();
    // User decisions 2026-10-03: named after the host (`build-box`), created by ensureRemoteContext when missing.
    expect(h.connection.open).toHaveBeenCalledWith('devenv-acme-api-a1b2c3d4', '/workspaces/api', 'build-box');
    const calls = h.docker.run.mock.calls.map(([args]) => (args as string[]).join(' '));
    expect(calls).toContain('context ls --format {{json .}}');
    expect(calls).toContain(`context create build-box --description ${ownContextDescription('build-box')} --docker host=ssh://build-box`);
  });

  // User decisions 2026-10-03: the fallback of windowArgs is ensureRemoteContext with the Docker of the controller.
  describe('the context of the window from ensureRemoteContext (user decisions 2026-10-03)', () => {
    /** The answers of `docker context ls --format {{json .}}` for `contexts`; every other call succeeds. */
    function contextsAre(contexts: Array<{ Name: string; Description?: string; DockerEndpoint: string }>): void {
      h.docker.run.mockImplementation(async (args: readonly string[]) => ({
        exitCode: 0,
        stdout: args[0] === 'context' && args[1] === 'ls' ? contexts.map((context) => `${JSON.stringify(context)}\n`).join('') : '',
        stderr: '',
        timedOut: false,
      }));
    }

    async function reopen(): Promise<string[]> {
      const env = remoteEnvironment();
      await h.registry.add(env);
      h.connection.currentContainerName.mockReturnValue(env.containerName);
      await connectHere(env);
      h.auth.getAccount.mockResolvedValue(OTHER_ACCOUNT);
      await h.controller.onSessionChanged();
      await settle(() => h.connection.closeRemoteConnection.mock.calls.length === 1, 'the close');
      h.auth.getAccount.mockResolvedValue(ACCOUNT);
      await h.controller.onSessionChanged();
      return h.docker.run.mock.calls.map(([args]) => (args as string[]).join(' ')).filter((call) => call.startsWith('context create'));
    }

    it('uses a context of the user that points to the host as it is', async () => {
      recreateHarness({ leaveCheckMs: 100 });
      contextsAre([{ Name: 'default', DockerEndpoint: 'unix:///var/run/docker.sock' }, { Name: 'build-box', Description: 'mine', DockerEndpoint: 'ssh://build-box' }]);
      expect(await reopen()).toEqual([]);
      expect(h.connection.open).toHaveBeenCalledWith('devenv-acme-api-a1b2c3d4', '/workspaces/api', 'build-box');
    });

    it('creates the name with the pair of the host when a context with the name points elsewhere', async () => {
      recreateHarness({ leaveCheckMs: 100 });
      contextsAre([{ Name: 'build-box', Description: 'mine', DockerEndpoint: 'ssh://me@elsewhere' }]);
      const pair = remoteContextNames('build-box')[1];
      expect(await reopen()).toEqual([`context create ${pair} --description ${ownContextDescription('build-box')} --docker host=ssh://build-box`]);
      expect(h.connection.open).toHaveBeenCalledWith('devenv-acme-api-a1b2c3d4', '/workspaces/api', pair);
    });
  });

  it('a restored window of another host asks "Use <host> again?"; declined, it runs nothing and closes its connection', async () => {
    const env = remoteEnvironment();
    await h.registry.add(env);
    fakeVscode.window.showWarningMessage.mockResolvedValue(undefined);
    await h.controller.openAttachedWindow(env, env.containerName, undefined);
    expect(remote.offerSwitchBack).toHaveBeenCalledWith('build-box', current);
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.docker.exec).not.toHaveBeenCalled();
    await settle(() => h.connection.closeRemoteConnection.mock.calls.length > 0, 'the close of the connection');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(Messages.otherDockerHost('acme/api', 'build-box', ''));
    expect(h.coordinator.setEnvironment).toHaveBeenCalledWith(null);
  });

  it('a restored window of another host continues after the switch back', async () => {
    const env = remoteEnvironment();
    await h.registry.add(env);
    remote.offerSwitchBack.mockImplementation(async () => {
      current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
      return true;
    });
    await h.controller.openAttachedWindow(env, env.containerName, undefined);
    expect(h.service.openEnvironment).toHaveBeenCalledWith(REMOTE_ENV_ID, expect.anything());
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    // The pipeline runs on the host that the switch selected.
    expect(operations.map((target) => target.host)).toEqual(['build-box']);
  });

  it('role B: a pending operation of another host is not run; the reopen rule skips its environment', async () => {
    await h.registry.add(remoteEnvironment());
    h.connection.isEmptyWindow.mockReturnValue(true);
    await h.sessionFiles.writeOperation({
      environmentId: REMOTE_ENV_ID,
      operation: 'stop',
      requestedAt: iso(NOW - 5000),
      requestedBy: 'old-window',
      reason: 'manual',
    });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.stop).not.toHaveBeenCalled();
    expect(h.logger.info).toHaveBeenCalledWith(`The pending stop of ${REMOTE_ENV_ID} is for another Docker host. It is not run.`);

    await h.sessionFiles.removeOperation(REMOTE_ENV_ID).catch(() => {});
    h.sessionFiles.writeReopenSync({ environmentId: REMOTE_ENV_ID, closedAt: iso(NOW - 60_000) });
    await h.controller.runEmptyWindowTasks();
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('reads the Docker context again for the next operation (a switch while VS Code runs takes effect)', async () => {
    await h.registry.add(environment());
    await run('stop', row('acme/api', environment()));
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    await run('stop', row('acme/api', environment()));
    expect(operations.map((target) => target.host)).toEqual(['', 'build-box']);
  });

  // User decision 2026-09-28: the window connects only when the current Docker context is the environment's host and
  // the container runs, and the log shows which Docker the Dev Containers extension will ask.
  it('does not connect the window when the Docker context changed to another host during the start', async () => {
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    await h.registry.add(remoteEnvironment());
    h.service.openEnvironment.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      current = dockerTargetOf('unix:///var/run/docker.sock', 'default');
      return openResult((await h.registry.get(id))!);
    });
    await run('start', row('acme/api', remoteEnvironment()));
    // Review round 3 (H2): the message of this path says that the container stays and how to switch back.
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]?.[0]).toBe(Messages.otherDockerHostAfterStart('acme/api', 'build-box', ''));
    // Review round 1 (F2): the pending connection file of the pipeline is removed.
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  // User report 2026-09-28: without the context in the authority, the Dev Containers extension asks the local Docker
  // first and reports the container of a remote environment as one that "no longer exists".
  it('names the Docker context of the operation in the window of a remote environment', async () => {
    current = dockerTargetOf('ssh://build-box', 'my-build-box');
    await h.registry.add(remoteEnvironment());
    await run('start', row('acme/api', remoteEnvironment()));
    expect(h.connection.open).toHaveBeenCalledWith('devenv-acme-api-a1b2c3d4', '/workspaces/api', 'my-build-box');
  });

  it('names no context when DOCKER_HOST decides the remote host (the Dev Containers extension follows it too)', async () => {
    current = dockerTargetOf('ssh://build-box', undefined);
    await h.registry.add(remoteEnvironment());
    await run('start', row('acme/api', remoteEnvironment()));
    expect(h.connection.open.mock.calls[0]).toEqual(['devenv-acme-api-a1b2c3d4', '/workspaces/api']);
  });

  it('names no context in the window of a local environment', async () => {
    await h.registry.add(environment());
    await run('start', row('acme/api', environment()));
    expect(h.connection.open.mock.calls[0]).toEqual([CONTAINER, '/workspaces/api']);
  });

  // Review round 3 (H1): the check reads the current context itself, although the operation's calls are pinned to its
  // own context (DOCKER_CONTEXT), with the real DockerTargets.
  it('does not connect the window when the current context changed during the start (real DockerTargets)', async () => {
    const endpoints: Record<string, string> = { 'devenv-remote-11111111': 'ssh://build-box', default: 'unix:///var/run/docker.sock' };
    let currentContext = 'devenv-remote-11111111';
    const cli = {
      isInstalled: () => true,
      // As ContainerAdapter.run: the context of the running operation (DOCKER_CONTEXT) wins over the current one.
      run: vi.fn(async (_args: readonly string[]) => {
        const name = operationDockerTarget()?.context ?? currentContext;
        return { exitCode: 0, stdout: JSON.stringify({ Name: name, Endpoints: { docker: { Host: endpoints[name] } } }), stderr: '', timedOut: false };
      }),
    };
    recreateHarness({ dockerTargets: new DockerTargets(cli, {}, silentLogger, 'linux'), remoteDocker: remote });
    await h.registry.add(remoteEnvironment());
    h.service.openEnvironment.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      currentContext = 'default';
      return openResult((await h.registry.get(id))!);
    });
    await run('start', row('acme/api', remoteEnvironment()));
    expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]?.[0]).toBe(Messages.otherDockerHostAfterStart('acme/api', 'build-box', ''));
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('does not connect the window when the container does not run after the start', async () => {
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    await h.registry.add(remoteEnvironment());
    h.docker.containerState.mockResolvedValue('stopped');
    h.service.openEnvironment.mockImplementation(async (id: string) => {
      await h.sessionFiles.writePending(id, WINDOW_ID);
      return openResult((await h.registry.get(id))!);
    });
    await run('start', row('acme/api', remoteEnvironment()));
    expect(h.service.openEnvironment).toHaveBeenCalledTimes(1);
    // Review round 1 (F2): the pending connection file of the pipeline is removed.
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(h.docker.containerState.mock.calls.filter(([name]) => name === 'devenv-acme-api-a1b2c3d4').length).toBeGreaterThanOrEqual(5);
    expect(fakeVscode.window.showErrorMessage.mock.calls[0]?.[0]).toBe(Messages.containerNotReady('acme/api', 'devenv-acme-api-a1b2c3d4'));
    expect(h.coordinator.writePending).not.toHaveBeenCalled();
    expect(h.connection.open).not.toHaveBeenCalled();
  });

  it('logs the current context and both inspects before the window connects', async () => {
    current = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
    await h.registry.add(remoteEnvironment());
    await run('start', row('acme/api', remoteEnvironment()));
    // User report 2026-09-28: the window of a remote environment names the Docker context of its operation.
    expect(h.connection.open).toHaveBeenCalledWith('devenv-acme-api-a1b2c3d4', '/workspaces/api', 'devenv-remote-11111111');
    const calls = h.docker.run.mock.calls.map(([args]) => (args as string[]).join(' '));
    expect(calls).toContain('context show');
    expect(calls).toContain('inspect --type container /devenv-acme-api-a1b2c3d4 --format {{.Id}} {{.State.Status}}');
    // Review round 1 (F4): the context that the operation used (here `devenv-remote-11111111`), not a derived name.
    expect(calls).toContain('--context devenv-remote-11111111 inspect --type container /devenv-acme-api-a1b2c3d4 --format {{.Id}} {{.State.Status}}');
    const logged = h.logger.info.mock.calls.map(([line]) => String(line));
    expect(logged.some((line) => line.startsWith('Before the window connects: Current Docker context:'))).toBe(true);
  });
});

// Unit 7, PR 2: Close and Keep Running closes the window; the container keeps running this time.
describe('Close and Keep Running (unit 7, PR 2)', () => {
  const REMOTE_TARGET = dockerTargetOf('ssh://build-box', 'devenv-remote-11111111');
  let current: DockerTarget;
  let sendHeartbeat: ReturnType<typeof vi.fn<(environmentId: string) => Promise<{ ok: true } | { ok: false; detail: string }>>>;
  const order: string[] = [];

  /** Plan step 8, PR A: the harness with a Session Monitor on every engine; `target` is the current Docker target. */
  function monitorHarness(target: DockerTarget, options: { leaveCheckMs?: number } = {}): void {
    current = target;
    order.length = 0;
    sendHeartbeat = vi.fn(async (id: string) => {
      // The flag is stored before the heartbeat reads it (WindowHeartbeats.sendFor reads the registry).
      order.push(`heartbeat ${id} ${(await h.registry.get(id))?.keepRunningOnce === true ? 'kept' : 'not kept'}`);
      return { ok: true as const };
    });
    const dockerTargets = {
      resolve: vi.fn(async () => current),
      current: vi.fn(async () => current),
      withOperation: vi.fn(async <T,>(fn: () => Promise<T>): Promise<T> => fn()),
    };
    recreateHarness({
      dockerTargets: dockerTargets as unknown as ControllerDeps['dockerTargets'],
      sessionMonitor: { sendHeartbeat },
      leaveCheckMs: options.leaveCheckMs,
    });
    h.connection.closeWindow.mockImplementation(async () => {
      order.push('close');
    });
    // Review of the attach context (A3): a window of this version names the context of its host in its authority.
    if (target.kind === 'remote') h.connection.currentDockerContext.mockReturnValue('devenv-remote-11111111');
  }

  function remoteHarness(options: { leaveCheckMs?: number } = {}): void {
    monitorHarness(REMOTE_TARGET, options);
  }

  const LOCAL_TARGET = dockerTargetOf('unix:///var/run/docker.sock', 'default');

  it('says so in a window without an environment, and changes nothing', async () => {
    await h.registry.add(environment());
    await run('closeAndKeepRunning');
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ControllerTexts.closeAndKeepRunningNotConnected);
    expect(h.connection.closeWindow).not.toHaveBeenCalled();
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
  });

  // Changed expectation, plan step 8 PR A: on the local Docker too, one heartbeat with the keep flag goes to the Session
  // Monitor of the engine first (before: no heartbeat for a local environment).
  it('local environment: sends one heartbeat with the keep flag first, then closes the window', async () => {
    monitorHarness(LOCAL_TARGET);
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning');
    expect((await h.registry.get(ENV_ID))?.keepRunningOnce).toBe(true);
    expect(sendHeartbeat).toHaveBeenCalledWith(ENV_ID);
    expect(order).toEqual([`heartbeat ${ENV_ID} kept`, 'close']);
    expect(h.connection.closeWindow).toHaveBeenCalledTimes(1);
    expect(h.connection.closeRemoteConnection).not.toHaveBeenCalled();
    // The row argument of the context menu does not matter: the command acts on the environment of this window.
    expect(h.service.stop).not.toHaveBeenCalled();
  });

  it('remote environment: sends one heartbeat with the keep flag first, then closes the window', async () => {
    remoteHarness();
    const env = environment({ dockerHost: 'build-box' });
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning', row('acme/api', env));
    // Changed expectation, plan step 8 PR A: WindowHeartbeats.sendFor takes the seq itself before it reads the flag, which
    // is stored before (review round 2 of PR #39, L1).
    expect(sendHeartbeat).toHaveBeenCalledWith(ENV_ID);
    expect(order).toEqual([`heartbeat ${ENV_ID} kept`, 'close']);
    expect((await h.registry.get(ENV_ID))?.keepRunningOnce).toBe(true);
  });

  it('remote environment: when the host cannot be reached, clears the flag, says so, and the window stays open', async () => {
    remoteHarness();
    h.settings.stopAfterMinutes = 15;
    sendHeartbeat.mockResolvedValue({ ok: false, detail: 'ssh: connect to host build-box port 22: Connection timed out' });
    const env = environment({ dockerHost: 'build-box' });
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning');
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
    expect(h.connection.closeWindow).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(
      'The Docker host build-box cannot be reached. The container would stop after 15 minutes without contact. The window stays open.',
    );
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Connection timed out'));
  });

  it('remote environment while Docker is set to another host: refused, nothing changed', async () => {
    remoteHarness();
    const env = environment({ dockerHost: 'build-box' });
    await h.registry.add(env);
    await connectHere(env);
    current = dockerTargetOf('unix:///var/run/docker.sock', 'default');
    await run('closeAndKeepRunning');
    expect(warningMessages()).toContain(Messages.otherDockerHost('acme/api', 'build-box', ''));
    expect(sendHeartbeat).not.toHaveBeenCalled();
    expect(h.connection.closeWindow).not.toHaveBeenCalled();
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
  });

  // Plan step 8, PR A: the same rules on the local Docker.
  it('local environment: when the Session Monitor cannot be reached, clears the flag, says so, and the window stays open', async () => {
    monitorHarness(LOCAL_TARGET);
    sendHeartbeat.mockResolvedValue({ ok: false, detail: 'The Session Monitor could not be started again: image not found' });
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning');
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
    expect(h.connection.closeWindow).not.toHaveBeenCalled();
    expect(fakeVscode.window.showErrorMessage).toHaveBeenCalledWith(
      'The Session Monitor of the local Docker cannot be reached. The container would stop after 10 minutes without contact. The window stays open.',
    );
  });

  it('local environment while Docker is set to a remote host: refused, nothing changed', async () => {
    monitorHarness(LOCAL_TARGET);
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    current = REMOTE_TARGET;
    await run('closeAndKeepRunning');
    expect(warningMessages()).toContain(Messages.otherDockerHost('acme/api', '', 'build-box'));
    expect(sendHeartbeat).not.toHaveBeenCalled();
    expect(h.connection.closeWindow).not.toHaveBeenCalled();
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
  });

  it('refuses without a Session Monitor in this window, and clears the flag', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning');
    expect(h.connection.closeWindow).not.toHaveBeenCalled();
    expect(await h.registry.get(ENV_ID)).not.toHaveProperty('keepRunningOnce');
  });

  // Review round 1 of PR #39 (F1): closeWindow resolves when the close starts, not after the dialog about unsaved files.
  it('keeps the flag when the window stays open (Cancel in the dialog about unsaved files), until the next connect', async () => {
    // Changed fixture, plan step 8 PR A: with the Session Monitor of the local Docker (every engine needs its heartbeat).
    monitorHarness(LOCAL_TARGET, { leaveCheckMs: 10 });
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await run('closeAndKeepRunning');
    await pause(50);
    expect((await h.registry.get(ENV_ID))?.keepRunningOnce).toBe(true);
    expect(h.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('stayed open'));
  });

  it('a window that connects to the environment again clears the flag', async () => {
    const env = environment({ keepRunningOnce: true, keepRunning: true });
    await h.registry.add(env);
    await connectHere(env);
    const stored = await h.registry.get(ENV_ID);
    expect(stored).not.toHaveProperty('keepRunningOnce');
    expect(stored?.keepRunning).toBe(true);
  });

  it('sets the context key of a connected window when it connects', async () => {
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('setContext', CONNECTED_CONTEXT_KEY, true);
  });

  it('is offered in the Command Palette only in a connected window, and in the menus of the row of this window', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: Array<{ command: string; title: string }>;
        menus: Record<string, Array<{ command?: string; when?: string }>>;
      };
    };
    expect(manifest.contributes.commands.find((entry) => entry.command === Commands.closeAndKeepRunning)?.title).toBe('Close and Keep Running');
    const when = (menu: string) => manifest.contributes.menus[menu].filter((item) => item.command === Commands.closeAndKeepRunning).map((item) => item.when);
    expect(when('commandPalette')).toEqual([CONNECTED_CONTEXT_KEY]);
    const clause = when('devEnvironments.more')[0]!;
    expect(when('view/item/context')).toEqual([`view == devEnvironments.repositories && ${clause}`]);
    const matches = (value: string) => new RegExp(clause.match(/viewItem =~ \/(.*)\/$/)![1]).test(value);
    expect(matches(treeContextValue(rowActions('connected', undefined), 'on', false, true))).toBe(true);
    expect(matches(treeContextValue(rowActions('connected', undefined), 'on', true, true))).toBe(true);
    expect(matches(treeContextValue(rowActions('running', undefined), 'on', false))).toBe(false);
  });
});

describe('Double-click on a repository row (user request 2026-09-27)', () => {
  /** A row as the view gives it to its command: with the actions of its state. */
  function viewRow(repository: string, env: Environment | undefined, state?: Parameters<typeof rowActions>[0]): unknown {
    return { ...(row(repository, env) as object), actions: rowActions(state, undefined) };
  }

  /** One click at `at` milliseconds after NOW. */
  async function click(argument: unknown, at: number): Promise<void> {
    h.clock.now = () => NOW + at;
    await run('rowActivated', argument);
  }

  it('is hidden in the Command Palette', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }>; menus: Record<string, Array<{ command?: string; when?: string }>> };
    };
    expect(manifest.contributes.commands.some((entry) => entry.command === Commands.rowActivated)).toBe(true);
    const entries = manifest.contributes.menus.commandPalette.filter((item) => item.command === Commands.rowActivated);
    expect(entries.map((item) => item.when)).toEqual(['false']);
    // Only the row itself runs it: no menu offers it.
    for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
      if (menu !== 'commandPalette') expect(items.some((item) => item.command === Commands.rowActivated)).toBe(false);
    }
  });

  it('only selects the row on a single click', async () => {
    const start = vi.spyOn(h.controller, 'start');
    await h.registry.add(environment());
    await click(viewRow('acme/api', environment(), 'stopped'), 0);
    expect(start).not.toHaveBeenCalled();
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
    // 2026-10-01: the Switch branch command was dropped (user decision). No FakeQuickPick any more.
    expect(fakeVscode.window.createQuickPick).not.toHaveBeenCalled();
  });

  it('runs Start with the row on two clicks of the same row within the interval', async () => {
    const start = vi.spyOn(h.controller, 'start');
    await h.registry.add(environment());
    const argument = viewRow('acme/api', environment(), 'stopped');
    await click(argument, 0);
    await click(argument, DOUBLE_CLICK_INTERVAL_MS);
    expect(start).toHaveBeenCalledTimes(1);
    // The same argument as the Start button of the row.
    expect(start).toHaveBeenCalledWith({ kind: 'row', repository: 'acme/api', info: undefined, environmentId: ENV_ID });
    expect(h.service.openEnvironment).toHaveBeenCalledWith(ENV_ID, expect.anything());
    expect(h.connection.open).toHaveBeenCalledWith(CONTAINER, '/workspaces/api');
  });

  it('starts nothing on two clicks of different rows', async () => {
    const start = vi.spyOn(h.controller, 'start');
    await click(viewRow('acme/api', undefined), 0);
    await click(viewRow('acme/web', undefined), 100);
    await click(viewRow('acme/api', undefined), 200);
    expect(start).not.toHaveBeenCalled();
    expect(h.service.open).not.toHaveBeenCalled();
  });

  it('starts nothing on clicks slower than the interval', async () => {
    const start = vi.spyOn(h.controller, 'start');
    const argument = viewRow('acme/api', undefined);
    await click(argument, 0);
    await click(argument, DOUBLE_CLICK_INTERVAL_MS + 1);
    await click(argument, 2 * DOUBLE_CLICK_INTERVAL_MS + 2);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts once on a triple click', async () => {
    const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
    const argument = viewRow('acme/api', undefined);
    await click(argument, 0);
    await click(argument, 150);
    await click(argument, 300);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('runs Start on the first activation when workbench.list.openMode is doubleClick', async () => {
    h.listOpenMode.value = 'doubleClick';
    const start = vi.spyOn(h.controller, 'start').mockResolvedValue(undefined);
    await click(viewRow('acme/api', undefined), 0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ kind: 'row', repository: 'acme/api', info: undefined, environmentId: undefined });
    // VS Code sends each double-click once: the next one starts again (Start's own rules decide).
    await click(viewRow('acme/api', undefined), 100);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('starts nothing in the row of the environment of this window', async () => {
    const start = vi.spyOn(h.controller, 'start');
    const env = environment();
    await h.registry.add(env);
    await connectHere(env);
    await click(viewRow('acme/api', env, 'connected'), 0);
    await click(viewRow('acme/api', env, 'connected'), 100);
    // Also a row from before the connection, which still shows Start.
    await click(viewRow('acme/api', env, 'stopped'), 1000);
    await click(viewRow('acme/api', env, 'stopped'), 1100);
    expect(start).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(h.service.openEnvironment).not.toHaveBeenCalled();
  });

  it('starts nothing where the row shows no Start (updating)', async () => {
    const start = vi.spyOn(h.controller, 'start');
    await click(viewRow('acme/api', environment(), 'updating'), 0);
    await click(viewRow('acme/api', environment(), 'updating'), 100);
    expect(start).not.toHaveBeenCalled();
  });

  it('ignores an argument that is no repository row', async () => {
    const start = vi.spyOn(h.controller, 'start');
    for (const argument of [undefined, { kind: 'owner', id: 'owner:acme' }, { kind: 'hint', id: 'hint:acme' }, { environmentId: ENV_ID }]) {
      await click(argument, 0);
      await click(argument, 100);
    }
    expect(start).not.toHaveBeenCalled();
  });
});

// Review round 1 of PR #87 (A-R1-4): the recorded state may be older than the last use of the environment (its release
// was lost, or the Session Monitor stopped it by the long limit); Delete's confirmation says that later changes are not
// known. Only a message: nothing more runs for it.
describe('Delete: a recorded state older than the last use (review round 1 of PR #87, A-R1-4)', () => {
  const at = (ms: number) => new Date(ms).toLocaleString();

  it('names the time of the recorded state when the environment was used after it (the container did not run)', async () => {
    const env = environment({
      lastUsedAt: iso(NOW - 600_000),
      gitSummary: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW - 3_600_000) },
    });
    await h.registry.add(env);
    h.service.safetyCheck.mockResolvedValue(env.gitSummary);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(Actions.delete);
    await run('delete', row('acme/api', env));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0]).toEqual([
      `${Messages.deleteConfirm('acme/api')} ${Messages.deleteChangesUnknownSince(at(NOW - 3_600_000))}`,
      { modal: true },
      Actions.delete,
    ]);
    expect(h.service.deleteInWorker).toHaveBeenCalled();
  });

  it('also with recorded changes, and without any recorded state since the last open', async () => {
    const old = { branch: 'main', uncommittedFiles: 2, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW - 3_600_000) };
    await h.registry.add(environment({ lastUsedAt: iso(NOW - 600_000), gitSummary: old }));
    h.service.safetyCheck.mockResolvedValue(old);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', environment()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(
      `${Messages.deleteUnsaved('acme/api', '2 uncommitted')} ${Messages.deleteChangesUnknownSince(at(NOW - 3_600_000))}`,
    );
    // Nothing recorded at all (safetyCheck has nothing, nor has the registry).
    fakeVscode.window.showWarningMessage.mockReset();
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      delete entry.gitSummary;
    });
    h.service.safetyCheck.mockResolvedValue(undefined);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', environment()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(`${Messages.deleteConfirm('acme/api')} ${Messages.deleteChangesNotRecorded}`);
  });

  it('says nothing more for a state recorded at or after the last use (a running container was checked just now)', async () => {
    await h.registry.add(environment({ lastUsedAt: iso(NOW - 600_000) }));
    h.service.safetyCheck.mockResolvedValue({ branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW) });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', environment()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(Messages.deleteConfirm('acme/api'));
  });

  // Review round 2 of PR #87, A-R2-2: a reload or a release moves the last use (lastSeenInUseAt), not only the open.
  it('compares with the last time a window was seen using it (a reload after the last open), not only the open (review round 2 of PR #87, A-R2-2)', async () => {
    const recorded = { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: iso(NOW - 3_600_000) };
    // Opened before the state was recorded, but seen in use after it (a reload): later changes are not known.
    await h.registry.add(environment({ lastUsedAt: iso(NOW - 7_200_000), lastSeenInUseAt: iso(NOW - 600_000), gitSummary: recorded }));
    h.service.safetyCheck.mockResolvedValue(recorded);
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', environment()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(
      `${Messages.deleteConfirm('acme/api')} ${Messages.deleteChangesUnknownSince(at(NOW - 3_600_000))}`,
    );
    // Seen in use last before the state was recorded (the release recorded it): nothing more.
    fakeVscode.window.showWarningMessage.mockReset();
    await h.registry.updateEnvironment(ENV_ID, (entry) => {
      entry.lastSeenInUseAt = iso(NOW - 3_700_000);
    });
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', environment()));
    expect(fakeVscode.window.showWarningMessage.mock.calls[0][0]).toBe(Messages.deleteConfirm('acme/api'));
    expect(h.service.deleteInWorker).not.toHaveBeenCalled();
  });
});

// Review round 1 of plan step 11C2b (mutation tests, B-R1 CT5, CT6, CT8).
describe('the Delete command sends the check to the worker (review round 1 of 11C2b)', () => {
  it('CT5/CT6/CT8: the check runs cancellable, with the signal of its progress and the name that the user sees', async () => {
    await h.registry.add(environment());
    fakeVscode.window.showWarningMessage.mockResolvedValueOnce(undefined);
    await run('delete', row('acme/api', environment(), repositoryInfo('Acme/API')));
    const [, options] = h.service.deleteCheckInWorker.mock.calls[0];
    expect(options).toMatchObject({ repository: 'Acme/API', otherWindow: false });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    // The only progress: the check (the dismissed confirmation deletes nothing).
    expect(fakeVscode.window.withProgress.mock.calls.map((call: unknown[]) => call[0])).toEqual([expect.objectContaining({ cancellable: true })]);
  });
});
