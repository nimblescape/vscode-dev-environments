// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3b (decision of 2026-10-03, the worker is the deputy; user decision of 2026-10-04, "recommended"): the
// core services of the pipeline as the worker constructs them for one operation. EnvironmentService and WorkspaceHelper
// run unchanged; what they need from the user's computer goes through the requests of the operation (HostSide), the
// engine is the worker's own (EngineDocker), the helper image is the worker's own image, and the lock and the batch
// helper are taken in the worker (`environmentLock`, given by the operation). What only the open runs (the host access
// analysis, the image update check, the variables of the computer) comes with plan step 11E; until
// then it fails closed here, as do the record writes by a function (plan steps 11D, 11E) and the Session Monitor beyond Delete's
// `forget` (plan step 11D). Plan step 11C2a: the busy marks are specific requests to the extension (decision of
// 2026-10-04); plan step 11E4b: so are the registry writes of the open (hostOpenRecords); plan step 11E4d: the liveness of
// the processes of the computer, the GitHub profile and the window's lifecycle memory are asked of the extension. Pure
// over its deps; no `vscode`.
import { UserFacingError, errorMessage } from '../errors';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import type { ConfigurationAnalyzer } from '../helper/configurationAnalysis';
import { WorkspaceHelper } from '../helper/workspaceHelper';
import { ImageChecker } from '../imageCheck/imageCheck';
import { RegistryClient, type CredentialsProvider } from '../imageCheck/registryClient';
import { IDENTITY_TOKEN_USER } from '../imageCheck/credentials';
import { proxiedHttpsTransport } from '../proxyTransport';
import { SECRET_REGISTRY } from '../helperChannel/protocol';
import { Messages } from '../messages';
import { EnvironmentService, type EnvironmentServiceDeps, type EnvironmentSessionFiles, type EnvironmentSessionMonitor, type EnvironmentStore } from '../pipeline/environmentService';
import type { EnvironmentBusyMarks } from '../pipeline/busyMarks';
import type { OpenRecords } from '../pipeline/openRecords';
import type { LifecycleMemory } from '../pipeline/lifecycleMemory';
import { systemClock, type GitHubAuth, type Logger, type PipelineUi } from '../ports';
import type { ExtensionSettings } from '../types';
import type { DockerEngine } from './dockerEngine';
import { forgetRecord, sendHeartbeat } from './monitorFlow';
import { isSourceId } from '../remoteMonitor/protocol';
import { stopAfterSeconds } from '../session/sessionRules';
import { EngineDocker } from './engineDocker';
import { readEnvironmentStates } from '../pipeline/refreshStates';
import type { HostSide } from './hostSide';
import type { OwnHelper } from './ownHelper';

/** What a part of the pipeline that is not in the worker yet throws (fail closed); `step` names the plan step that brings it. */
function notInWorker(what: string, step: string): Error {
  return new Error(`${what} does not run in the worker before plan step ${step}.`);
}

/**
 * EnvironmentStore over the `record` requests; a write by a function cannot cross the channel (plan step 11C: each write
 * is a specific request, decision of 2026-10-04).
 */
export function hostStore(records: HostSide['records']): EnvironmentStore {
  return {
    read: () => records.read(),
    get: (id) => records.get(id),
    list: () => records.list(),
    findForAccount: (repository, accountId, dockerHost = '') => records.findForAccount(repository, accountId, dockerHost),
    // Plan step 11E4c: the entry of a first open is `record createEnvironment` (hostOpenRecords); no other entry is added.
    add: async () => {
      throw new Error('The worker adds a registry entry only as the entry of a first open (record createEnvironment).');
    },
    remove: (id, volumes = {}) => records.remove(id, volumes),
    forgetKeptVolumes: (names) => records.forgetKeptVolumes(names),
    // Plan step 11C3: the entries rebuilt from the volumes of the engine.
    restore: (entries) => records.restore(entries),
    // The changes of an entry by the flows that still make them become specific requests when they move (plan steps 11D,
    // 11E); plan step 11E4c: those of the open are the requests of hostOpenRecords.
    updateEnvironment: async () => {
      throw notInWorker('A change of a registry entry by a function', '11D or 11E');
    },
  };
}

