// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, D1 and D2): the settings of the Session Monitor that an open and `monitorEnsure`
// carry (MonitorSettings: the image settings with the schedule of the whole background run, a cron schedule or an
// interval in minutes, and whether the monitor runs permanently), checked strictly on both sides; `settings -` gets them
// without the mode.
import { describe, expect, it } from 'vitest';
import { imageSettingsOf, parseImageSettingsInput, parseMonitorSettings } from '../remoteMonitor/protocol';
import { parseMonitorEnsureParams, parseOpenParams } from './protocol';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const IMAGES = { prefixes: ['ghcr.io/acme/base'], schedule: '17', timeZone: 'Europe/Vienna' };
const SETTINGS = { updateImagesOnConnect: true, hostAccessChecks: 'on', waitingTimeSeconds: 30, stopOnClose: true, respectShutdownActionNone: false };
const EXISTING = { dockerHost: '', owner: { windowId: 'window-1', pid: 7 }, monitorSource: SOURCE, settings: SETTINGS, images: IMAGES, repository: 'acme/app', environmentId: ID };

describe('the monitor settings of an open and of monitorEnsure (plan step 11H2)', () => {
  it('takes the schedule as whole minutes from 5 on, or five cron fields', () => {
    expect(parseImageSettingsInput(JSON.stringify(IMAGES))).toEqual(IMAGES);
    expect(parseImageSettingsInput(JSON.stringify({ ...IMAGES, schedule: '7 6 * * *' }))).toEqual({ ...IMAGES, schedule: '7 6 * * *' });
    for (const schedule of ['4', '5.5', '17 minutes', '7 6 * *']) {
      expect(parseImageSettingsInput(JSON.stringify({ ...IMAGES, schedule })), schedule).toBeUndefined();
    }
  });

  it('takes the mode as a boolean, or none; anything else is refused', () => {
    expect(parseMonitorSettings({ ...IMAGES, permanent: true })).toEqual({ ...IMAGES, permanent: true });
    expect(parseMonitorSettings({ ...IMAGES, permanent: false })).toEqual({ ...IMAGES, permanent: false });
    expect(parseMonitorSettings(IMAGES)).toEqual(IMAGES);
    expect(parseMonitorSettings(IMAGES)).not.toHaveProperty('permanent');
    for (const permanent of ['true', 1, null, {}]) expect(parseMonitorSettings({ ...IMAGES, permanent }), JSON.stringify(permanent)).toBeUndefined();
    expect(parseMonitorSettings({ ...IMAGES, permanent: true, extra: 1 })).toBeUndefined();
    expect(parseMonitorSettings({ ...IMAGES, schedule: '3', permanent: true })).toBeUndefined();
    expect(parseMonitorSettings('{}')).toBeUndefined();
  });

  it('carries the mode in monitorEnsure and in the open', () => {
    expect(parseMonitorEnsureParams({ images: { ...IMAGES, permanent: true } })).toEqual({ images: { ...IMAGES, permanent: true } });
    expect(parseMonitorEnsureParams({ images: { ...IMAGES, permanent: 'yes' } })).toBeUndefined();
    const open = { ...EXISTING, images: { ...IMAGES, permanent: true } };
    expect(parseOpenParams(open)).toEqual(open);
    expect(parseOpenParams({ ...EXISTING, images: { ...IMAGES, permanent: 0 } })).toBeUndefined();
  });

  it('gives `settings -` the image settings without the mode', () => {
    expect(imageSettingsOf({ ...IMAGES, permanent: true } as typeof IMAGES)).toEqual(IMAGES);
    expect(parseImageSettingsInput(JSON.stringify({ ...IMAGES, permanent: true }))).toBeUndefined();
  });
});
