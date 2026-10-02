// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 8, PR B (user decision D2): the lock of an automatic stop of the Session Monitor container. First with a fake
// `flock` (the outcomes and the close of the file), then with real processes as in src/helperChannel/lock.test.ts: the
// same lock file as the worker, a lock held by another process, the release, a symbolic link, and an invalid ID.
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCK_BUSY_EXIT, lockFilePath, lockFolder } from '../core/helperChannel/protocol';
import type { FlockProcess } from '../core/helperChannel/lockFile';
import { STOP_FLOCK_TIMEOUT_MS, stopLockDeps, stopLocker, type StopLockDeps } from './stopLock';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

type Outcome = { exitCode: number | null; error?: string; stderr?: string };

function fakeDeps(outcome: Outcome | 'hang' | 'throw', options: { openFails?: boolean } = {}): { deps: StopLockDeps; events: string[] } {
  const events: string[] = [];
  const deps: StopLockDeps = {
    stateDir: '/state',
    timeoutMs: 50,
    openLockFile: (stateDir, environmentId) => {
      events.push(`open ${stateDir} ${environmentId}`);
      if (options.openFails) throw new Error('ELOOP: too many symbolic links');
      return 42;
    },
    closeFile: (fd) => events.push(`close ${fd}`),
    startFlock: (args, fd): FlockProcess => {
      events.push(`flock ${args.join(' ')} fd=${fd}`);
      if (outcome === 'throw') throw new Error('spawn flock ENOENT');
      let finish!: (value: Outcome) => void;
      const exited = new Promise<Outcome>((resolve) => (finish = resolve));
      if (outcome !== 'hang') finish(outcome);
      return {
        exited,
        kill: (signal) => {
          events.push(`kill ${signal}`);
          finish({ exitCode: null });
        },
      };
    },
  };
  return { deps, events };
}

describe('stopLocker with a fake flock (plan step 8 PR B, D2)', () => {
  it('runs flock -n on file descriptor 3 and holds the open file until the release, which closes it once', async () => {
    const { deps, events } = fakeDeps({ exitCode: 0 });
    const attempt = await stopLocker(deps)(ID);
    expect(attempt.kind).toBe('locked');
    expect(events).toEqual([`open /state ${ID}`, `flock -n -E ${LOCK_BUSY_EXIT} 3 fd=42`]);
    if (attempt.kind !== 'locked') return;
    attempt.release();
    attempt.release();
    expect(events.slice(2)).toEqual(['close 42']);
  });

  it('busy: exit 75 of flock, and the file is closed', async () => {
    const { deps, events } = fakeDeps({ exitCode: LOCK_BUSY_EXIT });
    expect(await stopLocker(deps)(ID)).toEqual({ kind: 'busy' });
    expect(events.at(-1)).toBe('close 42');
  });

  it('failed: a file that cannot be opened (no flock), a flock that cannot start, another exit code, or a hang', async () => {
    const unopenable = fakeDeps({ exitCode: 0 }, { openFails: true });
    expect(await stopLocker(unopenable.deps)(ID)).toEqual({ kind: 'failed', detail: 'the lock file could not be opened: ELOOP: too many symbolic links' });
    expect(unopenable.events).toEqual([`open /state ${ID}`]);

    const thrown = fakeDeps('throw');
    expect(await stopLocker(thrown.deps)(ID)).toEqual({ kind: 'failed', detail: 'flock could not be started: spawn flock ENOENT' });
    expect(thrown.events.at(-1)).toBe('close 42');

    const notStarted = fakeDeps({ exitCode: null, error: 'spawn flock ENOENT' });
    expect(await stopLocker(notStarted.deps)(ID)).toEqual({ kind: 'failed', detail: 'flock could not be started: spawn flock ENOENT' });
    expect(notStarted.events.at(-1)).toBe('close 42');

    const other = fakeDeps({ exitCode: 1, stderr: 'flock: 3: Bad file descriptor' });
    expect(await stopLocker(other.deps)(ID)).toEqual({ kind: 'failed', detail: 'flock failed (exit code 1): flock: 3: Bad file descriptor' });
    expect(other.events.at(-1)).toBe('close 42');

    const hang = fakeDeps('hang');
    expect(await stopLocker(hang.deps)(ID)).toEqual({ kind: 'failed', detail: 'flock did not end within 0.05 s' });
    expect(hang.events.slice(-2)).toEqual(['kill SIGKILL', 'close 42']);
    expect(STOP_FLOCK_TIMEOUT_MS).toBe(10_000);
  });
});

