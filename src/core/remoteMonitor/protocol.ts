// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The protocol between the computers and the Session Monitor on a remote Docker host (unit 7, PR 2; implementation
// notes 16): the names of its container, volume, and label, the heartbeat records in its volume, the subcommands of its
// script (dist/remoteMonitor.js, src/remoteMonitor/main.ts), and the strict checks of everything that script reads.
// Pure functions without I/O; the script and the extension use the same checks. No `vscode`.
import { createHash } from 'crypto';

/**
 * The one Session Monitor container per Docker engine (never a container of an environment: no
 * nimblescape.devenv.environment-id).
 */
export const REMOTE_MONITOR_CONTAINER = 'devenv-session-monitor';
/** The volume of its heartbeat records, mounted at REMOTE_MONITOR_STATE_DIR. */
export const REMOTE_MONITOR_VOLUME = 'devenv-session-monitor';
/** Label of the container: 12 hex digits of sha256 of the script and the helper tag (remoteMonitorLabelValue). */
export const LABEL_SESSION_MONITOR = 'nimblescape.devenv.session-monitor';
/** Where the container writes its script at each start (its own file system, so it matches the container version). */
export const REMOTE_MONITOR_SCRIPT_PATH = '/opt/devenv/monitor.js';
/** The mount point of REMOTE_MONITOR_VOLUME in the container. */
export const REMOTE_MONITOR_STATE_DIR = '/state';
/** The folder of the heartbeat records in the volume: `<source>.<environment id>.json`. */
export const HEARTBEAT_FOLDER = 'heartbeats';

/** Default of the setting devEnvLauncher.remoteStopAfterMinutes (10 minutes). */
export const DEFAULT_REMOTE_STOP_AFTER_SECONDS = 600;
/** The smallest time limit that a heartbeat can set. */
export const MIN_LIMIT_SECONDS = 60;
/** The largest time limit that a heartbeat can set (one day). */
export const MAX_LIMIT_SECONDS = 86_400;
/** At most this many environments in one heartbeat. */
export const MAX_HEARTBEAT_ENVIRONMENTS = 200;
/** The longest heartbeat argument that the script accepts. */
export const MAX_HEARTBEAT_LENGTH = 32_000;
/** A record of another computer younger than this makes an environment "in use from another computer" (shared engine). */
export const OTHER_COMPUTER_FRESH_MS = 90_000;
/**
 * The longest script that the container takes as an argument of `docker run` (the command line of Windows is limited to
 * 32767 characters, and the quotes of a script are escaped there).
 */
export const MAX_SCRIPT_LENGTH = 24_000;

const SOURCE_PATTERN = /^[0-9a-f]{32}$/;
/** The form of `newEnvironmentId` (crypto.randomUUID, lower case). */
const ENVIRONMENT_ID_PATTERN = /^[0-9a-f-]{36}$/;
const RECORD_NAME_PATTERN = /^([0-9a-f]{32})\.([0-9a-f-]{36})\.json$/;

/** True for the id of a computer (`computer.id`): 32 lower-case hex digits. */
export function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_PATTERN.test(value);
}

/** True for an environment id as newEnvironmentId makes it (36 characters of lower-case hex digits and `-`). */
export function isRemoteEnvironmentId(value: unknown): value is string {
  return typeof value === 'string' && ENVIRONMENT_ID_PATTERN.test(value);
}

/**
 * One environment of a heartbeat. `seq` (review round 2 of PR #39, L1): the wall clock of the sending computer, in ms,
 * at which it read the keep flag (the Session Monitor: its tick; a window: right after it changed the flag). The remote
 * monitor does not replace a recent record of the same source with a higher `seq` (SEQ_ORDER_WINDOW_MS), so a
 * heartbeat that was under way while the flag changed cannot undo the newer choice.
 *
 * `clearOnly` (review round 3 of PR #39, N1; only with keepRunning false): the entry only withdraws a keep of this same
 * source. The remote monitor writes it only when the existing record of this source says keepRunning; otherwise it
 * writes nothing for it (no new record, no new `at`), so it is no choice about the environment and cannot overrule the
 * keep of another computer.
 */
