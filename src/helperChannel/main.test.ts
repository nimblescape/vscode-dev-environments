// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_CLEANUP_TIMEOUT_MS, CHANNEL_KILL_GRACE_MS } from '../core/helperChannel/protocol';
import { fatalHandler, timesFromEnv } from './main';

describe('the entry of the channel script', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an uncaught error shuts the channel down (cancel and cleanup), and ends the process later in any case (review round 1, P5)', async () => {
    const exits: number[] = [];
    const shutdown = vi.fn();
    fatalHandler({ shutdown }, (code) => exits.push(code))();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(CHANNEL_KILL_GRACE_MS + CHANNEL_CLEANUP_TIMEOUT_MS + 10_000);
    expect(exits).toEqual([1]);
  });

  it('ends the process at once when the shutdown itself fails', () => {
    const exits: number[] = [];
    fatalHandler(
      {
        shutdown: () => {
          throw new Error('broken');
        },
      },
      (code) => exits.push(code),
    )();
    expect(exits).toEqual([1]);
  });

  it('takes the shorter times of the Docker tests only in their range', () => {
    expect(timesFromEnv({ DEVENV_CHANNEL_SILENCE_MS: '3000' })).toEqual({ silenceMs: 3000, idleMs: 6000 });
    expect(timesFromEnv({ DEVENV_CHANNEL_SILENCE_MS: '100' })).toEqual({});
    expect(timesFromEnv({ DEVENV_CHANNEL_SILENCE_MS: '99999' })).toEqual({});
    expect(timesFromEnv({})).toEqual({});
  });
});
