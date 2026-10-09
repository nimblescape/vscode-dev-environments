// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, D1 and D2, and the user's decision "unless-stopped"): the setting
// cacheUpdateSchedule, the mode of the monitor and its restart policy, and when a background run is due.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_UPDATE_SCHEDULE,
  MAX_CACHE_INTERVAL_MINUTES,
  cacheRunDue,
  monitorRestartPolicy,
  monitorRunsPermanently,
  normalizeCacheSchedule,
  parseCacheSchedule,
} from './cacheSettings';

const MINUTE = 60_000;

describe('cacheUpdateSchedule (plan step 11H2, D2)', () => {
  it('takes whole minutes from 5 on as an interval, as a number or its digits', () => {
    expect(parseCacheSchedule('17')).toEqual({ kind: 'interval', minutes: 17, text: '17' });
    expect(parseCacheSchedule(5)).toEqual({ kind: 'interval', minutes: 5, text: '5' });
    expect(parseCacheSchedule(' 0060 ')).toEqual({ kind: 'interval', minutes: 60, text: '60' });
    expect(parseCacheSchedule(String(MAX_CACHE_INTERVAL_MINUTES))).toMatchObject({ kind: 'interval', minutes: MAX_CACHE_INTERVAL_MINUTES });
  });

  it('refuses fewer than 5 minutes, more than a year, fractions and signs', () => {
    for (const value of ['4', 4, '0', 0, '-5', -5, '5.0', 5.5, '+5', String(MAX_CACHE_INTERVAL_MINUTES + 1), '1e3', '12345678']) {
      expect(parseCacheSchedule(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('takes five cron fields as a cron schedule, its text with single spaces', () => {
    const parsed = parseCacheSchedule('  7  6 * *   1-5 ');
    expect(parsed?.kind).toBe('cron');
    expect(parsed?.text).toBe('7 6 * * 1-5');
    expect(parsed?.kind === 'cron' ? parsed.cron.weekdays : undefined).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('refuses junk: other text, four or six fields, an invalid field, other types', () => {
    for (const value of ['', ' ', 'soon', '17 minutes', '7 6 * *', '7 6 * * * *', '61 6 * * *', '05:30', null, undefined, true, ['17'], { minutes: 17 }]) {
      expect(parseCacheSchedule(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('normalizes to the text of the schedule, and anything else to the default of 17 minutes', () => {
    expect(DEFAULT_CACHE_UPDATE_SCHEDULE).toBe('17');
    expect(normalizeCacheSchedule('30')).toBe('30');
    expect(normalizeCacheSchedule('7  6 * * *')).toBe('7 6 * * *');
    expect(normalizeCacheSchedule('3')).toBe('17');
    expect(normalizeCacheSchedule('junk')).toBe('17');
    expect(normalizeCacheSchedule(undefined)).toBe('17');
  });
});

describe('the mode of the monitor (plan step 11H2, D1 and "unless-stopped")', () => {
  it('runs permanently on a remote engine always, on a local one only with stopLocalMonitorWhenIdle off', () => {
    expect(monitorRunsPermanently(true, true)).toBe(true);
    expect(monitorRunsPermanently(true, false)).toBe(true);
    expect(monitorRunsPermanently(true, undefined)).toBe(true);
    expect(monitorRunsPermanently(false, true)).toBe(false);
    expect(monitorRunsPermanently(false, undefined)).toBe(false);
    expect(monitorRunsPermanently(false, false)).toBe(true);
  });

  it('a permanent monitor has unless-stopped, one that ends when idle on-failure', () => {
    expect(monitorRestartPolicy(true)).toBe('unless-stopped');
    expect(monitorRestartPolicy(false)).toBe('on-failure');
  });
});

describe('when a background run is due (plan step 11H2, D2)', () => {
  const T = Date.parse('2026-10-09T10:00:00Z');
  const interval = parseCacheSchedule('17')!;

  it('is due when no run is known', () => {
    expect(cacheRunDue(interval, undefined, T, 'UTC')).toBe(true);
    expect(cacheRunDue(parseCacheSchedule('7 6 * * *')!, undefined, T, 'UTC')).toBe(true);
  });

  it('with an interval: the interval after the end of the previous run, not before', () => {
    expect(cacheRunDue(interval, T, T + 17 * MINUTE - 1, 'UTC')).toBe(false);
    expect(cacheRunDue(interval, T, T + 17 * MINUTE, 'UTC')).toBe(true);
    // A monitor that starts after a longer pause: its last run is older than the interval.
    expect(cacheRunDue(interval, T - 3 * 60 * MINUTE, T, 'UTC')).toBe(true);
  });

  it('with a cron schedule: when a time of it came after the end of the last run', () => {
    const daily = parseCacheSchedule('7 6 * * *')!;
    const end = Date.parse('2026-10-09T06:10:00Z');
    expect(cacheRunDue(daily, end, Date.parse('2026-10-10T06:06:59Z'), 'UTC')).toBe(false);
    expect(cacheRunDue(daily, end, Date.parse('2026-10-10T06:07:00Z'), 'UTC')).toBe(true);
    // A monitor that starts: one time passed since its last run (several passed: still one run).
    expect(cacheRunDue(daily, end, Date.parse('2026-10-14T12:00:00Z'), 'UTC')).toBe(true);
    // A run that ended after the time of today: not again today.
    expect(cacheRunDue(daily, Date.parse('2026-10-09T06:07:30Z'), Date.parse('2026-10-09T23:00:00Z'), 'UTC')).toBe(false);
  });
});
