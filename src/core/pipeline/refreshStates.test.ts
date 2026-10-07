// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR C: readEnvironmentStates, the refresh that runs directly and in the worker.
import { describe, expect, it } from 'vitest';
import { ContainerAdapter, type ContainerInfo } from '../docker/containerAdapter';
import { isReadOnlyDockerCall } from '../docker/dockerCli';
import { LABEL_ENVIRONMENT_ID } from '../names';
import { silentLogger, type RunResult } from '../ports';
import { BRANCH_EXEC_TIMEOUT_MS, BRANCH_READ_CONCURRENCY, readEnvironmentStates, type StateDocker, type StateEnvironment } from './refreshStates';
import { ENV_OPS, EXPECTED_STATES, FixtureRunner, REFRESH_ENVIRONMENTS } from './refreshStates.testkit';

function adapter(runner: FixtureRunner): ContainerAdapter {
  return new ContainerAdapter(runner, '/usr/bin/docker', {}, silentLogger, 'linux');
}

describe('readEnvironmentStates (plan step 5, PR C)', () => {
  it('reads the states of the dev containers and volumes, and the branches of the running ones that were asked for', async () => {
    const runner = new FixtureRunner();
    expect(await readEnvironmentStates(adapter(runner), REFRESH_ENVIRONMENTS)).toEqual(EXPECTED_STATES);
  });

  it('only reads, and every call can go through the worker: no input, no variables, no exec -i', async () => {
    const runner = new FixtureRunner();
    await readEnvironmentStates(adapter(runner), REFRESH_ENVIRONMENTS);
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const { args, options } of runner.calls) {
      expect(options.input).toBeUndefined();
      expect(args).not.toContain('-i');
      expect(args).not.toContain('-e');
      expect(args).not.toContain('--env');
      // Plan step 11I1, PR B2: changed expectation (before: isRoutableDockerCall, removed with the routing through the
      // worker): the same plainness checked directly: no global option, no folder, no streamed output (the environment
      // is the one that runDirect adds, the adapter's own with the Docker context of the operation).
      expect(args[0]?.startsWith('-')).toBe(false);
      expect(args.some((arg) => arg === '--env-file' || arg.startsWith('--env=') || arg.startsWith('--env-file='))).toBe(false);
      expect(options.cwd).toBeUndefined();
      expect(options.onStdout).toBeUndefined();
      expect(options.onStderr).toBeUndefined();
      if (args[0] !== 'exec') expect(isReadOnlyDockerCall(args)).toBe(true);
    }
    // No branch of an environment whose branch was not asked for (another account).
    const execs = runner.calls.filter((call) => call.args[0] === 'exec').map((call) => call.args[call.args.indexOf('git') - 1]);
    expect(execs.sort()).toEqual(['devenv-api', 'devenv-detached', 'devenv-git-fails']);
    expect(execs).not.toContain(REFRESH_ENVIRONMENTS.find((env) => env.id === ENV_OPS)?.containerName);
    // PR #72 review round 1 (B-R1-1): every branch read has a time limit, so a stuck exec cannot hang the refresh.
    const execCalls = runner.calls.filter((call) => call.args[0] === 'exec');
    expect(execCalls.length).toBe(3);
    for (const call of execCalls) expect(call.options.timeoutMs).toBe(BRANCH_EXEC_TIMEOUT_MS);
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
