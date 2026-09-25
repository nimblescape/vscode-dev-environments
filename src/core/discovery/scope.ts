// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The scan scope (concept 7.4, setting `owners` of section 8): the organizations and accounts whose repositories the
// extension asks GitHub about. An empty scope means all repositories that the account can access.

/**
 * The logins of the setting `owners` to scan, in their order: trimmed, without empty entries and without duplicates
 * (GitHub logins ignore case; the first spelling wins). Entries that are not text are dropped.
 */
export function scopeLogins(owners: readonly unknown[] | undefined): string[] {
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const owner of owners ?? []) {
    if (typeof owner !== 'string') continue;
    const login = owner.trim();
    const key = login.toLowerCase();
    if (login === '' || seen.has(key)) continue;
    seen.add(key);
    logins.push(login);
  }
  return logins;
}

/** The scope as it is stored with a list and compared: lower-case logins, sorted. Empty: all repositories. */
export function normalizeScope(owners: readonly unknown[] | undefined): string[] {
  return scopeLogins(owners)
    .map((login) => login.toLowerCase())
    .sort();
}

/** True if both settings give the same scope (order and case do not matter). A missing scope is the empty scope. */
export function sameScope(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  return left.length === right.length && left.every((login, index) => login === right[index]);
}

/** True if the scope includes the owner (case-insensitive). An empty scope includes every owner. */
export function isOwnerInScope(owners: readonly unknown[] | undefined, owner: string): boolean {
  const scope = normalizeScope(owners);
  return scope.length === 0 || scope.includes(owner.trim().toLowerCase());
}

/** True if the scope includes the owner of the repository `owner/name`. An empty scope includes every repository. */
export function isRepositoryInScope(owners: readonly unknown[] | undefined, repository: string): boolean {
  const slash = repository.indexOf('/');
  return isOwnerInScope(owners, slash >= 0 ? repository.slice(0, slash) : repository);
}
