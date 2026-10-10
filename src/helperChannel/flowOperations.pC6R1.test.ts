// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup PR #142 (B11): the end of a failure after a cancel (operationFailure, cancelledIfAborted) of
// each operation that names itself in its cancel, as before the cleanup: `cancelled` with "The <name> operation was
// cancelled.", and without a cancel `failed` with the message of the error.
import { describe, expect, it } from 'vitest';
import type { FlockProcess } from '../core/helperChannel/lockFile';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { OwnHelper } from '../core/worker/ownHelper';
import { reconcileOperation, stopOperation, windowStateOperation } from './flowOperations';
import type { LockDeps } from './lock';
import type { OperationContext } from './server';
import { contextSecrets } from './operationContext.testkit';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = 'devenv-acme-api-brave-noether';
const OWNER = { windowId: 'window-1', pid: 4242 };
const OWN: OwnHelper = { image: { tag: 'devenv-helper:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const noBatch = async () => Promise.reject(new Error('no batch helper in this test'));

function contextOf(aborted = false): { context: OperationContext; controller: AbortController } {
  const controller = new AbortController();
  if (aborted) controller.abort();
  const context: OperationContext = { signal: controller.signal, ...contextSecrets({}), progress: () => {}, log: () => {}, output: () => {} };
  return { context, controller };
}

/** A lock that is taken at once (flock exits 0). */
const freeLock: LockDeps = {
  stateDir: '/state',
  openLockFile: () => 42,
  closeFile: () => {},
  startFlock: (): FlockProcess => ({ exited: Promise.resolve({ exitCode: 0 }), kill: () => {} }),
};

describe('the end of a failure after a cancel, per operation (review round 1 of cleanup PR #142)', () => {
  it('stop: a failure of the engine is failed; after a cancel, cancelled with the name of the operation', async () => {
    const params = { environmentId: ID, containerName: NAME, folder: '/workspaces/api', waitSeconds: 10 };
    const failing = (abort?: AbortController): DockerEngine => ({
      ...unusedEngine(),
      containers: async () => {
        abort?.abort();
        throw new Error('the engine is gone');
      },
    });
    const plain = contextOf();
    await expect(stopOperation(() => failing(), freeLock)(params, plain.context)).rejects.toMatchObject({ code: 'failed', message: 'the engine is gone' });
    const cancelled = contextOf();
    await expect(stopOperation(() => failing(cancelled.controller), freeLock)(params, cancelled.context)).rejects.toMatchObject({
      code: 'cancelled',
      message: 'The stop operation was cancelled.',
    });
  });

  it('windowState: after a cancel, cancelled with the name of the operation', async () => {
    const params = { environmentId: ID, containerName: NAME, checks: 'on' };
    await expect(windowStateOperation(() => unusedEngine())(params, contextOf(true).context)).rejects.toMatchObject({
      code: 'cancelled',
      message: 'The windowState operation was cancelled.',
    });
  });

  it('reconcile: a failure of the engine is failed; after a cancel, cancelled with the name of the operation', async () => {
    const params = { dockerHost: '', owner: OWNER };
    const failing = (abort?: AbortController): DockerEngine => ({
      ...unusedEngine(),
      version: async () => ({ apiVersion: '1.48', version: '29.0.0' }),
      volumeNames: async () => {
        abort?.abort();
        throw new Error('the engine is gone');
      },
    });
    await expect(reconcileOperation(() => failing(), async () => OWN, noBatch)(params, contextOf().context)).rejects.toMatchObject({ code: 'failed', message: 'the engine is gone' });
    const cancelled = contextOf();
    await expect(reconcileOperation(() => failing(cancelled.controller), async () => OWN, noBatch)(params, cancelled.context)).rejects.toMatchObject({
      code: 'cancelled',
      message: 'The reconcile operation was cancelled.',
    });
  });
});
