// Parts of the sidebar input (TreeInput) that come from Docker and from the coordination files. No `vscode` import.
import { isBusyMarkLive, type BusyMarkLivenessInput } from '../core/busy';
import type { Environment, WindowStatus } from '../core/types';
import type { EnvironmentRuntime } from './treeModel';

/**
 * Runtime when Docker was just asked and does not run: no container runs (concept 7.6: "When Docker does not run, no
 * container runs"). The volumes cannot be checked; they count as present, so no environment shows "Files missing".
 * `undefined` as runtime means "not asked", which would keep a lost connection shown as Connected.
 */
export function dockerStoppedRuntime(environments: readonly Environment[]): Map<string, EnvironmentRuntime> {
  return new Map(environments.map((environment) => [environment.id, { container: 'stopped', volume: true }]));
}

/** Environments with a busy mark that still protects them (concept 7.9 rule 1, `isBusyMarkLive`). */
export function liveBusyEnvironmentIds(environments: readonly Environment[], liveness: BusyMarkLivenessInput): Set<string> {
  const ids = new Set<string>();
  for (const environment of environments) {
    if (environment.busy && isBusyMarkLive(environment.busy, liveness)) ids.add(environment.id);
  }
  return ids;
}

/** Environments that the given windows are connected to. */
export function environmentIdsOf(windows: readonly WindowStatus[]): Set<string> {
  const ids = new Set<string>();
  for (const window of windows) {
    if (window.environmentId !== null) ids.add(window.environmentId);
  }
  return ids;
}
