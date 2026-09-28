// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The schedule of the image updates on a remote Docker host (user request 2026-09-28: "a setting that tells the monitor
// to fetch in a guided cron style manner"): a cron expression of five fields, minute hour day-of-month month
// day-of-week, in a time zone (that of the computer that created the monitor). Each field: `*`, a number, a range
// `a-b`, a step `*/n`, `a-b/n` or `a/n`, or a list of these with commas; months and weekdays also by their English
// three-letter names (JAN, MON); weekday 0 and 7 are Sunday. As in cron: when both the day of the month and the day of
// the week are restricted (not `*`), a day that matches either one counts. Used by the extension (the check of the
// setting) and by the monitor script (the next pass). Only Node.js built-ins; no `vscode`.

/** The default schedule: every day at 06:07 (user request 2026-09-28, "at 6:07 CEST"). */
export const DEFAULT_IMAGE_SCHEDULE = '7 6 * * *';
/** The time zone when the monitor gets none that it knows. */
export const DEFAULT_IMAGE_TIME_ZONE = 'Europe/Vienna';
/** The longest schedule text that is accepted. */
export const MAX_CRON_LENGTH = 200;

export interface CronSchedule {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 (Sunday) .. 6. */
  readonly weekdays: ReadonlySet<number>;
  /** The day of the month or the day of the week is `*` (then only the other one decides). */
  readonly anyDay: boolean;
  readonly anyWeekday: boolean;
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function parseField(text: string, min: number, max: number, names?: readonly string[], nameBase = 0): Set<number> | undefined {
  const value = (part: string): number | undefined => {
    if (/^\d{1,2}$/.test(part)) return Number(part);
    const index = names ? names.indexOf(part.toUpperCase()) : -1;
    return index >= 0 ? index + nameBase : undefined;
  };
  const result = new Set<number>();
  for (const item of text.split(',')) {
    const match = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(item);
    if (!match) return undefined;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (step < 1) return undefined;
    let from: number | undefined;
    let to: number | undefined;
    if (match[1] === '*') {
      from = min;
      to = max;
    } else {
      const range = /^([^-]+)-([^-]+)$/.exec(match[1]);
      from = value(range ? range[1] : match[1]);
      // `a/n` runs from a to the end, as in cron.
      to = range ? value(range[2]) : match[2] === undefined ? from : max;
    }
    if (from === undefined || to === undefined || from < min || to > max || from > to) return undefined;
    for (let n = from; n <= to; n += step) result.add(n);
  }
  return result;
}

/** The schedule of a cron expression of five fields, or undefined when it is not one. */
export function parseCronSchedule(text: string | undefined): CronSchedule | undefined {
  if (typeof text !== 'string' || text.length > MAX_CRON_LENGTH) return undefined;
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const days = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12, MONTH_NAMES, 1);
  const weekdaysRaw = parseField(fields[4], 0, 7, WEEKDAY_NAMES, 0);
  if (!minutes || !hours || !days || !months || !weekdaysRaw) return undefined;
  const weekdays = new Set([...weekdaysRaw].map((day) => day % 7));
  return { minutes, hours, days, months, weekdays, anyDay: fields[2].startsWith('*'), anyWeekday: fields[4].startsWith('*') };
}

/** True for a time zone that this Node.js knows (an IANA name such as Europe/Vienna). */
export function isTimeZone(value: string | undefined): value is string {
  if (!value || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of `time` in `timeZone`, as if it were UTC (ms). */
function wallClock(time: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(time))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/**
 * The moments at which the wall clock of `timeZone` shows `wall`, earliest first: one, or two in the hour that the change
 * to winter time repeats. Review round 2 of PR #57 (R1): a wall time that the change to summer time skips maps to the
 * moment one hour later on the wall clock (02:30 → 03:30), east and west of UTC alike; before, west of UTC it mapped to
 * an hour before the change.
 */
function fromWallClock(wall: number, timeZone: string): number[] {
  // The offsets of the zone half a day before and after (a change of the clock lies between them, if any).
  const offset = (time: number) => wallClock(time, timeZone) - time;
  const candidates = [...new Set([wall - offset(wall - DAY / 2), wall - offset(wall + DAY / 2)])].sort((a, b) => a - b);
  const valid = candidates.filter((time) => wallClock(time, timeZone) === wall);
  return valid.length > 0 ? valid : [Math.max(...candidates)];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A schedule without a match within this many days (for example 30 2 31 2 *) has no next pass. */
const SEARCH_DAYS = 5 * 366;

/**
 * The next moment after `now` whose wall clock in `timeZone` matches the schedule (daylight saving time included:
 * `7 6 * * *` in Europe/Vienna is 04:07 UTC in summer and 05:07 UTC in winter). Undefined when no day within five
 * years matches. Review round 2 of PR #57 (R2), as cron: in the hour that the change to winter time repeats, a schedule
 * with every hour (`*` in the hour field) matches both times, one with fixed hours only the first; a time that the change
 * to summer time skips runs one hour later on the wall clock.
 */
export function nextCronTime(now: number, schedule: CronSchedule, timeZone: string): number | undefined {
  const dayMatches = (wall: Date) => {
    const byDay = schedule.days.has(wall.getUTCDate());
    const byWeekday = schedule.weekdays.has(wall.getUTCDay());
    if (schedule.anyDay && schedule.anyWeekday) return true;
    if (schedule.anyDay) return byWeekday;
    if (schedule.anyWeekday) return byDay;
    return byDay || byWeekday;
  };
  const everyHour = schedule.hours.size === 24;
  // An hour earlier on the wall clock: the second time of a repeated hour lies after `now` although its wall time does not.
  let wall = Math.floor(wallClock(now, timeZone) / MINUTE) * MINUTE + MINUTE - HOUR;
  const end = wall + SEARCH_DAYS * DAY;
  // The earliest match; the walk goes on for two hours of wall time after the first, as a later wall time can be an
  // earlier moment around a change of the clock.
  let best: number | undefined;
  let bestUntil = end;
  while (wall < end && wall <= bestUntil) {
    const date = new Date(wall);
    if (!schedule.months.has(date.getUTCMonth() + 1)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    } else if (!dayMatches(date)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
    } else if (!schedule.hours.has(date.getUTCHours())) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1);
    } else if (!schedule.minutes.has(date.getUTCMinutes())) {
      wall += MINUTE;
    } else {
      const times = fromWallClock(wall, timeZone);
      for (const time of everyHour ? times : times.slice(0, 1)) {
        if (time <= now || (best !== undefined && time >= best)) continue;
        if (best === undefined) bestUntil = wall + 2 * HOUR;
        best = time;
      }
      wall += MINUTE;
    }
  }
  return best;
}
