// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Live check of 2026-10-03 (the first Start on a remote host): the label build of the environment image and the helper
// run with a cleanup label go through the worker; the direct calls that do not only read are logged.
import { describe, expect, it } from 'vitest';
import { abortError, silentLogger, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { MAX_DOCKER_INPUT_LENGTH, channelStepLabel, newCleanupLabel } from '../helperChannel/protocol';
import { ContainerAdapter, type RoutedDockerOptions } from './containerAdapter';
import { dockerTargetOf, remoteContextNames, type DockerTarget } from './dockerHost';
import { helperRunCleanup, isRoutableDockerCall, labelBuildCall } from './dockerRouting';
import { runWithDockerTarget } from './dockerTargets';
import { runWithEnvironmentLock, type HeldEnvironmentLock } from './environmentLock';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);
const CLEANUP = '0123456789abcdef01234567';
const LABEL_BUILD = ['build', '--quiet', '-t', 'devenv-o-r-calm-curie:1', '--label', 'a=b', '--label', 'c={"x":1}', '-'];
const HELPER_RUN = [
  'run',
  '--rm',
  '--init',
  '--pull',
  'never',
  '--network',
  'none',
  '--label',
  'nimblescape.devenv.helper-run=true',
  '--label',
  channelStepLabel(CLEANUP),
  '--user',
  'root',
  '--entrypoint',
  'sh',
  '--mount',
  'type=volume,source=v,target=/workspaces',
  'img',
  '-c',
  'chown -R "$1" /workspaces/r',
  'sh',
  'dev',
];

class FakeRunner implements ProcessRunner {
  readonly calls: { args: string[]; options: RunOptions }[] = [];
  constructor(private readonly handler: (args: string[]) => RunResult | Promise<RunResult> = () => ok()) {}
  async run(_file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ args: [...args], options });
    if (options.signal?.aborted) throw abortError();
    return this.handler([...args]);
  }
}

function ok(stdout = ''): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: { ...silentLogger, info: (text) => lines.push(`info ${text}`), warn: (text) => lines.push(`warn ${text}`) }, lines };
}

