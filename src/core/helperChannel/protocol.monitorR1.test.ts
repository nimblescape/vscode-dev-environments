// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 1 of plan step 11D1 (mutation probes): the strict checks of the monitor operations.
import { describe, expect, it } from 'vitest';
import { parseHeartbeatValue, parseMonitorSettingsParams, parseRecordGitStateValue } from './protocol';

describe('the checks of the monitor operations (review B-R1 probes, plan step 11D1)', () => {
  it('a failed heartbeat: ok false, the exact keys, a string detail (PR6, PR7, PR11)', () => {
    for (const odd of [
      { ok: true, missing: false, detail: 'x' },
      { ok: 'no', missing: false, detail: 'x' },
      { ok: false, missing: false, detail: 'x', extra: 1 },
      { ok: false, missing: false, detail: 5 },
      { ok: false, missing: false, detail: ['x'] },
    ]) {
      expect(parseHeartbeatValue(odd), JSON.stringify(odd)).toBeUndefined();
    }
  });

  it('the image settings are passed on as the monitor reads them (duplicate prefixes once) (PR20)', () => {
    const settings = { prefixes: ['ghcr.io/acme/base', 'ghcr.io/acme/base'], schedule: '7 6 * * *', timeZone: 'UTC' };
    expect(parseMonitorSettingsParams({ settings })).toEqual({ settings: { ...settings, prefixes: ['ghcr.io/acme/base'] } });
  });

  it('recordGitState: an answer with more keys does not fit (PR23)', () => {
    expect(parseRecordGitStateValue({ recorded: true, extra: 1 })).toBeUndefined();
  });
});
