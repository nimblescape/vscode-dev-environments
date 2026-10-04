// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #103 (B, mutation probes): a slot handed on to a waiting job stays taken (the count does not
// also drop), and each set of slots counts only its own jobs.
import { describe, expect, it } from 'vitest';
import type { AnalysisJob, AnalysisResult } from './configurationAnalysis';
import { analysisSlots } from './configurationAnalysisRunner';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function jobsOf(slots: ReturnType<typeof analysisSlots>, started: string[]) {
  const finish = new Map<string, () => void>();
  const job = (name: string) =>
    slots(
      () =>
        new Promise<AnalysisResult<AnalysisJob>>((resolve) => {
          started.push(name);
          finish.set(name, () => resolve({ name } as never));
        }),
    );
  return { job, finish: (name: string) => finish.get(name)!() };
}

describe('analysisSlots (review round 2 of PR #103, B)', () => {
  it('a slot handed on to a waiting job is still taken: a later job waits for it', async () => {
    const started: string[] = [];
    const { job, finish } = jobsOf(analysisSlots(1), started);
    const a = job('a');
    const b = job('b');
    await tick();
    expect(started).toEqual(['a']);
    finish('a');
    await a;
    await tick();
    expect(started).toEqual(['a', 'b']);
    // b holds the only slot: c waits.
    const c = job('c');
    await tick();
    expect(started).toEqual(['a', 'b']);
    finish('b');
    await b;
    await tick();
    expect(started).toEqual(['a', 'b', 'c']);
    finish('c');
    await c;
  });

  it('two sets of slots count apart', async () => {
    const started: string[] = [];
    const one = jobsOf(analysisSlots(1), started);
    const other = jobsOf(analysisSlots(1), started);
    const a = one.job('a');
    const b = other.job('b');
    await tick();
    expect(started).toEqual(['a', 'b']);
    one.finish('a');
    other.finish('b');
    await Promise.all([a, b]);
  });
});
