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
import { analysisFailure, isAnalysisResult, type AnalysisJob, type AnalysisResult, type ConfigurationAnalyzer } from './configurationAnalysis';
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

export class WorkerConfigurationAnalyzer implements ConfigurationAnalyzer {
  constructor(
    private readonly scriptPath: string,
    private readonly logger?: Pick<Logger, 'warn'>,
    private readonly limits: Readonly<AnalysisLimits> = ANALYSIS_LIMITS,
  ) {}

  analyze<J extends AnalysisJob>(job: J): Promise<AnalysisResult<J>> {
    return new Promise((resolve) => {
      let worker: Worker | undefined;
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
      const fail = (reason: string): void => finish(analysisFailure(job), reason);
      const timer = setTimeout(() => fail(`it took longer than ${this.limits.timeoutMs} ms`), this.limits.timeoutMs);
      try {
        worker = new Worker(this.scriptPath, {
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
        if (message?.ok === true && isAnalysisResult(job, message.result)) finish(message.result as AnalysisResult<J>);
        else fail(message?.ok === false ? `error: ${message.error}` : 'an answer that is no result');
      });
      // ERR_WORKER_OUT_OF_MEMORY for a limit of `resourceLimits`, or an error of the script.
      worker.on('error', (error: Error & { code?: string }) => fail(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'it used too much memory' : `error: ${error.message}`));
      worker.on('exit', (code) => fail(`the worker ended with exit code ${code}`));
      worker.once('online', () => {
        if (!done && worker !== undefined) watch = this.watchMemory(worker, () => fail('it used too much memory'));
      });
      try {
        worker.postMessage(job);
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
