// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Extension entry (esbuild entry of dist/extension.js): the composition root. activate() builds the components, registers
// the commands and listeners, and runs the tasks of the window role (concept 7.9, 7.10, 7.14). Only the open pipeline
// of a restored window (role A) is awaited; everything else runs in the background.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContainerAdapter } from '../core/docker/containerAdapter';
import { dockerProcessEnv, findDockerCli, findExecutable } from '../core/docker/dockerCli';
import { DiscoveryService } from '../core/discovery/discoveryService';
import { GitHubApi } from '../core/discovery/githubApi';
import { errorMessage } from '../core/errors';
import { registryBaseDigest } from '../core/helper/helperImage';
import { WorkspaceHelper } from '../core/helper/workspaceHelper';
import { nodeHttpsTransport } from '../core/http';
import { DockerCredentialStore, withGitHubPackagesFallback } from '../core/imageCheck/credentials';
import { ImageChecker } from '../core/imageCheck/imageCheck';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { EnvironmentClaims } from '../core/ownership';
import { systemClock, type Logger } from '../core/ports';
import { EnvironmentService } from '../core/pipeline/environmentService';
import { githubPackagesPullCredentials } from '../core/pipeline/pullCredentials';
import { NodeProcessRunner } from '../core/process';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { Environment, ExtensionSettings } from '../core/types';
import { VsCodeGitHubAuth } from './auth';
import { ConnectionAdapter } from './connectionAdapter';
import { Controller } from './controller';
import { DisconnectRequests } from './disconnectRequests';
import { OutputChannelLogger } from './logger';
import { VsCodePipelineUi } from './pipelineUi';
import { onDidChangeBusy } from './progress';
import { SessionCoordinator } from './sessionCoordinator';
import { affectsSettings, readSettings } from './settings';
import { Sidebar } from './sidebar';
import { EnvironmentStatusBar } from './statusBar';
import { Throttle } from './tasks';
import { REPOSITORIES_VIEW_ID, RepositoriesTreeProvider, type TreeNode } from './treeView';

/** A window that gets the focus refreshes the sidebar at most this often. */
const FOCUS_REFRESH_INTERVAL_MS = 15_000;

/** Kept for deactivate(), which must be synchronous. */
let coordinator: SessionCoordinator | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new OutputChannelLogger();
  context.subscriptions.push(logger);
  try {
    await activateExtension(context, logger);
  } catch (error) {
    logger.error('Dev Environments could not be started.', error);
    throw error;
  }
}

/** Concept 7.9: only the synchronous `closing` write and the reopen record; VS Code gives deactivate() little time. */
export function deactivate(): void {
  try {
    coordinator?.deactivateSync();
  } catch {
    // deactivateSync never throws; nothing else may run here.
  }
}

