// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type { ExtensionSettings } from '../core/types';
import { Messages } from '../core/messages';
import {
  DEFAULT_SETTINGS,
  MAX_REFRESH_INTERVAL_MINUTES,
  normalizeSettings,
  readListOpenMode,
  readSettings,
  SETTINGS_SECTION,
  warnInvalidHostAccessChecksOff,
} from './settings';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

describe('settings (concept section 8)', () => {
  beforeEach(() => resetFakeVscode());

  it('has the defaults of concept section 8', () => {
    expect(normalizeSettings(() => undefined)).toEqual({
      reopenLastOnStartup: true,
      stopOnClose: true,
      waitingTimeSeconds: 30,
      updateImagesOnConnect: true,
      respectShutdownActionNone: false,
      owners: [],
      includeArchived: false,
      includeForks: true,
      refreshIntervalMinutes: 60,
      // Unit 10: no repository has its host access checks off by default.
      hostAccessChecksOff: [],
      // Unit 9 (setting repositoryGroups, concept 8): a new setting with the default [].
      repositoryGroups: [],
      // Unit 14 (setting openInNewWindow, concept 6.2, 8): a new setting with the default false (Start uses this window).
      openInNewWindow: false,
      // Unit 7, PR 2 (setting stopAfterMinutes): a new setting with the default of 10 minutes. Plan step 8 PR A
      // (Q1): renamed stopAfterMinutes, on every engine, no migration (Q7).
      stopAfterMinutes: 10,
      // User requests 2026-09-28 (setting remoteImageUpdates); user decision 2026-09-29: empty by default (no image
      // repositories known to the extension; the image maintenance is off until the user names some). Plan step 8 PR A:
      // renamed imageUpdates (every engine).
      imageUpdates: [],
      // User request 2026-09-28 ("in the morning again, at 6:07 CEST"; "in a guided cron style manner"): the schedule of
      // the image maintenance, a cron expression (the daily time 06:07 before).
      // Plan step 8 PR A: renamed imageUpdateSchedule.
      // Plan step 11H2 (D2, decision of 2026-10-09): changed expectation, imageUpdateSchedule is replaced by
      // cacheUpdateSchedule (no migration), the schedule of the whole background run, by default every 17 minutes (was
      // imageUpdateSchedule '7 6 * * *').
      cacheUpdateSchedule: '17',
      // Plan step 11H2 (D1, decision of 2026-10-09): a new setting, true by default (the local monitor ends when idle).
      stopLocalMonitorWhenIdle: true,
    });
  });

  // User requests 2026-09-28: the images that the monitor keeps up to date (plan step 8 PR A: imageUpdates, every engine).
  it('reads imageUpdates: strings only; an empty list turns it off; a wrong type gives the default', () => {
    const read = (value: unknown) => normalizeSettings((key) => (key === 'imageUpdates' ? value : undefined)).imageUpdates;
    expect(read(['ghcr.io/acme/base*', 3, null])).toEqual(['ghcr.io/acme/base*']);
    expect(read([])).toEqual([]);
    // User decision 2026-09-29: the default is empty.
    expect(read('ghcr.io/acme/base*')).toEqual([]);
    // User request 2026-09-28 ("in a guided cron style manner"): the daily time HH:MM became a cron schedule; an
    // invalid one (also a time HH:MM) gives the default.
    // Plan step 11H2 (D2, decision of 2026-10-09): changed expectation, the setting is cacheUpdateSchedule (was
    // imageUpdateSchedule), and its default is the interval of 17 minutes (was '7 6 * * *'); a whole number of at least 5
    // minutes is an interval now (530 was invalid).
    const schedule = (value: unknown) => normalizeSettings((key) => (key === 'cacheUpdateSchedule' ? value : undefined)).cacheUpdateSchedule;
    expect(schedule('30 5 * * 1-5')).toBe('30 5 * * 1-5');
    expect(schedule('  30  5 * *   mon-fri ')).toBe('30 5 * * mon-fri');
    expect(schedule('05:30')).toBe('17');
    expect(schedule('61 5 * * *')).toBe('17');
    expect(schedule(530)).toBe('530');
  });

  // Plan step 11H2 (D2, decision of 2026-10-09): cacheUpdateSchedule is a cron schedule of five fields or an interval of
  // whole minutes, at least 5; anything else is the default, every 17 minutes.
  it('reads cacheUpdateSchedule: five cron fields or whole minutes from 5 on; junk, fewer minutes and fractions give 17', () => {
    const schedule = (value: unknown) => normalizeSettings((key) => (key === 'cacheUpdateSchedule' ? value : undefined)).cacheUpdateSchedule;
    expect(schedule(undefined)).toBe('17');
    expect(schedule('17')).toBe('17');
    expect(schedule(' 5 ')).toBe('5');
    expect(schedule(5)).toBe('5');
    expect(schedule('60')).toBe('60');
    expect(schedule('0060')).toBe('60');
    expect(schedule('7 6 * * *')).toBe('7 6 * * *');
    for (const junk of ['4', 4, '0', '-5', '5.5', 5.5, '1e3', '17 minutes', '', '   ', '7 6 * *', '7 6 * * * *', null, true, ['17'], { minutes: 17 }, '525601']) {
      expect(schedule(junk), JSON.stringify(junk)).toBe('17');
    }
  });

  // Plan step 11H2 (D1 and D2, decision of 2026-10-09): the manifest has the two settings with the defaults of the code
  // (scope application, as the other settings of the monitor), no imageUpdateSchedule any more, and the pattern of
  // cacheUpdateSchedule takes whole minutes and five fields, and refuses other text.
  it('declares cacheUpdateSchedule and stopLocalMonitorWhenIdle in package.json with the defaults of the code', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown; pattern?: string; scope?: string; type?: string }> } };
    };
    const properties = manifest.contributes.configuration.properties;
    expect(properties[`${SETTINGS_SECTION}.imageUpdateSchedule`]).toBeUndefined();
    const schedule = properties[`${SETTINGS_SECTION}.cacheUpdateSchedule`];
    expect(schedule).toMatchObject({ type: 'string', default: DEFAULT_SETTINGS.cacheUpdateSchedule, scope: 'application' });
    expect(properties[`${SETTINGS_SECTION}.stopLocalMonitorWhenIdle`]).toMatchObject({ type: 'boolean', default: DEFAULT_SETTINGS.stopLocalMonitorWhenIdle, scope: 'application' });
    const pattern = new RegExp(schedule.pattern ?? '');
    for (const text of ['17', ' 60 ', '7 6 * * *', '7 */6 * * 1-5']) expect(pattern.test(text), text).toBe(true);
    for (const text of ['17 minutes', '7 6 * *', 'soon', '']) expect(pattern.test(text), text).toBe(false);
  });

  // Plan step 11H2 (D1, decision of 2026-10-09): stopLocalMonitorWhenIdle, a boolean, true by default.
  it('reads stopLocalMonitorWhenIdle: a boolean; anything else is true', () => {
    const read = (value: unknown) => normalizeSettings((key) => (key === 'stopLocalMonitorWhenIdle' ? value : undefined)).stopLocalMonitorWhenIdle;
    expect(read(false)).toBe(false);
    expect(read(true)).toBe(true);
    expect(read(undefined)).toBe(true);
    expect(read('false')).toBe(true);
  });

  it('reads the section devEnvLauncher', () => {
    const values: Partial<Record<keyof ExtensionSettings, unknown>> = { stopOnClose: false, owners: ['acme'] };
    // `inspect`: devEnvLauncher.hostAccessChecksOff is read from the user settings only (unit 10); it has no user value here.
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get: (key: keyof ExtensionSettings) => values[key], inspect: () => undefined });
    expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, stopOnClose: false, owners: ['acme'] });
    expect(fakeVscode.workspace.getConfiguration).toHaveBeenCalledWith(SETTINGS_SECTION);
    expect(SETTINGS_SECTION).toBe('devEnvLauncher');
  });

  it('reads the VS Code setting workbench.list.openMode (double-click on a row)', () => {
    let value: unknown = 'doubleClick';
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get: (key: string) => (key === 'openMode' ? value : undefined) });
    expect(readListOpenMode()).toBe('doubleClick');
    expect(fakeVscode.workspace.getConfiguration).toHaveBeenCalledWith('workbench.list');
    value = undefined;
    expect(readListOpenMode()).toBe('singleClick');
  });

  it('replaces values of a wrong type with the default, and cleans the owners', () => {
    const raw: Record<string, unknown> = {
      reopenLastOnStartup: 'no',
      waitingTimeSeconds: 'ten',
      refreshIntervalMinutes: Number.NaN,
      owners: [' acme ', '', 3, 'me'],
      includeForks: null,
    };
    const settings = normalizeSettings((key) => raw[key]);
    expect(settings.reopenLastOnStartup).toBe(true);
    expect(settings.waitingTimeSeconds).toBe(30);
    expect(settings.refreshIntervalMinutes).toBe(60);
    expect(settings.owners).toEqual(['acme', 'me']);
    expect(settings.includeForks).toBe(true);
    expect(normalizeSettings((key) => (key === 'owners' ? 'acme' : undefined)).owners).toEqual([]);
  });

  it('reads the entries of repositoryGroups as they are, and replaces a value that is not a list with []', () => {
    const entries = ['^a', { name: 'B', pattern: '^b', flags: 'i' }, 3];
    expect(normalizeSettings((key) => (key === 'repositoryGroups' ? entries : undefined)).repositoryGroups).toEqual(entries);
    for (const value of ['^a', null, 3, { pattern: '^a' }]) {
      expect(normalizeSettings((key) => (key === 'repositoryGroups' ? value : undefined)).repositoryGroups).toEqual([]);
    }
  });

  it('declares repositoryGroups with the scope application, so a workspace cannot set regular expressions', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { scope?: string; default?: unknown }> } };
    };
    const setting = manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.repositoryGroups`];
    expect(setting).toMatchObject({ scope: 'application', default: [] });
  });

  it('clamps the waiting time and the refresh interval', () => {
    const settings = (raw: Record<string, unknown>) => normalizeSettings((key) => raw[key]);
    expect(settings({ waitingTimeSeconds: -5 }).waitingTimeSeconds).toBe(0);
    expect(settings({ waitingTimeSeconds: 0 }).waitingTimeSeconds).toBe(0);
    expect(settings({ refreshIntervalMinutes: 0 }).refreshIntervalMinutes).toBe(1);
    expect(settings({ refreshIntervalMinutes: 15 }).refreshIntervalMinutes).toBe(15);
    // A timer with a longer delay would fire every millisecond.
    expect(settings({ refreshIntervalMinutes: 1_000_000 }).refreshIntervalMinutes).toBe(MAX_REFRESH_INTERVAL_MINUTES);
    expect(MAX_REFRESH_INTERVAL_MINUTES * 60_000).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  // Unit 7, PR 2: the time limit of a container on a remote Docker host without contact; review round 4 of PR #39 (P1):
  // five minutes to one day.
  // Plan step 8 PR A (Q1): renamed stopAfterMinutes, on every engine.
  it('clamps stopAfterMinutes to 5..1440 and gives 10 for a value that is no number', () => {
    const settings = (raw: Record<string, unknown>) => normalizeSettings((key) => raw[key]);
    expect(settings({ stopAfterMinutes: 0 }).stopAfterMinutes).toBe(5);
    expect(settings({ stopAfterMinutes: 1 }).stopAfterMinutes).toBe(5);
    expect(settings({ stopAfterMinutes: 4.9 }).stopAfterMinutes).toBe(5);
    expect(settings({ stopAfterMinutes: 5 }).stopAfterMinutes).toBe(5);
    expect(settings({ stopAfterMinutes: 30 }).stopAfterMinutes).toBe(30);
    expect(settings({ stopAfterMinutes: 100_000 }).stopAfterMinutes).toBe(1440);
    expect(settings({ stopAfterMinutes: '5' }).stopAfterMinutes).toBe(10);
    expect(settings({ stopAfterMinutes: Number.NaN }).stopAfterMinutes).toBe(10);
    // The same bounds in package.json.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { minimum?: number; maximum?: number; scope?: string }> } };
    };
    // User request 2026-09-29: one value per user and computer (scope application), so a workspace cannot give one
    // window another limit; all windows write the same monitor.json and heartbeats.
    expect(manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.stopAfterMinutes`]).toMatchObject({
      minimum: 5,
      maximum: 1440,
      scope: 'application',
    });
    // Review round 1 of PR #61 (R1): the other settings of the one monitor.json and of the heartbeats too, so that a
    // repository's workspace settings cannot keep every environment of the computer running or change its waiting time.
    for (const key of ['stopOnClose', 'waitingTimeSeconds', 'respectShutdownActionNone']) {
      expect(manifest.contributes.configuration.properties[`${SETTINGS_SECTION}.${key}`], key).toMatchObject({ scope: 'application' });
    }
  });

  it('reads hostAccessChecksOff from the user settings only, trimmed, without invalid entries', () => {
    const get = vi.fn((key: string) => (key === 'hostAccessChecksOff' ? ['from/workspace'] : undefined));
    const inspect = vi.fn((): { globalValue?: string[]; workspaceValue: string[] } => ({
      globalValue: [' acme/api ', 'not a name', 'me/web'],
      workspaceValue: ['evil/repo'],
    }));
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get, inspect });
    expect(readSettings().hostAccessChecksOff).toEqual(['acme/api', 'me/web']);
    expect(inspect).toHaveBeenCalledWith('hostAccessChecksOff');
    expect(get).not.toHaveBeenCalledWith('hostAccessChecksOff');
    // Without a user value, every check is on.
    inspect.mockReturnValue({ globalValue: undefined, workspaceValue: ['evil/repo'] });
    expect(readSettings().hostAccessChecksOff).toEqual([]);
    expect(normalizeSettings((key) => (key === 'hostAccessChecksOff' ? 'acme/api' : undefined)).hostAccessChecksOff).toEqual([]);
  });

  it('warns once about the invalid entries of hostAccessChecksOff, and again only when they change', () => {
    const inspect = vi.fn((): { globalValue: unknown[] } => ({ globalValue: ['acme/api', 'acme', 3] }));
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get: () => undefined, inspect });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    const warned = warnInvalidHostAccessChecksOff(logger, '');
    expect(warned).toBe('acme, 3');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(Messages.hostAccessChecksOffInvalid('acme, 3'));
    expect(logger.warn).toHaveBeenCalledWith(Messages.hostAccessChecksOffInvalid('acme, 3'));
    expect(warnInvalidHostAccessChecksOff(logger, warned)).toBe(warned);
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    inspect.mockReturnValue({ globalValue: ['acme/api'] });
    expect(warnInvalidHostAccessChecksOff(logger, warned)).toBe('');
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });
});
