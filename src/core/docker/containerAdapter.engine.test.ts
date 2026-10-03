// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 10A (decision of 2026-10-03): the pull and the start of containers go through the worker (its operations over
// the Engine API) within an operation; the direct calls that remain are logged.
import { describe, expect, it } from 'vitest';
import { CommandError, UserFacingError } from '../errors';
import { HelperChannelError, HelperOperationError, type ChannelPullOptions } from '../helperChannel/helperChannel';
import { abortError, silentLogger, type Credentials, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { ContainerAdapter, directCommandName, type WorkerEngine } from './containerAdapter';
import { dockerTargetOf, remoteContextNames, type DockerTarget } from './dockerHost';
import { runWithDockerTarget } from './dockerTargets';
import { runWithEnvironmentLock, type HeldEnvironmentLock } from './environmentLock';
import { runPreparingWorker } from './workerPreparation';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextNames('build-box')[0]);
const PLAIN_TCP: DockerTarget = { kind: 'unsupported', host: 'tcp://10.0.0.5:2375', endpoint: 'tcp://10.0.0.5:2375' };
const ID = 'a'.repeat(64);

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

function setup(options: { stored?: Credentials; failWith?: unknown; clock?: { now(): number } } = {}) {
  const runner = new FakeRunner();
  const { logger, lines } = recordingLogger();
  const lookups: string[] = [];
  const docker = new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', {
    storedCredentials: async (registry) => {
      lookups.push(registry);
      return options.stored;
    },
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const pulls: { target: DockerTarget; reference: string; options: ChannelPullOptions }[] = [];
  const starts: { target: DockerTarget; ids: readonly string[] }[] = [];
  const engine: WorkerEngine = {
    pull: async (target, reference, pullOptions) => {
      pulls.push({ target, reference, options: pullOptions });
      if (options.failWith !== undefined) throw options.failWith;
      pullOptions.onOutput?.('Status: Downloaded\n');
    },
    startContainers: async (target, ids) => {
      starts.push({ target, ids });
      if (options.failWith !== undefined) throw options.failWith;
    },
  };
  docker.setWorkerEngine(engine);
  return { docker, runner, lines, lookups, pulls, starts };
}

