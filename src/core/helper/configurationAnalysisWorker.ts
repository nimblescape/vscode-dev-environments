// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Worker thread of the host access analysis (review round 8; plan step 11E2: in the worker's bundle as the module
// `devenv:analysis-script`, scripts/workerScripts.mjs): runs one job of configurationAnalysis.ts and posts its result, or
// the error it threw. configurationAnalysisRunner.ts starts it from that text with limits of memory and stops it after its
// time limit. No `vscode` import.
import { parentPort } from 'worker_threads';
import { runAnalysisJob, type AnalysisJob } from './configurationAnalysis';

/** The answer of the worker to a job. */
export type AnalysisWorkerMessage = { ok: true; result: unknown } | { ok: false; error: string };

parentPort?.once('message', (job: AnalysisJob) => {
  let message: AnalysisWorkerMessage;
  try {
    message = { ok: true, result: runAnalysisJob(job) };
  } catch (error) {
    message = { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 500) };
  }
  parentPort?.postMessage(message);
});