/** EnvironmentSessionFiles over the `record sessionFile` and `local pendings` requests. */
export function hostSessionFiles(host: HostSide): EnvironmentSessionFiles {
  return {
    // The pending file is always the one of the window that sent the operation (the extension knows it).
    writePending: (environmentId) => host.records.sessionFile('writePending', environmentId),
    removePending: (environmentId) => host.records.sessionFile('removePending', environmentId),
    removeOperation: (environmentId) => host.records.sessionFile('removeOperation', environmentId),
    removeDisconnectRequest: (environmentId) => host.records.sessionFile('removeDisconnectRequest', environmentId),
    removeReopen: () => host.records.sessionFile('removeReopen', ''),
    // Plan step 11C2a: the extension reads the reopen record and removes it when it names the environment.
    removeReopenOf: (environmentId) => host.records.sessionFile('removeReopenOf', environmentId),
    readPendings: async () => [...(await host.state.pendings())],
    readReopen: async () => {
      throw notInWorker('The reopen record', '11E');
    },
  };
}

/**
 * Plan step 11C2a (decision of 2026-10-04): the busy marks of the window that sent the operation, which the extension
 * sets and clears (`record markBusy`, `record clearBusy`) with its clock and its view of the windows.
 */
export function hostBusyMarks(records: HostSide['records']): EnvironmentBusyMarks {
  return {
    mark: (environmentId, operation) => records.markBusy(environmentId, operation),
    clear: (environmentId) => records.clearBusy(environmentId),
  };
}

/**
 * Plan step 11E4b (decision of 2026-10-04): the registry writes of the open as requests to the extension, which applies
 * them with its owner, clock, account and view of the windows (`record createMark`, `record stepMark`, `record
 * ownerLogin`, `record lifecycleMark`, `record openFinished`). The worker sends neither the account of the owner, nor
 * the time of the last use, nor the liveness of the marks: the extension takes its own. Plan step 11E4c: the entry of a
 * first open (`record createEnvironment`: its ID, repository and configuration; the extension builds the rest), its
 * removal (`record dropCreated`), the configuration (`record configuration`) and the build records (`record build`).
 */
export function hostOpenRecords(host: HostSide): OpenRecords {
  const { records } = host;
  return {
    createEnvironment: async (environment) => {
      const entry = await records.createEnvironment(environment.id, environment.repository, environment.configPath);
      // The extension answered the environment of the repository that another window of the account created meanwhile:
      // the open finds it and uses it (openFirst), as when the registry refuses a second one.
      if (entry.id !== environment.id) throw new Error(`An environment of ${environment.repository} of the GitHub account exists already.`);
      // Review round 1 of PR #106 (A-L6): the open goes on with the entry as the extension recorded it (its clock, mark, owner).
      Object.assign(environment, entry);
    },
    dropCreated: (environmentId) => records.dropCreated(environmentId),
    createMark: (environmentId, kind, previous) => records.createMark(environmentId, kind, previous),
    takeStepMark: (environmentId, operation) => records.takeStepMark(environmentId, operation),
    releaseStepMark: (environmentId, mark) => records.releaseStepMark(environmentId, mark),
    ownerLogin: (environmentId) => records.ownerLogin(environmentId),
    configuration: (environmentId, change) => records.configuration(environmentId, change),
    build: (environmentId, change) => records.build(environmentId, change),
    lifecycleMark: (environmentId, change) => records.lifecycleMark(environmentId, change),
    openFinished: (environmentId, finish) =>
      records.openFinished(environmentId, {
        ...(finish.lifecycleMarkRead !== undefined ? { lifecycleMarkRead: finish.lifecycleMarkRead } : {}),
        ...(finish.lifecycleRanFor !== undefined ? { lifecycleRanFor: finish.lifecycleRanFor } : {}),
        ...(finish.remoteUser !== undefined ? { remoteUser: finish.remoteUser } : {}),
        remoteWorkspaceFolder: finish.remoteWorkspaceFolder,
        ...(finish.gitSummary !== undefined ? { gitSummary: finish.gitSummary } : {}),
      }),
  };
}

