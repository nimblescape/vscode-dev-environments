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
import { attachDiagnostics } from '../core/docker/attachDiagnostics';
import { ContainerAdapter } from '../core/docker/containerAdapter';
import { dockerProcessEnv, findDockerCli, findExecutable } from '../core/docker/dockerCli';
import { dockerHostOf, isOnDockerHost, remoteContextName } from '../core/docker/dockerHost';
import { ensureDockerRunning } from '../core/docker/dockerStart';
import { DockerTargets, operationDockerTarget, runWithDockerTarget } from '../core/docker/dockerTargets';
import { SshLoginCache, startDockerFor, type RemoteReachabilityDeps } from '../core/docker/remoteDocker';
import { DiscoveryService } from '../core/discovery/discoveryService';
import { GitHubApi } from '../core/discovery/githubApi';
import { sameScope } from '../core/discovery/scope';
import { errorMessage } from '../core/errors';
import { WorkerConfigurationAnalyzer } from '../core/helper/configurationAnalysisRunner';
import { registryBaseDigest } from '../core/helper/helperImage';
import { DOCKER_SOCKET, WorkspaceHelper } from '../core/helper/workspaceHelper';
import { nodeHttpsTransport } from '../core/http';
import { DockerCredentialStore, withGitHubPackagesFallback } from '../core/imageCheck/credentials';
import { ImageChecker } from '../core/imageCheck/imageCheck';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { systemClock, type Logger } from '../core/ports';
import { RemoteSessionMonitor } from '../core/remoteMonitor/remoteSessionMonitor';
import { DEFAULT_IMAGE_SCHEDULE, usableTimeZone } from '../core/remoteMonitor/cron';
import { PACKAGES_TIMEOUT_MS, ghcrOwnerOf, ghcrRepositories } from '../core/remoteMonitor/imageRepositories';
import { MAX_IMAGE_REPOSITORIES, imagePrefixesOf } from '../core/remoteMonitor/protocol';
import { EnvironmentService } from '../core/pipeline/environmentService';
import { githubPackagesPullCredentials } from '../core/pipeline/pullCredentials';
import { NodeProcessRunner } from '../core/process';
import { nodeSshConfigFiles, parseSshConfig } from '../core/sshConfig';
import { readOrCreateComputerId } from '../core/storage/computerId';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import { RemoteDockerState } from '../core/storage/remoteDockerState';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { Environment, ExtensionSettings } from '../core/types';
import { remoteStopAfterSeconds } from '../monitor/rules';
import { VsCodeGitHubAuth, ghcrRejectionReporter } from './auth';
import { ConnectionAdapter } from './connectionAdapter';
import { Controller } from './controller';
import { DisconnectRequests } from './disconnectRequests';
import { dockerAdapterOptions } from './dockerAdapterOptions';
import { DockerHostIndicator } from './dockerHostIndicator';
import { DockerSetup } from './dockerSetup';
import { OutputChannelLogger } from './logger';
import { updateOwnersContextKey } from './ownerSelector';
import { VsCodePipelineUi } from './pipelineUi';
import { onDidChangeBusy } from './progress';
import { PreviewWorkerRunner } from './groupsPreviewRunner';
import { RemoteDockerCommands } from './remoteDockerCommands';
import { RepositoryGroupsEditor } from './repositoryGroupsEditor';
import { SessionCoordinator } from './sessionCoordinator';
import { affectsSettings, readSettings, warnInvalidHostAccessChecksOff } from './settings';
import { Sidebar } from './sidebar';
import { EnvironmentStatusBar } from './statusBar';
import { Throttle } from './tasks';
import { REPOSITORIES_VIEW_ID, RepositoriesTreeProvider, type TreeNode } from './treeView';

/** A window that gets the focus refreshes the sidebar at most this often. */
const FOCUS_REFRESH_INTERVAL_MS = 15_000;
/** User requests 2026-09-28: the image list for the monitor of a host is sent at most this often. */
export const IMAGE_LIST_INTERVAL_MS = 60 * 60_000;
export const ImageListTexts = {
  signInQuestion: (host: string) =>
    `To keep all images of the setting "Remote Image Updates" on ${host} up to date, Dev Environments needs to read your GitHub packages.`,
  signIn: 'Sign in',
} as const;

