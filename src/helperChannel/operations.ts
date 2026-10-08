// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The operations of the helper channel (src/core/helperChannel/protocol.ts): `probe` (whether the worker reaches its
// engine, and which engine: plan step 5, PR A), `sweep`, `refresh` (the states and branches of the environments: plan
// step 5, PR C), and the flows that run whole operations here, next to the engine (flowOperations.ts). Plan step 11I1,
// PR B1: the relay operations (`docker`, `lock`, `batch`, `batchStep`, `batchChunk`, `pull`, `startContainers`) are gone;
// the worker runs the whole pipeline itself, under its own locks and batch helpers. Plan step 11I (PR A): every operation
// acts on the engine through its port (DockerEngine, section 0 of the plan); the worker runs no Docker CLI of its own.
import {
  OP_PROBE,
  OP_DELETE,
  OP_DELETE_CHECK,
  OP_RECONCILE,
  OP_HEARTBEAT,
  OP_OPEN,
  OP_MONITOR_ENSURE,
  OP_RECORD_GIT_STATE,
  OP_LIST_CONFIGURATIONS,
  OP_WINDOW_STATE,
  OP_STOP,
  OP_TOKEN_REMOVE,
  OP_REFRESH,
  OP_SWEEP,
  SWEEP_FILTERS,
  parseProbeParams,
  parseRefreshParams,
  parseSweepParams,
  refreshValue,
  type ProbeValue,
  type RefreshValue,
  type SweepValue,
} from '../core/helperChannel/protocol';
import { errorMessage } from '../core/errors';
import { readEnvironmentStates } from '../core/pipeline/refreshStates';
import { EngineDocker } from '../core/worker/engineDocker';
import { batchDeps, workerBatchSession } from './batch';
import { engineApi, engineHijack } from './engineApi';
import { dockerEngine } from './engineClient';
import { contextLogger, deleteCheckOperation, deleteOperation, listConfigurationsOperation, ownHelperOfEngine, reconcileOperation, heartbeatOperation, monitorEnsureOperation, openOperation, recordGitStateOperation, stopOperation, tokenRemoveOperation, windowStateOperation, type EngineOfOperation, type OwnHelperOf } from './flowOperations';
import * as os from 'os';
import { OperationError, type OperationHandler } from './server';
import monitorScript from 'devenv:monitor-script';

/** The longest detail of a probe that did not reach the engine (the end of the reason is kept). */
export const MAX_PROBE_DETAIL_LENGTH = 2_000;

/**
 * `probe` (plan step 5, PR A): the version of the engine behind the socket of the worker, and the identity of that
 * engine, which the extension compares with the identity that its own Docker CLI reads without the worker. Plan step
 * 11I (PR A): over the port of the engine (`GET /version`, `GET /info`), no Docker CLI of the worker. A version that
 * cannot be read is the answer (its reason as the detail: the extension closes the worker, "does not reach Docker"); an
 * identity that cannot be read is left out (the extension closes the worker too). The time limit is the one of the
 * request (the extension sets it).
 */
export function probeOperation(engineOf: EngineOfOperation): OperationHandler {
  return async (params, context) => {
    if (parseProbeParams(params) === undefined) throw new OperationError('invalid', 'The probe operation takes no parameters.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The probe operation takes no secret.');
    context.progress('probe');
    const engine = engineOf(context);
    let version: string;
    try {
      version = (await engine.version(context.signal)).version;
    } catch (error) {
      if (context.signal.aborted) throw new OperationError('cancelled', 'The probe operation was cancelled.');
      const failed: ProbeValue = { detail: errorMessage(error).slice(-MAX_PROBE_DETAIL_LENGTH) };
      return failed;
    }
    if (version === '') {
      const failed: ProbeValue = { detail: 'The Docker engine did not name its version.' };
      return failed;
    }
    const value: ProbeValue = { serverVersion: version, detail: `Docker ${version}` };
    try {
      value.engine = await engine.identity(context.signal);
    } catch (error) {
      if (context.signal.aborted) throw new OperationError('cancelled', 'The probe operation was cancelled.');
      // Plan step 5, PR A: no identity, so the extension refuses this worker; the log says why.
      context.log(`The identity of the Docker engine could not be read: ${errorMessage(error)}`, 'warn');
    }
    return value;
  };
}

/**
 * Review round 4 (M1): `sweep` removes the channel containers that were created but never started (protocol.ts,
 * OP_SWEEP). Plan step 11I (PR A): the prune of the port of the engine with SWEEP_FILTERS (`POST /containers/prune`;
 * before: `docker container prune -f` of the worker's Docker CLI, with the same filters); its value is how many it
 * removed.
 */
