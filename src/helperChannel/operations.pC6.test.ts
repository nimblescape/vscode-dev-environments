// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup after plan step 11 (PR C6, B11): the answers that every operation of the worker shares (checkedOperation,
// operationFailure, the read of the worker's own helper image), pinned per operation: parameters that its schema refuses,
// a secret that it does not take, and the end of a failure and of a cancel. The texts are those before the cleanup.
import { describe, expect, it } from 'vitest';
import { LOCK_UNAVAILABLE_CODE } from '../core/helperChannel/protocol';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import {
  deleteCheckOperation,
  deleteOperation,
  heartbeatOperation,
  listConfigurationsOperation,
  monitorEnsureOperation,
  openOperation,
  reconcileOperation,
  recordGitStateOperation,
  type OwnHelperOf,
} from './flowOperations';
import { OPERATIONS, probeOperation, sweepOperation } from './operations';
import type { OperationContext, OperationHandler } from './server';
import { contextSecrets } from './operationContext.testkit';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const OWNER = { windowId: 'window-1', pid: 4242 };
const IMAGES = { prefixes: [] as string[], schedule: '7 6 * * *', timeZone: 'UTC' };
const PIPELINE = { environmentId: ID, dockerHost: '', owner: OWNER };

/** Per operation: parameters that its schema takes, and the texts of its `invalid` answers. */
const TABLE: Record<string, { params: unknown; invalid: string; secret: string }> = {
  probe: { params: {}, invalid: 'The probe operation takes no parameters.', secret: 'The probe operation takes no secret.' },
  sweep: { params: {}, invalid: 'The sweep operation takes no parameters.', secret: 'The sweep operation takes no secret.' },
  refresh: { params: { environments: [] }, invalid: 'The parameters of the refresh operation are invalid.', secret: 'The refresh operation takes no secret.' },
  tokenRemove: {
    params: { environmentId: ID, containerName: 'devenv-acme-api-brave-noether' },
    invalid: 'The parameters of the tokenRemove operation are invalid.',
    secret: 'The tokenRemove operation takes no secret.',
  },
  stop: {
    params: { environmentId: ID, containerName: 'devenv-acme-api-brave-noether', folder: '/workspaces/api', waitSeconds: 10 },
    invalid: 'The parameters of the stop operation are invalid.',
    secret: 'The stop operation takes no secret.',
  },
  listConfigurations: { params: PIPELINE, invalid: 'The parameters of the listConfigurations operation are invalid.', secret: 'The listConfigurations operation takes no secret.' },
  delete: {
    params: { ...PIPELINE, additionalVolumesToRemove: [], monitorSource: SOURCE },
    invalid: 'The parameters of the delete operation are invalid.',
    secret: 'The delete operation takes no secret.',
  },
  deleteCheck: {
    params: { ...PIPELINE, repository: 'Acme/API', otherWindow: true },
    invalid: 'The parameters of the deleteCheck operation are invalid.',
    secret: 'The deleteCheck operation takes no secret.',
  },
  windowState: {
    params: { environmentId: ID, containerName: 'devenv-acme-api-brave-noether', checks: 'on' },
    invalid: 'The parameters of the windowState operation are invalid.',
    secret: 'The windowState operation takes no secret.',
  },
  reconcile: { params: { dockerHost: '', owner: OWNER }, invalid: 'The parameters of the reconcile operation are invalid.', secret: 'The reconcile operation takes no secret.' },
  heartbeat: {
    params: { heartbeat: { source: SOURCE, limitSeconds: 600, environments: [{ id: ID, keepRunning: false, seq: 1 }] } },
    invalid: 'The parameters of the heartbeat operation are invalid.',
    secret: 'The heartbeat operation takes no secret.',
  },
  recordGitState: { params: PIPELINE, invalid: 'The parameters of the recordGitState operation are invalid.', secret: 'The recordGitState operation takes no secret.' },
  monitorEnsure: { params: { images: IMAGES }, invalid: 'The parameters of the monitorEnsure operation are invalid.', secret: 'The monitorEnsure operation takes no secret.' },
  open: {
    params: {
      ...PIPELINE,
      monitorSource: SOURCE,
      settings: { updateImagesOnConnect: true, hostAccessChecks: 'on', waitingTimeSeconds: 12, stopOnClose: false, respectShutdownActionNone: true },
      images: IMAGES,
      repository: 'acme/api',
    },
    invalid: 'The parameters of the open operation are invalid.',
    secret: 'The open operation takes no secret: it asks for the ones it needs.',
  },
};

