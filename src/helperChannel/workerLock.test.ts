// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B3b: the lock of an environment as the worker's own pipeline holds it (workerEnvironmentLock), with a fake
// flock: the refusals as the pipeline expects them, the batch session of the flow, no Docker call, and `lost`.
import { describe, expect, it } from 'vitest';
import { EnvironmentLockError } from '../core/docker/environmentLock';
import type { HelperBatchSession } from '../core/helperChannel/helperChannel';
import { LOCK_BUSY_EXIT, flockArgs } from '../core/helperChannel/protocol';
import { FLOCK_FD } from './lock';
import type { FlockProcess, LockDeps } from './lock';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';
import { workerEnvironmentLock } from './workerLock';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

function setup(flock: () => Promise<{ exitCode: number | null }>, options: { openFails?: boolean } = {}) {
  const events: string[] = [];
  const controller = new AbortController();
  const context = { signal: controller.signal, ...contextSecrets({}), progress: () => {}, log: () => {}, output: () => {} } as unknown as OperationContext;
  const deps: LockDeps = {
    stateDir: '/state',
    openLockFile: () => {
      if (options.openFails) throw new Error('ELOOP');
      events.push('open');
      return 9;
    },
    closeFile: () => events.push('close'),
    startFlock: (args): FlockProcess => {
      events.push(`flock ${args.join(' ')}`);
      // As flock: a kill ends it (without the lock).
      let killed: (outcome: { exitCode: number | null }) => void = () => {};
      const ended = new Promise<{ exitCode: number | null }>((resolve) => (killed = resolve));
      return {
        exited: Promise.race([flock(), ended]),
        kill: () => {
          events.push('kill');
          killed({ exitCode: null });
        },
      };
    },
  };
  const opened: unknown[] = [];
  const session = { session: 's' } as HelperBatchSession;
  const lock = workerEnvironmentLock(
    deps,
    async (p) => (opened.push(p), session),
    context,
  );
  return { lock, events, controller, opened, session };
}

describe("the lock of the worker's own pipeline (plan step 11B3b)", () => {
  it('holds the lock until release; opens the batch session of the flow; refuses a Docker call', async () => {
    const { lock, events, opened, session } = setup(async () => ({ exitCode: 0 }));
    const held = await lock(ID, 10, undefined);
    expect(held.environmentId).toBe(ID);
    // Review round 1 of 11B3b (B-R1-11): changed expectation, flock waits the given time (D3).
    expect(events).toEqual(['open', `flock ${flockArgs(10, FLOCK_FD).join(' ')}`]);
    expect(await held.batch?.({ volume: 'v', image: 'sha256:x', socket: '/s' })).toBe(session);
    expect(opened).toEqual([{ volume: 'v', image: 'sha256:x', socket: '/s' }]);
    await expect(held.docker(['ps'], {})).rejects.toThrow('not allowed');
    await held.release();
    expect(events.at(-1)).toBe('close');
  });

  it('a holder elsewhere is busy; any other failure is unavailable; a cancel is an AbortError', async () => {
    const busy = setup(async () => ({ exitCode: LOCK_BUSY_EXIT }));
    const error = await busy.lock(ID, 10, undefined).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EnvironmentLockError);
    expect(error).toMatchObject({ kind: 'busy' });
    expect(busy.events.at(-1)).toBe('close');
    await expect(setup(async () => ({ exitCode: 1 })).lock(ID, 10, undefined)).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(setup(async () => ({ exitCode: 0 }), { openFails: true }).lock(ID, 10, undefined)).rejects.toMatchObject({ kind: 'unavailable' });
    // A cancel of the pipeline's own signal, or of the operation, while flock waits.
    const waiting = setup(() => new Promise(() => {}));
    const pipeline = new AbortController();
    const taking = waiting.lock(ID, 10, pipeline.signal);
    await new Promise((resolve) => setImmediate(resolve));
    pipeline.abort();
    await expect(taking).rejects.toMatchObject({ name: 'AbortError' });
    expect(waiting.events).toContain('kill');
  });

  it('is lost when the operation ends without release, never after release', async () => {
    const first = setup(async () => ({ exitCode: 0 }));
    const held = await first.lock(ID, 10, undefined);
    first.controller.abort();
    expect(await held.lost).toBe('the operation of the worker ended');
    // Review round 2 of 11B3b (A-R2-1): the lock file stays open until the release (after the batch helper closed), which
    // closes it once.
    expect(first.events.filter((event) => event === 'close')).toEqual([]);
    await held.release();
    await held.release();
    expect(first.events.filter((event) => event === 'close')).toEqual(['close']);
    const second = setup(async () => ({ exitCode: 0 }));
    const kept = await second.lock(ID, 10, undefined);
    await kept.release();
    second.controller.abort();
    const outcome = await Promise.race([kept.lost, new Promise((resolve) => setTimeout(() => resolve('not lost'), 20))]);
    expect(outcome).toBe('not lost');
  });
});
