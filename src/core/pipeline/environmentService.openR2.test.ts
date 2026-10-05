// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 2 of PR #111 (mutation probes): the open in the worker. A missing environment is never sent (B2-3); only
// a cancel of a question (code `cancelled`) that the window did not abort itself skips the cleanup of this window (B2-5,
// B2-6).
import type { OperationFlow } from './environmentOperations';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../errors';
import { HelperOperationError } from '../helperChannel/helperChannel';
import type { EnvironmentServiceDeps } from './environmentService';
import { ENV_ID, PID, WINDOW_ID, createHarness, seedEnvironment } from './environmentService.testkit';

function harness(answer: (signal: AbortSignal | undefined) => Promise<unknown>) {
  const sent: string[] = [];
  const h = createHarness({
    monitorSource: () => '0123456789abcdef0123456789abcdef',
    openMonitor: () => ({ images: { prefixes: [], schedule: '7 6 * * *', timeZone: 'UTC' }, listSent: () => {} }),
    flow: (async (op: string, _params: unknown, options: { signal?: AbortSignal }) => (sent.push(op), answer(options.signal))) as OperationFlow,
  });
  return { h, sent };
}

const rejection = (promise: Promise<unknown>) => promise.then((value) => ({ resolved: value }), (error: unknown) => error);
const busyMark = () => ({ operation: 'update' as const, since: new Date().toISOString(), pid: PID, windowId: WINDOW_ID });

describe('the open in the worker (review B, round 2 of PR #111)', () => {
  it('B2-3: an environment that is not in the registry is never sent', async () => {
    const { h, sent } = harness(async () => ({ opened: { environmentId: ENV_ID, containerName: 'c', remoteWorkspaceFolder: '/workspaces/api' } }));
    const error = await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }));
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).toMatchObject({ code: 'startFailed' });
    expect(sent).toEqual([]);
  });

  it('B2-5: a cancel after this window aborted the open is no cancel of a question; this window cleans up', async () => {
    const controller = new AbortController();
    const { h } = harness(async () => {
      controller.abort();
      throw new HelperOperationError('cancelled', 'The operation was cancelled.', false);
    });
    await seedEnvironment(h, { container: 'stopped', extra: { busy: busyMark() } });
    await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress, signal: controller.signal }));
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });

  it('B2-6: another failure of the worker is no cancel; this window cleans up', async () => {
    const { h } = harness(async () => {
      throw new HelperOperationError('failed', 'The open failed.', false);
    });
    await seedEnvironment(h, { container: 'stopped', extra: { busy: busyMark() } });
    const error = await rejection(h.operations.openEnvironmentInWorker(ENV_ID, { progress: h.progress }));
    expect(error).toBeInstanceOf(HelperOperationError);
    expect(error).toMatchObject({ code: 'failed' });
    expect((await h.registry.get(ENV_ID))?.busy).toBeUndefined();
  });
});
