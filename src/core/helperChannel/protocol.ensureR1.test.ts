// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #100 (B, mutation probes): each outcome of monitorEnsure.
import { describe, expect, it } from 'vitest';
import { parseMonitorEnsureValue } from './protocol';

describe('parseMonitorEnsureValue probes (review round 1 of PR #100, B)', () => {
  it('takes each outcome', () => {
    for (const outcome of ['running', 'started', 'created']) expect(parseMonitorEnsureValue({ outcome })).toEqual({ outcome });
  });
});
