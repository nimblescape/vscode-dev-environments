// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I (U1, decision of 2026-10-08): the Session Monitor talks to its engine over the Engine API, through the
// port DockerEngine (src/core/worker/dockerEngine.ts) as the worker builds it (src/helperChannel/engineClient.ts over
// engineApi.ts), on the socket of the engine that its container has at HELPER_DOCKER_SOCKET. No Docker CLI. The loop
// (main.ts) and the image maintenance (images.ts) each take a narrow part of the port, so that their tests pass a fake
// engine. The monitor never holds a registry login: its pulls are anonymous, as those of the Docker CLI of its container
// were.
import { errorMessage } from '../core/errors';
import { HELPER_DOCKER_SOCKET } from '../core/names';
import { isAbortError } from '../core/ports';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { engineApi, engineHijack } from '../helperChannel/engineApi';
import { dockerEngine } from '../helperChannel/engineClient';

/**
 * What the loop asks of its engine: the containers with the label of an environment, and the stop of one. Review round 1
 * of PR #126 (F1): the containers as the list gives them (containerSummaries, what `docker ps` read), never with an
 * inspect each, so a container whose inspect fails or waits for its lock does not hold the stops of the whole engine.
 */
export type LoopEngine = Pick<DockerEngine, 'containerSummaries' | 'stop'>;

/**
 * What the image maintenance asks of its engine: the list of the images, the inspect of one, a pull, the containers of
 * an image (the ancestor check), and the removal of an image without force.
 */
export type ImageEngine = Pick<DockerEngine, 'images' | 'inspect' | 'pull' | 'containerIds' | 'removeImage'>;

/**
 * Plan step 11H2 (decision of 2026-10-09): what the VS Code part of the background run asks of its engine: the proxy of
 * the daemon (its HTTPS, decision C1 of 2026-10-05) and its architecture (the platform of the server), the running dev
 * containers (their list and the inspect of each: their mounts and their label devcontainer.metadata), and the exec of the
 * link script of the registry of the container scripts in each. Review round 1 of 11H2 (A-M2): and, for the cleanup, the
 * running containers that mount the store (containerIds) and their processes (`GET /containers/<id>/top`).
 */
export type VscodeEngine = Pick<DockerEngine, 'proxy' | 'architecture' | 'containerSummaries' | 'container' | 'exec' | 'containerIds' | 'processes'>;

/** The engine of `run`: the loop's, the image maintenance's and (plan step 11H2) the VS Code part's of the background run. */
export type MonitorEngineParts = LoopEngine & ImageEngine & VscodeEngine;

/** The engine of the socket of the monitor container (the one of its engine, as the worker's). */
export function socketEngine(): MonitorEngineParts {
  return dockerEngine(engineApi(HELPER_DOCKER_SOCKET), engineHijack(HELPER_DOCKER_SOCKET));
}

/**
 * The reason of a failed call of the engine for the log: the message of the engine or of the connection, or, when the
 * time limit `timeoutMs` of the call ended it (an AbortError: the monitor gives no other signal), that limit.
 */
export function engineFailure(error: unknown, timeoutMs: number): string {
  if (isAbortError(error)) return `Docker did not answer within ${timeoutMs / 1000} seconds.`;
  const text = errorMessage(error).trim();
  return text !== '' ? text : 'Docker gave no reason.';
}
