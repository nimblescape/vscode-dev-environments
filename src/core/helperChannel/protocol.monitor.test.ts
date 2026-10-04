// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D1: the strict checks of the operations `heartbeat`, `monitorSettings` and `recordGitState`.
import { describe, expect, it } from 'vitest';
import {
  MAX_MONITOR_DETAIL_LENGTH,
  parseHeartbeatParams,
  parseHeartbeatValue,
  parseMonitorSettingsParams,
  parseMonitorSettingsValue,
  parseRecordGitStateParams,
  parseRecordGitStateValue,
} from './protocol';

const SOURCE = '0123456789abcdef0123456789abcdef';
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const HEARTBEAT = { source: SOURCE, limitSeconds: 600, environments: [{ id: ID, keepRunning: false, seq: 1 }] };
const SETTINGS = { prefixes: ['ghcr.io/acme/base'], schedule: '7 6 * * *', timeZone: 'Europe/Vienna' };

describe('the operations of the Session Monitor in the worker (plan step 11D1)', () => {
  it('heartbeat: the heartbeat as the monitor takes it, and nothing else', () => {
    expect(parseHeartbeatParams({ heartbeat: HEARTBEAT })).toEqual({ heartbeat: HEARTBEAT });
    expect(parseHeartbeatParams({ heartbeat: { ...HEARTBEAT, release: true } })).toEqual({ heartbeat: { ...HEARTBEAT, release: true } });
    // The limit is clamped as the monitor clamps it.
    expect(parseHeartbeatParams({ heartbeat: { ...HEARTBEAT, limitSeconds: 10 ** 9 } })?.heartbeat.limitSeconds).toBe(86_400);
    for (const odd of [
      undefined,
      {},
      { heartbeat: HEARTBEAT, extra: 1 },
      { heartbeat: { ...HEARTBEAT, source: '../x' } },
      { heartbeat: { ...HEARTBEAT, release: false } },
      { heartbeat: { ...HEARTBEAT, environments: [{ id: ID, keepRunning: true, seq: 1, clearOnly: true }] } },
      { heartbeat: { ...HEARTBEAT, environments: Array.from({ length: 201 }, () => HEARTBEAT.environments[0]) } },
    ]) {
      expect(parseHeartbeatParams(odd), JSON.stringify(odd)).toBeUndefined();
    }
  });

  it('heartbeat: the answer, ok or a bounded failure', () => {
    expect(parseHeartbeatValue({ ok: true })).toEqual({ ok: true });
    expect(parseHeartbeatValue({ ok: false, missing: true, detail: 'gone' })).toEqual({ ok: false, missing: true, detail: 'gone' });
    expect(parseHeartbeatValue({ ok: false, missing: false, detail: 'x'.repeat(MAX_MONITOR_DETAIL_LENGTH) })).toBeDefined();
    for (const odd of [null, { ok: true, missing: false }, { ok: false, detail: 'x' }, { ok: false, missing: 'no', detail: 'x' }, { ok: false, missing: false, detail: 'x'.repeat(MAX_MONITOR_DETAIL_LENGTH + 1) }, { ok: 'yes' }]) {
      expect(parseHeartbeatValue(odd), JSON.stringify(odd)).toBeUndefined();
    }
  });

  it('monitorSettings: the settings or the list as the monitor reads them, never both', () => {
    expect(parseMonitorSettingsParams({ settings: SETTINGS })).toEqual({ settings: SETTINGS });
    expect(parseMonitorSettingsParams({ repositories: ['ghcr.io/acme/app', 'ghcr.io/acme/app'] })).toEqual({ repositories: ['ghcr.io/acme/app'] });
    for (const odd of [
      {},
      { settings: SETTINGS, repositories: [] },
      { settings: { ...SETTINGS, schedule: 'daily' } },
      { settings: { ...SETTINGS, timeZone: 'Mars/Base' } },
      { settings: { ...SETTINGS, prefixes: ['docker.io/library'] } },
      { repositories: ['not a repository'] },
      { repositories: Array.from({ length: 501 }, (_, i) => `ghcr.io/acme/app${i}`) },
    ]) {
      expect(parseMonitorSettingsParams(odd), JSON.stringify(odd).slice(0, 80)).toBeUndefined();
    }
    expect(parseMonitorSettingsValue({ sent: true })).toEqual({ sent: true });
    expect(parseMonitorSettingsValue({ sent: 'yes' })).toBeUndefined();
    expect(parseMonitorSettingsValue({ sent: true, more: 1 })).toBeUndefined();
  });

  it('recordGitState: the environment, the Docker host and the window; the answer whether it was recorded', () => {
    const params = { environmentId: ID, dockerHost: 'ssh://box', owner: { windowId: 'window-1', pid: 7 } };
    expect(parseRecordGitStateParams(params)).toEqual(params);
    for (const odd of [{ ...params, environmentId: '../x' }, { ...params, extra: 1 }, { ...params, dockerHost: 'a\nb' }, { ...params, owner: { windowId: 'window-1', pid: 0 } }]) {
      expect(parseRecordGitStateParams(odd), JSON.stringify(odd)).toBeUndefined();
    }
    expect(parseRecordGitStateValue({ recorded: false })).toEqual({ recorded: false });
    expect(parseRecordGitStateValue({ recorded: 1 })).toBeUndefined();
  });
});
