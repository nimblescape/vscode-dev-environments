// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 5, PR B: the operation `lock` of the worker. First with a fake `flock` (the order of the steps, the exit
// codes, the cancel), then with real processes as in heartbeatLock.test.ts: `flock` as in the helper image, the kernel
// lock, a killed holder, and a lock file that is a symbolic link.
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCK_BUSY_EXIT, LOCK_HELD_STEP, lockFilePath, lockFolder } from '../core/helperChannel/protocol';
import { FLOCK_FD, LOCK_DEPS, lockOperation, openLockFile, type FlockProcess, type LockDeps } from './lock';
import { OperationError, type OperationContext } from './server';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

interface Harness {
  context: OperationContext;
  controller: AbortController;
  progress: string[];
}

function harness(secret?: string): Harness {
  const controller = new AbortController();
  const progress: string[] = [];
  return {
    controller,
    progress,
    context: {
      signal: controller.signal,
      secret,
      progress: (step) => progress.push(step),
      log: () => {},
      output: () => {},
      docker: async () => {
        throw new Error('The lock operation runs no Docker call.');
      },
    },
  };
}

/** A fake flock whose exit the test decides; records its arguments and its kills. */
class FakeFlock implements FlockProcess {
  readonly kills: string[] = [];
  private finish!: (outcome: { exitCode: number | null; error?: string; stderr?: string }) => void;
  readonly exited = new Promise<{ exitCode: number | null; error?: string; stderr?: string }>((resolve) => (this.finish = resolve));
  exit(exitCode: number | null, stderr = ''): void {
    this.finish({ exitCode, stderr });
  }
  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.kills.push(signal);
    this.finish({ exitCode: null });
  }
}

function fakeDeps(options: { openFails?: boolean } = {}): { deps: LockDeps; events: string[]; flocks: FakeFlock[] } {
  const events: string[] = [];
  const flocks: FakeFlock[] = [];
  const deps: LockDeps = {
    stateDir: '/state',
    openLockFile: (stateDir, environmentId) => {
      events.push(`open ${stateDir} ${environmentId}`);
      if (options.openFails) throw new Error('ELOOP: too many symbolic links');
      return 42;
    },
    closeFile: (fd) => events.push(`close ${fd}`),
    startFlock: (args, fd) => {
      events.push(`flock ${args.join(' ')} fd=${fd}`);
      const flock = new FakeFlock();
      flocks.push(flock);
      return flock;
    },
  };
  return { deps, events, flocks };
}

