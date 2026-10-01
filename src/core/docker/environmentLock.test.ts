// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: the scope of a held environment lock, and the Docker calls of ContainerAdapter in it: the plain
// calls go only through the worker that holds the lock, never directly, and after the lock was lost no call runs.
import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import { HelperChannelError } from '../helperChannel/helperChannel';
import { abortError, silentLogger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { ContainerAdapter } from './containerAdapter';
import { dockerTargetOf, remoteContextName } from './dockerHost';
import { runWithDockerTarget } from './dockerTargets';
import { heldEnvironmentLock, holdsEnvironmentLock, runWithEnvironmentLock, type HeldEnvironmentLock } from './environmentLock';

const REMOTE = dockerTargetOf('ssh://build-box', remoteContextName('build-box'));

function ok(stdout = ''): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

/** The direct calls (the runner of the adapter). */
class DirectRunner implements ProcessRunner {
  readonly calls: string[][] = [];
  async run(_file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push([...args]);
    if (options.signal?.aborted) throw abortError();
    return ok('direct');
  }
}

/** A held lock whose worker the test controls. */
function fakeLock(environmentId = 'env-1', docker: (args: readonly string[]) => Promise<RunResult> = async () => ok('worker')) {
  let lose!: (reason: string) => void;
  const calls: string[][] = [];
  const lock: HeldEnvironmentLock = {
    environmentId,
    lost: new Promise<string>((resolve) => (lose = resolve)),
    docker: async (args) => {
      calls.push([...args]);
      return docker(args);
    },
    release: async () => {},
  };
  return { lock, calls, lose };
}

function adapter() {
  const runner = new DirectRunner();
  const docker = new ContainerAdapter(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux');
  // Plan step 5, PR A: a router that would take every routable call; under the lock it must not be asked.
  const routed: string[][] = [];
  docker.setRouter(async (_target, args) => {
    routed.push([...args]);
    return ok('router');
  });
  return { docker, runner, routed };
}

describe('the scope of a held environment lock (plan step 5, PR B)', () => {
  it('sends the plain calls through the worker that holds the lock, not the router and not directly', async () => {
    const { docker, runner, routed } = adapter();
    const { lock, calls } = fakeLock();
    const result = await runWithDockerTarget(REMOTE, () => runWithEnvironmentLock(lock, () => docker.run(['stop', 'c1'])));
    expect(result.stdout).toBe('worker');
    expect(calls).toEqual([['stop', 'c1']]);
    expect(routed).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it('runs a call that is not routable directly while the lock holds', async () => {
    const { docker, runner } = adapter();
    const { lock, calls } = fakeLock();
    await runWithEnvironmentLock(lock, () => docker.run(['compose', 'stop'], {}));
    expect(runner.calls).toEqual([['compose', 'stop']]);
    expect(calls).toEqual([]);
  });

  it('a lost worker fails the call (outcome not known), also a call that only reads; it never goes direct', async () => {
    for (const args of [['stop', 'c1'], ['ps', '-a']]) {
      const { docker, runner, routed } = adapter();
      const { lock } = fakeLock('env-1', async () => {
        throw new HelperChannelError('lost', 'The helper channel to build-box was lost while docker ran.');
      });
      const error = await runWithEnvironmentLock(lock, () => docker.run(args)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CommandError);
      expect((error as Error).message).toContain('is not known');
      expect(runner.calls).toEqual([]);
      expect(routed).toEqual([]);
    }
  });

  it('a call that the worker did not send (closed) fails too, and never goes direct', async () => {
    const { docker, runner } = adapter();
    const { lock } = fakeLock('env-1', async () => {
      throw new HelperChannelError('closed', 'closed');
    });
    await expect(runWithEnvironmentLock(lock, () => docker.run(['rm', '-f', 'c1']))).rejects.toBeInstanceOf(CommandError);
    expect(runner.calls).toEqual([]);
  });

  // PR #74 review round 1, A-R1-2: a call that was not sent says so; only a call that was sent and then lost has an
  // outcome that is not known. Neither runs directly or through the router.
  it('A-R1-2: a call that was not sent (no place) fails as not sent, distinct from a lost one, and never goes direct', async () => {
    const texts: string[] = [];
    for (const failure of [
      new HelperChannelError('unsendable', 'The helper channel to build-box runs too many calls under locks.'),
      new HelperChannelError('lost', 'The helper channel to build-box was lost while docker ran.'),
    ]) {
      const { docker, runner, routed } = adapter();
      const { lock, calls } = fakeLock('env-1', async () => {
        throw failure;
      });
      const error = await runWithDockerTarget(REMOTE, () => runWithEnvironmentLock(lock, () => docker.run(['volume', 'rm', 'v1']))).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(CommandError);
      texts.push((error as Error).message);
      expect(calls).toEqual([['volume', 'rm', 'v1']]);
      expect(runner.calls).toEqual([]);
      expect(routed).toEqual([]);
    }
    expect(texts[0]).toContain('docker volume rm was not sent to the worker that holds the lock of the environment');
    expect(texts[0]).not.toContain('is not known');
    expect(texts[1]).toContain('the outcome of docker volume rm is not known');
    expect(texts[1]).not.toContain('was not sent');
  });

  it('after the lock was lost, no call runs at all, whatever its kind', async () => {
    const { docker, runner } = adapter();
    const { lock, calls, lose } = fakeLock();
    await runWithEnvironmentLock(lock, async () => {
      await docker.run(['ps']);
      lose('the helper channel to build-box was lost');
      await new Promise((resolve) => setImmediate(resolve));
      await expect(docker.run(['stop', 'c1'])).rejects.toThrow(/lock of the environment on the Docker host was lost/);
      await expect(docker.run(['compose', 'stop'])).rejects.toThrow(/was not run/);
    });
    expect(calls).toEqual([['ps']]);
    expect(runner.calls).toEqual([]);
  });

  it('an abort passes as an AbortError', async () => {
    const { docker } = adapter();
    const { lock } = fakeLock('env-1', async () => {
      throw abortError();
    });
    await expect(runWithEnvironmentLock(lock, () => docker.run(['stop', 'c1']))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('knows the environments whose lock it holds, also nested, and ends with the scope', async () => {
    const outer = fakeLock('env-1');
    const inner = fakeLock('env-2');
    expect(holdsEnvironmentLock('env-1')).toBe(false);
    await runWithEnvironmentLock(outer.lock, async () => {
      expect(holdsEnvironmentLock('env-1')).toBe(true);
      expect(holdsEnvironmentLock('env-2')).toBe(false);
      await runWithEnvironmentLock(inner.lock, async () => {
        expect(holdsEnvironmentLock('env-1')).toBe(true);
        expect(holdsEnvironmentLock('env-2')).toBe(true);
        // A loss of the outer lock counts in the inner scope too.
        outer.lose('lost');
        await new Promise((resolve) => setImmediate(resolve));
        expect(heldEnvironmentLock()?.lostReason()).toBe('lost');
      });
    });
    expect(holdsEnvironmentLock('env-1')).toBe(false);
    expect(heldEnvironmentLock()).toBeUndefined();
  });

  it('a timer that the scope left behind does not run in it after it ended', async () => {
    const { docker, runner } = adapter();
    const { lock, calls } = fakeLock();
    let later!: Promise<RunResult>;
    await runWithEnvironmentLock(lock, async () => {
      later = new Promise((resolve) => setTimeout(() => resolve(docker.run(['ps'])), 5));
    });
    await later;
    expect(calls).toEqual([]);
    expect(runner.calls).toEqual([['ps']]);
  });
});

// Plan step 6, PR C (Q4 of 2026-10-01): the token write into the dev container (`docker exec -i` with a secret input) goes
// only through the worker that holds the lock, with the secret as the secret input of the call; never directly.
describe('docker exec with a secret input (plan step 6, PR C)', () => {
  const SECRET = 'gho_0123456789abcdefSECRET';

  it('goes through the worker that holds the lock, with the secret only as its secret input', async () => {
    const { docker, runner, routed } = adapter();
    const options: unknown[] = [];
    const { lock, calls } = fakeLock();
    const held: HeldEnvironmentLock = {
      ...lock,
      docker: async (args, callOptions) => {
        options.push(callOptions);
        return lock.docker(args, callOptions);
      },
    };
    const result = await runWithEnvironmentLock(held, () => docker.exec('c1', ['sh', '-c', 'cat > /run/token', 'sh', 'dev'], { user: 'root', secretInput: SECRET, timeoutMs: 1000 }));
    expect(result.stdout).toBe('worker');
    expect(calls).toEqual([['exec', '-i', '-u', 'root', 'c1', 'sh', '-c', 'cat > /run/token', 'sh', 'dev']]);
    expect(options).toEqual([{ secretInput: SECRET, timeoutMs: 1000, signal: undefined }]);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect(runner.calls).toEqual([]);
    expect(routed).toEqual([]);
  });

  it('is refused without a held lock, and after the lock was lost; nothing runs directly', async () => {
    const { docker, runner, routed } = adapter();
    await expect(docker.exec('c1', ['sh'], { user: 'root', secretInput: SECRET })).rejects.toBeInstanceOf(CommandError);
    const { lock, calls, lose } = fakeLock();
    lose('the worker was lost');
    await Promise.resolve();
    await runWithEnvironmentLock(lock, async () => {
      await Promise.resolve();
      await expect(docker.exec('c1', ['sh'], { user: 'root', secretInput: SECRET })).rejects.toThrow('The lock of the environment on the Docker host was lost (the worker was lost)');
    });
    expect(calls).toEqual([]);
    expect(runner.calls).toEqual([]);
    expect(routed).toEqual([]);
  });

  it('a failure in the worker is never repeated directly', async () => {
    const { docker, runner } = adapter();
    const { lock } = fakeLock('env-1', async () => {
      throw new HelperChannelError('lost', 'gone');
    });
    await runWithEnvironmentLock(lock, async () => {
      const error = await docker.exec('c1', ['sh'], { user: 'root', secretInput: SECRET }).then(
        () => undefined,
        (reason: unknown) => reason as CommandError,
      );
      expect(error).toBeInstanceOf(CommandError);
      expect(error?.message).not.toContain(SECRET);
    });
    expect(runner.calls).toEqual([]);
  });
});
