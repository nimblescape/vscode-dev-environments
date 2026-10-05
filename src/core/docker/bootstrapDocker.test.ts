// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F2 (decision 1 of 2026-10-03: no bypass of the worker, by construction): the Docker CLI of the extension
// is only the bootstrap's. It has no way through the worker (no router, no worker engine) and no Docker call of the flows;
// each call runs directly with the Docker context of its operation, and a call that does not only read is logged with
// its command alone.
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { BootstrapDocker } from './bootstrapDocker';
import { ContainerAdapter } from './containerAdapter';
import { dockerTargetOf, remoteContextNames } from './dockerHost';
import { runWithDockerTarget } from './dockerTargets';

interface Call {
  args: string[];
  options: RunOptions;
}

class FakeRunner implements ProcessRunner {
  readonly calls: Call[] = [];
  constructor(private readonly answer: (args: readonly string[]) => RunResult = () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })) {}
  async run(_file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ args: [...args], options });
    return this.answer(args);
  }
}

const DOCKER = '/usr/local/bin/docker';

/** The public members of a class, without the constructor. */
function members(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype).filter((name) => name !== 'constructor');
}

describe('BootstrapDocker (plan step 11F2)', () => {
  it('has only the calls of the bootstrap: no route through the worker and no Docker call of the flows', () => {
    const own = members(BootstrapDocker.prototype);
    // Review round 1 of PR #113 (A-M1): also no read of a container's state (the worker reads it, windowStateInWorker).
    for (const name of ['setRouter', 'setWorkerEngine', 'pullImage', 'startContainer', 'exec', 'removeContainer', 'stopContainer', 'createVolume', 'removeVolume', 'labelImage', 'containerState']) {
      expect(own, name).not.toContain(name);
    }
    expect(own).toEqual(
      expect.arrayContaining(['isInstalled', 'run', 'runDirect', 'start', 'daemonStatus', 'isRunning', 'imageExists', 'imageId', 'buildImage', 'listImagesByLabel', 'removeImage']),
    );
  });

  it('runs a call directly, also within an operation, with the Docker context of the operation', async () => {
    const runner = new FakeRunner();
    const docker = new BootstrapDocker(runner, DOCKER, { PATH: '/usr/bin', DOCKER_CONTEXT: 'default' }, silentLogger, 'linux');
    const context = remoteContextNames('build-box')[0];
    await runWithDockerTarget(dockerTargetOf('ssh://build-box', context), () => docker.run(['container', 'inspect', 'x']));
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args).toEqual(['container', 'inspect', 'x']);
    expect(runner.calls[0].options.env?.DOCKER_CONTEXT).toBe(context);
    expect(runner.calls[0].options.env?.DOCKER_HOST).toBeUndefined();
  });

  it('logs a call that does not only read with its command, never with its arguments', async () => {
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, info: (line: string) => void lines.push(line) };
    const docker = new BootstrapDocker(new FakeRunner(), DOCKER, { PATH: '/usr/bin' }, logger, 'linux');
    await docker.run(['image', 'rm', 'secret-looking-reference:1']);
    await docker.run(['image', 'inspect', 'other-reference:1']);
    expect(lines.filter((line) => line.includes('(direct)'))).toEqual([expect.stringMatching(/^docker image rm \(direct\): exit code 0 after /)]);
    expect(lines.join('\n')).not.toContain('secret-looking-reference');
  });

  it('is the base of the CLI adapter of the flows, which keeps its calls (plan step 11I removes it)', () => {
    expect(new ContainerAdapter(new FakeRunner(), DOCKER, {}, silentLogger, 'linux')).toBeInstanceOf(BootstrapDocker);
  });
});
