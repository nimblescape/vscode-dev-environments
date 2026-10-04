// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #103 (B, mutation probes): workerAnalyzer runs the text of `devenv:analysis-script` (never as a
// path) with the limits of the extension (ANALYSIS_LIMITS), and each of the 5 operations whose pipeline is
// workerServices gives it that analyzer (none of them falls back to ANALYZER_NOT_IN_WORKER).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ deps: [] as Array<Record<string, unknown>> }));
vi.mock('../core/worker/workerServices', () => ({
  workerServices: (deps: Record<string, unknown>) => {
    captured.deps.push(deps);
    return {
      service: {
        listConfigurations: async () => [],
        delete: async () => undefined,
        deleteCheck: async () => ({ decision: 'cancel' }),
        reconcileFromVolumes: async () => 0,
        recordGitState: async () => false,
      },
    };
  },
}));

import analysisScriptStub from './analysisScript.stub';
import { ANALYSIS_LIMITS, WorkerConfigurationAnalyzer } from '../core/helper/configurationAnalysisRunner';
import type { DockerEngine } from '../core/worker/dockerEngine';
import type { OwnHelper } from '../core/worker/ownHelper';
import {
  deleteCheckOperation,
  deleteOperation,
  listConfigurationsOperation,
  reconcileOperation,
  recordGitStateOperation,
  workerAnalyzer,
  type OpenWorkerBatch,
} from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const TARGET = { dockerHost: '', owner: { windowId: 'window-1', pid: 4242 } };

function context(): OperationContext {
  return {
    signal: new AbortController().signal,
    ...contextSecrets(),
    progress: () => {},
    log: () => {},
    output: () => {},
    docker: async () => {
      throw new Error('No Docker CLI call.');
    },
  };
}

const engineOf = () => ({}) as DockerEngine;
const ownHelperOf = async () => ({}) as OwnHelper;
const openBatch: OpenWorkerBatch = async () => {
  throw new Error('No batch in this test.');
};

beforeEach(() => {
  captured.deps.length = 0;
});

describe('the analyzer of the operations of the worker (review round 1 of PR #103, B)', () => {
  it('workerAnalyzer runs the text of the script with `eval`, with the limits of the extension', () => {
    // Adapted to A-L1 of the same round (the shared slots wrap the analyzer): its `inner` is the thread's analyzer.
    const analyzer = workerAnalyzer(context()).inner as unknown as { script: unknown; limits: unknown };
    expect(analyzer).toBeInstanceOf(WorkerConfigurationAnalyzer);
    expect(analyzer.script).toEqual({ code: analysisScriptStub });
    expect(analyzer.limits).toBe(ANALYSIS_LIMITS);
  });

  it.each([
    ['listConfigurations', () => listConfigurationsOperation(engineOf, ownHelperOf, openBatch), { environmentId: ID, ...TARGET }],
    ['delete', () => deleteOperation(engineOf, ownHelperOf, openBatch), { environmentId: ID, ...TARGET, additionalVolumesToRemove: [], monitorSource: SOURCE }],
    ['deleteCheck', () => deleteCheckOperation(engineOf, ownHelperOf, openBatch), { environmentId: ID, ...TARGET, repository: 'Acme/API', otherWindow: false }],
    ['reconcile', () => reconcileOperation(engineOf, ownHelperOf, openBatch), { ...TARGET }],
    ['recordGitState', () => recordGitStateOperation(engineOf, ownHelperOf, openBatch), { environmentId: ID, ...TARGET }],
  ])('%s gives its pipeline the analysis thread of the worker', async (_name, operation, params) => {
    await operation()(params, context());
    expect(captured.deps).toHaveLength(1);
    expect((captured.deps[0].analyzer as { inner?: unknown } | undefined)?.inner).toBeInstanceOf(WorkerConfigurationAnalyzer);
  });
});
