// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (decision of 2026-10-03, the worker is the deputy): the operations that run a whole flow in the worker.
// Each one builds the seams of the flow from the requests of its operation (workerHostSide) and the port of its engine
// (dockerEngine), runs the flow, and answers with its result. The first flow is the token removal; the flows of plan
// steps 11B2 to 11E come here too.
import {
  LOCK_BUSY_CODE,
  LOCK_UNAVAILABLE_CODE,
  MAX_REFUSAL_DETAIL_LENGTH,
  MAX_REFUSAL_MESSAGE_LENGTH,
  parseDeleteCheckParams,
  parseDeleteParams,
  parseListConfigurationsParams,
  parseReconcileParams,
  parseHeartbeatParams,
  parseMonitorEnsureParams,
  parseOpenParams,
  OPEN_PROGRESS_DETAIL,
  type OpenParams,
  type OpenValue,
  type MonitorEnsureValue,
  parseRecordGitStateParams,
  type HeartbeatValue,
  type RecordGitStateValue,
  parseStopParams,
  parseTokenRemoveParams,
  parseWindowStateParams,
  type WindowStateValue,
  type FlowRefusal,
  type DeleteCheckValue,
  type DeleteValue,
  type ListConfigurationsValue,
  type StopValue,
  type TokenRemoveValue,
  type ReconcileValue,
} from '../core/helperChannel/protocol';
import { isBatchHelperUnavailable, isUserFacingError } from '../core/errors';
import { isAbortError, silentProgress, type Logger, type ProgressReporter } from '../core/ports';
import { errorMessage } from '../core/errors';
import { readOwnHelper, type OwnHelper } from '../core/worker/ownHelper';
import { workerServices } from '../core/worker/workerServices';
import { EngineDocker } from '../core/worker/engineDocker';
import { windowStateFlow } from '../core/worker/windowStateFlow';
import type { HelperBatchSession } from '../core/helperChannel/helperChannel';
import { workerEnvironmentLock } from './workerLock';
import { stopFlow } from '../core/worker/stopFlow';
import { LOCK_DEPS, takeEnvironmentLock, type LockDeps } from './lock';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { removeTokenFlow } from '../core/worker/tokenRemoveFlow';
import { sendHeartbeat, sendMonitorSettings } from '../core/worker/monitorFlow';
import type { ExtensionSettings } from '../core/types';
import { engineMonitor, limited } from '../core/worker/engineMonitor';
import analysisScript from 'devenv:analysis-script';
import { WorkerConfigurationAnalyzer, analysisSlots } from '../core/helper/configurationAnalysisRunner';
import { analysisFailure, type ConfigurationAnalyzer } from '../core/helper/configurationAnalysis';
import { monitorImageTag } from '../core/helper/helperState';
import { REMOTE_MONITOR_DOCKER_TIMEOUT_MS, RemoteSessionMonitor } from '../core/remoteMonitor/remoteSessionMonitor';
import { imageSettingsOf, type MonitorSettings } from '../core/remoteMonitor/protocol';
import { workerHostSide } from '../core/worker/workerHostSide';
import type { HostRequest } from '../core/worker/hostSide';
import { OperationError, type OperationContext, type OperationHandler } from './server';

/**
 * Plan step 5, PR C: the log of the extension as the Logger of the worker's code (plan step 11B3b: shared here).
 * Cleanup after plan step 11 (PR #139, D1, decision of 2026-10-10): `output`, the raw output of the tools (the Dev
 * Container CLI's build and up, the clone, the lifecycle commands, the pulls), goes to the extension's log as the
 * operation's output (OperationContext.output: masked by its StreamRedactor with every secret that the operation ever
 * held, also one split between two pieces; the rest is flushed, masked, when the operation ends; sent in pieces of at
 * most OUTPUT_CHUNK_CHARACTERS). Before, it was dropped.
 */
export function contextLogger(context: OperationContext): Logger {
  return {
    info: (message) => context.log(message),
    warn: (message) => context.log(message, 'warn'),
    error: (message) => context.log(message, 'warn'),
    output: (text) => context.output('stdout', text),
  };
}

/** The seams of a flow from the context of its operation: its requests to the extension and its secrets. */
export function flowHost(context: OperationContext) {
  const ask: (request: HostRequest) => Promise<unknown> = (request) => context.ask(request.kind, { call: request.call, args: request.args });
  return workerHostSide(ask, (name) => context.secrets[name]);
}

