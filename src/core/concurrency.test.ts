// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { allOrAbort, Semaphore } from './concurrency';

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
