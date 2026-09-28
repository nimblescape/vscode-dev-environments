// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The image repositories for the image maintenance of the Session Monitor on a remote Docker host (user request
// 2026-09-28: "all images", not only those already on the host). ghcr.io lists no repositories without a token, so the
// extension reads the container packages of each owner of the prefixes with the GitHub session (scope read:packages):
// GET /orgs/<owner>/packages?package_type=container, or /users/<owner>/packages for a user. Only the names go to the
// monitor, never the token. Prefixes of other registries: only the images already on the host. No `vscode`.
import type { HttpTransport } from '../http';
import { isImageRepository } from './protocol';

export const GITHUB_API = 'https://api.github.com';
/** At most this many pages of 100 packages per owner. */
const MAX_PACKAGE_PAGES = 10;
/** Review round 1 of PR #57 (B): the time limit of the whole listing (all owners and pages). */
export const PACKAGES_TIMEOUT_MS = 60_000;

/** The owner and the name prefix of a ghcr.io prefix (`ghcr.io/majikmate/devcontainer-dev` → majikmate, devcontainer-dev). */
export function ghcrOwnerOf(prefix: string): { owner: string; namePrefix: string } | undefined {
  const match = /^ghcr\.io\/([a-z0-9-]+)\/(.*)$/.exec(prefix);
  return match ? { owner: match[1], namePrefix: match[2] } : undefined;
}

/**
 * The ghcr.io repositories of the prefixes: the container packages of each owner whose name starts with the name
 * prefix, as `ghcr.io/<owner>/<name>`. Rejects when GitHub does not answer or refuses (the caller logs it).
 */
export async function ghcrRepositories(
  transport: HttpTransport,
  token: string,
  prefixes: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const owners = new Map<string, string[]>();
  for (const prefix of prefixes) {
    const parts = ghcrOwnerOf(prefix);
    if (!parts) continue;
    owners.set(parts.owner, [...(owners.get(parts.owner) ?? []), parts.namePrefix]);
  }
  const repositories: string[] = [];
  for (const [owner, namePrefixes] of owners) {
    for (const name of await packageNames(transport, token, owner, signal)) {
      const repository = `ghcr.io/${owner}/${name.toLowerCase()}`;
      if (namePrefixes.some((namePrefix) => name.toLowerCase().startsWith(namePrefix)) && isImageRepository(repository)) repositories.push(repository);
    }
  }
  return [...new Set(repositories)].sort();
}

async function packageNames(transport: HttpTransport, token: string, owner: string, signal: AbortSignal | undefined): Promise<string[]> {
  for (const kind of ['orgs', 'users']) {
    const names: string[] = [];
    let notFound = false;
    for (let page = 1; page <= MAX_PACKAGE_PAGES; page++) {
      const response = await transport.request(
        {
          method: 'GET',
          url: `${GITHUB_API}/${kind}/${encodeURIComponent(owner)}/packages?package_type=container&per_page=100&page=${page}`,
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'vscode-dev-environments' },
        },
        signal,
      );
      if (response.status === 404 && page === 1) {
        notFound = true;
        break;
      }
      if (response.status !== 200) throw new Error(`GitHub answered HTTP ${response.status} for the packages of ${owner}.`);
      const list = JSON.parse(response.body) as unknown;
      if (!Array.isArray(list)) throw new Error(`GitHub answered no list for the packages of ${owner}.`);
      for (const item of list) {
        const { name, visibility } = item as { name?: unknown; visibility?: unknown };
        // Review round 1 of PR #57 (J): the monitor reads the tags without a token, so a private or internal package
        // could never be updated (a failure in each pass): only public ones.
        if (typeof name === 'string' && (visibility === undefined || visibility === 'public')) names.push(name);
      }
      if (list.length < 100) break;
    }
    if (!notFound) return names;
  }
  throw new Error(`GitHub knows no organization or user ${owner}.`);
}
