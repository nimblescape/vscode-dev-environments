// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (decision of 2026-10-03, the worker is the deputy): the HostSide of this computer, which answers the
// requests of a flow that runs in the worker (hostSideHandler). It is the only place where those requests reach VS Code,
// the registry, the session files and the sign-ins; the flow itself has none of them.
import type { EnvironmentRegistry } from '../core/storage/registry';
import type { SessionFiles } from '../core/storage/sessionFiles';
import type { GitHubAuth, Logger, PipelineUi } from '../core/ports';
import { credentialServerName } from '../core/imageCheck/reference';
import type { DockerCredentialStore } from '../core/imageCheck/credentials';
import { IDENTITY_TOKEN_USER } from '../core/imageCheck/credentials';
import { FLOW_REQUESTS, type HostSide } from '../core/worker/hostSide';
import { registryBusyMarks, type BusyMarkView } from '../core/pipeline/busyMarks';
import { requestOpenRecords, type OpenRequestScope, type OpenRequests } from '../core/worker/openRequests';
import { isoTime, type Clock } from '../core/ports';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import type { HelperChannels } from '../core/helperChannel/helperChannels';
import type { DockerTarget } from '../core/docker/dockerHost';
import { errorMessage } from '../core/errors';
import type { GitHubViewer } from '../core/helper/containerGit';
import type { HelperMaintenance } from '../core/helper/helperImages';
import type { LifecycleMemory } from '../core/pipeline/lifecycleMemory';

export interface HostSideDeps {
  // Plan step 11E4c: changed (`add` is gone with `record add`; `update` for the writes of the open that read the whole registry).
  registry: Pick<EnvironmentRegistry, 'read' | 'get' | 'list' | 'findForAccount' | 'restore' | 'update' | 'updateEnvironment' | 'remove' | 'forgetKeptVolumes'>;
  sessionFiles: Pick<
    SessionFiles,
    'readWindowStatuses' | 'readPendings' | 'writePending' | 'removePending' | 'removeOperation' | 'removeReopenOf' | 'removeDisconnectRequest'
  >;
  ui: PipelineUi;
  auth: Pick<GitHubAuth, 'getToken' | 'getPackagesCredentials' | 'getAccount'>;
  /** The registry logins that Docker stored on this computer (DockerCredentialStore.getForPull). */
  credentials: Pick<DockerCredentialStore, 'getForPull'>;
  /** The window of this computer (its id, for the pending files that a flow writes). */
  windowId: string;
  /** Plan step 11C2a: the extension host of this window (its process id), for the busy marks of a flow. */
  pid: number;
  /** Plan step 11C2a: the clock of the busy marks. */
  clock: Clock;
  isProcessAlive: (pid: number) => boolean;
  /** Plan step 11E4d: the GitHub profile of a token (DiscoveryService.viewer); without it, `local viewer` answers none. */
  viewer?: (token: string, signal?: AbortSignal) => Promise<GitHubViewer>;
  /** Plan step 11E4d (decision of 2026-09-29): the memory of this window, which its own pipeline uses too. */
  lifecycleMemory: LifecycleMemory;
  logger: Logger;
}

/** Plan step 11E4d: the time limit of the question to GitHub for the profile (as EnvironmentService.identityOf). */
const VIEWER_TIMEOUT_MS = 5_000;

/** The only registry for which the GitHub sign-in is a login (concept 7.7); everything else comes from Docker's store. */
const GITHUB_PACKAGES_REGISTRY = 'ghcr.io';

