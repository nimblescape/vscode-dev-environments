// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B2 (decision of 2026-10-03, the worker is the deputy): Stop in the worker. Under the lock of the
// environment (the operation takes it), the Git state of the running dev container, then the stop of the dev container
// and of the running containers of the other services of Docker Compose (D-20: after the dev container). Before, the
// extension sent each of these Docker calls through the worker that held the lock (6 + n round trips on a remote host);
// now it is one operation. The extension records the Git state. Pure over the port; no I/O of its own, no `vscode`.
import { errorMessage } from '../errors';
import { parseGitSummaryOutput } from '../git/gitSummary';
import { LABEL_COMPOSE_SERVICE } from '../names';
import type { GitSummary } from '../types';
import { runScript } from './containerScripts';
import { isMissing, type DockerEngine, type EngineContainer } from './dockerEngine';
import { environmentContainers, runningDevContainer, runningServices } from './environmentContainers';

/** The time limit of the Git state (as before the move: GIT_EXEC_TIMEOUT_MS of the pipeline). */
export const STOP_GIT_TIMEOUT_MS = 30_000;
/**
 * The time limit of the stop of one container: its own stop time (which the policy caps at 20 s, else 10 s) and the end
 * of its processes (as DOCKER_QUERY_TIMEOUT_MS of `docker stop` before the move).
 */
export const STOP_CONTAINER_TIMEOUT_MS = 60_000;

export interface StopFlow {
  environmentId: string;
  containerName: string;
  /** The repository folder in the container (repositoryFolder), for the Git state. */
  folder: string;
  /** The remote user, for the Git state. */
  user?: string;
  engine: DockerEngine;
  log: (line: string) => void;
  /** The time of the Git state (ISO 8601). */
  now: () => string;
  signal?: AbortSignal;
}

export interface StopResult {
  outcome: 'stopped' | 'notRunning';
  gitSummary?: GitSummary;
  services: string[];
}

/**
 * Plan step 11B2: the Stop of the environment, under its lock. The Git state is best effort (a failure is logged, the
 * stop goes on); a stop that fails throws with its reason; a cancel throws its AbortError.
 */
export async function stopFlow(p: StopFlow): Promise<StopResult> {
  const containers = await environmentContainers(p.engine, p.environmentId, p.signal);
  const dev = runningDevContainer(containers, p.containerName, p.log);
  let gitSummary: GitSummary | undefined;
  if (dev === undefined) {
    p.log(`The container ${p.containerName} does not run.`);
  } else {
    gitSummary = await readGitSummary(p, dev);
    await stopContainer(p, dev, `Stopping the container ${dev.name}.`);
  }
  const services: string[] = [];
  for (const service of runningServices(containers, dev)) {
    await stopContainer(p, service, `Stopping the container ${service.name} of the service ${service.labels[LABEL_COMPOSE_SERVICE]}.`);
    services.push(service.name);
  }
  return { outcome: dev === undefined ? 'notRunning' : 'stopped', ...(gitSummary !== undefined ? { gitSummary } : {}), services };
}

/** The Git state of the running dev container, or undefined (logged) when it cannot be read. A cancel throws. */
async function readGitSummary(p: StopFlow, dev: EngineContainer): Promise<GitSummary | undefined> {
  try {
    const result = await runScript(p.engine, dev.id, 'gitSummary', [p.folder], { user: p.user, timeoutMs: STOP_GIT_TIMEOUT_MS, signal: p.signal });
    if (result.exitCode !== 0) {
      p.log(`The Git state in ${dev.name} could not be read: ${result.timedOut ? 'the script did not end in time.' : (result.stderr || result.stdout).trim() || `exit code ${result.exitCode ?? 'none'}.`}`);
      return undefined;
    }
    return parseGitSummaryOutput(result.stdout, p.now());
  } catch (error) {
    if (p.signal?.aborted) throw error;
    p.log(`The Git state in ${dev.name} could not be read: ${errorMessage(error)}`);
    return undefined;
  }
}

/** `docker stop` of one container, with its own stop time, within STOP_CONTAINER_TIMEOUT_MS. */
async function stopContainer(p: StopFlow, container: EngineContainer, line: string): Promise<void> {
  p.log(line);
  const limit = AbortSignal.timeout(STOP_CONTAINER_TIMEOUT_MS);
  try {
    await p.engine.stop(container.id, undefined, p.signal ? AbortSignal.any([p.signal, limit]) : limit);
  } catch (error) {
    if (p.signal?.aborted) throw error;
    // Removed since the list (as `docker stop` of a missing container before the move): nothing to stop.
    if (isMissing(error)) {
      p.log(`The container ${container.name} does not exist any more.`);
      return;
    }
    if (limit.aborted) throw new Error(`The container ${container.name} did not stop within ${STOP_CONTAINER_TIMEOUT_MS / 1000} s.`);
    throw new Error(`The container ${container.name} could not be stopped: ${errorMessage(error)}`);
  }
}
