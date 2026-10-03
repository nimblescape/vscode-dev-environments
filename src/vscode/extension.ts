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
import { ContainerAdapter, DOCKER_QUERY_TIMEOUT_MS } from '../core/docker/containerAdapter';
import { dockerProcessEnv, findDockerCli, findExecutable } from '../core/docker/dockerCli';
import { dockerHostOf, isOnDockerHost, sshEndpoint, type DockerTarget } from '../core/docker/dockerHost';
import { ensureDockerRunning } from '../core/docker/dockerStart';
import { DockerTargets, operationDockerTarget, outsideOperation, runWithDockerTarget } from '../core/docker/dockerTargets';
import { SshLoginCache, findRemoteContext, startDockerFor, type RemoteReachabilityDeps } from '../core/docker/remoteDocker';
import { DiscoveryService } from '../core/discovery/discoveryService';
import { GitHubApi } from '../core/discovery/githubApi';
import { sameScope } from '../core/discovery/scope';
import { errorMessage, UserFacingError } from '../core/errors';
import { WorkerConfigurationAnalyzer } from '../core/helper/configurationAnalysisRunner';
import { helperImageTag, registryBaseDigest } from '../core/helper/helperImage';
import { HelperPrebuild, dockerEngineAnswers } from '../core/helper/helperPrebuild';
import { DOCKER_SOCKET, WorkspaceHelper, helperDockerSocket } from '../core/helper/workspaceHelper';
import { HelperChannels, openHelperChannel } from '../core/helperChannel/helperChannels';
import { HelperChannelError } from '../core/helperChannel/helperChannel';
import { Messages } from '../core/messages';
import { nodeHttpsTransport } from '../core/http';
import { DockerCredentialStore, withGitHubPackagesFallback } from '../core/imageCheck/credentials';
import { ImageChecker } from '../core/imageCheck/imageCheck';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { systemClock, type Logger } from '../core/ports';
import { RemoteSessionMonitor } from '../core/remoteMonitor/remoteSessionMonitor';
import { DEFAULT_IMAGE_SCHEDULE, usableTimeZone } from '../core/remoteMonitor/cron';
import { PACKAGES_TIMEOUT_MS, ghcrOwnerOf, ghcrRepositories } from '../core/remoteMonitor/imageRepositories';
import { MAX_IMAGE_REPOSITORIES, REMOTE_MONITOR_VOLUME, imagePrefixesOf } from '../core/remoteMonitor/protocol';
import { EnvironmentService } from '../core/pipeline/environmentService';
import { githubPackagesPullCredentials } from '../core/pipeline/pullCredentials';
import { NodeProcessRunner } from '../core/process';
import { nodeSshConfigFiles, parseSshConfig } from '../core/sshConfig';
import { ClosingWork } from '../core/session/closingWork';
import { heartbeatWiring, monitorEnsure } from '../core/session/heartbeatWiring';
import { stopAfterSeconds } from '../core/session/sessionRules';
import { WindowHeartbeats, resolveHeartbeatEngine } from '../core/session/windowHeartbeats';
import { releaseEnvironment } from '../core/session/windowRelease';
import { readOrCreateComputerId } from '../core/storage/computerId';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import { RemoteDockerState } from '../core/storage/remoteDockerState';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { Environment, ExtensionSettings } from '../core/types';
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
import { sessionMonitorEnsure } from './sessionMonitorEnsure';
import { affectsSettings, readSettings, warnInvalidHostAccessChecksOff } from './settings';
import { Sidebar } from './sidebar';
import { EnvironmentStatusBar } from './statusBar';
import { Throttle } from './tasks';
import { REPOSITORIES_VIEW_ID, RepositoriesTreeProvider, type TreeNode } from './treeView';

/** A window that gets the focus refreshes the sidebar at most this often. */
const FOCUS_REFRESH_INTERVAL_MS = 15_000;
/** User requests 2026-09-28: the image list for the monitor of a host is sent at most this often. */
export const IMAGE_LIST_INTERVAL_MS = 60 * 60_000;

