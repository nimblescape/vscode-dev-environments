// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11I1, PR A1 (review round 2, reviewer B): a cancel of the worker pipeline while its real `flock` waits for a
// lock that the Session Monitor holds ends the wait at once (startFlockProcess kill), and leaves no holder behind: the
// monitor takes the lock right after its release. Mutation testing showed that a no-op `kill` in startFlockProcess
// (src/core/helperChannel/lockFile.ts) survived every unit test (they use a fake flock) and the R1 probe.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HelperBatchSession } from '../core/helperChannel/helperChannel';
import { stopLockDeps, stopLocker, type StopLockDeps } from '../remoteMonitor/stopLock';
import { LOCK_DEPS, type LockDeps } from './lock';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';
import { workerEnvironmentLock } from './workerLock';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

describe('11I1 A1 R2: a cancel of the worker lock while the real flock waits', () => {
  let stateDir = '';
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-11i1-r2-'));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('ends the wait at once with an AbortError, and leaves the lock free after the monitor lets go', { timeout: 30_000 }, async () => {
    const monitor = await stopLocker(stopLockDeps(stateDir))(ID);
    expect(monitor.kind).toBe('locked');
    const operation = new AbortController();
    const context = { signal: operation.signal, ...contextSecrets({}), progress: () => {}, log: () => {}, output: () => {} } as unknown as OperationContext;
    const deps: LockDeps = { ...LOCK_DEPS, stateDir };
    const flow = new AbortController();
    const started = Date.now();
    const attempt = workerEnvironmentLock(deps, async () => ({ session: 's' }) as HelperBatchSession, context)(ID, 20, flow.signal).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    flow.abort();
    const refused = await attempt;
    expect((refused as Error).name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(5_000);
    if (monitor.kind === 'locked') monitor.release();
    // A flock left waiting with the worker's open file would take the lock now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const again = await stopLocker(stopLockDeps(stateDir))(ID);
    expect(again.kind).toBe('locked');
    if (again.kind === 'locked') again.release();
    operation.abort();
  });

  it('the end of the worker operation (not only the signal of the flow) also ends the wait at once', { timeout: 30_000 }, async () => {
    const monitor = await stopLocker(stopLockDeps(stateDir))(ID);
    expect(monitor.kind).toBe('locked');
    const operation = new AbortController();
    const context = { signal: operation.signal, ...contextSecrets({}), progress: () => {}, log: () => {}, output: () => {} } as unknown as OperationContext;
    const started = Date.now();
    const attempt = workerEnvironmentLock({ ...LOCK_DEPS, stateDir }, async () => ({ session: 's' }) as HelperBatchSession, context)(ID, 20, new AbortController().signal).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    operation.abort();
    expect(((await attempt) as Error).name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(5_000);
    if (monitor.kind === 'locked') monitor.release();
  });

  it('a flock of the monitor ended by a signal (exit code null) is never a held stop lock', async () => {
    const closed: number[] = [];
    const deps: StopLockDeps = {
      stateDir,
      openLockFile: () => 42,
      closeFile: (fd) => void closed.push(fd),
      startFlock: () => ({ exited: Promise.resolve({ exitCode: null, stderr: '' }), kill: () => {} }),
    };
    const attempt = await stopLocker(deps)(ID);
    expect(attempt.kind).toBe('failed');
    expect(closed).toEqual([42]);
  });
});
