// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11C3 (reviewer B, mutation probe): records.restore of the worker checks the answer of the extension.
import { describe, expect, it } from 'vitest';
import { workerHostSide } from './workerHostSide';

describe('records.restore in the worker (review round 1 of 11C3, reviewer B)', () => {
  it('sends the entries as record restore and refuses an invalid answer', async () => {
    const asked: unknown[] = [];
    const ok = workerHostSide(async (request) => (asked.push(request), { added: 1, skipped: ['devenv-x'] }), () => undefined);
    expect(await ok.records.restore([])).toEqual({ added: 1, skipped: ['devenv-x'] });
    expect(asked).toEqual([{ kind: 'record', call: 'restore', args: [[]] }]);
    const odd = workerHostSide(async () => ({ added: '1', skipped: [] }), () => undefined);
    await expect(odd.records.restore([])).rejects.toThrow('invalid value');
  });
});
