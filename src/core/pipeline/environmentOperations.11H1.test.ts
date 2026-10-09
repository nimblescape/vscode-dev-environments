// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decision of 2026-10-03, "Shared VS Code server store"): the open of a window carries the VS Code server
// of the window (EnvironmentOperationsDeps.vscodeServerOfWindow, from its product.json) when the build qualifies; without
// one the parameters of the open are as before.
import { describe, expect, it } from 'vitest';
import { OP_OPEN, type OpenParams, type VscodeServerRef } from '../helperChannel/protocol';
import type { OperationFlow } from './environmentOperations';
import { ENV_ID, REPO, createHarness, seedEnvironment } from './environmentService.testkit';

const OPENED = { environmentId: ENV_ID, containerName: 'devenv-acme-api-c', remoteWorkspaceFolder: '/workspaces/api' };
const IMAGES = { prefixes: [], schedule: '7 6 * * *', timeZone: 'UTC' };
const SERVER: VscodeServerRef = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' };

function harness(server: (() => Promise<VscodeServerRef | undefined>) | undefined) {
  const sent: OpenParams[] = [];
  const h = createHarness({
    monitorSource: () => '0123456789abcdef0123456789abcdef',
    openMonitor: () => ({ images: IMAGES, listSent: () => {} }),
    ...(server !== undefined ? { vscodeServerOfWindow: server } : {}),
    flow: (async (op, params) => {
      if (op !== OP_OPEN) throw new Error(`no answer for ${op} here`);
      sent.push(params as OpenParams);
      return { opened: OPENED };
    }) satisfies OperationFlow,
  });
  return { h, sent };
}

describe('the VS Code server of an open (plan step 11H1)', () => {
  it('is sent with the open of an environment and of a repository', async () => {
    const { h, sent } = harness(async () => SERVER);
    try {
      await seedEnvironment(h, { container: 'running' });
      await h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress });
      await h.operations.openInWorker({ repository: REPO, defaultBranch: null, configPaths: [], trusted: true }, { progress: h.progress });
      expect(sent.map((params) => params.vscodeServer)).toEqual([SERVER, SERVER]);
    } finally {
      h.cleanup();
    }
  });

  it('is left out when the window has none, and without the dependency', async () => {
    for (const server of [async () => undefined, undefined]) {
      const { h, sent } = harness(server);
      try {
        await seedEnvironment(h, { container: 'running' });
        await h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress });
        expect(sent).toHaveLength(1);
        expect(sent[0]).not.toHaveProperty('vscodeServer');
      } finally {
        h.cleanup();
      }
    }
  });
});