async function activateExtension(context: vscode.ExtensionContext, logger: OutputChannelLogger): Promise<void> {
  const platform = process.platform;
  const env = process.env;
  const paths = new StoragePaths(context.globalStorageUri.fsPath);
  try {
    paths.ensureDirectoriesSync();
  } catch (error) {
    logger.warn(`The storage folder ${paths.root} could not be created: ${errorMessage(error)}`);
  }
  let settings: ExtensionSettings = readSettings();
  const getSettings = (): ExtensionSettings => settings;

  const runner = new NodeProcessRunner();
  const dockerPath = findDockerCli(env, platform);
  logger.info(dockerPath ? `Docker CLI: ${dockerPath}` : 'The Docker CLI was not found.');
  // Docker Desktop installed or updated while VS Code runs is found without a reload.
  const docker = new ContainerAdapter(runner, dockerPath, env, logger, platform, { findDocker: findDockerCli });
  const registry = new EnvironmentRegistry(paths, systemClock, { logger });
  const needsRestore = (): Promise<boolean> => registry.needsRestore();
  const sessionFiles = new SessionFiles(paths);
  const disconnectRequests = new DisconnectRequests(paths.root);
  const auth = new VsCodeGitHubAuth(logger);
  context.subscriptions.push(auth);
  // Credential helpers (docker-credential-*) are found like the Docker CLI, also with the short PATH of the extension host.
  const credentialEnv = dockerProcessEnv(env, platform, dockerPath);
  const credentials = new DockerCredentialStore(runner, {
    env: credentialEnv,
    platform,
    homeDir: os.homedir(),
    findExecutable: (name) => findExecutable(name, credentialEnv, platform),
    logger,
  });
  const registryClient = new RegistryClient(nodeHttpsTransport, withGitHubPackagesFallback(credentials.provider(), auth), logger);
  const imageChecker = new ImageChecker(registryClient, logger);
  const helper = new WorkspaceHelper({
    docker,
    logger,
    dockerfilePath: context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile')),
    env,
    // Implementation notes 7: the weekly check of the base image uses the registry client (and the credentials) of the
    // image check, with its own time limit of 5 seconds, in the background of the open.
    statePath: paths.helperState,
    baseDigest: registryBaseDigest(registryClient),
  });
  // One stored list per GitHub account (concept 6.2); the shared list of version 1 is removed.
  const discovery = new DiscoveryService(
    new GitHubApi(nodeHttpsTransport, logger),
    (accountId) => paths.repositoriesFile(accountId),
    logger,
  );
  fs.promises
    .rm(paths.legacyRepositories, { force: true })
    .catch((error: unknown) => logger.warn(`The old repository list could not be removed: ${errorMessage(error)}`));
  const ui = new VsCodePipelineUi(auth, logger, () => logger.show());
  // Concept 7.5: entries of an older version. The quiet question logs no repository name (a hidden entry may belong to
  // another account); a command of the user asks before an entry that is not unambiguous is assigned.
  const claims = new EnvironmentClaims({
    registry,
    getRepository: (repository, token, signal) => discovery.getRepository(repository, token, signal, { quiet: true }),
    confirm: (environment, account) => ui.confirmAssignment(environment.repository, account.login),
    logger,
  });
  const connection = new ConnectionAdapter(logger);
  const sessionCoordinator = new SessionCoordinator({
    paths,
    sessionFiles,
    logger,
    monitorScript: context.asAbsolutePath(path.join('dist', 'sessionMonitor.js')),
    settings: getSettings,
  });
  coordinator = sessionCoordinator;
  context.subscriptions.push(sessionCoordinator);
  const service = new EnvironmentService({
    docker,
    runner,
    helper,
    registry,
    sessionFiles,
    imageChecker,
    auth,
    // Concept section 9: the profile name of the owner account for the Git identity of a new environment.
    viewer: (token, signal) => discovery.viewer(token, signal),
    // Concept 7.5: an entry of an older version that an open meets (for example restored from its volume) is claimed first.
    claims,
    ui,
    logger,
    clock: systemClock,
    platform,
    env,
    owner: { windowId: sessionCoordinator.windowId, pid: process.pid },
    settings: getSettings,
    windowStatuses: () => sessionFiles.readWindowStatuses(),
    // Concept 7.7: a private image on ghcr.io that the image check reads with the GitHub session is pulled with it too.
    pullCredentials: githubPackagesPullCredentials(credentials.provider(), auth),
  });

  const tree = new RepositoriesTreeProvider(logger);
  const view = vscode.window.createTreeView<TreeNode>(REPOSITORIES_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const statusBar = new EnvironmentStatusBar();
  context.subscriptions.push(tree, view, statusBar);
  const sidebar = new Sidebar({
    logger,
    registry,
    sessionFiles,
    coordinator: sessionCoordinator,
    service,
    docker,
    discovery,
    auth,
    claims,
    tree,
    settings: getSettings,
  });
  const controller = new Controller({
    logger,
    registry,
    registryNeedsRestore: needsRestore,
    sessionFiles,
    disconnectRequests,
    docker,
    service,
    discovery,
    auth,
    claims,
    ui,
    connection,
    coordinator: sessionCoordinator,
    sidebar,
    statusBar,
    settings: getSettings,
    viewVisible: () => view.visible,
  });
  context.subscriptions.push(sidebar, controller, ...controller.registerCommands(), controller.watchDisconnectRequests());

  const background = (promise: Promise<unknown>, what: string): void => {
    promise.catch((error: unknown) => logger.error(`Could not ${what}.`, error));
  };

  // The environment of this window (concept 7.8): the container of its folder URI, if the registry knows it.
  const containerName = connection.currentContainerName();
  const currentEnvironment = containerName
    ? await findWindowEnvironment(containerName, { registry, needsRestore, docker, service, logger })
    : undefined;
  // Writes the window status file and starts the Session Monitor. Its result is the pending connection file of this
  // window's environment, which the first status write removes (role A).
  const started = sessionCoordinator.start(currentEnvironment?.id ?? null);
  controller.setReady(started);

  const focusThrottle = new Throttle(FOCUS_REFRESH_INTERVAL_MS);
  context.subscriptions.push(
    onDidChangeBusy((change) => controller.onBusyChanged(change)),
    sessionCoordinator.onDidHeartbeat(() => {
      controller.onHeartbeat();
      // Only the coordination files; Docker is not asked in the background (Resource Saver of Docker Desktop).
      if (view.visible) background(sidebar.render(), 'update the sidebar');
    }),
    sidebar.onDidRefreshStates(() => controller.onStatesRefreshed()),
    view.onDidChangeVisibility((event) => {
      if (!event.visible) return;
      controller.onViewVisible();
      background(sidebar.refreshStates(), 'update the sidebar');
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused || !focusThrottle.tryAcquire()) return;
      background(view.visible ? sidebar.refreshStates() : sidebar.render(), 'update the sidebar');
    }),
    auth.onDidChangeSession(() => {
      // Concept 7.5: a window of an environment of another account closes; the view shows the list of the new account.
      background(controller.onSessionChanged(), 'check the environment of this window after the account change');
      background(sidebar.onSessionChanged(), 'update the sign-in state');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!affectsSettings(event)) return;
      settings = readSettings();
      background(sessionCoordinator.writeMonitorSettings(), 'write the settings for the Session Monitor');
      background(sidebar.render(), 'update the sidebar');
      sidebar.restartTimer();
    }),
  );

  // Concept 6.1 step 3: the stored list at once, then the background refresh.
  background(sidebar.initialize(), 'show the repository list');
  if (view.visible) {
    controller.onViewVisible();
    background(sidebar.refreshStates(), 'update the sidebar');
  }
  // Concept 7.5: a lost registry is rebuilt from the volume labels (only when Docker runs).
  background(controller.reconcileIfRegistryLost(), 'restore the environments from the volumes');

  if (currentEnvironment && containerName) {
    // Role A: the open pipeline runs before VS Code connects this window (awaited).
    // Assumption (V-2): VS Code waits for activate() before it resolves the attached-container authority.
    const pending = await started;
    await controller.openAttachedWindow(currentEnvironment, containerName, pending);
    return;
  }
  background(started, 'start the window session');
  // Role B: pending operations, then the reopen rule. Role C (a local folder or another remote): nothing else.
  if (connection.isEmptyWindow()) background(controller.runEmptyWindowTasks(), 'run the tasks of the empty window');
}

/**
 * The registry entry of the container that this window is attached to. When the registry lost its content (concept 7.5
 * "registry lost": the file is missing, not valid, or has invalid entries), it is restored from the volume labels first,
 * so that the open pipeline of role A can run for a restored window; this needs a running Docker, which is not started
 * for it. Never throws.
 */
async function findWindowEnvironment(
  containerName: string,
  deps: {
    registry: EnvironmentRegistry;
    needsRestore: () => Promise<boolean>;
    docker: ContainerAdapter;
    service: EnvironmentService;
    logger: Logger;
  },
): Promise<Environment | undefined> {
  const { registry, needsRestore, docker, service, logger } = deps;
  try {
    const environment = await registry.findByContainerName(containerName);
    if (environment || !(await needsRestore())) return environment;
    if (!docker.isInstalled() || !(await docker.isRunning())) return undefined;
    if ((await service.reconcileFromVolumes()) === 0) return undefined;
    return await registry.findByContainerName(containerName);
  } catch (error) {
    logger.error('The environment of this window could not be found.', error);
    return undefined;
  }
}
