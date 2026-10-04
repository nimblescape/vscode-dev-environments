// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 1 of plan step 11D1 (mutation probes): the requests that the monitor operations may send.
import { describe, expect, it } from 'vitest';
import { OP_HEARTBEAT, OP_MONITOR_SETTINGS, OP_RECORD_GIT_STATE } from '../helperChannel/protocol';
import { FLOW_REQUESTS } from './hostSide';

describe('FLOW_REQUESTS of the monitor operations (review B-R1 probes, plan step 11D1)', () => {
  it('heartbeat and monitorSettings send nothing; recordGitState only reads and records its environment (HS3, HS4, HS5)', () => {
    expect(FLOW_REQUESTS[OP_HEARTBEAT] ?? []).toEqual([]);
    expect(FLOW_REQUESTS[OP_MONITOR_SETTINGS] ?? []).toEqual([]);
    expect([...FLOW_REQUESTS[OP_RECORD_GIT_STATE]].sort()).toEqual(['record get', 'record recordGitSummary']);
  });
});
