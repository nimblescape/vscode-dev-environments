// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR A: which Docker calls go through the worker, and the routing of ContainerAdapter.run.
import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import { HelperChannelError, HelperOperationError } from '../helperChannel/helperChannel';
import { abortError, isAbortError, silentLogger, type Logger, type ProcessRunner, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import { ContainerAdapter, type DockerRouter } from './containerAdapter';
import { LOCAL_DOCKER_TARGET, dockerTargetOf, remoteContextName, type DockerTarget } from './dockerHost';
import { dockerCommandWords, isReadOnlyDockerCall, isRoutableDockerCall } from './dockerRouting';
import { runWithDockerTarget } from './dockerTargets';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextName('build-box'));

interface Call {
  args: string[];
  options: RunOptions;
}

class FakeRunner implements ProcessRunner {
  readonly calls: Call[] = [];
  readonly started: string[][] = [];
  constructor(private readonly handler: (args: string[]) => RunResult | Promise<RunResult> = () => ok()) {}
  async run(_file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ args: [...args], options });
    if (options.signal?.aborted) throw abortError();
    return this.handler([...args]);
  }
  start(_file: string, args: readonly string[]): StartedProcess {
    this.started.push([...args]);
    return { write: () => true, end: () => {}, kill: () => {}, onStdout: () => {}, onStderr: () => {}, exited: new Promise(() => {}) };
  }
}

function ok(stdout = ''): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: { ...silentLogger, info: (text) => lines.push(text), warn: (text) => lines.push(text) }, lines };
}

describe('isRoutableDockerCall and isReadOnlyDockerCall (plan step 5, PR A)', () => {
  it('routes only the plain calls of the allowlist', () => {
    const routable = [
      ['ps', '-a', '--no-trunc', '--filter', 'label=x', '--format', '{{json .ID}}'],
      ['inspect', 'x'],
      ['info', '--format', '{{json .ServerVersion}}'],
      ['version', '--format', '{{.Server.APIVersion}}'],
      ['images'],
      ['stop', 'c'],
      ['rm', '-f', 'c'],
      ['rmi', 'img'],
      ['rename', 'a', 'b'],
      ['exec', 'c', 'git', 'status'],
      ['exec', '-u', 'root', '-w', '/workspaces', 'c', 'cat', '/proc/self/mountinfo'],
      ['container', 'inspect', 'c'],
      ['container', 'ls'],
      ['container', 'ps'],
      ['container', 'stop', 'c'],
      ['container', 'rm', 'c'],
      ['container', 'rename', 'a', 'b'],
      ['image', 'inspect', 'i'],
      ['image', 'ls'],
      ['image', 'rm', 'i'],
      ['volume', 'inspect', 'v'],
      ['volume', 'ls'],
      ['volume', 'rm', 'v'],
      ['volume', 'create', '--label', 'a=b', 'v'],
      ['network', 'inspect', 'n'],
      ['network', 'ls'],
      ['network', 'rm', 'n'],
    ];
    for (const args of routable) expect(isRoutableDockerCall(args, { timeoutMs: 1_000, signal: new AbortController().signal }), args.join(' ')).toBe(true);
    const refused = [
      [],
      ['run', '--rm', 'img'],
      ['create', 'img'],
      ['start', 'c'],
      ['build', '.'],
      ['pull', 'img'],
      ['push', 'img'],
      ['cp', 'c:/a', '/b'],
      ['context', 'inspect'],
      ['context', 'use', 'x'],
      ['desktop', 'start'],
      ['login', 'ghcr.io'],
      ['compose', 'ps'],
      ['buildx', 'build', '.'],
      ['logs', 'c'],
      ['events'],
      ['container', 'prune', '-f'],
      ['image', 'prune', '-f'],
      ['volume', 'prune', '-f'],
      ['network', 'prune', '-f'],
      ['system', 'prune', '-f'],
      ['container', 'create', 'img'],
      ['container', 'start', 'c'],
      ['image', 'pull', 'i'],
      ['image', 'history', 'i'],
      ['network', 'create', 'n'],
      ['network', 'connect', 'n', 'c'],
      // Global options before the command.
      ['-H', 'ssh://other', 'ps'],
      ['--host=ssh://other', 'ps'],
      ['--context', 'other', 'ps'],
      ['-c', 'other', 'ps'],
      ['--config', '/tmp/x', 'pull', 'i'],
      ['--config', '/tmp/x', 'ps'],
      ['-l', 'debug', 'info'],
      ['--debug', 'info'],
      // An environment variable, anywhere.
      ['exec', '-e', 'TOKEN=x', 'c', 'true'],
      ['exec', '--env', 'TOKEN=x', 'c', 'true'],
      ['exec', '--env=TOKEN=x', 'c', 'true'],
      ['exec', '--env-file', '/tmp/env', 'c', 'true'],
      ['exec', '--env-file=/tmp/env', 'c', 'true'],
      ['exec', '-eTOKEN=x', 'c', 'true'],
      ['exec', '-de', 'TOKEN=x', 'c', 'true'],
      ['exec', 'c', 'sh', '-e', '-c', 'true'],
      // exec with its input.
      ['exec', '-i', 'c', 'cat'],
      ['exec', '-it', 'c', 'sh'],
      ['exec', '--interactive', 'c', 'cat'],
      ['exec', '--interactive=true', 'c', 'cat'],
    ];
    for (const args of refused) expect(isRoutableDockerCall(args), args.join(' ')).toBe(false);
  });

  it('never routes a call with an input, an environment, a folder, or streamed output', () => {
    for (const options of [
      { input: '' },
      { input: 'token' },
      { env: {} },
      { cwd: '/tmp' },
      { onStdout: () => {} },
      { onStderr: () => {} },
    ] satisfies RunOptions[]) {
      expect(isRoutableDockerCall(['ps'], options), JSON.stringify(Object.keys(options))).toBe(false);
    }
  });

  it('isReadOnlyDockerCall: the calls that may run again without any effect', () => {
    expect(isReadOnlyDockerCall(['info'])).toBe(true);
    expect(isReadOnlyDockerCall(['volume', 'ls'])).toBe(true);
    expect(isReadOnlyDockerCall(['stop', 'c'])).toBe(false);
    expect(isReadOnlyDockerCall(['exec', 'c', 'git', 'status'])).toBe(false);
    expect(dockerCommandWords(['--context', 'x', 'volume', 'rm', 'v'])).toEqual(['volume', 'rm']);
  });
});

