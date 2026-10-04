// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 8 (structural fix of the parser DoS class, S8-1, S8-2, S8-4 and later ones): runs each job of the host
// access analysis (configurationAnalysis.ts) in a worker thread of its own (configurationAnalysisWorker.ts, bundled as
// dist/configurationAnalysisWorker.js) with limits of memory (`resourceLimits`) and a time limit. When the time runs out,
// the worker is stopped (Worker.terminate stops even a running loop); a worker that runs out of memory, crashes, exits,
// or answers with anything but a result is stopped too. Each such failure refuses the configuration as not supported
// (analysisFailure): fail closed, never allowed. The limits of the parser (the sizes and budgets of dockerfile.ts) stay
// the first line; this is the bound on everything they miss. No `vscode` import: the extension passes the path of the
// bundle (context.asAbsolutePath).
//
// V8 ignores `resourceLimits` when the process runs with `--max-old-space-size` (for example in NODE_OPTIONS): the flag
// applies to every isolate of the process. So the runner also watches the memory of the worker itself (MemoryWatch): its
// heap (Worker.getHeapStatistics, Node 22.16 and newer), or else the growth of the memory of the whole process, and stops
// the worker beyond the same limit.
import { Worker } from 'worker_threads';
import type { Logger } from '../ports';
import { MAX_ANALYSIS_JOB_CHARACTERS } from './analysisLimits';
import {
  analysisFailure,
  exceedsJobSize,
  isAnalysisResult,
  thrownFailure,
  transferableJob,
  type AnalysisFailureKind,
  type AnalysisJob,
  type AnalysisResult,
  type ConfigurationAnalyzer,
} from './configurationAnalysis';
import type { AnalysisWorkerMessage } from './configurationAnalysisWorker';

/** The limits of one job: its time, and the memory of its worker (Node's `resourceLimits` of a Worker). */
export interface AnalysisLimits {
  timeoutMs: number;
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  stackSizeMb: number;
}

/** The interval of the watch of the memory of a worker. */
const MEMORY_WATCH_INTERVAL_MS = 50;

/** The limits of the extension: 10 s and 256 MB for a configuration, which normally takes milliseconds and a few MB. */
export const ANALYSIS_LIMITS: Readonly<AnalysisLimits> = {
  timeoutMs: 10_000,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};

/**
 * Review round 9 (P9-1, P9-2): each failure is of the kind `limit` (the time or memory of the worker, or the size of the
 * job: the configuration) or `internal` (the worker did not start, ended or crashed without an answer, or answered with
 * something else; also the time limit before the worker was running).
 */
export class WorkerConfigurationAnalyzer implements ConfigurationAnalyzer {
  /**
   * `script`: the path of the bundle of the thread (the extension: dist/configurationAnalysisWorker.js), or (plan step
   * 11E2) its text, which the worker carries in its own bundle (`devenv:analysis-script`) and starts with `eval`.
   */
  constructor(
    private readonly script: string | { code: string },
    private readonly logger?: Pick<Logger, 'warn'>,
    private readonly limits: Readonly<AnalysisLimits> = ANALYSIS_LIMITS,
    private readonly maxJobCharacters: number = MAX_ANALYSIS_JOB_CHARACTERS,
  ) {}