export interface HeartbeatEntry {
  id: string;
  keepRunning: boolean;
  seq: number;
  clearOnly?: true;
}

/**
 * The seq order holds only while the stored record is at most this old by the clock of the remote host (review round 3
 * of PR #39, N2): the time in which a heartbeat can be under way (a `docker exec` ends after 20 s). An older record is
 * replaced whatever its `seq`, so a clock of the sending computer that was set back does not block its heartbeats.
 */
export const SEQ_ORDER_WINDOW_MS = 60_000;

/** One heartbeat: the computer, its time limit, and the environments it uses or keeps. */
export interface HeartbeatInput {
  source: string;
  limitSeconds: number;
  environments: HeartbeatEntry[];
}

/**
 * A heartbeat record in the volume. `at` is the clock of the remote host at the write, so the clocks of the computers do
 * not matter; `seq` is the one of the entry (HeartbeatEntry).
 */
export interface HeartbeatRecord {
  at: number;
  keepRunning: boolean;
  limitSeconds: number;
  seq: number;
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A time limit in whole seconds within MIN_LIMIT_SECONDS..MAX_LIMIT_SECONDS; the default for a value that is no number. */
export function clampLimitSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REMOTE_STOP_AFTER_SECONDS;
  return Math.min(MAX_LIMIT_SECONDS, Math.max(MIN_LIMIT_SECONDS, Math.round(value)));
}

/**
 * The argument of `monitor.js heartbeat`, checked strictly: a JSON object with exactly `source` (isSourceId),
 * `limitSeconds` (an integer, clamped to MIN_LIMIT_SECONDS..MAX_LIMIT_SECONDS), and `environments` (at most
 * MAX_HEARTBEAT_ENVIRONMENTS objects with exactly `id` (isRemoteEnvironmentId), `keepRunning` (a boolean), and `seq` (a
 * safe non-negative integer), and optionally `clearOnly` (a boolean; true only with keepRunning false)).
 * `undefined` for anything else; then nothing is written.
 */
export function parseHeartbeatInput(text: string): HeartbeatInput | undefined {
  if (text.length > MAX_HEARTBEAT_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !hasExactKeys(value, ['source', 'limitSeconds', 'environments'])) return undefined;
  const { source, limitSeconds, environments } = value;
  if (!isSourceId(source) || typeof limitSeconds !== 'number' || !Number.isInteger(limitSeconds)) return undefined;
  if (!Array.isArray(environments) || environments.length > MAX_HEARTBEAT_ENVIRONMENTS) return undefined;
  const checked: HeartbeatInput['environments'] = [];
  for (const entry of environments) {
    if (!isRecord(entry)) return undefined;
    const keys = 'clearOnly' in entry ? ['id', 'keepRunning', 'seq', 'clearOnly'] : ['id', 'keepRunning', 'seq'];
    if (!hasExactKeys(entry, keys)) return undefined;
    if (!isRemoteEnvironmentId(entry.id) || typeof entry.keepRunning !== 'boolean' || !isSeq(entry.seq)) return undefined;
    if ('clearOnly' in entry && (typeof entry.clearOnly !== 'boolean' || (entry.clearOnly && entry.keepRunning))) return undefined;
    const checkedEntry: HeartbeatEntry = { id: entry.id, keepRunning: entry.keepRunning, seq: entry.seq };
    if (entry.clearOnly === true) checkedEntry.clearOnly = true;
    checked.push(checkedEntry);
  }
  return { source, limitSeconds: clampLimitSeconds(limitSeconds), environments: checked };
}

