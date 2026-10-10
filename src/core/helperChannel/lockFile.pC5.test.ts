// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup C5 (plan step 11J, B3): the one flock acquisition (acquireFlock) of the environment lock of the worker
// (takeEnvironmentLock), the stop lock of the Session Monitor (stopLocker) and the locks of the shared VS Code store
// (storeLock, storeTryLock). The first part pins how each caller maps every outcome to its own errors, texts and flock
// arguments (these tests ran unchanged on the code before the cleanup); the second part pins acquireFlock itself. A fake
// `flock` throughout; the store locks open their lock files in a temporary folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { takeEnvironmentLock, type LockDeps } from '../../helperChannel/lock';
import { stopLocker, type StopLockDeps } from '../../remoteMonitor/stopLock';
import { storeLock, storeTryLock } from '../worker/vscodeServerStore';
import { acquireFlock, type FlockProcess } from './lockFile';
import { LOCK_BUSY_EXIT } from './protocol';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
type Outcome = { exitCode: number | null; error?: string; stderr?: string };
/** What the fake flock does: end with an outcome, never end on its own (until killed), throw at its start, or reject. */
type Behaviour = Outcome | 'hang' | 'throw' | 'reject';

/** A fake start of `flock`; every start, kill and close lands in `events`. */
function fakeFlock(behaviour: Behaviour, events: string[]) {
  return (args: readonly string[], fd: number): FlockProcess => {
    events.push(`flock ${args.join(' ')}`);
    if (behaviour === 'throw') throw new Error('spawn flock EACCES');
    let finish!: (value: Outcome) => void;
    let fail!: (error: Error) => void;
    const exited = new Promise<Outcome>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    if (behaviour === 'reject') fail(new Error('the end of flock was lost'));
    else if (behaviour !== 'hang') finish(behaviour);
    void fd;
    return {
      exited,
      kill: (signal) => {
        events.push(`kill ${signal}`);
        finish({ exitCode: null });
      },
    };
  };
}

