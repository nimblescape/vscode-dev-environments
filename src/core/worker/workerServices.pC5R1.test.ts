// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup C5 (plan step 11J, A11), review B: a probe of the narrowed port that the tests of the PR left
// open: `images` of the worker's Session Monitor waits for the images of the operation and passes on how they ended (a
// cancellation reaches the pipeline as an AbortError; nothing is left to reject unhandled).
import { describe, expect, it } from 'vitest';
import { abortError, silentLogger } from '../ports';
import { unusedEngine } from './dockerEngine.testkit';
import { workerSessionMonitor } from './workerServices';

describe("the worker's Session Monitor: images (review round 1 of cleanup C5, B)", () => {
  it('waits for the images of the operation and passes on their rejection', async () => {
    let finish!: () => void;
    let done = false;
    const pending = workerSessionMonitor(unusedEngine(), undefined, silentLogger, {
      images: () => new Promise<void>((resolve) => (finish = resolve)),
    })
      .images(undefined)
      .then(() => (done = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    finish();
    await pending;
    expect(done).toBe(true);
    const cancelled = workerSessionMonitor(unusedEngine(), undefined, silentLogger, { images: async () => Promise.reject(abortError()) });
    await expect(cancelled.images(new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