/**
 * The port of the engine for one operation: with its own secrets for the standard input of an exec (review round 1 of
 * plan step 11B1, A-R1-3).
 */
export type EngineOfOperation = (context: OperationContext) => DockerEngine;

/**
 * Cleanup after plan step 11 (PR C6, B11): the start that every operation shares. Its parameters by the schema of both
 * sides (`parse`; else `invalid`, "The parameters of the <name> operation are invalid.", or `texts.invalid`), and no
 * secret (else `invalid`, "The <name> operation takes no secret.", or `texts.secret`); then `run` with the parameters.
 */
export function checkedOperation<P>(
  name: string,
  parse: (params: unknown) => P | undefined,
  run: (checked: P, context: OperationContext) => Promise<unknown>,
  texts: { invalid?: string; secret?: string } = {},
): OperationHandler {
  return async (params, context) => {
    const checked = parse(params);
    if (checked === undefined) throw new OperationError('invalid', texts.invalid ?? `The parameters of the ${name} operation are invalid.`);
    if (!context.hasNoSecret()) throw new OperationError('invalid', texts.secret ?? `The ${name} operation takes no secret.`);
    return run(checked, context);
  };
}

/** Cleanup after plan step 11 (PR C6, B11): `cancelled`, "The <name> operation was cancelled.", when the operation was cancelled. */
export function cancelledIfAborted(name: string, context: OperationContext): void {
  if (context.signal.aborted) throw new OperationError('cancelled', `The ${name} operation was cancelled.`);
}

/**
 * Cleanup after plan step 11 (PR C6, B11): the end of an operation that failed with `error`: `cancelled` when it was
 * cancelled (cancelledIfAborted), else `failed` with the message of the error.
 */
export function operationFailure(name: string, error: unknown, context: OperationContext): OperationError {
  cancelledIfAborted(name, context);
  return new OperationError('failed', errorMessage(error));
}

/** `tokenRemove`: empties the token folder of the dev container of an environment (concept section 9). */
export function tokenRemoveOperation(engineOf: EngineOfOperation): OperationHandler {
  return checkedOperation('tokenRemove', parseTokenRemoveParams, async (checked, context) => {
    const host = flowHost(context);
    context.progress('tokenRemove', checked.containerName);
    try {
      const result = await removeTokenFlow({
        environmentId: checked.environmentId,
        containerName: checked.containerName,
        engine: engineOf(context),
        records: host.records,
        log: (line) => context.log(line),
        signal: context.signal,
      });
      context.log(
        result.outcome === 'removed'
          ? `The GitHub token was removed from the container ${checked.containerName}.`
          : `The container ${checked.containerName} does not run: its memory holds no GitHub token.`,
      );
      return result satisfies TokenRemoveValue;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError('failed', errorMessage(error));
    }
  });
}

/**
 * Plan step 11B2: `stop`, the Stop of an environment (stopFlow) under its lock, which the operation takes itself (the
 * one way: takeEnvironmentLock) and lets go at its end. A lock held elsewhere for the whole wait is `busy`.
 */
export function stopOperation(engineOf: EngineOfOperation, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('stop', parseStopParams, async (checked, context) => {
    context.progress('lock', checked.environmentId);
    let release: () => void;
    try {
      release = await takeEnvironmentLock(lockDeps, checked.environmentId, checked.waitSeconds, context.signal);
    } catch (error) {
      // Review round 1 (A-R1-3): a lock that could not be taken for another reason than a holder elsewhere changed
      // nothing; the extension says so (environmentLockUnavailable), as for the lock before the move.
      if (error instanceof OperationError && error.code !== LOCK_BUSY_CODE && error.code !== 'cancelled') throw new OperationError(LOCK_UNAVAILABLE_CODE, error.message);
      throw error;
    }
    try {
      context.progress('stop', checked.containerName);
      const result = await stopFlow({
        environmentId: checked.environmentId,
        containerName: checked.containerName,
        folder: checked.folder,
        ...(checked.user !== undefined ? { user: checked.user } : {}),
        engine: engineOf(context),
        log: (line) => context.log(line),
        now: () => new Date().toISOString(),
        signal: context.signal,
      });
      return result satisfies StopValue;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw operationFailure('stop', error, context);
    } finally {
      release();
    }
  });
}

