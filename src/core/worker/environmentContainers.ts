// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B2: the containers of an environment as the flows of the worker find them, one definition for all of them
// (the token removal, Stop, and the flows that follow): by the label of the environment, the dev container apart from
// the other services of Docker Compose. Plan step 11I (U4, decision of 2026-10-08): and the one rule for the dev
// container of an environment, for the open (EngineDocker.findContainer), the window state, the refresh, Stop and the
// token removal (before, each picked it in its own way). Pure over the port; no I/O of its own, no `vscode`.
import type { ListedContainer } from '../docker/dockerObjects';
import { LABEL_ENVIRONMENT_ID } from '../names';
import { isDevContainer, type DockerEngine, type EngineContainer } from './dockerEngine';

/** The containers with the label of the environment, stopped ones included. */
export function environmentContainers(engine: DockerEngine, environmentId: string, signal?: AbortSignal): Promise<EngineContainer[]> {
  return engine.containers(`${LABEL_ENVIRONMENT_ID}=${environmentId}`, signal);
}

/**
 * Plan step 11I (U4): what the rule of the dev container reads of a container; the containers of the port
 * (EngineContainer) and of the lists of the pipeline's Docker (ListedContainer) have it.
 */
export type RuleContainer = Pick<ListedContainer, 'id' | 'name' | 'state' | 'labels' | 'created'>;

/**
 * Review round 2 of plan step 11B1 (A-R2-7): the time of the create of a container as a number, never its text (the engine
 * trims the zeros of a fraction, so the text order is not the time order); a missing or unreadable time counts as the
 * oldest (0).
 */
function createdTime(container: RuleContainer): number {
  return Date.parse(container.created ?? '') || 0;
}

/** Newest first by createdTime; containers of the same time keep their order. */
function newestFirst<T extends RuleContainer>(containers: readonly T[]): T[] {
  return [...containers].sort((a, b) => createdTime(b) - createdTime(a));
}

/**
 * Plan step 11I (U4, decision of 2026-10-08): the dev container of an environment among `containers` (those with its
 * label). The candidates are its dev containers (isDevContainer: without the label of the other services of Docker
 * Compose, or with the recorded name `containerName`). The dev container is the candidate with the recorded name,
 * whatever its state; else the newest running candidate; else the newest candidate. `log` names the one that is used when
 * it is not the named one (review round 1 of plan step 11B1, A-R1-6: the recorded name is a preference, not a condition,
 * so a dev container that was created again under another name is still found).
 */
export function devContainerOf<T extends RuleContainer>(containers: readonly T[], containerName: string, log?: (line: string) => void): T | undefined {
  const candidates = containers.filter((container) => isDevContainer(container, containerName));
  const named = candidates.find((container) => container.name === containerName);
  if (named !== undefined) return named;
  const ordered = newestFirst(candidates);
  const used = ordered.find((container) => container.state === 'running') ?? ordered[0];
  if (used !== undefined) log?.(`There is no container ${containerName}; the ${used.state === 'running' ? 'running ' : ''}container ${used.name} of the environment is used.`);
  return used;
}

/**
 * Plan step 11I (U4, decision of 2026-10-08): the running dev containers of an environment among `containers`, in the
 * order of the rule (devContainerOf): the one with the recorded name first when it runs, then the others newest first.
 * For what needs a running dev container (the Git state of Stop, the token removal). `log` names the first when it is not
 * the named one, as before (review round 1 of plan step 11B1, A-R1-6).
 */
export function runningDevContainers<T extends RuleContainer>(containers: readonly T[], containerName: string, log?: (line: string) => void): T[] {
  const running = containers.filter((container) => container.state === 'running' && isDevContainer(container, containerName));
  const named = running.filter((container) => container.name === containerName);
  const ordered = [...named, ...newestFirst(running.filter((container) => container.name !== containerName))];
  if (named.length === 0 && ordered.length > 0) log?.(`The container ${containerName} does not run; the running container ${ordered[0].name} of the environment is used.`);
  return ordered;
}

/**
 * The running containers of the other services of Docker Compose among `containers` (label
 * nimblescape.devenv.compose-service): the running containers that are no dev container (isDevContainer). Plan step 11I
 * (U4): by the recorded name `containerName` (before: apart from one given dev container), so that these and
 * runningDevContainers are every running container of the environment, each once.
 */
export function runningServices<T extends RuleContainer>(containers: readonly T[], containerName: string): T[] {
  return containers.filter((container) => container.state === 'running' && !isDevContainer(container, containerName));
}
