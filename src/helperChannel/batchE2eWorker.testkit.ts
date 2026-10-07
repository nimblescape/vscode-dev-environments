// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I1, PR B1 (user decision D5 of 2026-10-07: the end of the batch helper with its worker is tested at unit
// level only, in batch.e2e.test.ts): the entry of the worker bundle of that test. It is the worker of main.ts (the same
// entries startChannel and startBatchHelper, the same operations) with one operation of the test, OP_HOLD_BATCH, which
// stands in for a flow of the worker that holds the batch helper of its environment (workerBatchSession): it opens the
// session, runs the steps that the test names through it, and holds it until the operation is cancelled when asked. The
// flows themselves need the lock folder of the Session Monitor, their own helper image and the records of the extension,
// which the test of the batch helper has no part in. Never bundled into the extension or the worker of dist.
import type { BatchStepKind } from '../core/helper/batchStepKinds';
import { batchDeps, workerBatchSession } from './batch';
import { engineApi, engineHijack } from './engineApi';
import { dockerEngine } from './engineClient';
import { OPERATIONS } from './operations';
import type { OperationHandler } from './server';

export { startBatchHelper, startChannel } from './main';

/** The operation of the test (see the module comment). */
export const OP_HOLD_BATCH = 'holdBatch';
/** The progress of OP_HOLD_BATCH once the session is open (the detail is the session). */
export const HELD_STEP = 'held';

export interface HoldBatchParams {
  volume: string;
  image: string;
  socket: string;
  /**
   * The steps to run through the session, in order. `overrideText`: the length of a text that the worker puts into
   * `params.override` (an input longer than a request of the extension, which the worker sends to the helper whole).
   */
  steps?: Array<{ kind: string; params: Record<string, unknown>; overrideText?: number }>;
  /** Hold the session after the steps until the operation is cancelled. */
  hold?: boolean;
}

/** The value of OP_HOLD_BATCH: the session, and the outcome of each step (its exit code, or the name and code of its error). */
export interface HoldBatchValue {
  session: string;
  outcomes: Array<{ exitCode: number | null } | { name: string; code?: string }>;
}

const DEPS = batchDeps((context) => dockerEngine(engineApi(), engineHijack(), (name) => context.secrets[name], () => context.maskedValues()));

const holdBatch: OperationHandler = async (params, context) => {
  const p = params as HoldBatchParams;
  const session = await workerBatchSession(DEPS, context, { volume: p.volume, image: p.image, socket: p.socket });
  try {
    const outcomes: HoldBatchValue['outcomes'] = [];
    for (const step of p.steps ?? []) {
      try {
        const stepParams = step.overrideText === undefined ? step.params : { ...step.params, override: { text: 'x'.repeat(step.overrideText) } };
        const result = await session.step(step.kind as BatchStepKind, stepParams, { signal: context.signal });
        outcomes.push({ exitCode: result.exitCode });
      } catch (error) {
        outcomes.push({ name: (error as Error).name, code: (error as { code?: string }).code });
      }
    }
    if (p.hold === true) {
      context.progress(HELD_STEP, session.session);
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    const value: HoldBatchValue = { session: session.session, outcomes };
    return value;
  } finally {
    await session.close();
  }
};

(OPERATIONS as Record<string, OperationHandler>)[OP_HOLD_BATCH] = holdBatch;