/**
 * Plan step 11B3b (user decision of 2026-10-04): the end of a flow that runs the worker's own pipeline. A refusal of the
 * pipeline (a UserFacingError) is its value, `{ refused }`, so that the extension shows it as before the move; a cancel
 * ends the operation as `cancelled`; anything else fails it.
 */
export function flowRefusal(error: unknown, context: OperationContext): { refused: FlowRefusal } {
  if (context.signal.aborted || isAbortError(error) || (isUserFacingError(error) && error.code === 'cancelled')) {
    throw new OperationError('cancelled', 'The operation was cancelled.');
  }
  if (error instanceof OperationError) throw error;
  if (!isUserFacingError(error) || error.code === 'cancelled') throw new OperationError('failed', errorMessage(error));
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  return {
    refused: {
      code: error.code,
      message: clip(error.message || error.code, MAX_REFUSAL_MESSAGE_LENGTH),
      ...(error.detail !== undefined ? { detail: clip(error.detail, MAX_REFUSAL_DETAIL_LENGTH) } : {}),
      ...(isBatchHelperUnavailable(error) ? { batchHelperUnavailable: true as const } : {}),
    },
  };
}

/** Plan step 11B3b: the worker's own helper image and socket, for the batch helpers of its flows (readOwnHelper). */
export type OwnHelperOf = (context: OperationContext) => Promise<OwnHelper>;

/**
 * Plan step 11B3b: the worker's own helper image of an operation (ownHelperOf). A cancel ends the operation as
 * `cancelled`; another failure changed nothing, so the extension says so as for a worker that cannot take the lock
 * (LOCK_UNAVAILABLE_CODE: environmentLockUnavailable). Cleanup after plan step 11 (PR C6, B11): one function for the six
 * operations that read it before their pipeline.
 */
async function ownHelperOfOperation(ownHelperOf: OwnHelperOf, context: OperationContext): Promise<OwnHelper> {
  try {
    return await ownHelperOf(context);
  } catch (error) {
    if (context.signal.aborted) throw new OperationError('cancelled', 'The operation was cancelled.');
    throw new OperationError(LOCK_UNAVAILABLE_CODE, `The helper image of the worker cannot be read: ${errorMessage(error)}`);
  }
}

/**
 * Plan step 11E2: the host access analysis of an operation in the worker: each job in a thread of its own, started from
 * the script in the worker's bundle (`devenv:analysis-script`) with the limits of the extension's (ANALYSIS_LIMITS), its
 * failures logged to the operation and refused (fail closed).
 */
export function workerAnalyzer(context: OperationContext): ConfigurationAnalyzer {
  const thread = workerThreadAnalyzer(context);
  // Review round 1 of PR #103 (A-L1): the operations of the worker share MAX_WORKER_ANALYSIS_THREADS threads.
  return {
    analyze: (job) =>
      WORKER_ANALYSIS_SLOTS(async () => {
        // Review round 2 of PR #103 (A-L1): a job whose operation ended while it waited starts no thread (refused).
        if (context.signal.aborted) return analysisFailure(job, { kind: 'internal', reason: 'the operation was cancelled' });
        return thread.analyze(job);
      }),
  };
}

/**
 * The analyzer of the thread of an operation (workerAnalyzer, without the shared slots): the text of the script in the
 * worker's bundle, the limits of the extension, the log of the operation. Review round 2 of PR #103 (A-L3): apart, so
 * that its tests need no seam in workerAnalyzer.
 */
export function workerThreadAnalyzer(context: OperationContext): WorkerConfigurationAnalyzer {
  return new WorkerConfigurationAnalyzer({ code: analysisScript }, contextLogger(context));
}

/** Review round 1 of PR #103 (A-L1): the most analysis threads that the worker runs at once, for all its operations. */
export const MAX_WORKER_ANALYSIS_THREADS = 2;
const WORKER_ANALYSIS_SLOTS = analysisSlots(MAX_WORKER_ANALYSIS_THREADS);

/**
 * Plan step 11B3b: the worker's own helper image, read once (`read`), and again after a failure (review round 1, B-R1-10:
 * one failed read never holds every later flow).
 */
export function ownHelperCache(read: OwnHelperOf): OwnHelperOf {
  let cached: Promise<OwnHelper> | undefined;
  return (context) => {
    const current = (cached ??= read(context));
    current.catch(() => {
      if (cached === current) cached = undefined;
    });
    return current;
  };
}

