// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #100 (B, mutation probes): the time limit of the flow of monitorEnsure.
import { describe, expect, it } from 'vitest';
import { MONITOR_ENSURE_FLOW_TIMEOUT_MS } from './workerMonitor';

describe('MONITOR_ENSURE_FLOW_TIMEOUT_MS (review round 1 of PR #100, B)', () => {
  it('is five minutes', () => {
    expect(MONITOR_ENSURE_FLOW_TIMEOUT_MS).toBe(5 * 60_000);
  });
});
