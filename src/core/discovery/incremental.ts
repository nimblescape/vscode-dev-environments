// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Incremental detection (concept 7.4): a refresh reads the configurations only of repositories that are new or that
// changed since the stored list. No `vscode` import.
import type { GraphQLError } from './githubApi';
import type { CheckedRepository, DiscoveryData, RepositoryInfo } from '../types';

/** The stored detection result of a repository: its configurations, and the state of GitHub it was read from. */
export interface StoredDetection {
  pushedAt: string | null;
  defaultBranch: string | null;
  configPaths: string[];
}

/**
 * The detection results of a stored list, by lower-case `owner/name`: the repositories with a configuration (without
 * those whose detection was not certain, `DiscoveryData.uncertain`), and those without one
 * (`DiscoveryData.withoutConfiguration`). Empty without a stored list.
 */
export function storedDetections(data: DiscoveryData | undefined): Map<string, StoredDetection> {
  const detections = new Map<string, StoredDetection>();
  if (!data) return detections;
  for (const checked of data.withoutConfiguration ?? []) {
    detections.set(checked.nameWithOwner.toLowerCase(), { pushedAt: checked.pushedAt, defaultBranch: checked.defaultBranch, configPaths: [] });
  }
  // A detection that was not certain is read again (concept 7.4: a lookup that fails is repeated at the next refresh).
  const uncertain = new Set((data.uncertain ?? []).map((name) => name.toLowerCase()));
  for (const info of data.repositories) {
    if (uncertain.has(info.nameWithOwner.toLowerCase())) continue;
    detections.set(info.nameWithOwner.toLowerCase(), {
      pushedAt: info.pushedAt,
      defaultBranch: info.defaultBranch,
      configPaths: [...info.configPaths],
    });
  }
  return detections;
}

/**
 * True if the configurations of the listed repository must be read: it is not in the stored list, or its last push
 * (`pushedAt`) or its default branch changed. A push to any branch changes `pushedAt`, so a change of the default branch
 * is never missed; a push to another branch only costs one lookup.
 */
export function needsConfigurationLookup(
  listed: Pick<RepositoryInfo, 'pushedAt' | 'defaultBranch'>,
  stored: Pick<StoredDetection, 'pushedAt' | 'defaultBranch'> | undefined,
): boolean {
  if (!stored) return true;
  return listed.pushedAt !== stored.pushedAt || listed.defaultBranch !== stored.defaultBranch;
}

/** The entry of `DiscoveryData.withoutConfiguration` for a repository without configuration. */
export function checkedRepository(info: Pick<RepositoryInfo, 'nameWithOwner' | 'pushedAt' | 'defaultBranch'>): CheckedRepository {
  return { nameWithOwner: info.nameWithOwner, pushedAt: info.pushedAt, defaultBranch: info.defaultBranch };
}

/**
 * The indexes of the repository nodes of a page that GraphQL errors point into, for example
 * `['viewer', 'repositories', 'nodes', 3, 'folder']`: their detection is not certain, so it is not kept for a later
 * refresh.
 */
export function nodesWithErrors(errors: readonly GraphQLError[]): Set<number> {
  const indexes = new Set<number>();
  for (const error of errors) {
    const path = error.path ?? [];
    for (let i = 1; i + 1 < path.length; i++) {
      const index = path[i + 1];
      if (path[i - 1] === 'repositories' && path[i] === 'nodes' && typeof index === 'number') indexes.add(index);
    }
  }
  return indexes;
}
