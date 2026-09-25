// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Select Organizations…" in the title bar of the view (concept 6.2, 8): a multi-select Quick Pick that writes the
// setting `owners`, the scan scope of the repository list (concept 7.4). The configuration change handler of
// extension.ts then loads the list of the new scope.
import * as vscode from 'vscode';
import type { DiscoveryService } from '../core/discovery/discoveryService';
import { errorMessage } from '../core/errors';
import { Actions, Messages } from '../core/messages';
import type { Logger } from '../core/ports';
import type { DiscoveryData, ExtensionSettings, GitHubAccount } from '../core/types';
import { ownerChoices, ownersFiltered, OwnerTexts, selectedOwners } from './ownerChoices';
import { SETTINGS_SECTION } from './settings';

/** Context key of the view title bar (package.json): the setting `owners` limits the scan (icon `$(filter-filled)`). */
export const OWNERS_FILTERED_CONTEXT_KEY = 'devEnvironments.ownersFiltered';

export interface OwnerSelectorDeps {
  auth: {
    isSignedIn(): Promise<boolean>;
    getToken(options: { interactive: boolean }): Promise<string | undefined>;
    getAccount(options: { interactive: boolean }): Promise<GitHubAccount | undefined>;
  };
  /** The list that the view shows, whose organizations are used when it belongs to the signed-in account. */
  discoveryData: () => DiscoveryData | undefined;
  discovery: Pick<DiscoveryService, 'viewerOrganizations'>;
  settings: () => ExtensionSettings;
  /** Sign in with GitHub (the command of the view). */
  signIn: () => Promise<void>;
  logger: Logger;
}

interface OwnerItem extends vscode.QuickPickItem {
  login: string;
}

/**
 * Asks for the owners to scan and writes them to the user setting `owners`. Not signed in: asks to sign in first.
 * Cancel changes nothing; an empty selection writes `[]` (all repositories).
 */
export async function selectOwners(deps: OwnerSelectorDeps): Promise<void> {
  if (!(await deps.auth.isSignedIn())) {
    const choice = await vscode.window.showInformationMessage(Messages.signInRequired, Actions.signIn);
    if (choice !== Actions.signIn) return;
    await deps.signIn();
    if (!(await deps.auth.isSignedIn())) return;
  }
  const [token, account] = await Promise.all([
    deps.auth.getToken({ interactive: false }),
    deps.auth.getAccount({ interactive: false }),
  ]);
  if (!token || !account) return;

  const owners = deps.settings().owners;
  const { login, organizations } = await accountOrganizations(deps, token, account);
  const items: OwnerItem[] = ownerChoices({ viewerLogin: login, organizations, owners }).map((choice) => ({
    label: choice.label,
    ...(choice.description ? { description: choice.description } : {}),
    picked: choice.picked,
    login: choice.login,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: OwnerTexts.title,
    placeHolder: OwnerTexts.placeholder,
    matchOnDescription: true,
  });
  if (!picked) return;
  await vscode.workspace
    .getConfiguration(SETTINGS_SECTION)
    .update('owners', selectedOwners(picked), vscode.ConfigurationTarget.Global);
}

/** Sets the context key of the filter icon from the setting `owners`. */
export function updateOwnersContextKey(owners: readonly unknown[], logger: Logger): void {
  vscode.commands.executeCommand('setContext', OWNERS_FILTERED_CONTEXT_KEY, ownersFiltered(owners)).then(undefined, (error: unknown) => {
    logger.warn(`Could not set the context key ${OWNERS_FILTERED_CONTEXT_KEY}: ${errorMessage(error)}`);
  });
}

/**
 * The organizations of the account: from the list of the view when it belongs to the account, otherwise from GitHub
 * (a request without repositories). When GitHub cannot be asked, only the account and the owners of the setting are
 * offered.
 */
async function accountOrganizations(
  deps: OwnerSelectorDeps,
  token: string,
  account: GitHubAccount,
): Promise<{ login: string; organizations: string[] }> {
  const data = deps.discoveryData();
  if (data && data.viewerLogin.toLowerCase() === account.login.toLowerCase()) {
    return { login: data.viewerLogin, organizations: data.organizations };
  }
  try {
    return await deps.discovery.viewerOrganizations(token);
  } catch (error) {
    deps.logger.warn(`The organizations of ${account.login} could not be read: ${errorMessage(error)}`);
    return { login: account.login, organizations: [] };
  }
}
