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
import { BootstrapDocker } from '../core/docker/bootstrapDocker';
import { dockerProcessEnv, findDockerCli, findExecutable } from '../core/docker/dockerCli';
import { dockerHostOf, isOnDockerHost, type DockerTarget } from '../core/docker/dockerHost';
import { ensureDockerRunning } from '../core/docker/dockerStart';
import { DockerTargets, operationDockerTarget, outsideOperation, runWithDockerTarget } from '../core/docker/dockerTargets';
import { SshLoginCache, findRemoteContext, startDockerFor, type RemoteReachabilityDeps } from '../core/docker/remoteDocker';
import { DiscoveryService } from '../core/discovery/discoveryService';
import { GitHubApi } from '../core/discovery/githubApi';
import { sameScope } from '../core/discovery/scope';
import { errorMessage, UserFacingError } from '../core/errors';
import { helperImageTag, registryBaseDigest } from '../core/helper/helperImage';
import { HelperPrebuild, dockerEngineAnswers } from '../core/helper/helperPrebuild';
import { DOCKER_SOCKET, HelperImages, helperDockerSocket } from '../core/helper/helperImages';
import { HelperChannels, openHelperChannel } from '../core/helperChannel/helperChannels';
import { HelperChannelError } from '../core/helperChannel/helperChannel';
import { Messages } from '../core/messages';
import { nodeHttpsTransport } from '../core/http';
import { DockerCredentialStore, withGitHubPackagesFallback } from '../core/imageCheck/credentials';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { systemClock } from '../core/ports';
import { usableTimeZone } from '../core/remoteMonitor/cron';
import { DEFAULT_CACHE_UPDATE_SCHEDULE, monitorRunsPermanently } from '../core/remoteMonitor/cacheSettings';
import { PACKAGES_TIMEOUT_MS, ghcrRepositories } from '../core/remoteMonitor/imageRepositories';
import { imageLists } from './imageLists';
import { REMOTE_MONITOR_VOLUME, imagePrefixesOf } from '../core/remoteMonitor/protocol';
import { EnvironmentOperations } from '../core/pipeline/environmentOperations';
import { windowLifecycleMemory } from '../core/pipeline/lifecycleMemory';
import { NodeProcessRunner } from '../core/process';
import { nodeSshConfigFiles, parseSshConfig } from '../core/sshConfig';
import { ClosingWork } from '../core/session/closingWork';
import { heartbeatWiring } from '../core/session/heartbeatWiring';
import { WindowHeartbeats, resolveHeartbeatEngine } from '../core/session/windowHeartbeats';
import { releaseEnvironment } from '../core/session/windowRelease';
import { readOrCreateComputerId } from '../core/storage/computerId';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import { findWindowEnvironment, restoreAfterPrebuild } from './windowEnvironment';
import { workerMonitor } from './workerMonitor';
import { windowVscodeServer } from './vscodeServer';
import { VSCODE_STORE_VOLUME } from '../core/names';
import { RemoteDockerState } from '../core/storage/remoteDockerState';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { ExtensionSettings } from '../core/types';
import { VsCodeGitHubAuth, ghcrRejectionReporter } from './auth';
import { ConnectionAdapter } from './connectionAdapter';
import { Controller } from './controller';
import { DisconnectRequests } from './disconnectRequests';
import { dockerAdapterOptions } from './dockerAdapterOptions';
import { DockerHostIndicator } from './dockerHostIndicator';
import { DockerSetup } from './dockerSetup';
import { OutputChannelLogger } from './logger';
import { updateOwnersContextKey } from './ownerSelector';
import { isProcessAlive } from '../core/session/sessionRules';
import { extensionFlow, extensionHostSide } from './hostSide';
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
export const ImageListTexts = {
  // Plan step 8, PR A: the setting is "Image Updates", on every engine.
  signInQuestion: (engine: string) =>
    `To keep all images of the setting "Image Updates" on ${engine} up to date, Dev Environments needs to read your GitHub packages.`,
  signIn: 'Sign in',
} as const;

