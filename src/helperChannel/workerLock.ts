// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3b (decision of 2026-10-03, the worker is the deputy): the lock of an environment as the worker's own
// pipeline holds it (EnvironmentServiceDeps.environmentLock): taken here, the one way (takeEnvironmentLock, user
// decisions D1 to D3), with the batch helper of the flow started here too (workerBatchSession). Nothing goes through the
// extension: a Docker call through the lock is refused in the worker (its pipeline uses the engine of the worker).
import { EnvironmentLockError, type HeldEnvironmentLock } from '../core/docker/environmentLock';
import { LOCK_BUSY_CODE } from '../core/helperChannel/protocol';
import { abortError } from '../core/ports';
import type { HelperBatchSession } from '../core/helperChannel/helperChannel';
import { takeEnvironmentLock, type LockDeps } from './lock';
import { OperationError, type OperationContext } from './server';

/** The environmentLock of the worker's own pipeline within the operation of `context`. */
export function workerEnvironmentLock(
  lockDeps: LockDeps,
  /** Opens a batch session of the flow (workerBatchSession of batch.ts). */
  openBatch: (p: { volume: string; image: string; socket: string }) => Promise<HelperBatchSession>,
  context: OperationContext,
): (environmentId: string, waitSeconds: number, signal: AbortSignal | undefined) => Promise<HeldEnvironmentLock> {
  return async (environmentId, waitSeconds, signal) => {
    let release: () => void;
    try {
      release = await takeEnvironmentLock(lockDeps, environmentId, waitSeconds, signal ? AbortSignal.any([context.signal, signal]) : context.signal);
    } catch (error) {
      // As the pipeline expects them (as the removed HelperChannels.lock gave them, plan step 11I1, PR B1): a cancel is an
      // AbortError, a holder elsewhere `busy`, anything else `unavailable` (nothing has changed).
      if (error instanceof OperationError && error.code === 'cancelled') throw abortError();
      if (error instanceof OperationError && error.code === LOCK_BUSY_CODE) throw new EnvironmentLockError('busy', error.message);
      throw new EnvironmentLockError('unavailable', error instanceof Error ? error.message : String(error));
    }
    let released = false;
    // The kernel lock lives with the open file of this worker until `release`, or until the worker exits (review round 2
    // of 11B3b, A-R2-1: the end of the operation alone does not let it go). The pipeline releases it in `finally`, after
    // its batch helper was closed, also after a cancel (withEnvironmentLock); a cancel only marks the lock as lost, so
    // that the batch scope ends its session first.
    const lost = new Promise<string>((resolve) => {
      const ended = () => {
        if (!released) resolve('the operation of the worker ended');
      };
      if (context.signal.aborted) ended();
      else context.signal.addEventListener('abort', ended, { once: true });
    });
    return {
      environmentId,
      lost,
      docker: async () => {
        throw new Error('A Docker call through the lock of the environment in the worker is not allowed: the pipeline of the worker uses its engine.');
      },
      // Review round 1 of 11B3b (A-R1-4): the open ends with the operation (its signal and time limit), not with a signal
      // of its own; the listing has none narrower. Plan step 11E passes the signal of the open through.
      batch: (p) => openBatch(p),
      release: async () => {
        // Once: a second close could close a file descriptor that the process has reused since.
        if (released) return;
        released = true;
        release();
      },
    };
  };
}
