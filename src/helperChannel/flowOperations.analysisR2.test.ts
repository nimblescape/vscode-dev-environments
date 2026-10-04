// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #103 (B, mutation probes): the analyzer that each of the 5 operations gives its pipeline runs
// the job in the analysis thread (WorkerConfigurationAnalyzer.analyze) and gives its result, not a stand-in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { AnalysisJob, ConfigurationAnalyzer } from '../core/helper/configurationAnalysis';
import { WorkerConfigurationAnalyzer } from '../core/helper/configurationAnalysisRunner';
import type { DockerEngine } from '../core/worker/dockerEngine';
import type { OwnHelper } from '../core/worker/ownHelper';
import {
  deleteCheckOperation,
  deleteOperation,
  listConfigurationsOperation,
  reconcileOperation,
  recordGitStateOperation,
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
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the analyzer of the operations of the worker (review round 2 of PR #103, B)', () => {
  it.each([
    ['listConfigurations', () => listConfigurationsOperation(engineOf, ownHelperOf, openBatch), { environmentId: ID, ...TARGET }],
    ['delete', () => deleteOperation(engineOf, ownHelperOf, openBatch), { environmentId: ID, ...TARGET, additionalVolumesToRemove: [], monitorSource: SOURCE }],
    ['deleteCheck', () => deleteCheckOperation(engineOf, ownHelperOf, openBatch), { environmentId: ID, ...TARGET, repository: 'Acme/API', otherWindow: false }],
    ['reconcile', () => reconcileOperation(engineOf, ownHelperOf, openBatch), { ...TARGET }],
    ['recordGitState', () => recordGitStateOperation(engineOf, ownHelperOf, openBatch), { environmentId: ID, ...TARGET }],
  ])('%s: its analyzer runs the job in the analysis thread and gives its result', async (_name, operation, params) => {
    const result = { report: { hostAccess: [], unsupported: [] } };
    const spy = vi.spyOn(WorkerConfigurationAnalyzer.prototype, 'analyze').mockResolvedValue(result as never);
    await operation()(params, context());
    expect(captured.deps).toHaveLength(1);
    const job: AnalysisJob = { kind: 'hostAccess', checksOn: true, input: { ownVolume: 'own' } } as AnalysisJob;
    expect(await (captured.deps[0].analyzer as ConfigurationAnalyzer).analyze(job)).toBe(result);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(job);
  });
});
