// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Entry point of the Session Monitor on a remote Docker host (unit 7, PR 2; implementation notes 16), bundled to
// dist/remoteMonitor.js. The container devenv-session-monitor (image: the workspace helper, which has Node.js and the
// Docker CLI; the Docker socket of its engine; the volume devenv-session-monitor at /state) writes it to
// /opt/devenv/monitor.js at each start and runs `node /opt/devenv/monitor.js run`. The computers run the other
// subcommands with `docker exec`:
//   run                          the loop: a tick every 15 s (rules.ts)
//   heartbeat <json>             writes the records of one heartbeat (exit 0; 2 for an invalid argument, nothing written)
//   records <environment id>     prints { now, records: [{ source, at, keepRunning }] } of that environment
//   forget <source> <env id>     removes that record (Delete of an environment)
// It uses only Node.js built-ins and small pure modules of src/core. Every argument and every file it reads is checked
// (protocol.ts); it never acts on a container without the label nimblescape.devenv.environment-id, and it removes
// nothing but its own record files. The log goes to stdout (`docker logs devenv-session-monitor`), one line per event.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID } from '../core/names';
import {
  HEARTBEAT_FOLDER,
  IMAGE_LIST_FILE,
  IMAGE_SETTINGS_FILE,
  MAX_IMAGE_LIST_LENGTH,
  parseImageListInput,
  parseImageSettingsInput,
  REMOTE_MONITOR_STATE_DIR,
  SEQ_ORDER_WINDOW_MS,
  heartbeatFileName,
  isRemoteEnvironmentId,
  isSourceId,
  parseHeartbeatFileName,
  parseHeartbeatInput,
  parseHeartbeatRecord,
  type HeartbeatInput,
  type HeartbeatRecord,
  type ImageSettings,
  type RecordsOutput,
} from '../core/remoteMonitor/protocol';
import {
  DEFAULT_REMOTE_TIMING,
  REMOTE_TICK_MS,
  decide,
  initialRemoteState,
  type RemoteContainer,
  type RemoteMonitorState,
  type RemoteRecord,
  type RemoteTiming,
} from './rules';
import {
  DEFAULT_IMAGE_SCHEDULE,
  DEFAULT_IMAGE_TIME_ZONE,
  ImageMaintenance,
  REMOTE_IMAGE_FIRST_PASS_MS,
  isTimeZone,
  nextCronTime,
  nodeHttpGet,
  parseCronSchedule,
  parseReplacedImages,
  prefixesFromEnv,
  type HttpGet,
} from './images';
import type { CronSchedule } from '../core/remoteMonitor/cron';

/** Time limit of the container list. */
export const LIST_TIMEOUT_MS = 30_000;
/** Time limit of one `docker stop` (the container gets 10 s before SIGKILL). */
export const STOP_TIMEOUT_MS = 60_000;
/** A record file larger than this is not read. */
const MAX_RECORD_BYTES = 4096;
/** Exit code for an invalid argument. */
export const EXIT_INVALID = 2;

/** `docker ps` in one line per container: id, state, name, environment id, compose service. */
export const PS_FORMAT = `{{.ID}}\t{{.State}}\t{{.Names}}\t{{.Label "${LABEL_ENVIRONMENT_ID}"}}\t{{.Label "${LABEL_COMPOSE_SERVICE}"}}`;

/** The folder of the records in the volume. */
export function heartbeatDir(stateDir: string = REMOTE_MONITOR_STATE_DIR): string {
  return path.join(stateDir, HEARTBEAT_FOLDER);
}

/** The lines of `docker ps --format PS_FORMAT`. A line with an invalid id or environment id is skipped. */
export function parseContainerLines(stdout: string): RemoteContainer[] {
  const containers: RemoteContainer[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const [id, state, name, environmentId, composeService = ''] = line.split('\t');
    if (!/^[0-9a-f]{12,64}$/.test(id ?? '') || !isRemoteEnvironmentId(environmentId)) continue;
    containers.push({ id, state: state ?? '', name: name ?? '', environmentId, composeService });
  }
  return containers;
}

/**
 * The valid records of the folder: files named `<source>.<environment id>.json` (regular files, at most 4 KB) with a
 * valid record. Everything else is ignored. A missing folder has none.
 */
