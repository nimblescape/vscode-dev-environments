// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup after plan step 11 (PR #138, B4): withTimeLimit, the one time-limited call (EngineDocker's calls, the engine of
// the Session Monitor's ensure, the stops of Stop).
import { describe, expect, it } from 'vitest';
import { abortError, withTimeLimit } from './ports';

/** A call that answers only its signal: it rejects with an AbortError when that aborts. */
const hanging = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError())));
const late = () => new Error('late');

describe('withTimeLimit (PR #138, B4)', () => {
  it('gives the answer of the call, which gets a signal that has not aborted', async () => {
    let seen: AbortSignal | undefined;
    expect(await withTimeLimit(1000, undefined, async (signal) => ((seen = signal), 'answer'), late)).toBe('answer');
    expect(seen?.aborted).toBe(false);
  });

  it('past the limit: the error of `timedOut`, and the call got the limit as its signal', async () => {
    let seen: AbortSignal | undefined;
    await expect(withTimeLimit(20, undefined, (signal) => ((seen = signal), hanging(signal)), late)).rejects.toThrow('late');
    expect(seen?.aborted).toBe(true);
    // Also with a signal of the caller that did not abort; and whatever the call rejected with after the limit.
    await expect(withTimeLimit(20, new AbortController().signal, hanging, late)).rejects.toThrow('late');
    await expect(withTimeLimit(20, undefined, (signal) => hanging(signal).catch(() => Promise.reject(new Error('socket closed'))), late)).rejects.toThrow('late');
  });

  it('a cancel of the caller passes as its error, also when the limit ran out meanwhile', async () => {
    const controller = new AbortController();
    const cancelled = withTimeLimit(60_000, controller.signal, hanging, late);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const both = new AbortController();
    const after = withTimeLimit(
      1,
      both.signal,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        both.abort();
        throw abortError();
      },
      late,
    );
    await expect(after).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('any other failure within the limit passes unchanged', async () => {
    const failure = new Error('connect ENOENT');
    await expect(withTimeLimit(60_000, undefined, async () => Promise.reject(failure), late)).rejects.toBe(failure);
  });
});