/**
 * Plan step 11C2a (decision of 2026-10-04: Delete's `forget` is the worker's): the Session Monitor of the worker's engine,
 * as Delete uses it: `forget` removes the heartbeat record of `source` (the computer that sent the operation) for the
 * environment (monitorFlow.forgetRecord). Best effort: a monitor container that does not exist or does not run has no
 * record that matters (review round 1 of 11C2a, A-R1-L3); any other failure is logged. Plan step 11D1: the heartbeats of
 * the windows are their own operation (`heartbeat`). Plan step 11E4e: the open's ensure (`ensure`, given by the operation
 * with its image maintenance, as `monitorEnsure` does it; without it, the ensure fails closed and the open is refused)
 * and its first heartbeat for `source` with the time limit of the settings (`limitSeconds`; without the settings or the
 * computer it is not sent, which the pipeline logs). The image list stays out until decision D (`images` is none).
 */
export function workerSessionMonitor(
  engine: DockerEngine,
  source: string | undefined,
  log: Logger,
  open: { ensure?: (signal: AbortSignal | undefined) => Promise<unknown>; limitSeconds?: () => number } = {},
): EnvironmentSessionMonitor {
  return {
    // The worker's own helper image runs the monitor (the operation knows it), never the tag or ID of the pipeline's run.
    ensure: async (_target, _helperTag, signal) => {
      if (open.ensure === undefined) throw notInWorker('The ensure of the Session Monitor without the image maintenance of its operation', '11E6');
      await open.ensure(signal);
    },
    heartbeat: async (_target, environmentId, keepRunning, seq) => {
      if (source === undefined) return { ok: false, detail: 'The operation names no computer for the Session Monitor.' };
      // Review round 1 of PR #108 (A-L1): a computer ID that the monitor script would refuse is named as such.
      if (!isSourceId(source)) return { ok: false, detail: 'The computer of the operation has no valid ID for the Session Monitor.' };
      if (open.limitSeconds === undefined) return { ok: false, detail: 'The operation has no settings for the time limit of the heartbeat.' };
      const result = await sendHeartbeat(engine, { source, limitSeconds: open.limitSeconds(), environments: [{ id: environmentId, keepRunning, seq }] });
      return result.ok ? { ok: true } : { ok: false, detail: result.detail };
    },
    forget: async (_target, environmentId) => {
      if (source === undefined) throw new Error('The operation names no computer for the Session Monitor.');
      const result = await forgetRecord(engine, source, environmentId);
      if (!result.ok && !result.missing) log.warn(`The heartbeat record of ${environmentId} could not be removed from the Session Monitor: ${result.detail}`);
    },
  };
}

/**
 * Plan step 11E4d (decision of 2026-09-29): the memory of the window that sent the operation, over `local
 * unrecordedLifecycle`, `record rememberLifecycle` and `record forgetLifecycle`.
 */
export function hostLifecycleMemory(host: HostSide): LifecycleMemory {
  return {
    get: (environmentId) => host.state.unrecordedLifecycle(environmentId),
    remember: (environmentId, containerId) => host.records.rememberLifecycle(environmentId, containerId),
    forget: (environmentId, containerId) => host.records.forgetLifecycle(environmentId, containerId),
  };
}

/** Plan step 11E3a: a registry login as the operation holds it while it is used. */
export type RegistryLogin = NonNullable<Awaited<ReturnType<HostSide['secrets']['registry']>>>;

/**
 * Plan step 11E3a (decision B1 of 2026-10-05): the logins of the registries of one operation. Every login comes as the one
 * registry secret of the operation (SECRET_REGISTRY), so they are used one after the other (review round 1 of PR #109,
 * A-H1: two logins asked at once could each read the other's): `use` runs with the login of `registry` (`undefined`
 * when the computer has none, or its request failed, which is logged), and the operation forgets the secret when `use`
 * ends, before the next login is asked.
 */