/** Review round 1 of 11B3b (A-R1-2): the time limit of a read of the worker's own helper image. */
export const OWN_HELPER_TIMEOUT_MS = 60_000;

/**
 * Plan step 11B3b: the worker's own helper image over the port of its engine: the inspect of the container of `hostname`
 * (its short ID), within OWN_HELPER_TIMEOUT_MS (review round 1, A-R1-2), cached (ownHelperCache). Review round 2 (B-R2-1):
 * apart, for its tests.
 */
export function ownHelperOfEngine(engineOf: EngineOfOperation, hostname: () => string, timeoutMs = OWN_HELPER_TIMEOUT_MS): OwnHelperOf {
  return ownHelperCache((context) => readOwnHelper(engineOf(context), hostname(), AbortSignal.timeout(timeoutMs)));
}

/** Plan step 11B3b: opens a batch session of a flow in the worker (workerBatchSession of batch.ts). */
export type OpenWorkerBatch = (context: OperationContext, p: { volume: string; image: string; socket: string }) => Promise<HelperBatchSession>;

/**
 * Plan step 11B3b (user decision of 2026-10-04): `listConfigurations`, the listing of Select configuration, run by the
 * worker's own pipeline (workerServices): the record and the account through the requests of the operation, the lock
 * and the batch helper (on the worker's own image) taken here.
 */
export function listConfigurationsOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('listConfigurations', parseListConfigurationsParams, async (checked, context) => {
    context.progress('listConfigurations', checked.environmentId);
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      environmentLock: workerEnvironmentLock(lockDeps, (p) => openBatch(context, p), context),
      analyzer: workerAnalyzer(context),
    });
    try {
      const configPaths = await service.listConfigurations(checked.environmentId, { progress: silentProgress, signal: context.signal });
      return { configPaths } satisfies ListConfigurationsValue;
    } catch (error) {
      return flowRefusal(error, context) satisfies ListConfigurationsValue;
    }
  });
}

/**
 * Plan step 11C1 (decisions of 2026-10-03 and 2026-10-04): `windowState`, what an attached window reads of its dev
 * container (windowStateFlow). It only reads: no lock, no secret, no request to the extension.
 */
export function windowStateOperation(engineOf: EngineOfOperation): OperationHandler {
  return checkedOperation('windowState', parseWindowStateParams, async (checked, context) => {
    try {
      const value = await windowStateFlow({ ...checked, docker: new EngineDocker(engineOf(context), contextLogger(context)), signal: context.signal });
      return value satisfies WindowStateValue;
    } catch (error) {
      throw operationFailure('windowState', error, context);
    }
  });
}

/**
 * Plan step 11C2a (decisions of 2026-10-03 and 2026-10-04): `delete`, the Delete of an environment, run by the worker's
 * own pipeline (workerServices, EnvironmentService.delete): the busy mark, the entry and the session files through the
 * requests of the operation (each for its environment only), the lock taken here, the removal over the port of the
 * engine, and the heartbeat record of the computer that sent it forgotten in the Session Monitor of the engine.
 */
export function deleteOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('delete', parseDeleteParams, async (checked, context) => {
    context.progress('delete', checked.environmentId);
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      environmentLock: workerEnvironmentLock(lockDeps, (p) => openBatch(context, p), context),
      analyzer: workerAnalyzer(context),
      monitorSource: checked.monitorSource,
    });
    try {
      await service.delete(checked.environmentId, { progress: silentProgress, signal: context.signal, additionalVolumesToRemove: checked.additionalVolumesToRemove });
      return { deleted: true } satisfies DeleteValue;
    } catch (error) {
      return flowRefusal(error, context) satisfies DeleteValue;
    }
  });
}

/**
 * Plan step 11C2b (decisions of 2026-10-03 and 2026-10-04): `deleteCheck`, the check of Delete and its questions, run
 * by the worker's own pipeline (workerServices, EnvironmentService.deleteCheck): the record, the account and the
 * registry through the requests of the operation, the Git state recorded through `record recordGitSummary`, the
 * questions as `question` requests. No lock: it only reads on the engine.
 */
export function deleteCheckOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('deleteCheck', parseDeleteCheckParams, async (checked, context) => {
    context.progress('deleteCheck', checked.environmentId);
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      environmentLock: workerEnvironmentLock(lockDeps, (p) => openBatch(context, p), context),
      analyzer: workerAnalyzer(context),
    });
    try {
      const decision = await service.deleteCheck(checked.environmentId, { progress: silentProgress, signal: context.signal, repository: checked.repository, otherWindow: checked.otherWindow });
      return decision satisfies DeleteCheckValue;
    } catch (error) {
      return flowRefusal(error, context) satisfies DeleteCheckValue;
    }
  });
}

