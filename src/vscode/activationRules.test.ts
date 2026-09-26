// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { PendingOperation } from '../core/types';
import {
  PENDING_OPERATION_MAX_AGE_MS,
  REOPEN_MIN_AGE_MS,
  REOPEN_TOO_RECENT_REASON,
  decideReopen,
  pipelineJustRan,
  sortPendingOperations,
  type ReopenInput,
} from './activationRules';

const NOW = Date.parse('2026-09-25T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('pipelineJustRan', () => {
  it('is true for a pending connection file of this environment younger than 2 minutes', () => {
    const pending = { environmentId: 'e1', windowId: 'w0', createdAt: iso(NOW - 5_000) };
    expect(pipelineJustRan(pending, 'e1', NOW)).toBe(true);
    expect(pipelineJustRan({ ...pending, createdAt: iso(NOW - 120_000) }, 'e1', NOW)).toBe(true);
  });

  it('is false without a file, for another environment, for an old file, or an invalid time', () => {
    expect(pipelineJustRan(undefined, 'e1', NOW)).toBe(false);
    expect(pipelineJustRan({ environmentId: 'e2', windowId: 'w0', createdAt: iso(NOW) }, 'e1', NOW)).toBe(false);
    expect(pipelineJustRan({ environmentId: 'e1', windowId: 'w0', createdAt: iso(NOW - 120_001) }, 'e1', NOW)).toBe(false);
    expect(pipelineJustRan({ environmentId: 'e1', windowId: 'w0', createdAt: 'later' }, 'e1', NOW)).toBe(false);
  });
});

describe('sortPendingOperations', () => {
  const operation = (environmentId: string, requestedAt: string): PendingOperation => ({
    environmentId,
    operation: 'rebuild',
    requestedAt,
    requestedBy: 'w1',
    reason: 'manual',
  });

  it('runs the oldest first and separates stale operations', () => {
    const result = sortPendingOperations(
      [
        operation('b', iso(NOW - 1_000)),
        operation('old', iso(NOW - PENDING_OPERATION_MAX_AGE_MS - 1)),
        operation('a', iso(NOW - 60_000)),
        operation('c', iso(NOW - 1_000)),
        operation('future', iso(NOW + PENDING_OPERATION_MAX_AGE_MS + 1)),
        operation('invalid', 'not a time'),
      ],
      NOW,
    );
    expect(result.runnable.map((entry) => entry.environmentId)).toEqual(['a', 'b', 'c']);
    expect(result.stale.map((entry) => entry.environmentId)).toEqual(['old', 'future', 'invalid']);
  });

  it('keeps an operation of exactly the maximum age', () => {
    const result = sortPendingOperations([operation('a', iso(NOW - PENDING_OPERATION_MAX_AGE_MS))], NOW);
    expect(result.runnable).toHaveLength(1);
  });
});

