import { describe, expect, it } from 'vitest';
import { CoalescingTask, OperationGate, Throttle, mapLimit } from './tasks';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('CoalescingTask', () => {
  it('join reuses the running execution', async () => {
    const gate = deferred<number>();
    let calls = 0;
    const task = new CoalescingTask(() => {
      calls++;
      return gate.promise;
    });
    const first = task.join();
    const second = task.join();
    expect(task.busy).toBe(true);
    gate.resolve(7);
    await expect(first).resolves.toBe(7);
    await expect(second).resolves.toBe(7);
    expect(calls).toBe(1);
    expect(task.busy).toBe(false);
  });

  it('request runs once more after the running execution, shared by all requests in between', async () => {
    const gates = [deferred<number>(), deferred<number>()];
    let calls = 0;
    const task = new CoalescingTask(() => gates[calls++].promise);
    const first = task.request();
    const second = task.request();
    const third = task.request();
    expect(calls).toBe(1);
    gates[0].resolve(1);
    await expect(first).resolves.toBe(1);
    await Promise.resolve();
    gates[1].resolve(2);
    await expect(second).resolves.toBe(2);
    await expect(third).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  it('runs the queued execution also when the running one fails, and passes each result on', async () => {
    const gates = [deferred<number>(), deferred<number>()];
    let calls = 0;
    const task = new CoalescingTask(() => gates[calls++].promise);
    const first = task.request();
    const second = task.request();
    gates[0].reject(new Error('offline'));
    await expect(first).rejects.toThrow('offline');
    gates[1].resolve(5);
    await expect(second).resolves.toBe(5);
  });

  it('join during a queued execution waits for the queued one', async () => {
    const gates = [deferred<number>(), deferred<number>()];
    let calls = 0;
    const task = new CoalescingTask(() => gates[calls++].promise);
    void task.request();
    const queued = task.request();
    const joined = task.join();
    gates[0].resolve(1);
    await Promise.resolve();
    gates[1].resolve(2);
    await expect(joined).resolves.toBe(2);
    await expect(queued).resolves.toBe(2);
  });

  it('turns a synchronous throw into a rejection and can run again', async () => {
    let fail = true;
    const task = new CoalescingTask(async () => {
      if (fail) throw new Error('boom');
      return 1;
    });
    await expect(task.join()).rejects.toThrow('boom');
    fail = false;
    await expect(task.join()).resolves.toBe(1);
    const sync = new CoalescingTask<number>(() => {
      throw new Error('sync');
    });
    await expect(sync.request()).rejects.toThrow('sync');
    expect(sync.busy).toBe(false);
  });
});

describe('OperationGate', () => {
  it('runs one operation per key at a time, ignoring the case of the key', async () => {
    const gate = new OperationGate();
    const running = deferred<string>();
    const first = gate.run('Acme/API', 'Start', () => running.promise);
    expect(gate.runningFor('acme/api')).toBe('Start');
    await expect(gate.run('acme/api', 'Stop', async () => 'no')).resolves.toEqual({ started: false, running: 'Start' });
    // Another key is independent.
    await expect(gate.run('acme/web', 'Stop', async () => 'yes')).resolves.toEqual({ started: true, value: 'yes' });
    running.resolve('done');
    await expect(first).resolves.toEqual({ started: true, value: 'done' });
    expect(gate.runningFor('acme/api')).toBeUndefined();
    expect(gate.keys()).toEqual([]);
  });

  it('releases the key when the operation fails', async () => {
    const gate = new OperationGate();
    await expect(gate.run('a/b', 'Delete', async () => Promise.reject(new Error('failed')))).rejects.toThrow('failed');
    await expect(gate.run('a/b', 'Delete', async () => 1)).resolves.toEqual({ started: true, value: 1 });
  });
});

describe('Throttle', () => {
  it('allows one call per interval', () => {
    let now = 1000;
    const throttle = new Throttle(15_000, () => now);
    expect(throttle.tryAcquire()).toBe(true);
    now += 14_999;
    expect(throttle.tryAcquire()).toBe(false);
    now += 1;
    expect(throttle.tryAcquire()).toBe(true);
    // A clock that went back allows the call.
    now -= 60_000;
    expect(throttle.tryAcquire()).toBe(true);
  });
});

describe('mapLimit', () => {
  it('keeps the order and never runs more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapLimit([5, 1, 3, 2, 4], 2, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active--;
      return value * 10;
    });
    expect(results).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
    await expect(mapLimit([], 3, async () => 1)).resolves.toEqual([]);
  });
});
