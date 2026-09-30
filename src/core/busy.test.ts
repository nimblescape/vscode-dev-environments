// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  BUSY_MARK_MAX_AGE_MS,
  BUSY_OWNER_STATUS_MAX_AGE_MS,
  HEARTBEAT_MAX_AGE_MS,
  PENDING_MAX_AGE_MS,
  SLEEP_GAP_MS,
  isBlockingBusyMark,
  isBusyMarkLive,
  isStaleLiveWindowStatus,
  otherWindowMayUseEnvironment,
  otherWindowUsesEnvironment,
  sleepGraceOfWindow,
} from './busy';
import type { BusyMark, PendingConnection, WindowStatus } from './types';

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

describe('otherWindowUsesEnvironment (review round 3 of PR #68, A-R3-4)', () => {
  const ENV = 'env-1';
  const OWN = 'own-window';
  const window = (overrides: Partial<WindowStatus> = {}): WindowStatus => status({ windowId: 'w2', environmentId: ENV, ...overrides });
  const pending = (overrides: Partial<PendingConnection> = {}): PendingConnection => ({ environmentId: ENV, windowId: 'w2', createdAt: iso(NOW - 10_000), ...overrides });
  const uses = (windowStatuses?: WindowStatus[], pendings?: PendingConnection[]) => otherWindowUsesEnvironment(ENV, OWN, { now: NOW, isAlive, windowStatuses, pendings });

  it('finds a live, active, fresh window of another window ID that is connected to the environment', () => {
    expect(uses([window()])).toEqual({ window: window() });
    expect(uses([window({ updatedAt: iso(NOW - HEARTBEAT_MAX_AGE_MS) })])).toBeDefined();
  });

  it('ignores this window, another environment, a closing window, a stale or future file, and an ended process', () => {
    expect(uses([window({ windowId: OWN })])).toBeUndefined();
    expect(uses([window({ environmentId: 'env-2' })])).toBeUndefined();
    expect(uses([window({ environmentId: null })])).toBeUndefined();
    expect(uses([window({ state: 'closing' })])).toBeUndefined();
    expect(uses([window({ updatedAt: iso(NOW - HEARTBEAT_MAX_AGE_MS - 1) })])).toBeUndefined();
    expect(uses([window({ updatedAt: iso(NOW + HEARTBEAT_MAX_AGE_MS + 1) })])).toBeUndefined();
    expect(uses([window({ updatedAt: 'not a time' })])).toBeUndefined();
    expect(uses([window({ pid: DEAD })])).toBeUndefined();
    expect(uses(undefined, undefined)).toBeUndefined();
  });

  it('finds a fresh pending connection file of another window for the environment', () => {
    expect(uses([], [pending()])).toEqual({ pending: pending() });
    expect(uses([], [pending({ createdAt: iso(NOW - PENDING_MAX_AGE_MS) })])).toBeDefined();
    expect(uses([], [pending({ createdAt: iso(NOW - PENDING_MAX_AGE_MS - 1) })])).toBeUndefined();
    expect(uses([], [pending({ windowId: OWN })])).toBeUndefined();
    expect(uses([], [pending({ environmentId: 'env-2' })])).toBeUndefined();
  });

  it('shares the limits of the Session Monitor', () => {
    expect(HEARTBEAT_MAX_AGE_MS).toBe(60_000);
    expect(PENDING_MAX_AGE_MS).toBe(120_000);
  });
});

describe('review round 5 of PR #68 (risk 2): a live window whose status file is late', () => {
  const status = (ageMs: number, extra: Partial<WindowStatus> = {}): WindowStatus => ({
    windowId: 'window-b',
    pid: LIVE,
    environmentId: 'env-1',
    state: 'active',
    updatedAt: iso(NOW - ageMs),
    ...extra,
  });
  const input = (windowStatuses: WindowStatus[], grace = false, waitingMs = 30_000) => ({
    now: NOW,
    isAlive: (pid: number) => pid === LIVE,
    windowStatuses,
    waitingMs,
    grace,
  });

  it('counts a file that is no longer fresh, but not stale by the rule of the Session Monitor', () => {
    expect(otherWindowMayUseEnvironment('env-1', 'window-a', input([status(HEARTBEAT_MAX_AGE_MS + 1)]))?.windowId).toBe('window-b');
    expect(otherWindowMayUseEnvironment('env-1', 'window-a', input([status(HEARTBEAT_MAX_AGE_MS + 30_000)]))?.windowId).toBe('window-b');
  });

  it('does not count a fresh file (otherWindowUsesEnvironment counts it), a stale one, a dead process, another state, environment, or the own window', () => {
    expect(otherWindowMayUseEnvironment('env-1', 'window-a', input([status(HEARTBEAT_MAX_AGE_MS)]))).toBeUndefined();
    expect(otherWindowMayUseEnvironment('env-1', 'window-a', input([status(HEARTBEAT_MAX_AGE_MS + 30_001)]))).toBeUndefined();
    expect(otherWindowMayUseEnvironment('env-1', 'window-a', input([status(75_000, { pid: DEAD })]))).toBeUndefined();
    expect(otherWindowMayUseEnvironment('env-1', 'window-a', input([status(75_000, { state: 'closing' })]))).toBeUndefined();
    expect(otherWindowMayUseEnvironment('env-1', 'window-a', input([status(75_000, { environmentId: 'env-2' })]))).toBeUndefined();
    expect(otherWindowMayUseEnvironment('env-1', 'window-b', input([status(75_000)]))).toBeUndefined();
  });

  it('follows the waiting time, and counts any age during the sleep grace', () => {
    expect(otherWindowMayUseEnvironment('env-1', 'window-a', input([status(150_000)], false, 120_000))?.windowId).toBe('window-b');
    expect(otherWindowMayUseEnvironment('env-1', 'window-a', input([status(10 * 60_000)], true))?.windowId).toBe('window-b');
    expect(isStaleLiveWindowStatus(status(10 * 60_000), true, NOW, true, 30_000)).toBe(false);
    expect(isStaleLiveWindowStatus(status(10 * 60_000), false, NOW, false, 30_000)).toBe(false);
  });

  it('the sleep grace of a window: its own status file was not updated for SLEEP_GAP_MS', () => {
    const own = { windowId: 'window-a', pid: LIVE };
    expect(sleepGraceOfWindow([status(SLEEP_GAP_MS + 1, { windowId: 'window-a' })], own, NOW)).toBe(true);
    expect(sleepGraceOfWindow([status(SLEEP_GAP_MS, { windowId: 'window-a' })], own, NOW)).toBe(false);
    // Another process with the ID of the own window (an earlier activation), no own file, or no files at all: no grace.
    expect(sleepGraceOfWindow([status(SLEEP_GAP_MS + 1, { windowId: 'window-a', pid: DEAD })], own, NOW)).toBe(false);
    expect(sleepGraceOfWindow([status(SLEEP_GAP_MS + 1)], own, NOW)).toBe(false);
    expect(sleepGraceOfWindow(undefined, own, NOW)).toBe(false);
  });
});
