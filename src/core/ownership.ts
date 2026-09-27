// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Environments belong to the GitHub account that created them (concept 7.5, section 9 "Accounts"). An account never
// sees, starts, or connects to an environment of another account; an account has at most one environment per
// repository (concept D-3).
import type { Environment, GitHubAccount } from './types';

/**
 * True if the signed-in `account` may use the environment: it is the owner of the environment. Without an account (not
 * signed in), no environment is available.
 */
export function isAvailableTo(environment: Pick<Environment, 'owner'>, account: GitHubAccount | undefined): boolean {
  return account !== undefined && environment.owner.id === account.id;
}

/** The environments that `account` may use, in their order. */
export function availableEnvironments<T extends Pick<Environment, 'owner'>>(
  environments: readonly T[],
  account: GitHubAccount | undefined,
): T[] {
  return environments.filter((environment) => isAvailableTo(environment, account));
}

/** The owner entry of an environment that `account` creates. */
export function ownerOf(account: GitHubAccount): GitHubAccount {
  return { id: account.id, login: account.login };
}
