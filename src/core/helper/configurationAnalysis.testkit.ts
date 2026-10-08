// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I (PR D): the host access analysis of the tests (moved here from configurationAnalysis.ts, where nothing
// of the extension or the worker used it).
import { analysisFailure, runAnalysisJob, thrownFailure, type AnalysisJob, type AnalysisResult, type ConfigurationAnalyzer } from './configurationAnalysis';

/**
 * Runs each job in the calling thread, without limits: for the tests of the pipeline (the worker runs the jobs in its
 * analysis thread, WorkerConfigurationAnalyzer). An analysis that throws refuses the configuration, as a failed thread
 * does.
 */
export const inProcessAnalyzer: ConfigurationAnalyzer = {
  analyze<J extends AnalysisJob>(job: J): Promise<AnalysisResult<J>> {
    try {
      return Promise.resolve(runAnalysisJob(job));
    } catch (error) {
      return Promise.resolve(analysisFailure(job, thrownFailure(error)));
    }
  },
};
