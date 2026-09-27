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
  type ImageInspection,
} from './containerAdapter';
import { MAX_IMAGE_INSPECT_SINGLE_CALLS } from '../helper/analysisLimits';

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
    const info = await docker.findContainer('env-1', 'devenv-acme-api-3f2a9c1e');
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
    expect(await docker.findContainer('env-1', 'devenv-acme-api-3f2a9c1e')).toBeUndefined();
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
    expect((await docker.findContainer('env-1', 'devenv-acme-api-3f2a9c1e'))?.id).toBe('run');
  });

  it('skips the other services of a Docker Compose environment: the dev container is found (unit 6, D-4)', async () => {
    const { docker } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines(['db', 'dev']));
      return ok(
        inspectOutput([
          // The running side service would win without the rule (a running container comes first).
          containerJson({ id: 'db', name: 'devenv-3f2a9c1e-db-1', status: 'running', labels: { 'devenv.environment-id': 'env-1', 'devenv.compose-service': 'db' } }),
          containerJson({ id: 'dev', name: 'devenv-acme-api-3f2a9c1e', status: 'exited', labels: { 'devenv.environment-id': 'env-1' } }),
        ]),
      );
    });
    expect((await docker.findContainer('env-1', 'devenv-acme-api-3f2a9c1e'))?.id).toBe('dev');
  });

  it('finds the container with the name of the environment even when its image gave it the label of a service (review round 1, D2)', async () => {
    const { docker } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines(['dev']));
      return ok(
        inspectOutput([
          containerJson({ id: 'dev', name: 'devenv-acme-api-3f2a9c1e', status: 'running', labels: { 'devenv.environment-id': 'env-1', 'devenv.compose-service': 'x' } }),
        ]),
      );
    });
    expect((await docker.findContainer('env-1', 'devenv-acme-api-3f2a9c1e'))?.id).toBe('dev');
  });

  it('prefers the container with the name of the environment over other dev containers, even running and newer ones (final review, FC-1)', async () => {
    const { docker } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines(['old', 'dev', 'stray']));
      return ok(
        inspectOutput([
          // The previous dev container of a Select configuration… (renamed, without devenv.compose-service), running.
          containerJson({ id: 'old', name: 'devenv-3f2a9c1e-app-1', status: 'running', created: '2026-01-01T00:00:00Z', labels: { 'devenv.environment-id': 'env-1' } }),
          containerJson({ id: 'dev', name: 'devenv-acme-api-3f2a9c1e', status: 'exited', created: '2026-02-01T00:00:00Z', labels: { 'devenv.environment-id': 'env-1' } }),
          containerJson({ id: 'stray', name: 'stray', status: 'running', created: '2026-03-01T00:00:00Z', labels: { 'devenv.environment-id': 'env-1' } }),
        ]),
      );
    });
    expect((await docker.findContainer('env-1', 'devenv-acme-api-3f2a9c1e'))?.id).toBe('dev');
    // Without a container of that name (an older container, a failed switch), a running one, then the newest.
    expect((await docker.findContainer('env-1', 'devenv-acme-api-00000000'))?.id).toBe('stray');
  });

  it('finds no container when only other services of a Docker Compose environment exist', async () => {
    const { docker } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines(['db']));
      return ok(inspectOutput([containerJson({ id: 'db', name: 'db', status: 'running', labels: { 'devenv.environment-id': 'env-1', 'devenv.compose-service': 'db' } })]));
    });
    expect(await docker.findContainer('env-1', 'devenv-acme-api-3f2a9c1e')).toBeUndefined();
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

  it('renameContainer runs docker rename and throws when it fails (review round 22, D22-1)', async () => {
    const { docker, runner } = adapter((call) => (call.args[2] === 'taken' ? fail('Error response from daemon: Conflict. The container name "/taken" is already in use') : ok()));
    await docker.renameContainer('x', 'devenv-3f2a9c1e-app-1');
    expect(runner.calls[0].args).toEqual(['rename', 'x', 'devenv-3f2a9c1e-app-1']);
    await expect(docker.renameContainer('x', 'taken')).rejects.toBeInstanceOf(CommandError);
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

  it('inspects the networks of a list that exist, with their labels and containers (review round 1, S2)', async () => {
    const { docker, runner } = adapter(() =>
      fail(
        'Error response from daemon: network gone not found',
        1,
        inspectOutput([
          { Name: 'backend', Id: 'a1b2', Labels: { 'com.docker.compose.project': 'devenv-11111111' }, Containers: { c1: { Name: 'x' }, c2: { Name: 'y' } } },
          { Name: 'shared', Labels: null, Containers: {} },
        ]),
      ),
    );
    // Review round 2 (S2-04): changed expectation, with the ID of each network (empty when Docker prints none).
    expect(await docker.inspectNetworks(['backend', 'shared', 'gone', 'backend'])).toEqual([
      { name: 'backend', id: 'a1b2', labels: { 'com.docker.compose.project': 'devenv-11111111' }, containers: ['c1', 'c2'] },
      { name: 'shared', id: '', labels: {}, containers: [] },
    ]);
    expect(runner.calls.map((call) => call.args)).toEqual([['network', 'inspect', 'backend', 'shared', 'gone']]);
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

  it('inspectImageNames asks about many references with one call per batch, and leaves out missing ones (review round 9, S9-3)', async () => {
    const line = (id: string, tag: string) => JSON.stringify({ id, repoTags: [tag], repoDigests: null });
    const { docker, runner } = adapter((call) => {
      const refs = call.args.slice(call.args.indexOf('--') + 1);
      if (refs.includes('broken')) return fail('Cannot connect to the Docker daemon');
      const found = refs.filter((ref) => !ref.startsWith('gone'));
      const stdout = found.map((ref) => line(`sha256:${ref.length}`, ref)).join('\n') + '\n';
      return found.length === refs.length ? ok(stdout) : { exitCode: 1, stdout, stderr: 'Error response from daemon: No such image: gone', timedOut: false };
    });
    const references = Array.from({ length: 150 }, (_, i) => (i === 3 ? 'gone:1' : `r${i}:1`));
    // Review round 10, P10-1: the result names the found images and the references that could not be checked.
    const { images: found, unchecked } = await docker.inspectImageNames(references);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0].args.slice(0, 5)).toEqual(['image', 'inspect', '--format', '{"id":{{json .Id}},"repoTags":{{json .RepoTags}},"repoDigests":{{json .RepoDigests}}}', '--']);
    expect(runner.calls[0].args).toHaveLength(105);
    expect(found).toHaveLength(149);
    expect(unchecked).toEqual([]);
    expect(found[0]).toEqual({ id: 'sha256:4', repoTags: ['r0:1'], repoDigests: [] });
    // Review round 10, P10-1: before, it threw for the whole batch; now the reference that Docker cannot inspect is named.
    // Review round 11, G1: with its reason; a daemon that cannot be reached says nothing about the reference.
    expect(await docker.inspectImageNames(['broken'])).toEqual({ images: [], unchecked: [{ reference: 'broken', reason: 'transient' }] });
    expect(await docker.inspectImageNames([])).toEqual({ images: [], unchecked: [] });
  });

  describe('review round 10 (P10-1): one reference that Docker cannot inspect does not leave the others of its batch unchecked', () => {
    const ID = `sha256:3f2a1b9c${'0'.repeat(56)}`;
    // As Docker 27: every reference is inspected; a missing one gives "No such image", an invalid one "invalid reference
    // format"; exit code 1 when any failed; the found ones on stdout.
    function daemon(call: { args: string[] }): RunResult {
      const refs = call.args.slice(call.args.indexOf('--') + 1);
      const lines: string[] = [];
      const errors: string[] = [];
      for (const ref of refs) {
        if (ref === '3f2a1b9c') lines.push(JSON.stringify({ id: ID, repoTags: ['devenv-7c1d2e3f-db:latest'], repoDigests: [] }));
        else if (ref === 'postgres:16') lines.push(JSON.stringify({ id: `sha256:${'1'.repeat(64)}`, repoTags: ['postgres:16'], repoDigests: [] }));
        else if (ref === 'foo/Bar') errors.push(`Error response from daemon: invalid reference format: repository name (library/foo/Bar) must be lowercase`);
        else errors.push(`Error response from daemon: No such image: ${ref}`);
      }
      const stdout = lines.map((line) => `${line}\n`).join('');
      return errors.length === 0 ? ok(stdout) : { exitCode: 1, stdout, stderr: `${errors.join('\n')}\n`, timedOut: false };
    }

    it('inspects the references of a batch one by one when Docker fails for another reason than a missing image', async () => {
      const { docker, runner } = adapter(daemon);
      const result = await docker.inspectImageNames(['foo/Bar', '3f2a1b9c', 'postgres:16']);
      // Before: a CommandError for the batch, and the pipeline checked none of them.
      // Review round 11, G1: with its reason.
      expect(result.unchecked).toEqual([{ reference: 'foo/Bar', reason: 'invalid' }]);
      expect(result.images.map((image) => image.id)).toEqual([ID, `sha256:${'1'.repeat(64)}`]);
      expect(runner.calls).toHaveLength(4);
    });

    it('does not take a batch with a missing and an invalid reference for missing images only', async () => {
      const { docker, runner } = adapter(daemon);
      const result = await docker.inspectImageNames(['gone:1', 'foo/Bar', '3f2a1b9c']);
      // Before: "No such image" anywhere in stderr counted as missing, and foo/Bar was left unchecked without a word.
      // Review round 11, G1: with its reason.
      expect(result.unchecked).toEqual([{ reference: 'foo/Bar', reason: 'invalid' }]);
      expect(result.images.map((image) => image.id)).toEqual([ID]);
      expect(runner.calls).toHaveLength(4);
    });

    it('still asks with one call when Docker only misses images, and names all references of a batch that timed out', async () => {
      const { docker, runner } = adapter(daemon);
      expect((await docker.inspectImageNames(['gone:1', 'postgres:16'])).unchecked).toEqual([]);
      expect(runner.calls).toHaveLength(1);
      const slow = adapter(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
      // Review round 11, G1: with their reason.
      expect(await slow.docker.inspectImageNames(['a:1', 'b:1'])).toEqual({
        images: [],
        unchecked: [
          { reference: 'a:1', reason: 'transient' },
          { reference: 'b:1', reason: 'transient' },
        ],
      });
      expect(slow.runner.calls).toHaveLength(1);
    });
  });

  describe('review round 11 (G1, G2): why a reference was not checked, and the bounds of the single calls', () => {
    const line = (ref: string) => JSON.stringify({ id: `sha256:${'1'.repeat(64)}`, repoTags: [ref], repoDigests: [] });
    /** Like Docker 27: the references in `answers` fail with their text; the others are found. */
    function daemon(answers: Record<string, string>): Handler {
      return (call) => {
        const refs = call.args.slice(call.args.indexOf('--') + 1);
        const errors = refs.filter((ref) => answers[ref] !== undefined).map((ref) => answers[ref]);
        const stdout = refs.filter((ref) => answers[ref] === undefined).map((ref) => `${line(ref)}\n`).join('');
        return errors.length === 0 ? ok(stdout) : { exitCode: 1, stdout, stderr: `${errors.join('\n')}\n`, timedOut: false };
      };
    }
    const unchecked = (result: ImageInspection) => result.unchecked.map((entry) => `${entry.reference} ${entry.reason}`);

    it('takes an invalid reference and an ambiguous ID prefix of both image stores for answers about the reference', async () => {
      const { docker, runner } = adapter(
        daemon({
          'foo/Bar': 'Error response from daemon: invalid reference format: repository name (library/foo/Bar) must be lowercase',
          a1b2: 'Error response from daemon: multiple IDs found with provided prefix: a1b2',
          c3d4: 'Error response from daemon: ambiguous reference: c3d4',
          gone: 'Error response from daemon: No such image: gone:latest',
        }),
      );
      const result = await docker.inspectImageNames(['foo/Bar', 'a1b2', 'c3d4', 'gone', 'postgres:16']);
      expect(unchecked(result)).toEqual(['foo/Bar invalid', 'a1b2 invalid', 'c3d4 invalid']);
      expect(result.images).toHaveLength(1);
      expect(runner.calls).toHaveLength(6);
    });

    it('takes the answers of go-digest and of the length of a name for answers about the reference (review round 12, P12-1)', async () => {
      const upper = `alpine@sha256:${'A'.repeat(64)}`;
      const short = `alpine@sha256:${'a'.repeat(40)}`;
      const md5 = `alpine@md5:${'a'.repeat(32)}`;
      const long = `${'a'.repeat(250)}:1`;
      const { docker } = adapter(
        daemon({
          [upper]: 'Error response from daemon: invalid checksum digest format',
          [short]: 'Error response from daemon: invalid checksum digest length',
          [md5]: 'Error response from daemon: unsupported digest algorithm',
          [long]: 'Error response from daemon: invalid reference format: repository name (library/aaa…) must not be more than 255 characters',
        }),
      );
      const result = await docker.inspectImageNames([upper, short, md5, long, 'postgres:16']);
      // Before: transient, and the open failed with the internal error ("reinstall Dev Environments") at each attempt.
      expect(unchecked(result)).toEqual([`${upper} invalid`, `${short} invalid`, `${md5} invalid`, `${long} invalid`]);
      const single = adapter(daemon({ 'x:1': 'Error response from daemon: repository name must not be more than 255 characters' }));
      expect(unchecked(await single.docker.inspectImageNames(['x:1']))).toEqual(['x:1 invalid']);
    });

    it('asks no more after a daemon error of a batch, and names every reference transient', async () => {
      const references = Array.from({ length: 250 }, (_, i) => `r${i}:1`);
      const { docker, runner } = adapter(daemon({ 'r0:1': 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' }));
      const result = await docker.inspectImageNames(references);
      // Before: the batch was inspected one by one (100 calls), then the next batches.
      expect(runner.calls).toHaveLength(1);
      expect(result.unchecked).toHaveLength(250);
      expect(result.unchecked.every((entry) => entry.reason === 'transient')).toBe(true);
    });

    it('asks no more after a timed-out batch', async () => {
      const references = Array.from({ length: 250 }, (_, i) => `r${i}:1`);
      const { docker, runner } = adapter((call) => (call.args.includes('r100:1') ? { exitCode: null, stdout: '', stderr: '', timedOut: true } : daemon({})(call)));
      const result = await docker.inspectImageNames(references);
      // Before: the third batch was asked too (and each batch after a timeout waited up to 60 s).
      expect(runner.calls).toHaveLength(2);
      expect(result.images).toHaveLength(100);
      expect(unchecked(result)).toEqual(references.slice(100).map((ref) => `${ref} transient`));
    });

    it('stops the single calls at the first daemon error or unknown answer', async () => {
      const { docker, runner } = adapter(daemon({ 'a:1': 'Error response from daemon: multiple IDs found with provided prefix: a', 'b:1': 'error during connect: EOF' }));
      const result = await docker.inspectImageNames(['a:1', 'b:1', 'c:1', 'd:1']);
      // The batch mixes an answer about a reference with a connection error: no single calls.
      expect(runner.calls).toHaveLength(1);
      expect(unchecked(result)).toEqual(['a:1 transient', 'b:1 transient', 'c:1 transient', 'd:1 transient']);
      let calls = 0;
      const flaky = adapter((call) => {
        calls++;
        // The batch fails for an invalid reference; the second single call hits a daemon that restarts.
        if (calls === 3) return fail('Error response from daemon: something unknown happened');
        return daemon({ 'x/Y': 'invalid reference format' })(call);
      });
      const second = await flaky.docker.inspectImageNames(['x/Y', 'b:1', 'c:1', 'd:1']);
      expect(flaky.runner.calls).toHaveLength(3);
      expect(unchecked(second)).toEqual(['x/Y invalid', 'b:1 transient', 'c:1 transient', 'd:1 transient']);
    });

    it(`makes at most ${MAX_IMAGE_INSPECT_SINGLE_CALLS} single calls; the references beyond are transient`, async () => {
      // One reference of each batch that Docker calls invalid: before, all 1000 references were inspected one by one.
      const references = Array.from({ length: 1000 }, (_, i) => (i % 100 === 0 ? `bad${i}` : `r${i}:1`));
      const answers = Object.fromEntries(references.filter((ref) => ref.startsWith('bad')).map((ref) => [ref, 'Error response from daemon: invalid reference format']));
      const { docker, runner } = adapter(daemon(answers));
      const result = await docker.inspectImageNames(references);
      expect(runner.calls).toHaveLength(2 + MAX_IMAGE_INSPECT_SINGLE_CALLS);
      // The first batch uses up the single calls; the second batch fails too, and its references and all after it are
      // not checked.
      expect(unchecked(result).slice(0, 2)).toEqual(['bad0 invalid', 'bad100 transient']);
      expect(result.unchecked.filter((entry) => entry.reason === 'transient')).toHaveLength(900);
      expect(result.images).toHaveLength(99);
    });

    it('passes the signal to each call and stops between the single calls when it aborts', async () => {
      const controller = new AbortController();
      const { docker, runner } = adapter((call) => {
        if (runner.calls.length === 3) controller.abort();
        return daemon({ 'x/Y': 'invalid reference format' })(call);
      });
      const error = await docker.inspectImageNames(['x/Y', 'b:1', 'c:1', 'd:1', 'e:1'], controller.signal).catch((e: unknown) => e);
      expect(isAbortError(error)).toBe(true);
      // Before: all four single calls ran, without the signal.
      expect(runner.calls).toHaveLength(3);
      expect(runner.calls.every((call) => call.options.signal === controller.signal)).toBe(true);
    });

    it('does not throw when the Docker CLI cannot be started (dockerNotInstalled)', async () => {
      const runner = new FakeRunner(() => ok());
      const docker = new ContainerAdapter(runner, undefined, {}, silentLogger, 'linux');
      // Before: the UserFacingError of run, although the doc comment said "Never throws".
      expect(unchecked(await docker.inspectImageNames(['a:1', 'b:1']))).toEqual(['a:1 transient', 'b:1 transient']);
      expect(runner.calls).toHaveLength(0);
      const gone = adapter(() => {
        throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      });
      expect(unchecked(await gone.docker.inspectImageNames(['a:1']))).toEqual(['a:1 transient']);
    });
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

  it('imageNames returns the tags and digests of an image, undefined for a missing image (review round 2, S2-05)', async () => {
    const { docker, runner } = adapter((call) => {
      const ref = call.args[call.args.length - 1];
      if (ref === 'a1b2c3d4') return ok('{"repoTags":["postgres:16"],"repoDigests":["postgres@sha256:' + 'e'.repeat(64) + '"]}\n');
      if (ref === 'dangling') return ok('{"repoTags":null,"repoDigests":[]}\n');
      if (ref === 'gone') return fail('Error response from daemon: No such image: gone');
      if (ref === 'odd') return ok('\n');
      return fail('Cannot connect to the Docker daemon');
    });
    expect(await docker.imageNames('a1b2c3d4')).toEqual({ repoTags: ['postgres:16'], repoDigests: [`postgres@sha256:${'e'.repeat(64)}`] });
    expect(runner.calls[0].args).toEqual(['image', 'inspect', '--format', '{"repoTags":{{json .RepoTags}},"repoDigests":{{json .RepoDigests}}}', 'a1b2c3d4']);
    expect(await docker.imageNames('dangling')).toEqual({ repoTags: [], repoDigests: [] });
    expect(await docker.imageNames('gone')).toBeUndefined();
    await expect(docker.imageNames('odd')).rejects.toBeInstanceOf(CommandError);
    await expect(docker.imageNames('other')).rejects.toBeInstanceOf(CommandError);
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

  it('reports the loss of a CLI that it found before to onCliLost (ENOENT), once per loss', async () => {
    let gone = true;
    const runner = new FakeRunner((call) => {
      if (call.file === DOCKER && gone) throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      return ok('"27.3.1"\n');
    });
    const lost: string[] = [];
    let found: string | undefined;
    const docker: ContainerAdapter = new ContainerAdapter(runner, DOCKER, {}, silentLogger, 'linux', {
      findDocker: () => found,
      onCliLost: () => lost.push(String(docker.dockerPath)),
    });
    await expect(docker.run(['ps'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    // Reported after the adapter forgot the path, so that a lookup in the callback looks for the CLI again.
    expect(lost).toEqual(['undefined']);
    // Without a CLI there is nothing to lose again.
    await expect(docker.run(['ps'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    expect(lost).toHaveLength(1);
    gone = false;
    found = DOCKER;
    expect(docker.lookUpCliNow()).toBe(true);
    await docker.run(['ps']);
    expect(lost).toHaveLength(1);
  });

  it('keeps its error when onCliLost throws', async () => {
    const runner = new FakeRunner(() => {
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    });
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message: string) => void warnings.push(message) };
    const docker = new ContainerAdapter(runner, DOCKER, {}, logger, 'linux', {
      findDocker: () => undefined,
      onCliLost: () => {
        throw new Error('boom');
      },
    });
    await expect(docker.run(['ps'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    expect(warnings.some((line) => line.includes('boom'))).toBe(true);
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

describe('ContainerAdapter.engineApiVersion', () => {
  it('reads the API version of the engine', async () => {
    const { docker, runner } = adapter(() => ok('1.48\n'));
    expect(await docker.engineApiVersion()).toBe('1.48');
    expect(runner.calls[0].args).toEqual(['version', '--format', '{{.Server.APIVersion}}']);
  });

  it.each([
    ['a failed call', fail('Cannot connect to the Docker daemon', 1, '')],
    ['an output that is no version', ok('<no value>\n')],
  ])('is undefined after %s', async (_name, result) => {
    const { docker } = adapter(() => result);
    expect(await docker.engineApiVersion()).toBeUndefined();
  });
});

// Unit 6, package C: Delete and a failed first open of a Docker Compose environment remove the whole project.
describe('ContainerAdapter: the objects of a Docker Compose project', () => {
  it('lists the containers of the project by its label, also those without the label of the environment', async () => {
    const { docker, runner } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines(['run1']));
      return ok(inspectOutput([containerJson({ id: 'run1', name: 'devenv-3f2a9c1e-db-run-1', status: 'exited', labels: { 'com.docker.compose.project': 'devenv-3f2a9c1e' } })]));
    });
    expect((await docker.listProjectContainers('devenv-3f2a9c1e')).map((c) => c.id)).toEqual(['run1']);
    expect(runner.calls[0].args).toEqual(['ps', '-a', '--no-trunc', '--filter', 'label=com.docker.compose.project=devenv-3f2a9c1e', '--format', '{{json .ID}}']);
  });

  it('reads the subpaths of volumes that each container mounts, with one inspect for all (review round 11, G3, G4)', async () => {
    const db = {
      ...containerJson({ id: 'db1', name: 'devenv-3f2a9c1e-db-1', status: 'running', labels: { 'com.docker.compose.project': 'devenv-3f2a9c1e' } }),
      // As Docker 27 prints a container that Compose created with a volume subpath: HostConfig.Mounts names the volume in
      // Source; Mounts (the mount points) has no subpath.
      HostConfig: {
        Mounts: [
          { Type: 'volume', Source: 'acme-api-3f2a9c1e', Target: '/var/lib/postgresql/data', VolumeOptions: { NoCopy: true, Subpath: 'api/data/pg' } },
          { Type: 'volume', Source: 'acme-api-3f2a9c1e', Target: '/init.sql', ReadOnly: true, VolumeOptions: { Subpath: 'api/init.sql' } },
          { Type: 'volume', Source: 'devenv-3f2a9c1e_cache', Target: '/cache', VolumeOptions: {} },
          { Type: 'bind', Source: '/etc/hosts', Target: '/x' },
        ],
      },
      Mounts: [{ Type: 'volume', Name: 'acme-api-3f2a9c1e', Source: '/var/lib/docker/volumes/acme-api-3f2a9c1e/_data', Destination: '/var/lib/postgresql/data', RW: true }],
    };
    const { docker, runner } = adapter((call) => {
      if (call.args[0] === 'ps') return ok(idLines(['db1', 'dev1']));
      return ok(inspectOutput([db, containerJson({ id: 'dev1', name: 'acme-api-3f2a9c1e', status: 'running', labels: { 'com.docker.compose.project': 'devenv-3f2a9c1e' } })]));
    });
    const containers = await docker.listProjectContainers('devenv-3f2a9c1e');
    expect(containers[0].volumeSubpaths).toEqual([
      { volume: 'acme-api-3f2a9c1e', subpath: 'api/data/pg', readOnly: false },
      { volume: 'acme-api-3f2a9c1e', subpath: 'api/init.sql', readOnly: true },
    ]);
    expect(containers[1].volumeSubpaths).toBeUndefined();
    expect(runner.calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['ps', '-a'],
      ['container', 'inspect'],
    ]);
  });

  it('reads the targets of the mounts of a container (review round 12, D12-2)', async () => {
    const dev = {
      ...containerJson({ id: 'dev1', name: 'acme-api-3f2a9c1e', status: 'running', labels: { 'com.docker.compose.project': 'devenv-3f2a9c1e' } }),
      HostConfig: { Tmpfs: { '/workspaces/api/tmp': 'rw' } },
      Mounts: [
        { Type: 'volume', Name: 'acme-api-3f2a9c1e', Source: '/var/lib/docker/volumes/acme-api-3f2a9c1e/_data', Destination: '/workspaces', RW: true },
        { Type: 'volume', Name: 'devenv-3f2a9c1e_pgdata', Source: '/var/lib/docker/volumes/devenv-3f2a9c1e_pgdata/_data', Destination: '/workspaces/api/.pgdata', RW: true },
        { Type: 'bind', Source: '/home/me/.ssh', Destination: '/home/vscode/.ssh', RW: false },
        { Type: 'tmpfs', Destination: '/run/x' },
        { Type: 'volume', Name: 'broken' },
      ],
    };
    const { docker } = adapter((call) => (call.args[0] === 'ps' ? ok(idLines(['dev1'])) : ok(inspectOutput([dev]))));
    const [container] = await docker.listProjectContainers('devenv-3f2a9c1e');
    expect(container.mountTargets).toEqual([
      { type: 'volume', volume: 'acme-api-3f2a9c1e', target: '/workspaces' },
      { type: 'volume', volume: 'devenv-3f2a9c1e_pgdata', target: '/workspaces/api/.pgdata' },
      { type: 'bind', target: '/home/vscode/.ssh' },
      { type: 'tmpfs', target: '/run/x' },
      { type: 'tmpfs', target: '/workspaces/api/tmp' },
    ]);
  });

  it('reads the subpath of a volume mount from HostConfig.Mounts, matched by volume and target (review round 14, P14-1)', async () => {
    const V = 'acme-api-3f2a9c1e';
    const source = `/var/lib/docker/volumes/${V}/_data`;
    const dev = {
      ...containerJson({ id: 'dev1', name: V, status: 'running', labels: { 'com.docker.compose.project': 'devenv-3f2a9c1e' } }),
      HostConfig: {
        Mounts: [
          { Type: 'volume', Source: V, Target: '/workspaces' },
          { Type: 'volume', Source: V, Target: '/workspaces/api/', VolumeOptions: { NoCopy: true, Subpath: 'api' } },
          { Type: 'volume', Source: V, Target: '/workspaces/api/src', VolumeOptions: { Subpath: 'api/src' } },
          // Another volume at the same target does not count; two different subpaths at one target: not known.
          { Type: 'volume', Source: 'other', Target: '/workspaces/api/pgview', VolumeOptions: { Subpath: 'x' } },
          { Type: 'volume', Source: V, Target: '/workspaces/api/twice', VolumeOptions: { Subpath: 'api/a' } },
          { Type: 'volume', Source: V, Target: '/workspaces/api/twice', VolumeOptions: { Subpath: 'api/b' } },
        ],
      },
      // The top-level Mounts have no VolumeOptions.
      Mounts: [
        { Type: 'volume', Name: V, Source: source, Destination: '/workspaces', RW: true },
        { Type: 'volume', Name: V, Source: source, Destination: '/workspaces/api', RW: true },
        { Type: 'volume', Name: V, Source: source, Destination: '/workspaces/api/src', RW: true },
        { Type: 'volume', Name: V, Source: source, Destination: '/workspaces/api/pgview', RW: true },
        { Type: 'volume', Name: V, Source: source, Destination: '/workspaces/api/twice', RW: true },
      ],
    };
    const { docker } = adapter((call) => (call.args[0] === 'ps' ? ok(idLines(['dev1'])) : ok(inspectOutput([dev]))));
    const [container] = await docker.listProjectContainers('devenv-3f2a9c1e');
    expect(container.mountTargets).toEqual([
      { type: 'volume', volume: V, target: '/workspaces' },
      { type: 'volume', volume: V, target: '/workspaces/api', subpath: 'api' },
      { type: 'volume', volume: V, target: '/workspaces/api/src', subpath: 'api/src' },
      { type: 'volume', volume: V, target: '/workspaces/api/pgview' },
      { type: 'volume', volume: V, target: '/workspaces/api/twice' },
    ]);
  });

  it('lists the networks of the project by its label', async () => {
    const { docker, runner } = adapter(() => ok('"devenv-3f2a9c1e_default"\n"devenv-3f2a9c1e_backend"\n'));
    expect(await docker.listProjectNetworks('devenv-3f2a9c1e')).toEqual(['devenv-3f2a9c1e_default', 'devenv-3f2a9c1e_backend']);
    expect(runner.calls[0].args).toEqual(['network', 'ls', '--filter', 'label=com.docker.compose.project=devenv-3f2a9c1e', '--format', '{{json .Name}}']);
  });

  it('removes a network; a missing one is no error, a network in use is', async () => {
    const { docker, runner } = adapter(() => ok());
    await docker.removeNetwork('devenv-3f2a9c1e_default');
    expect(runner.calls[0].args).toEqual(['network', 'rm', 'devenv-3f2a9c1e_default']);
    await expect(adapter(() => fail('Error response from daemon: network devenv-3f2a9c1e_default not found')).docker.removeNetwork('x')).resolves.toBeUndefined();
    await expect(adapter(() => fail('Error: No such network: x')).docker.removeNetwork('x')).resolves.toBeUndefined();
    await expect(adapter(() => fail('Error response from daemon: error while removing network: network x has active endpoints')).docker.removeNetwork('x')).rejects.toThrow('active endpoints');
  });

  it('lists the images that Compose built for the project, and only those', async () => {
    const lines = [
      { Repository: 'devenv-3f2a9c1e-app', Tag: 'latest' },
      { Repository: 'devenv-3f2a9c1e-worker', Tag: 'latest' },
      // Docker's filter is a pattern: the result is checked again.
      { Repository: 'devenv-3f2a9c1e', Tag: '2' },
      { Repository: 'devenv-3f2a9c1e-old', Tag: '<none>' },
    ].map((line) => JSON.stringify(line));
    const { docker, runner } = adapter(() => ok(`${lines.join('\n')}\n`));
    expect(await docker.listProjectImages('devenv-3f2a9c1e')).toEqual(['devenv-3f2a9c1e-app:latest', 'devenv-3f2a9c1e-worker:latest']);
    expect(runner.calls[0].args).toEqual(['image', 'ls', '--filter', 'reference=devenv-3f2a9c1e-*', '--format', '{{json .}}']);
  });

  it('leaves out the images whose label names another environment (review round 1, D3)', async () => {
    const lines = [
      { Repository: 'devenv-3f2a9c1e-app', Tag: 'latest' },
      { Repository: 'devenv-3f2a9c1e-db', Tag: 'latest' },
      { Repository: 'devenv-3f2a9c1e-tool', Tag: 'latest' },
    ].map((line) => JSON.stringify(line));
    const { docker, runner } = adapter((call) => {
      if (call.args[0] === 'image' && call.args[1] === 'ls') return ok(`${lines.join('\n')}\n`);
      return ok(
        inspectOutput([
          { RepoTags: ['devenv-3f2a9c1e-app:latest'], Config: { Labels: { 'devenv.environment-id': 'env-1' } } },
          { RepoTags: ['devenv-3f2a9c1e-db:latest'], Config: { Labels: { 'devenv.environment-id': 'env-2' } } },
          { RepoTags: ['devenv-3f2a9c1e-tool:latest'], Config: { Labels: null } },
        ]),
      );
    });
    expect(await docker.listProjectImages('devenv-3f2a9c1e', 'env-1')).toEqual(['devenv-3f2a9c1e-app:latest', 'devenv-3f2a9c1e-tool:latest']);
    expect(runner.calls[1].args).toEqual(['image', 'inspect', 'devenv-3f2a9c1e-app:latest', 'devenv-3f2a9c1e-db:latest', 'devenv-3f2a9c1e-tool:latest']);
  });
});
