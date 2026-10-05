// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3b (decision of 2026-10-03, the worker is the deputy; user decision of 2026-10-04, "recommended"): the
// core services of the pipeline as the worker constructs them for one operation. EnvironmentService and WorkspaceHelper
// run unchanged; what they need from the user's computer goes through the requests of the operation (HostSide), the
// engine is the worker's own (EngineDocker), the helper image is the worker's own image, and the lock and the batch
// helper are taken in the worker (`environmentLock`, given by the operation). What only the open runs (the host access
// analysis, the image update check, the GitHub viewer, the variables of the computer) comes with plan step 11E; until
// then it fails closed here, as do the record writes by a function (plan steps 11D, 11E) and the Session Monitor beyond Delete's
// `forget` (plan step 11D). Plan step 11C2a: the busy marks are specific requests to the extension (decision of
// 2026-10-04); plan step 11E4b: so are the registry writes of the open (hostOpenRecords). Pure over its deps; no `vscode`.
import { UserFacingError, errorMessage } from '../errors';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import type { ConfigurationAnalyzer } from '../helper/configurationAnalysis';
import { WorkspaceHelper } from '../helper/workspaceHelper';
import { Messages } from '../messages';
import { EnvironmentService, type EnvironmentServiceDeps, type EnvironmentSessionFiles, type EnvironmentSessionMonitor, type EnvironmentStore } from '../pipeline/environmentService';
import type { EnvironmentBusyMarks } from '../pipeline/busyMarks';
import type { OpenRecords } from '../pipeline/openRecords';
import { systemClock, type GitHubAuth, type Logger, type PipelineUi } from '../ports';
import type { ExtensionSettings } from '../types';
import type { DockerEngine } from './dockerEngine';
import { forgetRecord } from './monitorFlow';
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
 * record that matters (review round 1 of 11C2a, A-R1-L3); any other failure is logged. The ensure comes with plan step
 * 11D2; until then it fails closed. Plan step 11D1: the heartbeats are their own operation (`heartbeat`).
 */
export function workerSessionMonitor(engine: DockerEngine, source: string | undefined, log: Logger): EnvironmentSessionMonitor {
  return {
    ensure: async () => {
      throw notInWorker('The ensure of the Session Monitor', '11D2');
    },
    heartbeat: async () => {
      throw notInWorker('A heartbeat of the open to the Session Monitor', '11E');
    },
    forget: async (_target, environmentId) => {
      if (source === undefined) throw new Error('The operation names no computer for the Session Monitor.');
      const result = await forgetRecord(engine, source, environmentId);
      if (!result.ok && !result.missing) log.warn(`The heartbeat record of ${environmentId} could not be removed from the Session Monitor: ${result.detail}`);
    },
  };
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
  const docker = new EngineDocker(deps.engine, deps.logger, deps.secretOf);
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
    sessionMonitor: workerSessionMonitor(deps.engine, deps.monitorSource, deps.logger),
    sessionFiles: hostSessionFiles(deps.host),
    windowStatuses: () => deps.host.state.windowStatuses(),
    // The pipeline asks synchronously, so every other process counts as alive here. Plan step 11C2a: the busy marks that
    // Delete sets and waits for are decided by the extension (busyMarks); the opens follow with plan step 11E.
    isProcessAlive: () => true,
    imageChecker: {
      check: async () => {
        throw notInWorker('The image update check', '11E');
      },
    },
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
