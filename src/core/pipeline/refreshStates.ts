// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR C: the states of the environments and the branches of their running dev containers, read in one go.
// It runs in the worker (the operation `refresh`, src/helperChannel/operations.ts; plan step 11C1: only there, never
// directly in the extension). It only reads. Pure: no `vscode`, and nothing of the
// service, so that the script of the worker stays small.
import { Semaphore } from '../concurrency';
import type { ListedContainer } from '../docker/dockerObjects';
import { errorMessage } from '../errors';
import { parseGitSummaryOutput } from '../git/gitSummary';
import { LABEL_ENVIRONMENT_ID } from '../names';
import type { ContainerState, GitSummary } from '../types';
import { runScript, type ScriptExec } from '../worker/containerScripts';
import { devContainerOf } from '../worker/environmentContainers';
// Plan step 11I2: a type only (no code of the service in the worker's script).
import type { EnvironmentDocker } from './environmentPorts';

/** State of the container and the volume of an environment. */
export interface EnvironmentRuntimeState {
  /**
   * Review round 7, P7-2: the state of the dev container only (isDevContainer), not of the other services. Plan step 11I
   * (U4, decision of 2026-10-08): of the dev container by the rule (devContainerOf), as the open connects to it.
   */
  container: ContainerState;
  volume: boolean;
  /**
   * Review round 7, P7-2: `true` when a container of another service of Docker Compose (label
   * nimblescape.devenv.compose-service) runs; not set otherwise. Stop stays offered while it runs, also when the dev
   * container is stopped. Plan step 11I (U4): when any other container of the environment runs, a service or another dev
   * container (Stop stops them all). The name of the field stays (the protocol).
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

/** The part of the pipeline's Docker that readEnvironmentStates uses (plan step 11I2: of EnvironmentDocker, was of ContainerAdapter). */
export type StateDocker = Pick<EnvironmentDocker, 'listEnvironmentContainers' | 'listEnvironmentVolumes' | 'volumeExists' | 'exec'>;

/** At most this many branches are read at the same time. */
export const BRANCH_READ_CONCURRENCY = 4;
export const BRANCH_EXEC_TIMEOUT_MS = 15_000;

/**
 * The branch of the repository at `folder` in a running container (through `docker exec`, without `-i` and without
 * variables): `null` for a detached HEAD, `undefined` when Git is missing, fails, or `signal` aborts. Plan step 11I (PR B,
 * one function per fact): the script `branch` of the registry (GIT_BRANCH_SCRIPT of gitSummary.ts), which reads the
 * branch as the Git state does (GIT_BRANCH_FUNCTION: no hooks, the C locale, `safe.directory`, and `git symbolic-ref -q
 * HEAD`, a branch only below refs/heads/, review round 1 of PR #124); before, `git -c safe.directory=* -C <folder> branch
 * --show-current`, which Git before 2.22 refused.
 */
export async function readBranch(
  docker: Pick<EnvironmentDocker, 'exec'>,
  container: string,
  user: string | undefined,
  folder: string,
  signal?: AbortSignal,
): Promise<string | null | undefined> {
  try {
    const result = await runScript(docker, container, 'branch', [folder], {
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
 * The time limit of the script `gitSummary` (readGitSummary). Cleanup after plan step 11 (PR #138, B1): one constant (before,
 * STOP_GIT_TIMEOUT_MS of Stop and GIT_EXEC_TIMEOUT_MS of the service, both 30 s).
 */
export const GIT_SUMMARY_TIMEOUT_MS = 30_000;

/**
 * Cleanup after plan step 11 (PR #138, B1, one function per fact): the Git state of the repository at `folder` in a
 * running container, for Stop (stopFlow) and the service (the open after a clone, Delete's check, recordGitState). Before,
 * each had its own copy (stopFlow's readGitSummary, EnvironmentService.gitSummaryInContainer). The script `gitSummary`
 * of the registry runs as `user` within GIT_SUMMARY_TIMEOUT_MS; its output is parsed with the time `now()` after it.
 * Undefined when it cannot be read; the reason goes to `log` as "The Git state in <container.name> could not be read:
 * <reason>" (the end of a script that failed: "the script did not end in time.", its output, or its exit code). A
 * cancel of `signal`: with `cancel: 'throw'` (Stop) its error is thrown; with `cancel: 'fail'` (the service) it is a
 * failed read like any other, as before.
 */
export async function readGitSummary(
  docker: ScriptExec,
  container: { id: string; name: string },
  user: string | undefined,
  folder: string,
  options: { now: () => string; log: (line: string) => void; cancel: 'throw' | 'fail'; signal?: AbortSignal },
): Promise<GitSummary | undefined> {
  const failed = (reason: string): undefined => {
    options.log(`The Git state in ${container.name} could not be read: ${reason}`);
    return undefined;
  };
  try {
    const result = await runScript(docker, container.id, 'gitSummary', [folder], { user, timeoutMs: GIT_SUMMARY_TIMEOUT_MS, signal: options.signal });
    if (result.exitCode !== 0) {
      return failed(result.timedOut ? 'the script did not end in time.' : (result.stderr || result.stdout).trim() || `exit code ${result.exitCode ?? 'none'}.`);
    }
    return parseGitSummaryOutput(result.stdout, options.now());
  } catch (error) {
    if (options.cancel === 'throw' && options.signal?.aborted) throw error;
    return failed(errorMessage(error));
  }
}

/**
 * The container and volume state of each environment, and the branches of the running dev containers (at most
 * BRANCH_READ_CONCURRENCY at a time). Throws when the containers or the volumes cannot be listed.
 */
export async function readEnvironmentStates(docker: StateDocker, environments: readonly StateEnvironment[]): Promise<EnvironmentStates> {
  const [containers, volumes] = await Promise.all([docker.listEnvironmentContainers(), docker.listEnvironmentVolumes()]);
  // Review round 7, P7-2: the state of the environment is the one of its dev container; a running container of another
  // service of Docker Compose only sets servicesRunning (before: any running container made it "running"). Plan step 11I
  // (U4, decision of 2026-10-08): the dev container by the rule (devContainerOf), the one that the open connects to
  // (before: "running" when any dev container ran); any other running container of the environment, a service or another
  // dev container, sets servicesRunning, so that the sidebar offers Stop, which stops them all.
  const byEnvironment = new Map<string, ListedContainer[]>();
  for (const container of containers) {
    const id = container.labels[LABEL_ENVIRONMENT_ID];
    if (!id) continue;
    const own = byEnvironment.get(id);
    if (own === undefined) byEnvironment.set(id, [container]);
    else own.push(container);
  }
  const volumeNames = new Set(volumes.map((volume) => volume.name));
  const runtime = new Map<string, EnvironmentRuntimeState>();
  const devContainers = new Map<string, ListedContainer>();
  for (const env of environments) {
    const own = byEnvironment.get(env.id) ?? [];
    const dev = devContainerOf(own, env.containerName);
    if (dev !== undefined) devContainers.set(env.id, dev);
    // A volume without the labels (created outside of this extension) is found by its name.
    const volume = volumeNames.has(env.volumeName) || (await docker.volumeExists(env.volumeName));
    const state: EnvironmentRuntimeState = { container: dev?.state ?? 'missing', volume };
    if (own.some((other) => other.state === 'running' && other.id !== dev?.id)) state.servicesRunning = true;
    runtime.set(env.id, state);
  }
  const branches = new Map<string, string>();
  const limit = new Semaphore(BRANCH_READ_CONCURRENCY);
  const running = environments.flatMap((env) => {
    const dev = devContainers.get(env.id);
    return env.branch && dev?.state === 'running' ? [{ env, dev }] : [];
  });
  await Promise.all(
    running.map(({ env, dev }) =>
      limit.run(async () => {
        // Plan step 11I (U4): from the dev container of the rule, by its ID (before: by the recorded name).
        const branch = await readBranch(docker, dev.id, env.user, env.folder);
        if (branch) branches.set(env.id, branch);
      }),
    ),
  );
  return { runtime, branches };
}