/** Plan step 11B1: what a flow in the worker may ask this computer for. */
export function extensionHostSide(deps: HostSideDeps): HostSide {
  // Plan step 11C2a (decision of 2026-10-04): the same busy marks as the pipeline of this window sets itself.
  const markView: BusyMarkView = {
    owner: { windowId: deps.windowId, pid: deps.pid },
    clock: deps.clock,
    isAlive: (pid) => deps.isProcessAlive(pid),
    windowStatuses: () => deps.sessionFiles.readWindowStatuses(),
    logger: deps.logger,
  };
  const busyMarks = registryBusyMarks(deps.registry, markView);
  // Plan step 11E4b (decision of 2026-10-04): the registry writes of the open for a request of the worker, with the owner,
  // clock and view of the windows of this window, only on an entry of the account signed in here (read now, never the
  // worker's) on the Docker host of the operation (`scope`, from the handler).
  const openRequests = async (scope: OpenRequestScope | undefined): Promise<OpenRequests> => {
    if (scope === undefined) throw new Error('The registry write of the open names no Docker host of its operation.');
    const account = await deps.auth.getAccount({ interactive: false });
    if (account === undefined) throw new Error('No GitHub account is signed in in this window.');
    return requestOpenRecords(deps.registry, markView, { account: { id: account.id, login: account.login }, dockerHost: scope.dockerHost });
  };
  return {
    questions: {
      confirmUntrustedRepository: (repository) => deps.ui.confirmUntrustedRepository(repository),
      configurationChanged: (repository) => deps.ui.configurationChanged(repository),
      configurationKindChanged: (repository, message) => deps.ui.configurationKindChanged(repository, message),
      filesMissing: (repository) => deps.ui.filesMissing(repository),
      recreateContainer: (repository, question) => deps.ui.recreateContainer(repository, question),
      // Plan step 11C2b: the questions of Delete.
      confirmDelete: (repository, confirmation) => deps.ui.confirmDelete(repository, confirmation),
      deleteAdditionalVolumes: (volumes) => deps.ui.deleteAdditionalVolumes(volumes),
      deleteServiceData: (volumes, possibly) => deps.ui.deleteServiceData(volumes, possibly),
      message: async (kind, text) => {
        if (kind === 'info') deps.ui.info(text);
        else if (kind === 'warn') deps.ui.warn(text);
        else deps.ui.registrySignIn(text);
      },
    },
    state: {
      windowStatuses: () => deps.sessionFiles.readWindowStatuses(),
      pendings: async () => (await deps.sessionFiles.readPendings()).map((pending) => ({ ...pending })),
      processAlive: async (pid) => deps.isProcessAlive(pid),
      account: (interactive) => deps.auth.getAccount({ interactive }),
      // Plan step 11E4d: with the token of this window, never one of the worker; only the profile of the signed-in account.
      viewer: async () => {
        if (!deps.viewer) return undefined;
        try {
          const account = await deps.auth.getAccount({ interactive: false });
          const token = await deps.auth.getToken({ interactive: false });
          if (account === undefined || token === undefined) return undefined;
          const profile = await deps.viewer(token, AbortSignal.timeout(VIEWER_TIMEOUT_MS));
          return String(profile.databaseId) === account.id ? profile : undefined;
        } catch (error) {
          deps.logger.info(`The GitHub profile could not be read for the worker: ${errorMessage(error)}`);
          return undefined;
        }
      },
      unrecordedLifecycle: (environmentId) => deps.lifecycleMemory.get(environmentId),
    },
    records: {
      read: () => deps.registry.read(),
      get: (id) => deps.registry.get(id),
      list: () => deps.registry.list(),
      findForAccount: (repository, accountId, dockerHost) => deps.registry.findForAccount(repository, accountId, dockerHost),
      // Review round 1 of 11C2a (A-R1-L2): the volumes of a removal are the additional volumes of the entry, never the kept
      // volumes of another environment or account.
      remove: async (id, volumes) => {
        const own = new Set((await deps.registry.get(id))?.additionalVolumes ?? []);
        const odd = [...(volumes.kept ?? []), ...(volumes.removed ?? [])].filter((name) => !own.has(name));
        if (odd.length > 0) throw new Error(`The volumes ${odd.join(', ')} are not additional volumes of the environment.`);
        await deps.registry.remove(id, volumes);
      },
      forgetKeptVolumes: (names) => deps.registry.forgetKeptVolumes(names),
      // Plan step 11E4d: the memory of this window (the handler checks the environment and the container ID).
      rememberLifecycle: (environmentId, containerId) => deps.lifecycleMemory.remember(environmentId, containerId),
      forgetLifecycle: (environmentId, containerId) => deps.lifecycleMemory.forget(environmentId, containerId),
      sessionFile: async (kind, environmentId) => {
        if (kind === 'writePending') await deps.sessionFiles.writePending(environmentId, deps.windowId);
        else if (kind === 'removePending') await deps.sessionFiles.removePending(environmentId);
        else if (kind === 'removeOperation') await deps.sessionFiles.removeOperation(environmentId);
        else if (kind === 'removeReopenOf') await deps.sessionFiles.removeReopenOf(environmentId);
        else if (kind === 'removeDisconnectRequest') await deps.sessionFiles.removeDisconnectRequest(environmentId);
        // PR #125 review round 1 (A L-3): a second guard behind the handler's allowlist.
        else throw new Error(`The session file request ${String(kind)} is not known.`);
      },
      markBusy: (environmentId, operation, onReplaced) => busyMarks.mark(environmentId, operation, onReplaced),
      clearBusy: (environmentId) => busyMarks.clear(environmentId),
      // Plan step 11C2b (decision of 2026-10-04): the Git state that the worker read, under the registry lock.
      recordGitSummary: async (environmentId, summary) =>
        void (await deps.registry.updateEnvironment(environmentId, (entry) => {
          entry.gitSummary = summary;
        })),
      // Plan step 11C3 (decision of 2026-10-04): the entries rebuilt from the volumes, with the clock of this window.
      restore: async (entries) => {
        const now = isoTime(deps.clock);
        return deps.registry.restore(entries.map((entry) => ({ ...entry, createdAt: now, lastUsedAt: now })));
      },
      // Plan step 11E4b: the registry writes of the open (requestOpenRecords).
      createMark: async (environmentId, kind, previous, scope) => (await openRequests(scope)).createMark(environmentId, kind, previous),
      takeStepMark: async (environmentId, operation, scope) => (await openRequests(scope)).takeStepMark(environmentId, operation),
      releaseStepMark: async (environmentId, mark, scope) => (await openRequests(scope)).releaseStepMark(environmentId, mark),
      ownerLogin: async (environmentId, scope) => (await openRequests(scope)).ownerLogin(environmentId),
      lifecycleMark: async (environmentId, change, scope) => (await openRequests(scope)).lifecycleMark(environmentId, change),
      openFinished: async (environmentId, finish, scope) => (await openRequests(scope)).openFinished(environmentId, finish),
      // Plan step 11E4c: the entry of a first open, its removal, the configuration and the build records (requestOpenRecords).
      createEnvironment: async (id, repository, configPath, scope) => (await openRequests(scope)).createEnvironment({ id, repository, configPath }),
      dropCreated: async (environmentId, scope) => (await openRequests(scope)).dropCreated(environmentId),
      configuration: async (environmentId, change, scope) => (await openRequests(scope)).configuration(environmentId, change),
      build: async (environmentId, change, scope) => (await openRequests(scope)).build(environmentId, change),
    },
    secrets: {
      token: async () => deps.auth.getToken({ interactive: false }),
      registry: async (registry) => {
        const stored = await deps.credentials.getForPull(registry);
        if (stored !== undefined) {
          const serveraddress = credentialServerName(registry);
          return stored.username === IDENTITY_TOKEN_USER
            ? { identityToken: true, serveraddress, password: stored.password }
            : { username: stored.username, serveraddress, password: stored.password };
        }
        if (registry.toLowerCase() !== GITHUB_PACKAGES_REGISTRY) return undefined;
        // Concept 7.7: the GitHub sign-in is the login of ghcr.io when Docker has none; never asked with a dialog.
        const login = await deps.auth.getPackagesCredentials({ interactive: false }).catch(() => undefined);
        return login === undefined ? undefined : { username: login.username, serveraddress: GITHUB_PACKAGES_REGISTRY, password: login.password };
      },
    },
  };
}

