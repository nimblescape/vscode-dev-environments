// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E6: what the worker's services of an open take from its operation: the image settings and list of the
// Session Monitor (decision D1 of 2026-10-05: `images`, given by the operation; without it, none), and the answer
// "lifecycle unknown" of the window's memory (review round 1 of PR #107, A-L2).
import { describe, expect, it, vi } from 'vitest';
import { LIFECYCLE_UNKNOWN } from '../pipeline/lifecycleMemory';
import { silentLogger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import { workerHostSide } from './workerHostSide';
import { workerSessionMonitor } from './workerServices';

const TARGET = { kind: 'local' as const, host: '', endpoint: '' };
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

describe("the worker's services of an open (plan step 11E6)", () => {
  it("the Session Monitor's images: those of the operation, with the signal of the pipeline; none without them", async () => {
    const images = vi.fn(async (_signal: AbortSignal | undefined) => {});
    const monitor = workerSessionMonitor(unusedEngine(), undefined, silentLogger, { images });
    const signal = new AbortController().signal;
    await monitor.images!(TARGET, signal);
    expect(images).toHaveBeenCalledWith(signal);
    expect(workerSessionMonitor(unusedEngine(), undefined, silentLogger).images).toBeUndefined();
  });

  it('the memory of the window: a container ID, or LIFECYCLE_UNKNOWN; anything else is refused', async () => {
    for (const [answer, expected] of [
      [null, undefined],
      ['a'.repeat(64), 'a'.repeat(64)],
      [LIFECYCLE_UNKNOWN, LIFECYCLE_UNKNOWN],
    ] as const) {
      expect(await workerHostSide(async () => answer, () => undefined).state.unrecordedLifecycle(ID)).toBe(expected);
    }
    for (const odd of ['UNKNOWN', 'unknown ', 'abc', 42]) {
      await expect(workerHostSide(async () => odd, () => undefined).state.unrecordedLifecycle(ID), String(odd)).rejects.toThrow('invalid value');
    }
  });
});