/**
 * Plan step 11C3 (decisions of 2026-10-03 and 2026-10-04): `reconcile`, the registry rebuilt from the labels of the
 * volumes of the engine (concept 7.5 "registry lost"), by the worker's own pipeline (workerServices,
 * EnvironmentService.reconcileFromVolumes): the volumes and the containers read over the port of the engine, the entries
 * added by the extension (`record restore`). No lock: it only reads on the engine.
 */
export function reconcileOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('reconcile', parseReconcileParams, async (checked, context) => {
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      environmentLock: workerEnvironmentLock(lockDeps, (p) => openBatch(context, p), context),
      analyzer: workerAnalyzer(context),
    });
    try {
      return { added: await service.reconcileFromVolumes() } satisfies ReconcileValue;
    } catch (error) {
      throw operationFailure('reconcile', error, context);
    }
  });
}

/**
 * Plan step 11D1 (decision of 2026-10-03): `heartbeat`, one heartbeat of a window to the Session Monitor container of
 * the worker's engine (monitorFlow.sendHeartbeat). `missing` tells the window to start the monitor again.
 */
export function heartbeatOperation(engineOf: EngineOfOperation): OperationHandler {
  return checkedOperation('heartbeat', parseHeartbeatParams, async (checked, context) => {
    const value = await sendHeartbeat(engineOf(context), checked.heartbeat, context.signal).catch((error: unknown) => {
      cancelledIfAborted('heartbeat', context);
      throw error;
    });
    return value satisfies HeartbeatValue;
  });
}

/**
 * Plan step 11D1 (user decision Q2 of 2026-10-02): `recordGitState`, the Git state of the running dev container of an
 * environment that a window releases, by the worker's own pipeline (EnvironmentService.recordGitState): the record
 * through `record get`, the state recorded through `record recordGitSummary`. No lock: it only reads on the engine.
 */
export function recordGitStateOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('recordGitState', parseRecordGitStateParams, async (checked, context) => {
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      environmentLock: workerEnvironmentLock(lockDeps, (p) => openBatch(context, p), context),
      analyzer: workerAnalyzer(context),
    });
    const recorded = await service.recordGitState(checked.environmentId, context.signal);
    cancelledIfAborted('recordGitState', context);
    return { recorded } satisfies RecordGitStateValue;
  });
}

/**
 * Plan step 11D3 (option B of 2026-10-03): the image of the monitor container: the worker's own image (the pinned
 * helper image) by its monitor tag `devenv-monitor:<hash>`, tagged here, with the ID that the create checks; by the ID
 * itself (as before) when the tag of the worker is no helper tag or the tag fails (the name in the Containers view only).
 */
export async function monitorImage(engine: DockerEngine, own: { tag: string; id?: string }, logger: Logger, signal: AbortSignal): Promise<{ reference: string; id?: string }> {
  // Without an ID, its tag (as before; readOwnHelper always reads one).
  if (own.id === undefined) return { reference: own.tag };
  const reference = monitorImageTag(own.tag);
  if (reference === undefined) return { reference: own.id };
  try {
    const id = own.id;
    await limited(REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal, (limit) => engine.tagImage(id, reference, limit));
  } catch (error) {
    if (signal.aborted) throw error;
    logger.warn(`The image of the Session Monitor could not be tagged as ${reference}; it runs from ${own.id}: ${errorMessage(error)}`);
    return { reference: own.id };
  }
  return { reference, id: own.id };
}

/**
 * Plan step 11E4e: the Session Monitor of the worker's engine made sure, as `monitorEnsure` does it, for that operation
 * and for the open in the worker (WorkerServicesDeps.monitorEnsure): from the worker's own helper image (its monitor tag,
 * monitorImage), with the socket that the worker mounts, the monitor script of the worker's bundle and the image
 * maintenance of the operation. Rejects with the cause when it cannot. Plan step 11H2 (decision of 2026-10-09): with the
 * mode of the monitor (MonitorSettings.permanent), and with the shared VS Code server store that the worker mounts
 * (OwnHelper.vscodeStore), which the monitor mounts too for its background run.
 */