export async function readRecords(dir: string): Promise<RemoteRecord[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: RemoteRecord[] = [];
  for (const name of names) {
    const parts = parseHeartbeatFileName(name);
    if (!parts) continue;
    // Removed meanwhile, or not readable: ignored.
    const record = await readRecordFile(path.join(dir, name));
    if (record) records.push({ ...parts, ...record });
  }
  return records;
}

/** A lock of a record older than this is left over (a `docker exec` that was killed) and is removed. */
const RECORD_LOCK_STALE_MS = 10_000;
/** How long a heartbeat waits for the lock of a record. */
const RECORD_LOCK_WAIT_MS = 5_000;

/**
 * Runs `fn` while holding the lock of one record (`.<name>.lock`, created with `wx`), so that two heartbeats of the same
 * source (two `docker exec` at the same time) read and replace the record one after the other.
 */
async function withRecordLock<T>(dir: string, name: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(dir, `.${name}.lock`);
  const deadline = Date.now() + RECORD_LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.promises.writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.promises.lstat(lock).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > RECORD_LOCK_STALE_MS) {
        await fs.promises.rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`The record ${name} is locked.`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.promises.rm(lock, { force: true }).catch(() => undefined);
  }
}

/**
 * Writes the records of one heartbeat, each atomically (a temporary file, then a rename), with mode 0600. An entry is
 * ignored (no write, the record stays as it is):
 * - when its `seq` is lower than the `seq` of the existing record of the same source and that record is at most
 *   SEQ_ORDER_WINDOW_MS old (review round 2 of PR #39, L1, and round 3, N2): the newer choice of that computer stays,
 *   while an older record is replaced whatever its `seq` (a clock of the computer that was set back);
 * - when it is `clearOnly` and the existing record of the same source does not say keepRunning (review round 3, N1):
 *   it only withdraws a keep of this source, and must not create or refresh a record.
 * Returns the ids of the ignored entries.
 */
export async function writeHeartbeat(dir: string, input: HeartbeatInput, now: number): Promise<string[]> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const ignored: string[] = [];
  for (const environment of input.environments) {
    const name = heartbeatFileName(input.source, environment.id);
    const file = path.join(dir, name);
    await withRecordLock(dir, name, async () => {
      const existing = await readRecordFile(file);
      const olderEntry = existing !== undefined && existing.seq > environment.seq && Math.abs(now - existing.at) <= SEQ_ORDER_WINDOW_MS;
      const nothingToClear = environment.clearOnly === true && existing?.keepRunning !== true;
      if (olderEntry || nothingToClear) {
        ignored.push(environment.id);
        return;
      }
      const temp = path.join(dir, `.${name}.${process.pid}.tmp`);
      const record = { at: now, keepRunning: environment.keepRunning, limitSeconds: input.limitSeconds, seq: environment.seq };
      try {
        await fs.promises.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
        await fs.promises.rename(temp, file);
      } finally {
        await fs.promises.rm(temp, { force: true }).catch(() => undefined);
      }
    });
  }
  return ignored;
}

/** One record file: a regular file of at most 4 KB with a valid record; `undefined` for anything else. */
async function readRecordFile(file: string): Promise<HeartbeatRecord | undefined> {
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return undefined;
    return parseHeartbeatRecord(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The records of one environment, for `records <id>`. */
export async function recordsOf(dir: string, environmentId: string, now: number): Promise<RecordsOutput> {
  const records = (await readRecords(dir)).filter((record) => record.environmentId === environmentId);
  return { now, records: records.map(({ source, at, keepRunning }) => ({ source, at, keepRunning })) };
}

/** Removes one record; a missing one is no error. */
export async function removeRecord(dir: string, source: string, environmentId: string): Promise<void> {
  await fs.promises.rm(path.join(dir, heartbeatFileName(source, environmentId)), { force: true });
}

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the Docker CLI of the container (its socket is the one of the engine). Never rejects. */
export type DockerRunner = (args: readonly string[], timeoutMs: number) => Promise<DockerResult>;

export const nodeDocker: DockerRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile('docker', [...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      const detail = error && error.killed ? `${stderr}\nThe command did not end within ${timeoutMs / 1000} seconds.` : stderr;
      resolve({ code, stdout: String(stdout), stderr: String(detail) });
    });
  });

