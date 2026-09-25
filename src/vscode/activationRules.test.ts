// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { PendingOperation } from '../core/types';
import {
  PENDING_OPERATION_MAX_AGE_MS,
  REOPEN_MIN_AGE_MS,
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
    ['the record is younger than 30 seconds (Close Remote Connection)', { record: { environmentId: 'e1', closedAt: iso(NOW - REOPEN_MIN_AGE_MS) } }],
    ['the record time is in the future', { record: { environmentId: 'e1', closedAt: iso(NOW + 60_000) } }],
    ['the record time is invalid', { record: { environmentId: 'e1', closedAt: 'yesterday' } }],
  ])('does not reopen when %s', (_name, overrides) => {
    const decision = decideReopen({ ...base, ...overrides });
    expect(decision.reopen).toBe(false);
    if (!decision.reopen) expect(decision.reason).not.toBe('');
  });

  it('reopens a record just older than 30 seconds', () => {
    expect(decideReopen({ ...base, record: { environmentId: 'e1', closedAt: iso(NOW - REOPEN_MIN_AGE_MS - 1) } }).reopen).toBe(true);
  });
});