export function sweepOperation(engineOf: EngineOfOperation): OperationHandler {
  return async (params, context) => {
    if (parseSweepParams(params) === undefined) throw new OperationError('invalid', 'The sweep operation takes no parameters.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The sweep operation takes no secret.');
    try {
      const removed = await engineOf(context).pruneContainers(SWEEP_FILTERS, context.signal);
      const value: SweepValue = { removed: removed.length };
      return value;
    } catch (error) {
      if (context.signal.aborted) throw new OperationError('cancelled', 'The sweep operation was cancelled.');
      throw new OperationError('failed', errorMessage(error));
    }
  };
}

/**
 * Plan step 5, PR C: `refresh`: readEnvironmentStates of the worker, the same code as in the pipeline. Plan step 11C1:
 * over the port of its engine (EngineDocker; section 0 of the plan), no Docker CLI of its own. It only reads; it takes no
 * secret.
 */
export function refreshOperation(engineOf: EngineOfOperation): OperationHandler {
  return async (params, context) => {
    const checked = parseRefreshParams(params);
    if (checked === undefined) throw new OperationError('invalid', 'The parameters of the refresh operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The refresh operation takes no secret.');
    context.progress('refresh');
    const value: RefreshValue = refreshValue(await readEnvironmentStates(new EngineDocker(engineOf(context), contextLogger(context)), checked.environments));
    return value;
  };
}

/** Plan step 10A: the Engine API of the worker's engine, over its socket. */
const ENGINE = engineApi();

/** Plan step 11B1: the port of the engine for the flows that run in the worker (section 0 of the plan), per operation. */
const HIJACK = engineHijack();
// Plan step 11E1 (review round 1 of PR #102, A-M1): the output of an exec masked with every secret of the operation.
const ENGINE_OF: EngineOfOperation = (context) => dockerEngine(ENGINE, HIJACK, (name) => context.secrets[name], () => context.maskedValues());

/** Plan step 6, PR B: the batch helpers of the flows of this worker (workerBatchSession); plan step 11G3: over its engine. */
const BATCH = batchDeps(ENGINE_OF);

/**
 * Plan step 11B3b: the worker's own helper image and socket, read once from the engine (the inspect of its own container,
 * whose host name is its short ID), and again after a failure, each read within a time limit (ownHelperOfEngine).
 */
const OWN_HELPER_OF: OwnHelperOf = ownHelperOfEngine(ENGINE_OF, () => os.hostname());

export const OPERATIONS: Readonly<Record<string, OperationHandler>> = {
  // Plan step 11I (PR A): over the port of the engine too.
  [OP_PROBE]: probeOperation(ENGINE_OF),
  [OP_SWEEP]: sweepOperation(ENGINE_OF),
  [OP_REFRESH]: refreshOperation(ENGINE_OF),
  // Plan step 11B1: the flows that run in the worker (flowOperations.ts).
  [OP_TOKEN_REMOVE]: tokenRemoveOperation(ENGINE_OF),
  // Plan step 11B2: Stop, under the lock that the operation takes itself.
  [OP_STOP]: stopOperation(ENGINE_OF),
  // Plan step 11B3b: the listing of Select configuration, by the worker's own pipeline.
  [OP_LIST_CONFIGURATIONS]: listConfigurationsOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p)),
  // Plan step 11C2a: Delete, by the worker's own pipeline.
  [OP_DELETE]: deleteOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p)),
  // Plan step 11C2b: the check of Delete and its questions, by the worker's own pipeline.
  [OP_DELETE_CHECK]: deleteCheckOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p)),
  // Plan step 11C1: the reads of an attached window.
  [OP_WINDOW_STATE]: windowStateOperation(ENGINE_OF),
  // Plan step 11C3: the registry rebuilt from the volumes, by the worker's own pipeline.
  [OP_RECONCILE]: reconcileOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p)),
  // Plan step 11D1: the heartbeats of the Session Monitor, and the Git state of a release (plan step 11E6, decision D1 of
  // 2026-10-05: the image settings and list come with the open).
  [OP_HEARTBEAT]: heartbeatOperation(ENGINE_OF),
  [OP_RECORD_GIT_STATE]: recordGitStateOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p)),
  // Plan step 11D2: the ensure of the Session Monitor container, with the script of the monitor in this bundle.
  [OP_MONITOR_ENSURE]: monitorEnsureOperation(ENGINE_OF, OWN_HELPER_OF, () => monitorScript),
  // Plan step 11E6: the open, by the worker's own pipeline, with the Session Monitor of this bundle.
  [OP_OPEN]: openOperation(ENGINE_OF, OWN_HELPER_OF, (context, p) => workerBatchSession(BATCH, context, p), () => monitorScript),
};