describe('labelBuildCall and helperRunCleanup (live check of 2026-10-03)', () => {
  it('takes only the label build of labelImage', () => {
    expect(labelBuildCall(LABEL_BUILD)).toBe(true);
    expect(labelBuildCall(['build', '--quiet', '-t', 'i', '-'])).toBe(true);
    for (const args of [
      ['build', '-t', 'i', '-'],
      ['build', '--quiet', '-t', 'i', '.'],
      ['build', '--quiet', '-t', 'i', '--label', 'a=b', '.', '-'],
      ['build', '--quiet', '-t', 'i', '--build-arg', 'a=b', '-'],
      ['build', '--quiet', '-t', 'i', '--label', 'a=b', '--label', '-'],
      ['build', '--quiet', '-t', 'i', '--label', '--secret=id=x', '-'],
      ['build', '--quiet', '-t', 'i', '--label', 'nolabel', '-'],
      ['build', '--quiet', '-t', '--push', '-'],
      ['buildx', '--quiet', '-t', 'i', '-'],
      ['build', '--quiet', '-t', 'i'],
    ]) {
      expect(labelBuildCall(args), args.join(' ')).toBe(false);
    }
  });

  it('routes the label build only with its input, within the input limit, and nothing else with an input', () => {
    expect(isRoutableDockerCall(LABEL_BUILD, { input: 'FROM devenv-o-r-calm-curie:1\n' })).toBe(true);
    expect(isRoutableDockerCall(LABEL_BUILD, { input: 'x'.repeat(MAX_DOCKER_INPUT_LENGTH) })).toBe(true);
    expect(isRoutableDockerCall(LABEL_BUILD, { input: 'x'.repeat(MAX_DOCKER_INPUT_LENGTH + 1) })).toBe(false);
    expect(isRoutableDockerCall(LABEL_BUILD)).toBe(false);
    expect(isRoutableDockerCall(LABEL_BUILD, { input: 'FROM i\n', onStdout: () => {} })).toBe(false);
    expect(isRoutableDockerCall(LABEL_BUILD, { input: 'FROM i\n', env: {} })).toBe(false);
    expect(isRoutableDockerCall(['--context', 'x', ...LABEL_BUILD], { input: 'FROM i\n' })).toBe(false);
    expect(isRoutableDockerCall(['build', '--quiet', '-t', 'i', '--label', 'e=1', '-e', '-'], { input: 'FROM i\n' })).toBe(false);
    for (const args of [['ps'], ['exec', 'c', 'cat'], ['exec', '-i', 'c', 'cat'], ['volume', 'create', 'v'], HELPER_RUN]) {
      expect(isRoutableDockerCall(args, { input: 'x' }), args.join(' ')).toBe(false);
    }
  });

  it('routes a helper run with --rm, --pull never, and exactly one valid cleanup label, and gives that label', () => {
    expect(helperRunCleanup(HELPER_RUN)).toBe(CLEANUP);
    expect(isRoutableDockerCall(HELPER_RUN, { timeoutMs: 1_000 })).toBe(true);
    const fresh = newCleanupLabel();
    expect(helperRunCleanup(['run', '--rm', '--pull', 'never', `--label=${channelStepLabel(fresh)}`, 'img'])).toBe(fresh);
    expect(helperRunCleanup(['run', '--rm', '--pull', 'never', '-l', channelStepLabel(fresh), 'img'])).toBe(fresh);
    const without = (drop: number, count = 1): string[] => [...HELPER_RUN.slice(0, drop), ...HELPER_RUN.slice(drop + count)];
    for (const [what, args] of [
      ['no --rm', without(1)],
      ['no --pull never', without(3, 2)],
      ['--pull always', HELPER_RUN.map((arg, i) => (i === 4 ? 'always' : arg))],
      ['no cleanup label', without(9, 2)],
      ['an invalid cleanup label', HELPER_RUN.map((arg) => (arg === channelStepLabel(CLEANUP) ? channelStepLabel('XYZ') : arg))],
      ['two cleanup labels', [...HELPER_RUN.slice(0, 11), '--label', channelStepLabel(newCleanupLabel()), ...HELPER_RUN.slice(11)]],
      ['-d', ['run', '-d', ...HELPER_RUN.slice(1)]],
      ['--detach', ['run', '--detach', ...HELPER_RUN.slice(1)]],
      ['-i', ['run', '-i', ...HELPER_RUN.slice(1)]],
      ['-t', ['run', '-t', ...HELPER_RUN.slice(1)]],
      ['-it', ['run', '-it', ...HELPER_RUN.slice(1)]],
      ['--tty', ['run', '--tty', ...HELPER_RUN.slice(1)]],
      ['not run', ['create', ...HELPER_RUN.slice(1)]],
    ] as const) {
      expect(helperRunCleanup(args), what).toBeUndefined();
      expect(isRoutableDockerCall(args), what).toBe(false);
    }
    // An environment variable keeps it direct (no token through the worker), as for every call.
    expect(isRoutableDockerCall(['run', '-e', 'T=x', ...HELPER_RUN.slice(1)])).toBe(false);
    expect(isRoutableDockerCall(['run', '--env-file', '/f', ...HELPER_RUN.slice(1)])).toBe(false);
    // Changed expectation of plan step 5, PR A stays: a plain run without the cleanup label is direct.
    expect(isRoutableDockerCall(['run', '--rm', 'img'])).toBe(false);
  });
});

