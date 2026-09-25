// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Choices of "Select Organizations…" (concept 6.2, 8): the owners that the setting `owners` can name. No `vscode`
// import, so the rules are unit-tested.
import { normalizeScope, scopeLogins } from '../core/discovery/scope';

// User-visible texts that messages.ts lacks; to be moved there.
export const OwnerTexts = {
  title: 'Select Organizations',
  placeholder: 'Select the organizations and accounts to scan for repositories. Select none to scan all repositories that you can access.',
  yourAccount: 'your account',
  /** An owner of the setting that is neither the account nor one of its organizations. */
  fromSettings: 'from your settings',
} as const;

export interface OwnerChoice {
  /** The login that the setting stores. */
  login: string;
  label: string;
  description?: string;
  /** Selected when the Quick Pick opens: the owner is in the setting. */
  picked: boolean;
}

/**
 * The choices: the signed-in account first, then its organizations in alphabetical order, then the owners of the setting
 * that are in neither list, so that they can be removed. Each owner once (logins ignore case); the owners of the
 * setting are selected.
 */
export function ownerChoices(input: {
  viewerLogin: string;
  organizations: readonly string[];
  owners: readonly string[];
}): OwnerChoice[] {
  const selected = new Set(normalizeScope(input.owners));
  const seen = new Set<string>();
  const choices: OwnerChoice[] = [];
  const add = (login: string, description?: string): void => {
    const key = login.trim().toLowerCase();
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    choices.push({ login: login.trim(), label: login.trim(), ...(description ? { description } : {}), picked: selected.has(key) });
  };
  add(input.viewerLogin, OwnerTexts.yourAccount);
  const organizations = [...input.organizations].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  for (const organization of organizations) add(organization);
  for (const owner of scopeLogins(input.owners)) add(owner, OwnerTexts.fromSettings);
  return choices;
}

/** The value of the setting `owners` for the selected choices. No selection: `[]`, which scans all repositories. */
export function selectedOwners(choices: readonly Pick<OwnerChoice, 'login'>[]): string[] {
  return scopeLogins(choices.map((choice) => choice.login));
}

/** True if the setting limits the scan (the filled filter icon of the view title). */
export function ownersFiltered(owners: readonly unknown[]): boolean {
  return scopeLogins(owners).length > 0;
}