export interface RemoteLoopDeps {
  docker: DockerRunner;
  /** The folder of the records. */
  dir: string;
  now: () => number;
  log: (message: string) => void;
  timing?: RemoteTiming;
}

/** The loop of `run`: one `tick()` per interval. The log names each event once, not every tick. */
export class RemoteMonitorLoop {
  private state: RemoteMonitorState = initialRemoteState();
  private listFailing = false;
  /** Env ids whose "keeps running" was logged; env ids whose failed stop was logged. */
  private readonly keptLogged = new Set<string>();
  private readonly stopFailedLogged = new Set<string>();
  private graceLogged = false;

  constructor(private readonly deps: RemoteLoopDeps) {}

  get currentState(): RemoteMonitorState {
    return this.state;
  }

  /** One tick; returns the environments whose containers were stopped. Never throws. */
  async tick(): Promise<string[]> {
    const { docker, log } = this.deps;
    const listed = await docker(['ps', '-a', '--no-trunc', '--filter', `label=${LABEL_ENVIRONMENT_ID}`, '--format', PS_FORMAT], LIST_TIMEOUT_MS);
    if (listed.code !== 0) {
      if (!this.listFailing) log(`Docker does not answer; nothing is stopped while it does not answer. ${listed.stderr.trim()}`);
      this.listFailing = true;
      return [];
    }
    if (this.listFailing) log('Docker answers again.');
    this.listFailing = false;
    let records: RemoteRecord[];
    try {
      records = await readRecords(this.deps.dir);
    } catch (error) {
      log(`The heartbeat records could not be read; nothing is stopped. ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const decision = decide({
      now: this.deps.now(),
      containers: parseContainerLines(listed.stdout),
      records,
      state: this.state,
      timing: this.deps.timing ?? DEFAULT_REMOTE_TIMING,
    });
    this.state = decision.state;
    if (decision.grace && !this.graceLogged) log('A pause or a start: nothing is stopped until the computers have sent heartbeats again.');
    this.graceLogged = decision.grace;

    for (const id of decision.kept) {
      if (!this.keptLogged.has(id)) log(`${id} keeps running: a computer asked to keep it running when closed.`);
    }
    this.keptLogged.clear();
    for (const id of decision.kept) this.keptLogged.add(id);

    const stopped: string[] = [];
    for (const { environmentId, containers, reason } of decision.stop) {
      let failed = false;
      for (const container of containers) {
        log(`Stopping the container ${container.name} of ${environmentId}: ${reason}.`);
        const result = await docker(['stop', container.id], STOP_TIMEOUT_MS);
        if (result.code !== 0 && !/no such container/i.test(result.stderr)) {
          failed = true;
          // Tried again at the next tick; logged once per series.
          if (!this.stopFailedLogged.has(environmentId)) log(`The container ${container.name} could not be stopped: ${result.stderr.trim()}`);
        }
      }
      if (failed) {
        this.stopFailedLogged.add(environmentId);
      } else {
        this.stopFailedLogged.delete(environmentId);
        stopped.push(environmentId);
      }
    }

    for (const record of decision.forget) {
      try {
        await removeRecord(this.deps.dir, record.source, record.environmentId);
        log(`Removed the old record of ${record.environmentId} (no container of it exists).`);
      } catch (error) {
        log(`The old record of ${record.environmentId} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return stopped;
  }
}

/**
 * The tick of the tests of the container (DEVENV_MONITOR_TICK_MS, 100..60000 ms): the gap and the grace scale with it
 * (4 and 8 ticks). Without it, or with another value, the times of rules.ts.
 */
export function timingFromEnv(env: NodeJS.ProcessEnv): { tickMs: number; timing: RemoteTiming } {
  const text = env.DEVENV_MONITOR_TICK_MS;
  if (text !== undefined && /^\d{3,5}$/.test(text)) {
    const tickMs = Number(text);
    if (tickMs >= 100 && tickMs <= 60_000) return { tickMs, timing: { gapMs: 4 * tickMs, graceMs: 8 * tickMs } };
  }
  return { tickMs: REMOTE_TICK_MS, timing: DEFAULT_REMOTE_TIMING };
}

export interface MainDeps {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  docker?: DockerRunner;
  /** The images (user requests 2026-09-28): the registry, and the standard input of `images -`. */
  httpGet?: HttpGet;
  readStdin?: () => Promise<string>;
  now?: () => number;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

function timestamped(out: (text: string) => void): (message: string) => void {
  return (message) => out(`${new Date().toISOString()} ${message}\n`);
}

/** The standard input as text, at most MAX_IMAGE_LIST_LENGTH + 1 characters (a longer one is refused). */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > MAX_IMAGE_LIST_LENGTH) {
        process.stdin.destroy();
        resolve(text);
      }
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(text));
  });
}

