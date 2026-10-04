// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #101 (B, mutation probes): a monitor tag has the colon of a repository:tag after its prefix.
import { describe, expect, it } from 'vitest';
import { isMonitorImageTag } from './helperState';

describe('isMonitorImageTag (review round 2 of PR #101, B)', () => {
  it('needs the colon after devenv-monitor', () => {
    expect(isMonitorImageTag('devenv-monitor:0123456789ab')).toBe(true);
    expect(isMonitorImageTag('devenv-monitor-0123456789ab')).toBe(false);
    expect(isMonitorImageTag('devenv-monitor/0123456789ab')).toBe(false);
  });
});
