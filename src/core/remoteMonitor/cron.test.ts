// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// User request 2026-09-28: "a setting that tells the monitor to fetch in a guided cron style manner".
import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_SCHEDULE, isTimeZone, nextCronTime, parseCronSchedule, usableTimeZone, type CronSchedule } from './cron';

const at = (iso: string) => Date.parse(iso);
const next = (iso: string, text: string, timeZone = 'Europe/Vienna') => {
  const time = nextCronTime(at(iso), parseCronSchedule(text)!, timeZone);
  return time === undefined ? undefined : new Date(time).toISOString();
};
const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b);

describe('the cron schedule of the image updates', () => {
  it('reads the five fields: *, numbers, ranges, steps, lists, names; weekday 7 is Sunday', () => {
    const schedule = parseCronSchedule('0,30 */6 1-10/3 jan,JUL-SEP mon-fri,7')!;
    expect(sorted(schedule.minutes)).toEqual([0, 30]);
    expect(sorted(schedule.hours)).toEqual([0, 6, 12, 18]);
    expect(sorted(schedule.days)).toEqual([1, 4, 7, 10]);
    expect(sorted(schedule.months)).toEqual([1, 7, 8, 9]);
    expect(sorted(schedule.weekdays)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(schedule.anyDay).toBe(false);
    expect(sorted(parseCronSchedule('5/20 * * * *')!.minutes)).toEqual([5, 25, 45]);
    expect(parseCronSchedule(`  ${DEFAULT_IMAGE_SCHEDULE}  `)).toMatchObject<Partial<CronSchedule>>({ anyDay: true, anyWeekday: true });
  });

  it('refuses anything else', () => {
    for (const text of [
      '',
      '7 6 * *',
      '7 6 * * * *',
      '60 6 * * *',
      '7 24 * * *',
      '7 6 0 * *',
      '7 6 * 13 *',
      '7 6 * * 8',
      '7 6 * * 5-2',
      '*/0 6 * * *',
      '7 6 * * MONDAY',
      '@daily',
      '7;6 * * * *',
      `${'1,'.repeat(100)}1 * * * *`,
      undefined,
    ]) {
      expect(parseCronSchedule(text), String(text)).toBeUndefined();
    }
  });

  // Moved from src/remoteMonitor/images.test.ts with the same expectations (user request 2026-09-28, "at 6:07 CEST"):
  // the daily time became the default cron schedule.
  it('finds the next 06:07 in Europe/Vienna: 04:07 UTC in summer, 05:07 UTC in winter, the next day after it', () => {
    expect(next('2026-09-28T20:00:00Z', '7 6 * * *')).toBe('2026-09-29T04:07:00.000Z');
    expect(next('2026-09-29T03:00:00Z', '7 6 * * *')).toBe('2026-09-29T04:07:00.000Z');
    expect(next('2026-12-01T12:00:00Z', '7 6 * * *')).toBe('2026-12-02T05:07:00.000Z');
    // The night of the change to winter time (25 October 2026): 06:07 is already CET.
    expect(next('2026-10-24T12:00:00Z', '7 6 * * *')).toBe('2026-10-25T05:07:00.000Z');
    expect(next('2026-09-28T20:00:00Z', '7 6 * * *', 'UTC')).toBe('2026-09-29T06:07:00.000Z');
    // Exactly at a pass: the next one, a day later.
    expect(next('2026-09-29T04:07:00Z', '7 6 * * *')).toBe('2026-09-30T04:07:00.000Z');
  });

  it('follows weekdays, days of the month, months, steps', () => {
    // 2026-10-02 is a Friday: Monday to Friday at 05:30 → Friday, then Monday.
    expect(next('2026-10-01T12:00:00Z', '30 5 * * 1-5', 'UTC')).toBe('2026-10-02T05:30:00.000Z');
    expect(next('2026-10-02T06:00:00Z', '30 5 * * 1-5', 'UTC')).toBe('2026-10-05T05:30:00.000Z');
    expect(next('2026-10-02T06:00:00Z', '0 */4 * * *', 'UTC')).toBe('2026-10-02T08:00:00.000Z');
    expect(next('2026-10-02T06:00:00Z', '0 3 1 * *', 'UTC')).toBe('2026-11-01T03:00:00.000Z');
    expect(next('2026-10-02T06:00:00Z', '0 3 1 jan *', 'UTC')).toBe('2027-01-01T03:00:00.000Z');
    // Both restricted: either day counts (the 15th, or a Sunday: 2026-10-04).
    expect(next('2026-10-02T06:00:00Z', '0 3 15 * sun', 'UTC')).toBe('2026-10-04T03:00:00.000Z');
    // February 29: the next leap year.
    expect(next('2026-10-02T06:00:00Z', '0 3 29 2 *', 'UTC')).toBe('2028-02-29T03:00:00.000Z');
    // Never (February 31).
    expect(next('2026-10-02T06:00:00Z', '0 3 31 2 *', 'UTC')).toBeUndefined();
  });

  it('a time that the change to summer time skips runs once, right after the change', () => {
    // 29 March 2026 in Europe/Vienna: 02:00 CET becomes 03:00 CEST (01:00 UTC); 02:30 does not exist.
    const time = next('2026-03-28T12:00:00Z', '30 2 * * *');
    expect(time).toBeDefined();
    expect(Date.parse(time!)).toBeGreaterThanOrEqual(at('2026-03-29T01:00:00Z'));
    expect(Date.parse(time!)).toBeLessThan(at('2026-03-29T02:00:00Z'));
    // And the day after, 02:30 CEST again.
    expect(next(time!, '30 2 * * *')).toBe('2026-03-30T00:30:00.000Z');
  });

  it('a time that the change to winter time repeats runs once', () => {
    // 25 October 2026 in Europe/Vienna: 03:00 CEST becomes 02:00 CET (01:00 UTC); 02:30 comes twice.
    const first = next('2026-10-24T12:00:00Z', '30 2 * * *')!;
    expect([at('2026-10-25T00:30:00Z'), at('2026-10-25T01:30:00Z')]).toContain(Date.parse(first));
    expect(next(first, '30 2 * * *')).toBe('2026-10-26T01:30:00.000Z');
  });

  // Review round 2 of PR #57 (R1): west of UTC, a skipped time mapped to an hour before the change.
  it('a skipped time runs one hour later on the wall clock, also west of UTC', () => {
    // 8 March 2026 in America/New_York: 02:00 EST becomes 03:00 EDT (07:00 UTC); 02:30 → 03:30 EDT.
    expect(next('2026-03-08T05:00:00Z', '30 2 * * *', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
    expect(next('2026-03-28T12:00:00Z', '30 2 * * *')).toBe('2026-03-29T01:30:00.000Z');
  });

  // Review round 2 of PR #57 (R2): with every hour, both times of the repeated hour run (as cron); with a fixed hour, the
  // first only.
  it('in the repeated hour, a schedule of every hour runs both times; one of a fixed hour once', () => {
    const walk = (from: string, text: string, timeZone: string, count: number) => {
      const times: string[] = [];
      let at = from;
      for (let index = 0; index < count; index++) times.push((at = next(at, text, timeZone)!));
      return times;
    };
    expect(walk('2026-10-24T23:30:00Z', '0 * * * *', 'Europe/Vienna', 4)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
    ]);
    expect(walk('2026-11-01T04:30:00Z', '0 * * * *', 'America/New_York', 3)).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
    ]);
    // Every half hour: in time order, not in the order of the wall clock.
    expect(walk('2026-10-24T23:50:00Z', '0,30 * * * *', 'Europe/Vienna', 4)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T01:30:00.000Z',
    ]);
    expect(walk('2026-10-24T12:00:00Z', '30 2 * * *', 'Europe/Vienna', 2)).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
    expect(walk('2026-10-31T12:00:00Z', '30 1 * * *', 'America/New_York', 2)).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  });

  // Review round 3 of PR #57 (N2), as Vixie cron: a step in a day field that starts with `*` counts.
  it('honours a step in the day of the month or the day of the week', () => {
    const days = (text: string, count: number) => {
      const times: string[] = [];
      let at = '2026-09-01T07:00:00Z';
      for (let index = 0; index < count; index++) times.push((at = next(at, text, 'UTC')!).slice(0, 10));
      return times;
    };
    expect(days('0 6 */2 * *', 3)).toEqual(['2026-09-03', '2026-09-05', '2026-09-07']);
    // 2026-09-02 is a Wednesday: Sunday, Wednesday and Saturday.
    expect(days('0 6 * * */3', 4)).toEqual(['2026-09-02', '2026-09-05', '2026-09-06', '2026-09-09']);
    // Both: Mondays on odd days (2026-09-07 and 2026-09-21).
    expect(days('0 6 */2 * 1', 2)).toEqual(['2026-09-07', '2026-09-21']);
    // Two restricted fields: either one.
    expect(days('0 6 15 * 1', 3)).toEqual(['2026-09-07', '2026-09-14', '2026-09-15']);
  });

  // Review round 3 of PR #57 (N3, N4): zones more than 12 hours ahead of UTC, and a change of two hours.
  it('handles the changes of the clock of Pacific/Auckland and Antarctica/Troll', () => {
    // 27 September 2026 in Auckland: 02:00 NZST becomes 03:00 NZDT (14:00 UTC the day before); 02:30 → 03:30 NZDT.
    expect(next('2026-09-26T00:00:00Z', '30 2 * * *', 'Pacific/Auckland')).toBe('2026-09-26T14:30:00.000Z');
    // 5 April 2026: 03:00 NZDT becomes 02:00 NZST (14:00 UTC the day before); a fixed hour runs at the first 02:30.
    expect(next('2026-04-04T00:00:00Z', '30 2 * * *', 'Pacific/Auckland')).toBe('2026-04-04T13:30:00.000Z');
    const walk = (from: string, text: string, timeZone: string, count: number) => {
      const times: string[] = [];
      let at = from;
      for (let index = 0; index < count; index++) times.push((at = next(at, text, timeZone)!));
      return times;
    };
    expect(walk('2026-04-04T12:00:00Z', '30 * * * *', 'Pacific/Auckland', 3)).toEqual([
      '2026-04-04T12:30:00.000Z',
      '2026-04-04T13:30:00.000Z',
      '2026-04-04T14:30:00.000Z',
    ]);
    // 25 October 2026 in Troll: +02 becomes +00 at 01:00 UTC; wall 01:00-03:00 comes twice.
    expect(walk('2026-10-24T23:10:00Z', '30 * * * *', 'Antarctica/Troll', 5)).toEqual([
      '2026-10-24T23:30:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T02:30:00.000Z',
      '2026-10-25T03:30:00.000Z',
    ]);
    expect(next('2026-10-25T00:40:00Z', '30 * * * *', 'Antarctica/Troll')).toBe('2026-10-25T01:30:00.000Z');
  });

  // Review round 5 of PR #57 (P2): Node.js names an unknown zone (an empty TZ) `Etc/Unknown`.
  it('takes UTC for a time zone that Node.js does not know', () => {
    expect(usableTimeZone('Europe/Vienna')).toBe('Europe/Vienna');
    expect(usableTimeZone('Etc/Unknown')).toBe('UTC');
    expect(usableTimeZone(undefined)).toBe('UTC');
  });

  // Moved from src/remoteMonitor/images.test.ts with the same expectations.
  it('reads a time zone strictly', () => {
    expect(isTimeZone('Europe/Vienna')).toBe(true);
    expect(isTimeZone('Mars/Base')).toBe(false);
    expect(isTimeZone('Europe/Vienna; rm -rf /')).toBe(false);
  });
});
