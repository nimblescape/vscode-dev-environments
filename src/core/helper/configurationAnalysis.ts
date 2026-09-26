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

/**
 * Review round 9 (P9-1, P9-2): why an analysis failed.
 * - `limit`: the configuration is beyond a limit (the time or the memory of the worker, or a size of analysisLimits.ts):
 *   ANALYSIS_FAILED_ITEM;
 * - `internal`: the analysis could not run (its worker did not start, ended or crashed without an answer, or answered
 *   with something else than a result): analysisInternalItem. Nothing says that the configuration is to blame.
 */
export type AnalysisFailureKind = 'limit' | 'internal';

export interface AnalysisFailure {
  kind: AnalysisFailureKind;
  /** For the log, for example `it took longer than 10000 ms`. */
  reason: string;
}

/** Review round 9 (P9-2): the item of an analysis that could not run (AnalysisFailure `internal`). */
export function analysisInternalItem(reason: string): string {
  return `The configuration check failed to start (internal error): ${reason}`;
}

/** The refused item of a failed analysis: ANALYSIS_FAILED_ITEM, or analysisInternalItem. */
export function analysisFailureItem(failure: AnalysisFailure): string {
  return failure.kind === 'limit' ? ANALYSIS_FAILED_ITEM : analysisInternalItem(failure.reason);
}

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

/**
 * The result of each kind of AnalysisJob. `failure` (review round 9, P9-1, P9-2): the analysis failed (analysisFailure),
 * and the report refuses the configuration with analysisFailureItem; the pipeline tells it apart from a refusal of the
 * policy. Never set by a worker (the runner sets it).
 */
export interface AnalysisResults {
  hostAccess: { report: HostAccessReport; failure?: AnalysisFailure };
  single: { report: HostAccessReport; imageReferences: NamedImageReference[]; references: ConfigReferences; failure?: AnalysisFailure };
  compose: { report: HostAccessReport; imageReferences: NamedImageReference[]; references: ConfigReferences; failure?: AnalysisFailure };
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
 * The result of a job whose analysis failed: the configuration is refused as not supported (analysisFailureItem:
 * ANALYSIS_FAILED_ITEM for a limit), without image references (the refusal stops the pipeline before they are used).
 * Review round 9 (P9-1, P9-2): `failure` says why.
 */
export function analysisFailure<J extends AnalysisJob>(job: J, failure: AnalysisFailure = { kind: 'limit', reason: 'the analysis failed' }): AnalysisResult<J> {
  const report: HostAccessReport = { hostAccess: [], unsupported: [analysisFailureItem(failure)] };
  if (job.kind === 'hostAccess') return { report, failure } as AnalysisResult<J>;
  return { report, imageReferences: [], references: { images: [], features: [] }, failure } as AnalysisResult<J>;
}

/**
 * Review round 9 (S9-2): whether the texts (and keys) of `value` have more than `maxCharacters` characters together, or
 * it has more than `maxCharacters / 8` values: counted without a copy, and stopped at the limit, so that the extension
 * host never clones a job of that size for its worker.
 */
export function exceedsJobSize(value: unknown, maxCharacters: number): boolean {
  let characters = 0;
  let values = 0;
  const maxValues = Math.floor(maxCharacters / 8);
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const item = stack.pop();
    if (++values > maxValues) return true;
    if (typeof item === 'string') characters += item.length;
    else if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) continue;
      seen.add(item);
      if (Array.isArray(item)) {
        for (const entry of item) stack.push(entry);
      } else {
        for (const [key, entry] of Object.entries(item)) {
          characters += key.length;
          stack.push(entry);
        }
      }
    }
    if (characters > maxCharacters) return true;
  }
  return false;
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
    } catch (error) {
      return Promise.resolve(analysisFailure(job, thrownFailure(error)));
    }
  },
};

/**
 * Review round 9 (P9-2): the kind of an error that the analysis threw: a stack or memory overflow is a limit (the
 * configuration is too complex), anything else an internal error.
 */
export function thrownFailure(error: unknown): AnalysisFailure {
  const text = String(error instanceof Error ? error.message : error).slice(0, 500);
  return /maximum call stack|out of memory|invalid (string|array) length|allocation failed/i.test(text)
    ? { kind: 'limit', reason: `error: ${text}` }
    : { kind: 'internal', reason: `error: ${text}` };
}