/** Kept for deactivate(). */
let coordinator: SessionCoordinator | undefined;
/**
 * Plan step 8, PR C: the work of deactivate() (the release of the window's environment, bounded). VS Code disposes the
 * subscriptions right after it calls deactivate(); review round 1 of PR #87 (B-R1-7 (a)): the worker channels with their
 * router, the preparation of the heartbeats, and the logger are disposed only after it settled (ClosingWork.deferred),
 * so the release still has its worker, can open it again, and logs to a live channel.
 */
const closingWork = new ClosingWork();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Concept 7.10: the reopen rule measures the age of the reopen record at this time, before any await.
  const activatedAt = systemClock.now();
  const logger = new OutputChannelLogger();
  // Review round 1 of PR #87 (B-R1-7 (a)): the release of deactivate() still logs.
  context.subscriptions.push(closingWork.deferred(logger));
  try {
    await activateExtension(context, logger, activatedAt);
  } catch (error) {
    logger.error('Dev Environments could not be started.', error);
    throw error;
  }
}

/**
 * Concept 7.9: the synchronous `closing` write and the reopen record first. Plan step 8, PR C (user decisions Q1 and Q2 of
 * 2026-10-02): then, best effort and within about 2 seconds (CLOSE_RELEASE_BOUNDS), the recorded state of the repository
 * and the short release of the window's environment; VS Code gives deactivate() little time, and a lost release leaves
 * the long limit of the heartbeats.
 */
