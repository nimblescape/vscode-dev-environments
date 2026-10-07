// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// PR #119 review round 1 (B, mutation testing): probes for the refusal of a docker exec with a secret input.
import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import { silentLogger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { ContainerAdapter } from './containerAdapter';

class Runner implements ProcessRunner {
  readonly calls: string[][] = [];
  async run(_file: string, args: readonly string[], _options: RunOptions = {}): Promise<RunResult> {
    this.calls.push([...args]);
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  }
}

describe('ContainerAdapter.exec with a secret input (PR #119, B-R1)', () => {
  it('refuses by a rejected promise, never a synchronous throw, naming the call as exec -i', async () => {
    const runner = new Runner();
    const docker = new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux');
    let result: unknown;
    expect(() => {
      result = docker.exec('c1', ['sh', '-c', 'cat > /run/token'], { user: 'root', secretInput: 'gho_SECRET' });
    }).not.toThrow();
    expect(result).toBeInstanceOf(Promise);
    const error = await (result as Promise<RunResult>).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).command).toContain('exec -i -u root c1');
    expect((error as CommandError).command).not.toContain('gho_SECRET');
    expect(runner.calls).toEqual([]);
  });
});
