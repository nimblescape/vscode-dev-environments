// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { CommandError, UserFacingError } from '../errors';
import { Messages } from '../messages';
import { abortError, isAbortError, silentLogger, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import {
  ContainerAdapter,
  DOCKER_CLI_LOOKUP_RETRY_MS,
  isProtectedDockerEndpoint,
  mapContainerState,
  parseJsonLines,
  registryLoginConfig,
  toLabels,
} from './containerAdapter';

interface Call {
  file: string;
  args: string[];
  options: RunOptions;
}

type Handler = (call: Call) => RunResult | Promise<RunResult>;

class FakeRunner implements ProcessRunner {
  readonly calls: Call[] = [];
  constructor(private readonly handler: Handler) {}
  async run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const call = { file, args: [...args], options };
    this.calls.push(call);
    return this.handler(call);
  }
}

function ok(stdout = '', stderr = ''): RunResult {
  return { exitCode: 0, stdout, stderr, timedOut: false };
}

function fail(stderr: string, exitCode: number | null = 1, stdout = ''): RunResult {
  return { exitCode, stdout, stderr, timedOut: false };
}

const DOCKER = '/usr/local/bin/docker';

function adapter(handler: Handler, env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }): { docker: ContainerAdapter; runner: FakeRunner } {
  const runner = new FakeRunner(handler);
  return { docker: new ContainerAdapter(runner, DOCKER, env, silentLogger, 'linux'), runner };
}

function containerJson(p: {
  id: string;
  name: string;
  status: string;
  labels?: Record<string, string> | null;
  image?: string;
  created?: string;
}): Record<string, unknown> {
  return {
    Id: p.id,
    Created: p.created ?? '2026-09-24T10:00:00.000000000Z',
    Name: `/${p.name}`,
    State: { Status: p.status, Running: p.status === 'running' },
    Config: { Image: p.image ?? 'devenv-3f2a9c1e:1', Labels: p.labels === undefined ? {} : p.labels },
    Image: 'sha256:abc',
  };
}

/** docker inspect prints an indented JSON array. */
function inspectOutput(items: unknown[]): string {
  return `${JSON.stringify(items, null, 4)}\n`;
}

function idLines(ids: string[]): string {
  return ids.map((id) => `${JSON.stringify(id)}\n`).join('');
}

describe('mapContainerState', () => {
  it.each([
    ['running', 'running'],
    ['restarting', 'running'],
    ['paused', 'running'],
    ['created', 'stopped'],
    ['exited', 'stopped'],
    ['dead', 'stopped'],
    ['removing', 'stopped'],
    ['Running', 'running'],
  ] as const)('%s → %s', (raw, state) => {
    expect(mapContainerState(raw)).toBe(state);
  });
});

describe('parseJsonLines', () => {
  it('parses one value per line and skips blank and invalid lines', () => {
    expect(parseJsonLines('{"a":1}\r\n\nWARNING: something\n"x"\n')).toEqual([{ a: 1 }, 'x']);
  });
});

describe('toLabels', () => {
  it('keeps string values only and accepts null', () => {
    expect(toLabels({ a: 'b', c: 1, d: null })).toEqual({ a: 'b' });
    expect(toLabels(null)).toEqual({});
  });
});

