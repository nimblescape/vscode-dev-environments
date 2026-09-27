// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { silentLogger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { ContainerAdapter } from './containerAdapter';
import { DockerTargets, operationDockerTarget } from './dockerTargets';

const DOCKER = '/usr/local/bin/docker';

interface Call {
  args: string[];
  options: RunOptions;
}

/** A Docker CLI whose current context the test changes (`context`), like `docker context use` in another terminal. */
class FakeDockerCli implements ProcessRunner {
  readonly calls: Call[] = [];
  contexts: Record<string, string> = { default: 'unix:///var/run/docker.sock', 'desktop-linux': 'unix:///home/me/.docker/desktop/docker.sock', 'devenv-remote': 'ssh://box' };
  context = 'default';
  inspectFails = false;

  async run(_file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ args: [...args], options });
    if (args[0] === 'context' && args[1] === 'inspect') {
      if (this.inspectFails) return { exitCode: 1, stdout: '', stderr: 'context "x": context not found', timedOut: false };
      const host = options.env?.DOCKER_HOST;
      const name = host ? 'default' : (options.env?.DOCKER_CONTEXT ?? this.context);
      const endpoint = host ?? this.contexts[name];
      return { exitCode: 0, stdout: `${JSON.stringify({ Name: name, Endpoints: { docker: { Host: endpoint } } })}\n`, stderr: '', timedOut: false };
    }
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  }
}

function setup(env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }, cliFound = true) {
  const dockerPath = cliFound ? DOCKER : undefined;
  const cli = new FakeDockerCli();
  const docker = new ContainerAdapter(cli, dockerPath, env, silentLogger, 'linux');
  const targets = new DockerTargets(docker, env, silentLogger, 'linux');
  return { cli, docker, targets };
}

describe('DockerTargets.resolve (remote mode detection from the current context)', () => {
  it('reads the local Docker of the current context', async () => {
    const { targets, cli } = setup();
    await expect(targets.resolve()).resolves.toEqual({ kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock', context: 'default' });
    expect(cli.calls[0].args).toEqual(['context', 'inspect', '--format', '{{json .}}']);
    expect(targets.last?.kind).toBe('local');
  });

  it('reads an ssh:// context as the remote host after ssh://', async () => {
    const { targets, cli } = setup();
    cli.context = 'devenv-remote';
    await expect(targets.resolve()).resolves.toEqual({ kind: 'remote', host: 'box', endpoint: 'ssh://box', context: 'devenv-remote' });
    await expect(targets.host()).resolves.toBe('box');
  });

  it('follows DOCKER_HOST of VS Code, without a context name', async () => {
    const { targets } = setup({ PATH: '/usr/bin', DOCKER_HOST: 'ssh://me@other' });
    await expect(targets.resolve()).resolves.toEqual({ kind: 'remote', host: 'me@other', endpoint: 'ssh://me@other' });
  });

  it('refuses tcp to another computer', async () => {
    const { targets, cli } = setup();
    cli.contexts.default = 'tcp://192.0.2.10:2376';
    await expect(targets.resolve()).resolves.toMatchObject({ kind: 'unsupported', host: 'tcp://192.0.2.10:2376' });
  });

  it('assumes the local Docker without a CLI, or when the context cannot be read', async () => {
    const withoutCli = setup({ PATH: '/usr/bin' }, false);
    await expect(withoutCli.targets.resolve()).resolves.toEqual({ kind: 'local', host: '', endpoint: '' });
    expect(withoutCli.cli.calls).toEqual([]);
    const broken = setup();
    broken.cli.inspectFails = true;
    await expect(broken.targets.resolve()).resolves.toEqual({ kind: 'local', host: '', endpoint: '' });
  });

  it('reads the context again for each operation, not once for ever', async () => {
    const { targets, cli } = setup();
    await expect(targets.host()).resolves.toBe('');
    cli.context = 'devenv-remote';
    await expect(targets.host()).resolves.toBe('box');
  });
});

describe('DockerTargets.withOperation (an operation keeps the host it started with)', () => {
  it('reads the target once; a switch in the middle does not move the operation', async () => {
    const { targets, cli, docker } = setup();
    cli.context = 'devenv-remote';
    await targets.withOperation(async () => {
      expect(operationDockerTarget()?.host).toBe('box');
      // The user runs `docker context use default` meanwhile.
      cli.context = 'default';
      await expect(targets.host()).resolves.toBe('box');
      await docker.run(['ps']);
      // A nested operation keeps it too.
      await targets.withOperation(async () => {
        await expect(targets.host()).resolves.toBe('box');
      });
    });
    const inspects = cli.calls.filter((call) => call.args[1] === 'inspect');
    expect(inspects).toHaveLength(1);
    // Every Docker call of the operation names the context it started with.
    const ps = cli.calls.find((call) => call.args[0] === 'ps');
    expect(ps?.options.env?.DOCKER_CONTEXT).toBe('devenv-remote');
    expect(ps?.options.env).not.toHaveProperty('DOCKER_HOST');
    // The next operation reads the new context.
    await targets.withOperation(async () => {
      await expect(targets.host()).resolves.toBe('');
    });
    expect(operationDockerTarget()).toBeUndefined();
  });

  it('leaves the Docker calls outside of an operation, and with DOCKER_HOST, as they are', async () => {
    const plain = setup();
    await plain.docker.run(['ps']);
    expect(plain.cli.calls[0].options.env).not.toHaveProperty('DOCKER_CONTEXT');
    const withHost = setup({ PATH: '/usr/bin', DOCKER_HOST: 'ssh://me@other' });
    await withHost.targets.withOperation(() => withHost.docker.run(['ps']));
    const ps = withHost.cli.calls.find((call) => call.args[0] === 'ps');
    expect(ps?.options.env).not.toHaveProperty('DOCKER_CONTEXT');
    expect(ps?.options.env?.DOCKER_HOST).toBe('ssh://me@other');
  });

  it('keeps an explicit environment of a call (docker --config for a pull) as the caller built it', async () => {
    const { targets, cli, docker } = setup();
    cli.context = 'devenv-remote';
    await targets.withOperation(() => docker.run(['--config', '/tmp/x', 'pull', 'img'], { env: { DOCKER_HOST: 'ssh://box' } }));
    const pull = cli.calls.find((call) => call.args.includes('pull'));
    expect(pull?.options.env).toEqual({ DOCKER_HOST: 'ssh://box' });
  });

  it('a timer that an operation started reads the context again after the operation ended', async () => {
    const { targets, cli, docker } = setup();
    cli.context = 'devenv-remote';
    let later: Promise<string> | undefined;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await targets.withOperation(async () => {
      later = gate.then(async () => {
        await docker.run(['ps']);
        return targets.host();
      });
    });
    cli.context = 'default';
    release();
    await expect(later).resolves.toBe('');
    expect(cli.calls.find((call) => call.args[0] === 'ps')?.options.env).not.toHaveProperty('DOCKER_CONTEXT');
  });
});
