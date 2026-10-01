// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR C: the batch scope of an open operation (Start, Rebuild, Select configuration, Clone again, a first
// open). Decision 2026-09-29 and Q1 of 2026-10-01: every helper step of the operation that needs the volume of the
// environment runs in ONE batch helper of the operation (HelperBatchSession), opened through the worker that holds the
// lock of the environment (HeldEnvironmentLock.batch), never as a `docker run` of its own. WorkspaceHelper routes its
// volume steps here while the scope is active (currentBatchScope).
//
// - The session opens at the first volume step of the operation (after the lock, and after the volume was created by a
//   first open or Clone again, so `batch` never meets a missing volume), and closes when the scope ends (`finally`),
//   before the lock is released; also before the volume is removed (closeSession).
// - User decision D1 of 2026-09-30: a step without a batch kind, a step for another volume, a lock without `batch`, or a
//   session that cannot be opened refuse the operation (UserFacingError helperFailed with the cause). Nothing ever falls
//   back to the per-step `docker run`.
// - The helper ends itself after 15 minutes without a step (PR B), while the lock stays held during a question to the
//   user (Q3). A session that ended between two steps (lost, closed, or idle) is replaced once by a new one under the
//   same held lock before the next step; when that open fails, the operation is refused. A step is never repeated or
//   moved to a new session: a step that fails because its session was lost fails the operation, and every later step of
//   the scope is refused too, so that no caller that catches the error goes on.
// - Steps run one at a time (the helper runs one step at a time; a second one would be `busy`).
// No `vscode`.
import { AsyncLocalStorage } from 'async_hooks';
import type { HeldEnvironmentLock } from '../docker/environmentLock';
import { UserFacingError, errorMessage } from '../errors';
import type { BatchStepOptions, HelperBatchSession } from '../helperChannel/helperChannel';
import { Messages } from '../messages';
import { abortError, isAbortError, type Logger, type RunResult } from '../ports';
import { OutputTooLargeError } from '../process';
import type { BatchStepKind } from './batchSteps';

/** What a session needs besides the volume: the pinned helper image (its ID, `sha256:…`) and the socket source. */
export interface BatchSessionTarget {
  image: string;
  socket: string;
}

/** One step of the scope (see HelperBatchSession.step). */
export interface BatchScopeStep {
  volume: string;
  kind: BatchStepKind;
  params: unknown;
  options: BatchStepOptions;
}

/** The batch scope of one open operation (see the module comment). Create it with runWithBatchScope. */
export class BatchScope {
  private session: HelperBatchSession | undefined;
  /** Why the current session ended without close (set by its `lost`). */
  private sessionLost: string | undefined;
  /** Why the lock of the scope was lost. */
  private lockLost: string | undefined;
  /** Set once the scope refused: every later step is refused with it (D1). */
  private refused: UserFacingError | undefined;
  /** The chain of the steps (one at a time). */
  private queue: Promise<unknown> = Promise.resolve();
  private active = true;

  constructor(
    private readonly lock: HeldEnvironmentLock,
    readonly volume: string,
    private readonly logger: Logger,
  ) {
    void lock.lost.then((reason) => {
      this.lockLost = reason;
      // Review round 1 of PR #82 (A-R1-5): the session is a separate operation of the worker, so a step that runs keeps
      // running without the lock unless the session ends: its close ends that step, whose rejection then refuses the
      // scope (runStep). Never rejects (HelperBatchSession.close); the later closeSession of the scope waits for it.
      void this.session?.close();
    });
  }

