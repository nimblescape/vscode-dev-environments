// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review 11F2 R1 (mutation testing): BootstrapDocker keeps the operation on its Docker host also with a second spelling
// of DOCKER_CONTEXT (Windows), forgets a lost CLI only when it is still the one that failed, and never counts a Docker
// call that changes something as one that only reads (which would be repeated after an SSH drop and not be logged).
import { describe, expect, it } from 'vitest';
import { silentLogger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { BootstrapDocker } from './bootstrapDocker';
import { isReadOnlyDockerCall } from './dockerCli';
import { dockerTargetOf, remoteContextNames } from './dockerHost';
import { runWithDockerTarget } from './dockerTargets';

const OK: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };

describe('BootstrapDocker (review 11F2 R1)', () => {
  it('gives an operation exactly one DOCKER_CONTEXT, also when the environment spells it otherwise (Windows)', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const runner: ProcessRunner = {
      async run(_file: string, _args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
        envs.push(options.env ?? {});
        return OK;
      },
    };
    const docker = new BootstrapDocker(runner, 'C:\\Docker\\docker.exe', { Path: 'C:\\Windows', Docker_Context: 'desktop-linux' }, silentLogger, 'win32');
    const context = remoteContextNames('build-box')[0];
    await runWithDockerTarget(dockerTargetOf('ssh://build-box', context), () => docker.run(['container', 'inspect', 'x']));
    const keys = Object.keys(envs[0]).filter((key) => key.toUpperCase() === 'DOCKER_CONTEXT');
    expect(keys).toEqual(['DOCKER_CONTEXT']);
    expect(envs[0].DOCKER_CONTEXT).toBe(context);
  });

  it('keeps a CLI found again meanwhile when an older call fails with ENOENT', async () => {
    const OLD = '/old/docker';
    const NEW = '/new/docker';
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const runner: ProcessRunner = {
      async run(file: string): Promise<RunResult> {
        calls++;
        if (file === OLD && calls === 1) {
          // The first call hangs until the CLI was lost and found again, then fails like the others on the old path.
          await new Promise<void>((resolve) => (releaseFirst = resolve));
          throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
        }
        if (file === OLD) throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
        return OK;
      },
    };
    let lost = 0;
    let found: string | undefined;
    const docker = new BootstrapDocker(runner, OLD, {}, silentLogger, 'linux', { findDocker: () => found, onCliLost: () => void lost++ });
    const first = docker.run(['image', 'rm', 'a']);
    await expect(docker.run(['image', 'rm', 'b'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    expect(lost).toBe(1);
    found = NEW;
    expect(docker.lookUpCliNow()).toBe(true);
    expect(docker.dockerPath).toBe(NEW);
    releaseFirst?.();
    await expect(first).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    // The failure of the old path does not drop the CLI that was found since.
    expect(docker.dockerPath).toBe(NEW);
    expect(lost).toBe(1);
  });
});

describe('isReadOnlyDockerCall (review 11F2 R1)', () => {
  it('counts no call that changes something as one that only reads (it would be repeated and not logged)', () => {
    const changing: string[][] = [];
    for (const object of ['container', 'image', 'volume', 'network', 'context', 'system']) {
      for (const command of ['rm', 'remove', 'prune', 'create', 'update', 'use', 'kill', 'stop', 'start', 'restart', 'rename', 'tag', 'push', 'pull', 'load', 'import', 'connect', 'disconnect', 'commit', 'cp']) {
        changing.push([object, command, 'x']);
      }
    }
    for (const command of ['rm', 'rmi', 'run', 'exec', 'create', 'start', 'stop', 'kill', 'build', 'pull', 'push', 'tag', 'cp', 'commit', 'rename', 'update', 'login', 'logout', 'load', 'import']) {
      changing.push([command, 'x'], ['--context', 'box', command, 'x']);
    }
    expect(changing.filter((args) => isReadOnlyDockerCall(args)).map((args) => args.join(' '))).toEqual([]);
  });
});
