// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H3 (reviewer B, mutation testing): probe of the operation `open` of the worker that no test held:
// the user's default extensions of the parameters (OpenParams.defaultExtensions) reach the pipeline of the open
// (workerServices), which records them in the shared extension cache. The services of the worker are a fake here
// (vi.mock); the rest is the real operation.
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
          openEnvironment: async (environmentId: string) => ({ environment: { id: environmentId }, containerName: 'devenv-api-1', remoteWorkspaceFolder: '/workspaces/api' }),
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

describe('the operation open with the user\'s default extensions, probe (review round 1 of 11H3, reviewer B)', () => {
  const operation = openOperation(
    () => unusedEngine(),
    async () => OWN,
    async () => {
      throw new Error('No batch helper in this test.');
    },
    () => 'monitor script',
  );

  it('hands the default extensions of the parameters to the pipeline', async () => {
    seen.deps.length = 0;
    await operation({ ...PARAMS, vscodeServer: SERVER, defaultExtensions: ['a.b', 'c.d@1.2.3'] }, context());
    expect(seen.deps).toHaveLength(1);
    expect(seen.deps[0].defaultExtensions).toEqual(['a.b', 'c.d@1.2.3']);
  });

  it('without defaults in the parameters, none reach the pipeline', async () => {
    seen.deps.length = 0;
    await operation({ ...PARAMS, vscodeServer: SERVER }, context());
    expect(seen.deps[0]).not.toHaveProperty('defaultExtensions');
  });
});