describe('ContainerAdapter: the routed label build and helper run (live check of 2026-10-03)', () => {
  it('sends the label build through the router with its input, and the helper run with its cleanup label', async () => {
    const runner = new FakeRunner();
    const docker = new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux');
    const seen: { args: readonly string[]; options: RoutedDockerOptions }[] = [];
    docker.setRouter(async (_target, args, options) => {
      seen.push({ args, options });
      return ok();
    });
    const signal = new AbortController().signal;
    await runWithDockerTarget(REMOTE, async () => {
      await docker.run(LABEL_BUILD, { input: 'FROM devenv-o-r-calm-curie:1\n', signal });
      await docker.run(HELPER_RUN, { timeoutMs: 5_000, signal });
      await docker.run(['ps'], { timeoutMs: 1_000 });
    });
    expect(seen).toEqual([
      { args: LABEL_BUILD, options: { timeoutMs: undefined, signal, input: 'FROM devenv-o-r-calm-curie:1\n' } },
      { args: HELPER_RUN, options: { timeoutMs: 5_000, signal, cleanup: CLEANUP } },
      { args: ['ps'], options: { timeoutMs: 1_000, signal: undefined } },
    ]);
    expect(runner.calls).toEqual([]);
  });

  it('sends them through the worker that holds the lock of the environment, with the input and the cleanup label', async () => {
    const runner = new FakeRunner();
    const docker = new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux');
    const seen: { args: readonly string[]; options: unknown }[] = [];
    const lock: HeldEnvironmentLock = {
      environmentId: 'e',
      lost: new Promise(() => {}),
      docker: async (args, options) => {
        seen.push({ args, options });
        return ok();
      },
      release: async () => {},
    };
    await runWithEnvironmentLock(lock, async () => {
      await docker.run(LABEL_BUILD, { input: 'FROM i\n' });
      await docker.run(HELPER_RUN);
    });
    expect(seen).toEqual([
      { args: LABEL_BUILD, options: { timeoutMs: undefined, signal: undefined, input: 'FROM i\n' } },
      { args: HELPER_RUN, options: { timeoutMs: undefined, signal: undefined, cleanup: CLEANUP } },
    ]);
    expect(runner.calls).toEqual([]);
  });

  it('labelImage builds through the worker within an operation', async () => {
    const ids = ['"sha256:old"\n', '"sha256:new"\n'];
    const runner = new FakeRunner((args) => {
      if (args[0] === 'image' && args[1] === 'inspect' && args.includes('{{json .Id}}')) return ok(ids.shift() ?? '"sha256:new"\n');
      if (args[0] === 'image' && args[1] === 'inspect') return ok('{"repoTags":[],"repoDigests":[]}\n');
      return ok();
    });
    const docker = new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux');
    const routedBuilds: RoutedDockerOptions[] = [];
    docker.setRouter(async (_target, args, options) => {
      if (args[0] === 'build') routedBuilds.push(options);
      return runner.run('docker', args, options);
    });
    await runWithDockerTarget(REMOTE, () => docker.labelImage('img:1', { k: 'v' }));
    expect(routedBuilds).toEqual([{ timeoutMs: undefined, signal: undefined, input: 'FROM img:1\n' }]);
  });
});

describe('ContainerAdapter.runDirect logs the calls that do not only read (live check of 2026-10-03)', () => {
  function setup(handler?: (args: string[]) => RunResult | Promise<RunResult>) {
    const runner = new FakeRunner(handler);
    const { logger, lines } = recordingLogger();
    let now = 1_000;
    const clock = { now: () => now };
    const docker = new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { clock });
    return { docker, lines, advance: (ms: number) => (now += ms) };
  }

  it('logs the first two words, the exit code, and the time, never the arguments or the input', async () => {
    let advance!: (ms: number) => void;
    const made = setup((args) => {
      advance(12_100);
      return args[0] === 'pull' ? { exitCode: 1, stdout: '', stderr: 'denied', timedOut: false } : ok();
    });
    advance = made.advance;
    await made.docker.runDirect(['build', '--quiet', '-t', 'secret-name', '--label', 'k=v', '-'], { input: 'FROM secret-name\n' });
    await made.docker.runDirect(['pull', 'ghcr.io/o/private:1']);
    await made.docker.runDirect(['context', 'create', 'box', '--docker', 'host=ssh://box']);
    expect(made.lines).toEqual([
      'info docker build (direct): exit code 0 after 12.1 s.',
      'info docker pull (direct): exit code 1 after 12.1 s.',
      'info docker context create (direct): exit code 0 after 12.1 s.',
    ]);
    expect(made.lines.join('\n')).not.toMatch(/secret|private|ssh:/);
  });

  it('logs a timeout, a failure, and a cancel; a call that only reads is not logged', async () => {
    const { docker, lines } = setup((args) => {
      if (args[0] === 'stop') return { exitCode: null, stdout: '', stderr: '', timedOut: true };
      if (args[0] === 'start') throw new Error('spawn failed');
      return ok();
    });
    await docker.runDirect(['ps']);
    await docker.runDirect(['image', 'inspect', 'i']);
    await docker.runDirect(['stop', 'c']);
    await expect(docker.runDirect(['start', 'c'])).rejects.toThrow('spawn failed');
    const controller = new AbortController();
    controller.abort();
    await expect(docker.runDirect(['rm', 'c'], { signal: controller.signal })).rejects.toThrow();
    expect(lines).toEqual([
      'info docker stop (direct): timed out after 0.0 s.',
      'info docker start (direct): failed after 0.0 s.',
      'info docker rm (direct): cancelled after 0.0 s.',
    ]);
  });
});