function contextOf(secrets: Record<string, string> = {}, aborted = false): { context: OperationContext; progress: string[] } {
  const controller = new AbortController();
  if (aborted) controller.abort();
  const progress: string[] = [];
  const context: OperationContext = { signal: controller.signal, ...contextSecrets(secrets), progress: (step) => progress.push(step), log: () => {}, output: () => {} };
  return { context, progress };
}

describe('the shared start of every operation (cleanup PR C6, B11)', () => {
  it('the table names every operation of the worker', () => {
    expect(Object.keys(TABLE).sort()).toEqual(Object.keys(OPERATIONS).sort());
  });

  for (const [name, row] of Object.entries(TABLE)) {
    it(`${name}: refuses parameters outside its schema, and a secret, before it does anything`, async () => {
      const operation = OPERATIONS[name]!;
      const refused = contextOf();
      await expect(operation({ unknown: 1 }, refused.context)).rejects.toMatchObject({ name: 'OperationError', code: 'invalid', message: row.invalid });
      await expect(operation([1], refused.context)).rejects.toMatchObject({ code: 'invalid', message: row.invalid });
      const secret = contextOf({ token: 'ghs_secretvalue' });
      await expect(operation(row.params, secret.context)).rejects.toMatchObject({ name: 'OperationError', code: 'invalid', message: row.secret });
      expect([...refused.progress, ...secret.progress]).toEqual([]);
    });
  }
});

describe('the end of a failure and of a cancel (cleanup PR C6, B11)', () => {
  const failing: OwnHelperOf = async () => Promise.reject(new Error('no inspect'));
  const openBatch = async () => Promise.reject(new Error('no batch in this test'));
  const engineOf = () => unusedEngine();
  const pipeline: Record<string, OperationHandler> = {
    listConfigurations: listConfigurationsOperation(engineOf, failing, openBatch),
    delete: deleteOperation(engineOf, failing, openBatch),
    deleteCheck: deleteCheckOperation(engineOf, failing, openBatch),
    reconcile: reconcileOperation(engineOf, failing, openBatch),
    recordGitState: recordGitStateOperation(engineOf, failing, openBatch),
    open: openOperation(engineOf, failing, openBatch, () => ''),
  };

  for (const [name, operation] of Object.entries(pipeline)) {
    it(`${name}: a helper image that cannot be read is environmentLockUnavailable; after a cancel, cancelled`, async () => {
      await expect(operation(TABLE[name]!.params, contextOf().context)).rejects.toMatchObject({
        code: LOCK_UNAVAILABLE_CODE,
        message: 'The helper image of the worker cannot be read: no inspect',
      });
      await expect(operation(TABLE[name]!.params, contextOf({}, true).context)).rejects.toMatchObject({ code: 'cancelled', message: 'The operation was cancelled.' });
    });
  }

  it('monitorEnsure: a failure is failed with its message; after a cancel, cancelled with the name of the operation', async () => {
    const operation = monitorEnsureOperation(engineOf, failing, () => '');
    await expect(operation(TABLE.monitorEnsure!.params, contextOf().context)).rejects.toMatchObject({ code: 'failed', message: 'no inspect' });
    await expect(operation(TABLE.monitorEnsure!.params, contextOf({}, true).context)).rejects.toMatchObject({ code: 'cancelled', message: 'The monitorEnsure operation was cancelled.' });
  });

  it('sweep: a failure is failed with its message; after a cancel, cancelled with the name of the operation', async () => {
    const operation = sweepOperation(engineOf);
    await expect(operation({}, contextOf().context)).rejects.toMatchObject({ code: 'failed', message: 'The fake engine of this test does not serve pruneContainers.' });
    await expect(operation({}, contextOf({}, true).context)).rejects.toMatchObject({ code: 'cancelled', message: 'The sweep operation was cancelled.' });
  });

  it('probe: a version that cannot be read is its answer; after a cancel, cancelled with the name of the operation', async () => {
    const operation = probeOperation(engineOf);
    expect(await operation({}, contextOf().context)).toEqual({ detail: 'The fake engine of this test does not serve version.' });
    await expect(operation({}, contextOf({}, true).context)).rejects.toMatchObject({ code: 'cancelled', message: 'The probe operation was cancelled.' });
  });

  it('heartbeat: after a cancel, cancelled with the name of the operation', async () => {
    const operation = heartbeatOperation(engineOf);
    await expect(operation(TABLE.heartbeat!.params, contextOf({}, true).context)).rejects.toMatchObject({ code: 'cancelled', message: 'The heartbeat operation was cancelled.' });
  });
});