export async function ensureWorkerMonitor(
  engine: DockerEngine,
  own: OwnHelper,
  logger: Logger,
  script: () => string,
  images: MonitorSettings,
  signal: AbortSignal,
): Promise<MonitorEnsureValue['outcome']> {
  const monitor = new RemoteSessionMonitor({
    engine: engineMonitor(engine),
    logger,
    script: async () => script(),
    imageMaintenance: () => images,
    ...(own.vscodeStore !== undefined ? { vscodeStoreVolume: own.vscodeStore } : {}),
  });
  const image = await monitorImage(engine, own.image, logger, signal);
  return monitor.ensureOrThrow(own.image.tag, own.socket, signal, image.reference, image.id);
}

/**
 * Plan step 11D2 (decision of 2026-10-03): `monitorEnsure`, the Session Monitor container of the worker's engine made
 * sure (RemoteSessionMonitor.ensureOrThrow over the Engine API, engineMonitor): with the worker's own helper image (the
 * image the worker runs from: its tag in the label, its ID as the image of the container; plan step 11D3: its monitor
 * tag, monitorImage), the socket that the worker mounts, and `script` (the monitor of the worker's bundle). A failure
 * fails the operation with its cause.
 */
export function monitorEnsureOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, script: () => string): OperationHandler {
  return checkedOperation('monitorEnsure', parseMonitorEnsureParams, async (checked, context) => {
    try {
      const own = await ownHelperOf(context);
      const outcome = await ensureWorkerMonitor(engineOf(context), own, contextLogger(context), script, checked.images, context.signal);
      return { outcome } satisfies MonitorEnsureValue;
    } catch (error) {
      throw operationFailure('monitorEnsure', error, context);
    }
  });
}

/**
 * Plan step 11E6: the settings of the pipeline of an open from its OpenSettings: the host access checks of its repository
 * (`hostAccessChecksOff` names it only when they are off), and nothing that the pipeline does not read.
 */
export function openSettingsOf(repository: string, settings: OpenParams['settings']): ExtensionSettings {
  return {
    reopenLastOnStartup: false,
    stopOnClose: settings.stopOnClose,
    waitingTimeSeconds: settings.waitingTimeSeconds,
    updateImagesOnConnect: settings.updateImagesOnConnect,
    respectShutdownActionNone: settings.respectShutdownActionNone,
    owners: [],
    includeArchived: false,
    includeForks: false,
    refreshIntervalMinutes: 0,
    hostAccessChecksOff: settings.hostAccessChecks === 'off' ? [repository] : [],
    ...(settings.stopAfterMinutes !== undefined ? { stopAfterMinutes: settings.stopAfterMinutes } : {}),
  };
}

/** Plan step 11E6: the progress of the pipeline as the progress of the operation (OPEN_PROGRESS_DETAIL for a detail). */
export function operationProgress(context: OperationContext): ProgressReporter {
  return {
    step: (step) => context.progress(step),
    detail: (message) => context.progress(OPEN_PROGRESS_DETAIL, message),
  };
}

/**
 * Plan step 11E6 (decision D1 of 2026-10-05): the image settings and the image list of an open for the Session Monitor of
 * the worker's engine, after its ensure: the settings (plan step 11H2: always, they hold the schedule of the background
 * run; before, only when they named prefixes), the list when the open carries one. Best effort: a failure is logged. Returns whether the monitor took the list.
 */
export async function giveMonitorImages(
  engine: DockerEngine,
  params: Pick<OpenParams, 'images' | 'repositories'>,
  logger: Logger,
  signal: AbortSignal,
): Promise<boolean> {
  // Plan step 11H2 (D2 of 2026-10-09): always, also without prefixes: the schedule of the whole background run (the newest
  // settings of any computer apply); without the mode, which is part of the label (imageSettingsOf).
  const settings = await sendMonitorSettings(engine, { settings: imageSettingsOf(params.images) }, signal);
  if (!settings.ok) logger.warn(`The image settings could not be given to the Session Monitor: ${settings.detail}`);
  if (params.repositories === undefined) return false;
  const list = await sendMonitorSettings(engine, { repositories: params.repositories }, signal);
  if (!list.ok) logger.warn(`The image list could not be given to the Session Monitor: ${list.detail}`);
  return list.ok;
}

