// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I1, PR A1 (review round 1, reviewer B): the Docker tests no longer have a worker hold a lock against the
// Session Monitor (remoteMonitor.test.ts: holdLockInContainer/lockIsFree instead of the `lock` operation), and the busy
// check of workerFlows.test.ts uses a `flock(1)` holder instead of a second worker. This keeps, with the real `flock` on a
// folder of the test, the direct interop of the two production holders that the move took out of the Docker tests: the
// lock of the worker's own pipeline (workerEnvironmentLock over takeEnvironmentLock and openLockFile) against the stop
// lock of the Session Monitor (stopLocker), both ways; and that the script of the new Docker helpers (test/docker/
// lockHolder.ts, bundled as holdLockInContainer and lockIsFree run it; review round 1, A-M1) conflicts with both, as those
// tests assume.
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentLockError } from '../core/docker/environmentLock';
import type { HelperBatchSession } from '../core/helperChannel/helperChannel';
import { LOCK_BUSY_EXIT } from '../core/helperChannel/protocol';
import { stopLockDeps, stopLocker } from '../remoteMonitor/stopLock';
import { LOCK_DEPS, type LockDeps } from './lock';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';
import { workerEnvironmentLock } from './workerLock';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

describe('11I1 A1 R1: the worker lock and the monitor stop lock on the same lock file (real flock)', () => {
  let stateDir = '';
  const started: ChildProcess[] = [];
  const controllers: AbortController[] = [];

  let holderScript = '';

  beforeEach(async () => {
    holderScript ||= (
      await esbuild.build({ entryPoints: [path.resolve(__dirname, '../../test/docker/lockHolder.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', write: false, logLevel: 'silent' })
    ).outputFiles[0].text;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-11i1-lock-'));
  });

  afterEach(() => {
    for (const c of controllers) c.abort();
    controllers.length = 0;
    for (const child of started) {
      // Review round 2 (A-L1): only a holder that still runs (the group of one that ended may be another's by now).
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    started.length = 0;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function workerLock() {
    const controller = new AbortController();
    controllers.push(controller);
    const context = { signal: controller.signal, ...contextSecrets({}), progress: () => {}, log: () => {}, output: () => {} } as unknown as OperationContext;
    const deps: LockDeps = { ...LOCK_DEPS, stateDir };
    return workerEnvironmentLock(deps, async () => ({ session: 's' }) as HelperBatchSession, context);
  }

  /** As lockIsFree of test/docker/workerLocks.ts (lockHolder.ts `try`): 0 when taken, LOCK_BUSY_EXIT when held for the whole wait. */
  function lockIsFreeScript(waitSeconds: number): number {
    try {
      execFileSync(process.execPath, ['-e', holderScript, 'try', ID, String(waitSeconds), stateDir], { stdio: 'ignore' });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  }

  /** As holdLockInContainer of test/docker/workerLocks.ts (lockHolder.ts `hold`); resolves once it holds the lock. */
  async function holdLikeContainer(): Promise<ChildProcess> {
    const holder = spawn(process.execPath, ['-e', holderScript, 'hold', ID, '30', stateDir], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    started.push(holder);
    await new Promise<void>((resolve, reject) => {
      let out = '';
      holder.stdout!.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('held')) resolve();
      });
      holder.once('exit', (code) => reject(new Error(`the holder exited with ${code}`)));
    });
    return holder;
  }

  it('a lock held by the worker pipeline makes the monitor busy and the lockIsFree script busy; after release both take it', { timeout: 20_000 }, async () => {
    const held = await workerLock()(ID, 1, undefined);
    expect((await stopLocker(stopLockDeps(stateDir))(ID)).kind).toBe('busy');
    expect(lockIsFreeScript(1)).toBe(LOCK_BUSY_EXIT);
    await held.release();
    const attempt = await stopLocker(stopLockDeps(stateDir))(ID);
    expect(attempt.kind).toBe('locked');
    if (attempt.kind === 'locked') attempt.release();
    expect(lockIsFreeScript(1)).toBe(0);
  });

  it('a stop lock held by the monitor makes the worker pipeline busy; after release the worker takes it', { timeout: 20_000 }, async () => {
    const attempt = await stopLocker(stopLockDeps(stateDir))(ID);
    expect(attempt.kind).toBe('locked');
    await expect(workerLock()(ID, 1, undefined)).rejects.toMatchObject({ kind: 'busy' });
    expect(lockIsFreeScript(1)).toBe(LOCK_BUSY_EXIT);
    if (attempt.kind === 'locked') attempt.release();
    const held = await workerLock()(ID, 1, undefined);
    await held.release();
  });

  it('the holdLockInContainer script (lockHolder.ts) makes both the worker pipeline and the monitor busy; its kill frees the lock', { timeout: 20_000 }, async () => {
    const holder = await holdLikeContainer();
    const refused = await workerLock()(ID, 1, undefined).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(EnvironmentLockError);
    expect((refused as EnvironmentLockError).kind).toBe('busy');
    expect((await stopLocker(stopLockDeps(stateDir))(ID)).kind).toBe('busy');
    process.kill(-(holder.pid as number), 'SIGKILL');
    await new Promise<void>((resolve) => (holder.exitCode !== null || holder.signalCode !== null ? resolve() : holder.once('exit', () => resolve())));
    expect(lockIsFreeScript(2)).toBe(0);
    const attempt = await stopLocker(stopLockDeps(stateDir))(ID);
    expect(attempt.kind).toBe('locked');
    if (attempt.kind === 'locked') attempt.release();
  });
});