/** Stores the list of repositories (atomically: a temporary file, then a rename). */
export async function writeImageList(stateDir: string, repositories: readonly string[]): Promise<void> {
  await writeStateFile(stateDir, IMAGE_LIST_FILE, JSON.stringify({ repositories }));
}

/** Writes a file of the volume at once (a temporary file, then rename). */
async function writeStateFile(stateDir: string, name: string, text: string): Promise<void> {
  const file = path.join(stateDir, name);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, text, { mode: 0o600 });
  await fs.promises.rename(temporary, file);
}

/** The stored list of repositories; none when it is missing or invalid. */
export async function readImageList(stateDir: string): Promise<string[]> {
  try {
    const text = await fs.promises.readFile(path.join(stateDir, IMAGE_LIST_FILE), 'utf8');
    return parseImageListInput(text) ?? [];
  } catch {
    return [];
  }
}

/**
 * The times of the Docker tests: DEVENV_IMAGE_FIRST_MS (the first pass) and DEVENV_IMAGE_INTERVAL_MS (a fixed interval
 * instead of the daily time), 100..86400000 ms each.
 */
export function imageTimesFromEnv(env: NodeJS.ProcessEnv): { firstMs: number; intervalMs?: number } {
  const read = (text: string | undefined) => (text !== undefined && /^\d{3,8}$/.test(text) && Number(text) >= 100 ? Number(text) : undefined);
  return { firstMs: read(env.DEVENV_IMAGE_FIRST_MS) ?? REMOTE_IMAGE_FIRST_PASS_MS, intervalMs: read(env.DEVENV_IMAGE_INTERVAL_MS) };
}

/**
 * The schedule of the passes (user request 2026-09-28, "in a guided cron style manner"): DEVENV_IMAGE_SCHEDULE (a cron
 * expression of five fields, the setting remoteImageUpdateSchedule) in DEVENV_IMAGE_TZ (the time zone of the computer
 * that created the monitor). Invalid or missing: `7 6 * * *` (06:07) in Europe/Vienna.
 */
export function imageScheduleFromEnv(env: NodeJS.ProcessEnv): { text: string; schedule: CronSchedule; timeZone: string } {
  const valid = parseCronSchedule(env.DEVENV_IMAGE_SCHEDULE);
  const text = valid ? env.DEVENV_IMAGE_SCHEDULE!.trim() : DEFAULT_IMAGE_SCHEDULE;
  return { text, schedule: valid ?? parseCronSchedule(DEFAULT_IMAGE_SCHEDULE)!, timeZone: isTimeZone(env.DEVENV_IMAGE_TZ) ? env.DEVENV_IMAGE_TZ : DEFAULT_IMAGE_TIME_ZONE };
}

/** The IDs of images that pulls replaced (review round 6 of PR #57, F1), in the volume. */
export const REPLACED_IMAGES_FILE = 'replaced-images.json';
/** How often the monitor looks whether a time of the schedule has come (as cron: every minute). */
export const IMAGE_CHECK_MS = 60_000;
/** A clock that steps back by more than this starts the image schedule again from its time (review round 4, L1). */
export const IMAGE_CLOCK_RESET_MS = 60 * 60_000;

/** The settings of the image maintenance with the parsed schedule. */
export interface ActiveImageSettings extends ImageSettings {
  cron: CronSchedule;
}

