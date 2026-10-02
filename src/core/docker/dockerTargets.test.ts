// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { silentLogger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { ContainerAdapter } from './containerAdapter';
import { CONTEXT_INSPECT_TIMEOUT_MS, DockerTargets, operationDockerTarget, runWithDockerTarget } from './dockerTargets';

const DOCKER = '/usr/local/bin/docker';

interface Call {
  args: string[];
  options: RunOptions;
}

/** A Docker CLI whose current context the test changes (`context`), like `docker context use` in another terminal. */
class FakeDockerCli implements ProcessRunner {
  readonly calls: Call[] = [];
  contexts: Record<string, string> = { default: 'unix:///var/run/docker.sock', 'desktop-linux': 'unix:///home/me/.docker/desktop/docker.sock', 'devenv-remote-26f8567f': 'ssh://box' };
  context = 'default';
  inspectFails = false;

  async run(_file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ args: [...args], options });
    if (args[0] === 'context' && args[1] === 'inspect') {
      if (this.inspectFails) return { exitCode: 1, stdout: '', stderr: 'context "x": context not found', timedOut: false };
      const host = options.env?.DOCKER_HOST;
      // Review round 1 of PR #85 (A-R1-3): `docker context inspect --format {{json .}} <name>` reads a named context.
      const named = args[4];
      if (named !== undefined && !(named in this.contexts)) return { exitCode: 1, stdout: '', stderr: `context "${named}": context not found`, timedOut: false };
      const name = host ? 'default' : (named ?? options.env?.DOCKER_CONTEXT ?? this.context);
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
    cli.context = 'devenv-remote-26f8567f';
    await expect(targets.resolve()).resolves.toEqual({ kind: 'remote', host: 'box', endpoint: 'ssh://box', context: 'devenv-remote-26f8567f' });
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
    cli.context = 'devenv-remote-26f8567f';
    await expect(targets.host()).resolves.toBe('box');
  });
});

