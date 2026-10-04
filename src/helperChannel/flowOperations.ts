// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (decision of 2026-10-03, the worker is the deputy): the operations that run a whole flow in the worker.
// Each one builds the seams of the flow from the requests of its operation (workerHostSide) and the port of its engine
// (dockerEngine), runs the flow, and answers with its result. The first flow is the token removal; the flows of plan
// steps 11B2 to 11E come here too.
import { LOCK_BUSY_CODE, LOCK_UNAVAILABLE_CODE, parseStopParams, parseTokenRemoveParams, type StopValue, type TokenRemoveValue } from '../core/helperChannel/protocol';
import { stopFlow } from '../core/worker/stopFlow';
import { LOCK_DEPS, takeEnvironmentLock, type LockDeps } from './lock';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { removeTokenFlow } from '../core/worker/tokenRemoveFlow';
import { workerHostSide } from '../core/worker/workerHostSide';
import type { HostRequest } from '../core/worker/hostSide';
import { OperationError, type OperationContext, type OperationHandler } from './server';

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
