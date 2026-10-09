// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, D1 and D2): extension.ts gives the Session Monitor of an engine the schedule of
// its background run (cacheUpdateSchedule) and its mode: permanent on a remote engine (an open whose Docker host is not
// the local one, a repair of a remote target), on a local one only with stopLocalMonitorWhenIdle off. Review round 1 of
// 11H2 (A-L7): the settings come from monitorSettings.ts and are tested by their result (the former checks of the source
// text of extension.ts are replaced); only that extension.ts calls them with the Docker host of the open and the target
// of the repair is still read from its source (extension.ts cannot be loaded without VS Code).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { monitorSettingsOf, type MonitorSettingsDeps } from './monitorSettings';

const deps = (settings: ReturnType<MonitorSettingsDeps['settings']>): MonitorSettingsDeps => ({
  settings: () => settings,
  prefixes: () => ['ghcr.io/acme/'],
  timeZone: () => 'Europe/Vienna',
});

describe('the monitor settings of extension.ts (plan step 11H2; review round 1, A-L7)', () => {
  it('the schedule of cacheUpdateSchedule (default 17), the prefixes and the time zone', () => {
    const settings = monitorSettingsOf(deps({ cacheUpdateSchedule: '7 6 * * *' }));
    expect(settings.forOpen('')).toEqual({ prefixes: ['ghcr.io/acme/'], schedule: '7 6 * * *', timeZone: 'Europe/Vienna', permanent: false });
    expect(monitorSettingsOf(deps({})).forOpen('').schedule).toBe('17');
  });

  it('the mode: a remote engine always permanent (`remote`), a local one only with stopLocalMonitorWhenIdle off', () => {
    for (const stop of [true, false, undefined]) {
      const settings = monitorSettingsOf(deps(stop === undefined ? {} : { stopLocalMonitorWhenIdle: stop }));
      for (const remote of [settings.forOpen('user@host'), settings.forTarget({ kind: 'remote' })]) {
        expect(remote, String(stop)).toMatchObject({ permanent: true, remote: true });
      }
      // A target of an unsupported kind is no remote engine.
      for (const local of [settings.forOpen(''), settings.forTarget({ kind: 'local' }), settings.forTarget({ kind: 'unsupported' })]) {
        expect(local.permanent, String(stop)).toBe(stop === false);
        expect(local, String(stop)).not.toHaveProperty('remote');
      }
    }
  });

  it('extension.ts gives an open the settings of its Docker host and a repair those of its target', () => {
    const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
    expect(source).toContain('openMonitor: (dockerHost) => ({ images: monitorSettings.forOpen(dockerHost), ...imageListFor(dockerHost) }),');
    expect(source).toContain('monitorCalls.monitorEnsure(target, monitorSettings.forTarget(target), signal)');
    expect(source).not.toContain('imageUpdateSchedule ??');
  });
});
