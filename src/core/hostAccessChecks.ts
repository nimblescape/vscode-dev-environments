// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The switch of the host access checks, per repository (concept section 8 and section 9 "Host access", user request
// 2026-09-26: "application of the security policy shall be configurable per repository, by default it is on"). The user
// setting devEnvLauncher.hostAccessChecksOff lists the repositories whose configuration may use the computer; for every
// other repository the checks are on. The open pipeline reads the switch at each open and passes it to the host access
// policy (hostAccessReport in helper/hostAccess.ts), which then lifts only the refusals of access to the computer.
// Pure functions, no I/O.
import type { ExtensionSettings } from './types';

/** Whether the host access policy refuses the settings that need access to the computer, for one repository. */
export type HostAccessChecks = 'on' | 'off';

/** The key of the setting below the section devEnvLauncher. */
export const HOST_ACCESS_CHECKS_OFF_SETTING = 'hostAccessChecksOff';

/**
 * `owner/name` as GitHub names repositories: the owner of letters, digits, and hyphens (not first), the name of
 * letters, digits, `.`, `_`, and `-` (not `.` or `..`).
 */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const NAME = /^[A-Za-z0-9._-]+$/;

/** True for a valid entry of the setting: `owner/name`, without surrounding spaces. */
export function isRepositoryEntry(text: string): boolean {
  const index = text.indexOf('/');
  if (index <= 0) return false;
  const owner = text.slice(0, index);
  const name = text.slice(index + 1);
  return OWNER.test(owner) && NAME.test(name) && name !== '.' && name !== '..';
}

/** The setting, read: its valid repositories (trimmed, each once without regard to case), and the invalid entries. */
export interface HostAccessChecksOffSetting {
  repositories: string[];
  /** The entries that are no repository name, as the setting has them (texts, or the JSON of other values). */
  invalid: string[];
}

/**
 * Reads the raw value of devEnvLauncher.hostAccessChecksOff. Each entry is trimmed; entries that are no `owner/name`
 * (also entries that are no text) are ignored and listed in `invalid`, for one warning. A value that is no list turns
 * no check off.
 */
export function parseHostAccessChecksOff(value: unknown): HostAccessChecksOffSetting {
  const setting: HostAccessChecksOffSetting = { repositories: [], invalid: [] };
  if (value === undefined || value === null) return setting;
  if (!Array.isArray(value)) {
    setting.invalid.push(String(JSON.stringify(value)));
    return setting;
  }
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      setting.invalid.push(String(JSON.stringify(entry)));
      continue;
    }
    const repository = entry.trim();
    if (!isRepositoryEntry(repository)) {
      setting.invalid.push(entry);
      continue;
    }
    const key = repository.toLowerCase();
    if (keys.has(key)) continue;
    keys.add(key);
    setting.repositories.push(repository);
  }
  return setting;
}

/**
 * The switch for `repository` (`owner/name`): `off` when the setting lists it (compared without case and surrounding
 * spaces), otherwise `on`, the default.
 */
export function hostAccessChecks(
  repository: string,
  settings: Pick<ExtensionSettings, 'hostAccessChecksOff'> | Partial<Pick<ExtensionSettings, 'hostAccessChecksOff'>>,
): HostAccessChecks {
  const key = repository.trim().toLowerCase();
  const off = (settings.hostAccessChecksOff ?? []).some((entry) => typeof entry === 'string' && entry.trim().toLowerCase() === key);
  return off ? 'off' : 'on';
}

/**
 * The new raw value of the setting after the commands Turn Off Host Access Checks… (`off`) and Turn On Host Access
 * Checks (`on`) for `repository`: `off` adds it at the end unless the list has it; `on` removes every entry that names
 * it. Other entries, also invalid ones, stay as the user wrote them.
 */
export function withHostAccessChecks(value: unknown, repository: string, checks: HostAccessChecks): unknown[] {
  const entries: unknown[] = Array.isArray(value) ? [...(value as unknown[])] : [];
  const key = repository.trim().toLowerCase();
  const names = (entry: unknown): boolean => typeof entry === 'string' && entry.trim().toLowerCase() === key;
  if (checks === 'on') return entries.filter((entry) => !names(entry));
  return entries.some(names) ? entries : [...entries, repository.trim()];
}
