// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type { ExtensionSettings } from '../core/types';
import { DEFAULT_SETTINGS, MAX_REFRESH_INTERVAL_MINUTES, normalizeSettings, readSettings, SETTINGS_SECTION } from './settings';
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
    });
  });

  it('reads the section devEnvLauncher', () => {
    const values: Partial<Record<keyof ExtensionSettings, unknown>> = { stopOnClose: false, owners: ['acme'] };
    fakeVscode.workspace.getConfiguration.mockReturnValue({ get: (key: keyof ExtensionSettings) => values[key] });
    expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, stopOnClose: false, owners: ['acme'] });
    expect(fakeVscode.workspace.getConfiguration).toHaveBeenCalledWith(SETTINGS_SECTION);
    expect(SETTINGS_SECTION).toBe('devEnvLauncher');
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
});