/** Plan step 11C2a: the environment of an operation, from its parameters (`environmentId`), for SCOPED_REQUESTS. */
function environmentOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const id = (params as { environmentId?: unknown }).environmentId;
  return typeof id === 'string' ? id : undefined;
}

/** Plan step 11C3: the Docker host of an operation, from its parameters (`dockerHost`), for `record restore`. */
function dockerHostOfParams(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const host = (params as { dockerHost?: unknown }).dockerHost;
  return typeof host === 'string' ? host : undefined;
}

/** Review round 1 of 11C2b (A-R1-M2): the name of the repository that the questions of the operation name. */
function repositoryOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const repository = (params as { repository?: unknown }).repository;
  return typeof repository === 'string' ? repository : undefined;
}

/**
 * Plan step 11B1: runs the flow `op` in the worker of the current engine; the HostSide of this computer answers its
 * requests, and only those that the operation may send (FLOW_REQUESTS; review round 2 of 11B1, B-R1-1: one place, tested).
 */
export function extensionFlow(
  channels: Pick<HelperChannels, 'flow'>,
  current: () => Promise<DockerTarget>,
  host: HostSide,
  logger: Logger,
): (
  op: string,
  params: unknown,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    passive?: boolean;
    onAnswer?: (call: string, args: unknown[], value: unknown) => void;
    onQuestion?: (state: 'asked' | 'settled') => void;
    // Plan step 11E6: the progress of the flow (the steps of the open).
    onProgress?: (step: string, detail?: string) => void;
    // Plan step 11D1: the engine of the flow when it is not the current one (the heartbeats and the release of a window
    // go to the engine that the window uses the environment on).
    target?: DockerTarget;
    // PR H (decision of 2026-10-09): the helper image maintenance of the preparation of the worker of an operation `open`.
    helperMaintenance?: HelperMaintenance;
  },
) => Promise<unknown> {
  return async (op, params, options) =>
    channels.flow(options.target ?? (await current()), op, params, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      // Plan step 11C1, review round 1 (A-R1-1): a read in the background never builds the helper image.
      ...(options.passive === true ? { passive: true } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      // PR H (decision of 2026-10-09): only the open passes it; the worker of the open is prepared with it (HelperChannels).
      ...(options.helperMaintenance ? { helperMaintenance: options.helperMaintenance } : {}),
      // Review round 1 of 11C2b (A-R1-M1, A-R1-M2): the repository that the questions name, and the observer of the answers.
      onAsk: hostSideHandler(host, logger, Object.hasOwn(FLOW_REQUESTS, op) ? FLOW_REQUESTS[op] : [], {
        environmentId: environmentOf(params),
        repository: repositoryOf(params),
        dockerHost: dockerHostOfParams(params),
        ...(options.onAnswer ? { onAnswer: options.onAnswer } : {}),
        ...(options.onQuestion ? { onQuestion: options.onQuestion } : {}),
      }),
    });
}