/**
 * How each Docker command that ContainerAdapter issues is routed (plan step 5, PR A). Key: the command, or the object and
 * its command; `--config pull` for a pull with its own config folder; `exec -i` for an exec with its input. A new call
 * of the adapter fails the test below until it is classified here.
 */
const CLASSIFICATION: Record<string, { routed: boolean; readOnly: boolean }> = {
  info: { routed: true, readOnly: true },
  version: { routed: true, readOnly: true },
  ps: { routed: true, readOnly: true },
  'container inspect': { routed: true, readOnly: true },
  'image inspect': { routed: true, readOnly: true },
  'image ls': { routed: true, readOnly: true },
  'volume inspect': { routed: true, readOnly: true },
  'volume ls': { routed: true, readOnly: true },
  'network inspect': { routed: true, readOnly: true },
  'network ls': { routed: true, readOnly: true },
  stop: { routed: true, readOnly: false },
  rename: { routed: true, readOnly: false },
  rm: { routed: true, readOnly: false },
  exec: { routed: true, readOnly: false },
  'image rm': { routed: true, readOnly: false },
  'volume create': { routed: true, readOnly: false },
  'volume rm': { routed: true, readOnly: false },
  'network rm': { routed: true, readOnly: false },
  'exec -i': { routed: false, readOnly: false },
  'context inspect': { routed: false, readOnly: true },
  pull: { routed: false, readOnly: false },
  '--config pull': { routed: false, readOnly: false },
  build: { routed: false, readOnly: false },
};

const OBJECTS = new Set(['container', 'image', 'volume', 'network', 'context']);

function commandKey(args: readonly string[]): string {
  if (args[0] === '--config') return `--config ${args[2]}`;
  if (args[0] === 'exec' && args.includes('-i')) return 'exec -i';
  return OBJECTS.has(args[0]) ? `${args[0]} ${args[1]}` : args[0];
}

