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
import { isAbortError, silentProgress, type Logger } from '../core/ports';
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
import { workerHostSide } from '../core/worker/workerHostSide';
import type { HostRequest } from '../core/worker/hostSide';
import { OperationError, type OperationContext, type OperationHandler } from './server';

/** Plan step 5, PR C: the log of the extension as the Logger of the worker's code (plan step 11B3b: shared here). */
export function contextLogger(context: OperationContext): Logger {
  return {
    info: (message) => context.log(message),
    warn: (message) => context.log(message, 'warn'),
    error: (message) => context.log(message, 'warn'),
    output: () => {},
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

/** `tokenRemove`: empties the token folder of the dev container of an environment (concept section 9). */
export function tokenRemoveOperation(engineOf: EngineOfOperation): OperationHandler {
  return async (params, context) => {
    const checked = parseTokenRemoveParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the tokenRemove operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The tokenRemove operation takes no secret.');
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
      throw new OperationError('failed', error instanceof Error ? error.message : String(error));
    }
  };
}

/**
 * Plan step 11B2: `stop`, the Stop of an environment (stopFlow) under its lock, which the operation takes itself (the
 * one way: takeEnvironmentLock) and lets go at its end. A lock held elsewhere for the whole wait is `busy`.
 */
export function stopOperation(engineOf: EngineOfOperation, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return async (params, context) => {
    const checked = parseStopParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the stop operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The stop operation takes no secret.');
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
      if (context.signal.aborted) throw new OperationError('cancelled', 'The stop operation was cancelled.');
      throw new OperationError('failed', error instanceof Error ? error.message : String(error));
    } finally {
      release();
    }
  };
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
  if (!isUserFacingError(error) || error.code === 'cancelled') throw new OperationError('failed', error instanceof Error ? error.message : String(error));
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
  return async (params, context) => {
    const checked = parseListConfigurationsParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the listConfigurations operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The listConfigurations operation takes no secret.');
    context.progress('listConfigurations', checked.environmentId);
    let ownHelper: OwnHelper;
    try {
      ownHelper = await ownHelperOf(context);
    } catch (error) {
      if (context.signal.aborted) throw new OperationError('cancelled', 'The operation was cancelled.');
      // Nothing has changed: the extension says so as for a worker that cannot take the lock (environmentLockUnavailable).
      throw new OperationError(LOCK_UNAVAILABLE_CODE, `The helper image of the worker cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      environmentLock: workerEnvironmentLock(lockDeps, (p) => openBatch(context, p), context),
    });
    try {
      const configPaths = await service.listConfigurations(checked.environmentId, { progress: silentProgress, signal: context.signal });
      return { configPaths } satisfies ListConfigurationsValue;
    } catch (error) {
      return flowRefusal(error, context) satisfies ListConfigurationsValue;
    }
  };
}

/**
 * Plan step 11C1 (decisions of 2026-10-03 and 2026-10-04): `windowState`, what an attached window reads of its dev
 * container (windowStateFlow). It only reads: no lock, no secret, no request to the extension.
 */
export function windowStateOperation(engineOf: EngineOfOperation): OperationHandler {
  return async (params, context) => {
    const checked = parseWindowStateParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the windowState operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The windowState operation takes no secret.');
    try {
      const value = await windowStateFlow({ ...checked, docker: new EngineDocker(engineOf(context), contextLogger(context)), signal: context.signal });
      return value satisfies WindowStateValue;
    } catch (error) {
      if (context.signal.aborted) throw new OperationError('cancelled', 'The windowState operation was cancelled.');
      throw new OperationError('failed', error instanceof Error ? error.message : String(error));
    }
  };
}

/**
 * Plan step 11C2a (decisions of 2026-10-03 and 2026-10-04): `delete`, the Delete of an environment, run by the worker's
 * own pipeline (workerServices, EnvironmentService.delete): the busy mark, the entry and the session files through the
 * requests of the operation (each for its environment only), the lock taken here, the removal over the port of the
 * engine, and the heartbeat record of the computer that sent it forgotten in the Session Monitor of the engine.
 */
export function deleteOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return async (params, context) => {
    const checked = parseDeleteParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the delete operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The delete operation takes no secret.');
    context.progress('delete', checked.environmentId);
    let ownHelper: OwnHelper;
    try {
      ownHelper = await ownHelperOf(context);
    } catch (error) {
      if (context.signal.aborted) throw new OperationError('cancelled', 'The operation was cancelled.');
      // Nothing has changed: the extension says so as for a worker that cannot take the lock (environmentLockUnavailable).
      throw new OperationError(LOCK_UNAVAILABLE_CODE, `The helper image of the worker cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      environmentLock: workerEnvironmentLock(lockDeps, (p) => openBatch(context, p), context),
      monitorSource: checked.monitorSource,
    });
    try {
      await service.delete(checked.environmentId, { progress: silentProgress, signal: context.signal, additionalVolumesToRemove: checked.additionalVolumesToRemove });
      return { deleted: true } satisfies DeleteValue;
    } catch (error) {
      return flowRefusal(error, context) satisfies DeleteValue;
    }
  };
}