/**
 * Review round 1 of PR #57 (C): the settings of the image maintenance: those of the container (DEVENV_IMAGE_*), or the
 * newer ones that an extension stored in the volume (`monitor.js settings -`, image-settings.json), read again before
 * each check. So another computer (another time zone, another schedule) does not replace the container.
 */
export class CurrentImageSettings {
  value: ActiveImageSettings;
  private stored = '';

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly stateDir: string,
    private readonly log: (message: string) => void,
  ) {
    const { text, schedule, timeZone } = imageScheduleFromEnv(env);
    this.value = { prefixes: prefixesFromEnv(env), schedule: text, timeZone, cron: schedule };
  }

  /** Reads the stored settings; keeps the current ones when there are none or they are invalid. Never throws. */
  async refresh(): Promise<void> {
    let text: string;
    try {
      text = await fs.promises.readFile(path.join(this.stateDir, IMAGE_SETTINGS_FILE), 'utf8');
    } catch {
      return;
    }
    if (text === this.stored) return;
    this.stored = text;
    const settings = parseImageSettingsInput(text);
    if (!settings) return;
    this.value = { ...settings, cron: parseCronSchedule(settings.schedule)! };
    this.log(`Image update settings: ${settings.prefixes.join(', ') || 'no prefixes'}; at "${settings.schedule}" (cron, ${settings.timeZone}).`);
  }
}

/**
 * The passes of the image maintenance by the cron schedule (user request 2026-09-28, "in a guided cron style manner"):
 * every IMAGE_CHECK_MS, a pass when a time of the schedule came since the last check. At most one pass at a time: a time
 * that comes during a pass is left out.
 */
export class ImageSchedule {
  private checkedUntil: number;
  private running = false;

  constructor(
    private readonly deps: {
      now: () => number;
      log: (message: string) => void;
      settings: Pick<CurrentImageSettings, 'value' | 'refresh'>;
      pass: () => Promise<void>;
    },
  ) {
    this.checkedUntil = deps.now();
  }

  /** One check: a pass when a time of the schedule lies after the previous check and not after now. */
  async check(): Promise<void> {
    await this.deps.settings.refresh();
    const time = this.deps.now();
    const { cron, timeZone } = this.deps.settings.value;
    const due = nextCronTime(this.checkedUntil, cron, timeZone);
    // Review round 2 of PR #57 (R3): a clock that steps back a little does not run a time that was handled already again.
    // Review round 4 (L1): one that steps back by more (a clock that was far ahead, then corrected) starts the schedule
    // again from now; otherwise no pass would come until the clock caught up.
    if (time < this.checkedUntil - IMAGE_CLOCK_RESET_MS) {
      this.deps.log(`The clock of the host went back by ${Math.round((this.checkedUntil - time) / 60_000)} minutes; the image schedule goes on from now.`);
      this.checkedUntil = time;
    } else {
      this.checkedUntil = Math.max(this.checkedUntil, time);
    }
    if (due !== undefined && due <= time) await this.run();
  }

