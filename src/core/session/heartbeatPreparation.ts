// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of PR #85 (A-R2-2): the preparation (the helper image for the worker, and for the start of a missing
// Session Monitor container) that a heartbeat of the window starts. The deadline of a heartbeat's attempt
// (HEARTBEAT_ATTEMPT_DEADLINE_MS) ends only the heartbeat's wait, never this shared work: it runs with its own long
// signal (HELPER_PREBUILD_TIMEOUT_MS, aborted when the window closes), so the next attempt joins the build that runs
// instead of starting it again. Everything else (an operation of the user) keeps its own signal for its preparation.
// No `vscode`.
import { AsyncLocalStorage } from 'async_hooks';
import { HELPER_PREBUILD_TIMEOUT_MS } from '../helper/helperPrebuild';
import { abortError } from '../ports';

export class HeartbeatPreparation {
  private readonly heartbeat = new AsyncLocalStorage<true>();
  private readonly disposal = new AbortController();

  constructor(private readonly timeoutMs: number = HELPER_PREBUILD_TIMEOUT_MS) {}

  /** Runs `fn` as the work of a heartbeat (its send, its repair): `prepare` within it gets the long signal. */
  scope<T>(fn: () => Promise<T>): Promise<T> {
    return this.heartbeat.run(true, fn);
  }

  /**
   * A preparation. In the scope of a heartbeat, `work` gets the long signal (ended after `timeoutMs`, aborted by
   * dispose) and is waited for until `wait` aborts (then an AbortError, while `work` goes on); elsewhere `work` gets
   * `wait` itself.
   */
  prepare<T>(work: (signal: AbortSignal | undefined) => Promise<T>, wait: AbortSignal | undefined): Promise<T> {
    if (this.heartbeat.getStore() !== true) return work(wait);
    return this.run(work, wait);
  }

  /** `work` with the long signal, waited for until `wait` aborts. */
  run<T>(work: (signal: AbortSignal) => Promise<T>, wait: AbortSignal | undefined): Promise<T> {
    if (wait?.aborted) return Promise.reject(abortError());
    const controller = new AbortController();
    const onDispose = (): void => controller.abort(abortError());
    if (this.disposal.signal.aborted) onDispose();
    else this.disposal.signal.addEventListener('abort', onDispose, { once: true });
    const timer = setTimeout(() => controller.abort(abortError()), this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const job = Promise.resolve()
      .then(() => work(controller.signal))
      .finally(() => {
        clearTimeout(timer);
        this.disposal.signal.removeEventListener('abort', onDispose);
      });
    // The waiter may have left (its deadline); the work's own failure is then nobody's to handle.
    job.catch(() => undefined);
    if (wait === undefined) return job;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortError());
      wait.addEventListener('abort', onAbort, { once: true });
      job.then(
        (value) => {
          wait.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          wait.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /** The window closes: the preparations it started are aborted. */
  dispose(): void {
    this.disposal.abort(abortError());
  }
}