describe('DockerTargets.withOperation (an operation keeps the host it started with)', () => {
  // Review round 4 of PR #57 (L2): background work of an operation (the image list of the remote monitor) that it pins
  // with runWithDockerTarget keeps the target after the operation ended, also when the context was switched meanwhile.
  it('background work pinned to the target of an operation keeps it after the operation ended', async () => {
    const { targets, cli } = setup();
    cli.context = 'devenv-remote-26f8567f';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let later: Promise<string | undefined> | undefined;
    let unpinned: Promise<string | undefined> | undefined;
    await targets.withOperation(async () => {
      const target = operationDockerTarget()!;
      later = runWithDockerTarget(target, async () => {
        await gate;
        return operationDockerTarget()?.host;
      });
      unpinned = (async () => {
        await gate;
        return operationDockerTarget()?.host;
      })();
    });
    cli.context = 'default';
    release();
    expect(await later).toBe('box');
    expect(await unpinned).toBeUndefined();
  });

  it('reads the target once; a switch in the middle does not move the operation', async () => {
    const { targets, cli, docker } = setup();
    cli.context = 'devenv-remote-26f8567f';
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
    expect(ps?.options.env?.DOCKER_CONTEXT).toBe('devenv-remote-26f8567f');
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
    cli.context = 'devenv-remote-26f8567f';
    await targets.withOperation(() => docker.run(['--config', '/tmp/x', 'pull', 'img'], { env: { DOCKER_HOST: 'ssh://box' } }));
    const pull = cli.calls.find((call) => call.args.includes('pull'));
    expect(pull?.options.env).toEqual({ DOCKER_HOST: 'ssh://box' });
  });

  it('a timer that an operation started reads the context again after the operation ended', async () => {
    const { targets, cli, docker } = setup();
    cli.context = 'devenv-remote-26f8567f';
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

// User request 2026-09-28: the view shows the Docker host of every read.
describe('DockerTargets.onDidResolve', () => {
  it('gives every read target to the listener until it is removed', async () => {
    const { targets, cli } = setup();
    const seen: string[] = [];
    const remove = targets.onDidResolve((target) => seen.push(`${target.kind}:${target.host}`));
    await targets.resolve();
    cli.context = 'devenv-remote-26f8567f';
    await targets.resolve();
    remove();
    await targets.resolve();
    expect(seen).toEqual(['local:', 'remote:box']);
  });

  it('keeps reading when a listener throws, and tells the others', async () => {
    const { targets } = setup();
    const seen: string[] = [];
    targets.onDidResolve(() => {
      throw new Error('broken');
    });
    targets.onDidResolve((target) => seen.push(target.kind));
    await expect(targets.resolve()).resolves.toMatchObject({ kind: 'local' });
    expect(seen).toEqual(['local']);
  });
});

// Review of the sidebar host (S4): of overlapping reads, the one that started last wins.
describe('DockerTargets.resolve with overlapping reads', () => {
  it('does not let an older read that finishes later overwrite a newer one', async () => {
    const results = [
      { exitCode: 0, stdout: JSON.stringify({ Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }), stderr: '', timedOut: false },
      { exitCode: 0, stdout: JSON.stringify({ Name: 'devenv-remote-26f8567f', Endpoints: { docker: { Host: 'ssh://box' } } }), stderr: '', timedOut: false },
    ];
    const gates: Array<(value: RunResult) => void> = [];
    const docker = { isInstalled: () => true, run: async (): Promise<RunResult> => new Promise<RunResult>((resolve) => gates.push(resolve)) };
    const targets = new DockerTargets(docker, {}, silentLogger, 'linux');
    const seen: string[] = [];
    targets.onDidResolve((target) => seen.push(target.host));
    const older = targets.resolve();
    const newer = targets.resolve();
    gates[1](results[1]);
    await newer;
    gates[0](results[0]);
    await expect(older).resolves.toMatchObject({ kind: 'local' });
    expect(seen).toEqual(['box']);
    expect(targets.last?.host).toBe('box');
  });
});

// Review round 1 of PR #85 (A-R1-3): the engine of a window's own Docker context, whatever context is current.
describe('DockerTargets.ofContext', () => {
  it('reads the named context, not the current one, and changes neither `last` nor tells a listener', async () => {
    const { targets, cli } = setup();
    cli.context = 'devenv-remote-26f8567f';
    const seen: string[] = [];
    targets.onDidResolve((target) => seen.push(target.host));
    await expect(targets.ofContext('desktop-linux')).resolves.toEqual({
      kind: 'local',
      host: '',
      endpoint: 'unix:///home/me/.docker/desktop/docker.sock',
      context: 'desktop-linux',
    });
    expect(cli.calls[0].args).toEqual(['context', 'inspect', '--format', '{{json .}}', 'desktop-linux']);
    expect(targets.last).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('is undefined for a context that cannot be read, a name that is no context name, or without a Docker CLI', async () => {
    const { targets, cli } = setup();
    await expect(targets.ofContext('gone')).resolves.toBeUndefined();
    await expect(targets.ofContext('--host=tcp://x')).resolves.toBeUndefined();
    expect(cli.calls.map((call) => call.args[4])).toEqual(['gone']);
    await expect(setup({ PATH: '/usr/bin' }, false).targets.ofContext('default')).resolves.toBeUndefined();
  });

  // Review round 3 of PR #85 (mutants D03, D09, D11; B-R3-6): bounded, never an option, never throws.
  function reader(run: (args: readonly string[], options?: RunOptions) => Promise<RunResult>, installed: () => boolean = () => true) {
    const calls: Array<{ args: readonly string[]; options?: RunOptions }> = [];
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const targets = new DockerTargets(
      {
        isInstalled: installed,
        run: (args, options) => {
          calls.push({ args, options });
          return run(args, options);
        },
      },
      { PATH: '/usr/bin' },
      logger,
      'linux',
    );
    return { targets, calls, warnings };
  }
  const inspected = async (): Promise<RunResult> => ({
    exitCode: 0,
    stdout: JSON.stringify({ Name: 'desktop-linux', Endpoints: { docker: { Host: 'unix:///home/me/.docker/desktop/docker.sock' } } }),
    stderr: '',
    timedOut: false,
  });

  it('reads the context within CONTEXT_INSPECT_TIMEOUT_MS', async () => {
    const r = reader(inspected);
    await expect(r.targets.ofContext('desktop-linux')).resolves.toMatchObject({ context: 'desktop-linux' });
    expect(r.calls[0].options?.timeoutMs).toBe(CONTEXT_INSPECT_TIMEOUT_MS);
  });

  it('is undefined with a warning when the Docker CLI rejects or the check of the CLI throws; never throws', async () => {
    const r = reader(() => Promise.reject(new Error('spawn docker EACCES')));
    await expect(r.targets.ofContext('desktop-linux')).resolves.toBeUndefined();
    expect(r.warnings).toEqual(['The Docker context desktop-linux could not be read: spawn docker EACCES']);
    const s = reader(inspected, () => {
      throw new Error('stat failed');
    });
    await expect(s.targets.ofContext('desktop-linux')).resolves.toBeUndefined();
    expect(s.warnings).toHaveLength(1);
  });

  it('never passes a name that starts with a dash (an option) to the CLI', async () => {
    const r = reader(inspected);
    await expect(r.targets.ofContext('-D')).resolves.toBeUndefined();
    await expect(r.targets.ofContext('--help')).resolves.toBeUndefined();
    expect(r.calls).toEqual([]);
  });

  it('follows DOCKER_HOST of VS Code, as resolve does', async () => {
    const { targets } = setup({ PATH: '/usr/bin', DOCKER_HOST: 'unix:///run/user/1000/docker.sock' });
    await expect(targets.ofContext('desktop-linux')).resolves.toEqual({ kind: 'local', host: '', endpoint: 'unix:///run/user/1000/docker.sock' });
  });
});
