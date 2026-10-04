// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #101 (B, mutation probes): a monitor tag has exactly 12 lowercase hex characters.
import { describe, expect, it } from 'vitest';
import { isMonitorImageTag, monitorImageTag } from './helperState';

describe('isMonitorImageTag (review round 1 of PR #101, B)', () => {
  it('accepts only lowercase hex characters after the prefix', () => {
    expect(isMonitorImageTag('devenv-monitor:0123456789ab')).toBe(true);
    expect(isMonitorImageTag('devenv-monitor:0123456789ag')).toBe(false);
    expect(isMonitorImageTag('devenv-monitor:zzzzzzzzzzzz')).toBe(false);
    expect(isMonitorImageTag('devenv-monitor:0123456789AB')).toBe(false);
    expect(monitorImageTag('devenv-helper:zzzzzzzzzzzz')).toBeUndefined();
  });
});