describe.skipIf(process.platform !== 'linux')('stopLocker with real processes (plan step 8 PR B, D2)', () => {
  let stateDir: string;
  const started: ChildProcess[] = [];

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-stop-lock-'));
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

  /** `flock -n` from another process: 0 when the lock is free, 1 when it is held. */
  function tryLock(): number {
    try {
      execFileSync('flock', ['-n', lockFilePath(ID, stateDir), 'true'], { stdio: 'ignore' });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  }

  it('takes the free lock of the worker file (folder 0700, file 0600), holds it, and the release frees it; the file stays', { timeout: 20_000 }, async () => {
    const attempt = await stopLocker(stopLockDeps(stateDir))(ID);
    expect(attempt.kind).toBe('locked');
    expect(fs.statSync(lockFolder(stateDir)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(lockFilePath(ID, stateDir)).mode & 0o777).toBe(0o600);
    expect(tryLock()).toBe(1);
    if (attempt.kind === 'locked') attempt.release();
    expect(tryLock()).toBe(0);
    expect(fs.existsSync(lockFilePath(ID, stateDir))).toBe(true);
  });

  it('a lock that another process holds is busy at once, and stays held by it', { timeout: 20_000 }, async () => {
    fs.mkdirSync(lockFolder(stateDir), { recursive: true, mode: 0o700 });
    const marker = path.join(stateDir, 'held');
    const holder = spawn('flock', [lockFilePath(ID, stateDir), 'sh', '-c', `touch '${marker}'; exec sleep 60`], { detached: true, stdio: 'ignore' });
    started.push(holder);
    while (!fs.existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 10));
    const begun = Date.now();
    expect(await stopLocker(stopLockDeps(stateDir))(ID)).toEqual({ kind: 'busy' });
    expect(Date.now() - begun).toBeLessThan(5_000);
    expect(tryLock()).toBe(1);
    process.kill(-(holder.pid as number), 'SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    const attempt = await stopLocker(stopLockDeps(stateDir))(ID);
    expect(attempt.kind).toBe('locked');
    if (attempt.kind === 'locked') attempt.release();
  });

  it('a lock file that is a symbolic link fails and touches nothing; so does an invalid ID', { timeout: 20_000 }, async () => {
    fs.mkdirSync(lockFolder(stateDir), { recursive: true, mode: 0o700 });
    const target = path.join(stateDir, 'elsewhere');
    fs.writeFileSync(target, 'data', { mode: 0o644 });
    fs.symlinkSync(target, lockFilePath(ID, stateDir));
    const linked = await stopLocker(stopLockDeps(stateDir))(ID);
    expect(linked.kind).toBe('failed');
    expect(fs.readFileSync(target, 'utf8')).toBe('data');
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    expect(fs.lstatSync(lockFilePath(ID, stateDir)).isSymbolicLink()).toBe(true);

    for (const id of ['../escape', 'a.b', '', 'x/y']) {
      expect(await stopLocker(stopLockDeps(stateDir))(id)).toEqual({ kind: 'failed', detail: 'the lock file could not be opened: The environment ID of the lock is invalid.' });
    }
    expect(fs.readdirSync(stateDir).sort()).toEqual(['elsewhere', 'locks']);
  });

  // Review round 1 of PR #86, B-R1-4 (mutants L05, L10): a lock path that is no plain file (a FIFO, a folder) fails before
  // any flock, and the file it opened is closed again.
  it('a FIFO or a folder at the lock path fails, starts no flock, and leaves no file open (review round 1 of PR #86, B-R1-4)', { timeout: 20_000 }, async () => {
    fs.mkdirSync(lockFolder(stateDir), { recursive: true, mode: 0o700 });
    const flocks: number[] = [];
    const deps: StopLockDeps = {
      ...stopLockDeps(stateDir),
      startFlock: (_args, fd) => {
        flocks.push(fd);
        return { exited: Promise.resolve({ exitCode: 0 }), kill: () => {} };
      },
    };
    const openFiles = () => fs.readdirSync('/proc/self/fd').length;
    execFileSync('mkfifo', ['-m', '600', lockFilePath(ID, stateDir)]);
    const before = openFiles();
    const fifo = await stopLocker(deps)(ID);
    expect(fifo).toEqual({ kind: 'failed', detail: `the lock file could not be opened: The lock file of ${ID} is not a plain file.` });
    expect(openFiles()).toBe(before);
    expect(flocks).toEqual([]);

    fs.rmSync(lockFilePath(ID, stateDir));
    fs.mkdirSync(lockFilePath(ID, stateDir), { mode: 0o700 });
    const folder = await stopLocker(deps)(ID);
    expect(folder.kind).toBe('failed');
    expect(openFiles()).toBe(before);
    expect(flocks).toEqual([]);
  });
});