describe('ContainerAdapter basics', () => {
  it('throws dockerNotInstalled without a CLI', async () => {
    const runner = new FakeRunner(() => ok());
    const docker = new ContainerAdapter(runner, undefined, {}, silentLogger, 'linux');
    expect(docker.isInstalled()).toBe(false);
    const error = await docker.run(['ps']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as UserFacingError).code).toBe('dockerNotInstalled');
    expect((error as UserFacingError).message).toBe(Messages.dockerNotInstalled);
    expect(await docker.isRunning()).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it('runs the CLI with PATH extended by its folder', async () => {
    const runner = new FakeRunner(() => ok());
    const docker = new ContainerAdapter(runner, '/opt/docker/bin/docker', { PATH: '/usr/bin', HOME: '/h' }, silentLogger, 'linux');
    await docker.run(['version']);
    expect(runner.calls[0].file).toBe('/opt/docker/bin/docker');
    expect(runner.calls[0].options.env?.PATH).toBe('/usr/bin:/opt/docker/bin:/usr/local/bin');
    expect(runner.calls[0].options.env?.HOME).toBe('/h');
  });

  it('keeps an explicit environment of a call', async () => {
    const { docker, runner } = adapter(() => ok());
    await docker.run(['version'], { env: { X: '1' } });
    expect(runner.calls[0].options.env).toEqual({ X: '1' });
  });

  it('maps ENOENT of the runner to dockerNotInstalled', async () => {
    const { docker } = adapter(() => {
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    });
    await expect(docker.run(['ps'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
  });

  it('runChecked returns stdout and throws CommandError on failure', async () => {
    const { docker } = adapter((call) => (call.args[0] === 'good' ? ok('out') : fail('bad things', 2)));
    expect(await docker.runChecked(['good'])).toBe('out');
    const error = await docker.runChecked(['bad', 'x']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).exitCode).toBe(2);
    expect((error as CommandError).command).toBe('docker bad x');
    expect((error as CommandError).stderr).toBe('bad things');
  });

  it('hides values of environment variables in the error (the log must not contain secrets)', async () => {
    const { docker } = adapter(() => fail('boom'));
    const args = ['run', '--rm', '-e', 'GH_TOKEN=ghp_secret', '--env', 'B=x=y', '--env=C=hidden', '-e', 'PLAIN', 'img', 'sh'];
    const error = (await docker.runChecked(args).catch((e: unknown) => e)) as CommandError;
    expect(error.command).toBe('docker run --rm -e GH_TOKEN=*** --env B=*** --env=C=*** -e PLAIN img sh');
    expect(error.message).not.toContain('ghp_secret');
    expect(error.message).not.toContain('hidden');
  });

  it('runChecked reports a timeout', async () => {
    const { docker } = adapter(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
    const error = (await docker.runChecked(['ps']).catch((e: unknown) => e)) as CommandError;
    expect(error.exitCode).toBeNull();
    expect(error.stderr).toContain('time limit');
  });
});

describe('isRunning / daemonStatus', () => {
  it('is true when docker info prints a server version', async () => {
    const { docker, runner } = adapter(() => ok('"29.8.0"\n'));
    expect(await docker.isRunning()).toBe(true);
    expect(runner.calls[0].args).toEqual(['info', '--format', '{{json .ServerVersion}}']);
    expect(runner.calls[0].options.timeoutMs).toBe(20_000);
  });

  it('is false when docker info fails', async () => {
    const { docker } = adapter(() => fail('failed to connect to the docker API at unix:///var/run/docker.sock', 1, '""\n'));
    expect(await docker.daemonStatus()).toEqual({
      running: false,
      detail: 'failed to connect to the docker API at unix:///var/run/docker.sock',
    });
  });

  it('is false for an empty server version with exit code 0', async () => {
    const { docker } = adapter(() => ok('""\n'));
    expect(await docker.isRunning()).toBe(false);
  });

  it('is false after a timeout', async () => {
    const { docker } = adapter(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
    const status = await docker.daemonStatus(undefined, 5000);
    expect(status.running).toBe(false);
    expect(status.detail).toContain('5 seconds');
  });

  it('is false when the CLI cannot be started', async () => {
    const { docker } = adapter(() => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    });
    expect(await docker.isRunning()).toBe(false);
  });

  it('passes the signal and rejects with an AbortError', async () => {
    const controller = new AbortController();
    const { docker, runner } = adapter(() => {
      throw abortError();
    });
    const error = await docker.isRunning(controller.signal).catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(runner.calls[0].options.signal).toBe(controller.signal);
  });

  it('reports each result to onDaemonStatus, also without CLI, but not a cancellation', async () => {
    const reported: boolean[] = [];
    const results = [ok('"29.8.0"\n'), fail('Cannot connect to the Docker daemon')];
    const runner = new FakeRunner(() => {
      const next = results.shift();
      if (!next) throw abortError();
      return next;
    });
    const options = { onDaemonStatus: (running: boolean) => reported.push(running) };
    const docker = new ContainerAdapter(runner, DOCKER, { PATH: '/usr/bin' }, silentLogger, 'linux', options);
    expect(await docker.isRunning()).toBe(true);
    expect(await docker.isRunning()).toBe(false);
    await expect(docker.isRunning()).rejects.toThrow();
    expect(reported).toEqual([true, false]);
    const missing = new ContainerAdapter(runner, undefined, {}, silentLogger, 'linux', options);
    expect(await missing.isRunning()).toBe(false);
    expect(reported).toEqual([true, false, false]);
  });

  it('keeps its answer when onDaemonStatus throws', async () => {
    const runner = new FakeRunner(() => ok('"29.8.0"\n'));
    const docker = new ContainerAdapter(runner, DOCKER, {}, silentLogger, 'linux', {
      onDaemonStatus: () => {
        throw new Error('listener failed');
      },
    });
    expect(await docker.isRunning()).toBe(true);
  });
});

describe('containers', () => {
  const metadata = '[{"id":"ghcr.io/devcontainers/features/node:1","settings":{"a,b":"c=d"}}]';

  it('finds the container of an environment by label and reads labels with commas', async () => {
    const { docker, runner } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines(['c1']));
      return ok(
        inspectOutput([
          containerJson({
            id: 'c1',
            name: 'devenv-acme-api-3f2a9c1e',
            status: 'exited',
            labels: { 'devenv.environment-id': 'env-1', 'devcontainer.metadata': metadata },
          }),
        ]),
      );
    });
    const info = await docker.findContainer('env-1');
    expect(runner.calls[0].args).toEqual([
      'ps',
      '-a',
      '--no-trunc',
      '--filter',
      'label=devenv.environment-id=env-1',
      '--format',
      '{{json .ID}}',
    ]);
    expect(runner.calls[1].args).toEqual(['container', 'inspect', 'c1']);
    expect(info).toEqual({
      id: 'c1',
      name: 'devenv-acme-api-3f2a9c1e',
      state: 'stopped',
      rawState: 'exited',
      labels: { 'devenv.environment-id': 'env-1', 'devcontainer.metadata': metadata },
      image: 'devenv-3f2a9c1e:1',
    });
  });

  it('returns undefined without a container and does not call inspect', async () => {
    const { docker, runner } = adapter(() => ok(''));
    expect(await docker.findContainer('env-1')).toBeUndefined();
    expect(runner.calls).toHaveLength(1);
  });

  it('prefers a running container, then the newest one', async () => {
    const { docker } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines(['old', 'new', 'run']));
      return ok(
        inspectOutput([
          containerJson({ id: 'old', name: 'a', status: 'exited', created: '2026-01-01T00:00:00Z' }),
          containerJson({ id: 'new', name: 'b', status: 'exited', created: '2026-02-01T00:00:00Z' }),
          containerJson({ id: 'run', name: 'c', status: 'running', created: '2025-01-01T00:00:00Z' }),
        ]),
      );
    });
    expect((await docker.findContainer('env-1'))?.id).toBe('run');
  });

  it('skips a container that was removed between list and inspect', async () => {
    const { docker } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines(['c1', 'gone']));
      return fail(
        'Error response from daemon: No such container: gone\n',
        1,
        inspectOutput([containerJson({ id: 'c1', name: 'x', status: 'running', labels: null })]),
      );
    });
    const list = await docker.listEnvironmentContainers();
    expect(list).toEqual([{ id: 'c1', name: 'x', state: 'running', rawState: 'running', labels: {}, image: 'devenv-3f2a9c1e:1' }]);
  });

  it('reads the named volumes that a container mounts', async () => {
    const { docker } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines(['c1']));
      const container = {
        ...(containerJson({ id: 'c1', name: 'x', status: 'running' }) as Record<string, unknown>),
        Mounts: [
          { Type: 'volume', Name: 'devenv-acme-api-3f2a9c1e', Destination: '/workspaces' },
          { Type: 'volume', Name: 'api-node_modules', Destination: '/workspaces/api/node_modules' },
          { Type: 'bind', Source: '/tmp', Destination: '/tmp' },
          { Type: 'tmpfs', Destination: '/run' },
        ],
      };
      return ok(inspectOutput([container]));
    });
    expect((await docker.listEnvironmentContainers())[0].volumes).toEqual(['devenv-acme-api-3f2a9c1e', 'api-node_modules']);
  });

  it('throws when inspect fails for another reason', async () => {
    const { docker } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines(['c1']));
      return fail('Cannot connect to the Docker daemon', 1, '[]');
    });
    await expect(docker.listEnvironmentContainers()).rejects.toBeInstanceOf(CommandError);
  });

  it('throws when docker ps fails', async () => {
    const { docker } = adapter(() => fail('Cannot connect to the Docker daemon'));
    await expect(docker.listEnvironmentContainers()).rejects.toBeInstanceOf(CommandError);
  });

  it('lists all environment containers in batches and skips malformed entries', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
    const { docker, runner } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines([...ids, 'id0']));
      const batch = call.args.slice(2);
      return ok(inspectOutput([...batch.map((id) => containerJson({ id, name: id, status: 'running' })), { Id: 'broken' }]));
    });
    const list = await docker.listEnvironmentContainers();
    expect(runner.calls[0].args).toContain('label=devenv.environment-id');
    expect(list).toHaveLength(120);
    expect(runner.calls.slice(1).map((call) => call.args.length - 2)).toEqual([50, 50, 20]);
  });

  it('containerState maps states and reports missing containers', async () => {
    const { docker, runner } = adapter((call) => {
      const name = call.args[call.args.length - 1];
      if (name === 'running') return ok('"running"\n');
      if (name === 'paused') return ok('"paused"\n');
      if (name === 'created') return ok('"created"\n');
      if (name === 'missing') return fail('Error response from daemon: No such container: missing');
      return fail('permission denied while trying to connect to the Docker daemon socket');
    });
    expect(await docker.containerState('running')).toBe('running');
    expect(await docker.containerState('paused')).toBe('running');
    expect(await docker.containerState('created')).toBe('stopped');
    expect(await docker.containerState('missing')).toBe('missing');
    await expect(docker.containerState('other')).rejects.toBeInstanceOf(CommandError);
    expect(runner.calls[0].args).toEqual(['container', 'inspect', '--format', '{{json .State.Status}}', 'running']);
  });

  it('stopContainer ignores a missing container', async () => {
    const { docker, runner } = adapter((call) =>
      call.args[1] === 'gone' ? fail('Error response from daemon: No such container: gone') : ok('x\n'),
    );
    await docker.stopContainer('x');
    await docker.stopContainer('gone');
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['stop', 'x'],
      ['stop', 'gone'],
    ]);
  });

  it('stopContainer throws for other errors', async () => {
    const { docker } = adapter(() => fail('Error response from daemon: cannot stop container: permission denied'));
    await expect(docker.stopContainer('x')).rejects.toBeInstanceOf(CommandError);
  });

  it('removeContainer uses rm -f and ignores a missing container', async () => {
    const { docker, runner } = adapter((call) =>
      call.args[2] === 'gone' ? fail('Error: No such container: gone') : ok(),
    );
    await docker.removeContainer('x');
    await docker.removeContainer('gone');
    expect(runner.calls[0].args).toEqual(['rm', '-f', 'x']);
  });

  it('removeContainer throws for other errors', async () => {
    const { docker } = adapter(() => fail('Error response from daemon: something else'));
    await expect(docker.removeContainer('x')).rejects.toBeInstanceOf(CommandError);
  });

  it('exec attaches standard input only with input', async () => {
    const { docker, runner } = adapter(() => ok('main\n'));
    const signal = new AbortController().signal;
    await docker.exec('c', ['git', 'branch'], { user: 'root', workdir: '/workspaces/api', signal, timeoutMs: 1000 });
    await docker.exec('c', ['sh', '-c', 'cat'], { input: 'secret' });
    expect(runner.calls[0].args).toEqual(['exec', '-u', 'root', '-w', '/workspaces/api', 'c', 'git', 'branch']);
    expect(runner.calls[0].options).toMatchObject({ signal, timeoutMs: 1000, input: undefined });
    expect(runner.calls[1].args).toEqual(['exec', '-i', 'c', 'sh', '-c', 'cat']);
    expect(runner.calls[1].options.input).toBe('secret');
  });

  it('exec returns a non-zero exit code without throwing', async () => {
    const { docker } = adapter(() => fail('container is not running', 1));
    expect((await docker.exec('c', ['true'])).exitCode).toBe(1);
  });
});

