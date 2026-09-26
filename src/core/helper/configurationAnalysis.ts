// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 8 (structural fix of the parser DoS class): the host access analysis of the configuration of a repository
// (hostAccessReport, composeAccessReport, and the images of its Dockerfiles) as jobs that run in a worker thread with
// limits of time and memory (configurationAnalysisRunner.ts, configurationAnalysisWorker.ts). A Dockerfile or a Compose
// model of a repository is hostile input: however its text is analysed, the extension host must not freeze or crash on
// it. A job that fails (too slow, too much memory, a crash) refuses the configuration: never allowed on a failure.
// Pure: no `vscode` import, no I/O.
import { collectReferences, type ConfigReferences } from '../imageCheck/imageCheck';
import type { DevcontainerConfig } from '../types';
import { composeReferences } from './compose';
import { composeAccessReport, composeImageReferences, type ComposeAccessInput } from './composeAccess';
import {
  hostAccessReport,
  singleImageReferences,
  withDockerfileCache,
  type HostAccessInput,
  type HostAccessReport,
  type NamedImageReference,
} from './hostAccess';

/**
 * The item of a configuration whose analysis failed (ConfigurationAnalyzer): refused as not supported, whatever the
 * switch of the host access checks says.
 */
export const ANALYSIS_FAILED_ITEM = 'The configuration is too large or too complex to check (it took too long or used too much memory)';

/** One analysis of the host access policy. */
export type AnalysisJob =
  /** hostAccessReport alone (devcontainer.json, the merged configuration, the runArgs of Docker, the image metadata). */
  | { kind: 'hostAccess'; input: HostAccessInput; checksOn: boolean }
  /**
   * A single container: hostAccessReport (with its Dockerfile), the image references for the question of image IDs
   * (singleImageReferences), and the references of the image check (collectReferences, the FROM images).
   */
  | { kind: 'single'; input: HostAccessInput; checksOn: boolean; config: DevcontainerConfig; dockerfileText?: string }
  /**
   * A Docker Compose model: composeAccessReport, its image references (composeImageReferences), and the references of
   * the image check (composeReferences, with the `features` of devcontainer.json).
   */
  | { kind: 'compose'; input: ComposeAccessInput; checksOn: boolean; features?: unknown };

/** The result of each kind of AnalysisJob. */
export interface AnalysisResults {
  hostAccess: { report: HostAccessReport };
  single: { report: HostAccessReport; imageReferences: NamedImageReference[]; references: ConfigReferences };
  compose: { report: HostAccessReport; imageReferences: NamedImageReference[]; references: ConfigReferences };
}

export type AnalysisResult<J extends AnalysisJob> = AnalysisResults[J['kind']];

/** Runs the analyses of the host access policy; a failed one resolves the refusal of analysisFailure, never rejects. */
export interface ConfigurationAnalyzer {
  analyze<J extends AnalysisJob>(job: J): Promise<AnalysisResult<J>>;
}

/** Runs a job in this thread (the worker runs it with runAnalysisJob too). Throws what the analysis throws. */
export function runAnalysisJob<J extends AnalysisJob>(job: J): AnalysisResult<J> {
  // One analysis of each Dockerfile for the whole job (review round 8, S8-4).
  return withDockerfileCache(() => {
    switch (job.kind) {
      case 'hostAccess':
        return { report: hostAccessReport(job.input, job.checksOn) } as AnalysisResult<J>;
      case 'single':
        return {
          report: hostAccessReport(job.input, job.checksOn),
          imageReferences: singleImageReferences(job.config, job.dockerfileText),
          references: collectReferences(job.config, job.dockerfileText),
        } as AnalysisResult<J>;
      case 'compose': {
        const dockerfiles = job.input.dockerfiles ?? {};
        return {
          report: composeAccessReport(job.input, job.checksOn),
          imageReferences: composeImageReferences(job.input.model, dockerfiles),
          references: composeReferences(job.input.model, dockerfiles, job.features),
        } as AnalysisResult<J>;
      }
      default:
        throw new Error(`Unknown analysis job ${String((job as { kind?: unknown }).kind)}.`);
    }
  });
}

/**
 * The result of a job whose analysis failed: the configuration is refused as not supported (ANALYSIS_FAILED_ITEM),
 * without image references (the refusal stops the pipeline before they are used).
 */
export function analysisFailure<J extends AnalysisJob>(job: J): AnalysisResult<J> {
  const report: HostAccessReport = { hostAccess: [], unsupported: [ANALYSIS_FAILED_ITEM] };
  if (job.kind === 'hostAccess') return { report } as AnalysisResult<J>;
  return { report, imageReferences: [], references: { images: [], features: [] } } as AnalysisResult<J>;
}

/**
 * Whether `value` has the form of the result of `job` (the answer of a worker): the reports as lists of texts, the
 * references as lists. Anything else counts as a failure.
 */
export function isAnalysisResult(job: AnalysisJob, value: unknown): boolean {
  const record = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item);
  const texts = (item: unknown): boolean => Array.isArray(item) && item.every((entry) => typeof entry === 'string');
  if (!record(value) || !record(value.report) || !texts(value.report.hostAccess) || !texts(value.report.unsupported)) return false;
  if (job.kind === 'hostAccess') return true;
  const references = value.references;
  return (
    Array.isArray(value.imageReferences) &&
    value.imageReferences.every((entry) => record(entry) && typeof entry.reference === 'string' && typeof entry.what === 'string') &&
    record(references) &&
    texts(references.images) &&
    texts(references.features)
  );
}

/**
 * Runs each job in the calling thread, without limits: for the tests of the pipeline (the extension uses
 * WorkerConfigurationAnalyzer). An analysis that throws refuses the configuration, as a failed worker does.
 */
export const inProcessAnalyzer: ConfigurationAnalyzer = {
  analyze<J extends AnalysisJob>(job: J): Promise<AnalysisResult<J>> {
    try {
      return Promise.resolve(runAnalysisJob(job));
    } catch {
      return Promise.resolve(analysisFailure(job));
    }
  },
};