/**
 * Plan step 11E6 (decision D1 of 2026-10-05): the Session Monitor of an open: its ensure with the image maintenance of
 * the parameters, then its image settings and list (giveMonitorImages); each with the signal of the operation when the
 * pipeline gives none (review round 1 of PR #108, A-I1). `imageListSent`: the monitor took the list.
 */
export function openMonitor(
  engine: DockerEngine,
  own: OwnHelper,
  logger: Logger,
  script: () => string,
  params: Pick<OpenParams, 'images' | 'repositories'>,
  operationSignal: AbortSignal,
  ensure: typeof ensureWorkerMonitor = ensureWorkerMonitor,
): { monitorEnsure: (signal: AbortSignal | undefined) => Promise<unknown>; monitorImages: (signal: AbortSignal | undefined) => Promise<void>; imageListSent: () => boolean } {
  let sent = false;
  return {
    monitorEnsure: (signal) => ensure(engine, own, logger, script, params.images, signal ?? operationSignal),
    monitorImages: async (signal) => {
      if (await giveMonitorImages(engine, params, logger, signal ?? operationSignal)) sent = true;
    },
    imageListSent: () => sent,
  };
}

/**
 * Plan step 11E6 (decisions of 2026-10-03 and 2026-10-04; A1 and D1 of 2026-10-05): `open`, the open of an environment by
 * the worker's own pipeline (workerServices, EnvironmentService.open or openEnvironment): the records, the questions,
 * the token and the registry logins through the requests of the operation, the lock and the batch helper (on the
 * worker's own image) taken here, the Session Monitor of the engine made sure with the image maintenance of the
 * parameters (ensureWorkerMonitor, with the signal of the operation when the pipeline gives none: review round 1 of PR
 * #108, A-I1), its image settings and list given after it (giveMonitorImages), and its first heartbeat with the time
 * limit of the settings. It answers with what the window needs to connect (A1); a refusal of the pipeline is its value.
 */
export function openOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, script: () => string, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return checkedOperation('open', parseOpenParams, async (checked, context) => {
    context.progress('open', checked.environmentId ?? checked.repository);
    const ownHelper = await ownHelperOfOperation(ownHelperOf, context);
    const engine = engineOf(context);
    const logger = contextLogger(context);
    const monitor = openMonitor(engine, ownHelper, logger, script, checked, context.signal);
    const { service } = workerServices({
      host: flowHost(context),
      engine,
      secretOf: (name) => context.secrets[name],
      forgetSecret: (name) => context.forgetSecret(name),
      logger,
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      environmentLock: workerEnvironmentLock(lockDeps, (p) => openBatch(context, p), context),
      analyzer: workerAnalyzer(context),
      settings: openSettingsOf(checked.repository, checked.settings),
      monitorSource: checked.monitorSource,
      monitorEnsure: monitor.monitorEnsure,
      monitorImages: monitor.monitorImages,
      // Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"): the server of the window's VS Code.
      ...(checked.vscodeServer !== undefined ? { vscodeServer: checked.vscodeServer } : {}),
      // Plan step 11H3 (decision of 2026-10-09): the user's default extensions, for the shared extension cache.
      ...(checked.defaultExtensions !== undefined ? { defaultExtensions: checked.defaultExtensions } : {}),
    });
    const sent = (): { imageListSent?: true } => (monitor.imageListSent() ? { imageListSent: true } : {});
    const options = {
      progress: operationProgress(context),
      signal: context.signal,
      ...(checked.forceRebuild === true ? { forceRebuild: true } : {}),
      ...(checked.configPath !== undefined ? { configPath: checked.configPath } : {}),
    };
    try {
      const result =
        checked.environmentId !== undefined
          ? await service.openEnvironment(checked.environmentId, options)
          : await service.open({ repository: checked.repository, ...checked.target!, defaultBranch: checked.target!.defaultBranch ?? null }, options);
      return {
        opened: { environmentId: result.environment.id, containerName: result.containerName, remoteWorkspaceFolder: result.remoteWorkspaceFolder },
        // Plan step 11H1: what the link of the shared VS Code server did (one value; the log of the open says why).
        ...(result.vscodeServer !== undefined ? { vscodeServer: result.vscodeServer } : {}),
        ...sent(),
      } satisfies OpenValue;
    } catch (error) {
      return { ...flowRefusal(error, context), ...sent() } satisfies OpenValue;
    }
  }, { secret: 'The open operation takes no secret: it asks for the ones it needs.' });
}
