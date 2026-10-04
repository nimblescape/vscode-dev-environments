// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR C: the states of the environments and the branches of their running dev containers, read in one go.
// It runs in the worker (the operation `refresh`, src/helperChannel/operations.ts; plan step 11C1: only there, never
// directly in the extension). It only reads. Pure: no `vscode`, and nothing of the
// service, so that the script of the worker stays small.
import { Semaphore } from '../concurrency';
import { isDevContainer, type ContainerAdapter } from '../docker/containerAdapter';
import { LABEL_ENVIRONMENT_ID } from '../names';
import type { ContainerState } from '../types';

/** State of the container and the volume of an environment. */
export interface EnvironmentRuntimeState {
  /** Review round 7, P7-2: the state of the dev container only (isDevContainer), not of the other services. */
  container: ContainerState;
  volume: boolean;
  /**
   * Review round 7, P7-2: `true` when a container of another service of Docker Compose (label
   * nimblescape.devenv.compose-service) runs; not set otherwise. Stop stays offered while it runs, also when the dev
   * container is stopped.
   */
  servicesRunning?: boolean;
}

/** What readEnvironmentStates needs of an environment (of the current Docker host). */
export interface StateEnvironment {
  id: string;
  containerName: string;
  volumeName: string;
  /** The user of `docker exec` for the branch (remoteUser); none: the user of the container. */
  user?: string;
  /** The folder of the repository in the container (repositoryFolder). */
  folder: string;
  /** Read the branch when its dev container runs (the sidebar reads it for the environments of the account only). */
  branch: boolean;
}

export interface EnvironmentStates {
  runtime: Map<string, EnvironmentRuntimeState>;
  /** The branch of each running dev container that has one (none for a detached HEAD or a failed read). */
  branches: Map<string, string>;
}

/** The part of ContainerAdapter that readEnvironmentStates uses. */
export type StateDocker = Pick<ContainerAdapter, 'listEnvironmentContainers' | 'listEnvironmentVolumes' | 'volumeExists' | 'exec'>;

/** At most this many branches are read at the same time. */
export const BRANCH_READ_CONCURRENCY = 4;
export const BRANCH_EXEC_TIMEOUT_MS = 15_000;

/**
 * The branch of the repository at `folder` in a running container (`git branch --show-current` through `docker exec`,
 * without `-i` and without variables): `null` for a detached HEAD, `undefined` when Git is missing, fails, or `signal`
 * aborts.
 */
export async function readBranch(
  docker: Pick<ContainerAdapter, 'exec'>,
  container: string,
  user: string | undefined,
  folder: string,
  signal?: AbortSignal,
): Promise<string | null | undefined> {
  try {
    const result = await docker.exec(container, ['git', '-c', 'safe.directory=*', '-C', folder, 'branch', '--show-current'], {
      user,
      timeoutMs: BRANCH_EXEC_TIMEOUT_MS,
      signal,
    });
    if (result.exitCode !== 0) return undefined;
    const branch = result.stdout.trim();
    return branch === '' ? null : branch;
  } catch {
    return undefined;
  }
}

/**
 * The container and volume state of each environment, and the branches of the running dev containers (at most
 * BRANCH_READ_CONCURRENCY at a time). Throws when the containers or the volumes cannot be listed.
 */
export async function readEnvironmentStates(docker: StateDocker, environments: readonly StateEnvironment[]): Promise<EnvironmentStates> {
  const [containers, volumes] = await Promise.all([docker.listEnvironmentContainers(), docker.listEnvironmentVolumes()]);
  // Review round 7, P7-2: the state of the environment is the one of its dev container; a running container of another
  // service of Docker Compose only sets servicesRunning (before: any running container made it "running").
  const containerNames = new Map(environments.map((env) => [env.id, env.containerName]));
  const containerStates = new Map<string, ContainerState>();
  const servicesRunning = new Set<string>();
  for (const container of containers) {
    const id = container.labels[LABEL_ENVIRONMENT_ID];
    const containerName = id === undefined ? undefined : containerNames.get(id);
    if (!id || containerName === undefined) continue;
    if (!isDevContainer(container, containerName)) {
      if (container.state === 'running') servicesRunning.add(id);
    } else if (containerStates.get(id) !== 'running') {
      containerStates.set(id, container.state);
    }
  }
  const volumeNames = new Set(volumes.map((volume) => volume.name));
  const runtime = new Map<string, EnvironmentRuntimeState>();
  for (const env of environments) {
    // A volume without the labels (created outside of this extension) is found by its name.
    const volume = volumeNames.has(env.volumeName) || (await docker.volumeExists(env.volumeName));
    const state: EnvironmentRuntimeState = { container: containerStates.get(env.id) ?? 'missing', volume };
    if (servicesRunning.has(env.id)) state.servicesRunning = true;
    runtime.set(env.id, state);
  }
  const branches = new Map<string, string>();
  const limit = new Semaphore(BRANCH_READ_CONCURRENCY);
  const running = environments.filter((env) => env.branch && runtime.get(env.id)?.container === 'running');
  await Promise.all(
    running.map((env) =>
      limit.run(async () => {
        const branch = await readBranch(docker, env.containerName, env.user, env.folder);
        if (branch) branches.set(env.id, branch);
      }),
    ),
  );
  return { runtime, branches };
}