export function registryLogins(
  host: HostSide,
  forget: () => void,
  log: Logger,
): <T>(registry: string, use: (login: RegistryLogin | undefined) => Promise<T>, signal?: AbortSignal) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  // `use` must not ask for a login itself (it would wait for its own turn).
  return (registry, use, signal) => {
    const run = queue.then(async () => {
      try {
        let login: RegistryLogin | undefined;
        try {
          // Review round 2 of PR #109 (A2-L1): a login whose user gave up while it waited is not asked.
          if (!signal?.aborted) login = await host.secrets.registry(registry);
        } catch (error) {
          log.warn(`The login of ${registry} could not be asked: ${errorMessage(error)}`);
        }
        return await use(login);
      } finally {
        forget();
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };
}

/**
 * Plan step 11E3a (decision B1 of 2026-10-05): the login of a registry for one use of the registry client
 * (CredentialsProvider), through `logins` (asked when it is needed, forgotten right after). An identity token is the
 * password of IDENTITY_TOKEN_USER, as the Docker credentials give it. Never throws.
 */
export function hostRegistryCredentials(logins: ReturnType<typeof registryLogins>): CredentialsProvider {
  return (registry, signal) =>
    logins(
      registry,
      async (login) => (login === undefined ? undefined : { username: login.identityToken === true ? IDENTITY_TOKEN_USER : (login.username ?? ''), password: login.password }),
      signal,
    ).catch(() => undefined);
}

/**
 * Plan step 11E3a: the image update check of the worker (ImageChecker over a RegistryClient): HTTPS through the proxy of
 * the daemon of its engine (proxiedHttpsTransport, decision C1), the logins by hostRegistryCredentials (decision B1). A
 * login that a registry rejects is logged; the check goes on without it (RegistryClient).
 */
export function workerImageChecker(deps: Pick<WorkerServicesDeps, 'host' | 'engine' | 'forgetSecret' | 'logger'>, logins = registryLogins(deps.host, () => deps.forgetSecret(SECRET_REGISTRY), deps.logger)): ImageChecker {
  const transport = proxiedHttpsTransport(() => deps.engine.proxy());
  const client = new RegistryClient(transport, hostRegistryCredentials(logins), deps.logger, {
    onCredentialsRejected: (registry) => deps.logger.warn(`The registry ${registry} rejected the login of this computer.`),
  });
  return new ImageChecker(client, deps.logger);
}

/** The GitHub sign-in of the user's computer: the account through `local account`, the token through `secret token`. */
export function hostAuth(host: HostSide, log: Logger): Pick<GitHubAuth, 'getToken' | 'getAccount' | 'reportRejectedToken'> {
  return {
    getAccount: ({ interactive }) => host.state.account(interactive),
    getToken: async ({ interactive }) => {
      if (interactive) throw notInWorker('A sign-in with a dialog for the token', '11E');
      return host.secrets.token();
    },
    // The token never goes back over the channel; the report of a rejected token comes with the clone (plan step 11E).
    reportRejectedToken: () => log.warn('GitHub rejected the token of the operation.'),
  };
}

/** PipelineUi over the `question` requests; the messages go as `question message` (they are not awaited by the pipeline). */
export function hostUi(questions: HostSide['questions'], log: Logger): PipelineUi {
  const message = (kind: 'info' | 'warn' | 'registrySignIn', text: string) => {
    questions.message(kind, text).catch((error: unknown) => log.warn(`A message for the user could not be shown: ${error instanceof Error ? error.message : String(error)}`));
  };
  return {
    confirmUntrustedRepository: (repository) => questions.confirmUntrustedRepository(repository),
    configurationChanged: (repository) => questions.configurationChanged(repository),
    configurationKindChanged: (repository, text) => questions.configurationKindChanged(repository, text),
    filesMissing: (repository) => questions.filesMissing(repository),
    recreateContainer: (repository, question) => questions.recreateContainer(repository, question),
    // Plan step 11C2b: the questions of Delete.
    confirmDelete: (repository, confirmation) => questions.confirmDelete(repository, confirmation),
    deleteAdditionalVolumes: (volumes) => questions.deleteAdditionalVolumes(volumes),
    deleteServiceData: (volumes, possibly) => questions.deleteServiceData(volumes, possibly),
    info: (text) => message('info', text),
    warn: (text) => message('warn', text),
    registrySignIn: (registry) => message('registrySignIn', registry),
  };
}

/** Without the analysis thread of the worker (WorkerServicesDeps.analyzer, plan step 11E2), nothing is analyzed. */
const ANALYZER_NOT_IN_WORKER: ConfigurationAnalyzer = {
  analyze: async () => {
    throw notInWorker('The host access analysis', '11E');
  },
};

export interface WorkerServicesDeps {
  host: HostSide;
  engine: DockerEngine;
  /** The secrets of the operation (OperationContext.secrets). */
  secretOf: (name: string) => string | undefined;
  /** Plan step 11E3a (decision B1 of 2026-10-05): the operation no longer holds the secret (OperationContext.forgetSecret). */
  forgetSecret: (name: string) => void;
  logger: Logger;
  /** The worker's own helper image and socket (readOwnHelper). */
  ownHelper: OwnHelper;
  /** The Docker host of the operation as the extension resolved it ('' for the local Docker). */
  dockerHost: string;
  /** The window that sent the operation. */
  owner: { windowId: string; pid: number };
  /** The lock of an environment, taken in the worker (workerEnvironmentLock). */
  environmentLock: (environmentId: string, waitSeconds: number, signal: AbortSignal | undefined) => Promise<HeldEnvironmentLock>;
  /** The settings of the extension, when the operation read them (`local settings`); a read without them fails closed. */
  settings?: ExtensionSettings;
  /** Plan step 11C2a: the id of the computer that sent the operation in the Session Monitor (Delete's `forget`). */
  monitorSource?: string;
  /**
   * Plan step 11E4e: the ensure of the Session Monitor of the worker's engine for the open (ensureWorkerMonitor, with the
   * image maintenance of the operation); without it, the ensure fails closed.
   */
  monitorEnsure?: (signal: AbortSignal | undefined) => Promise<unknown>;
  /**
   * Plan step 11E2: the host access analysis in the worker (its analysis thread, from the script in the worker's bundle,
   * with its limits); without it, an analysis fails closed.
   */
  analyzer?: ConfigurationAnalyzer;
}

/** The core services of one operation in the worker (see the module comment). */
export function workerServices(deps: WorkerServicesDeps): { service: EnvironmentService; helper: WorkspaceHelper; docker: EngineDocker } {
  const serviceDeps = workerServiceDeps(deps);
  return { service: new EnvironmentService(serviceDeps), helper: serviceDeps.helper as WorkspaceHelper, docker: serviceDeps.docker as EngineDocker };
}

/** The deps of EnvironmentService in the worker (workerServices; review round 1 of 11B3b: apart, for their tests). */
export function workerServiceDeps(deps: WorkerServicesDeps): EnvironmentServiceDeps & { helper: WorkspaceHelper; docker: EngineDocker } {
  // Plan step 11E3b: one queue of registry logins for the operation, shared by its pulls and its image check (they share the
  // one registry secret; review round 1 of PR #109, A-H1).
  const logins = registryLogins(deps.host, () => deps.forgetSecret(SECRET_REGISTRY), deps.logger);
  const docker = new EngineDocker(deps.engine, deps.logger, deps.secretOf, logins);
  const helper = new WorkspaceHelper({
    docker: {
      run: async () => {
        throw notInWorker('A container of the workspace helper of its own', '11G');
      },
      imageExists: (reference) => docker.imageExists(reference),
      imageId: (reference) => docker.imageId(reference),
      buildImage: async () => {
        throw new Error('The worker builds no helper image: it runs from its own.');
      },
      listImagesByLabel: async () => {
        throw new Error('The worker maintains no helper images: it runs from its own.');
      },
      removeImage: async () => {
        throw new Error('The worker maintains no helper images: it runs from its own.');
      },
    },
    logger: deps.logger,
    dockerfilePath: '',
    env: {},
    platform: 'linux',
    engine: async () => ({ key: deps.dockerHost, socket: deps.ownHelper.socket }),
    ownImage: deps.ownHelper.image,
  });
  return {
    docker,
    runner: {
      run: async () => {
        throw new Error('The pipeline of the worker runs no process of its own on the Docker host.');
      },
    },
    // Docker runs where the worker runs; the engine must answer.
    startDocker: async ({ signal }) => {
      if (!(await docker.isRunning(signal))) throw new UserFacingError('dockerEngineNotRunning', Messages.dockerEngineNotRunning, 'The engine of the worker does not answer.');
    },
    helper,
    registry: hostStore(deps.host.records),
    // Plan step 11C2a (decision of 2026-10-04): the busy marks are set and cleared by the extension.
    busyMarks: hostBusyMarks(deps.host.records),
    // Plan step 11E4b (decision of 2026-10-04): the registry writes of the open are requests to the extension.
    openRecords: hostOpenRecords(deps.host),
    // Plan step 11C2b (decision of 2026-10-04): the Git state is recorded by the extension.
    recordGitSummary: (environmentId, summary) => deps.host.records.recordGitSummary(environmentId, summary),
    // Plan step 11E4e: the open's ensure and first heartbeat too (the time limit of the settings of the operation).
    sessionMonitor: workerSessionMonitor(deps.engine, deps.monitorSource, deps.logger, {
      ...(deps.monitorEnsure !== undefined ? { ensure: deps.monitorEnsure } : {}),
      ...(deps.settings !== undefined ? { limitSeconds: () => stopAfterSeconds(deps.settings!.stopAfterMinutes) } : {}),
    }),
    sessionFiles: hostSessionFiles(deps.host),
    windowStatuses: () => deps.host.state.windowStatuses(),
    // Plan step 11E4d: the processes of the user's computer are not the worker's; the pipeline asks the extension before
    // each decision about the other windows (processAlive). Nothing asks synchronously any more: fail closed.
    isProcessAlive: () => {
      throw new Error('The worker does not know synchronously whether a process of the computer runs.');
    },
    processAlive: (pid) => deps.host.state.processAlive(pid),
    // Plan step 11E4d (decision of 2026-09-29): the window's memory of the containers whose lifecycle mark was not recorded.
    lifecycleMemory: hostLifecycleMemory(deps.host),
    // Plan step 11E4d: the GitHub profile of the account, read by the extension with its token (never the worker's).
    viewer: async () => {
      const profile = await deps.host.state.viewer();
      if (profile === undefined) throw new Error('The extension could not read the GitHub profile.');
      return profile;
    },
    // Plan step 11E3a: the image update check in the worker, over its own HTTPS (through the proxy of the daemon, decision
    // C1) with the login of each registry asked when it is needed and forgotten after its use (decision B1).
    imageChecker: workerImageChecker(deps, logins),
    auth: hostAuth(deps.host, deps.logger),
    ui: hostUi(deps.host.questions, deps.logger),
    logger: deps.logger,
    clock: systemClock,
    platform: 'linux',
    env: {},
    owner: deps.owner,
    settings: () => {
      if (deps.settings === undefined) throw notInWorker('A read of the settings without them', '11E');
      return deps.settings;
    },
    analyzer: deps.analyzer ?? ANALYZER_NOT_IN_WORKER,
    dockerTarget: async () => ({ kind: deps.dockerHost === '' ? 'local' : 'remote', host: deps.dockerHost, endpoint: '' }),
    environmentLock: deps.environmentLock,
    // Plan step 11C1: the pipeline of the worker reads the states itself, over its engine.
    workerRefresh: (environments) => readEnvironmentStates(docker, environments),
    flow: async (op) => {
      throw new Error(`The pipeline of the worker sends no flow (${op}): it is the flow.`);
    },
  };
}