/** The content of a record file; `undefined` for anything that is not a valid record. */
export function parseHeartbeatRecord(text: string): HeartbeatRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { at, keepRunning, limitSeconds, seq } = value;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined;
  if (typeof keepRunning !== 'boolean' || !isSeq(seq)) return undefined;
  if (typeof limitSeconds !== 'number' || !Number.isInteger(limitSeconds) || limitSeconds < MIN_LIMIT_SECONDS || limitSeconds > MAX_LIMIT_SECONDS) {
    return undefined;
  }
  return { at, keepRunning, limitSeconds, seq };
}

/** The file name of the record of `source` for `environmentId`. Throws for an invalid id. */
export function heartbeatFileName(source: string, environmentId: string): string {
  if (!isSourceId(source) || !isRemoteEnvironmentId(environmentId)) throw new Error('Invalid heartbeat record name.');
  return `${source}.${environmentId}.json`;
}

/** The parts of a record file name; `undefined` for any other name (temporary files, foreign files). */
export function parseHeartbeatFileName(name: string): { source: string; environmentId: string } | undefined {
  const match = RECORD_NAME_PATTERN.exec(name);
  return match ? { source: match[1], environmentId: match[2] } : undefined;
}

/** The command of `docker exec` that writes a heartbeat. The argument holds no secret (ids and flags only). */
export function heartbeatCommand(input: HeartbeatInput): string[] {
  return ['node', REMOTE_MONITOR_SCRIPT_PATH, 'heartbeat', JSON.stringify(input)];
}

/** The command of `docker exec` that prints the records of an environment (RecordsOutput). */
export function recordsCommand(environmentId: string): string[] {
  return ['node', REMOTE_MONITOR_SCRIPT_PATH, 'records', environmentId];
}

/** The command of `docker exec` that removes the record of `source` for an environment (Delete). */
export function forgetCommand(source: string, environmentId: string): string[] {
  return ['node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', source, environmentId];
}

/** The output of `monitor.js records <id>`: the clock of the remote host and the records of that environment. */
export interface RecordsOutput {
  now: number;
  records: Array<{ source: string; at: number; keepRunning: boolean }>;
}

/** Parses the output of `monitor.js records`; `undefined` when it is not such an object. */
export function parseRecordsOutput(stdout: string): RecordsOutput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.now !== 'number' || !Number.isFinite(value.now) || !Array.isArray(value.records)) return undefined;
  const records: RecordsOutput['records'] = [];
  for (const entry of value.records) {
    if (!isRecord(entry) || !isSourceId(entry.source) || typeof entry.at !== 'number' || !Number.isFinite(entry.at)) return undefined;
    if (typeof entry.keepRunning !== 'boolean') return undefined;
    records.push({ source: entry.source, at: entry.at, keepRunning: entry.keepRunning });
  }
  return { now: value.now, records };
}

/**
 * Shared engine (reviewer note of PR 2), consistent with "the newest record decides" of the remote monitor (review round
 * 2 of PR #39, M1): true when a computer other than `ownSource` sent a heartbeat for the environment less than
 * OTHER_COMPUTER_FRESH_MS ago (it uses it), or has a record that keeps it running and that is at least as new as the
 * newest record of this computer (by the clock of the remote host). A later choice of this computer (a heartbeat without
 * the flag) overrules an older keep of another one, for example of a computer that no longer sends. Then this computer
 * does not stop it.
 */
export function inUseByOtherComputer(output: RecordsOutput, ownSource: string): boolean {
  const own = output.records.filter((record) => record.source === ownSource).reduce((newest, record) => Math.max(newest, record.at), Number.NEGATIVE_INFINITY);
  return output.records.some(
    (record) =>
      record.source !== ownSource && (Math.abs(output.now - record.at) < OTHER_COMPUTER_FRESH_MS || (record.keepRunning && record.at >= own)),
  );
}

/** The value of LABEL_SESSION_MONITOR: 12 hex digits of sha256 of the script and the helper tag. */
export function remoteMonitorLabelValue(script: string, helperTag: string): string {
  return createHash('sha256').update(script, 'utf8').update('\n', 'utf8').update(helperTag, 'utf8').digest('hex').slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
