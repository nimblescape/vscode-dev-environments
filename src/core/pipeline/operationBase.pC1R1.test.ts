// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup after plan step 11, review B round 1 of PR C1 (probe): the default of OperationBase and markViewOf, when the
// caller passes no isProcessAlive, is isProcessAlive of sessionRules.ts (A5): it is used through the instance (processAlive,
// markView), not only as a function of its own. An ID above the largest PID never counts as running (the MAX_PID guard),
// a process of another user (EPERM) does, an ended one (ESRCH) does not.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationBase, markViewOf, type OperationBaseDeps, type OperationRecords } from './operationBase';

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const owner = { windowId: 'w', pid: 1 };
const clock = { now: () => 0 };

class Probe extends OperationBase {
  constructor() {
    super({ logger, clock, owner, registry: {} } as unknown as OperationBaseDeps, async () => {}, () => ({}) as OperationRecords);
  }

  alive(pids: number[]): Promise<(pid: number) => boolean> {
    return this.processesAlive(pids);
  }

  view(): (pid: number) => boolean {
    return this.markView.isAlive;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the default isProcessAlive of OperationBase (PR C1, A5)', () => {
  it('the instance asks isProcessAlive: this process runs, an ID above the largest PID or 0 does not', async () => {
    const probe = new Probe();
    const alive = await probe.alive([process.pid, 0x80000000, 0]);
    expect(alive(process.pid)).toBe(true);
    expect(alive(0x80000000)).toBe(false);
    expect(alive(0)).toBe(false);
    expect(probe.view()(process.pid)).toBe(true);
    expect(probe.view()(0x80000000)).toBe(false);
  });

  it('markViewOf without isProcessAlive: the same default', () => {
    const view = markViewOf({ logger, clock, owner } as unknown as Pick<OperationBaseDeps, 'owner' | 'clock' | 'logger'>);
    expect(view.isAlive(process.pid)).toBe(true);
    expect(view.isAlive(0x80000000)).toBe(false);
    expect(view.isAlive(-1)).toBe(false);
  });

  it('EPERM counts as running and ESRCH does not, through the default of the instance and of markViewOf', async () => {
    const view = markViewOf({ logger, clock, owner } as unknown as Pick<OperationBaseDeps, 'owner' | 'clock' | 'logger'>);
    const probe = new Probe();
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    expect(view.isAlive(4242)).toBe(true);
    expect((await probe.alive([4242]))(4242)).toBe(true);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    expect(view.isAlive(4242)).toBe(false);
    expect((await probe.alive([4242]))(4242)).toBe(false);
  });
});
