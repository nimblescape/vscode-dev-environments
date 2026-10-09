// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, "11H: the shared VS Code server and the Session Monitor's daily run", D1 and
// D2, and the user's decision "unless-stopped" of the same day): the rules of the Session Monitor's background run that
// the extension, the worker and the monitor share: the setting devEnvLauncher.cacheUpdateSchedule (a cron schedule of
// five fields or an interval in minutes, which replaces imageUpdateSchedule; no migration before the release), when a run
// is due, and whether the monitor of an engine runs permanently (its restart policy). Pure functions; no I/O, no `vscode`.
import { nextCronTime, parseCronSchedule, type CronSchedule } from './cron';

/** Plan step 11H2 (D2): the default of devEnvLauncher.cacheUpdateSchedule: every 17 minutes. */
export const DEFAULT_CACHE_UPDATE_SCHEDULE = '17';
/** Plan step 11H2 (D2): the shortest interval in minutes (the brief: a whole number, at least 5). */
export const MIN_CACHE_INTERVAL_MINUTES = 5;
/** Plan step 11H2: the longest interval in minutes (a year; a longer number is no valid setting). */
export const MAX_CACHE_INTERVAL_MINUTES = 525_600;

/** Plan step 11H2 (D2): the schedule of the background run: an interval in minutes, or a cron schedule. */
export type CacheSchedule = { kind: 'interval'; minutes: number; text: string } | { kind: 'cron'; cron: CronSchedule; text: string };

/**
 * Plan step 11H2 (D2): the setting devEnvLauncher.cacheUpdateSchedule: a whole number of minutes from
 * MIN_CACHE_INTERVAL_MINUTES to MAX_CACHE_INTERVAL_MINUTES (a JSON number or its digits, spaces around it allowed) is an
 * interval, five fields that parseCronSchedule takes are a cron schedule (its text with single spaces); `undefined` for
 * anything else (fewer minutes, a fraction, other text, another type).
 */
export function parseCacheSchedule(value: unknown): CacheSchedule | undefined {
  const text = typeof value === 'number' ? (Number.isInteger(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : '';
  if (/^\d{1,7}$/.test(text)) {
    const minutes = Number(text);
    if (minutes < MIN_CACHE_INTERVAL_MINUTES || minutes > MAX_CACHE_INTERVAL_MINUTES) return undefined;
    return { kind: 'interval', minutes, text: String(minutes) };
  }
  const cron = parseCronSchedule(text);
  return cron === undefined ? undefined : { kind: 'cron', cron, text: text.split(/\s+/).join(' ') };
}

/** Plan step 11H2 (D2): the setting as the monitor gets it: the text of parseCacheSchedule, or the default. */
export function normalizeCacheSchedule(value: unknown): string {
  return parseCacheSchedule(value)?.text ?? DEFAULT_CACHE_UPDATE_SCHEDULE;
}

/**
 * Plan step 11H2 (D1): whether the Session Monitor of an engine runs permanently: on a remote engine (`ssh://`,
 * classifyDockerEndpoint) always; on a local engine only when the setting devEnvLauncher.stopLocalMonitorWhenIdle is
 * false (its default is true: the local monitor ends after 5 minutes without a running environment, as before).
 */
export function monitorRunsPermanently(remote: boolean, stopLocalMonitorWhenIdle: boolean | undefined): boolean {
  return remote || stopLocalMonitorWhenIdle === false;
}

/**
 * Plan step 8, PR B (Q5): the restart policy of a monitor that ends when idle: Docker restarts it after a failure only,
 * so an exit with 0 when idle leaves it exited.
 */
export const IDLE_MONITOR_RESTART_POLICY = 'on-failure';
/**
 * Plan step 11H2 (the user's decision "unless-stopped" of 2026-10-09): the restart policy of a permanent monitor: Docker
 * starts it again after a crash and after a restart of the engine.
 */
export const PERMANENT_MONITOR_RESTART_POLICY = 'unless-stopped';

/** Plan step 11H2: the restart policy of a monitor by its mode (monitorRunsPermanently). */
export function monitorRestartPolicy(permanent: boolean): typeof IDLE_MONITOR_RESTART_POLICY | typeof PERMANENT_MONITOR_RESTART_POLICY {
  return permanent ? PERMANENT_MONITOR_RESTART_POLICY : IDLE_MONITOR_RESTART_POLICY;
}

/**
 * Plan step 11H2 (D2): whether the background run is due at `now`, after the last run that ended at `lastEndAt`
 * (undefined: no run is known, so it is due). With an interval: when `now` is at least the interval after that end (so
 * the runs follow each other at that distance from the end of the previous one, and a monitor that starts runs at once
 * when its last run is older than the interval). With a cron schedule: when a time of the schedule (in `timeZone`) came
 * after that end and not after `now` (a monitor that starts runs once when a time passed since its last run; the times
 * during a run are left out).
 */
export function cacheRunDue(schedule: CacheSchedule, lastEndAt: number | undefined, now: number, timeZone: string): boolean {
  if (lastEndAt === undefined) return true;
  if (schedule.kind === 'interval') return now - lastEndAt >= schedule.minutes * 60_000;
  const next = nextCronTime(lastEndAt, schedule.cron, timeZone);
  return next !== undefined && next <= now;
}
