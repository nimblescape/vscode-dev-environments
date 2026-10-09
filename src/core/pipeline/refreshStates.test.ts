// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR C: readEnvironmentStates, the refresh that runs directly and in the worker.
import { describe, expect, it } from 'vitest';
import type { ContainerInfo, ListedContainer } from '../docker/dockerObjects';
import { LABEL_ENVIRONMENT_ID } from '../names';
import type { RunResult } from '../ports';
import type { DockerEngine, EngineExecOptions } from '../worker/dockerEngine';
import { scriptCommand } from '../worker/containerScripts';
import { EngineDocker } from '../worker/engineDocker';
import { BRANCH_EXEC_TIMEOUT_MS, BRANCH_READ_CONCURRENCY, readEnvironmentStates, type StateDocker, type StateEnvironment } from './refreshStates';
import { ENV_OPS, EXPECTED_STATES, REFRESH_ENVIRONMENTS, fixtureContainerId, fixtureEngine } from './refreshStates.testkit';

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
      // (before: `git -c safe.directory=* -C <folder> branch --show-current`). Plan step 11I (U4, decision of 2026-10-08):
      // changed expectation, the exec names the dev container by its ID (before: by the recorded name).
      expect(command).toEqual(scriptCommand('branch', [REFRESH_ENVIRONMENTS.find((env) => fixtureContainerId(env.containerName) === container)!.folder]));
    }
    // No branch of an environment whose branch was not asked for (another account).
    const containers = execs.map((exec) => exec.container);
    // Plan step 11I (U4): changed expectation, the IDs of these dev containers (before: their names).
    expect([...containers].sort()).toEqual(['devenv-api', 'devenv-detached', 'devenv-git-fails'].map(fixtureContainerId).sort());
    const ops = REFRESH_ENVIRONMENTS.find((env) => env.id === ENV_OPS)!.containerName;
    expect(containers).not.toContain(ops);
    expect(containers).not.toContain(fixtureContainerId(ops));
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

describe('readEnvironmentStates: the dev container by the rule (plan step 11I, U4, decision of 2026-10-08)', () => {
  const env: StateEnvironment = { id: 'env-u4', containerName: 'devenv-u4', volumeName: 'v-u4', folder: '/workspaces/u4', branch: true };
  const listed = (id: string, name: string, state: 'running' | 'stopped', created?: string): ListedContainer => ({
    id,
    name,
    state,
    rawState: state === 'running' ? 'running' : 'exited',
    labels: { [LABEL_ENVIRONMENT_ID]: env.id },
    image: 'img',
    ...(created !== undefined ? { created } : {}),
  });
  function docker(containers: ListedContainer[], execs: string[]): StateDocker {
    return {
      listEnvironmentContainers: async () => containers,
      listEnvironmentVolumes: async () => [{ name: env.volumeName, labels: {} }],
      volumeExists: async () => true,
      exec: async (container) => (execs.push(container), { exitCode: 0, stdout: `branch-of-${container}\n`, stderr: '', timedOut: false }),
    };
  }

  it('the state of the named dev container while another dev container runs; that one sets servicesRunning, so Stop is offered', async () => {
    const execs: string[] = [];
    const states = await readEnvironmentStates(docker([listed('id-named', env.containerName, 'stopped'), listed('id-other', 'devenv-u4-old', 'running', '2026-10-08T09:00:00Z')], execs), [env]);
    expect(states.runtime.get(env.id)).toEqual({ container: 'stopped', volume: true, servicesRunning: true });
    expect(states.branches.size).toBe(0);
    expect(execs).toEqual([]);
  });

  it('without the named one: the newest running dev container by its time, its branch read by its ID; another running one sets servicesRunning', async () => {
    const execs: string[] = [];
    const containers = [
      listed('id-older', 'devenv-a', 'running', '2026-10-08T08:00:00Z'),
      // Half a second later than id-text, which sorts after it as text.
      listed('id-newer', 'devenv-b', 'running', '2026-10-08T09:00:00.5Z'),
      listed('id-text', 'devenv-c', 'running', '2026-10-08T09:00:00Z'),
    ];
    const states = await readEnvironmentStates(docker(containers, execs), [env]);
    expect(states.runtime.get(env.id)).toEqual({ container: 'running', volume: true, servicesRunning: true });
    expect(execs).toEqual(['id-newer']);
    expect(states.branches.get(env.id)).toBe('branch-of-id-newer');
  });

  it('the named running dev container alone: no servicesRunning, its branch by its ID', async () => {
    const execs: string[] = [];
    const states = await readEnvironmentStates(docker([listed('id-named', env.containerName, 'running'), listed('id-old', 'devenv-u4-old', 'stopped', '2026-10-08T09:00:00Z')], execs), [env]);
    expect(states.runtime.get(env.id)).toEqual({ container: 'running', volume: true });
    expect(execs).toEqual(['id-named']);
  });
});
