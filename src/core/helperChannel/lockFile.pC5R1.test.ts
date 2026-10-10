// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup C5 (plan step 11J, B3), review B: probes of acquireFlock that the tests of the PR left open:
// the time limit ends a hung flock at `timeoutMs` (not later), its timer is cleared once flock ended, a timed-out flock is
// awaited before the file is closed and the outcome given, and a start error counts even with exit code 0.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireFlock, type FlockProcess } from './lockFile';
import { LOCK_BUSY_EXIT } from './protocol';

type Outcome = { exitCode: number | null; error?: string; stderr?: string };

/** A fake flock: ends with `outcome` (or hangs until killed; a kill ends it after `endDelayMs`). */
function fakeFlock(outcome: Outcome | 'hang', events: string[], endDelayMs = 0) {
  return (args: readonly string[]): FlockProcess => {
    events.push(`flock ${args.join(' ')}`);
    let finish!: (value: Outcome) => void;
    const exited = new Promise<Outcome>((resolve) => (finish = resolve));
    if (outcome !== 'hang') finish(outcome);
    return {
      exited,
      kill: (signal) => {
        events.push(`kill ${signal}`);
        const end = () => {
          events.push('ended');
          finish({ exitCode: null });
        };
        if (endDelayMs === 0) end();
        else setTimeout(end, endDelayMs);
      },
    };
  };
}

const how = (events: string[]) => ({ open: () => (events.push('open'), 42), close: (fd: number) => void events.push(`close ${fd}`) });

describe('acquireFlock (review round 1 of cleanup C5, B)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a hung flock ends at its time limit, not later', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let settled: unknown;
    void acquireFlock({ ...how(events), start: fakeFlock('hang', events), timeoutMs: 1_000 }).then((attempt) => (settled = attempt));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ kind: 'timeout' });
    expect(events).toEqual(['open', `flock -n -E ${LOCK_BUSY_EXIT} 3`, 'kill SIGKILL', 'ended', 'close 42']);
  });

  it('clears its timer when flock ends within the limit', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const attempt = await acquireFlock({ ...how(events), start: fakeFlock({ exitCode: LOCK_BUSY_EXIT }, events), timeoutMs: 10_000 });
    expect(attempt).toEqual({ kind: 'busy' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('awaits the end of a timed-out flock before it closes the file and gives the outcome', async () => {
    const events: string[] = [];
    const attempt = await acquireFlock({ ...how(events), start: fakeFlock('hang', events, 50), timeoutMs: 10 });
    expect(attempt).toEqual({ kind: 'timeout' });
    expect(events).toEqual(['open', `flock -n -E ${LOCK_BUSY_EXIT} 3`, 'kill SIGKILL', 'ended', 'close 42']);
  });

  it('a start error is `startFailed` (the file closed), whatever the exit code', async () => {
    const events: string[] = [];
    const attempt = await acquireFlock({ ...how(events), start: fakeFlock({ exitCode: 0, error: 'spawn flock ENOENT' }, events) });
    expect(attempt).toEqual({ kind: 'startFailed', detail: 'spawn flock ENOENT' });
    expect(events.at(-1)).toBe('close 42');
  });
});