describe('ContainerAdapter.pullImage through the worker (plan step 10A)', () => {
  it('pulls through the worker of the operation, with latest added, and with the credentials that Docker stored here', async () => {
    const { docker, runner, pulls, lookups, lines } = setup({ stored: { username: 'me', password: 'stored-secret' } });
    const output: string[] = [];
    await runWithDockerTarget(REMOTE, () => docker.pullImage('team/app', { onOutput: (text) => output.push(text) }));
    expect(pulls).toHaveLength(1);
    expect(pulls[0].target).toBe(REMOTE);
    expect(pulls[0].reference).toBe('team/app:latest');
    expect(pulls[0].options.credentials).toEqual({ username: 'me', password: 'stored-secret', serveraddress: 'https://index.docker.io/v1/' });
    expect(lookups).toEqual(['registry-1.docker.io']);
    expect(output).toEqual(['Status: Downloaded\n']);
    expect(runner.calls).toEqual([]);
    expect(lines.join('\n')).not.toContain('stored-secret');
  });

  it('uses the given login instead of the stored credentials (the GitHub sign-in for ghcr.io)', async () => {
    const { docker, pulls, lookups } = setup({ stored: { username: 'me', password: 'stored' } });
    await runWithDockerTarget(REMOTE, () => docker.pullImage('ghcr.io/o/i:1', { credentials: { registry: 'ghcr.io', username: 'octo', password: 'gho_token' } }));
    expect(pulls[0].options.credentials).toEqual({ username: 'octo', password: 'gho_token', serveraddress: 'ghcr.io' });
    expect(lookups).toEqual([]);
  });

  // Review round 1 of PR #89 (A-R1-3): a stored identity token goes as such.
  it('sends a stored identity token as an identity token', async () => {
    const { docker, pulls } = setup({ stored: { username: '<token>', password: 'refresh-token' } });
    await runWithDockerTarget(REMOTE, () => docker.pullImage('myregistry.azurecr.io/team/app:1'));
    expect(pulls[0].options.credentials).toEqual({ identityToken: 'refresh-token', serveraddress: 'myregistry.azurecr.io' });
  });

  it('pulls without credentials when none are stored', async () => {
    const { docker, pulls } = setup();
    await runWithDockerTarget(REMOTE, () => docker.pullImage('alpine:3.20'));
    expect(pulls[0].options.credentials).toBeUndefined();
  });

  it('refuses a login to an engine without a protected connection, and sends no stored credentials there', async () => {
    const { docker, pulls, lookups } = setup({ stored: { username: 'me', password: 'stored' } });
    const thrown = await runWithDockerTarget(PLAIN_TCP, () =>
      docker.pullImage('ghcr.io/o/i:1', { credentials: { registry: 'ghcr.io', username: 'octo', password: 'gho_token' } }),
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(UserFacingError);
    expect((thrown as UserFacingError).code).toBe('unencryptedDockerConnection');
    expect(pulls).toEqual([]);
    await runWithDockerTarget(PLAIN_TCP, () => docker.pullImage('alpine:1'));
    expect(pulls[0].options.credentials).toBeUndefined();
    expect(lookups).toEqual([]);
  });

  it('goes through the worker that holds the lock of the environment', async () => {
    const { docker, runner, pulls } = setup();
    const lockPulls: string[] = [];
    const lock: HeldEnvironmentLock = {
      environmentId: 'e',
      lost: new Promise(() => {}),
      docker: async () => ok(),
      pull: async (reference) => {
        lockPulls.push(reference);
      },
      release: async () => {},
    };
    await runWithEnvironmentLock(lock, () => docker.pullImage('alpine'));
    expect(lockPulls).toEqual(['alpine:latest']);
    expect(pulls).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it('pulls directly outside an operation and while the worker is prepared (bootstrap), and logs that call', async () => {
    const { docker, runner, pulls, lines } = setup();
    await docker.pullImage('alpine:1');
    await runWithDockerTarget(REMOTE, () => runPreparingWorker(() => docker.pullImage('alpine:2')));
    expect(pulls).toEqual([]);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['pull', 'alpine:1'],
      ['pull', 'alpine:2'],
    ]);
    expect(lines.filter((line) => line.includes('(direct)'))).toEqual([
      'info docker pull (direct): exit code 0 after 0.0 s.',
      'info docker pull (direct): exit code 0 after 0.0 s.',
    ]);
  });

  for (const [what, error, expected] of [
    ['the worker cannot be prepared', new HelperChannelError('unavailable', 'no helper image'), UserFacingError],
    ['not sent', new HelperChannelError('unsendable', 'too long'), CommandError],
    ['a failure of the operation', new HelperOperationError('failed', 'The pull of alpine:1 failed after 1.0 s: denied', false), CommandError],
    ['a lost worker', new HelperChannelError('lost', 'gone'), CommandError],
  ] as const) {
    it(`maps ${what} to ${expected.name}, without a direct call`, async () => {
      const { docker, runner } = setup({ failWith: error });
      const thrown = await runWithDockerTarget(REMOTE, () => docker.pullImage('alpine:1')).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(expected);
      if (error instanceof HelperOperationError) expect((thrown as Error).message).toContain('denied');
      expect(runner.calls).toEqual([]);
    });
  }

  it('passes a cancel on as an AbortError', async () => {
    const { docker } = setup({ failWith: abortError() });
    await expect(runWithDockerTarget(REMOTE, () => docker.pullImage('alpine:1'))).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ContainerAdapter.startContainer (plan step 10A)', () => {
  it('starts through the worker of the operation, through the lock, or directly outside an operation', async () => {
    const { docker, runner, starts } = setup();
    await runWithDockerTarget(REMOTE, () => docker.startContainer(ID, { timeoutMs: 1_000 }));
    expect(starts).toEqual([{ target: REMOTE, ids: [ID] }]);
    const lockStarts: (readonly string[])[] = [];
    const lock: HeldEnvironmentLock = {
      environmentId: 'e',
      lost: new Promise(() => {}),
      docker: async () => ok(),
      startContainers: async (ids) => {
        lockStarts.push(ids);
      },
      release: async () => {},
    };
    await runWithEnvironmentLock(lock, () => docker.startContainer(ID));
    expect(lockStarts).toEqual([[ID]]);
    expect(runner.calls).toEqual([]);
    await docker.startContainer(ID);
    expect(runner.calls.map((call) => call.args)).toEqual([['start', ID]]);
  });

  it('throws a CommandError with the message of the worker', async () => {
    const { docker } = setup({ failWith: new HelperOperationError('failed', 'The container aaaaaaaaaaaa could not be started: port is already allocated', false) });
    await expect(runWithDockerTarget(REMOTE, () => docker.startContainer(ID))).rejects.toThrow('port is already allocated');
  });
});

describe('the log of the direct calls (plan step 10A)', () => {
  it('names only the command, never an argument; a call that only reads is not logged', async () => {
    expect(directCommandName(['pull', 'ghcr.io/o/private:1'])).toBe('pull');
    expect(directCommandName(['context', 'create', 'box', '--docker', 'host=ssh://box'])).toBe('context create');
    expect(directCommandName(['--context', 'x', 'image', 'rm', 'i'])).toBe('image rm');
    expect(directCommandName(['compose', '-f', 'x.yml', 'up'])).toBe('compose');
    let now = 1_000;
    const runner = new FakeRunner((args) => {
      now += 12_100;
      if (args[0] === 'stop') return { exitCode: null, stdout: '', stderr: '', timedOut: true };
      if (args[0] === 'start') throw new Error('spawn failed');
      return ok();
    });
    const { logger, lines } = recordingLogger();
    const docker = new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { clock: { now: () => now } });
    await docker.runDirect(['ps']);
    await docker.runDirect(['build', '--quiet', '-t', 'secret-name', '-'], { input: 'FROM secret-name\n' });
    await docker.runDirect(['stop', 'c']);
    await expect(docker.runDirect(['start', 'c'])).rejects.toThrow('spawn failed');
    const controller = new AbortController();
    controller.abort();
    await expect(docker.runDirect(['rm', 'c'], { signal: controller.signal })).rejects.toThrow();
    expect(lines).toEqual([
      'info docker build (direct): exit code 0 after 12.1 s.',
      'info docker stop (direct): timed out after 12.1 s.',
      'info docker start (direct): failed after 12.1 s.',
      'info docker rm (direct): cancelled after 0.0 s.',
    ]);
  });
});
