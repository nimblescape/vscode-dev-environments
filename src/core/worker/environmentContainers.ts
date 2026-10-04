// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B2: the containers of an environment as the flows of the worker find them, one definition for all of them
// (the token removal, Stop, and the flows that follow): by the label of the environment, the dev container apart from
// the other services of Docker Compose. Pure over the port; no I/O of its own, no `vscode`.
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID } from '../names';
import { isDevContainer, type DockerEngine, type EngineContainer } from './dockerEngine';

/** The containers with the label of the environment, stopped ones included. */
export function environmentContainers(engine: DockerEngine, environmentId: string, signal?: AbortSignal): Promise<EngineContainer[]> {
  return engine.containers(`${LABEL_ENVIRONMENT_ID}=${environmentId}`, signal);
}

/**
 * The running dev container among `containers` (as ContainerAdapter.findContainer found it): the side services of Docker
 * Compose are not it, the one with the recorded name comes first, and else the newest one. Review round 1 of plan step
 * 11B1 (A-R1-6): the recorded name is a preference, not a condition, so a dev container that was created again under
 * another name is still found; `log` names it then.
 */
export function runningDevContainer(containers: readonly EngineContainer[], containerName: string, log?: (line: string) => void): EngineContainer | undefined {
  const running = containers.filter((container) => container.state === 'running' && isDevContainer(container, containerName));
  const named = running.find((container) => container.name === containerName);
  if (named !== undefined) return named;
  // Review round 2 of plan step 11B1 (A-R2-7): by the time, not the text (the engine trims the zeros of a fraction).
  const time = (container: EngineContainer) => Date.parse(container.created ?? '') || 0;
  const newest = [...running].sort((a, b) => time(b) - time(a))[0];
  if (newest !== undefined) log?.(`The container ${containerName} does not run; the running container ${newest.name} of the environment is used.`);
  return newest;
}

/** The running containers of the other services of Docker Compose among `containers` (label nimblescape.devenv.compose-service). */
export function runningServices(containers: readonly EngineContainer[], devContainer?: EngineContainer): EngineContainer[] {
  return containers.filter((container) => container.state === 'running' && container.labels[LABEL_COMPOSE_SERVICE] !== undefined && container.id !== devContainer?.id);
}
