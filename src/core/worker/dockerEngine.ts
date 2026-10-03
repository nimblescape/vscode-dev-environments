// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (section 0 of the plan, one concept for commanding Docker): the one port through which a flow in the
// worker acts on its engine. It is implemented over the Docker Engine API (src/helperChannel/engineClient.ts); there is
// no `docker` process of our own behind it. The Docker CLI and Docker Compose run only as tools of the Dev Container CLI
// in the batch helper, and in the extension only for the bootstrap. Pure types and checks; no I/O, no `vscode`.
import { LABEL_COMPOSE_SERVICE } from '../names';
import type { ContainerState } from '../types';

/** A container as a flow needs it (the fields of `docker inspect` that the flows read). */
export interface EngineContainer {
  id: string;
  /** Without the leading '/'. */
  name: string;
  state: ContainerState;
  /** `State.Status`, for example `exited`. */
  rawState: string;
  exitCode?: number;
  restartCount?: number;
  labels: Record<string, string>;
  /** The image reference that the container was created from (`Config.Image`). */
  image: string;
  /** The full ID of that image (`Image`), which the reference may no longer name. */
  imageId?: string;
  /** The named volumes that the container mounts. */
  volumes?: string[];
  /** When the daemon created it (`Created`, RFC 3339). */
  created?: string;
}

/** What `exec` ran: the exit code of the process, and what it wrote. */
export interface EngineExecResult {
  /** `null` when the process ended through a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the time limit ended it. */
  timedOut: boolean;
}

/** The options of `exec` (plan step 11B1: the one primitive through which every script runs in a container). */
export interface EngineExecOptions {
  /** The user of the process, as `docker exec -u` takes it. */
  user?: string;
  /** Its working folder. */
  workdir?: string;
  /** Its standard input, then closed. */
  input?: string;
  /**
   * The name of the secret of the operation (OperationContext.secrets) whose value is its standard input instead: never
   * an argument, never a log line. A name, not a value (review round 1 of plan step 11B1, A-R1-3: ContainerAdapter's
   * `secretInput` is a value); an exec fails when the operation holds no such secret.
   */
  secretInputName?: string;
  /** The output as it comes, in addition to the result. */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Plan step 11B1: the port of the engine. It grows with the flows that move into the worker (plan steps 11B2 to 11E);
 * every method here is one request to the Engine API, and every script that runs in a container goes through `exec`
 * (containerScripts.ts). Each method rejects with an EngineError, or with an AbortError when the signal aborts.
 */
export interface DockerEngine {
  /** The container `reference` (a name or an ID), or undefined when it does not exist. */
  container(reference: string, signal?: AbortSignal): Promise<EngineContainer | undefined>;
  /** The containers with the label `label` (`<key>` or `<key>=<value>`), stopped ones included. */
  containers(label: string, signal?: AbortSignal): Promise<EngineContainer[]>;
  /** One process in a running container (the one primitive for the scripts of containerScripts.ts). */
  exec(container: string, command: readonly string[], options?: EngineExecOptions): Promise<EngineExecResult>;
  /** Stops the container (SIGTERM, then SIGKILL after `timeoutSeconds`); a container that is not running is left alone. */
  stop(container: string, timeoutSeconds: number, signal?: AbortSignal): Promise<void>;
  /** Starts the container; one that runs already is left alone. */
  start(container: string, signal?: AbortSignal): Promise<void>;
}

/** A failure of the engine: its message, and the HTTP status that it answered with. */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/** True when the engine answered that the container, image, volume or network does not exist. */
export function isMissing(error: unknown): boolean {
  return error instanceof EngineError && error.status === 404;
}

/**
 * Whether a container of an environment is its dev container: without the label nimblescape.devenv.compose-service of
 * the other services of Docker Compose, or with the name of the environment.
 */
export function isDevContainer(container: { name: string; labels: Record<string, string> }, containerName: string): boolean {
  return container.labels[LABEL_COMPOSE_SERVICE] === undefined || container.name === containerName;
}
