// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { allOrAbort, RequestLimiter, Semaphore, type RequestKind } from './concurrency';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Semaphore', () => {
  it.each([1, 2, 4])('never runs more than %i functions at the same time, and runs all of them', async (limit) => {
    const semaphore = new Semaphore(limit);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      [5, 1, 3, 2, 4, 1, 2].map((value) =>
        semaphore.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await delay(value);
          active--;
          return value;
        }),
      ),
    );
    expect(results).toEqual([5, 1, 3, 2, 4, 1, 2]);
    expect(peak).toBe(limit);
  });

  it('frees the slot of a function that fails', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(async () => Promise.reject(new Error('failed')))).rejects.toThrow('failed');
    await expect(semaphore.run(async () => 'next')).resolves.toBe('next');
  });
});

describe('RequestLimiter', () => {
  /** Runs `kind` for `ms` through the limiter and records its start and end in `events`. */
  function track(limiter: RequestLimiter, events: string[], name: string, kind: RequestKind, ms: number, fail = false): Promise<string> {
    return limiter.run(async () => {
      events.push(`start ${name}`);
      await delay(ms);
      events.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    }, kind);
  }

  it.each([1, 2, 4])('never runs more than %i functions of all kinds at the same time, and runs all of them', async (limit) => {
    const limiter = new RequestLimiter(limit);
    const close = limiter.openList();
    let active = 0;
    let peak = 0;
    const kinds: RequestKind[] = ['lookup', 'list', 'lookup', 'other', 'lookup', 'lookup', 'list', 'lookup', 'lookup'];
    const results = await Promise.all(
      kinds.map((kind, index) =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await delay(1 + (index % 3));
          active--;
          if (index === 6) close();
          return index;
        }, kind),
      ),
    );
    expect(results).toEqual(kinds.map((_kind, index) => index));
    expect(peak).toBeLessThanOrEqual(limit);
    expect(limiter.peak).toBe(peak);
  });

  it('keeps one slot free for the next page of an open list, so a page never waits for a lookup', async () => {
    const limiter = new RequestLimiter(4);
    const events: string[] = [];
    const close = limiter.openList();
    const lookups = [1, 2, 3, 4, 5].map((i) => track(limiter, events, `lookup${i}`, 'lookup', 30));
    await delay(1);
    // Three lookups run; the fourth and fifth wait for the slot of the list.
    expect(events).toEqual(['start lookup1', 'start lookup2', 'start lookup3']);
    expect(limiter.lookupIdle()).toBe(false);
    await track(limiter, events, 'page', 'list', 1);
    expect(events).toContain('end page');
    expect(events.some((event) => event.startsWith('end lookup'))).toBe(false);
    // The list ends: the waiting lookups take all slots.
    close();
    await delay(1);
    expect(events.filter((event) => event.startsWith('start lookup'))).toHaveLength(4);
    await Promise.all(lookups);
    expect(limiter.peak).toBe(4);
  });

  it('gives waiting list pages and other requests the next free slot before waiting lookups', async () => {
    const limiter = new RequestLimiter(2);
    const events: string[] = [];
    const running = [track(limiter, events, 'lookup1', 'lookup', 5), track(limiter, events, 'lookup2', 'lookup', 20)];
    const waiting = [track(limiter, events, 'lookup3', 'lookup', 1), track(limiter, events, 'other', 'other', 1), track(limiter, events, 'page', 'list', 1)];
    await Promise.all([...running, ...waiting]);
    expect(events.filter((event) => event.startsWith('start')).slice(2)).toEqual(['start other', 'start page', 'start lookup3']);
  });

  it('lets lookups use every slot when no list is open, and always gives them one slot', async () => {
    const limiter = new RequestLimiter(1);
    const events: string[] = [];
    const close = limiter.openList();
    expect(limiter.lookupIdle()).toBe(true);
    await track(limiter, events, 'lookup', 'lookup', 1);
    close();
    close();
    const four = new RequestLimiter(4);
    await Promise.all([1, 2, 3, 4].map((i) => track(four, events, `l${i}`, 'lookup', 5)));
    expect(four.peak).toBe(4);
  });

  it('frees the slot of a function that fails', async () => {
    const limiter = new RequestLimiter(1);
    const events: string[] = [];
    await expect(track(limiter, events, 'fails', 'lookup', 1, true)).rejects.toThrow('fails');
    await expect(track(limiter, events, 'next', 'list', 1)).resolves.toBe('next');
  });
});

describe('allOrAbort', () => {
  it('resolves with the results in the order of the items', async () => {
    await expect(allOrAbort([3, 1, 2], async (value) => (await delay(value), value * 10))).resolves.toEqual([30, 10, 20]);
  });

  it('aborts the signal of the other calls at the first failure, and rejects with that failure', async () => {
    const aborted: number[] = [];
    const failure = new Error('owner failed');
    const result = allOrAbort([1, 2, 3], async (value, signal) => {
      if (value === 2) {
        await delay(1);
        throw failure;
      }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      aborted.push(value);
      return value;
    });
    await expect(result).rejects.toBe(failure);
    await delay(1);
    expect(aborted.sort()).toEqual([1, 3]);
  });

  it('passes an abort of the outer signal on', async () => {
    const outer = new AbortController();
    const seen: boolean[] = [];
    const result = allOrAbort([1], async (_value, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      seen.push(signal.aborted);
      return 1;
    }, outer.signal);
    outer.abort();
    await result;
    expect(seen).toEqual([true]);
  });
});
