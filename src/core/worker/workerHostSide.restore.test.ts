// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C3: the answer of `record restore` as the worker reads it (parseRestoreAnswer).
import { describe, expect, it } from 'vitest';
import { parseRestoreAnswer } from './workerHostSide';

describe('the answer of record restore in the worker (plan step 11C3)', () => {
  it('takes the number of added entries and the volumes left out', () => {
    expect(parseRestoreAnswer({ added: 2, skipped: ['devenv-a'] })).toEqual({ added: 2, skipped: ['devenv-a'] });
    expect(parseRestoreAnswer({ added: 0, skipped: [] })).toEqual({ added: 0, skipped: [] });
  });

  it.each([null, [], { added: -1, skipped: [] }, { added: 1.5, skipped: [] }, { added: '1', skipped: [] }, { added: 1 }, { added: 1, skipped: [1] }])('refuses %j', (value) => {
    expect(() => parseRestoreAnswer(value)).toThrow('invalid value');
  });
});