describe('each caller keeps its errors (cleanup C5, B3)', () => {
  describe('takeEnvironmentLock (the worker)', () => {
    function deps(behaviour: Behaviour, events: string[], openFails = false): LockDeps {
      return {
        stateDir: '/state',
        openLockFile: () => {
          events.push('open');
          if (openFails) throw new Error('ELOOP: too many symbolic links');
          return 42;
        },
        closeFile: (fd) => void events.push(`close ${fd}`),
        startFlock: fakeFlock(behaviour, events),
      };
    }
    const take = async (behaviour: Behaviour, options: { openFails?: boolean; signal?: AbortSignal } = {}) => {
      const events: string[] = [];
      const outcome = await takeEnvironmentLock(deps(behaviour, events, options.openFails), ID, 7, options.signal ?? new AbortController().signal).then(
        (release) => ({ release }),
        (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }),
      );
      return { outcome, events };
    };

    it('the lock: flock with a wait on descriptor 3; the release closes the file', async () => {
      const { outcome, events } = await take({ exitCode: 0 });
      expect(events).toEqual(['open', `flock -w 7 -E ${LOCK_BUSY_EXIT} 3`]);
      if (!('release' in outcome)) throw new Error('not locked');
      outcome.release();
      expect(events.slice(2)).toEqual(['close 42']);
    });

    it('every other outcome: its OperationError, and the file closed', async () => {
      expect(await take({ exitCode: 0 }, { openFails: true })).toEqual({
        outcome: { code: 'failed', message: 'The lock file could not be opened: ELOOP: too many symbolic links' },
        events: ['open'],
      });
      expect((await take('throw')).outcome).toEqual({ code: 'failed', message: 'flock could not be started: spawn flock EACCES' });
      expect((await take({ exitCode: null, error: 'spawn flock ENOENT' })).outcome).toEqual({ code: 'failed', message: 'flock could not be started: spawn flock ENOENT' });
      expect((await take({ exitCode: LOCK_BUSY_EXIT })).outcome).toEqual({ code: 'busy', message: 'The lock stayed held by another holder for 7 s.' });
      expect((await take({ exitCode: 1, stderr: 'flock: bad file' })).outcome).toEqual({ code: 'failed', message: 'flock failed (exit code 1): flock: bad file' });
      expect((await take({ exitCode: null, stderr: '' })).outcome).toEqual({ code: 'failed', message: 'flock failed (ended by a signal)' });
      for (const behaviour of ['throw', { exitCode: LOCK_BUSY_EXIT }, { exitCode: 1 }] as const) expect((await take(behaviour)).events.at(-1)).toBe('close 42');
      expect((await take('reject')).outcome).toEqual({ code: undefined, message: 'the end of flock was lost' });
    });

    it('a cancellation before the start starts no flock; one during the wait kills it; both are `cancelled`', async () => {
      const aborted = new AbortController();
      aborted.abort();
      expect(await take({ exitCode: 0 }, { signal: aborted.signal })).toEqual({
        outcome: { code: 'cancelled', message: 'The lock operation was cancelled.' },
        events: ['open', 'close 42'],
      });
      const controller = new AbortController();
      const pending = take('hang', { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      expect(await pending).toEqual({
        outcome: { code: 'cancelled', message: 'The lock operation was cancelled.' },
        events: ['open', `flock -w 7 -E ${LOCK_BUSY_EXIT} 3`, 'kill SIGKILL', 'close 42'],
      });
    });
  });

  describe('stopLocker (the Session Monitor)', () => {
    function deps(behaviour: Behaviour, events: string[], openFails = false): StopLockDeps {
      return {
        stateDir: '/state',
        timeoutMs: 50,
        openLockFile: () => {
          events.push('open');
          if (openFails) throw new Error('ELOOP: too many symbolic links');
          return 42;
        },
        closeFile: (fd) => void events.push(`close ${fd}`),
        startFlock: fakeFlock(behaviour, events),
      };
    }
    const attempt = async (behaviour: Behaviour, openFails = false) => {
      const events: string[] = [];
      const result = await stopLocker(deps(behaviour, events, openFails))(ID);
      return { result, events };
    };

    it('maps each outcome to its attempt, with flock -n and the file closed unless locked', async () => {
      const locked = await attempt({ exitCode: 0 });
      expect(locked.events).toEqual(['open', `flock -n -E ${LOCK_BUSY_EXIT} 3`]);
      expect(locked.result.kind).toBe('locked');
      expect(await attempt({ exitCode: 0 }, true)).toEqual({ result: { kind: 'failed', detail: 'the lock file could not be opened: ELOOP: too many symbolic links' }, events: ['open'] });
      expect((await attempt('throw')).result).toEqual({ kind: 'failed', detail: 'flock could not be started: spawn flock EACCES' });
      expect((await attempt('reject')).result).toEqual({ kind: 'failed', detail: 'flock could not be started: the end of flock was lost' });
      expect((await attempt({ exitCode: null, error: 'spawn flock ENOENT' })).result).toEqual({ kind: 'failed', detail: 'flock could not be started: spawn flock ENOENT' });
      expect((await attempt({ exitCode: LOCK_BUSY_EXIT })).result).toEqual({ kind: 'busy' });
      expect((await attempt({ exitCode: 1, stderr: 'flock: bad file' })).result).toEqual({ kind: 'failed', detail: 'flock failed (exit code 1): flock: bad file' });
      expect((await attempt({ exitCode: null })).result).toEqual({ kind: 'failed', detail: 'flock failed (ended by a signal)' });
      const hung = await attempt('hang');
      expect(hung).toEqual({ result: { kind: 'failed', detail: 'flock did not end within 0.05 s' }, events: ['open', `flock -n -E ${LOCK_BUSY_EXIT} 3`, 'kill SIGKILL', 'close 42'] });
      for (const behaviour of ['throw', 'reject', { exitCode: LOCK_BUSY_EXIT }, { exitCode: 1 }] as const) expect((await attempt(behaviour)).events.at(-1)).toBe('close 42');
    });
  });

  describe('storeLock and storeTryLock (the shared VS Code store)', () => {
    let root: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-c5-store-'));
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    const lockOf = async (behaviour: Behaviour, signal: AbortSignal = new AbortController().signal, lockFile?: string) => {
      const events: string[] = [];
      const outcome = await storeLock(root, 'stable-linux-x64-abc', 9, signal, fakeFlock(behaviour, events), lockFile).then(
        (release) => ({ release }),
        (error: Error) => ({ message: error.message }),
      );
      return { outcome, events };
    };

    it('storeLock: flock with a wait; each outcome its error (a failed open or start rejects with its own error)', async () => {
      const locked = await lockOf({ exitCode: 0 });
      expect(locked.events).toEqual([`flock -w 9 -E ${LOCK_BUSY_EXIT} 3`]);
      if (!('release' in locked.outcome)) throw new Error('not locked');
      locked.outcome.release();
      expect((await lockOf('throw')).outcome).toEqual({ message: 'spawn flock EACCES' });
      expect((await lockOf('reject')).outcome).toEqual({ message: 'the end of flock was lost' });
      expect((await lockOf({ exitCode: null, error: 'spawn flock ENOENT' })).outcome).toEqual({ message: 'flock could not be started: spawn flock ENOENT' });
      expect((await lockOf({ exitCode: LOCK_BUSY_EXIT })).outcome).toEqual({ message: 'the lock of the server stayed held for 9 s' });
      // Without the error output of flock.
      expect((await lockOf({ exitCode: 1, stderr: 'flock: bad file' })).outcome).toEqual({ message: 'flock failed (exit code 1)' });
      expect((await lockOf({ exitCode: null })).outcome).toEqual({ message: 'flock failed (ended by a signal)' });
      const folder = path.join(root, 'in-the-way');
      fs.mkdirSync(folder);
      const open = await lockOf({ exitCode: 0 }, undefined, folder);
      expect(open.events).toEqual([]);
      expect('message' in open.outcome && open.outcome.message).toMatch(/EISDIR/);
      const aborted = new AbortController();
      aborted.abort();
      expect(await lockOf({ exitCode: 0 }, aborted.signal)).toEqual({ outcome: { message: 'the wait for the lock of the server ended' }, events: [] });
      const controller = new AbortController();
      const pending = lockOf('hang', controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      expect(await pending).toEqual({ outcome: { message: 'the wait for the lock of the server ended' }, events: [`flock -w 9 -E ${LOCK_BUSY_EXIT} 3`, 'kill SIGKILL'] });
    });

    it('storeTryLock: flock -n; each outcome its attempt', async () => {
      const attempt = async (behaviour: Behaviour, lockFile?: string) => {
        const events: string[] = [];
        return { result: await storeTryLock(root, 'stable-linux-x64-abc', fakeFlock(behaviour, events), lockFile), events };
      };
      const locked = await attempt({ exitCode: 0 });
      expect(locked.events).toEqual([`flock -n -E ${LOCK_BUSY_EXIT} 3`]);
      expect(locked.result.kind).toBe('locked');
      if (locked.result.kind === 'locked') locked.result.release();
      expect((await attempt('throw')).result).toEqual({ kind: 'failed', detail: 'flock could not be started: spawn flock EACCES' });
      expect((await attempt('reject')).result).toEqual({ kind: 'failed', detail: 'flock could not be started: the end of flock was lost' });
      expect((await attempt({ exitCode: null, error: 'spawn flock ENOENT' })).result).toEqual({ kind: 'failed', detail: 'flock could not be started: spawn flock ENOENT' });
      expect((await attempt({ exitCode: LOCK_BUSY_EXIT })).result).toEqual({ kind: 'busy' });
      expect((await attempt({ exitCode: 1, stderr: 'flock: bad file' })).result).toEqual({ kind: 'failed', detail: 'flock failed (exit code 1)' });
      const folder = path.join(root, 'in-the-way');
      fs.mkdirSync(folder);
      const open = await attempt({ exitCode: 0 }, folder);
      expect(open.events).toEqual([]);
      expect(open.result).toMatchObject({ kind: 'failed', detail: expect.stringMatching(/^the lock file could not be opened: .*EISDIR/) });
    });
  });
});

describe('acquireFlock (cleanup C5, B3)', () => {
  const how = (behaviour: Behaviour, events: string[]) => ({
    open: () => (events.push('open'), 42),
    close: (fd: number) => void events.push(`close ${fd}`),
    start: fakeFlock(behaviour, events),
  });

  it('a release closes the file once, also when it is called again', async () => {
    const events: string[] = [];
    const attempt = await acquireFlock({ ...how({ exitCode: 0 }, events), waitSeconds: 3 });
    expect(attempt.kind).toBe('locked');
    if (attempt.kind !== 'locked') return;
    attempt.release();
    attempt.release();
    expect(events).toEqual(['open', `flock -w 3 -E ${LOCK_BUSY_EXIT} 3`, 'close 42']);
  });

  it('a cancellation counts before the outcome of flock: the file is closed and the lock not kept', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const start = (args: readonly string[], fd: number): FlockProcess => {
      const started = fakeFlock({ exitCode: 0 }, events)(args, fd);
      controller.abort();
      return started;
    };
    expect(await acquireFlock({ ...how({ exitCode: 0 }, events), start, signal: controller.signal })).toEqual({ kind: 'cancelled' });
    expect(events).toEqual(['open', `flock -n -E ${LOCK_BUSY_EXIT} 3`, 'kill SIGKILL', 'close 42']);
  });

  it('a close that throws counts as closed', async () => {
    const attempt = await acquireFlock({
      open: () => 42,
      close: () => {
        throw new Error('EBADF');
      },
      start: fakeFlock({ exitCode: LOCK_BUSY_EXIT }, []),
    });
    expect(attempt).toEqual({ kind: 'busy' });
  });
});