/** Public and internal members of ContainerAdapter that issue no Docker call of their own, or only pass one through. */
const NO_OWN_CALL = new Set([
  'constructor',
  'dockerPath',
  'isInstalled',
  'setRouter',
  'run',
  'runRouted',
  'runDirect',
  'runOnce',
  'start',
  'operationEnv',
  'processEnv',
  'lookUpCliNow',
  'reportCliLost',
  'lookUpCliIfMissing',
  'runChecked',
  'queryDaemonStatus',
  'envForOwnConfig',
  'containerIds',
  'inspectContainers',
  'inspectBatch',
  'onlyMissing',
  'isMissing',
  'commandError',
]);

describe('the classification of every Docker call of ContainerAdapter (plan step 5, PR A)', () => {
  it('routes exactly the classified calls within an operation, and every call is classified', async () => {
    const runner = new FakeRunner((args) => {
      const key = commandKey(args);
      if (key === 'ps') return ok('"c1"\n');
      if (key === 'image ls') return ok(`${JSON.stringify({ ID: 'sha256:1', Repository: 'p-s', Tag: '1', CreatedAt: 'x' })}\n`);
      if (key === 'volume ls' || key === 'network ls') return ok('"x"\n');
      if (key === 'context inspect') return ok('"unix:///var/run/docker.sock"\n');
      return ok(args.includes('--format') ? '"x"\n' : '[]\n');
    });
    const docker = new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux');
    const routed: string[] = [];
    docker.setRouter(async (_target, args) => {
      routed.push(JSON.stringify(args));
      // Not sent: every call also runs directly, so the runner sees all of them.
      return undefined;
    });
    const exercised: Record<string, (d: ContainerAdapter) => Promise<unknown>> = {
      daemonStatus: (d) => d.daemonStatus(),
      isRunning: (d) => d.isRunning(),
      findContainer: (d) => d.findContainer('e', 'n'),
      engineApiVersion: (d) => d.engineApiVersion(),
      listEnvironmentContainers: (d) => d.listEnvironmentContainers(),
      listProjectContainers: (d) => d.listProjectContainers('p'),
      listProjectNetworks: (d) => d.listProjectNetworks('p'),
      removeNetwork: (d) => d.removeNetwork('n'),
      listProjectImages: (d) => d.listProjectImages('p', 'e'),
      containerState: (d) => d.containerState('c'),
      stopContainer: (d) => d.stopContainer('c'),
      renameContainer: (d) => d.renameContainer('c', 'd'),
      removeContainer: (d) => d.removeContainer('c'),
      exec: async (d) => {
        await d.exec('c', ['git', 'status'], { user: 'u', workdir: '/w' });
        await d.exec('c', ['cat'], { input: 'secret' });
      },
      volumeExists: (d) => d.volumeExists('v'),
      createVolume: (d) => d.createVolume('v', { a: 'b' }),
      removeVolume: (d) => d.removeVolume('v'),
      listEnvironmentVolumes: (d) => d.listEnvironmentVolumes(),
      inspectVolumes: (d) => d.inspectVolumes(['v']),
      inspectNetworks: (d) => d.inspectNetworks(['n']),
      imageExists: (d) => d.imageExists('i'),
      imageId: (d) => d.imageId('i'),
      imageNames: (d) => d.imageNames('i'),
      inspectImageNames: (d) => d.inspectImageNames(['i']),
      listImagesByLabel: (d) => d.listImagesByLabel('l'),
      removeImage: (d) => d.removeImage('i'),
      listEnvironmentImages: (d) => d.listEnvironmentImages(),
      listImageTags: (d) => d.listImageTags('p-s'),
      pullImage: async (d) => {
        await d.pullImage('i', { onOutput: () => {} });
        await d.pullImage('ghcr.io/o/i:1', { onOutput: () => {}, credentials: { registry: 'ghcr.io', username: 'u', password: 'token' } });
      },
      buildImage: (d) => d.buildImage({ tag: 't', dockerfile: 'D', context: '.', onOutput: () => {} }),
      imageLabels: (d) => d.imageLabels('i'),
    };
    const members = Object.getOwnPropertyNames(ContainerAdapter.prototype);
    const unknown = members.filter((name) => !NO_OWN_CALL.has(name) && !(name in exercised));
    expect(unknown, 'a new member of ContainerAdapter: exercise it here and classify its calls').toEqual([]);
    const all: Call[] = [];
    await runWithDockerTarget(REMOTE, async () => {
      for (const [name, call] of Object.entries(exercised)) {
        runner.calls.length = 0;
        // Only the calls count here; a method may reject the fake output of a later call (for example imageNames).
        await call(docker).catch(() => undefined);
        expect(runner.calls.length, `${name} issued no Docker call`).toBeGreaterThan(0);
        all.push(...runner.calls);
      }
    });
    const keys = new Set<string>();
    for (const { args } of all) {
      const key = commandKey(args);
      keys.add(key);
      const expected = CLASSIFICATION[key];
      expect(expected, `unclassified Docker call: docker ${args.join(' ')}`).toBeDefined();
      expect(routed.includes(JSON.stringify(args)), `routed: docker ${args.join(' ')}`).toBe(expected.routed);
      expect(isReadOnlyDockerCall(args), `read-only: docker ${args.join(' ')}`).toBe(expected.readOnly);
    }
    // Every entry of the table is issued by the adapter (no stale entry).
    expect([...keys].sort()).toEqual(Object.keys(CLASSIFICATION).sort());
    // The token of the pull and the input of the exec never reached the router.
    expect(routed.some((args) => args.includes('token') || args.includes('secret'))).toBe(false);
  });
});

