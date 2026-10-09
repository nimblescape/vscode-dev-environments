// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// PR H, a follow-up of plan step 11I (decision of 2026-10-09, docs/plan-remote-worker.md section 2): the operation
// `open` carries the helper image maintenance for the preparation of its worker (HelperMaintenance, with the setting
// updateImagesOnConnect), and shows a build there as the detail of its progress until that preparation ended; no other
// operation of the window carries one.
import { describe, expect, it } from 'vitest';
import type { HelperBuildKind } from '../helper/helperImage';
import type { HelperMaintenance } from '../helper/helperImages';
import { OP_OPEN } from '../helperChannel/protocol';
import type { OperationFlow } from './environmentOperations';
import { PipelineTexts } from './operationBase';
import { ENV_ID, REPO, createHarness, seedEnvironment } from './environmentService.testkit';

const OPENED = { environmentId: ENV_ID, containerName: 'devenv-acme-api-c', remoteWorkspaceFolder: '/workspaces/api' };
const IMAGES = { prefixes: ['ghcr.io/acme/base'], schedule: '7 6 * * *', timeZone: 'UTC' };

type FlowOptions = Parameters<OperationFlow>[2];

/**
 * The window's operations with a worker that records each flow and answers the open (the other flows fail after they
 * were recorded). `build`: the kind of a build that the preparation of the open's worker reports.
 */
function harness(build?: HelperBuildKind) {
  const flows: { op: string; maintenance: HelperMaintenance | undefined }[] = [];
  const h = createHarness({
    monitorSource: () => '0123456789abcdef0123456789abcdef',
    openMonitor: () => ({ images: IMAGES, listSent: () => {} }),
    flow: async (op: string, _params: unknown, options: FlowOptions) => {
      flows.push({ op, maintenance: options.helperMaintenance });
      if (op !== OP_OPEN) throw new Error(`no answer for ${op} here`);
      // As HelperChannels prepares the worker of the open before it sends the flow (heartbeatHelperImage).
      if (build !== undefined) {
        options.helperMaintenance?.onBuild?.(build);
        options.helperMaintenance?.onBuildEnd?.();
      }
      options.onProgress?.('starting');
      return { opened: OPENED };
    },
  });
  return { h, flows };
}

describe('the helper image maintenance of the open (PR H, decision of 2026-10-09)', () => {
  it('the open carries it with its setting updateImagesOnConnect; no other operation carries one', async () => {
    const { h, flows } = harness();
    try {
      const environment = await seedEnvironment(h, { container: 'running' });
      await h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress });
      h.settings = { ...h.settings, updateImagesOnConnect: false };
      await h.operations.openInWorker({ repository: REPO, defaultBranch: null, configPaths: [], trusted: true }, { progress: h.progress });
      expect(flows.map((flow) => [flow.op, flow.maintenance?.checkBaseImage])).toEqual([
        [OP_OPEN, true],
        [OP_OPEN, false],
      ]);
      // The other operations of the window, each of which sends its flow (and fails here after it was recorded).
      const settle = (promise: Promise<unknown>): Promise<unknown> => promise.catch(() => undefined);
      await settle(h.operations.stop(ENV_ID));
      await settle(h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: REPO, otherWindow: false }));
      await settle(h.operations.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }));
      await settle(h.operations.listConfigurationsInWorker(ENV_ID, { progress: h.progress }));
      await settle(h.operations.windowStateInWorker(environment, environment.containerName));
      await settle(h.operations.windowStateInWorker(environment, environment.containerName, { signal: new AbortController().signal }));
      await settle(h.operations.reconcileInWorker({ passive: true }));
      await settle(h.operations.reconcileInWorker({ passive: false }));
      const others = flows.slice(2);
      expect(others.map((flow) => flow.op)).toEqual(['stop', 'deleteCheck', 'delete', 'listConfigurations', 'windowState', 'windowState', 'reconcile', 'reconcile']);
      expect(others.filter((flow) => flow.maintenance !== undefined)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a rebuild in the preparation of its worker shows "being updated" until the preparation ended', async () => {
    const { h } = harness('refresh');
    try {
      await seedEnvironment(h, { container: 'running' });
      await h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress });
      expect(h.progress.details).toEqual([PipelineTexts.updatingHelper, '']);
      expect(h.progress.steps).toEqual(['starting']);
    } finally {
      h.cleanup();
    }
  });

  it('the build of a missing tag in the preparation of its worker shows "being prepared" until the preparation ended', async () => {
    const { h } = harness('create');
    try {
      await seedEnvironment(h, { container: 'running' });
      await h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress });
      expect(h.progress.details).toEqual([PipelineTexts.preparingHelper, '']);
    } finally {
      h.cleanup();
    }
  });
});
