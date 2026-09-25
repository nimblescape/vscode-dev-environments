// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { BUSY_MARK_MAX_AGE_MS, BUSY_OWNER_STATUS_MAX_AGE_MS, isBlockingBusyMark, isBusyMarkLive } from './busy';
import type { BusyMark, WindowStatus } from './types';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const LIVE = 100;
const DEAD = 200;
const isAlive = (pid: number): boolean => pid === LIVE;

function mark(overrides: Partial<BusyMark> = {}): BusyMark {
  return { operation: 'rebuild', since: iso(NOW - 60_000), pid: LIVE, windowId: 'w1', ...overrides };
}

function status(overrides: Partial<WindowStatus> = {}): WindowStatus {
  return { windowId: 'w1', pid: LIVE, environmentId: null, state: 'active', updatedAt: iso(NOW - 10_000), ...overrides };
}

describe('isBusyMarkLive', () => {
  it('is live while the owner process exists and the mark is young', () => {
    expect(isBusyMarkLive(mark(), { now: NOW, isAlive })).toBe(true);
  });

  it('is not live when the owner process ended', () => {
    expect(isBusyMarkLive(mark({ pid: DEAD }), { now: NOW, isAlive })).toBe(false);
  });

  it('is not live when the mark is older than the maximum age (reused process ID)', () => {
    expect(isBusyMarkLive(mark({ since: iso(NOW - BUSY_MARK_MAX_AGE_MS - 1) }), { now: NOW, isAlive })).toBe(false);
    expect(isBusyMarkLive(mark({ since: iso(NOW - BUSY_MARK_MAX_AGE_MS) }), { now: NOW, isAlive })).toBe(true);
  });

  it('keeps a mark whose time cannot be parsed while the owner lives', () => {
    expect(isBusyMarkLive(mark({ since: 'not a time' }), { now: NOW, isAlive })).toBe(true);
  });

  describe('with window status files', () => {
    it('is live when the owner window has a recent status file of the same process', () => {
      expect(isBusyMarkLive(mark(), { now: NOW, isAlive, windowStatuses: [status()] })).toBe(true);
    });

    it('stays live while the owner window is closing (its process still runs)', () => {
      expect(isBusyMarkLive(mark(), { now: NOW, isAlive, windowStatuses: [status({ state: 'closing' })] })).toBe(true);
    });

    it('is not live without a status file of the owner window', () => {
      expect(isBusyMarkLive(mark(), { now: NOW, isAlive, windowStatuses: [status({ windowId: 'w2' })] })).toBe(false);
      expect(isBusyMarkLive(mark(), { now: NOW, isAlive, windowStatuses: [] })).toBe(false);
    });

    it('is not live when the status file of the owner window names another process', () => {
      expect(isBusyMarkLive(mark(), { now: NOW, isAlive, windowStatuses: [status({ pid: 300 })] })).toBe(false);
    });

    it('is not live when the status file of the owner window is old (process ID from before a restart)', () => {
      const old = status({ updatedAt: iso(NOW - BUSY_OWNER_STATUS_MAX_AGE_MS - 1) });
      expect(isBusyMarkLive(mark(), { now: NOW, isAlive, windowStatuses: [old] })).toBe(false);
      const recent = status({ updatedAt: iso(NOW - BUSY_OWNER_STATUS_MAX_AGE_MS) });
      expect(isBusyMarkLive(mark(), { now: NOW, isAlive, windowStatuses: [recent] })).toBe(true);
    });

    it('with ignoreOwnerStatusAge (sleep grace): needs the status file of the same process, but not a recent one', () => {
      const old = status({ updatedAt: iso(NOW - BUSY_OWNER_STATUS_MAX_AGE_MS - 60_000) });
      const input = { now: NOW, isAlive, ignoreOwnerStatusAge: true };
      expect(isBusyMarkLive(mark(), { ...input, windowStatuses: [old] })).toBe(true);
      expect(isBusyMarkLive(mark(), { ...input, windowStatuses: [status({ updatedAt: 'not a time' })] })).toBe(true);
      expect(isBusyMarkLive(mark(), { ...input, windowStatuses: [] })).toBe(false);
      expect(isBusyMarkLive(mark(), { ...input, windowStatuses: [status({ pid: 300 })] })).toBe(false);
      expect(isBusyMarkLive(mark({ pid: DEAD }), { ...input, windowStatuses: [status({ pid: DEAD })] })).toBe(false);
      expect(isBusyMarkLive(mark({ since: iso(NOW - BUSY_MARK_MAX_AGE_MS - 1) }), { ...input, windowStatuses: [old] })).toBe(false);
    });

    it('still needs a live process and a young mark', () => {
      expect(isBusyMarkLive(mark({ pid: DEAD }), { now: NOW, isAlive, windowStatuses: [status({ pid: DEAD })] })).toBe(false);
      const old = mark({ since: iso(NOW - BUSY_MARK_MAX_AGE_MS - 1) });
      expect(isBusyMarkLive(old, { now: NOW, isAlive, windowStatuses: [status()] })).toBe(false);
    });
  });
});

describe('isBlockingBusyMark', () => {
  const other = { windowId: 'w9', pid: 900 };

  it('blocks for a live mark of another window', () => {
    expect(isBlockingBusyMark(mark(), other, { now: NOW, isAlive })).toBe(true);
  });

  it('never blocks for a mark of the same process', () => {
    expect(isBlockingBusyMark(mark(), { windowId: 'w1', pid: LIVE }, { now: NOW, isAlive })).toBe(false);
    expect(isBlockingBusyMark(mark(), { windowId: 'earlier', pid: LIVE }, { now: NOW, isAlive })).toBe(false);
  });

  it('does not block for a mark that is not live', () => {
    expect(isBlockingBusyMark(mark({ pid: DEAD }), other, { now: NOW, isAlive })).toBe(false);
    expect(isBlockingBusyMark(mark(), other, { now: NOW, isAlive, windowStatuses: [] })).toBe(false);
  });
});
