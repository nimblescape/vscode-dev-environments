// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11C2a (mutation tests, B-R1): the strictness of the answer of delete and of the busy mark.
import { describe, expect, it } from 'vitest';
import { parseDeleteValue } from './protocol';
import { parseBusyMarkAnswer } from '../worker/workerHostSide';

describe('the answers of delete and of the busy mark: review round 1 of 11C2a (B-R1 P10, W7–W9)', () => {
  it('a refusal with another key is invalid (P10)', () => {
    expect(parseDeleteValue({ refused: { code: 'otherAccount', message: 'x' } })).toBeDefined();
    expect(parseDeleteValue({ refused: { code: 'otherAccount', message: 'x' }, deleted: true })).toBeUndefined();
  });
  it('a conflict that is not a busy mark is a failure of the request (W7, W8, W9)', () => {
    const mark = { operation: 'update', since: '2026-10-04T10:00:00.000Z', pid: 7, windowId: 'w2' };
    expect(parseBusyMarkAnswer({ conflict: mark }, 'e1')).toEqual({ conflict: mark });
    for (const odd of [{ ...mark, since: 1 }, { ...mark, pid: 1.5 }, { ...mark, windowId: 2 }]) {
      expect(() => parseBusyMarkAnswer({ conflict: odd }, 'e1'), JSON.stringify(odd)).toThrow('invalid value');
    }
  });
});
