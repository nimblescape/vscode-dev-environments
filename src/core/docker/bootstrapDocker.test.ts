// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F2 (decision 1 of 2026-10-03: no bypass of the worker, by construction): the Docker CLI of the extension
// is only the bootstrap's. It has no way through the worker (no router, no worker engine) and no Docker call of the flows;
// each call runs directly with the Docker context of its operation, and a call that does not only read is logged with
// its command alone.
//
// Plan step 11I2: the tests of the calls of BootstrapDocker that ran through the removed CLI adapter ContainerAdapter
// (containerAdapter.test.ts) moved here, unchanged except that they construct BootstrapDocker, which implements them.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CommandError, UserFacingError } from '../errors';
import { Messages } from '../messages';
import { abortError, isAbortError, silentLogger, type Logger, type ProcessRunner, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import {
  BootstrapDocker,
  DOCKER_CLI_LOOKUP_RETRY_MS,
  SSH_DROP_RETRY_DELAY_MS,
  directCommandName,
  parseJsonLines,
  sshDroppedReadCall,
} from './bootstrapDocker';
import { dockerCommandWords, isReadOnlyDockerCall } from './dockerCli';
import { dockerTargetOf, remoteContextNames } from './dockerHost';
import { runWithDockerTarget } from './dockerTargets';

interface Call {
  file: string;
  args: string[];
  options: RunOptions;
}

type Handler = (call: Call) => RunResult | Promise<RunResult>;

function ok(stdout = '', stderr = ''): RunResult {
  return { exitCode: 0, stdout, stderr, timedOut: false };
}

// Plan step 11I2: one fake runner for the tests of this file and the moved ones (the handler of the moved tests gets the
// whole call; without one, every call succeeds without output, as before).
class FakeRunner implements ProcessRunner {
  readonly calls: Call[] = [];
  constructor(private readonly handler: Handler = () => ok()) {}
  async run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const call = { file, args: [...args], options };
    this.calls.push(call);
    return this.handler(call);
  }
}

function fail(stderr: string, exitCode: number | null = 1, stdout = ''): RunResult {
  return { exitCode, stdout, stderr, timedOut: false };
}

const DOCKER = '/usr/local/bin/docker';

function adapter(handler: Handler, env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }): { docker: BootstrapDocker; runner: FakeRunner } {
  const runner = new FakeRunner(handler);
  return { docker: new BootstrapDocker(runner, DOCKER, env, silentLogger, 'linux'), runner };
}

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
    // Plan step 11I (PR D): changed, `run` is the one method of a call (before: also `runDirect`, which `run` called).
    expect(own).toEqual(expect.arrayContaining(['isInstalled', 'run', 'start', 'daemonStatus', 'isRunning', 'imageExists', 'imageId', 'buildImage', 'listImagesByLabel', 'removeImage']));
    expect(own).not.toContain('runDirect');
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
    // Plan step 11I (PR D): changed, without "(direct)" (every call of BootstrapDocker is one; before: "docker image rm
    // (direct): …").
    expect(lines.filter((line) => line.startsWith('docker '))).toEqual([expect.stringMatching(/^docker image rm: exit code 0 after /)]);
    expect(lines.join('\n')).not.toContain('secret-looking-reference');
  });

  // Plan step 11I2 (decision D8 of 2026-10-07): changed expectation (before: 'is the base of the CLI adapter of the flows,
  // which keeps its calls'): the CLI adapter ContainerAdapter is removed as a whole, so BootstrapDocker is the only Docker
  // CLI of the code; the pipeline commands Docker only through the worker's EngineDocker.
  it('is the only Docker CLI: the CLI adapter of the flows (ContainerAdapter) is removed (plan step 11I2)', () => {
    expect(fs.existsSync(path.join(__dirname, 'containerAdapter.ts'))).toBe(false);
    expect(fs.readdirSync(__dirname).filter((file) => /^containerAdapter\b/.test(file))).toEqual([]);
  });
});

