// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #100 (B, mutation probes): the ensure of the monitor asks nothing of this computer.
import { describe, expect, it } from 'vitest';
import { OP_MONITOR_ENSURE } from '../helperChannel/protocol';
import { FLOW_REQUESTS } from './hostSide';

describe('FLOW_REQUESTS of monitorEnsure (review round 1 of PR #100, B)', () => {
  it('is an empty list', () => {
    expect(Object.hasOwn(FLOW_REQUESTS, OP_MONITOR_ENSURE)).toBe(true);
    expect(FLOW_REQUESTS[OP_MONITOR_ENSURE]).toEqual([]);
  });
});
