// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11C2b (decision of 2026-10-03, the worker is the deputy): the check of Delete (concept 7.14 step 1) and its
// questions, as the worker runs them: the Git state of the repository (refreshed in the running dev container), the data
// of the services that Delete removes with the repository, and the volumes that Delete may remove; the questions go to the
// user as their requests (PipelineUi), with the facts, never with a text of the worker (the extension words them, in the
// locale of the user). The answer is the decision of the user. Moved from the controller (Delete); pure over its deps.
import { formatChanges, lastSeenInUse } from '../messages';
import { repositoryServiceDataFolders } from './pipelineRules';
import type { Environment, GitSummary } from '../types';

/** The confirmation of Delete (PipelineUi.confirmDelete): the facts that the extension words. */
export interface DeleteConfirmation {
  /** The changes in the repository (formatChanges), empty when there are none or none are known. */
  changes: string;
  /** When the Git state that the confirmation names was recorded; absent when none was. */
  recordedAt?: string;
  /** The last time the environment was seen in use (lastSeenInUse); absent when it is not known. */
  lastSeenInUse?: string;
  /** The folders of the repository with the data of services (removed with the repository). */
  repositoryData: string[];
  /** A window of this computer is connected to the environment and closes its connection first. */
  otherWindow: boolean;
}

/** The decision of the user: delete with the volumes to remove too, open the environment instead, or nothing. */
export type DeleteDecision = { decision: 'delete'; additionalVolumesToRemove: string[] } | { decision: 'open' } | { decision: 'cancel' };

export interface DeleteCheckDeps {
  /** The Git state to name (EnvironmentService.safetyCheck: refreshed in the running dev container and recorded). */
  summary(): Promise<GitSummary | undefined>;
  /** The registry entry now (undefined: it is gone). */
  environment(): Promise<Environment | undefined>;
  /** The paths of the repository that the containers of the other services mount (repositoryServiceData). */
  repositoryServiceData(): Promise<string[]>;
  removableAdditionalVolumes(): Promise<string[]>;
  removableServiceDataVolumes(): Promise<string[]>;
  possibleServiceDataVolumes(): Promise<string[]>;
  ui: {
    confirmDelete(repository: string, confirmation: DeleteConfirmation): Promise<'delete' | 'open' | undefined>;
    deleteAdditionalVolumes(volumes: readonly string[]): Promise<'remove' | 'keep' | undefined>;
    deleteServiceData(volumes: readonly string[], possibly: readonly string[]): Promise<string[] | undefined>;
  };
}

/**
 * The check and the questions of Delete for `environment` (the entry when the command started), named `repository` to
 * the user; `otherWindow`: a window of this computer is connected to it. User decision 2026-10-02 ("No git needs delete.
 * ... we may flag uncommitted changes though, but that does not hinder deletion."): the changes of the recorded Git state
 * are named, and the user can always delete.
 */
export async function deleteCheck(deps: DeleteCheckDeps, environment: Environment, repository: string, otherWindow: boolean): Promise<DeleteDecision> {
  const summary = await deps.summary();
  // Review round 1 of PR #87 (A-R1-4) and round 2 (A-R2-2): the note when the recorded state is older than the last use.
  const used = (await deps.environment().catch(() => undefined)) ?? environment;
  const named = summary ?? used.gitSummary;
  const seen = lastSeenInUse(used);
  // Review round 9 (D9-2), round 11 (G3, G4): the data of services in folders of the repository go with the volume.
  const repositoryData = [...new Set([...repositoryServiceDataFolders(used), ...(await deps.repositoryServiceData().catch(() => []))])];
  const answer = await deps.ui.confirmDelete(repository, {
    changes: summary ? formatChanges(summary) : '',
    ...(named !== undefined ? { recordedAt: named.recordedAt } : {}),
    ...(seen !== undefined ? { lastSeenInUse: seen } : {}),
    repositoryData,
    otherWindow,
  });
  if (answer === 'open') return { decision: 'open' };
  if (answer !== 'delete') return { decision: 'cancel' };
  const confirmed = (await deps.environment()) ?? environment;
  const additional = (confirmed.additionalVolumes ?? []).length > 0;
  // Only the volumes that Delete would remove (their labels make them the environment's own).
  const volumes = additional ? await deps.removableAdditionalVolumes() : [];
  let additionalVolumesToRemove: string[] = [];
  if (volumes.length > 0) {
    const choice = await deps.ui.deleteAdditionalVolumes(volumes);
    if (choice === undefined) return { decision: 'cancel' };
    additionalVolumesToRemove = choice === 'remove' ? [...volumes] : [];
  }
  // D-19: the volumes of a Docker Compose project hold the data of its services; none ticked; Escape cancels.
  const serviceData = additional ? await deps.removableServiceDataVolumes() : [];
  if (serviceData.length > 0) {
    // Review round 3 (P3-4): an environment whose services are not known lists its additional volumes as possible data.
    const possibly = await deps.possibleServiceDataVolumes();
    const picked = await deps.ui.deleteServiceData(serviceData, possibly);
    if (picked === undefined) return { decision: 'cancel' };
    // Only names that the question offered.
    additionalVolumesToRemove = [...additionalVolumesToRemove, ...picked.filter((name) => serviceData.includes(name))];
  }
  return { decision: 'delete', additionalVolumesToRemove };
}
