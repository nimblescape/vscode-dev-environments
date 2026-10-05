// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of plan step 11C2b (mutation tests, B-R2): the open questions in the gate of deleteCheckInWorker.
import type { OperationFlow } from './environmentOperations';
import { describe, expect, it } from 'vitest';
import { ENV_ID, createHarness, seedEnvironment } from './environmentService.testkit';
import type { EnvironmentServiceDeps } from './environmentService';

type FlowOptions = Parameters<OperationFlow>[2];
const rejection = (p: Promise<unknown>) => p.then((value) => ({ resolved: value }), (error: unknown) => error);

describe('review round 2 of 11C2b (mutation tests): the open questions of the check of Delete', () => {
  it('G11b/G11c: a settled question does not block the decision; two asked and one settled does', async () => {
    let answer: (options: FlowOptions) => unknown = () => ({ decision: 'cancel' });
    const h = createHarness({ flow: async (_op, _params, options) => answer(options) });
    await seedEnvironment(h, { container: 'stopped' });
    const check = () => rejection(h.operations.deleteCheckInWorker(ENV_ID, { progress: h.progress, repository: 'acme/api', otherWindow: false }));
    answer = (options) => {
      options.onQuestion?.('asked');
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onQuestion?.('settled');
      return { decision: 'delete', additionalVolumesToRemove: [] };
    };
    expect(await check()).toEqual({ resolved: { decision: 'delete', additionalVolumesToRemove: [] } });
    answer = (options) => {
      options.onQuestion?.('asked');
      options.onQuestion?.('asked');
      options.onAnswer?.('confirmDelete', ['acme/api', {}], 'delete');
      options.onQuestion?.('settled');
      return { decision: 'delete', additionalVolumesToRemove: [] };
    };
    expect(((await check()) as Error).message).toContain('a decision that the user did not give');
  });
});
