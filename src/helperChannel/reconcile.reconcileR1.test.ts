// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11C3 (reviewer B, mutation probes): reconcileOperation's refusals and its errors.
import { describe, expect, it } from 'vitest';
import { LOCK_UNAVAILABLE_CODE } from '../core/helperChannel/protocol';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { OwnHelper } from '../core/worker/ownHelper';
import { reconcileOperation } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const OWN: OwnHelper = { image: { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const PARAMS = { dockerHost: '', owner: { windowId: 'window-1', pid: 4242 } };

function run(options: { secrets?: Record<string, string>; ownHelper?: (abort: () => void) => Promise<OwnHelper>; volumeNames?: (abort: () => void) => Promise<string[]> } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets(options.secrets ?? {}),
    progress: () => {},
    log: () => {},
    output: () => {},
    docker: async () => {
      throw new Error('no Docker CLI');
    },
  };
  const engine: DockerEngine = {
    ...unusedEngine(),
    version: async () => ({ apiVersion: '1.48', version: '29.0.0' }),
    volumeNames: async () => (options.volumeNames ? options.volumeNames(abort) : []),
    containers: async () => [],
  };
  const operation = reconcileOperation(
    () => engine,
    () => (options.ownHelper ? options.ownHelper(abort) : Promise.resolve(OWN)),
    async () => {
      throw new Error('no batch helper');
    },
  );
  return operation(PARAMS, context);
}

describe('reconcileOperation (review round 1 of 11C3, reviewer B)', () => {
  it('takes no secret', async () => {
    await expect(run({ secrets: { token: 'gho_x' } })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a helper image that cannot be read is lock-unavailable; cancelled while the operation is aborted', async () => {
    await expect(
      run({
        ownHelper: async () => {
          throw new Error('no image');
        },
      }),
    ).rejects.toMatchObject({ code: LOCK_UNAVAILABLE_CODE, message: expect.stringContaining('no image') });
    await expect(
      run({
        ownHelper: async (abort) => {
          abort();
          throw new Error('aborted');
        },
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('a failed rebuild fails with its message; cancelled while the operation is aborted', async () => {
    await expect(
      run({
        volumeNames: async () => {
          throw new Error('the engine is gone');
        },
      }),
    ).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('the engine is gone') });
    await expect(
      run({
        volumeNames: async (abort) => {
          abort();
          throw new Error('aborted');
        },
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});