  analyze<J extends AnalysisJob>(job: J): Promise<AnalysisResult<J>> {
    // Review round 9 (S9-2): the structured clone of postMessage copies the job in this thread: never one of this size.
    if (exceedsJobSize(job, this.maxJobCharacters)) {
      const reason = `the configuration is larger than ${Math.round(this.maxJobCharacters / (1024 * 1024))} million characters`;
      this.logger?.warn(`The host access analysis of the configuration failed (${reason}); the configuration is refused.`);
      // Review round 10 (P10-3): a size, not a time or memory limit of the worker.
      return Promise.resolve(analysisFailure(job, { kind: 'size', reason }));
    }
    return new Promise((resolve) => {
      let worker: Worker | undefined;
      let online = false;
      let done = false;
      let watch: ReturnType<typeof setInterval> | undefined;
      const finish = (result: AnalysisResult<J>, failure?: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (watch !== undefined) clearInterval(watch);
        if (worker !== undefined) {
          worker.removeAllListeners();
          // An error of a worker that is stopped is of no interest any more.
          worker.on('error', () => undefined);
          void worker.terminate().catch(() => undefined);
        }
        if (failure !== undefined) {
          this.logger?.warn(`The host access analysis of the configuration failed (${failure}); the configuration is refused.`);
        }
        resolve(result);
      };
      const fail = (reason: string, kind: AnalysisFailureKind = 'internal'): void => finish(analysisFailure(job, { kind, reason }), reason);
      // A worker that is not running yet when the time is up did not start (for example on a machine under load).
      const timer = setTimeout(
        () => (online ? fail(`it took longer than ${this.limits.timeoutMs} ms`, 'limit') : fail(`the worker did not start within ${this.limits.timeoutMs} ms`)),
        this.limits.timeoutMs,
      );
      try {
        // A path, or (plan step 11E2) the text of the script, which `eval` runs.
        const evaluated = typeof this.script !== 'string';
        worker = new Worker(typeof this.script === 'string' ? this.script : this.script.code, {
          eval: evaluated,
          resourceLimits: {
            maxOldGenerationSizeMb: this.limits.maxOldGenerationSizeMb,
            maxYoungGenerationSizeMb: this.limits.maxYoungGenerationSizeMb,
            stackSizeMb: this.limits.stackSizeMb,
          },
        });
      } catch (error) {
        fail(`the worker did not start: ${String(error)}`);
        return;
      }
      worker.on('message', (message: AnalysisWorkerMessage) => {
        if (message?.ok === true && isAnalysisResult(job, message.result)) {
          // Only what a result has: a failure is never taken from a worker.
          const { failure: _ignored, ...result } = message.result as AnalysisResult<J> & { failure?: unknown };
          finish(result as AnalysisResult<J>);
        } else if (message?.ok === false) {
          const failure = thrownFailure(message.error);
          fail(failure.reason, failure.kind);
        } else fail('an answer that is no result');
      });
      // ERR_WORKER_OUT_OF_MEMORY for a limit of `resourceLimits`, or an error of the script (before `online`: it did not
      // start, for example a missing bundle).
      worker.on('error', (error: Error & { code?: string }) =>
        error.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? fail('it used too much memory', 'limit')
          : fail(
              online && error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_MODULE_NOT_FOUND'
                ? `error: ${error.message}`
                : `the worker did not start: ${error.message}`,
            ),
      );
      worker.on('exit', (code) => fail(`the worker ended with exit code ${code}`));
      worker.once('online', () => {
        online = true;
        if (!done && worker !== undefined) watch = this.watchMemory(worker, () => fail('it used too much memory', 'limit'));
      });
      try {
        // Without the function of the variables of the CLI (transferableJob), which postMessage cannot copy.
        worker.postMessage(transferableJob(job));
      } catch (error) {
        fail(`the job could not be passed: ${String(error)}`);
      }
    });
  }

  /**
   * Calls `onExceeded` when the heap of `worker` grows beyond the limits of `resourceLimits` (old and young generation
   * together), also where V8 ignores them. Without Worker.getHeapStatistics (Node before 22.16, as in older versions of
   * VS Code), the memory of the whole process (RSS) may grow by twice that much.
   */
  private watchMemory(worker: Worker, onExceeded: () => void): ReturnType<typeof setInterval> {
    const limitBytes = (this.limits.maxOldGenerationSizeMb + this.limits.maxYoungGenerationSizeMb) * 1024 * 1024;
    const heapStatistics = (worker as Worker & { getHeapStatistics?: () => Promise<{ used_heap_size: number }> }).getHeapStatistics;
    const startRss = process.memoryUsage().rss;
    let pending = false;
    const interval = setInterval(() => {
      if (typeof heapStatistics !== 'function') {
        if (process.memoryUsage().rss - startRss > 2 * limitBytes) onExceeded();
        return;
      }
      if (pending) return;
      pending = true;
      heapStatistics
        .call(worker)
        .then((statistics) => {
          if (statistics.used_heap_size > limitBytes) onExceeded();
        })
        // The worker ended in the meantime.
        .catch(() => undefined)
        .finally(() => {
          pending = false;
        });
    }, MEMORY_WATCH_INTERVAL_MS);
    interval.unref?.();
    return interval;
  }
}

/**
 * Plan step 11E2 (review round 1 of PR #103, A-L1): at most `max` jobs of the analyzers that share this limit run at once
 * (each in a thread of up to its memory limit); the others wait in order. The worker's operations share one, so
 * concurrent operations cannot add up threads without a bound.
 */
export function analysisSlots(max: number): <J extends AnalysisJob>(run: () => Promise<AnalysisResult<J>>) => Promise<AnalysisResult<J>> {
  // Review round 2 of PR #103 (A-L2): with no slot at all, every job would wait forever.
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`The analysis needs at least one slot, not ${max}.`);
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (run) => {
    if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next !== undefined) next();
      else running--;
    }
  };
}
