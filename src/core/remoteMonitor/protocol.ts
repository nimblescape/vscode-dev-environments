// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The protocol between the computers and the Session Monitor of a Docker engine (unit 7, PR 2; plan step 8, PR A: on every
// engine; implementation notes 16): the names of its container, volume, and label, the heartbeat records in its volume,
// the subcommands of its script (src/remoteMonitor/main.ts, in the worker's bundle as `devenv:monitor-script`, plan step
// 11D2), and the strict checks of everything that script reads.
// Pure functions without I/O; the script and the extension use the same checks. No `vscode`.
import { createHash } from 'crypto';
import { PIPE_LOADER } from '../loader/pipeLoader';
import { parseCacheSchedule } from './cacheSettings';
import { isTimeZone } from './cron';

/**
 * The one Session Monitor container per Docker engine (never a container of an environment: no
 * nimblescape.devenv.environment-id).
 */
export const REMOTE_MONITOR_CONTAINER = 'devenv-session-monitor';
/** The volume of its heartbeat records, mounted at REMOTE_MONITOR_STATE_DIR. */
export const REMOTE_MONITOR_VOLUME = 'devenv-session-monitor';
/** Label of the container: 12 hex digits of sha256 of the script, the helper tag and the loader (remoteMonitorLabelValue). */
export const LABEL_SESSION_MONITOR = 'nimblescape.devenv.session-monitor';
/**
 * Review round 1 of PR #69 (A-R1-2): a label with a random nonce per create of the monitor container (not part of
 * remoteMonitorLabelValue). A failed create removes only the container with its own nonce (`docker ps -aq --filter
 * label=…`, then `docker rm -f <id>`), never the container of the name, which may be that of another window by then.
 */
export const LABEL_MONITOR_CREATE = 'nimblescape.devenv.monitor-create';
/**
 * Where the pipe loader stores the script (plan step 3; its own file system, so it matches the container version). A
 * restart of the container starts it from there without new input (resume); the `docker exec` subcommands run it too.
 */
export const REMOTE_MONITOR_SCRIPT_PATH = '/opt/devenv/monitor.js';
/** The function of the script that the pipe loader starts (src/remoteMonitor/main.ts): the loop, `run`. */
export const REMOTE_MONITOR_ENTRY = 'startMonitor';
/**
 * The start of the log line with which `run` says that it started. The extension waits for it on the output of the
 * attached `docker run` before it lets the container go (RemoteSessionMonitor.ensure).
 */
export const REMOTE_MONITOR_READY_TEXT = 'Session Monitor started';
/** The mount point of REMOTE_MONITOR_VOLUME in the container. */
export const REMOTE_MONITOR_STATE_DIR = '/state';
/** The folder of the heartbeat records in the volume: `<source>.<environment id>.json`. */
export const HEARTBEAT_FOLDER = 'heartbeats';
/** The kernel lock (`flock`) of the heartbeat records, in the volume (underRecordsLock). */
export const HEARTBEAT_LOCK_PATH = `${REMOTE_MONITOR_STATE_DIR}/.heartbeats.lock`;
/** How long a heartbeat waits for HEARTBEAT_LOCK_PATH, in seconds. */
export const HEARTBEAT_LOCK_WAIT_SECONDS = 5;
/** A heartbeat that holds HEARTBEAT_LOCK_PATH longer than this, in seconds, is killed (the lock with it). */
export const HEARTBEAT_RUN_LIMIT_SECONDS = 10;

/** Default of the setting devEnvLauncher.stopAfterMinutes (10 minutes; plan step 8, PR A: every engine). */
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

/**
 * One heartbeat: the computer, its time limit, and the environments it uses or keeps. `release` (plan step 8, PR C;
 * review round 1 of PR #87, A-R1-2): the short release of a window that left the environment (windowRelease.ts); its
 * records carry it, and the monitor lets such a record decide only while no record of another source is still within
 * its own limit (rules.ts, decide), so a release never shortens the heartbeats of another computer.
 */
