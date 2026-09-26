// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Settings of concept section 8 (prefix `devEnvLauncher`, working name of decision D-1).
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import { HOST_ACCESS_CHECKS_OFF_SETTING, parseHostAccessChecksOff } from '../core/hostAccessChecks';
import { Messages } from '../core/messages';
import type { Logger } from '../core/ports';
import type { ExtensionSettings } from '../core/types';

export const SETTINGS_SECTION = 'devEnvLauncher';

/** Defaults of concept section 8. */
export const DEFAULT_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  reopenLastOnStartup: true,
  stopOnClose: true,
  waitingTimeSeconds: 30,
  updateImagesOnConnect: true,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: true,
  refreshIntervalMinutes: 60,
  hostAccessChecksOff: [],
  repositoryGroups: [],
});

/**
 * Largest refresh interval that a Node.js timer supports (2^31 - 1 ms). A longer delay makes `setInterval` fire every
 * millisecond, which would send a discovery request to GitHub in a loop.
 */
export const MAX_REFRESH_INTERVAL_MINUTES = Math.floor(0x7fffffff / 60_000);

/**
 * Current settings. Values of a wrong type fall back to the default; waitingTimeSeconds ≥ 0,
 * 1 ≤ refreshIntervalMinutes ≤ MAX_REFRESH_INTERVAL_MINUTES. hostAccessChecksOff is read from the user settings only
 * (hostAccessChecksOffValue). `repositoryGroups` has the scope `application` in
 * package.json, so VS Code returns only the user setting: a workspace cannot bring its own regular expressions.
 */
export function readSettings(): ExtensionSettings {
  const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  return normalizeSettings((key) =>
    key === HOST_ACCESS_CHECKS_OFF_SETTING ? hostAccessChecksOffValue(configuration) : configuration.get<unknown>(key),
  );
}

/**
 * The raw value of devEnvLauncher.hostAccessChecksOff in the user settings (concept section 8: scope `application`). A
 * value of a workspace or folder, which a repository could bring along, never turns a check off: VS Code ignores such
 * values of an application setting, and this reads the user value only, to be sure.
 */
export function hostAccessChecksOffValue(configuration: Pick<vscode.WorkspaceConfiguration, 'inspect'>): unknown {
  return configuration.inspect<unknown>(HOST_ACCESS_CHECKS_OFF_SETTING)?.globalValue;
}

/** The entries of devEnvLauncher.hostAccessChecksOff (user settings) that are no repository name, for one warning. */
export function invalidHostAccessChecksOffEntries(): string[] {
  const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  return parseHostAccessChecksOff(hostAccessChecksOffValue(configuration)).invalid;
}

/**
 * One warning (a message and a log line) that names the invalid entries of devEnvLauncher.hostAccessChecksOff, which
 * are ignored. `warned`: the entries of the last warning (`''` for none); the same entries are not named again. Returns
 * the entries of this call, for the next one.
 */
export function warnInvalidHostAccessChecksOff(logger: Logger, warned: string): string {
  const invalid = invalidHostAccessChecksOffEntries().join(', ');
  if (invalid === '' || invalid === warned) return invalid;
  logger.warn(Messages.hostAccessChecksOffInvalid(invalid));
  Promise.resolve(vscode.window.showWarningMessage(Messages.hostAccessChecksOffInvalid(invalid))).catch((error: unknown) =>
    logger.warn(`The warning about the setting hostAccessChecksOff could not be shown: ${errorMessage(error)}`),
  );
  return invalid;
}

/** True if a configuration change affects these settings. */
export function affectsSettings(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SETTINGS_SECTION);
}

/** Builds valid settings from raw values (`get` returns `undefined` for a missing value). */
export function normalizeSettings(get: (key: keyof ExtensionSettings) => unknown): ExtensionSettings {
  const bool = (key: keyof ExtensionSettings, fallback: boolean): boolean => {
    const value = get(key);
    return typeof value === 'boolean' ? value : fallback;
  };
  const number = (key: keyof ExtensionSettings, fallback: number, minimum: number, maximum = Infinity): number => {
    const value = get(key);
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
  };
  const owners = get('owners');
  const repositoryGroups = get('repositoryGroups');
  return {
    reopenLastOnStartup: bool('reopenLastOnStartup', DEFAULT_SETTINGS.reopenLastOnStartup),
    stopOnClose: bool('stopOnClose', DEFAULT_SETTINGS.stopOnClose),
    waitingTimeSeconds: number('waitingTimeSeconds', DEFAULT_SETTINGS.waitingTimeSeconds, 0),
    updateImagesOnConnect: bool('updateImagesOnConnect', DEFAULT_SETTINGS.updateImagesOnConnect),
    respectShutdownActionNone: bool('respectShutdownActionNone', DEFAULT_SETTINGS.respectShutdownActionNone),
    owners: Array.isArray(owners)
      ? owners
          .filter((owner): owner is string => typeof owner === 'string')
          .map((owner) => owner.trim())
          .filter((owner) => owner !== '')
      : [],
    includeArchived: bool('includeArchived', DEFAULT_SETTINGS.includeArchived),
    includeForks: bool('includeForks', DEFAULT_SETTINGS.includeForks),
    refreshIntervalMinutes: number(
      'refreshIntervalMinutes',
      DEFAULT_SETTINGS.refreshIntervalMinutes,
      1,
      MAX_REFRESH_INTERVAL_MINUTES,
    ),
    hostAccessChecksOff: parseHostAccessChecksOff(get('hostAccessChecksOff')).repositories,
    // The entries are checked where they are used (repositoryGroups.ts), so that each problem can be named.
    repositoryGroups: Array.isArray(repositoryGroups) ? [...(repositoryGroups as unknown[])] : [],
  };
}