describe('decideReopen', () => {
  const base: ReopenInput = {
    settings: { reopenLastOnStartup: true },
    emptyWindow: true,
    otherActiveWindows: 0,
    pendingOperations: 0,
    record: { environmentId: 'e1', closedAt: iso(NOW - 10 * 60_000) },
    environmentIds: new Set(['e1']),
    now: NOW,
  };

  it('reopens the last environment when all conditions of concept 7.10 hold', () => {
    expect(decideReopen(base)).toEqual({ reopen: true, environmentId: 'e1' });
  });

  it.each<[string, Partial<ReopenInput>]>([
    ['the setting is off', { settings: { reopenLastOnStartup: false } }],
    ['the window is not empty', { emptyWindow: false }],
    ['another window is alive', { otherActiveWindows: 1 }],
    ['an operation is pending', { pendingOperations: 1 }],
    ['no reopen record exists', { record: undefined }],
    ['the environment was deleted', { environmentIds: new Set(['e2']) }],
    // The guard is 5 seconds since the user decision 2026-09-26, "go with the proposal for closing" (it was 30 seconds).
    ['the record is not older than 5 seconds (Close Remote Connection)', { record: { environmentId: 'e1', closedAt: iso(NOW - REOPEN_MIN_AGE_MS) } }],
    ['the record time is in the future', { record: { environmentId: 'e1', closedAt: iso(NOW + 60_000) } }],
    ['the record time is invalid', { record: { environmentId: 'e1', closedAt: 'yesterday' } }],
  ])('does not reopen when %s', (_name, overrides) => {
    const decision = decideReopen({ ...base, ...overrides });
    expect(decision.reopen).toBe(false);
    if (!decision.reopen) expect(decision.reason).not.toBe('');
  });

  // User decision 2026-09-26, "go with the proposal for closing": the guard is 5 seconds, not 30. The log showed a real
  // reopen from the macOS Dock that the 30-second rule blocked; Close Remote Connection brings up the empty window within
  // 1 to 3 seconds, which the guard still covers.
  it('reopens a record just older than 5 seconds', () => {
    expect(REOPEN_MIN_AGE_MS).toBe(5_000);
    expect(decideReopen({ ...base, record: { environmentId: 'e1', closedAt: iso(NOW - REOPEN_MIN_AGE_MS - 1) } }).reopen).toBe(true);
  });

  it('guards 5 seconds: no reopen after 1, 3, and 4 seconds, a reopen after 6 seconds and after 30 seconds', () => {
    const after = (ms: number) => decideReopen({ ...base, record: { environmentId: 'e1', closedAt: iso(NOW - ms) } });
    for (const ms of [1_000, 3_000, 4_000, 5_000]) {
      expect(after(ms)).toEqual({ reopen: false, reason: REOPEN_TOO_RECENT_REASON });
    }
    expect(after(6_000)).toEqual({ reopen: true, environmentId: 'e1' });
    // A reopen from the macOS Dock 10 to 30 seconds after the quit, which the 30-second rule blocked.
    expect(after(10_000)).toEqual({ reopen: true, environmentId: 'e1' });
    expect(after(30_000)).toEqual({ reopen: true, environmentId: 'e1' });
  });

  it('derives the reason text from the constant', () => {
    expect(REOPEN_TOO_RECENT_REASON).toBe('the last environment was closed less than 5 seconds ago');
    expect(REOPEN_TOO_RECENT_REASON).not.toContain('30');
  });

  describe('in an Extension Development Host (a debug run)', () => {
    const development: ReopenInput = { ...base, development: true };

    it('reopens right after the previous debug run closed the window', () => {
      expect(decideReopen({ ...development, record: { environmentId: 'e1', closedAt: iso(NOW - 5_000) } })).toEqual({ reopen: true, environmentId: 'e1' });
    });

    it('reopens while the window with the source code is open (a window without an environment)', () => {
      expect(decideReopen({ ...development, otherActiveWindows: 1, otherConnectedWindows: 0 })).toEqual({ reopen: true, environmentId: 'e1' });
    });

    it('does not reopen while another window is connected to an environment', () => {
      expect(decideReopen({ ...development, otherActiveWindows: 2, otherConnectedWindows: 1 }).reopen).toBe(false);
    });

    it('counts all other windows when it does not know which are connected', () => {
      expect(decideReopen({ ...development, otherActiveWindows: 1 }).reopen).toBe(false);
    });

    it.each<[string, Partial<ReopenInput>]>([
      ['the setting is off', { settings: { reopenLastOnStartup: false } }],
      ['the window is not empty', { emptyWindow: false }],
      ['an operation is pending', { pendingOperations: 1 }],
      ['no reopen record exists', { record: undefined }],
      ['the environment was deleted', { environmentIds: new Set(['e2']) }],
      ['the record time is invalid', { record: { environmentId: 'e1', closedAt: 'yesterday' } }],
      ['the record time is in the future', { record: { environmentId: 'e1', closedAt: iso(NOW + 60_000) } }],
    ])('still does not reopen when %s', (_name, overrides) => {
      expect(decideReopen({ ...development, ...overrides }).reopen).toBe(false);
    });
  });
});