describe('volumes', () => {
  it('volumeExists', async () => {
    const { docker, runner } = adapter((call) => {
      const name = call.args[call.args.length - 1];
      if (name === 'there') return ok('"there"\n');
      if (name === 'gone') return fail('Error response from daemon: get gone: no such volume');
      return fail('Cannot connect to the Docker daemon');
    });
    expect(await docker.volumeExists('there')).toBe(true);
    expect(await docker.volumeExists('gone')).toBe(false);
    await expect(docker.volumeExists('error')).rejects.toBeInstanceOf(CommandError);
    expect(runner.calls[0].args).toEqual(['volume', 'inspect', '--format', '{{json .Name}}', 'there']);
  });

  it('createVolume passes the labels as separate arguments', async () => {
    const { docker, runner } = adapter(() => ok('v\n'));
    await docker.createVolume('v', { 'devenv.environment-id': 'env-1', 'devenv.repository': 'acme/a,b' });
    expect(runner.calls[0].args).toEqual([
      'volume',
      'create',
      '--label',
      'devenv.environment-id=env-1',
      '--label',
      'devenv.repository=acme/a,b',
      'v',
    ]);
  });

  it('createVolume throws CommandError', async () => {
    const { docker } = adapter(() => fail('no space left'));
    await expect(docker.createVolume('v', {})).rejects.toBeInstanceOf(CommandError);
  });

  it('removeVolume ignores a missing volume but not a volume in use', async () => {
    const { docker } = adapter((call) => {
      const name = call.args[2];
      if (name === 'gone') return fail('Error response from daemon: get gone: no such volume');
      if (name === 'used') return fail('Error response from daemon: remove used: volume is in use - [abc]');
      return ok('v\n');
    });
    await docker.removeVolume('v');
    await docker.removeVolume('gone');
    await expect(docker.removeVolume('used')).rejects.toBeInstanceOf(CommandError);
  });

  it('lists environment volumes with their labels', async () => {
    const { docker, runner } = adapter((call) => {
      if (call.args[1] === 'ls') return ok(idLines(['v1', 'v2', 'v3']));
      return fail(
        'Error response from daemon: get v3: no such volume',
        1,
        inspectOutput([
          { Name: 'v1', Driver: 'local', Labels: { 'devenv.environment-id': 'e1', 'devenv.repository': 'acme/api' } },
          { Name: 'v2', Driver: 'local', Labels: null },
          { Driver: 'broken' },
        ]),
      );
    });
    expect(await docker.listEnvironmentVolumes()).toEqual([
      { name: 'v1', labels: { 'devenv.environment-id': 'e1', 'devenv.repository': 'acme/api' } },
      { name: 'v2', labels: {} },
    ]);
    expect(runner.calls[0].args).toEqual(['volume', 'ls', '--filter', 'label=devenv.environment-id', '--format', '{{json .Name}}']);
    expect(runner.calls[1].args).toEqual(['volume', 'inspect', 'v1', 'v2', 'v3']);
  });

  it('lists no volumes without calling inspect', async () => {
    const { docker, runner } = adapter(() => ok(''));
    expect(await docker.listEnvironmentVolumes()).toEqual([]);
    expect(runner.calls).toHaveLength(1);
  });

  it('inspects the volumes of a list that exist, each once, with their labels', async () => {
    const { docker, runner } = adapter(() =>
      fail(
        'Error response from daemon: get gone: no such volume',
        1,
        inspectOutput([
          { Name: 'db', Driver: 'local', Labels: { 'com.docker.compose.project': 'shop' } },
          { Name: 'cache', Driver: 'local', Labels: null },
        ]),
      ),
    );
    expect(await docker.inspectVolumes(['db', 'cache', 'gone', 'db'])).toEqual([
      { name: 'db', labels: { 'com.docker.compose.project': 'shop' } },
      { name: 'cache', labels: {} },
    ]);
    expect(runner.calls.map((call) => call.args)).toEqual([['volume', 'inspect', 'db', 'cache', 'gone']]);
  });

  it('inspects nothing for an empty list, and throws for errors other than a missing volume', async () => {
    const { docker, runner } = adapter(() => fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.'));
    expect(await docker.inspectVolumes([])).toEqual([]);
    expect(runner.calls).toHaveLength(0);
    await expect(docker.inspectVolumes(['x'])).rejects.toBeInstanceOf(CommandError);
  });
});

describe('images', () => {
  it('imageExists', async () => {
    const { docker } = adapter((call) => {
      const ref = call.args[call.args.length - 1];
      if (ref === 'there:1') return ok('"sha256:abc"\n');
      if (ref === 'gone:1') return fail('Error response from daemon: No such image: gone:1');
      return fail('invalid reference format');
    });
    expect(await docker.imageExists('there:1')).toBe(true);
    expect(await docker.imageExists('gone:1')).toBe(false);
    await expect(docker.imageExists('BAD')).rejects.toBeInstanceOf(CommandError);
  });

  it('removeImage returns false for a missing image or an image in use', async () => {
    const { docker, runner } = adapter((call) => {
      const ref = call.args[2];
      if (ref === 'gone:1') return fail('Error response from daemon: No such image: gone:1');
      if (ref === 'used:1') {
        return fail(
          'Error response from daemon: conflict: unable to remove repository reference "used:1" (must force) - container abc is using its referenced image def',
          1,
        );
      }
      if (ref === 'running:1') {
        return fail('Error response from daemon: conflict: unable to delete def (cannot be forced) - image is being used by running container abc', 1);
      }
      if (ref === 'parent:1') return fail('Error response from daemon: conflict: unable to delete def (cannot be forced) - image has dependent child images');
      if (ref === 'broken:1') return fail('Cannot connect to the Docker daemon');
      return ok('Untagged: x:1\nDeleted: sha256:abc\n');
    });
    expect(await docker.removeImage('x:1')).toBe(true);
    expect(await docker.removeImage('gone:1')).toBe(false);
    expect(await docker.removeImage('used:1')).toBe(false);
    expect(await docker.removeImage('running:1')).toBe(false);
    expect(await docker.removeImage('parent:1')).toBe(false);
    await expect(docker.removeImage('broken:1')).rejects.toBeInstanceOf(CommandError);
    expect(runner.calls[0].args).toEqual(['image', 'rm', 'x:1']);
  });

  it('listImageTags returns the tags of exactly this repository, sorted numerically', async () => {
    const lines = [
      { Repository: 'devenv-3f2a9c1e', Tag: '10', ID: 'a' },
      { Repository: 'devenv-3f2a9c1e', Tag: '2', ID: 'b' },
      { Repository: 'devenv-3f2a9c1e', Tag: '<none>', ID: 'c' },
      { Repository: 'devenv-3f2a9c1e-other', Tag: '1', ID: 'd' },
      { Repository: 'devenv-3f2a9c1e', Tag: '2', ID: 'b' },
    ];
    const { docker, runner } = adapter(() => ok(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`));
    expect(await docker.listImageTags('devenv-3f2a9c1e')).toEqual(['devenv-3f2a9c1e:2', 'devenv-3f2a9c1e:10']);
    expect(runner.calls[0].args).toEqual(['image', 'ls', '--format', '{{json .}}', 'devenv-3f2a9c1e']);
  });

  it('pullImage forwards the output and throws CommandError', async () => {
    const output: string[] = [];
    const { docker, runner } = adapter((call) => {
      call.options.onStdout?.('Pulling from library/ubuntu\n');
      call.options.onStderr?.('warning\n');
      return call.args[1] === 'bad' ? fail('manifest unknown') : ok();
    });
    await docker.pullImage('ubuntu:24.04', { onOutput: (text) => output.push(text) });
    expect(runner.calls[0].args).toEqual(['pull', 'ubuntu:24.04']);
    expect(output).toEqual(['Pulling from library/ubuntu\n', 'warning\n']);
    await expect(docker.pullImage('bad')).rejects.toBeInstanceOf(CommandError);
  });

  it('pullImage passes the signal', async () => {
    const controller = new AbortController();
    const { docker, runner } = adapter(() => ok());
    await docker.pullImage('x', { signal: controller.signal });
    expect(runner.calls[0].options.signal).toBe(controller.signal);
  });

  it('buildImage builds with tag, Dockerfile, labels and build arguments', async () => {
    const output: string[] = [];
    const { docker, runner } = adapter((call) => {
      call.options.onStderr?.('#1 building\n');
      return ok();
    });
    await docker.buildImage({
      tag: 'devenv-helper:abc',
      dockerfile: '/ext/resources/helper/Dockerfile',
      context: '/ext/resources/helper',
      labels: { 'devenv.helper': 'true' },
      buildArgs: { DEVCONTAINER_CLI_VERSION: '0.89.0' },
      onOutput: (text) => output.push(text),
    });
    expect(runner.calls[0].args).toEqual([
      'build',
      '-t',
      'devenv-helper:abc',
      '-f',
      '/ext/resources/helper/Dockerfile',
      '--label',
      'devenv.helper=true',
      '--build-arg',
      'DEVCONTAINER_CLI_VERSION=0.89.0',
      '/ext/resources/helper',
    ]);
    expect(output).toEqual(['#1 building\n']);
  });

  it('buildImage passes --pull and --no-cache when asked', async () => {
    const { docker, runner } = adapter(() => ok());
    await docker.buildImage({ tag: 't:1', dockerfile: 'D', context: '.', labels: { l: 'v' }, pull: true, noCache: true });
    await docker.buildImage({ tag: 't:2', dockerfile: 'D', context: '.', pull: true });
    await docker.buildImage({ tag: 't:3', dockerfile: 'D', context: '.', pull: false, noCache: false });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['build', '-t', 't:1', '-f', 'D', '--pull', '--no-cache', '--label', 'l=v', '.'],
      ['build', '-t', 't:2', '-f', 'D', '--pull', '.'],
      ['build', '-t', 't:3', '-f', 'D', '.'],
    ]);
  });

  it('imageId returns the ID, undefined for a missing image, and throws for other errors', async () => {
    const id = `sha256:${'7'.repeat(64)}`;
    const { docker, runner } = adapter((call) => {
      const ref = call.args[call.args.length - 1];
      if (ref === 'there:1') return ok(`${JSON.stringify(id)}\n`);
      if (ref === 'gone:1') return fail('Error response from daemon: No such image: gone:1');
      if (ref === 'odd:1') return ok('\n');
      return fail('Cannot connect to the Docker daemon');
    });
    expect(await docker.imageId('there:1')).toBe(id);
    expect(runner.calls[0].args).toEqual(['image', 'inspect', '--format', '{{json .Id}}', 'there:1']);
    expect(await docker.imageId('gone:1')).toBeUndefined();
    await expect(docker.imageId('odd:1')).rejects.toBeInstanceOf(CommandError);
    await expect(docker.imageId('other:1')).rejects.toBeInstanceOf(CommandError);
  });

  it('listImagesByLabel lists the images with the label, one entry per ID, dangling ones without tags', async () => {
    const id1 = `sha256:${'1'.repeat(64)}`;
    const id2 = `sha256:${'2'.repeat(64)}`;
    const id3 = `sha256:${'3'.repeat(64)}`;
    const lines = [
      { ID: id1, Repository: 'devenv-helper', Tag: '76fa66d93464', CreatedAt: '2026-09-25 02:31:55 +0200 CEST', Digest: '<none>' },
      { ID: id1, Repository: 'mine', Tag: 'backup', CreatedAt: '2026-09-25 02:31:55 +0200 CEST' },
      { ID: id1, Repository: 'devenv-helper', Tag: '76fa66d93464', CreatedAt: '2026-09-25 02:31:55 +0200 CEST' },
      { ID: id2, Repository: '<none>', Tag: '<none>', CreatedAt: '2026-09-24 22:37:12 +0200 CEST' },
      { ID: id3, Repository: 'devenv-helper', Tag: '<none>' },
      { ID: '', Repository: 'x', Tag: '1' },
      { Repository: 'x', Tag: '1' },
    ];
    const all = `${lines.map((line) => JSON.stringify(line)).join('\n')}\nWARNING: not JSON\n`;
    // The classic image store lists a dangling image in both listings.
    const { docker, runner } = adapter((call) => ok(call.args.includes('dangling=true') ? `${JSON.stringify(lines[3])}\n` : all));
    expect(await docker.listImagesByLabel('devenv.helper=true')).toEqual([
      { id: id1, tags: ['devenv-helper:76fa66d93464', 'mine:backup'], createdAt: '2026-09-25 02:31:55 +0200 CEST' },
      { id: id2, tags: [], createdAt: '2026-09-24 22:37:12 +0200 CEST' },
      { id: id3, tags: [], createdAt: '' },
    ]);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['image', 'ls', '--filter', 'label=devenv.helper=true', '--no-trunc', '--format', '{{json .}}'],
      ['image', 'ls', '--filter', 'label=devenv.helper=true', '--filter', 'dangling=true', '--no-trunc', '--format', '{{json .}}'],
    ]);
  });

  it('listImagesByLabel includes dangling images that only the dangling filter lists (containerd image store)', async () => {
    const tagged = `sha256:${'4'.repeat(64)}`;
    const dangling = `sha256:${'5'.repeat(64)}`;
    // Docker Desktop with the containerd image store: `docker image ls` without `-a` hides untagged images.
    const { docker } = adapter((call) =>
      ok(
        call.args.includes('dangling=true')
          ? `${JSON.stringify({ ID: dangling, Repository: '<none>', Tag: '<none>', CreatedAt: 'b' })}\n`
          : `${JSON.stringify({ ID: tagged, Repository: 'devenv-helper', Tag: '0123456789ab', CreatedAt: 'a' })}\n`,
      ),
    );
    expect(await docker.listImagesByLabel('devenv.helper=true')).toEqual([
      { id: tagged, tags: ['devenv-helper:0123456789ab'], createdAt: 'a' },
      { id: dangling, tags: [], createdAt: 'b' },
    ]);
  });

  it('listImagesByLabel throws CommandError', async () => {
    const { docker } = adapter(() => fail('Cannot connect to the Docker daemon'));
    await expect(docker.listImagesByLabel('devenv.helper=true')).rejects.toBeInstanceOf(CommandError);
  });

  it('buildImage throws CommandError', async () => {
    const { docker } = adapter(() => fail('failed to solve'));
    await expect(docker.buildImage({ tag: 't', dockerfile: 'D', context: '.' })).rejects.toBeInstanceOf(CommandError);
  });

  it('imageLabels', async () => {
    const { docker, runner } = adapter((call) => {
      const ref = call.args[call.args.length - 1];
      if (ref === 'labeled:1') return ok('{"devcontainer.metadata":"[{\\"a\\":\\"b,c\\"}]","x":"y"}\n');
      if (ref === 'plain:1') return ok('null\n');
      if (ref === 'gone:1') return fail('Error response from daemon: No such image: gone:1');
      return fail('Cannot connect to the Docker daemon');
    });
    expect(await docker.imageLabels('labeled:1')).toEqual({ 'devcontainer.metadata': '[{"a":"b,c"}]', x: 'y' });
    expect(await docker.imageLabels('plain:1')).toEqual({});
    expect(await docker.imageLabels('gone:1')).toBeUndefined();
    await expect(docker.imageLabels('other:1')).rejects.toBeInstanceOf(CommandError);
    expect(runner.calls[0].args).toEqual(['image', 'inspect', '--format', '{{json .Config.Labels}}', 'labeled:1']);
  });
});

describe('ContainerAdapter: a Docker CLI that is installed later', () => {
  function setup(found: Array<string | undefined>) {
    let now = 1_000_000;
    const lookups: string[] = [];
    const runner = new FakeRunner(() => ok());
    const docker = new ContainerAdapter(runner, undefined, { PATH: '/usr/bin' }, silentLogger, 'linux', {
      clock: { now: () => now },
      findDocker: (env, platform) => {
        lookups.push(`${env.PATH ?? ''} ${platform}`);
        return found.length > 1 ? found.shift() : found[0];
      },
    });
    return { docker, runner, lookups, advance: (ms: number) => (now += ms) };
  }

  it('looks for a missing CLI again, at most every DOCKER_CLI_LOOKUP_RETRY_MS, and then uses it', async () => {
    const { docker, runner, lookups, advance } = setup([undefined, '/opt/docker/bin/docker']);
    // The caller has just looked it up (activation).
    expect(docker.isInstalled()).toBe(false);
    expect(lookups).toEqual([]);
    advance(DOCKER_CLI_LOOKUP_RETRY_MS);
    expect(docker.isInstalled()).toBe(false);
    expect(lookups).toEqual(['/usr/bin linux']);
    advance(DOCKER_CLI_LOOKUP_RETRY_MS - 1);
    await expect(docker.run(['ps'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    expect(lookups).toHaveLength(1);
    advance(1);
    expect(docker.isInstalled()).toBe(true);
    expect(docker.dockerPath).toBe('/opt/docker/bin/docker');
    expect(lookups).toHaveLength(2);
    await docker.run(['version']);
    expect(runner.calls[0].file).toBe('/opt/docker/bin/docker');
    expect(runner.calls[0].options.env?.PATH).toBe('/usr/bin:/opt/docker/bin:/usr/local/bin');
    advance(DOCKER_CLI_LOOKUP_RETRY_MS);
    expect(docker.isInstalled()).toBe(true);
    expect(lookups).toHaveLength(2);
  });

  it('looks up the CLI in the first call after the CLI could not be started (ENOENT)', async () => {
    let now = 0;
    const lookups: number[] = [];
    let gone = true;
    const runner = new FakeRunner((call) => {
      if (call.file === '/usr/local/bin/docker' && gone) {
        gone = false;
        throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      }
      return ok('"27.3.1"\n');
    });
    const docker = new ContainerAdapter(runner, '/usr/local/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', {
      clock: { now: () => now },
      findDocker: () => {
        lookups.push(now);
        return '/Applications/Docker.app/Contents/Resources/bin/docker';
      },
    });
    await expect(docker.run(['info'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    now += 1;
    expect(await docker.isRunning()).toBe(true);
    expect(lookups).toEqual([1]);
    expect(runner.calls.map((call) => call.file)).toEqual(['/usr/local/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker']);
  });

  it('looks for a missing CLI at once with lookUpCliNow, without the waiting time', () => {
    const { docker, lookups, advance } = setup([undefined, undefined, '/opt/docker/bin/docker']);
    expect(docker.lookUpCliNow()).toBe(false);
    expect(docker.lookUpCliNow()).toBe(false);
    expect(lookups).toHaveLength(2);
    advance(1);
    expect(docker.lookUpCliNow()).toBe(true);
    expect(docker.dockerPath).toBe('/opt/docker/bin/docker');
    // A found CLI is not looked up again.
    expect(docker.lookUpCliNow()).toBe(true);
    expect(lookups).toHaveLength(3);
  });

  it('keeps a fixed path with lookUpCliNow', () => {
    const docker = new ContainerAdapter(new FakeRunner(() => ok()), undefined, {}, silentLogger, 'linux');
    expect(docker.lookUpCliNow()).toBe(false);
  });

  it('keeps the path fixed without findDocker', async () => {
    const runner = new FakeRunner(() => {
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    });
    const docker = new ContainerAdapter(runner, DOCKER, {}, silentLogger, 'linux');
    await expect(docker.run(['ps'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    expect(docker.dockerPath).toBe(DOCKER);
    expect(docker.isInstalled()).toBe(true);
  });
});

describe('ContainerAdapter.pullImage with credentials', () => {
  const LOGIN = { registry: 'ghcr.io', username: 'octocat', password: 'gho_secret_token' };

  function recordingLogger(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    const add = (message: string, error?: unknown): void => {
      lines.push(error === undefined ? message : `${message} ${String(error)}`);
    };
    return { logger: { info: add, warn: add, error: add, output: add }, lines };
  }

  interface PullSeen {
    configDir: string;
    config: unknown;
    configMode: number;
    dirMode: number;
    env: NodeJS.ProcessEnv | undefined;
  }

  function pullRunner(options: { contextHost?: string; contextFails?: boolean; pullFails?: boolean } = {}) {
    const seen: PullSeen[] = [];
    const runner = new FakeRunner((call) => {
      if (call.args[0] === 'context') {
        return options.contextFails ? fail('unknown command') : ok(`${JSON.stringify(options.contextHost ?? '')}\n`);
      }
      if (call.args[0] === '--config') {
        const configDir = call.args[1];
        const file = `${configDir}/config.json`;
        seen.push({
          configDir,
          config: JSON.parse(fs.readFileSync(file, 'utf8')) as unknown,
          configMode: fs.statSync(file).mode & 0o777,
          dirMode: fs.statSync(configDir).mode & 0o777,
          env: call.options.env,
        });
        call.options.onStdout?.('Pulling from acme/private-base\n');
        return options.pullFails ? fail('denied: permission_denied') : ok();
      }
      return fail('unexpected call');
    });
    return { runner, seen };
  }

  it('writes a config.json with only these credentials, pulls with it on the daemon of the current context, and removes it', async () => {
    const { runner, seen } = pullRunner({ contextHost: 'unix:///home/u/.docker/desktop/docker.sock' });
    const { logger, lines } = recordingLogger();
    const env = { PATH: '/usr/bin', HOME: '/home/u', DOCKER_CONTEXT: 'desktop-linux' };
    const docker = new ContainerAdapter(runner, DOCKER, env, logger, 'linux');
    const output: string[] = [];
    await docker.pullImage('ghcr.io/acme/private-base:latest', { credentials: LOGIN, onOutput: (text) => output.push(text) });

    expect(runner.calls[0].args).toEqual(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']);
    expect(runner.calls[0].options.env?.DOCKER_CONTEXT).toBe('desktop-linux');
    expect(runner.calls[1].args).toEqual(['--config', seen[0].configDir, 'pull', 'ghcr.io/acme/private-base:latest']);
    expect(seen[0].config).toEqual({ auths: { 'ghcr.io': { auth: Buffer.from('octocat:gho_secret_token').toString('base64') } } });
    if (process.platform !== 'win32') {
      expect(seen[0].configMode).toBe(0o600);
      expect(seen[0].dirMode).toBe(0o700);
    }
    expect(seen[0].env?.DOCKER_HOST).toBe('unix:///home/u/.docker/desktop/docker.sock');
    expect(seen[0].env?.DOCKER_CONTEXT).toBeUndefined();
    expect(seen[0].env?.HOME).toBe('/home/u');
    expect(output).toEqual(['Pulling from acme/private-base\n']);
    expect(fs.existsSync(seen[0].configDir)).toBe(false);
    const logged = lines.join('\n');
    expect(logged).toContain('with the credentials for ghcr.io');
    expect(logged).not.toContain('gho_secret_token');
    expect(logged).not.toContain(Buffer.from('octocat:gho_secret_token').toString('base64'));
  });

  it('keeps a DOCKER_HOST that is set, and does not read the context', async () => {
    const { runner, seen } = pullRunner();
    const docker = new ContainerAdapter(runner, DOCKER, { PATH: '/usr/bin', DOCKER_HOST: 'ssh://me@build-host' }, silentLogger, 'linux');
    await docker.pullImage('ghcr.io/acme/x', { credentials: LOGIN });
    expect(runner.calls.map((call) => call.args[0])).toEqual(['--config']);
    expect(seen[0].env?.DOCKER_HOST).toBe('ssh://me@build-host');
  });

  it('keeps a tcp DOCKER_HOST with TLS verification and its certificates', async () => {
    const { runner, seen } = pullRunner();
    const env = { DOCKER_HOST: 'tcp://10.0.0.5:2376', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/home/u/certs' };
    const docker = new ContainerAdapter(runner, DOCKER, { PATH: '/usr/bin', ...env }, silentLogger, 'linux');
    await docker.pullImage('ghcr.io/acme/x', { credentials: LOGIN });
    expect(seen[0].env).toMatchObject(env);
  });

  it.each<[string, NodeJS.ProcessEnv, string | undefined]>([
    ['a tcp DOCKER_HOST without TLS', { DOCKER_HOST: 'tcp://10.0.0.5:2375' }, undefined],
    ['a tcp DOCKER_HOST with DOCKER_TLS_VERIFY=0', { DOCKER_HOST: 'tcp://10.0.0.5:2376', DOCKER_TLS_VERIFY: '0', DOCKER_CERT_PATH: '/c' }, undefined],
    ['a tcp DOCKER_HOST without DOCKER_CERT_PATH', { DOCKER_HOST: 'tcp://10.0.0.5:2376', DOCKER_TLS_VERIFY: '1' }, undefined],
    ['a tcp endpoint of the Docker context without TLS variables', { DOCKER_CONTEXT: 'remote' }, 'tcp://10.0.0.5:2376'],
    ['an endpoint of an unknown scheme', { DOCKER_HOST: 'http://10.0.0.5:2375' }, undefined],
  ])('does not send the credentials over %s', async (_name, env, contextHost) => {
    const { runner, seen } = pullRunner({ contextHost });
    const { logger, lines } = recordingLogger();
    const docker = new ContainerAdapter(runner, DOCKER, { PATH: '/usr/bin', ...env }, logger, 'linux');
    const error = await docker.pullImage('ghcr.io/acme/x', { credentials: LOGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserFacingError);
    expect(error).toMatchObject({ code: 'unencryptedDockerConnection', message: Messages.unencryptedDockerConnection });
    expect(seen).toEqual([]);
    expect(runner.calls.some((call) => call.args[0] === '--config' || call.args.includes('pull'))).toBe(false);
    expect(lines.join('\n')).not.toContain('gho_secret_token');
    expect(String((error as UserFacingError).detail)).not.toContain('gho_secret_token');
  });

  it('uses the default endpoint when the context cannot be read', async () => {
    const { runner, seen } = pullRunner({ contextFails: true });
    const docker = new ContainerAdapter(runner, DOCKER, { PATH: '/usr/bin' }, silentLogger, 'linux');
    await docker.pullImage('ghcr.io/acme/x', { credentials: LOGIN });
    expect(seen).toHaveLength(1);
    expect(seen[0].env?.DOCKER_HOST).toBeUndefined();
  });

  it('removes the config folder also when the pull fails, and the error holds no secret', async () => {
    const { runner, seen } = pullRunner({ contextHost: 'unix:///var/run/docker.sock', pullFails: true });
    const docker = new ContainerAdapter(runner, DOCKER, { PATH: '/usr/bin' }, silentLogger, 'linux');
    const error = await docker.pullImage('ghcr.io/acme/x', { credentials: LOGIN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect(String((error as Error).message)).not.toContain('gho_secret_token');
    expect(fs.existsSync(seen[0].configDir)).toBe(false);
  });

  it('pulls as before without credentials', async () => {
    const { docker, runner } = adapter(() => ok());
    await docker.pullImage('ubuntu:24.04', {});
    expect(runner.calls.map((call) => call.args)).toEqual([['pull', 'ubuntu:24.04']]);
    expect(runner.calls[0].options.env?.DOCKER_HOST).toBeUndefined();
  });

  it.each<[string, string | undefined, NodeJS.ProcessEnv, NodeJS.Platform, boolean]>([
    ['the default endpoint (no DOCKER_HOST)', undefined, {}, 'linux', true],
    ['an empty endpoint', '  ', {}, 'darwin', true],
    ['a Unix socket', 'unix:///var/run/docker.sock', {}, 'linux', true],
    ['a named pipe', 'npipe:////./pipe/docker_engine', {}, 'win32', true],
    ['SSH', 'ssh://me@host:22', {}, 'darwin', true],
    ['an upper-case scheme', 'UNIX:///var/run/docker.sock', {}, 'linux', true],
    ['tcp with TLS verification and certificates', 'tcp://h:2376', { DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/c' }, 'linux', true],
    ['tcp with the variables in another spelling on Windows', 'tcp://h:2376', { docker_tls_verify: 'yes', Docker_Cert_Path: 'C:\\c' }, 'win32', true],
    ['tcp without TLS', 'tcp://h:2375', {}, 'linux', false],
    ['tcp with DOCKER_TLS_VERIFY=0', 'tcp://h:2376', { DOCKER_TLS_VERIFY: '0', DOCKER_CERT_PATH: '/c' }, 'linux', false],
    ['tcp with an empty DOCKER_TLS_VERIFY', 'tcp://h:2376', { DOCKER_TLS_VERIFY: '', DOCKER_CERT_PATH: '/c' }, 'linux', false],
    ['tcp without DOCKER_CERT_PATH', 'tcp://h:2376', { DOCKER_TLS_VERIFY: '1' }, 'linux', false],
    ['tcp with only DOCKER_TLS (no verification)', 'tcp://h:2376', { DOCKER_TLS: '1', DOCKER_CERT_PATH: '/c' }, 'linux', false],
    ['http', 'http://h:2375', {}, 'linux', false],
    ['fd', 'fd://', {}, 'linux', false],
    ['a host without a scheme', 'h:2375', {}, 'linux', false],
  ])('isProtectedDockerEndpoint: %s', (_name, host, env, platform, expected) => {
    expect(isProtectedDockerEndpoint(host, env, platform)).toBe(expected);
  });

  it('registryLoginConfig encodes user and password as Docker does', () => {
    expect(JSON.parse(registryLoginConfig({ registry: 'ghcr.io', username: 'a', password: 'b:c' }))).toEqual({
      auths: { 'ghcr.io': { auth: Buffer.from('a:b:c').toString('base64') } },
    });
  });
});