describe('parseJsonLines', () => {
  it('parses one value per line and skips blank and invalid lines', () => {
    expect(parseJsonLines('{"a":1}\r\n\nWARNING: something\n"x"\n')).toEqual([{ a: 1 }, 'x']);
  });
});

describe('BootstrapDocker basics', () => {
  it('throws dockerNotInstalled without a CLI', async () => {
    const runner = new FakeRunner(() => ok());
    const docker = new BootstrapDocker(runner, undefined, {}, silentLogger, 'linux');
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
    const docker = new BootstrapDocker(runner, '/opt/docker/bin/docker', { PATH: '/usr/bin', HOME: '/h' }, silentLogger, 'linux');
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
    const docker = new BootstrapDocker(runner, DOCKER, { PATH: '/usr/bin' }, silentLogger, 'linux', options);
    expect(await docker.isRunning()).toBe(true);
    expect(await docker.isRunning()).toBe(false);
    await expect(docker.isRunning()).rejects.toThrow();
    expect(reported).toEqual([true, false]);
    const missing = new BootstrapDocker(runner, undefined, {}, silentLogger, 'linux', options);
    expect(await missing.isRunning()).toBe(false);
    expect(reported).toEqual([true, false, false]);
  });

  it('keeps its answer when onDaemonStatus throws', async () => {
    const runner = new FakeRunner(() => ok('"29.8.0"\n'));
    const docker = new BootstrapDocker(runner, DOCKER, {}, silentLogger, 'linux', {
      onDaemonStatus: () => {
        throw new Error('listener failed');
      },
    });
    expect(await docker.isRunning()).toBe(true);
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

  /**
   * Review round 4 of PR #64 (R4-2/R4-3): the arguments of `docker build` without the pair `--label
   * nimblescape.devenv.build-id=<nonce>`, which is checked here (a random nonce of 32 hex characters), and without an
   * `--iidfile`.
   */
  function withoutBuildLabel(args: readonly string[]): string[] {
    expect(args).not.toContain('--iidfile');
    const index = args.findIndex((arg) => arg.startsWith('nimblescape.devenv.build-id='));
    expect(args[index - 1]).toBe('--label');
    expect(args[index]).toMatch(/^nimblescape\.devenv\.build-id=[0-9a-f]{32}$/);
    return [...args.slice(0, index - 1), ...args.slice(index + 1)];
  }

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
      labels: { 'nimblescape.devenv.helper': 'true' },
      buildArgs: { DEVCONTAINER_CLI_VERSION: '0.89.0' },
      onOutput: (text) => output.push(text),
    });
    // Changed expectation (review round 4 of PR #64, R4-2/R4-3): the build gets a build label, no `--iidfile`
    // (withoutBuildLabel checks it).
    expect(withoutBuildLabel(runner.calls[0].args)).toEqual([
      'build',
      '-t',
      'devenv-helper:abc',
      '-f',
      '/ext/resources/helper/Dockerfile',
      '--label',
      'nimblescape.devenv.helper=true',
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
    // Changed expectation (review round 4 of PR #64, R4-2/R4-3): each build gets a build label, no `--iidfile`
    // (withoutBuildLabel checks it). Only the build calls: after each build, the image is looked up by its label.
    expect(runner.calls.filter((call) => call.args[0] === 'build').map((call) => withoutBuildLabel(call.args))).toEqual([
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
    expect(await docker.listImagesByLabel('nimblescape.devenv.helper=true')).toEqual([
      { id: id1, tags: ['devenv-helper:76fa66d93464', 'mine:backup'], createdAt: '2026-09-25 02:31:55 +0200 CEST' },
      { id: id2, tags: [], createdAt: '2026-09-24 22:37:12 +0200 CEST' },
      { id: id3, tags: [], createdAt: '' },
    ]);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['image', 'ls', '--filter', 'label=nimblescape.devenv.helper=true', '--no-trunc', '--format', '{{json .}}'],
      ['image', 'ls', '--filter', 'label=nimblescape.devenv.helper=true', '--filter', 'dangling=true', '--no-trunc', '--format', '{{json .}}'],
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
    expect(await docker.listImagesByLabel('nimblescape.devenv.helper=true')).toEqual([
      { id: tagged, tags: ['devenv-helper:0123456789ab'], createdAt: 'a' },
      { id: dangling, tags: [], createdAt: 'b' },
    ]);
  });

  it('listImagesByLabel throws CommandError', async () => {
    const { docker } = adapter(() => fail('Cannot connect to the Docker daemon'));
    await expect(docker.listImagesByLabel('nimblescape.devenv.helper=true')).rejects.toBeInstanceOf(CommandError);
  });

  it('buildImage returns the ID of the image that its build label lists, never one read by the tag (review round 4 of PR #64, R4-2/R4-3)', async () => {
    // Changed expectation (review round 4 of PR #64, R4-2/R4-3): replaces the test of the ID from the --iidfile.
    const id = `sha256:${'c'.repeat(64)}`;
    let label = '';
    const { docker, runner } = adapter((call) => {
      if (call.args[0] === 'build') {
        label = call.args[call.args.findIndex((arg) => arg.startsWith('nimblescape.devenv.build-id='))];
        return ok();
      }
      // The engine lists the image of the build label; the tag is never inspected.
      const dangling = call.args.includes('dangling=true');
      return ok(dangling ? '' : `${JSON.stringify({ ID: id, Repository: 't', Tag: 'latest', CreatedAt: '' })}\n`);
    });
    expect(await docker.buildImage({ tag: 't', dockerfile: 'D', context: '.' })).toBe(id);
    expect(runner.calls.slice(1).map((call) => call.args)).toEqual([
      ['image', 'ls', '--filter', `label=${label}`, '--no-trunc', '--format', '{{json .}}'],
      ['image', 'ls', '--filter', `label=${label}`, '--filter', 'dangling=true', '--no-trunc', '--format', '{{json .}}'],
    ]);
    expect(runner.calls.some((call) => call.args[0] === 'image' && call.args[1] === 'inspect')).toBe(false);
    // A new nonce for each build.
    const first = label;
    await docker.buildImage({ tag: 't', dockerfile: 'D', context: '.' });
    expect(label).not.toBe(first);
  });

  it('buildImage finds a dangling image of its build (the tag moved meanwhile) by its build label (review round 4 of PR #64, R4-2/R4-3)', async () => {
    const id = `sha256:${'e'.repeat(64)}`;
    const { docker } = adapter((call) => {
      if (call.args[0] === 'build') return ok();
      return ok(call.args.includes('dangling=true') ? `${JSON.stringify({ ID: id, Repository: '<none>', Tag: '<none>', CreatedAt: '' })}\n` : '');
    });
    expect(await docker.buildImage({ tag: 't', dockerfile: 'D', context: '.' })).toBe(id);
  });

  it('buildImage succeeds without an ID when the lookup by the build label fails or does not find exactly one image (review round 4 of PR #64, R4-2/R4-3)', async () => {
    // Changed expectation (review round 4 of PR #64, R4-2/R4-3): replaces the test of a missing or invalid --iidfile.
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    let listing: 'fail' | 'none' | 'two' = 'fail';
    const runner = new FakeRunner((call) => {
      if (call.args[0] === 'build') return ok();
      if (listing === 'fail') return fail('Cannot connect to the Docker daemon');
      if (listing === 'none' || call.args.includes('dangling=true')) return ok('');
      const line = (id: string) => JSON.stringify({ ID: id, Repository: 't', Tag: 'latest', CreatedAt: '' });
      return ok(`${line(`sha256:${'1'.repeat(64)}`)}\n${line(`sha256:${'2'.repeat(64)}`)}\n`);
    });
    const docker = new BootstrapDocker(runner, DOCKER, { PATH: '/usr/bin' }, logger, 'linux');
    expect(await docker.buildImage({ tag: 't', dockerfile: 'D', context: '.' })).toBeUndefined();
    listing = 'none';
    expect(await docker.buildImage({ tag: 't', dockerfile: 'D', context: '.' })).toBeUndefined();
    listing = 'two';
    expect(await docker.buildImage({ tag: 't', dockerfile: 'D', context: '.' })).toBeUndefined();
    expect(warnings).toHaveLength(3);
  });

  it('buildImage throws CommandError', async () => {
    const { docker } = adapter(() => fail('failed to solve'));
    await expect(docker.buildImage({ tag: 't', dockerfile: 'D', context: '.' })).rejects.toBeInstanceOf(CommandError);
  });
});

describe('BootstrapDocker: a Docker CLI that is installed later', () => {
  function setup(found: Array<string | undefined>) {
    let now = 1_000_000;
    const lookups: string[] = [];
    const runner = new FakeRunner(() => ok());
    const docker = new BootstrapDocker(runner, undefined, { PATH: '/usr/bin' }, silentLogger, 'linux', {
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
    const docker = new BootstrapDocker(runner, '/usr/local/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', {
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
    const docker: BootstrapDocker = new BootstrapDocker(runner, DOCKER, {}, silentLogger, 'linux', {
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
    const docker = new BootstrapDocker(runner, DOCKER, {}, logger, 'linux', {
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
    const docker = new BootstrapDocker(new FakeRunner(() => ok()), undefined, {}, silentLogger, 'linux');
    expect(docker.lookUpCliNow()).toBe(false);
  });

  it('keeps the path fixed without findDocker', async () => {
    const runner = new FakeRunner(() => {
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    });
    const docker = new BootstrapDocker(runner, DOCKER, {}, silentLogger, 'linux');
    await expect(docker.run(['ps'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    expect(docker.dockerPath).toBe(DOCKER);
    expect(docker.isInstalled()).toBe(true);
  });
});

describe('BootstrapDocker: an SSH server that closes the connection before the login (unit 7)', () => {
  /** The error of the Docker CLI when sshd dropped the connection (as in CI: OpenSSH 9.6 prints one line). */
  function dropped(path = 'images/devenv-helper:1/json', sshStderr = 'Connection closed by 127.0.0.1 port 32771\r\n'): RunResult {
    return fail(
      `error during connect: Get "http://docker.example.com/v1.48/${path}": command [ssh -o ConnectTimeout=30 -T -- build-box docker system dial-stdio] has exited with exit status 255, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=${sshStderr}\n`,
    );
  }

  function droppingAdapter(handler: Handler, warnings: string[] = []): { docker: BootstrapDocker; runner: FakeRunner } {
    const runner = new FakeRunner(handler);
    const logger: Logger = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    return { docker: new BootstrapDocker(runner, DOCKER, { PATH: '/usr/bin' }, logger, 'linux', { sshDropRetryDelayMs: 0 }), runner };
  }

  it('waits one second before the repetition by default', () => {
    expect(SSH_DROP_RETRY_DELAY_MS).toBe(1_000);
  });

  it('repeats a call that only reads once, and returns the second answer', async () => {
    const warnings: string[] = [];
    let calls = 0;
    const { docker, runner } = droppingAdapter(() => (++calls === 1 ? dropped() : ok('"sha256:abc"\n')), warnings);
    await expect(docker.run(['image', 'inspect', '--format', '{{json .Id}}', 'devenv-helper:1'])).resolves.toMatchObject({ exitCode: 0 });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].args).toEqual(runner.calls[0].args);
    expect(warnings).toEqual([expect.stringContaining('docker image inspect: the SSH server of the Docker host closed the connection before the login')]);
  });

  it('repeats it only once: a second drop is the answer', async () => {
    const { docker, runner } = droppingAdapter(() => dropped());
    const result = await docker.run(['ps', '-a', '--format', '{{json .ID}}']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Connection closed by 127.0.0.1 port 32771');
    expect(runner.calls).toHaveLength(2);
  });

  it('also after the older message of the client (kex_exchange_identification), and for docker -H ssh://… info', async () => {
    let calls = 0;
    const { docker, runner } = droppingAdapter(() =>
      ++calls === 1 ? dropped('info', 'kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 192.0.2.10 port 22\r\n') : ok('"28.0.1"'),
    );
    await expect(docker.run(['-H', 'ssh://build-box', 'info', '--format', '{{json .ServerVersion}}'])).resolves.toMatchObject({ exitCode: 0 });
    expect(runner.calls).toHaveLength(2);
  });

  it.each([
    [['run', '-d', '--name', 'x', 'img']],
    [['create', '--name', 'x', 'img']],
    [['exec', '-i', 'x', 'sh', '-c', 'cat > /run/devenv/github-token']],
    [['start', 'x']],
    [['stop', 'x']],
    [['rm', '-f', 'x']],
    [['volume', 'create', 'v']],
    [['volume', 'rm', 'v']],
    [['image', 'rm', 'img']],
    [['build', '-t', 'img', '.']],
    [['pull', 'img']],
  ])('never repeats a call that changes something: %j', async (args) => {
    const { docker, runner } = droppingAdapter(() => dropped());
    expect((await docker.run(args)).exitCode).toBe(1);
    expect(runner.calls).toHaveLength(1);
  });

  it.each([
    ['a failed login', 'root@127.0.0.1: Permission denied (publickey).\r\n'],
    ['an unknown host key', 'No ED25519 host key is known for [127.0.0.1]:32771 and you have requested strict checking.\r\nHost key verification failed.\r\n'],
    ['a closed port', 'ssh: connect to host 127.0.0.1 port 45171: Connection refused\r\n'],
    ['a drop with another message of ssh', 'Warning: Permanently added build-box.\r\nConnection closed by 127.0.0.1 port 32771\r\n'],
  ])('does not repeat a read after %s', async (_name, sshStderr) => {
    const { docker, runner } = droppingAdapter(() => dropped('info', sshStderr));
    expect((await docker.run(['info'])).exitCode).toBe(1);
    expect(runner.calls).toHaveLength(1);
  });

  it('does not repeat a read that failed on the engine, or ran out of time', async () => {
    const engine = droppingAdapter(() => fail('Error: No such image: devenv-helper:1'));
    expect((await engine.docker.run(['image', 'inspect', 'devenv-helper:1'])).exitCode).toBe(1);
    expect(engine.runner.calls).toHaveLength(1);
    const late = droppingAdapter(() => ({ ...dropped(), exitCode: null, timedOut: true }));
    expect((await late.docker.run(['info'])).timedOut).toBe(true);
    expect(late.runner.calls).toHaveLength(1);
  });

  it('does not repeat after an abort, and an abort during the wait rejects with an AbortError', async () => {
    const aborted = new AbortController();
    const first = droppingAdapter(() => {
      aborted.abort();
      return dropped();
    });
    expect((await first.docker.run(['ps'], { signal: aborted.signal })).exitCode).toBe(1);
    expect(first.runner.calls).toHaveLength(1);

    const during = new AbortController();
    const runner = new FakeRunner(() => dropped());
    const docker = new BootstrapDocker(runner, DOCKER, { PATH: '/usr/bin' }, silentLogger, 'linux', { sshDropRetryDelayMs: 60_000 });
    const pending = docker.run(['ps'], { signal: during.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    during.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(runner.calls).toHaveLength(1);
  });

  it('isReadOnlyDockerCall: only commands that read, also after global options', () => {
    // User decisions 2026-10-03: contexts are named after the host, for example htldvm.
    for (const args of [
      ['info'],
      ['version', '--format', '{{json .Server.APIVersion}}'],
      ['ps', '-aq'],
      ['images'],
      ['inspect', 'x'],
      ['image', 'inspect', 'img'],
      ['image', 'ls'],
      ['container', 'inspect', 'x'],
      ['volume', 'ls', '--filter', 'label=a'],
      ['volume', 'inspect', 'v'],
      ['network', 'inspect', 'n'],
      ['context', 'inspect'],
      ['system', 'df'],
      ['-H', 'ssh://build-box', 'info'],
      ['--context', 'htldvm', 'image', 'inspect', 'img'],
    ]) {
      expect(isReadOnlyDockerCall(args), args.join(' ')).toBe(true);
    }
    for (const args of [
      [],
      ['-H', 'ssh://info'],
      ['run', 'img', 'inspect'],
      ['exec', 'x', 'docker', 'ps'],
      ['image', 'rm', 'img'],
      ['image', 'prune', '-f'],
      ['volume', 'create', 'ls'],
      ['network', 'rm', 'inspect'],
      ['context', 'use', 'htldvm'],
      ['compose', 'ps'],
      ['buildx', 'build', '.'],
      ['logs', 'x'],
    ]) {
      expect(isReadOnlyDockerCall(args), args.join(' ')).toBe(false);
    }
  });

  it('sshDroppedReadCall needs the exit of the SSH command of the Docker CLI', () => {
    expect(sshDroppedReadCall(['info'], dropped())).toBe(true);
    expect(sshDroppedReadCall(['info'], ok())).toBe(false);
    // The same words from somewhere else (for example the output of a container) are not a drop.
    expect(sshDroppedReadCall(['info'], fail('Connection closed by 127.0.0.1 port 32771'))).toBe(false);
  });
});

describe('BootstrapDocker.start (user request 2026-09-28: the helper channel)', () => {
  it('starts docker with the Docker context of the operation, and nothing without a runner that can start', async () => {
    const starts: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const fakeStarted = {} as StartedProcess;
    const runner: ProcessRunner = {
      run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      start: (file, args, options) => {
        starts.push({ file, args, env: options?.env });
        return fakeStarted;
      },
    };
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin', DOCKER_CONTEXT: 'desktop-linux' }, silentLogger, 'linux');
    // User decisions 2026-10-03: the Docker context of a host is named after it (remoteContextNames; before: remoteContextName).
    const target = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);
    expect(await runWithDockerTarget(target, async () => docker.start(['run', '-i', 'img']))).toBe(fakeStarted);
    expect(starts[0]).toMatchObject({ file: '/usr/bin/docker', args: ['run', '-i', 'img'] });
    expect(starts[0].env?.DOCKER_CONTEXT).toBe(remoteContextNames('build-box')[0]);
    expect(starts[0].env?.DOCKER_HOST).toBeUndefined();
    const withoutStart = new BootstrapDocker({ run: runner.run }, '/usr/bin/docker', {}, silentLogger, 'linux');
    expect(withoutStart.start(['ps'])).toBeUndefined();
    const withoutCli = new BootstrapDocker(runner, undefined, {}, silentLogger, 'linux');
    expect(withoutCli.start(['ps'])).toBeUndefined();
  });
});


// Plan step 11I1, PR B2: every call runs directly. Plan step 11I2: the tests of BootstrapDocker's direct calls moved here
// from containerAdapter.test.ts; the ones of the calls of the removed CLI adapter (pull, start of a container, exec with a
// secret input, no route through the worker) are gone with it (BootstrapDocker has none of these members, see above).
describe('BootstrapDocker: every call runs directly (plan step 11I1, PR B2)', () => {
  function recordingAdapter(handler: Handler = () => ok(), clock?: { now(): number }) {
    const runner = new FakeRunner(handler);
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, info: (text) => lines.push(`info ${text}`), warn: (text) => lines.push(`warn ${text}`) };
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', clock ? { clock } : {});
    return { docker, runner, lines };
  }
  const REMOTE = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);

  // Moved unchanged from containerAdapter.engine.test.ts ('the log of the direct calls (plan step 10A)').
  it('logs a direct call with only its command, never an argument; a call that only reads is not logged', async () => {
    expect(directCommandName(['pull', 'ghcr.io/o/private:1'])).toBe('pull');
    expect(directCommandName(['context', 'create', 'box', '--docker', 'host=ssh://box'])).toBe('context create');
    expect(directCommandName(['--context', 'x', 'image', 'rm', 'i'])).toBe('image rm');
    expect(directCommandName(['compose', '-f', 'x.yml', 'up'])).toBe('compose');
    let now = 1_000;
    const { docker, lines } = recordingAdapter(
      (call) => {
        if (call.options.signal?.aborted) throw abortError();
        now += 12_100;
        if (call.args[0] === 'stop') return { exitCode: null, stdout: '', stderr: '', timedOut: true };
        if (call.args[0] === 'start') throw new Error('spawn failed');
        return ok();
      },
      { now: () => now },
    );
    // Plan step 11I (PR D): changed, `run` (before: `runDirect`, which it called), and the lines without "(direct)".
    await docker.run(['ps']);
    await docker.run(['build', '--quiet', '-t', 'secret-name', '-'], { input: 'FROM secret-name\n' });
    await docker.run(['stop', 'c']);
    await expect(docker.run(['start', 'c'])).rejects.toThrow('spawn failed');
    const controller = new AbortController();
    controller.abort();
    await expect(docker.run(['rm', 'c'], { signal: controller.signal })).rejects.toThrow();
    expect(lines).toEqual([
      'info docker build: exit code 0 after 12.1 s.',
      'info docker stop: timed out after 12.1 s.',
      'info docker start: failed after 12.1 s.',
      'info docker rm: cancelled after 0.0 s.',
    ]);
  });

  // Moved from dockerRouting.test.ts ('the classification of every Docker call of BootstrapDocker (plan step 5, PR A)').

  // Moved from dockerRouting.test.ts ('the classification of every Docker call of ContainerAdapter (plan step 5, PR A)').
  // Plan step 11I2: changed expectation (before: every call of the removed CLI adapter ContainerAdapter, its own and the
  // ones of BootstrapDocker): every call of BootstrapDocker is classified as one that only reads or not (runDirect repeats
  // only those after an SSH drop), and each entry of the table is issued by it. The calls that only the removed adapter
  // issued keep their classification below (isReadOnlyDockerCall serves every caller of the Docker CLI).
  it('classifies every Docker call of BootstrapDocker as one that only reads or not', async () => {
    /** Key: the command, or the object and its command. */
    const READ_ONLY: Record<string, boolean> = {
      info: true,
      'image inspect': true,
      'image ls': true,
      'image rm': false,
      build: false,
    };
    const objects = new Set(['container', 'image', 'volume', 'network', 'context']);
    const commandKey = (args: readonly string[]): string => (objects.has(args[0]) ? `${args[0]} ${args[1]}` : args[0]);
    /** Members of BootstrapDocker that issue no Docker call of their own, or only pass one through. */
    const noOwnCall = new Set([
      'constructor',
      'dockerPath',
      'isInstalled',
      // Plan step 11I (PR D): changed, runRepeated (before: runDirect and runDirectOnce; `run` is the one method).
      'runRepeated',
      'runOnce',
      'start',
      'operationEnv',
      'processEnv',
      'lookUpCliNow',
      'reportCliLost',
      'lookUpCliIfMissing',
      'runChecked',
      'queryDaemonStatus',
      'isMissing',
      'commandError',
      'run',
    ]);
    const { docker, runner } = recordingAdapter((call) => {
      const key = commandKey(call.args);
      if (key === 'image ls') return ok(`${JSON.stringify({ ID: 'sha256:1', Repository: 'p-s', Tag: '1', CreatedAt: 'x' })}\n`);
      return ok(call.args.includes('--format') ? '"x"\n' : '[]\n');
    });
    const exercised: Record<string, (d: BootstrapDocker) => Promise<unknown>> = {
      daemonStatus: (d) => d.daemonStatus(),
      isRunning: (d) => d.isRunning(),
      imageExists: (d) => d.imageExists('i'),
      imageId: (d) => d.imageId('i'),
      listImagesByLabel: (d) => d.listImagesByLabel('l'),
      removeImage: (d) => d.removeImage('i'),
      buildImage: (d) => d.buildImage({ tag: 't', dockerfile: 'D', context: '.', onOutput: () => {} }),
    };
    const unknown = Object.getOwnPropertyNames(BootstrapDocker.prototype).filter((name) => !noOwnCall.has(name) && !(name in exercised));
    expect(unknown, 'a new member of BootstrapDocker: exercise it here and classify its calls').toEqual([]);
    const all: string[][] = [];
    await runWithDockerTarget(REMOTE, async () => {
      for (const [name, call] of Object.entries(exercised)) {
        runner.calls.length = 0;
        await call(docker).catch(() => undefined);
        expect(runner.calls.length, `${name} issued no Docker call`).toBeGreaterThan(0);
        all.push(...runner.calls.map((c) => c.args));
      }
    });
    const keys = new Set<string>();
    for (const args of all) {
      const key = commandKey(args);
      keys.add(key);
      expect(READ_ONLY[key], `unclassified Docker call: docker ${args.join(' ')}`).toBeDefined();
      expect(isReadOnlyDockerCall(args), `read-only: docker ${args.join(' ')}`).toBe(READ_ONLY[key]);
    }
    // Every entry of the table is issued by BootstrapDocker (no stale entry).
    expect([...keys].sort()).toEqual(Object.keys(READ_ONLY).sort());
    // The calls that only the removed adapter issued, as it issued them: still classified the same way.
    const removedAdapterCalls: Array<[string[], boolean]> = [
      [['version', '--format', '{{.Server.APIVersion}}'], true],
      [['ps', '-a', '--no-trunc', '--filter', 'label=x', '--format', '{{json .ID}}'], true],
      [['container', 'inspect', 'c'], true],
      [['volume', 'inspect', 'v'], true],
      [['volume', 'ls', '--filter', 'label=x'], true],
      [['network', 'inspect', 'n'], true],
      [['network', 'ls', '--filter', 'label=x'], true],
      [['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], true],
      [['stop', 'c'], false],
      [['rename', 'c', 'd'], false],
      [['rm', '-f', 'c'], false],
      [['exec', '-u', 'u', 'c', 'git', 'status'], false],
      [['exec', '-i', 'c', 'cat'], false],
      [['volume', 'create', '--label', 'a=b', 'v'], false],
      [['volume', 'rm', 'v'], false],
      [['network', 'rm', 'n'], false],
      [['pull', 'i'], false],
      [['--config', '/tmp/x', 'pull', 'i'], false],
      [['start', 'c'], false],
      [['run', '--rm', 'i'], false],
    ];
    for (const [args, readOnly] of removedAdapterCalls) expect(isReadOnlyDockerCall(args), `read-only: docker ${args.join(' ')}`).toBe(readOnly);
  });

  // Moved from dockerRouting.test.ts ('isReadOnlyDockerCall: the calls that may run again without any effect').
  it('isReadOnlyDockerCall and dockerCommandWords: the calls that may run again without any effect', () => {
    expect(isReadOnlyDockerCall(['info'])).toBe(true);
    expect(isReadOnlyDockerCall(['volume', 'ls'])).toBe(true);
    expect(isReadOnlyDockerCall(['stop', 'c'])).toBe(false);
    expect(isReadOnlyDockerCall(['exec', 'c', 'git', 'status'])).toBe(false);
    expect(dockerCommandWords(['--context', 'x', 'volume', 'rm', 'v'])).toEqual(['volume', 'rm']);
  });
});
