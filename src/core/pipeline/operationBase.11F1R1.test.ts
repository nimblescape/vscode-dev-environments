// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11F1, review B round 1 (mutation probes): the rules of OperationBase that the window's operations and the
// worker's pipeline share. One operation per repository at a time also with three queued; a process whose state is not
// known counts as running; processExists never counts an invalid PID as running, and counts a process of another user
// (EPERM) as running.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationBase, processExists, type OperationBaseDeps, type OperationRecords } from './operationBase';

class Probe extends OperationBase {
  constructor(deps: Partial<OperationBaseDeps> = {}) {
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    // Plan step 11I (PR D): the busy marks and the registry writes of the open come from the subclass (none used here).
    super({ logger, clock: { now: () => 0 }, owner: { windowId: 'w', pid: 1 }, registry: {}, ...deps } as unknown as OperationBaseDeps, async () => {}, () => ({}) as OperationRecords);
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.exclusive(key, undefined, fn);
  }

  alive(pids: number[]): Promise<(pid: number) => boolean> {
    return this.processesAlive(pids);
  }
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OperationBase, review B round 1 of plan step 11F1', () => {
  it('runs the operations on one repository one after the other, also when an earlier one ends while others wait', async () => {
    const probe = new Probe();
    let running = 0;
    let most = 0;
    const gates = [gate(), gate(), gate(), gate()];
    const operation = (index: number) => async () => {
      running++;
      most = Math.max(most, running);
      await gates[index].promise;
      running--;
    };
    const a = probe.run('acme/api', operation(0));
    const b = probe.run('acme/api', operation(1));
    const c = probe.run('acme/api', operation(2));
    await flush();
    gates[0].open();
    await a;
    await flush();
    // B runs now; C waits. An operation that comes now waits for C.
    const d = probe.run('acme/api', operation(3));
    await flush();
    expect(running).toBe(1);
    for (const g of gates.slice(1)) {
      g.open();
      await flush();
    }
    await Promise.all([b, c, d]);
    expect(most).toBe(1);
  });

  it('a process that was not asked counts as running', async () => {
    const probe = new Probe({ processAlive: async () => false });
    const alive = await probe.alive([10]);
    expect(alive(10)).toBe(false);
    expect(alive(11)).toBe(true);
  });

  it('processExists: no invalid PID counts as running', () => {
    const kill = vi.spyOn(process, 'kill');
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(processExists(pid), String(pid)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('processExists: a process of another user (EPERM) counts as running; an ended one (ESRCH) does not', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    expect(processExists(4242)).toBe(true);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    expect(processExists(4242)).toBe(false);
  });
});
