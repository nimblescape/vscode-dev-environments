// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR C: readEnvironmentStates, the refresh that runs directly and in the worker.
import { describe, expect, it } from 'vitest';
import type { ContainerInfo } from '../docker/dockerObjects';
import { LABEL_ENVIRONMENT_ID } from '../names';
import type { RunResult } from '../ports';
import type { DockerEngine, EngineExecOptions } from '../worker/dockerEngine';
import { scriptCommand } from '../worker/containerScripts';
import { EngineDocker } from '../worker/engineDocker';
import { BRANCH_EXEC_TIMEOUT_MS, BRANCH_READ_CONCURRENCY, readEnvironmentStates, type StateDocker, type StateEnvironment } from './refreshStates';
import { ENV_OPS, EXPECTED_STATES, REFRESH_ENVIRONMENTS, fixtureEngine } from './refreshStates.testkit';

/**
 * Plan step 11I2: the Docker of the refresh is the worker's EngineDocker over the engine of the fixture (fixtureEngine,
 * whose every other method fails: unusedEngine), in place of the removed CLI adapter ContainerAdapter over a fake Docker
 * CLI. Records the options of each exec.
 */
function engineDocker(): { docker: EngineDocker; execs: Array<{ container: string; command: readonly string[]; options: EngineExecOptions }> } {
  const { engine } = fixtureEngine();
  const execs: Array<{ container: string; command: readonly string[]; options: EngineExecOptions }> = [];
  const recording: DockerEngine = {
    ...engine,
    exec: (container, command, options = {}) => {
      execs.push({ container, command, options });
      return engine.exec(container, command, options);
    },
  };
  return { docker: new EngineDocker(recording), execs };
}

describe('readEnvironmentStates (plan step 5, PR C)', () => {
  it('reads the states of the dev containers and volumes, and the branches of the running ones that were asked for', async () => {
    expect(await readEnvironmentStates(engineDocker().docker, REFRESH_ENVIRONMENTS)).toEqual(EXPECTED_STATES);
  });

  it('only reads, and no exec has an input, a secret input or variables', async () => {
    const { docker, execs } = engineDocker();
    await readEnvironmentStates(docker, REFRESH_ENVIRONMENTS);
    // Plan step 11I2: changed expectation (before: the arguments and options of each call of the Docker CLI of the removed
    // ContainerAdapter, each one that only reads by isReadOnlyDockerCall): the refresh runs over the Engine API, whose
    // fake answers only the reads of the refresh and exec (fixtureEngine over unusedEngine: any other call fails the
    // refresh), and each exec has no standard input, no secret input and no variables (EngineExecOptions has no `env`).
    for (const { container, command, options } of execs) {
      expect(options.input).toBeUndefined();
      expect(options.secretInputName).toBeUndefined();
      expect(Object.keys(options).every((key) => ['user', 'timeoutMs', 'signal'].includes(key))).toBe(true);
      // Plan step 11I (PR B): changed expectation, the script `branch` of the registry in the folder of the environment
      // (before: `git -c safe.directory=* -C <folder> branch --show-current`).
      expect(command).toEqual(scriptCommand('branch', [REFRESH_ENVIRONMENTS.find((env) => env.containerName === container)!.folder]));
    }
    // No branch of an environment whose branch was not asked for (another account).
    const containers = execs.map((exec) => exec.container);
    expect([...containers].sort()).toEqual(['devenv-api', 'devenv-detached', 'devenv-git-fails']);
    expect(containers).not.toContain(REFRESH_ENVIRONMENTS.find((env) => env.id === ENV_OPS)?.containerName);
    // PR #72 review round 1 (B-R1-1): every branch read has a time limit, so a stuck exec cannot hang the refresh.
    expect(execs.length).toBe(3);
    for (const exec of execs) expect(exec.options.timeoutMs).toBe(BRANCH_EXEC_TIMEOUT_MS);
  });

  // PR #72 review round 1 (B-R1-2): a leftover stopped dev container never hides the running one.
  for (const order of ['running first', 'stopped first'] as const) {
    it(`shows an environment with a running and a stopped dev container as running (${order})`, async () => {
      const dev = (name: string, running: boolean): ContainerInfo => ({
        id: name,
        name,
        state: running ? 'running' : 'stopped',
        rawState: running ? 'running' : 'exited',
        labels: { [LABEL_ENVIRONMENT_ID]: 'env-dup' },
        image: 'img',
        volumes: [],
        volumeSubpaths: [],
        mountTargets: [],
      });
      const pair = [dev('devenv-dup', true), dev('devenv-dup-old', false)];
      const docker: StateDocker = {
        listEnvironmentContainers: async () => (order === 'running first' ? pair : [...pair].reverse()),
        listEnvironmentVolumes: async () => [{ name: 'v-dup', labels: {} }],
        volumeExists: async () => true,
        exec: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }),
      };
      const env: StateEnvironment = { id: 'env-dup', containerName: 'devenv-dup', volumeName: 'v-dup', folder: '/workspaces/r', branch: false };
      const states = await readEnvironmentStates(docker, [env]);
      expect(states.runtime.get('env-dup')?.container).toBe('running');
    });
  }

  it('fails when the containers cannot be listed', async () => {
    const docker: StateDocker = {
      listEnvironmentContainers: async () => {
        throw new Error('Cannot connect to the Docker daemon');
      },
      listEnvironmentVolumes: async () => [],
      volumeExists: async () => false,
      exec: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }),
    };
    await expect(readEnvironmentStates(docker, REFRESH_ENVIRONMENTS)).rejects.toThrow(/Docker daemon/);
  });

  it(`reads at most ${BRANCH_READ_CONCURRENCY} branches at a time`, async () => {
    const environments: StateEnvironment[] = Array.from({ length: 10 }, (_, index) => ({
      id: `env-${index}`,
      containerName: `c-${index}`,
      volumeName: `v-${index}`,
      folder: `/workspaces/r${index}`,
      branch: true,
    }));
    const containers: ContainerInfo[] = environments.map((env) => ({
      id: env.containerName,
      name: env.containerName,
      state: 'running',
      rawState: 'running',
      labels: { [LABEL_ENVIRONMENT_ID]: env.id },
      image: 'img',
      volumes: [],
      volumeSubpaths: [],
      mountTargets: [],
    }));
    let active = 0;
    let peak = 0;
    const docker: StateDocker = {
      listEnvironmentContainers: async () => containers,
      listEnvironmentVolumes: async () => environments.map((env) => ({ name: env.volumeName, labels: {} })),
      volumeExists: async () => true,
      exec: async (container): Promise<RunResult> => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { exitCode: 0, stdout: `b-${container}\n`, stderr: '', timedOut: false };
      },
    };
    const states = await readEnvironmentStates(docker, environments);
    expect(peak).toBe(BRANCH_READ_CONCURRENCY);
    expect(states.branches.size).toBe(10);
    expect(states.branches.get('env-3')).toBe('b-c-3');
  });
});