/** Lets the pending promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('the lock operation with a fake flock (plan step 5, PR B)', () => {
  it('takes the lock with flock -w -E 75 on the inherited file, reports it, and holds it until the cancel', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const done = lockOperation(deps)({ environmentId: ID, waitSeconds: 10 }, h.context);
    await settle();
    expect(events).toEqual(['open /state ' + ID, `flock -w 10 -E ${LOCK_BUSY_EXIT} ${FLOCK_FD} fd=42`]);
    flocks[0].exit(0);
    await settle();
    expect(h.progress).toEqual(['lock', LOCK_HELD_STEP]);
    // Held: the file stays open until the cancel.
    expect(events).not.toContain('close 42');
    h.controller.abort();
    await expect(done).resolves.toEqual({});
    expect(events.at(-1)).toBe('close 42');
  });

  it('exit 75 of flock is a busy lock (code busy); the file is closed', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const done = lockOperation(deps)({ environmentId: ID, waitSeconds: 10 }, h.context);
    await settle();
    flocks[0].exit(LOCK_BUSY_EXIT);
    await expect(done).rejects.toMatchObject({ name: 'OperationError', code: 'busy' });
    expect(h.progress).not.toContain(LOCK_HELD_STEP);
    expect(events.at(-1)).toBe('close 42');
  });

  it('another exit code of flock fails the operation (code failed) with its error output', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const done = lockOperation(deps)({ environmentId: ID, waitSeconds: 10 }, h.context);
    await settle();
    flocks[0].exit(1, 'flock: 3: Bad file descriptor');
    const error = await done.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ code: 'failed' });
    expect((error as Error).message).toContain('Bad file descriptor');
    expect(h.progress).not.toContain(LOCK_HELD_STEP);
    expect(events.at(-1)).toBe('close 42');
  });

  // PR #74 review round 1, B-R1-2: flock killed from outside (an OOM kill, a SIGKILL) while it waits has no lock.
  it('B-R1-2: flock ended by a signal without a cancel fails the operation (code failed), without the lock', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const done = lockOperation(deps)({ environmentId: ID, waitSeconds: 10 }, h.context);
    await settle();
    flocks[0].exit(null);
    const error = await done.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ code: 'failed' });
    expect((error as Error).message).toContain('ended by a signal');
    expect(h.progress).not.toContain(LOCK_HELD_STEP);
    expect(events.at(-1)).toBe('close 42');
  });

  it('a cancel while it waits kills flock and closes the file, without the lock', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const done = lockOperation(deps)({ environmentId: ID, waitSeconds: 10 }, h.context);
    await settle();
    h.controller.abort();
    await expect(done).rejects.toMatchObject({ code: 'cancelled' });
    expect(flocks[0].kills).toEqual(['SIGKILL']);
    expect(h.progress).not.toContain(LOCK_HELD_STEP);
    expect(events.at(-1)).toBe('close 42');
  });

  it('a cancel after the lock was taken closes the file (the lock is let go)', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const done = lockOperation(deps)({ environmentId: ID, waitSeconds: 10 }, h.context);
    await settle();
    flocks[0].exit(0);
    await settle();
    expect(events.filter((event) => event.startsWith('close'))).toEqual([]);
    h.controller.abort();
    await done;
    expect(events.filter((event) => event.startsWith('close'))).toEqual(['close 42']);
    expect(flocks[0].kills).toEqual([]);
  });

  it('lets go of the lock after its longest time (the backstop)', async () => {
    const { deps, events, flocks } = fakeDeps();
    const h = harness();
    const done = lockOperation({ ...deps, holdLimitMs: 20 })({ environmentId: ID, waitSeconds: 10 }, h.context);
    await settle();
    flocks[0].exit(0);
    await expect(done).rejects.toMatchObject({ code: 'timeout' });
    expect(events.at(-1)).toBe('close 42');
  });

  it.each<[string, unknown]>([
    ['a path in the id', { environmentId: '../../etc/passwd', waitSeconds: 10 }],
    ['a dot in the id', { environmentId: 'a.b', waitSeconds: 10 }],
    ['an empty id', { environmentId: '', waitSeconds: 10 }],
    ['an id that is no string', { environmentId: 7, waitSeconds: 10 }],
    ['no wait', { environmentId: ID, waitSeconds: 0 }],
    ['a wait that is no whole number', { environmentId: ID, waitSeconds: 1.5 }],
    ['a wait beyond the limit', { environmentId: ID, waitSeconds: 61 }],
    ['a wait as text', { environmentId: ID, waitSeconds: '10' }],
    ['a key too many', { environmentId: ID, waitSeconds: 10, force: true }],
    ['no parameters', null],
  ])('refuses %s, and opens nothing', async (_name, params) => {
    const { deps, events } = fakeDeps();
    await expect(lockOperation(deps)(params, harness().context)).rejects.toMatchObject({ code: 'invalid' });
    expect(events).toEqual([]);
  });

  it('refuses a secret, and opens nothing', async () => {
    const { deps, events } = fakeDeps();
    await expect(lockOperation(deps)({ environmentId: ID, waitSeconds: 10 }, harness('a-secret-token').context)).rejects.toMatchObject({ code: 'invalid' });
    expect(events).toEqual([]);
  });

  it('fails without flock when the lock file cannot be opened', async () => {
    const { deps, events } = fakeDeps({ openFails: true });
    await expect(lockOperation(deps)({ environmentId: ID, waitSeconds: 10 }, harness().context)).rejects.toMatchObject({ code: 'failed' });
    expect(events).toEqual([`open /state ${ID}`]);
  });
});

// As heartbeatLock.test.ts: `flock` and process groups exist on Linux only, where the helper image and CI run.
describe.skipIf(process.platform !== 'linux')('the lock operation with real processes (plan step 5, PR B)', () => {
  let stateDir: string;
  const started: ChildProcess[] = [];
  const deps = (): LockDeps => ({ ...LOCK_DEPS, stateDir });

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-environment-lock-'));
  });

  afterEach(() => {
    for (const child of started) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-(child.pid as number), 'SIGKILL');
        } catch {
          // Gone already.
        }
      }
    }
    started.length = 0;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  /** Holds the lock file of ID with `flock` in a process group of its own until it is killed; resolves once it holds it. */
  async function holdWithFlock(): Promise<ChildProcess> {
    fs.mkdirSync(lockFolder(stateDir), { recursive: true, mode: 0o700 });
    const marker = path.join(stateDir, 'held');
    const holder = spawn('flock', [lockFilePath(ID, stateDir), 'sh', '-c', `touch '${marker}'; exec sleep 60`], { detached: true, stdio: 'ignore' });
    started.push(holder);
    while (!fs.existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 10));
    return holder;
  }

  function exited(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => child.once('exit', () => resolve()));
  }

  /** `flock -n` from another process: 0 when the lock is free, 1 when it is held. */
  function tryLock(): number {
    try {
      execFileSync('flock', ['-n', lockFilePath(ID, stateDir), 'true'], { stdio: 'ignore' });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  }

  it('takes the lock (folder 0700, file 0600), holds it against another flock, and lets go of it on the cancel', { timeout: 20_000 }, async () => {
    const h = harness();
    const done = lockOperation(deps())({ environmentId: ID, waitSeconds: 5 }, h.context);
    while (!h.progress.includes(LOCK_HELD_STEP)) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.statSync(lockFolder(stateDir)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(lockFilePath(ID, stateDir)).mode & 0o777).toBe(0o600);
    expect(tryLock()).toBe(1);
    h.controller.abort();
    await done;
    expect(tryLock()).toBe(0);
    // The lock file is never deleted.
    expect(fs.existsSync(lockFilePath(ID, stateDir))).toBe(true);
  });

  it('a second holder gets exit 75 of the real flock (busy) after its wait, and the first keeps the lock', { timeout: 20_000 }, async () => {
    const first = harness();
    const holding = lockOperation(deps())({ environmentId: ID, waitSeconds: 5 }, first.context);
    while (!first.progress.includes(LOCK_HELD_STEP)) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = harness();
    const startedAt = Date.now();
    await expect(lockOperation(deps())({ environmentId: ID, waitSeconds: 1 }, second.context)).rejects.toMatchObject({ code: 'busy' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(second.progress).not.toContain(LOCK_HELD_STEP);
    expect(tryLock()).toBe(1);
    first.controller.abort();
    await holding;
    expect(tryLock()).toBe(0);
  });

  it('a holder killed with SIGKILL frees the lock at once: the waiting lock takes it', { timeout: 20_000 }, async () => {
    const holder = await holdWithFlock();
    const h = harness();
    const done = lockOperation(deps())({ environmentId: ID, waitSeconds: 10 }, h.context);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.progress).not.toContain(LOCK_HELD_STEP);
    process.kill(-(holder.pid as number), 'SIGKILL');
    await exited(holder);
    const killedAt = Date.now();
    while (!h.progress.includes(LOCK_HELD_STEP)) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Date.now() - killedAt).toBeLessThan(3_000);
    h.controller.abort();
    await done;
  });

  it('a lock file that is a symbolic link is refused, and its target is not touched', { timeout: 20_000 }, async () => {
    fs.mkdirSync(lockFolder(stateDir), { mode: 0o700 });
    const target = path.join(stateDir, 'elsewhere');
    fs.writeFileSync(target, 'data', { mode: 0o644 });
    fs.symlinkSync(target, lockFilePath(ID, stateDir));
    expect(() => openLockFile(stateDir, ID)).toThrow(/ELOOP|symbolic/);
    await expect(lockOperation(deps())({ environmentId: ID, waitSeconds: 1 }, harness().context)).rejects.toMatchObject({ code: 'failed' });
    expect(fs.readFileSync(target, 'utf8')).toBe('data');
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  });

  // PR #74 review round 1, B-R1-7: an existing folder or file with a wider mode is repaired, so no other user can
  // replace a held lock file.
  it('B-R1-7: repairs an existing lock folder at 0777 to 0700 and an existing lock file at 0666 to 0600', () => {
    fs.mkdirSync(lockFolder(stateDir));
    fs.chmodSync(lockFolder(stateDir), 0o777);
    fs.writeFileSync(lockFilePath(ID, stateDir), '');
    fs.chmodSync(lockFilePath(ID, stateDir), 0o666);
    expect(fs.statSync(lockFolder(stateDir)).mode & 0o777).toBe(0o777);
    expect(fs.statSync(lockFilePath(ID, stateDir)).mode & 0o777).toBe(0o666);
    const fd = openLockFile(stateDir, ID);
    try {
      expect(fs.statSync(lockFolder(stateDir)).mode & 0o777).toBe(0o700);
      expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('a lock folder that is a symbolic link is refused', { timeout: 20_000 }, async () => {
    const elsewhere = path.join(stateDir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, lockFolder(stateDir));
    await expect(lockOperation(deps())({ environmentId: ID, waitSeconds: 1 }, harness().context)).rejects.toMatchObject({ code: 'failed' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});