export function deactivate(): Promise<void> | undefined {
  // Never throws; the disposals of ClosingWork.deferred wait for this promise.
  return closingWork.begin(() => coordinator?.deactivate());
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
  // Plan step 5, PR A: the worker (the helper channels), set below; its failed opens are tried again at once when the
  // Docker engine begins to answer.
  let helperChannels: HelperChannels | undefined;
  let daemonRunning = false;
  const adapterOptions = dockerAdapterOptions(() => dockerSetup);
  // Docker Desktop installed, updated, uninstalled or moved while VS Code runs is found or lost without a reload.
  // Plan step 11F2 (decision 1 of 2026-10-03): the Docker CLI of the extension is only the bootstrap's (BootstrapDocker).
  const docker = new BootstrapDocker(runner, dockerPath, env, logger, platform, {
    ...adapterOptions,
    onDaemonStatus: (running) => {
      if (running && !daemonRunning) helperChannels?.clearFailures();
      daemonRunning = running;
      adapterOptions.onDaemonStatus?.(running);
    },
  });
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
  const helperDockerfile = context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile'));
  // Plan step 11F2: the helper image of the bootstrap, apart from the steps of the workspace helper (the worker's).
  const helper = new HelperImages({
    docker,
    logger,
    dockerfilePath: helperDockerfile,
    // Implementation notes 7: the digest of the base image is read with this registry client and the credentials of
    // this computer (for ghcr.io also the GitHub sign-in), with its own time limit of 5 seconds: at the build of a
    // missing tag, and by the weekly check of the maintaining ensure (PR H, decision of 2026-10-09: the preparation of
    // the worker for an operation `open`, and the background prebuild).
    statePath: paths.helperState,
    baseDigest: registryBaseDigest(registryClient),
    // Unit 7: the engine of the operation (its key: '' for the local Docker, else the host). Review round 1 of PR #129
    // (A-L3): without its socket, which only the steps of the workspace helper read (now the worker's own; the socket
    // mount of the worker is engineSocket below).
    engine: async () => ({ key: (await targets.current()).host }),
    // Plan step 5, PR A: a worker that could not be opened for want of the helper image is tried again at once.
    // Review round 4 of PR #85 (A-R4-1): a build that succeeded also ends the wait of the heartbeats' builds on its engine
    // (the target of the operation that built it; every wait when it is not known). Review round 5 of PR #85 (B-R5-1):
    // in heartbeatWiring.
    onImageBuilt: () => {
      helperChannels?.clearFailures();
      heartbeats.imageBuilt();
    },
  });
  // Review round 2 of PR #85 (A-R2-2): the preparation that a heartbeat starts (the helper image for the worker, and for
  // a repair) runs with its own long signal (HELPER_PREBUILD_TIMEOUT_MS, aborted when the window closes); the deadline of
  // the heartbeat's attempt ends only its wait, so the next attempt joins the build instead of starting it again.
  // Review round 3 of PR #85 (A-R3-1): after a failed build for a heartbeat, the next one on that engine waits 1, 2, then
  // 5 minutes (REPAIR_BACKOFF_MS); a heartbeat within the wait fails at once and counts towards the Q4 warning.
  // Review round 4 of PR #85 (A-R4-1): only a build that started and failed starts the wait; within it a heartbeat goes
  // on when the helper tag is present (presentImage, never a build), and any successful preparation there ends it.
  // Review round 4 of PR #85 (B-R4-1): the helper image of the worker and of a repair of a heartbeat, on its engine.
  // Review round 5 of PR #85 (B-R5-1): this wiring (the preparation disposed with the window, onImageBuilt, the worker's
  // preparation and the repair through heartbeatHelperImage) is heartbeatWiring, tested in core.
  const heartbeats = heartbeatWiring({
    helper,
    inTarget: runWithDockerTarget,
    onOutput: (text) => logger.output(text),
    operationTarget: operationDockerTarget,
    // Review round 1 of PR #87 (B-R1-7 (a)): the preparation is disposed only after the release of deactivate(), which
    // may need to open the worker again.
    subscriptions: closingWork.deferredSubscriptions(context.subscriptions),
  });
  const heartbeatPreparation = heartbeats.preparation;
  // Plan step 5, PR A: the worker per window and Docker engine (the helper channel, dist/helperChannel.js), local and
  // remote. Plan step 11F2: every operation runs in it; the extension sends no Docker call of its own through it. Plan
  // step 5, PR D (rule D1 of 2026-09-30): an operation makes it ready first (the helper image, then the open), and is
  // refused when that fails. Its socket mount is the one of the workspace helper on that engine.
  const channelScriptPath = context.asAbsolutePath(path.join('dist', 'helperChannel.js'));
  // The source of the socket mount on the host of an engine, for the worker and the Session Monitor container: the
  // recorded socket of a rootless remote engine, else /var/run/docker.sock there; on the local Docker the socket of its
  // endpoint.
  const engineSocket = async (target: Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>): Promise<string> =>
    target.kind === 'remote' ? ((await remoteState.rootlessSocket(target.host)) ?? DOCKER_SOCKET) : helperDockerSocket(env, platform, target.endpoint);
  let channelScript: Promise<string> | undefined;
  const channels = new HelperChannels({
    logger,
    // Plan step 5, PR D (rule D1 of 2026-09-30): the helper image on the engine of the operation, as withEnvironmentLock
    // ensures it before the lock (only a missing tag is built). A-R2-2: for a heartbeat, with the long signal. PR H
    // (decision of 2026-10-09): for an operation `open`, the maintaining ensure with its `maintenance` (heartbeatWiring).
    prepare: async (target, signal, maintenance) => {
      // Review round 3 of PR #85 (A-R3-1): for a heartbeat, no new build on this engine within the wait after a failed one;
      // review round 4 of PR #85 (A-R4-1): within it, the heartbeat goes on when the tag is present (heartbeatWiring).
      await heartbeats.prepareWorker(target, signal, maintenance);
    },
    // PR #76 review round 1 (A-R1-1, A-R1-2): the refresh of the sidebar only checks that the helper image is present.
    checkPresent: async (target, signal) => {
      await runWithDockerTarget(target, () => helper.checkImagePresent({ signal }));
    },
    open: (target) =>
      openHelperChannel(
        {
          start: (args) => docker.start(args),
          runDirect: (args, options) => docker.run(args, options),
          logger,
          script: () => {
            channelScript ??= fs.promises.readFile(channelScriptPath, 'utf8');
            // A failed read is tried again at the next open.
            channelScript.catch(() => (channelScript = undefined));
            return channelScript;
          },
          helperTag: async () => helperImageTag(await fs.promises.readFile(helperDockerfile, 'utf8')),
          socketPath: engineSocket,
          // Plan step 5, PR B: the lock files of the environments, in the volume of the Session Monitor of the engine.
          stateVolume: REMOTE_MONITOR_VOLUME,
          // Plan step 11H1 (decision of 2026-10-03, "The VS Code caches are worker operations"): the shared VS Code server
          // store of the engine, which the worker mounts read-write.
          vscodeVolume: VSCODE_STORE_VOLUME,
        },
        target,
      ),
  });
  helperChannels = channels;
  // Plan step 11F2: the extension relays no Docker call through the worker any more (its pipeline runs there).
  // Plan step 8, PR C: after the release of deactivate() (bounded; it never rejects), which needs the worker.
  context.subscriptions.push(
    closingWork.deferred({
      dispose: () => {
        channels.dispose();
      },
    }),
  );
  // Plan step 11D1 (decision of 2026-10-03): the heartbeats, the image settings and list, the check of a container and the
  // Git state of a release, as operations of the worker of the engine (workerFlow is set below, before the first call).
  // Plan step 11D2: also the ensure of the Session Monitor container (unit 7, PR 2; plan step 8, PR A: every engine), with
  // the image maintenance of this computer (user requests 2026-09-28: the settings imageUpdates and imageUpdateSchedule,
  // plan step 11H2: cacheUpdateSchedule, in its time zone); the worker holds the script of the monitor and runs from the
  // helper image.
  const monitorCalls = workerMonitor({
    flow: (op, params, options) => workerFlow(op, params, options),
    owner: () => ({ windowId: windowCoordinator?.windowId ?? '', pid: process.pid }),
    logger,
  });
  // Plan step 11E6 (decision D1 of 2026-10-05): the open carries the image maintenance of this computer and the image list
  // for the Session Monitor of its engine (imageLists).
  // Review round 9 of PR #57 (T2): patterns that are left out (invalid, or beyond the limits) are logged once.
  let warnedPatterns = '';
  const usedImagePrefixes = (): string[] => {
    const patterns = getSettings().imageUpdates ?? [];
    const prefixes = imagePrefixesOf(patterns);
    const left = patterns.filter((pattern) => !prefixes.includes(pattern.trim().replace(/\*$/, '')));
    if (left.length > 0 && JSON.stringify(left) !== warnedPatterns) {
      warnedPatterns = JSON.stringify(left);
      logger.warn(`These image patterns of devEnvLauncher.imageUpdates are not used (invalid, Docker Hub, duplicate, or beyond 50 patterns or 4096 characters): ${left.join(', ')}`);
    }
    return prefixes;
  };
  // Plan step 11H2 (D1 and D2, decision of 2026-10-09): the schedule of the monitor's whole background run
  // (cacheUpdateSchedule), and its mode for an engine that is remote (`ssh://`, classifyDockerEndpoint) or local
  // (monitorRunsPermanently with stopLocalMonitorWhenIdle).
  const imageMaintenance = (remote: boolean) => ({
    prefixes: usedImagePrefixes(),
    schedule: getSettings().cacheUpdateSchedule ?? DEFAULT_CACHE_UPDATE_SCHEDULE,
    // Review round 5 of PR #57 (P2): an unknown zone of Node.js (`Etc/Unknown`) is UTC.
    timeZone: usableTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
    permanent: monitorRunsPermanently(remote, getSettings().stopLocalMonitorWhenIdle),
  });
  const imageListFor = imageLists({
    prefixes: usedImagePrefixes,
    packagesToken: async () => (await auth.getPackagesCredentials({ interactive: false }))?.password,
    read: (token, prefixes) => ghcrRepositories(nodeHttpsTransport, token, prefixes, AbortSignal.timeout(PACKAGES_TIMEOUT_MS)),
    offerSignIn: (engine) =>
      void vscode.window.showInformationMessage(ImageListTexts.signInQuestion(engine), ImageListTexts.signIn).then(async (choice) => {
        if (choice === ImageListTexts.signIn) await auth.getPackagesCredentials({ interactive: true });
      }),
    logger,
  });
  const connection = new ConnectionAdapter(logger);
  // The source of the heartbeats (computer.id); created by the first reader.
  const computerId = (): string => readOrCreateComputerId(paths.computerId);
  // Plan step 8, PR A (user decision Q4 of 2026-10-02): the heartbeats of this window to the Session Monitor container of
  // the engine of each environment it uses, through this window's worker of that engine (its operation `heartbeat`; the
  // worker is made ready first, D1; review round 1 of PR #113, A-L1); a missing monitor is started again as the open starts it.
  // Review round 1 of PR #85 (A-R1-2): `signal` aborts at the deadline of the heartbeat's attempt. Review round 2 of PR
  // #85 (A-R2-2): it ends only the wait for the helper image, whose build runs with the long signal of the preparation.
  // A-R3-1: the same wait after a failed build on this engine as for the worker of a heartbeat; A-R4-1: within it, the
  // repair goes on with the tag when it is present (heartbeatWiring.repair).
  // Plan step 11D2: the operation `monitorEnsure` of the worker of that engine.
  const repairSessionMonitor = heartbeats.repair((target, signal) => monitorCalls.monitorEnsure(target, imageMaintenance(target.kind === 'remote'), signal));
  // Set below (the coordinator makes the ID of this window).
  let windowCoordinator: SessionCoordinator | undefined;
  const windowHeartbeats = new WindowHeartbeats({
    owner: () => ({ windowId: windowCoordinator?.windowId ?? '', pid: process.pid }),
    connected: () => windowCoordinator?.environmentId ?? null,
    registry,
    settings: getSettings,
    sourceId: computerId,
    // Review round 1 of PR #85 (A-R1-3): the engine of the connected environment is the one of this window's own Docker
    // context (its authority, which its status file records as dockerContext), also for a local environment; never the
    // global current context when the window has its own (resolveHeartbeatEngine).
    engineFor: (environment, use) =>
      resolveHeartbeatEngine(environment, use, {
        windowContext: (shown) => (connection.currentContainerName() === shown.containerName ? connection.currentDockerContext() : undefined),
        current: () => outsideOperation(() => targets.resolve()),
        ofContext: (name) => outsideOperation(() => targets.ofContext(name)),
        // Review round 1 of PR #88 (A-R1-5): only an existing context; a heartbeat never creates one (a context that the
        // user removed is not made again by a tick).
        remoteContext: (host) =>
          outsideOperation(() => findRemoteContext(docker, host)).catch((error: unknown) => {
            logger.warn(`The Docker context of ${host} could not be had: ${errorMessage(error)}`);
            return undefined;
          }),
      }),
    // A-R2-2: in the scope of a heartbeat, the worker's preparation runs with the long signal (heartbeatPreparation).
    // Plan step 11D1: the operation `heartbeat` of the worker of that engine.
    send: (target, input, signal) => heartbeatPreparation.scope(() => monitorCalls.heartbeat(target, input, signal)),
    repair: repairSessionMonitor,
    // Review round 2 of PR #85 (A-R2-1): the container of the environment (its name in the registry) on that engine; any
    // failure counts as not there. Plan step 11D1: the operation `windowState` of the worker of that engine.
    containerExists: (target, environment, signal) => heartbeatPreparation.scope(() => monitorCalls.containerExists(target, environment, signal)),
    warn: (message) => {
      void vscode.window.showWarningMessage(message).then(undefined, (error: unknown) => logger.error('Could not show the message.', error));
    },
    logger,
  });
  context.subscriptions.push({ dispose: () => windowHeartbeats.dispose() });
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
  const sessionCoordinator = new SessionCoordinator({
    paths,
    sessionFiles,
    logger,
    settings: getSettings,
    windowDockerContext: () => connection.currentDockerContext(),
    windowHeartbeats,
    // Plan step 8, PR C (user decisions Q1 and Q2 of 2026-10-02): the release of an environment this window leaves.
    release: (environmentId, bounds) =>
      releaseEnvironment(
        {
          registry,
          settings: getSettings,
          // Review round 1 of PR #87 (A-R1-2): status files, pending connection files, and busy marks of other windows.
          otherWindowUses: (environment) => sessionCoordinator.otherWindowUses(environment),
          // Q2 (c): in the running dev container as its user, on the engine this window uses it on, through its worker.
          recordGitState: async (environment, signal) => {
            const target = await windowHeartbeats.connectedEngine(environment);
            if (target === undefined) return;
            // Plan step 11D1: the operation `recordGitState` of the worker of that engine.
            await heartbeatPreparation.scope(() => monitorCalls.recordGitState(target, environment, signal));
          },
          send: (id, limitSeconds, signal) => windowHeartbeats.release(id, limitSeconds, signal),
          // Review round 2 of PR #87 (A-R2-2): the last use, for Delete's note, at the start of every release.
          markSeenInUse: (environment, at) => registry.markSeenInUse(environment.id, at),
          logger,
        },
        environmentId,
        bounds,
      ),
    // Review round 2 of PR #87 (A-R2-2): a window that starts connected (a reload) was seen using its environment.
    markSeenInUse: (environmentId, at) => registry.markSeenInUse(environmentId, at),
  });
  windowCoordinator = sessionCoordinator;
  coordinator = sessionCoordinator;
  context.subscriptions.push(sessionCoordinator);
  // Plan step 11B1, 11B2 (decision of 2026-10-03, the worker is the deputy): the flows that run in the worker of the
  // current engine, with the HostSide of this computer answering their requests; one for the service and the controller.
  // Plan step 11E4d (decision of 2026-09-29): the containers that this window remembers, for its pipeline and its worker.
  const lifecycleMemory = windowLifecycleMemory();
  const workerFlow = extensionFlow(
    channels,
    () => targets.current(),
    extensionHostSide({
      registry,
      sessionFiles,
      ui,
      auth,
      credentials,
      windowId: sessionCoordinator.windowId,
      // Plan step 11C2a: the busy marks that a flow sets for this window, as its own pipeline sets them.
      pid: process.pid,
      clock: systemClock,
      isProcessAlive: (pid: number) => isProcessAlive(pid),
      // Plan step 11E4d: the profile of the account and the window's memory, for the open in the worker.
      viewer: (token, signal) => discovery.viewer(token, signal),
      lifecycleMemory,
      logger,
    }),
    logger,
  );
  // Plan step 11F1 (decision 1 of 2026-10-03): the operations of this window, each a flow in the worker of the Docker
  // target; the pipeline runs there (EnvironmentService), never here.
  const service = new EnvironmentOperations({
    flow: workerFlow,
    registry,
    sessionFiles,
    auth,
    lifecycleMemory,
    // Plan step 5, PR C: the refresh of the sidebar in one operation of the worker of the Docker target of the operation
    // (plan step 11C1: outside of an operation, of the current one; never read directly). Plan step 5, PR D (rule D1 of 2026-09-30): within
    // an operation, the worker is made ready first; when it cannot be, the refresh fails (never read directly).
    workerRefresh: async (environments) => {
      // Plan step 11C1: always through the worker, of the target of the operation or else the current one.
      const target = operationDockerTarget() ?? (await targets.current());
      try {
        return await channels.refresh(target, environments);
      } catch (error) {
        if (!(error instanceof HelperChannelError) || error.code !== 'unavailable') throw error;
        throw new UserFacingError('helperFailed', Messages.workerUnavailable(error.message), error.message);
      }
    },
    // Whether the Docker engine of the current target answers (Stop and the refresh do nothing without it).
    dockerRunning: () => docker.isRunning(),
    ui,
    logger,
    clock: systemClock,
    owner: { windowId: sessionCoordinator.windowId, pid: process.pid },
    // Plan step 11C2a: the id of this computer in the Session Monitor, for the `forget` of Delete in the worker.
    monitorSource: computerId,
    settings: getSettings,
    windowStatuses: () => sessionFiles.readWindowStatuses(),
    // Unit 7: new environments record the Docker host; only its environments are used. Review D2: an endpoint that is
    // neither local nor SSH is refused by every operation and never read.
    dockerTarget: () => targets.current(),
    // Plan step 11E6 (decision D1 of 2026-10-05): the image maintenance and the image list that an open carries for the
    // Session Monitor of its engine (the worker makes sure that the monitor runs, and sends its first heartbeat).
    // Plan step 11H2 (D1): the Docker host of the open is empty for the local Docker and names the SSH host otherwise.
    openMonitor: (dockerHost) => ({ images: imageMaintenance(dockerHost !== ''), ...imageListFor(dockerHost) }),
    // Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"): the commit and quality of this VS Code
    // (product.json under vscode.env.appRoot, read once), which an open sends when the build qualifies.
    vscodeServerOfWindow: windowVscodeServer(vscode.env.appRoot, (file) => fs.promises.readFile(file, 'utf8'), (message) => logger.info(message)),
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
    dockerTargets: targets,
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
    // Plan step 11B1 (decision of 2026-10-03, the worker is the deputy): a flow runs in the worker of the current engine,
    // and the HostSide of this computer answers its requests (hostSideHandler).
    flow: workerFlow,
    service,
    discovery,
    auth,
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
    // Unit 7, PR 2: Close and Keep Running tells the Session Monitor at once. Plan step 8, PR A: on every engine, and
    // Keep Running When Closed and Stop When Closed too, through this window's worker of the engine.
    sessionMonitor: {
      sendHeartbeat: (environmentId) => windowHeartbeats.sendFor(environmentId),
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
  // Writes the window status file and cleans up the storage folder (plan step 8, PR C). Its result is the pending connection file of this
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
  // Review round 2 of 11C3 (A-R2-M1): a window whose container the registry did not know takes its restored environment.
  const adopt = Boolean(containerName) && currentEnvironment === undefined;
  background(controller.reconcileIfRegistryLost({ passive: true, adopt }), 'restore the environments from the volumes');
  // User decision 2026-09-29 (no previous helper image): when helper.json does not know the current helper tag (after the
  // installation, or an update that changed it; review round 7 of PR #64, R7-2), the helper image is built in the background, when Docker runs (review round
  // 6 of PR #64, R6-1: no cross-window lock; windows that start together may each build once, later ones find the record).
  // The build (HelperImages.prebuildImage) is shared with the preparation of a worker in this window
  // (HelperImages.ensureImagePresent, ensureImageUse before an open) and cancelled when the extension is deactivated.
  // PR H (decision of 2026-10-09): with updateImagesOnConnect on, it also runs when helper.json says that the refresh of
  // the helper image is due (the rebuild that a check asked for, the weekly check), never for the daily cleanup alone; its
  // maintaining ensure then also runs the cleanup when that is due. Plan step 6, PR D: on the Docker engine of the current
  // Docker context, local or remote alike, as an operation on it (the state file and engine key of an open there); a
  // remote host gets our own SSH check without questions before its `docker info` (dockerEngineAnswers). A host switch
  // starts no new prebuild: the next activation, or the first open on that host, builds its tag.
  const helperPrebuild = new HelperPrebuild({
    helper,
    dockerRunning: (target, signal) =>
      dockerEngineAnswers(target, { daemonStatus: (s, timeoutMs) => docker.daemonStatus(s, timeoutMs), ssh: remoteDeps(), logger }, signal),
    dockerfilePath: context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile')),
    statePath: paths.helperState,
    // PR H (decision of 2026-10-09): the setting decides the check of the base image and the rebuild, not the cleanup.
    checkBaseImage: () => getSettings().updateImagesOnConnect,
    logger,
  });
  context.subscriptions.push(helperPrebuild);
  background(
    targets
      .current()
      .then((target) => helperPrebuild.start(target))
      // Review round 1 of 11C3 (A-R1-M2): a lost registry is restored again once the helper image was built.
      .then((outcome) =>
        // Review round 3 of 11C3 (A-R3-L3): a failed restore is logged as such, not as a failed preparation.
        restoreAfterPrebuild(outcome, () => controller.reconcileIfRegistryLost({ passive: false, adopt })).catch((error: unknown) =>
          logger.error('Could not restore the environments from the volumes after the helper image was prepared.', error),
        ),
      ),
    'prepare the workspace helper image in the background',
  );

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
      const context = own ?? (current && isOnDockerHost(environment, current.host) ? current.context : host === '' ? undefined : await findRemoteContext(docker, host));
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
