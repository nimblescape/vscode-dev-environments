// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #111 (A): a question that the user cancels in the worker is a cancel (A-M1); an environment of
// another account is never sent (A-L1); the answer names the folder that the open recorded (A-I1).
import type { OperationFlow } from './environmentOperations';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { HelperOperationError } from '../helperChannel/helperChannel';
import type { BusyMark } from '../types';
import type { EnvironmentServiceDeps } from './environmentService';
import { ENV_ID, OTHER_ACCOUNT, PID, WINDOW_ID, createHarness, seedEnvironment } from './environmentService.testkit';

const OPENED = { environmentId: ENV_ID, containerName: 'devenv-acme-api-c', remoteWorkspaceFolder: '/workspaces/api' };

function harness(answer: () => Promise<unknown>) {
  const sent: string[] = [];
  const h = createHarness({
    monitorSource: () => '0123456789abcdef0123456789abcdef',
    openMonitor: () => ({ images: { prefixes: [], schedule: '7 6 * * *', timeZone: 'UTC' }, listSent: () => {} }),
    flow: (async (op: string) => (sent.push(op), answer())) as OperationFlow,
  });
  return { h, sent };
}

const rejection = (promise: Promise<unknown>) => promise.then((value) => ({ resolved: value }), (error: unknown) => error);

describe('the open in the worker (review round 1 of PR #111)', () => {
  it('A-M1: a question that the user cancelled in the worker is a cancel; the worker cleaned up, nothing is cleaned here', async () => {
    const { h } = harness(async () => {
      throw new HelperOperationError('cancelled', 'The operation was cancelled.', false);
    });
    const mark: BusyMark = { operation: 'update', since: new Date().toISOString(), pid: PID, windowId: WINDOW_ID };
    await seedEnvironment(h, { container: 'stopped', extra: { busy: mark } });
    const error = await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }));
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).toMatchObject({ code: 'cancelled' });
    expect((await h.registry.get(ENV_ID))?.busy).toEqual(mark);
  });

  it('A-M1: a time limit of the worker is no cancel of the user; this window cleans up', async () => {
    const { h } = harness(async () => {
      throw new HelperOperationError('cancelled', 'The operation ended at its time limit.', true);
    });
    await seedEnvironment(h, { container: 'stopped', extra: { busy: { operation: 'update', since: new Date().toISOString(), pid: PID, windowId: WINDOW_ID } } });
    const error = await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }));
    expect(error).toBeInstanceOf(HelperOperationError);
    expect(error).not.toBeInstanceOf(UserFacingError);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('A-L1: an environment of another account is refused before anything is sent', async () => {
    const { h, sent } = harness(async () => ({ opened: OPENED }));
    await seedEnvironment(h, { container: 'stopped', owner: OTHER_ACCOUNT });
    expect(await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }))).toMatchObject({ code: 'otherAccount' });
    expect(sent).toEqual([]);
  });

  it('A-I1: an answer whose folder is not the one that the open recorded is refused', async () => {
    const { h } = harness(async () => ({ opened: { ...OPENED, remoteWorkspaceFolder: '/workspaces/other' } }));
    await seedEnvironment(h, { container: 'stopped' });
    expect(((await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }))) as Error).message).toContain('not the one of the open');
  });

  // Review round 2 of PR #111 (A2-M1): a worker that ended the operation itself (its shutdown) is no cancel of the user.
  it('A2-M1: a cancel of the worker itself is no cancel of the user; this window cleans up', async () => {
    const { h } = harness(async () => {
      throw new HelperOperationError('cancelled', 'The worker ends.', false, true);
    });
    await seedEnvironment(h, { container: 'stopped', extra: { busy: { operation: 'update', since: new Date().toISOString(), pid: PID, windowId: WINDOW_ID } } });
    const error = await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }));
    expect(error).not.toBeInstanceOf(UserFacingError);
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });
});
