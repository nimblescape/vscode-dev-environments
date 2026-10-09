// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11H1 (reviewer B, mutation testing): probes of the operation `open` of the worker that no
// test held: the VS Code server of the parameters reaches the pipeline of the open (workerServices), and what the link
// did comes back in the value of the open. The services of the worker are a fake here (vi.mock); the rest is the real
// operation.
import { describe, expect, it, vi } from 'vitest';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { OwnHelper } from '../core/worker/ownHelper';
import { openOperation } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const seen = vi.hoisted(() => ({ deps: [] as Array<Record<string, unknown>> }));
vi.mock('../core/worker/workerServices', async (importOriginal) => {
  const original = await importOriginal<typeof import('../core/worker/workerServices')>();
  return {
    ...original,
    workerServices: (deps: Record<string, unknown>) => {
      seen.deps.push(deps);
      return {
        service: {
          openEnvironment: async (environmentId: string) => ({
            environment: { id: environmentId },
            containerName: 'devenv-api-1',
            remoteWorkspaceFolder: '/workspaces/api',
            ...(deps.vscodeServer !== undefined ? { vscodeServer: { outcome: 'linked' } } : {}),
          }),
        },
      };
    },
  };
});

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' };
const OWN: OwnHelper = { image: { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock', vscodeStore: 'devenv-vscode' };
const PARAMS = {
  dockerHost: '',
  owner: { windowId: 'window-1', pid: 4242 },
  monitorSource: '0123456789abcdef0123456789abcdef',
  settings: { updateImagesOnConnect: true, hostAccessChecks: 'on' as const, waitingTimeSeconds: 12, stopOnClose: false, respectShutdownActionNone: true },
  images: { prefixes: [] as string[], schedule: '7 6 * * *', timeZone: 'UTC' },
  repository: 'acme/api',
  environmentId: ID,
};

function context(): OperationContext {
  return {
    signal: new AbortController().signal,
    ...contextSecrets({}, async () => undefined),
    progress: () => undefined,
    log: () => undefined,
    output: () => undefined,
  };
}

describe('the operation open with the shared VS Code server, probes (review round 1 of 11H1, reviewer B)', () => {
  const operation = openOperation(
    () => unusedEngine(),
    async () => OWN,
    async () => {
      throw new Error('No batch helper in this test.');
    },
    () => 'monitor script',
  );

  it('hands the server of the parameters to the pipeline, and returns what the link did', async () => {
    seen.deps.length = 0;
    const value = await operation({ ...PARAMS, vscodeServer: SERVER }, context());
    expect(seen.deps).toHaveLength(1);
    expect(seen.deps[0].vscodeServer).toEqual(SERVER);
    expect(value).toMatchObject({ opened: { environmentId: ID }, vscodeServer: { outcome: 'linked' } });
  });

  it('without a server in the parameters, none reaches the pipeline and the value has none', async () => {
    seen.deps.length = 0;
    const value = await operation(PARAMS, context());
    expect(seen.deps[0]).not.toHaveProperty('vscodeServer');
    expect(value).not.toHaveProperty('vscodeServer');
  });
});
