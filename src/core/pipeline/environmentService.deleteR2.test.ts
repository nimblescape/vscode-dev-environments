// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of 11C2a (B-R2, mutant C3): the clear of this window's busy mark after a flow that ended
// without an answer is quiet: a failing clear is logged and never replaces the failure of the flow.
import { describe, expect, it, vi } from 'vitest';
import { HelperOperationError } from '../helperChannel/helperChannel';
import { LOCK_BUSY_CODE } from '../helperChannel/protocol';
import { PipelineTexts } from './environmentService';
import { ENV_ID, REPO, createHarness, seedEnvironment } from './environmentService.testkit';

describe('the clear after a flow without an answer (B-R2 C3)', () => {
  it('a clear that fails is logged; the Delete fails with the failure of the flow', async () => {
    const busyMarks = { mark: vi.fn(async () => ({})), clear: vi.fn(async () => { throw new Error('registry locked'); }) };
    const h = createHarness({
      busyMarks: busyMarks as never,
      monitorSource: () => '0123456789abcdef0123456789abcdef',
      flow: async () => { throw new HelperOperationError(LOCK_BUSY_CODE, 'held', false); },
    });
    await seedEnvironment(h, { container: 'stopped' });
    const error = await h.service.deleteInWorker(ENV_ID, { progress: h.progress, additionalVolumesToRemove: [] }).then(() => undefined, (e: unknown) => e);
    expect(busyMarks.clear).toHaveBeenCalledWith(ENV_ID);
    expect(error).toMatchObject({ code: 'startFailed', message: PipelineTexts.environmentLockBusy(REPO) });
    expect(h.logger.warnings.join('\n')).toContain('registry locked');
  });
});