  /** One pass now, unless one runs. Never throws. */
  async run(): Promise<void> {
    if (this.running) {
      this.deps.log('An image update is still running; this time of the schedule is left out.');
      return;
    }
    this.running = true;
    try {
      await this.deps.settings.refresh();
      await this.deps.pass();
    } catch (error) {
      this.deps.log(`The images could not be maintained: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}

/** Runs one subcommand of `argv` (without node and the script). Resolves with the exit code; `run` never resolves. */
export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const now = deps.now ?? Date.now;
  const dir = heartbeatDir(deps.stateDir);
  const [command, ...args] = argv;
  switch (command) {
    case 'heartbeat': {
      const input = args.length === 1 ? parseHeartbeatInput(args[0]) : undefined;
      if (!input) {
        err('Invalid heartbeat.\n');
        return EXIT_INVALID;
      }
      await writeHeartbeat(dir, input, now());
      return 0;
    }
    case 'records': {
      if (args.length !== 1 || !isRemoteEnvironmentId(args[0])) {
        err('Invalid environment id.\n');
        return EXIT_INVALID;
      }
      out(`${JSON.stringify(await recordsOf(dir, args[0], now()))}\n`);
      return 0;
    }
    case 'forget': {
      if (args.length !== 2 || !isSourceId(args[0]) || !isRemoteEnvironmentId(args[1])) {
        err('Invalid record.\n');
        return EXIT_INVALID;
      }
      await removeRecord(dir, args[0], args[1]);
      return 0;
    }
    case 'images': {
      // User request 2026-09-28 ("all images"): the repositories that the extension read from the registry, on stdin.
      const repositories = args.length === 1 && args[0] === '-' ? parseImageListInput(await (deps.readStdin ?? readStdin)()) : undefined;
      if (!repositories) {
        err('Invalid image list.\n');
        return EXIT_INVALID;
      }
      await writeImageList(deps.stateDir ?? REMOTE_MONITOR_STATE_DIR, repositories);
      return 0;
    }
    case 'settings': {
      // Review round 1 of PR #57 (C): the settings of the image maintenance of the computer that opened last, on stdin.
      const text = args.length === 1 && args[0] === '-' ? await (deps.readStdin ?? readStdin)() : undefined;
      const settings = text === undefined ? undefined : parseImageSettingsInput(text);
      if (!settings) {
        err('Invalid image settings.\n');
        return EXIT_INVALID;
      }
      await writeStateFile(deps.stateDir ?? REMOTE_MONITOR_STATE_DIR, IMAGE_SETTINGS_FILE, JSON.stringify(settings));
      return 0;
    }
    case 'run': {
      if (args.length !== 0) {
        err('run takes no argument.\n');
        return EXIT_INVALID;
      }
      const { tickMs, timing } = timingFromEnv(deps.env);
      const log = timestamped(out);
      const docker = deps.docker ?? nodeDocker;
      const loop = new RemoteMonitorLoop({ docker, dir, now, log, timing });
      log(`Session Monitor started (Node.js ${process.version}, a check every ${tickMs / 1000} s).`);
      // User requests 2026-09-28: the images of the prefixes, one minute after the start and then at each time of the schedule.
      // Only when the container got prefixes: only then it has a network (the label says whether it has).
      if (prefixesFromEnv(deps.env).length > 0) {
        const stateDir = deps.stateDir ?? REMOTE_MONITOR_STATE_DIR;
        const settings = new CurrentImageSettings(deps.env, stateDir, log);
        await settings.refresh();
        const images = new ImageMaintenance({
          docker,
          httpGet: deps.httpGet ?? nodeHttpGet,
          log,
          prefixes: () => settings.value.prefixes,
          knownRepositories: () => readImageList(stateDir),
          // Review round 6 of PR #57 (F1): the IDs that pulls replaced, in the volume.
          replaced: {
            read: async () => parseReplacedImages(await fs.promises.readFile(path.join(stateDir, REPLACED_IMAGES_FILE), 'utf8').catch(() => '{}')),
            write: (value) => writeStateFile(stateDir, REPLACED_IMAGES_FILE, JSON.stringify(value)),
          },
        });
        const { firstMs, intervalMs } = imageTimesFromEnv(deps.env);
        const schedule = new ImageSchedule({ now, log, settings, pass: () => images.pass() });
        log(`Image updates of ${settings.value.prefixes.join(', ')}: in ${Math.round(firstMs / 1000)} s, then at "${settings.value.schedule}" (cron, ${settings.value.timeZone}).`);
        setTimeout(() => void schedule.run(), firstMs);
        // The Docker tests: a fixed interval (DEVENV_IMAGE_INTERVAL_MS) instead of the schedule.
        if (intervalMs !== undefined) setInterval(() => void schedule.run(), intervalMs);
        else setInterval(() => void schedule.check(), IMAGE_CHECK_MS);
      }
      for (;;) {
        await loop.tick();
        await new Promise((resolve) => setTimeout(resolve, tickMs));
      }
    }
    default:
      err('Usage: monitor.js run | heartbeat <json> | records <environment id> | forget <source> <environment id> | images - | settings -\n');
      return EXIT_INVALID;
  }
}

// Only when this file is the entry module (dist/remoteMonitor.js), not when a test imports it.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  main(process.argv.slice(2), { env: process.env }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
