// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review 11F2 R2 (mutation testing): ContainerAdapter.containerState (moved from BootstrapDocker in review round 1 of
// PR #113). The read has the deadline of a Docker query, so a Docker that does not answer cannot hold the worker's read
// of the window forever; and an output that is not a state string is an error, never a stopped container.
import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import { silentLogger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { DOCKER_QUERY_TIMEOUT_MS } from './bootstrapDocker';
import { ContainerAdapter } from './containerAdapter';

function adapter(stdout: string): { docker: ContainerAdapter; options: RunOptions[] } {
  const options: RunOptions[] = [];
  const runner: ProcessRunner = {
    async run(_file: string, _args: readonly string[], runOptions: RunOptions = {}): Promise<RunResult> {
      options.push(runOptions);
      return { exitCode: 0, stdout, stderr: '', timedOut: false };
    },
  };
  return { docker: new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux'), options };
}

describe('ContainerAdapter.containerState (review 11F2 R2)', () => {
  it('reads the state with the deadline of a Docker query', async () => {
    const { docker, options } = adapter('"exited"\n');
    expect(await docker.containerState('c')).toBe('stopped');
    expect(options[0].timeoutMs).toBe(DOCKER_QUERY_TIMEOUT_MS);
  });

  it.each(['null\n', '{"Status":"running"}\n', '42\n'])('reports the output %j as an error, not as a stopped container', async (stdout) => {
    const { docker } = adapter(stdout);
    await expect(docker.containerState('c')).rejects.toBeInstanceOf(CommandError);
  });
});