export interface HeartbeatInput {
  source: string;
  limitSeconds: number;
  environments: HeartbeatEntry[];
  release?: true;
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
  /** Review round 1 of PR #87 (A-R1-2): written by a release (HeartbeatInput.release). */
  release?: true;
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
 * safe non-negative integer), and optionally `clearOnly` (a boolean; true only with keepRunning false)), and optionally
 * `release` (only `true`; review round 1 of PR #87, A-R1-2). `undefined` for anything else; then nothing is written.
 */
export function parseHeartbeatInput(text: string): HeartbeatInput | undefined {
  if (text.length > MAX_HEARTBEAT_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  // Review round 1 of PR #87 (A-R1-2): optionally `release` (true only).
  if (!isRecord(value)) return undefined;
  const keys = 'release' in value ? ['source', 'limitSeconds', 'environments', 'release'] : ['source', 'limitSeconds', 'environments'];
  if (!hasExactKeys(value, keys)) return undefined;
  if ('release' in value && value.release !== true) return undefined;
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
  const input: HeartbeatInput = { source, limitSeconds: clampLimitSeconds(limitSeconds), environments: checked };
  if (value.release === true) input.release = true;
  return input;
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
  const { at, keepRunning, limitSeconds, seq, release } = value;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined;
  if (typeof keepRunning !== 'boolean' || !isSeq(seq)) return undefined;
  if (typeof limitSeconds !== 'number' || !Number.isInteger(limitSeconds) || limitSeconds < MIN_LIMIT_SECONDS || limitSeconds > MAX_LIMIT_SECONDS) {
    return undefined;
  }
  // Review round 1 of PR #87 (A-R1-2): a release record; any other value of `release` is no valid record.
  if (release !== undefined && release !== true) return undefined;
  return release === true ? { at, keepRunning, limitSeconds, seq, release: true } : { at, keepRunning, limitSeconds, seq };
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

/** The exit code of a command under the lock of the records that did not get the lock in time (`flock -E`). */
export const RECORDS_LOCK_BUSY_EXIT = 75;
/** The exit code of a command under the lock of the records that `timeout -s KILL` ended (128 + SIGKILL). */
export const RECORDS_RUN_LIMIT_EXIT = 137;

/**
 * `command` under the kernel lock `flock` (util-linux) of HEARTBEAT_LOCK_PATH.
 *
 * Review round 2 of PR #58 (after review round 10 of PR #57): two heartbeats (two `docker exec` at the same time) read and
 * replace the records one after the other. The kernel releases the lock when its process ends, also when it is killed,
 * so no lock is ever left over; a command that does not get the lock within HEARTBEAT_LOCK_WAIT_SECONDS fails with
 * RECORDS_LOCK_BUSY_EXIT (review round 3, F7) and writes nothing, and one that holds it longer than
 * HEARTBEAT_RUN_LIMIT_SECONDS is killed (`timeout`, coreutils; RECORDS_RUN_LIMIT_EXIT), so a hanging heartbeat cannot
 * block the others. Together at most 15 s, within the 20 s of a `docker exec` of a heartbeat. Plan step 11I (U2, decision
 * of 2026-10-08): the prefix of the entries monitorHeartbeat and monitorForget of the registry of the container scripts
 * (src/core/worker/containerScripts.ts), and of forgetIfUnchangedCommand of the monitor itself.
 */
export function underRecordsLock(command: readonly string[]): string[] {
  return [
    'flock',
    '-w',
    String(HEARTBEAT_LOCK_WAIT_SECONDS),
    '-E',
    String(RECORDS_LOCK_BUSY_EXIT),
    HEARTBEAT_LOCK_PATH,
    'timeout',
    '-s',
    'KILL',
    String(HEARTBEAT_RUN_LIMIT_SECONDS),
    ...command,
  ];
}

/**
 * Whether `command` runs under the lock of the records (underRecordsLock: the entries monitorHeartbeat and monitorForget
 * of the registry, forgetIfUnchangedCommand).
 */
export function isUnderRecordsLock(command: readonly string[]): boolean {
  return command[0] === 'flock';
}

/**
 * The reason of a failed `docker exec` of the monitor: its stderr, else (review round 3 of PR #58, F7) for a command
 * under the lock of the records (`underLock`) the busy lock or a kill by their exit codes, else the exit code. Review
 * round 4 (H2): 137 is any SIGKILL (the time limit, an OOM kill, a container removed meanwhile), so the text names both;
 * a command without the lock (records) gets the bare exit code.
 */
export function monitorExecFailure(exitCode: number | null, stderr: string, underLock: boolean): string {
  const text = stderr.trim();
  if (text !== '') return text;
  if (underLock && exitCode === RECORDS_LOCK_BUSY_EXIT) {
    return `the heartbeat records stayed locked by another command for ${HEARTBEAT_LOCK_WAIT_SECONDS} s`;
  }
  if (underLock && exitCode === RECORDS_RUN_LIMIT_EXIT) {
    return `the command was killed (its limit of ${HEARTBEAT_RUN_LIMIT_SECONDS} s, or a kill from outside)`;
  }
  return `exit code ${exitCode}`;
}

// Plan step 11I (U2, decision of 2026-10-08): the commands that the worker runs in the monitor container (a heartbeat,
// Delete's forget, the image settings and list) are entries of the registry of the container scripts
// (monitorHeartbeat, monitorForget, monitorSettings, monitorImages in src/core/worker/containerScripts.ts) with the same
// command lines; heartbeatCommand, forgetCommand, imageSettingsCommand and imagesCommand are removed. Review round 3 of
// PR #58 (F6): Delete's forget runs under the lock of the records, so a heartbeat that read the record before cannot
// write it back after. Plan step 11I (U10, decision of 2026-10-08): the subcommand `records` and its recordsCommand are
// removed.

/**
 * Review round 1 of PR #63 (F2): the command with which the monitor itself removes an old record (`forget` with the `at`
 * of the record as it read it), under the lock of the records: it removes the record only when its `at` is still that
 * one, so a heartbeat written after the read stays. It prints `removed` when it removed it.
 */
export function forgetIfUnchangedCommand(source: string, environmentId: string, at: number): string[] {
  return underRecordsLock(['node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', source, environmentId, String(at)]);
}

// ---- The images of the remote host (user requests 2026-09-28: pull the latest major version of all images of the
// setting imageUpdates, keep the two newest versions; plan step 8, PR A: on every engine) ----

/** A prefix of image repositories: `registry/path…`, lower case, no tag, no digest (the setting drops a trailing `*`). */
export function isImagePrefix(value: unknown): value is string {
  // Review round 6 of PR #57 (F2): at most MAX_IMAGE_PREFIX_LENGTH characters.
  // Review round 8 of PR #57 (S4): not Docker Hub, whose images `docker image ls` lists without the registry.
  return (
    typeof value === 'string' &&
    value.length <= MAX_IMAGE_PREFIX_LENGTH &&
    /^[a-z0-9.-]+(:[0-9]+)?\/[a-z0-9._/-]*$/.test(value) &&
    !value.includes('..') &&
    !/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//.test(value) &&
    // A registry host first (a `.` or a port, or localhost): without one, the name would never be maintained.
    /^([^/]*[.:][^/]*|localhost)\//.test(value)
  );
}

/**
 * The prefixes of the setting imageUpdates: a trailing `*` dropped, invalid ones and duplicates left out. Review
 * round 5 of PR #57 (P1): at most MAX_IMAGE_PREFIXES, as the monitor takes (`settings -`); before, more were sent and
 * refused at every open.
 */
export function imagePrefixesOf(patterns: readonly unknown[]): string[] {
  const prefixes: string[] = [];
  for (const pattern of patterns) {
    if (prefixes.length >= MAX_IMAGE_PREFIXES) break;
    if (typeof pattern !== 'string') continue;
    const prefix = pattern.trim().replace(/\*$/, '');
    // Review round 6 of PR #57 (F2): all together at most MAX_IMAGE_PREFIXES_JSON_LENGTH characters as JSON, as they go on
    // the command line of `docker run` of the monitor (DEVENV_IMAGE_PREFIXES), which stays short (plan step 3: the script
    // is no longer on it, so all of them go there).
    if (isImagePrefix(prefix) && !prefixes.includes(prefix) && JSON.stringify([...prefixes, prefix]).length <= MAX_IMAGE_PREFIXES_JSON_LENGTH) prefixes.push(prefix);
  }
  return prefixes;
}

/** The list of image repositories that the extension sends (`monitor.js images -`, JSON on stdin). */
export const IMAGE_LIST_FILE = 'images.json';
/** At most this many repositories in the list. */
export const MAX_IMAGE_REPOSITORIES = 500;
/** The longest input of `monitor.js images -`. */
export const MAX_IMAGE_LIST_LENGTH = 128 * 1024;

/** A repository of an image registry: `registry/path` in lower case, no tag, no digest (`ghcr.io/acme/base`). */
export function isImageRepository(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 255 &&
    /^[a-z0-9.-]+(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$/.test(value) &&
    /[.:]/.test(value.slice(0, value.indexOf('/')))
  );
}

/** The input of `monitor.js images -`: `{ "repositories": [...] }`, strict. Undefined for anything else. */
export function parseImageListInput(text: string): string[] | undefined {
  if (text.length > MAX_IMAGE_LIST_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).join() !== 'repositories') return undefined;
  const { repositories } = value;
  if (!Array.isArray(repositories) || repositories.length > MAX_IMAGE_REPOSITORIES || !repositories.every(isImageRepository)) return undefined;
  return [...new Set(repositories as string[])];
}

/**
 * Review round 1 of PR #57 (C): the settings of the image maintenance are not part of the label of the monitor, so
 * computers with other settings or another time zone on the same engine do not replace it at each open. Each open sends
 * them (`monitor.js settings -`, JSON on stdin); the newest settings of any computer apply from its next check on.
 */
export const IMAGE_SETTINGS_FILE = 'image-settings.json';
/** At most this many prefixes. */
export const MAX_IMAGE_PREFIXES = 50;
/** The longest prefix (review round 6 of PR #57, F2). */
export const MAX_IMAGE_PREFIX_LENGTH = 128;
/** The longest list of prefixes as JSON (review round 6 of PR #57, F2: they go on the command line of `docker run`). */
export const MAX_IMAGE_PREFIXES_JSON_LENGTH = 4096;

export interface ImageSettings {
  prefixes: string[];
  /**
   * A cron expression of five fields. Plan step 11H2 (D2, decision of 2026-10-09): or an interval in whole minutes (the
   * setting cacheUpdateSchedule, parseCacheSchedule); the schedule of the whole background run of the monitor, not only of
   * its images.
   */
  schedule: string;
  /** An IANA time zone. */
  timeZone: string;
}

/**
 * Plan step 11H2 (D1, decision of 2026-10-09): the settings of the Session Monitor that an open and `monitorEnsure`
 * carry: the image settings (ImageSettings, which the monitor gets with `settings -`), and whether it runs permanently
 * (monitorRunsPermanently: on a remote engine, or on a local one with stopLocalMonitorWhenIdle off). The mode is part of
 * its label (monitorModeLabelPart), never of `settings -`; missing means false. Review round 1 of 11H2 (A-L2): and why it
 * is permanent: `remote` when the computer reaches the engine as a remote one (only with `permanent`).
 */
export interface MonitorSettings extends ImageSettings {
  permanent?: boolean;
  remote?: boolean;
}

/** Plan step 11H2: the image settings of MonitorSettings, as `settings -` takes them (without the mode). */
export function imageSettingsOf(settings: ImageSettings): ImageSettings {
  return { prefixes: settings.prefixes, schedule: settings.schedule, timeZone: settings.timeZone };
}

/**
 * Plan step 11H2: the strict check of MonitorSettings (both sides of `open` and `monitorEnsure`): an object with the keys
 * of parseImageSettingsInput and optionally `permanent` (a boolean). Undefined for anything else.
 */
export function parseMonitorSettings(value: unknown): MonitorSettings | undefined {
  if (!isRecord(value)) return undefined;
  const { permanent, remote, ...rest } = value;
  if ('permanent' in value && typeof permanent !== 'boolean') return undefined;
  // Review round 1 of 11H2 (A-L2): `remote`, a boolean, only for a permanent monitor (a remote engine always has one).
  if ('remote' in value && (typeof remote !== 'boolean' || (remote && permanent !== true))) return undefined;
  const images = parseImageSettingsInput(JSON.stringify(rest));
  if (images === undefined) return undefined;
  return { ...images, ...(typeof permanent === 'boolean' ? { permanent } : {}), ...(typeof remote === 'boolean' ? { remote } : {}) };
}

/**
 * The input of `monitor.js settings -`: `{ "prefixes": [...], "schedule": "…", "timeZone": "…" }`, strict. Plan step
 * 11H2 (D2): the schedule a cron expression or an interval in minutes (parseCacheSchedule), as the setting gives it.
 */
export function parseImageSettingsInput(text: string): ImageSettings | undefined {
  if (text.length > MAX_IMAGE_LIST_LENGTH) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !hasExactKeys(value, ['prefixes', 'schedule', 'timeZone'])) return undefined;
  const { prefixes, schedule, timeZone } = value;
  if (!Array.isArray(prefixes) || prefixes.length > MAX_IMAGE_PREFIXES || !prefixes.every(isImagePrefix)) return undefined;
  if (typeof schedule !== 'string' || !parseCacheSchedule(schedule) || typeof timeZone !== 'string' || !isTimeZone(timeZone)) return undefined;
  return { prefixes: [...new Set(prefixes as string[])], schedule, timeZone };
}

/**
 * Shared engine (reviewer note of PR 2), consistent with "the newest record decides" of the remote monitor (review round
 * 2 of PR #39, M1): true when a computer other than `ownSource` sent a heartbeat for the environment less than
 * OTHER_COMPUTER_FRESH_MS ago (it uses it), or has a record that keeps it running and that is at least as new as the
 * newest record of this computer (by the clock of the remote host). A later choice of this computer (a heartbeat without
 * the flag) overrules an older keep of another one, for example of a computer that no longer sends. Then this computer
 * does not stop it. `output`: the clock of the remote host and the records of the environment (plan step 11I, U10: the
 * output of the removed subcommand `records` is no longer a type of its own).
 */
export function inUseByOtherComputer(output: { now: number; records: ReadonlyArray<{ source: string; at: number; keepRunning: boolean }> }, ownSource: string): boolean {
  const own = output.records.filter((record) => record.source === ownSource).reduce((newest, record) => Math.max(newest, record.at), Number.NEGATIVE_INFINITY);
  return output.records.some(
    (record) =>
      record.source !== ownSource && (Math.abs(output.now - record.at) < OTHER_COMPUTER_FRESH_MS || (record.keepRunning && record.at >= own)),
  );
}

/**
 * Plan step 11H2 (D1 and the user's decision "unless-stopped" of 2026-10-09): the part of the label of a monitor that runs
 * permanently (restart policy `unless-stopped`, never an exit when idle), so a change of the mode replaces it at the next
 * ensure. It replaces the part `image-maintenance` of the user requests of 2026-09-28: the monitor always has its outbound
 * network now (the VS Code server of its background run), so the image maintenance no longer changes its container.
 * Review round 1 of PR #57 (C): the settings of the run are not part of the label. Review round 1 of 11H2 (A-L2): the part
 * says why it is permanent (before: `permanent` alone): a computer reaches the engine as a remote one
 * (`permanent-remote`), or as the local one with stopLocalMonitorWhenIdle off (`permanent-local`). An ensure that sees the
 * engine as local takes a running `permanent-remote` monitor of the same version as current, and one that sees it as
 * remote a running `permanent-local` one (RemoteSessionMonitor), so a computer that turns the setting on again replaces
 * its own permanent monitor, but never one that another computer runs as remote.
 */
export const PERMANENT_REMOTE_LABEL_PART = 'permanent-remote';
export const PERMANENT_LOCAL_LABEL_PART = 'permanent-local';

/** Review round 1 of 11H2 (A-L2): the mode of a monitor: it ends when idle, or it is permanent for one of two reasons. */
export type MonitorMode = 'idle' | typeof PERMANENT_LOCAL_LABEL_PART | typeof PERMANENT_REMOTE_LABEL_PART;

/** Review round 1 of 11H2 (A-L2): the mode of the monitor that MonitorSettings ask for. */
export function monitorModeOf(settings: Pick<MonitorSettings, 'permanent' | 'remote'> | undefined): MonitorMode {
  if (settings?.permanent !== true) return 'idle';
  return settings.remote === true ? PERMANENT_REMOTE_LABEL_PART : PERMANENT_LOCAL_LABEL_PART;
}

/**
 * Review round 1 of 11H2 (A-L6): the part of the label of a monitor that mounts the shared VS Code server store `volume`,
 * so that a monitor created without the store (or with another one) is replaced by an ensure that has it.
 */
export function vscodeStoreLabelPart(volume: string): string {
  return `vscode-store:${volume}`;
}

/** Plan step 11H2: the file of the background run in the volume of the monitor (the end of its last run, its last cleanup). */
export const CACHE_RUN_FILE = 'cache-run.json';

/**
 * The value of LABEL_SESSION_MONITOR: 12 hex digits of sha256 of the script, the helper tag, the pipe loader (plan step
 * 3: a new loader is a new version of the container, so every monitor of an older way of loading is replaced once), and
 * the `extra` parts.
 */
export function remoteMonitorLabelValue(script: string, helperTag: string, extra: readonly string[] = []): string {
  const hash = createHash('sha256').update(script, 'utf8').update('\n', 'utf8').update(helperTag, 'utf8');
  hash.update('\n', 'utf8').update(PIPE_LOADER, 'utf8');
  if (extra.length > 0) hash.update('\n', 'utf8').update(JSON.stringify(extra), 'utf8');
  return hash.digest('hex').slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