/**
 * Plan step 11C2b (decisions of 2026-10-03 and 2026-10-04): `deleteCheck`, the check of Delete and its questions, run
 * by the worker's own pipeline (workerServices, EnvironmentService.deleteCheck): the record, the account and the
 * registry through the requests of the operation, the Git state recorded through `record recordGitSummary`, the
 * questions as `question` requests. No lock: it only reads on the engine.
 */
export function deleteCheckOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return async (params, context) => {
    const checked = parseDeleteCheckParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the deleteCheck operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The deleteCheck operation takes no secret.');
    context.progress('deleteCheck', checked.environmentId);
    let ownHelper: OwnHelper;
    try {
      ownHelper = await ownHelperOf(context);
    } catch (error) {
      if (context.signal.aborted) throw new OperationError('cancelled', 'The operation was cancelled.');
      throw new OperationError(LOCK_UNAVAILABLE_CODE, `The helper image of the worker cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      environmentLock: workerEnvironmentLock(lockDeps, (p) => openBatch(context, p), context),
    });
    try {
      const decision = await service.deleteCheck(checked.environmentId, { progress: silentProgress, signal: context.signal, repository: checked.repository, otherWindow: checked.otherWindow });
      return decision satisfies DeleteCheckValue;
    } catch (error) {
      return flowRefusal(error, context) satisfies DeleteCheckValue;
    }
  };
}

/**
 * Plan step 11C3 (decisions of 2026-10-03 and 2026-10-04): `reconcile`, the registry rebuilt from the labels of the
 * volumes of the engine (concept 7.5 "registry lost"), by the worker's own pipeline (workerServices,
 * EnvironmentService.reconcileFromVolumes): the volumes and the containers read over the port of the engine, the entries
 * added by the extension (`record restore`). No lock: it only reads on the engine.
 */
export function reconcileOperation(engineOf: EngineOfOperation, ownHelperOf: OwnHelperOf, openBatch: OpenWorkerBatch, lockDeps: LockDeps = LOCK_DEPS): OperationHandler {
  return async (params, context) => {
    const checked = parseReconcileParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the reconcile operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The reconcile operation takes no secret.');
    let ownHelper: OwnHelper;
    try {
      ownHelper = await ownHelperOf(context);
    } catch (error) {
      if (context.signal.aborted) throw new OperationError('cancelled', 'The operation was cancelled.');
      throw new OperationError(LOCK_UNAVAILABLE_CODE, `The helper image of the worker cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { service } = workerServices({
      host: flowHost(context),
      engine: engineOf(context),
      secretOf: (name) => context.secrets[name],
      logger: contextLogger(context),
      ownHelper,
      dockerHost: checked.dockerHost,
      owner: checked.owner,
      environmentLock: workerEnvironmentLock(lockDeps, (p) => openBatch(context, p), context),
    });
    try {
      return { added: await service.reconcileFromVolumes() } satisfies ReconcileValue;
    } catch (error) {
      if (context.signal.aborted) throw new OperationError('cancelled', 'The reconcile operation was cancelled.');
      throw new OperationError('failed', error instanceof Error ? error.message : String(error));
    }
  };
}