describe('ContainerAdapter.run with a router (plan step 5, PR A)', () => {
  function setup(router: DockerRouter, handler?: (args: string[]) => RunResult) {
    const runner = new FakeRunner(handler);
    const { logger, lines } = recordingLogger();
    const docker = new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux');
    docker.setRouter(router);
    return { docker, runner, lines };
  }

  it('routes a routable call within an operation with its time limit and signal, and runs nothing directly', async () => {
    const seen: { target: DockerTarget; args: readonly string[]; options: RunOptions }[] = [];
    const { docker, runner } = setup(async (target, args, options) => {
      seen.push({ target, args, options });
      return ok('routed');
    });
    const signal = new AbortController().signal;
    const result = await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['stop', 'c'], { timeoutMs: 5_000, signal }));
    expect(result.stdout).toBe('routed');
    expect(seen).toEqual([{ target: LOCAL_DOCKER_TARGET, args: ['stop', 'c'], options: { timeoutMs: 5_000, signal } }]);
    expect(runner.calls).toEqual([]);
  });

  it('runs directly when the router returns undefined', async () => {
    const { docker, runner } = setup(async () => undefined, () => ok('direct'));
    const result = await runWithDockerTarget(REMOTE, () => docker.run(['rm', '-f', 'c'], { timeoutMs: 5_000 }));
    expect(result.stdout).toBe('direct');
    expect(runner.calls.map((call) => call.args)).toEqual([['rm', '-f', 'c']]);
    expect(runner.calls[0].options.env?.DOCKER_CONTEXT).toBe(REMOTE.context);
  });

  it('runs a non-routable call directly, never through the router', async () => {
    let routed = 0;
    const { docker, runner } = setup(async () => {
      routed++;
      return ok();
    });
    await runWithDockerTarget(REMOTE, async () => {
      await docker.run(['exec', '-i', 'c', 'cat'], { input: 'token' });
      await docker.run(['run', '--rm', 'img']);
      await docker.run(['ps'], { onStdout: () => {} });
    });
    expect(routed).toBe(0);
    expect(runner.calls).toHaveLength(3);
  });

  for (const [what, error] of [
    ['lost', new HelperChannelError('lost', 'The helper channel to build-box was lost.')],
    ['protocol', new HelperChannelError('protocol', 'invalid answer')],
    ['an operation failure', new HelperOperationError('failed', 'spawn docker ENOENT', false)],
  ] as const) {
    it(`a read-only call is retried once directly after ${what} (logged)`, async () => {
      const { docker, runner, lines } = setup(
        async () => {
          throw error;
        },
        () => ok('direct'),
      );
      const result = await runWithDockerTarget(REMOTE, () => docker.run(['volume', 'ls'], { timeoutMs: 5_000 }));
      expect(result.stdout).toBe('direct');
      expect(runner.calls.map((call) => call.args)).toEqual([['volume', 'ls']]);
      expect(lines.some((line) => line.includes('docker volume ls through the worker failed') && line.includes('runs once more directly'))).toBe(true);
    });

    it(`a mutating call throws after ${what}, with no direct call`, async () => {
      const { docker, runner, lines } = setup(async () => {
        throw error;
      });
      const thrown = await runWithDockerTarget(REMOTE, () => docker.run(['volume', 'rm', 'v'], { timeoutMs: 5_000 })).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(CommandError);
      expect((thrown as CommandError).message).toContain('the outcome of docker volume rm is not known');
      expect((thrown as CommandError).message).toContain('The connection to the Docker host was lost');
      expect(runner.calls).toEqual([]);
      expect(lines.some((line) => line.includes('is not repeated'))).toBe(true);
      // Also through the adapter's own methods: Stop is not reported as done.
      await expect(runWithDockerTarget(REMOTE, () => docker.stopContainer('c'))).rejects.toBeInstanceOf(CommandError);
      expect(runner.calls).toEqual([]);
    });
  }

  it('passes another error of the router on unchanged, without a direct call', async () => {
    const failure = new Error('something else');
    const { docker, runner } = setup(async () => {
      throw failure;
    });
    await expect(runWithDockerTarget(REMOTE, () => docker.run(['ps']))).rejects.toBe(failure);
    expect(runner.calls).toEqual([]);
  });

  it('an abort propagates as an AbortError, without a direct call', async () => {
    const controller = new AbortController();
    const { docker, runner } = setup(async (_target, _args, options) => {
      controller.abort();
      // A cancel that could not be sent: the channel reports the call as lost.
      if (options.signal?.aborted) throw new HelperChannelError('lost', 'The cancel of docker could not be sent.');
      return ok();
    });
    const read = await runWithDockerTarget(REMOTE, () => docker.run(['ps'], { signal: controller.signal })).catch((e: unknown) => e);
    expect(isAbortError(read)).toBe(true);
    const { docker: docker2, runner: runner2 } = setup(async () => {
      throw abortError();
    });
    const write = await runWithDockerTarget(REMOTE, () => docker2.run(['stop', 'c'])).catch((e: unknown) => e);
    expect(isAbortError(write)).toBe(true);
    expect(runner.calls).toEqual([]);
    expect(runner2.calls).toEqual([]);
  });

  it('routes nothing outside an operation', async () => {
    let routed = 0;
    const { docker, runner } = setup(async () => {
      routed++;
      return ok();
    });
    await docker.run(['ps']);
    await docker.stopContainer('c');
    // Also not after the operation ended (a timer of it keeps its store).
    let later: (() => Promise<RunResult>) | undefined;
    await runWithDockerTarget(REMOTE, async () => {
      later = () => docker.run(['info']);
    });
    await later?.();
    expect(routed).toBe(0);
    expect(runner.calls).toHaveLength(3);
  });

  it('never routes start (the worker itself is started with it)', async () => {
    let routed = 0;
    const { docker, runner } = setup(async () => {
      routed++;
      return ok();
    });
    await runWithDockerTarget(REMOTE, async () => {
      docker.start(['run', '--rm', '-i', 'img']);
      docker.start(['ps']);
    });
    expect(routed).toBe(0);
    expect(runner.started).toEqual([['run', '--rm', '-i', 'img'], ['ps']]);
  });

  it('runDirect never routes', async () => {
    let routed = 0;
    const { docker, runner } = setup(async () => {
      routed++;
      return ok();
    });
    await runWithDockerTarget(REMOTE, () => docker.runDirect(['info', '--format', '{{json .ID}} {{json .DockerRootDir}}']));
    expect(routed).toBe(0);
    expect(runner.calls).toHaveLength(1);
  });

  it('routes nothing without a router', async () => {
    const runner = new FakeRunner();
    const docker = new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux');
    await runWithDockerTarget(REMOTE, () => docker.run(['ps']));
    docker.setRouter(async () => ok('routed'));
    docker.setRouter(undefined);
    await runWithDockerTarget(REMOTE, () => docker.run(['ps']));
    expect(runner.calls).toHaveLength(2);
  });
});