/** Kept for deactivate(), which must be synchronous. */
let coordinator: SessionCoordinator | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Concept 7.10: the reopen rule measures the age of the reopen record at this time, before any await.
  const activatedAt = systemClock.now();
  const logger = new OutputChannelLogger();
  context.subscriptions.push(logger);
  try {
    await activateExtension(context, logger, activatedAt);
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

async function activateExtension(
  context: vscode.ExtensionContext,
  logger: OutputChannelLogger,
  activatedAt: number,
): Promise<void> {
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
  // Invalid entries of devEnvLauncher.hostAccessChecksOff are ignored, with one warning (again only when they change).
  let invalidHostAccessEntries = warnInvalidHostAccessChecksOff(logger, '');

  const runner = new NodeProcessRunner();
  const dockerPath = findDockerCli(env, platform);
  logger.info(dockerPath ? `Docker CLI: ${dockerPath}` : 'The Docker CLI was not found.');
  // Set below; the adapter reports each `docker info` to it (context key devEnvironments.dockerReady).
  let dockerSetup: DockerSetup | undefined;
  // Docker Desktop installed, updated, uninstalled or moved while VS Code runs is found or lost without a reload.
  const docker = new ContainerAdapter(runner, dockerPath, env, logger, platform, dockerAdapterOptions(() => dockerSetup));
  // Unit 7: the Docker host is the current Docker context, read at the start of each operation.
  const targets = new DockerTargets(docker, env, logger, platform);
  const remoteState = new RemoteDockerState(paths.remoteDocker);
  const sshPath = (): string | undefined => findExecutable('ssh', env, platform);
  // Review, C3: the SSH check before the Docker calls to a remote host; a success counts for a minute per host.
  const sshLogins = new SshLoginCache();
  const remoteDeps = (): RemoteReachabilityDeps => ({ docker, runner, state: remoteState, logger, sshPath: sshPath(), env, sshLogins });
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
  // The sign-in fix: a 401 of GitHub (here the token service of ghcr.io for the GitHub session) reaches auth.ts, which
  // ignores tokens that belong to no current session (for example a token of the Docker credentials).
  const registryClient = new RegistryClient(nodeHttpsTransport, withGitHubPackagesFallback(credentials.provider(), auth), logger, {
    onCredentialsRejected: ghcrRejectionReporter(auth),
  });
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
    // Unit 7: the engine of the operation. On a remote host the socket mount's source is a path of that computer: the
    // recorded socket of a rootless engine, else /var/run/docker.sock.
    engine: async () => {
      const target = await targets.current();
      if (target.kind !== 'remote') return { key: target.host, endpoint: target.endpoint };
      return { key: target.host, socket: (await remoteState.rootlessSocket(target.host)) ?? DOCKER_SOCKET };
    },
  });
  // Unit 7, PR 2: the Session Monitor container on a remote Docker host. Its script is dist/remoteMonitor.js, read once.
  const remoteMonitorScript = context.asAbsolutePath(path.join('dist', 'remoteMonitor.js'));
  let remoteMonitorScriptText: Promise<string> | undefined;
  const remoteMonitor = new RemoteSessionMonitor({
    docker,
    logger,
    // User requests 2026-09-28: the image maintenance of the monitor (the settings remoteImageUpdates and
    // remoteImageUpdateSchedule, in the time zone of this computer).
    imageMaintenance: () => imageMaintenance(),
    script: () => {
      remoteMonitorScriptText ??= fs.promises.readFile(remoteMonitorScript, 'utf8');
      // A failed read is tried again at the next open.
      remoteMonitorScriptText.catch(() => (remoteMonitorScriptText = undefined));
      return remoteMonitorScriptText;
    },
  });
  // User request 2026-09-28 ("all images"): the image repositories of the prefixes, read with the GitHub session (scope
  // read:packages) and given to the monitor of the host, at most once an hour per host. Without that scope, a question
  // once per window; the monitor then updates only the images that are on the host. Review round 1 of PR #57: first the
  // settings of this computer (C: they are not part of the label anymore), when they changed or an hour passed; the list
  // is read in the background with a time limit (B: it never delays Start); a failed send is tried again at the next open
  // (D).
  const imageListSentAt = new Map<string, number>();
  const imageSettingsSent = new Map<string, { text: string; at: number }>();
  let packagesSignInOffered = false;
  // Review round 9 of PR #57 (T2): patterns that are left out (invalid, or beyond the limits) are logged once.
  let warnedPatterns = '';
  const usedImagePrefixes = (): string[] => {
    const patterns = getSettings().remoteImageUpdates ?? [];
    const prefixes = imagePrefixesOf(patterns);
    const left = patterns.filter((pattern) => !prefixes.includes(pattern.trim().replace(/\*$/, '')));
    if (left.length > 0 && JSON.stringify(left) !== warnedPatterns) {
      warnedPatterns = JSON.stringify(left);
      logger.warn(`These image patterns of devEnvLauncher.remoteImageUpdates are not used (invalid, Docker Hub, duplicate, or beyond 50 patterns or 4096 characters): ${left.join(', ')}`);
    }
    return prefixes;
  };
  const imageMaintenance = () => ({
    prefixes: usedImagePrefixes(),
    schedule: getSettings().remoteImageUpdateSchedule ?? DEFAULT_IMAGE_SCHEDULE,
    // Review round 5 of PR #57 (P2): an unknown zone of Node.js (`Etc/Unknown`) is UTC.
    timeZone: usableTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
  });
  const sendImageSettings = async (host: string): Promise<void> => {
    const settings = imageMaintenance();
    if (settings.prefixes.length === 0) return;
    const text = JSON.stringify(settings);
    const last = imageSettingsSent.get(host);
    if (last && last.text === text && Math.abs(Date.now() - last.at) < IMAGE_LIST_INTERVAL_MS) return;
    if (await remoteMonitor.imageSettings(settings)) imageSettingsSent.set(host, { text, at: Date.now() });
    else imageSettingsSent.delete(host);
  };
  const sendRepositories = async (host: string, prefixes: string[], token: string): Promise<void> => {
    let repositories: string[];
    try {
      repositories = await ghcrRepositories(nodeHttpsTransport, token, prefixes, AbortSignal.timeout(PACKAGES_TIMEOUT_MS));
    } catch (error) {
      imageListSentAt.delete(host);
      logger.warn(`The image repositories could not be read from GitHub: ${errorMessage(error)}`);
      return;
    }
    if (repositories.length > MAX_IMAGE_REPOSITORIES) {
      logger.warn(`GitHub lists ${repositories.length} image repositories for ${prefixes.join(', ')}; the Session Monitor on ${host} gets the first ${MAX_IMAGE_REPOSITORIES}.`);
      repositories = repositories.slice(0, MAX_IMAGE_REPOSITORIES);
    }
    logger.info(`The Session Monitor on ${host} keeps ${repositories.length} image repositories up to date: ${repositories.join(', ')}.`);
    if (!(await remoteMonitor.images(repositories))) imageListSentAt.delete(host);
  };
  const sendImageList = async (host: string): Promise<void> => {
    const prefixes = usedImagePrefixes();
    if (prefixes.length === 0) return;
    // Review round 4 of PR #57 (L2): the background work keeps the Docker target of the open; after the open ended, its
    // calls would read the current context again, and a switch to another host in the meantime sent there.
    const target = operationDockerTarget();
    const inTarget = (fn: () => Promise<void>) => void (target ? runWithDockerTarget(target, fn) : fn());
    // Review round 2 of PR #57 (R6): in the background too (a docker exec of up to 20 s that Cancel could not end); a
    // failure is logged and the next open sends again.
    inTarget(() => sendImageSettings(host));
    if (!prefixes.some((prefix) => ghcrOwnerOf(prefix) !== undefined)) return;
    const last = imageListSentAt.get(host);
    if (last !== undefined && Math.abs(Date.now() - last) < IMAGE_LIST_INTERVAL_MS) return;
    const credentials = await auth.getPackagesCredentials({ interactive: false });
    if (!credentials) {
      logger.info(`The image list for ${host} needs the GitHub sign-in for packages; the Session Monitor there updates only the images that it has.`);
      if (!packagesSignInOffered) {
        packagesSignInOffered = true;
        void vscode.window.showInformationMessage(ImageListTexts.signInQuestion(host), ImageListTexts.signIn).then(async (choice) => {
          if (choice !== ImageListTexts.signIn) return;
          if (await auth.getPackagesCredentials({ interactive: true })) imageListSentAt.delete(host);
        });
      }
      return;
    }
    imageListSentAt.set(host, Date.now());
    inTarget(() => sendRepositories(host, prefixes, credentials.password));
  };
  // The source of the heartbeats (computer.id); created by the first reader.
  const computerId = (): string => readOrCreateComputerId(paths.computerId);
  // One stored list per GitHub account (concept 6.2).
  const discovery = new DiscoveryService(
    new GitHubApi(nodeHttpsTransport, logger, {
      onUnauthorized: (token) => auth.reportRejectedToken(token),
      onAuthorized: (token) => auth.reportAcceptedToken(token),
    }),
    (accountId) => paths.repositoriesFile(accountId),
    logger,
    systemClock,
    // Concept 7.4: the setting `owners` is the scan scope; GitHub is asked only about these owners.
    { scope: () => getSettings().owners },
  );
  const ui = new VsCodePipelineUi(auth, logger, () => logger.show());
  const connection = new ConnectionAdapter(logger);
  const sessionCoordinator = new SessionCoordinator({
    paths,
    sessionFiles,
    logger,
    monitorScript: context.asAbsolutePath(path.join('dist', 'sessionMonitor.js')),
    settings: getSettings,
    windowDockerContext: () => connection.currentDockerContext(),
  });
  coordinator = sessionCoordinator;
  context.subscriptions.push(sessionCoordinator);
  // Review round 9 (P9-2): without its bundle every analysis fails (as an internal error, which refuses new and changed
  // configurations): the log says why at once.
  if (!fs.existsSync(context.asAbsolutePath(path.join('dist', 'configurationAnalysisWorker.js')))) {
    logger.error('The bundle of the configuration check (dist/configurationAnalysisWorker.js) is missing. Reinstall Dev Environments.');
  }
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
    // Review round 8: the host access analysis of a configuration runs in a worker thread with limits of time and memory.
    analyzer: new WorkerConfigurationAnalyzer(context.asAbsolutePath(path.join('dist', 'configurationAnalysisWorker.js')), logger),
    // Unit 7: new environments record the Docker host; only its environments are used. Review D2: an endpoint that is
    // neither local nor SSH is refused by every operation and never read.
    dockerTarget: () => targets.current(),
    // Unit 7, PR 2: the Session Monitor on a remote host, with the socket that the workspace helper mounts there.
    remoteMonitor: {
      ensure: async (host, helperTag, signal, helperImage) =>
        remoteMonitor.ensure(helperTag, (await remoteState.rootlessSocket(host)) ?? DOCKER_SOCKET, signal, helperImage),
      heartbeat: async (_host, environmentId, keepRunning, seq) => {
        const result = await remoteMonitor.heartbeat({
          source: computerId(),
          limitSeconds: remoteStopAfterSeconds(getSettings().remoteStopAfterMinutes),
          environments: [{ id: environmentId, keepRunning, seq }],
        });
        return result.ok ? { ok: true } : { ok: false, detail: result.detail };
      },
      forget: async (_host, environmentId) => remoteMonitor.forget(computerId(), environmentId),
      images: sendImageList,
    },
    // Unit 7: the local Docker is started as before; a remote host is only checked (never a Docker Desktop start).
    startDocker: async ({ onStarting, signal }) =>
      startDockerFor(
        await targets.current(),
        () => ensureDockerRunning(docker, runner, logger, { platform, env, onStarting, signal }),
        remoteDeps(),
        signal,
      ),
  });

  const tree = new RepositoriesTreeProvider(logger);
  const view = vscode.window.createTreeView<TreeNode>(REPOSITORIES_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const statusBar = new EnvironmentStatusBar();
  context.subscriptions.push(tree, view, statusBar);
  // User requests 2026-09-28: the view's title and its first row name the Docker host (also the local Docker).
  const dockerHostIndicator = new DockerHostIndicator(view, logger, (host) => tree.setDockerHost(host));
  context.subscriptions.push({ dispose: targets.onDidResolve((target) => dockerHostIndicator.update(target, docker.isInstalled())) });
  // Concept 6.1 step 2: while no Docker CLI is found, the sidebar shows the Docker setup (welcome view) instead of the
  // repositories. User decision 2026-09-26: "when no remote docker is configured and local docker is not available, the
  // repositories shall not be shown, instead, the side view shall show the install docker wizard".
  const setup = new DockerSetup({
    docker,
    runner,
    logger,
    showLog: () => logger.show(),
    platform,
    env,
    // The CLI was found or lost: the sidebar renders again and shows the repositories or the setup.
    onDidChangeInstalled: () => {
      sidebar.render().catch((error: unknown) => logger.error('Could not update the sidebar.', error));
    },
    // Unit 7: the current Docker context points to another computer (as last read). Without a Docker CLI no context can
    // be read, so the setup shows as before.
    remoteDockerHostConfigured: () => targets.last?.kind === 'remote',
    // Unit 7: Start Docker never starts Docker Desktop for a remote host; it only checks that host.
    startDocker: async (signal, onStarting) =>
      startDockerFor(
        await targets.current(),
        () => ensureDockerRunning(docker, runner, logger, { platform, env, signal, onStarting }),
        remoteDeps(),
        signal,
      ),
  });
  dockerSetup = setup;
  context.subscriptions.push(setup);
  const sidebar = new Sidebar({
    logger,
    registry,
    sessionFiles,
    coordinator: sessionCoordinator,
    service,
    docker,
    discovery,
    auth,
    tree,
    settings: getSettings,
    dockerSetupRequired: () => setup.setupRequired,
    dockerHost: () => targets.host(),
    view,
  });
  setup.initialize();
  const repositoryGroupsEditor = new RepositoryGroupsEditor({
    extensionUri: context.extensionUri,
    logger,
    groupingInput: () => sidebar.groupingInput(),
    onDidRender: sidebar.onDidRender,
    previewRunner: new PreviewWorkerRunner(context.asAbsolutePath(path.join('dist', 'groupsPreviewWorker.js'))),
  });
  context.subscriptions.push(repositoryGroupsEditor);
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
    ui,
    connection,
    coordinator: sessionCoordinator,
    sidebar,
    statusBar,
    settings: getSettings,
    dockerSetup: setup,
    repositoryGroupsEditor,
    viewVisible: () => view.visible,
    development: context.extensionMode === vscode.ExtensionMode.Development,
    dockerTargets: targets,
    remoteDocker: new RemoteDockerCommands({
      docker,
      runner,
      targets,
      state: remoteState,
      logger,
      showLog: () => logger.show(),
      sshHosts: () => parseSshConfig(nodeSshConfigFiles, { home: os.homedir() }),
      sshPath,
      env,
      platform,
      sshLogins,
      onDidSwitch: async () => {
        await sidebar.render();
        if (view.visible) await sidebar.refreshStates();
      },
    }),
    // Unit 7, PR 2: Close and Keep Running tells the Session Monitor on the remote host at once.
    remoteMonitor: {
      sendKeepRunning: async (environmentId, seq) => {
        const result = await remoteMonitor.heartbeat({
          source: computerId(),
          limitSeconds: remoteStopAfterSeconds(getSettings().remoteStopAfterMinutes),
          environments: [{ id: environmentId, keepRunning: true, seq }],
        });
        return result.ok ? { ok: true } : { ok: false, detail: result.detail };
      },
    },
  });
  context.subscriptions.push(
    sidebar,
    controller,
    ...controller.registerCommands(),
    controller.watchDisconnectRequests(),
    // Concept 7.4: the first load shows the repositories as they arrive.
    discovery.onPartialResult((result) => sidebar.onPartialResult(result)),
  );

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
    // GitHub rejected the token of the session, or accepted it again: the same account, so only the view changes.
    auth.onDidChangeSignInState(() => background(sidebar.onSessionChanged({ again: false }), 'update the sign-in state')),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!affectsSettings(event)) return;
      const previous = settings;
      settings = readSettings();
      invalidHostAccessEntries = warnInvalidHostAccessChecksOff(logger, invalidHostAccessEntries);
      updateOwnersContextKey(settings.owners, logger);
      // Concept 7.4: another scan scope loads the list again at once.
      if (!sameScope(previous.owners, settings.owners)) {
        background(sidebar.onScopeChanged(), 'load the repository list of the selected organizations');
      }
      background(sessionCoordinator.writeMonitorSettings(), 'write the settings for the Session Monitor');
      background(sidebar.render(), 'update the sidebar');
      sidebar.restartTimer();
    }),
  );

  // The icon of Select Organizations… in the view title bar.
  updateOwnersContextKey(settings.owners, logger);
  // The Docker host of the view title (every later read of the context updates it too).
  background(targets.resolve(), 'read the Docker host');
  // Concept 6.1 step 3: the stored list at once, then the background refresh.
  background(sidebar.initialize(), 'show the repository list');
  if (view.visible) background(sidebar.refreshStates(), 'update the sidebar');
  // Concept 7.5: a lost registry is rebuilt from the volume labels (only when Docker runs).
  background(controller.reconcileIfRegistryLost(), 'restore the environments from the volumes');

  if (currentEnvironment && containerName && docker.isInstalled()) {
    // User request 2026-09-28: which Docker the Dev Containers extension asks when it resolves this window. Only for an
    // environment of this extension (review round 1, F5). Its context: the one in the authority of this window, through
    // which the Dev Containers extension attaches (review of the attach context, A4); for a window without one, the
    // current context when that is on the host of the environment (review round 2, G5), else none for the local Docker.
    const environment = currentEnvironment;
    const logDocker = async (): Promise<void> => {
      const host = dockerHostOf(environment);
      const own = connection.currentDockerContext();
      const current = own === undefined ? await targets.resolve() : undefined;
      const context = own ?? (current && isOnDockerHost(environment, current.host) ? current.context : host === '' ? undefined : remoteContextName(host));
      const lines = await attachDiagnostics(docker, docker.processEnv(), containerName, context);
      for (const line of lines) logger.info(`While this window connects: ${line}`);
    };
    background(logDocker(), 'log the Docker of this window');
  }

  if (currentEnvironment && containerName) {
    // Role A: the open pipeline runs before VS Code connects this window (awaited).
    // Assumption (V-2, ATTACHED_CONTAINER_ACTIVATION_EVENT): VS Code waits for activate() before it resolves the authority.
    const pending = await started;
    await controller.openAttachedWindow(currentEnvironment, containerName, pending);
    return;
  }
  background(started, 'start the window session');
  // Role B: pending operations, then the reopen rule. Role C (a local folder or another remote): nothing else.
  if (connection.isEmptyWindow()) background(controller.runEmptyWindowTasks(activatedAt), 'run the tasks of the empty window');
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
    // Review D2: reconcileFromVolumes checks the Docker target first (never an endpoint that is neither local nor SSH),
    // then whether Docker runs.
    if (!docker.isInstalled()) return undefined;
    if ((await service.reconcileFromVolumes()) === 0) return undefined;
    return await registry.findByContainerName(containerName);
  } catch (error) {
    logger.error('The environment of this window could not be found.', error);
    return undefined;
  }
}