/** The name of an engine in the log and the messages: the remote host, or the local Docker (host ''). */
function engineName(host: string): string {
  return host === '' ? 'the local Docker' : host;
}
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
  const docker = new ContainerAdapter(runner, dockerPath, env, logger, platform, {
    ...adapterOptions,
    onDaemonStatus: (running) => {
      if (running && !daemonRunning) helperChannels?.clearFailures();
      daemonRunning = running;
      adapterOptions.onDaemonStatus?.(running);
    },
    // Plan step 10A: a pull through the worker sends the credentials that Docker stored here (the store comes below).
    storedCredentials: (registry, signal) => credentials.getForPull(registry, signal),
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
  const imageChecker = new ImageChecker(registryClient, logger);
  const helperDockerfile = context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile'));
  const helper = new WorkspaceHelper({
    docker,
    logger,
    dockerfilePath: helperDockerfile,
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
  // remote. The plain Docker calls of an operation go through it (ContainerAdapter.run, dockerRouting.ts); everything
  // else runs directly. Plan step 5, PR D (rule D1 of 2026-09-30): a call that needs it makes it ready first (the helper
  // image, then the open), and is refused when that fails, never run directly. Its socket mount is the one of the
  // workspace helper on that engine.
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
    // ensures it before the lock (only a missing tag is built). A-R2-2: for a heartbeat, with the long signal.
    prepare: async (target, signal) => {
      // Review round 3 of PR #85 (A-R3-1): for a heartbeat, no new build on this engine within the wait after a failed one;
      // review round 4 of PR #85 (A-R4-1): within it, the heartbeat goes on when the tag is present (heartbeatWiring).
      await heartbeats.prepareWorker(target, signal);
    },
    // PR #76 review round 1 (A-R1-1, A-R1-2): the refresh of the sidebar only checks that the helper image is present.
    checkPresent: async (target, signal) => {
      await runWithDockerTarget(target, () => helper.checkImagePresent({ signal }));
    },
    open: (target) =>
      openHelperChannel(
        {
          start: (args) => docker.start(args),
          runDirect: (args, options) => docker.runDirect(args, options),
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
        },
        target,
      ),
  });
  helperChannels = channels;
  docker.setRouter((target, args, options) => channels.docker(target, args, options));
  // Plan step 10A (decision of 2026-10-03): the operations of the worker over the Engine API.
  docker.setWorkerEngine({
    pull: (target, reference, options) => channels.pull(target, reference, options),
    startContainers: (target, ids, options) => channels.startContainers(target, ids, options),
  });
  // Plan step 8, PR C: after the release of deactivate() (bounded; it never rejects), which needs the worker.
  context.subscriptions.push(
    closingWork.deferred({
      dispose: () => {
        docker.setRouter(undefined);
        docker.setWorkerEngine(undefined);
        channels.dispose();
      },
    }),
  );
  // Unit 7, PR 2: the Session Monitor container of a Docker engine (plan step 8, PR A: every engine, local and remote).
  // Its script is dist/remoteMonitor.js, read once.
  const remoteMonitorScript = context.asAbsolutePath(path.join('dist', 'remoteMonitor.js'));
  let remoteMonitorScriptText: Promise<string> | undefined;
  const remoteMonitor = new RemoteSessionMonitor({
    docker,
    logger,
    // User requests 2026-09-28: the image maintenance of the monitor (the settings imageUpdates and imageUpdateSchedule,
    // in the time zone of this computer; plan step 8, PR A: on every engine).
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
    const patterns = getSettings().imageUpdates ?? [];
    const prefixes = imagePrefixesOf(patterns);
    const left = patterns.filter((pattern) => !prefixes.includes(pattern.trim().replace(/\*$/, '')));
    if (left.length > 0 && JSON.stringify(left) !== warnedPatterns) {
      warnedPatterns = JSON.stringify(left);
      logger.warn(`These image patterns of devEnvLauncher.imageUpdates are not used (invalid, Docker Hub, duplicate, or beyond 50 patterns or 4096 characters): ${left.join(', ')}`);
    }
    return prefixes;
  };
  const imageMaintenance = () => ({
    prefixes: usedImagePrefixes(),
    schedule: getSettings().imageUpdateSchedule ?? DEFAULT_IMAGE_SCHEDULE,
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
      logger.warn(`GitHub lists ${repositories.length} image repositories for ${prefixes.join(', ')}; the Session Monitor on ${engineName(host)} gets the first ${MAX_IMAGE_REPOSITORIES}.`);
      repositories = repositories.slice(0, MAX_IMAGE_REPOSITORIES);
    }
    logger.info(`The Session Monitor on ${engineName(host)} keeps ${repositories.length} image repositories up to date: ${repositories.join(', ')}.`);
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
      logger.info(`The image list for ${engineName(host)} needs the GitHub sign-in for packages; the Session Monitor there updates only the images that it has.`);
      if (!packagesSignInOffered) {
        packagesSignInOffered = true;
        void vscode.window.showInformationMessage(ImageListTexts.signInQuestion(engineName(host)), ImageListTexts.signIn).then(async (choice) => {
          if (choice !== ImageListTexts.signIn) return;
          if (await auth.getPackagesCredentials({ interactive: true })) imageListSentAt.delete(host);
        });
      }
      return;
    }
    imageListSentAt.set(host, Date.now());
    inTarget(() => sendRepositories(host, prefixes, credentials.password));
  };
  const connection = new ConnectionAdapter(logger);
  // The source of the heartbeats (computer.id); created by the first reader.
  const computerId = (): string => readOrCreateComputerId(paths.computerId);
  const limitSeconds = (): number => stopAfterSeconds(getSettings().stopAfterMinutes);
  // Plan step 8, PR A (user decision Q4 of 2026-10-02): the heartbeats of this window to the Session Monitor container of
  // the engine of each environment it uses, through this window's worker of that engine (a routed `docker exec`: the
  // worker is made ready first, D1); a missing monitor is started again as the open starts it.
  // Review round 1 of PR #85 (A-R1-2): `signal` aborts at the deadline of the heartbeat's attempt. Review round 2 of PR
  // #85 (A-R2-2): it ends only the wait for the helper image, whose build runs with the long signal of the preparation.
  // A-R3-1: the same wait after a failed build on this engine as for the worker of a heartbeat; A-R4-1: within it, the
  // repair goes on with the tag when it is present (heartbeatWiring.repair).
  // Review round 6 of PR #85 (B-R6-6): its start of the monitor (monitorEnsure) is tested in core.
  const repairSessionMonitor = heartbeats.repair(monitorEnsure(remoteMonitor, engineSocket));
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
    send: async (target, input, signal) => {
      const result = await heartbeatPreparation.scope(() => runWithDockerTarget(target, () => remoteMonitor.heartbeat(input, signal)));
      return result.ok ? { ok: true } : { ok: false, missing: result.missing, detail: result.detail };
    },
    repair: repairSessionMonitor,
    // Review round 2 of PR #85 (A-R2-1): the container of the environment (its name in the registry) on that engine, a
    // routed `docker container inspect`; any failure counts as not there.
    containerExists: async (target, environment, signal) => {
      try {
        const result = await heartbeatPreparation.scope(() =>
          runWithDockerTarget(target, () =>
            docker.run(['container', 'inspect', '--format', '{{.Id}}', environment.containerName], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, signal }),
          ),
        );
        return result.exitCode === 0 && result.stdout.trim() !== '';
      } catch (error) {
        logger.info(`The container of ${environment.repository} could not be checked on ${target.kind === 'local' ? 'the local Docker' : target.host}: ${errorMessage(error)}`);
        return false;
      }
    },
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
            await heartbeatPreparation.scope(() => runWithDockerTarget(target, () => service.recordGitState(environment.id, signal)));
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
    // Plan step 5, PR C: the refresh of the sidebar in one operation of the worker of the Docker target of the operation
    // (none outside of an operation: the refresh reads directly then). Plan step 5, PR D (rule D1 of 2026-09-30): within
    // an operation, the worker is made ready first; when it cannot be, the refresh fails (never read directly).
    workerRefresh: async (environments) => {
      const target = operationDockerTarget();
      if (target === undefined) return undefined;
      try {
        return await channels.refresh(target, environments);
      } catch (error) {
        if (!(error instanceof HelperChannelError) || error.code !== 'unavailable') throw error;
        throw new UserFacingError('helperFailed', Messages.workerUnavailable(error.message), error.message);
      }
    },
    // Plan step 5, PR B: the lock of an environment in the worker of the Docker target of the operation (Stop, Delete).
    environmentLock: async (environmentId, waitSeconds, signal) => channels.lock(await targets.current(), environmentId, waitSeconds, signal),
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
    // Unit 7, PR 2: the Session Monitor of the engine, with the socket that the workspace helper mounts there. Plan step 8,
    // PR A: on every engine; its calls run in the operation (through its worker where they are plain Docker calls).
    sessionMonitor: {
      ensure: sessionMonitorEnsure(remoteMonitor, engineSocket),
      heartbeat: async (_target, environmentId, keepRunning, seq) => {
        const result = await remoteMonitor.heartbeat({
          source: computerId(),
          limitSeconds: limitSeconds(),
          environments: [{ id: environmentId, keepRunning, seq }],
        });
        return result.ok ? { ok: true } : { ok: false, detail: result.detail };
      },
      forget: async (_target, environmentId) => remoteMonitor.forget(computerId(), environmentId),
      images: async (target) => sendImageList(target.host),
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
  background(controller.reconcileIfRegistryLost(), 'restore the environments from the volumes');
  // User decision 2026-09-29 (no previous helper image): when helper.json does not know the current helper tag (after the
  // installation, or an update that changed it; review round 7 of PR #64, R7-2), the helper image is built in the background, when Docker runs (review round
  // 6 of PR #64, R6-1: no cross-window lock; windows that start together may each build once, later ones find the record).
  // The build is shared with the open pipeline of this window (WorkspaceHelper.prebuildImage) and cancelled when the
  // extension is deactivated. Plan step 6, PR D: on the Docker engine of the current Docker context, local or remote
  // alike, as an operation on it (the state file and engine key of an open there); a remote host gets our own SSH check
  // without questions before its `docker info` (dockerEngineAnswers). A host switch starts no new prebuild: the next
  // activation, or the first open on that host, builds its tag.
  const helperPrebuild = new HelperPrebuild({
    helper,
    dockerRunning: (target, signal) =>
      dockerEngineAnswers(target, { daemonStatus: (s, timeoutMs) => docker.daemonStatus(s, timeoutMs), ssh: remoteDeps(), logger }, signal),
    dockerfilePath: context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile')),
    statePath: paths.helperState,
    logger,
  });
  context.subscriptions.push(helperPrebuild);
  background(
    targets.current().then((target) => helperPrebuild.start(target)),
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