  /**
   * Runs one step in the session of the scope; opens the session first when there is none, or when it ended since the
   * last step (`target` gives the image and the socket then). Rejects with UserFacingError('helperFailed') when the step
   * cannot run in the batch helper (D1), with an AbortError on a cancel, and with OutputTooLargeError; resolves with the
   * result of the step otherwise (also for a non-zero exit code or `timedOut`).
   */
  step(step: BatchScopeStep, target: () => Promise<BatchSessionTarget>): Promise<RunResult> {
    const run = this.queue.then(
      () => this.runStep(step, target),
      () => this.runStep(step, target),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Refuses the operation (D1) for a step that cannot run in the batch helper; the scope refuses every later step too. */
  refuse(cause: string): UserFacingError {
    this.logger.warn(`${cause}; the operation is refused, and nothing is run without the batch helper.`);
    this.refused ??= new UserFacingError('helperFailed', Messages.batchHelperUnavailable(cause), cause);
    return this.refused;
  }

  /**
   * Ends the session of the scope, if any (before the volume is removed, and when the scope ends). A later step opens
   * a new one. Never rejects.
   */
  async closeSession(): Promise<void> {
    const done = this.queue.then(async () => {
      const session = this.session;
      this.session = undefined;
      this.sessionLost = undefined;
      if (session === undefined) return;
      try {
        await session.close();
      } catch {
        // close never rejects; nothing to do.
      }
      this.logger.info(`The batch helper ${session.session} on the volume ${this.volume} is closed.`);
    });
    this.queue = done.catch(() => undefined);
    await this.queue;
  }

  private async runStep(step: BatchScopeStep, target: () => Promise<BatchSessionTarget>): Promise<RunResult> {
    if (this.refused !== undefined) throw this.refused;
    if (!this.active) throw this.refuse(`The step ${step.kind} came after the end of the operation`);
    if (step.volume !== this.volume) throw this.refuse(`The step ${step.kind} is for the volume ${step.volume}, not for ${this.volume} of the operation`);
    if (step.options.signal?.aborted) throw abortError();
    // Never a step without the lock (D1), also while the session itself still answers.
    if (this.lockLost !== undefined) throw this.refuse(`The lock of the environment was lost (${this.lockLost}), so the step ${step.kind} is not run`);
    const session = await this.ensureSession(step, target);
    try {
      return await session.step(step.kind, step.params, step.options);
    } catch (error) {
      if (isAbortError(error) || step.options.signal?.aborted) throw error;
      // The step failed on its own (its output beyond the cap); the session stays usable.
      if (error instanceof OutputTooLargeError) throw error;
      // Never repeated, never moved to another session: the step fails the operation (see the module comment).
      throw this.refuse(`The step ${step.kind} failed in the batch helper ${session.session}: ${errorMessage(error)}`);
    }
  }

  private async ensureSession(step: BatchScopeStep, target: () => Promise<BatchSessionTarget>): Promise<HelperBatchSession> {
    if (this.session !== undefined && this.sessionLost === undefined) return this.session;
    const reopen = this.session !== undefined;
    if (reopen) {
      // Between two steps (for example after its 15 minutes without a step while a question was open): one new session
      // under the same held lock.
      this.logger.info(`The batch helper ${this.session!.session} on the volume ${this.volume} ended (${this.sessionLost}). A new one is opened under the same lock.`);
      this.session = undefined;
      this.sessionLost = undefined;
    }
    if (this.lock.batch === undefined) throw this.refuse(`The worker that holds the lock of the environment has no batch helper for the step ${step.kind}`);
    let session: HelperBatchSession;
    try {
      const { image, socket } = await target();
      session = await this.lock.batch({ volume: this.volume, image, socket }, step.options.signal);
    } catch (error) {
      if (isAbortError(error) || step.options.signal?.aborted) throw error;
      throw this.refuse(`The batch helper on the volume ${this.volume} could not be ${reopen ? 'opened again' : 'opened'}: ${errorMessage(error)}`);
    }
    this.session = session;
    void session.lost.then((reason) => {
      if (this.session === session) this.sessionLost = reason;
    });
    this.logger.info(`The batch helper ${session.session} on the volume ${this.volume} is open.`);
    return session;
  }

  /** Ends the scope: closes its session. */
  async end(): Promise<void> {
    // Review round 1 of PR #82 (A-R1-6): inactive before the close, so that a step queued while the session closes is
    // refused and never opens a new session that nothing would close.
    this.active = false;
    await this.closeSession();
  }
}

const scopes = new AsyncLocalStorage<BatchScope>();

/** The batch scope of the running operation, if any. */
export function currentBatchScope(): BatchScope | undefined {
  return scopes.getStore();
}

/**
 * Runs `fn` in a batch scope for `volume` with the held `lock` (see the module comment); its session is closed when `fn`
 * ends (success, failure, or cancel), before the caller releases the lock. Re-entrant: within a scope of the same volume,
 * `fn` runs in it.
 */
export async function runWithBatchScope<T>(lock: HeldEnvironmentLock, volume: string, logger: Logger, fn: () => Promise<T>): Promise<T> {
  const current = currentBatchScope();
  if (current !== undefined && current.volume === volume) return fn();
  const scope = new BatchScope(lock, volume, logger);
  try {
    return await scopes.run(scope, fn);
  } finally {
    await scope.end();
  }
}
