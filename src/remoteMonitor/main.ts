// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Entry point of the Session Monitor on a remote Docker host (unit 7, PR 2; implementation notes 16), bundled to
// dist/remoteMonitor.js. The container devenv-session-monitor (image: the workspace helper, which has Node.js and the
// Docker CLI; the Docker socket of its engine; the volume devenv-session-monitor at /state) runs the pipe loader (plan step
// 3, src/core/loader/pipeLoader.ts): at the first start it gets the script over its standard input, stores it at
// /opt/devenv/monitor.js and calls startMonitor (`run`); after a restart it starts the stored file again. The computers
// run the other subcommands with `docker exec node /opt/devenv/monitor.js …`:
//   run                          the loop: a tick every 15 s (rules.ts); each automatic stop under the environment lock
//                                (plan step 8, PR B, D2); exits with 0 after REMOTE_IDLE_EXIT_MS without a running
//                                environment container while it maintains no images (Q5)
//   heartbeat <json>             writes the records of one heartbeat (exit 0; 2 for an invalid argument, nothing written)
//   records <environment id>     prints { now, records: [{ source, at, keepRunning }] } of that environment
//   forget <source> <env id>     removes that record file, valid or not (Delete of an environment)
//   forget <source> <env id> <at>  removes it only while it holds a valid record with that `at`, then prints `removed`
//                                (the loop; review round 1 of PR #63, F2; review round 4, N4-2: no other meaning of an `at`)
// It uses only Node.js built-ins and small pure modules of src/core. Every argument and every file it reads is checked
// (protocol.ts); it never acts on a container without the label nimblescape.devenv.environment-id, and it removes
// nothing but its own files (records, leftover temporary files of the volume; monitor cleanup, user decision 2026-09-29)
// and, with image maintenance, older images of the prefixes. The log goes to stdout (`docker logs devenv-session-monitor`), one line per event.
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
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_STATE_DIR,
  SEQ_ORDER_WINDOW_MS,
  forgetIfUnchangedCommand,
  heartbeatFileName,
  isRemoteEnvironmentId,
  isSourceId,
  monitorExecFailure,
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
  isRunningState,
  type RemoteContainer,
  type RemoteStop,
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
import { stopLockDeps, stopLocker, type StopLocker } from './stopLock';

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
 * valid record. Everything else is ignored, and not removed. A missing folder has none. Review round 4 of PR #63 (N4-1):
 * R3-9 reverted: a file with such a name but no valid record may be a record in a newer format of a running environment
 * (monitors of different versions on one engine), so the loop never removes it; Delete's plain forget removes it by name.
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

/**
 * Writes the records of one heartbeat, each atomically (a temporary file, then a rename), with mode 0600. An entry is
 * ignored (no write, the record stays as it is):
 * - when its `seq` is lower than the `seq` of the existing record of the same source and that record is at most
 *   SEQ_ORDER_WINDOW_MS old (review round 2 of PR #39, L1, and round 3, N2): the newer choice of that computer stays,
 *   while an older record is replaced whatever its `seq` (a clock of the computer that was set back);
 * - when it is `clearOnly` and the existing record of the same source does not say keepRunning (review round 3, N1):
 *   it only withdraws a keep of this source, and must not create or refresh a record.
 * Returns the ids of the ignored entries. The caller holds the kernel lock of the records (heartbeatCommand runs
 * `heartbeat` under `flock`), so two heartbeats read and replace the records one after the other.
 */
export async function writeHeartbeat(dir: string, input: HeartbeatInput, now: number): Promise<string[]> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await removeLeftoverTemporaryFiles(dir);
  const ignored: string[] = [];
  for (const environment of input.environments) {
    const name = heartbeatFileName(input.source, environment.id);
    const file = path.join(dir, name);
    const existing = await readRecordFile(file);
    const olderEntry = existing !== undefined && existing.seq > environment.seq && Math.abs(now - existing.at) <= SEQ_ORDER_WINDOW_MS;
    const nothingToClear = environment.clearOnly === true && existing?.keepRunning !== true;
    if (olderEntry || nothingToClear) {
      ignored.push(environment.id);
      continue;
    }
    const temp = path.join(dir, `.${name}.${process.pid}.tmp`);
    const record = { at: now, keepRunning: environment.keepRunning, limitSeconds: input.limitSeconds, seq: environment.seq };
    try {
      await fs.promises.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
      await fs.promises.rename(temp, file);
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return ignored;
}

/**
 * Review round 3 of PR #58 (F5): removes the temporary files of heartbeats that were killed between the write and the
 * rename (`timeout -s KILL`, a killed container), `.<record name>.<pid>.tmp`. Only under the lock of the records
 * (heartbeatCommand), where no other heartbeat writes one. Nothing else is touched; a failure is ignored.
 */
async function removeLeftoverTemporaryFiles(dir: string): Promise<void> {
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const match = /^\.(.+)\.[0-9]+\.tmp$/.exec(name);
    if (match && parseHeartbeatFileName(match[1])) await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
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

/**
 * Removes one record. Review round 1 of PR #63 (F2): with `at`, only while the file holds a record with that `at` (the
 * caller holds the lock of the records). With `at`: true when it removed the file, false when the file is missing or does
 * not hold a record with that `at` (review round 4 of PR #63, N4-1: R3-9 reverted). Without `at`: removes it if present,
 * always true (review round 9 of PR #63, B7).
 */
export async function removeRecord(dir: string, source: string, environmentId: string, at?: number): Promise<boolean> {
  const file = path.join(dir, heartbeatFileName(source, environmentId));
  if (at !== undefined && (await readRecordFile(file))?.at !== at) return false;
  await fs.promises.rm(file, { force: true });
  return true;
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

/**
 * Review round 1 of PR #63 (F2): removes an old record that `decide` named, under the lock of the records and only while
 * the file still holds it (the `at` it read). True when it removed it.
 */
export type RecordRemover = (record: RemoteRecord) => Promise<boolean>;

/** The time limit of a removal: the wait for the lock and the run limit (protocol.ts), plus the start of Node.js. */
export const FORGET_TIMEOUT_MS = 20_000;

/** The part of execFile that recordRemover uses (review round 2 of PR #63, R2-4: the tests pass their own). */
export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: { code?: string | number | null; killed?: boolean; signal?: string | null; message: string } | null, stdout: string, stderr: string) => void,
) => unknown;

/**
 * Runs `forget <source> <env id> <at>` of this script under the lock of the records (forgetIfUnchangedCommand). Review
 * round 2 of PR #63 (R2-2): a timeout and a failed start (a string code such as ENOENT) say so, not "exit code null".
 * Review round 3 (R3-2): the timeout kills only `flock`, whose child may still remove the record, so the text says so;
 * another signal is named.
 */
export const recordRemover =
  (exec: ExecFile = execFile): RecordRemover =>
  (record) =>
    new Promise((resolve, reject) => {
      const [file, ...args] = forgetIfUnchangedCommand(record.source, record.environmentId, record.at);
      exec(file, args, { timeout: FORGET_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) resolve(String(stdout).trim() === 'removed');
        else if (error.killed) reject(new Error(`no answer within ${FORGET_TIMEOUT_MS / 1000} s (it may still end)`));
        else if (error.signal) reject(new Error(`killed by ${error.signal}`));
        else reject(new Error(typeof error.code === 'string' ? error.message : monitorExecFailure(error.code ?? null, String(stderr), true)));
      });
    });

export interface RemoteLoopDeps {
  docker: DockerRunner;
  /** Removes an old record (recordRemover); the tests remove it in the process. */
  removeRecord: RecordRemover;
  /** The folder of the records. */
  dir: string;
  now: () => number;
  log: (message: string) => void;
  timing?: RemoteTiming;
  /**
   * Plan step 8, PR B (user decision D2): the environment lock of an automatic stop, without waiting (stopLock.ts). An
   * environment is stopped only while the monitor holds its lock.
   */
  lockEnvironment: StopLocker;
  /**
   * Plan step 8, PR B (Q5): a monotonic clock in ms for the idle time of the monitor (default `performance.now()`, which
   * a step of the wall clock does not move).
   */
  monotonic?: () => number;
}

/** The loop of `run`: one `tick()` per interval. The log names each event once, not every tick. */
export class RemoteMonitorLoop {
  private state: RemoteMonitorState = initialRemoteState();
  private listFailing = false;
  /** Env ids whose "keeps running" was logged; env ids whose failed stop was logged. */
  private readonly keptLogged = new Set<string>();
  private readonly stopFailedLogged = new Set<string>();
  /**
   * Review round 2 of PR #63 (R2-3): the records (`<source>.<env id>.<at>`) whose failed removal was logged. Like
   * stopFailedLogged, it is kept across a tick that ends early (review round 3, R3-8).
   */
  private removeFailedLogged = new Set<string>();
  private graceLogged = false;
  /**
   * Plan step 8, PR B (D2): env ids whose lock was busy at the last tick that wanted to stop them (logged once per busy
   * streak), and those whose lock file could not be opened or locked (logged once per streak).
   */
  private busyLogged = new Set<string>();
  private lockFailedLogged = new Set<string>();
  /**
   * Plan step 8, PR B (Q5): the monotonic time at which a container with the label nimblescape.devenv.environment-id was
   * last seen running (or Docker did not answer, which is not known to be idle); the start of the loop at first.
   */
  private activeAt: number;
  /**
   * Review round 4 of PR #63 (N4-5): the pass of removals that runs in the background, at most one at a time. Never
   * rejects (each removal catches its error). Read by the tests through `removals`.
   */
  private removing?: Promise<void>;

  constructor(private readonly deps: RemoteLoopDeps) {
    this.activeAt = this.monotonic();
  }

  private monotonic(): number {
    return (this.deps.monotonic ?? (() => performance.now()))();
  }

  /**
   * Plan step 8, PR B (Q5): how long (ms) no container with the label nimblescape.devenv.environment-id ran, as the
   * finished ticks saw it. A kept environment that runs counts as running.
   */
  idleMs(): number {
    return this.monotonic() - this.activeAt;
  }

  get currentState(): RemoteMonitorState {
    return this.state;
  }

  /** The pass of removals that runs now, if any (for the tests). */
  get removals(): Promise<void> | undefined {
    return this.removing;
  }

  /** One tick; returns the environments whose containers were stopped. Never throws. */
  async tick(): Promise<string[]> {
    const { docker, log } = this.deps;
    const listed = await docker(['ps', '-a', '--no-trunc', '--filter', `label=${LABEL_ENVIRONMENT_ID}`, '--format', PS_FORMAT], LIST_TIMEOUT_MS);
    if (listed.code !== 0) {
      if (!this.listFailing) log(`Docker does not answer; nothing is stopped while it does not answer. ${listed.stderr.trim()}`);
      this.listFailing = true;
      // Plan step 8, PR B (Q5): not known to be idle.
      this.activeAt = this.monotonic();
      return [];
    }
    if (this.listFailing) log('Docker answers again.');
    this.listFailing = false;
    const containers = parseContainerLines(listed.stdout);
    const anyRunning = containers.some((container) => isRunningState(container.state));
    // Plan step 8, PR B (Q5): also when the records cannot be read below.
    if (anyRunning) this.activeAt = this.monotonic();
    let records: RemoteRecord[];
    try {
      records = await readRecords(this.deps.dir);
    } catch (error) {
      log(`The heartbeat records could not be read; nothing is stopped. ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const decision = decide({
      now: this.deps.now(),
      containers,
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

    // Plan step 8, PR B (user decision D2): each stop under the lock of its environment, taken without a wait. A busy lock
    // (an operation of a window, or a Stop or Delete) skips the environment in this tick (logged once per busy streak); a
    // lock that cannot be opened or taken skips it too (logged once per streak): never a stop without the lock. Under the
    // lock, its containers and records are read again and decided again (the newest record decides), so a heartbeat or a
    // Start that came before the lock was taken is seen; then the stop (the dev container first) and the release.
    const stopped: string[] = [];
    const busy = new Set<string>();
    const lockFailed = new Set<string>();
    for (const { environmentId } of decision.stop) {
      const attempt = await this.deps.lockEnvironment(environmentId);
      if (attempt.kind === 'busy') {
        busy.add(environmentId);
        if (!this.busyLogged.has(environmentId)) log(`${environmentId} is busy with an operation; it is not stopped now and is checked again at the next tick.`);
        continue;
      }
      if (attempt.kind === 'failed') {
        lockFailed.add(environmentId);
        if (!this.lockFailedLogged.has(environmentId)) log(`The lock of ${environmentId} could not be taken; it is not stopped. ${attempt.detail}`);
        continue;
      }
      try {
        const again = await this.decideAgain(environmentId);
        if (again === undefined) continue;
        if (await this.stopContainers(environmentId, again)) stopped.push(environmentId);
      } catch (error) {
        log(`${environmentId} is not stopped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        attempt.release();
      }
    }
    this.busyLogged = busy;
    this.lockFailedLogged = lockFailed;
    // Plan step 8, PR B (Q5): measured again when the stops are done, so a long stop is no idle time.
    if (anyRunning) this.activeAt = this.monotonic();

    // Monitor cleanup, user decision 2026-09-29 (R1): the log line names why a record is removed. Review round 1 of PR #63
    // (F2): each under the lock of the records and only while the file still holds the record that `decide` saw, so a
    // heartbeat written since stays. Review round 2 (R2-1): after the stops, which a removal (up to FORGET_TIMEOUT_MS each)
    // would otherwise delay; the `at` check makes a late removal safe. A failed one is logged once per series (R2-3).
    // Review round 4 of PR #63 (N4-5): R3-1 replaced. The removals run in the background, one pass at a time, and never
    // lengthen a tick (a long one would make the next tick a gap, which holds every stop). A tick that reaches the end of
    // its stops while no pass runs starts the next one, with the records it read at its start; a duplicate removal finds a
    // missing file or another `at` and does nothing; the "Removed…" line comes when the removal ends. A removed record
    // never matters to a stop: a superseded one is never the newest, and (review round 5, R5-6) the forgotten ones of an
    // environment go oldest first (a keep last of equal `at`; review round 6, R6-1: in the order of `decide`, by the times
    // as the rules see them, clamped), and after one that is not removed the rest of it stay, so the newest records of an
    // environment stay until all are gone, even if containers of it are created meanwhile.
    const removals = [
      ...decision.forget.map((record) => ({ record, reason: 'no container of it exists', forget: true })),
      ...decision.superseded.map((record) => ({ record, reason: 'a newer record of it exists', forget: false })),
    ];
    this.removing ??= (async () => {
      const failing = new Set<string>();
      const held = new Set<string>();
      for (const { record, reason, forget } of removals) {
        const key = `${record.source}.${record.environmentId}.${record.at}`;
        // Review round 6 of PR #63 (R6-3): a skipped record keeps its logged failure.
        if (forget && held.has(record.environmentId)) {
          if (this.removeFailedLogged.has(key)) failing.add(key);
          continue;
        }
        let removed = false;
        try {
          removed = await this.deps.removeRecord(record);
          if (removed) log(`Removed the old record of ${record.environmentId} (${reason}).`);
        } catch (error) {
          if (!this.removeFailedLogged.has(key)) log(`The old record of ${record.environmentId} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
          failing.add(key);
        }
        if (!removed) held.add(record.environmentId);
      }
      this.removeFailedLogged = failing;
    })().finally(() => (this.removing = undefined));
    return stopped;
  }

  /**
   * Plan step 8, PR B (D2): under the lock of `environmentId`, its containers and records read again and decided again
   * with the state of this tick (no new gap: the time since the start of the tick is no pause). The stop of `decide` for
   * it, or undefined (logged) when it is no longer to be stopped. Throws when the containers or the records cannot be
   * read (no stop).
   */
  private async decideAgain(environmentId: string): Promise<RemoteStop | undefined> {
    const listed = await this.deps.docker(
      ['ps', '-a', '--no-trunc', '--filter', `label=${LABEL_ENVIRONMENT_ID}=${environmentId}`, '--format', PS_FORMAT],
      LIST_TIMEOUT_MS,
    );
    if (listed.code !== 0) throw new Error(`its containers could not be listed again. ${listed.stderr.trim()}`);
    const records = (await readRecords(this.deps.dir)).filter((record) => record.environmentId === environmentId);
    const now = this.deps.now();
    const decision = decide({
      now,
      containers: parseContainerLines(listed.stdout).filter((container) => container.environmentId === environmentId),
      records,
      state: { ...this.state, lastTickAt: now },
      timing: this.deps.timing ?? DEFAULT_REMOTE_TIMING,
    });
    const stop = decision.stop.find((entry) => entry.environmentId === environmentId);
    if (stop === undefined) this.deps.log(`${environmentId} is not stopped: a heartbeat or another change came before its lock was taken.`);
    return stop;
  }

  /** `docker stop` of the containers of one stop, the dev container first. True when all are stopped (or gone). */
  private async stopContainers(environmentId: string, { containers, reason }: RemoteStop): Promise<boolean> {
    const { docker, log } = this.deps;
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
    if (failed) this.stopFailedLogged.add(environmentId);
    else this.stopFailedLogged.delete(environmentId);
    return !failed;
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

/**
 * Plan step 8, PR B (user decision Q5 of 2026-10-02): the monitor exits (code 0, so the restart policy `on-failure`
 * leaves it exited) after this time without a running container with the label nimblescape.devenv.environment-id, when
 * it maintains no images. The next open ensures it again (`docker start`), and the heartbeats of a window start it again
 * when it is missing (their repair, Q4).
 */
export const REMOTE_IDLE_EXIT_MS = 5 * 60_000;

/**
 * The idle time of the tests of the container (DEVENV_MONITOR_IDLE_MS, 100..86400000 ms); without it, or with another
 * value, REMOTE_IDLE_EXIT_MS.
 */
export function idleExitFromEnv(env: NodeJS.ProcessEnv): number {
  const text = env.DEVENV_MONITOR_IDLE_MS;
  if (text !== undefined && /^\d{3,8}$/.test(text) && Number(text) >= 100 && Number(text) <= 86_400_000) return Number(text);
  return REMOTE_IDLE_EXIT_MS;
}

export interface MainDeps {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  docker?: DockerRunner;
  /** The images (user requests 2026-09-28): the registry, and the standard input of `images -`. */
  httpGet?: HttpGet;
  readStdin?: () => Promise<string>;
  /** Review round 2 of PR #63 (R2-4): the start of the removals of `run` (recordRemover). */
  exec?: ExecFile;
  /** Plan step 8, PR B (D2): the lock of an automatic stop (default: stopLocker on the lock files of the volume). */
  lockEnvironment?: StopLocker;
  /** Plan step 8, PR B (Q5): the monotonic clock of the idle time, and the wait between two ticks (the tests). */
  monotonic?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
let temporaryFiles = 0;

async function writeStateFile(stateDir: string, name: string, text: string): Promise<void> {
  const file = path.join(stateDir, name);
  // Review round 9 of PR #57 (T1): a name of its own for each write, so two writes at the same time never mix.
  const temporary = `${file}.${process.pid}.${++temporaryFiles}.tmp`;
  try {
    await fs.promises.writeFile(temporary, text, { mode: 0o600 });
    await fs.promises.rename(temporary, file);
  } finally {
    // Review round 10 of PR #57 (U2): a failed write (a full volume) leaves no temporary file behind.
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Monitor cleanup, user decision 2026-09-29 (R4): the temporary files of writeStateFile
 * (`<name>.<pid>.<count>.tmp` of images.json, image-settings.json, replaced-images.json) that a killed write left behind.
 */
export const STATE_TEMPORARY_FILE = /^(images|image-settings|replaced-images)\.json\.\d+\.\d+\.tmp$/;
/**
 * Such a file whose modification time is more than this from now is removed at the start of `run` (only then: a younger
 * one stays until the next start; review round 9 of PR #63, A2).
 */
export const STATE_TEMPORARY_MAX_AGE_MS = 60 * 60_000;

/**
 * Monitor cleanup, user decision 2026-09-29 (R4): removes the leftover temporary files of writeStateFile in the volume whose
 * modification time is more than STATE_TEMPORARY_MAX_AGE_MS from now, in either direction (review round 3 of PR #63,
 * R3-7; a younger one may belong to a write that runs now). Only regular files with
 * such a name, never a link; every error is ignored. Returns the names it removed.
 */
export async function removeStaleStateTemporaryFiles(stateDir: string, now: number): Promise<string[]> {
  const removed: string[] = [];
  const names = await fs.promises.readdir(stateDir).catch(() => [] as string[]);
  for (const name of names) {
    if (!STATE_TEMPORARY_FILE.test(name)) continue;
    const file = path.join(stateDir, name);
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || Math.abs(now - stat.mtimeMs) <= STATE_TEMPORARY_MAX_AGE_MS) continue;
      await fs.promises.unlink(file);
      removed.push(name);
    } catch {
      // Removed meanwhile, or not removable: left alone.
    }
  }
  return removed;
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
 * expression of five fields, the setting imageUpdateSchedule) in DEVENV_IMAGE_TZ (the time zone of the computer
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
  /** Review round 9 of PR #57 (T1): a check that takes longer than a minute (a slow `docker image ls`) is not joined. */
  private checking = false;
  /** The observe of a check that runs now; a pass waits for it (review round 9, T1). */
  private observing: Promise<void> | undefined;

  constructor(
    private readonly deps: {
      now: () => number;
      log: (message: string) => void;
      settings: Pick<CurrentImageSettings, 'value' | 'refresh'>;
      pass: () => Promise<void>;
      /** Review round 8 of PR #57 (S3): at each check while no pass runs (the IDs of the images of the repositories). */
      observe?: () => Promise<void>;
    },
  ) {
    this.checkedUntil = deps.now();
  }

  /** One check: a pass when a time of the schedule lies after the previous check and not after now. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.checkOnce();
    } finally {
      this.checking = false;
    }
  }

  private async checkOnce(): Promise<void> {
    await this.deps.settings.refresh();
    if (!this.running && this.deps.observe) {
      this.observing = this.deps.observe().finally(() => (this.observing = undefined));
      await this.observing;
    }
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
    if (due === undefined || due > time) return;
    await this.run();
    // Review round 10 of PR #57 (U1): the times of the schedule that came during the pass are left out (logged); the
    // checks of those minutes were not run (`checking`), so without this a second pass would follow at once.
    const after = this.deps.now();
    const missed = nextCronTime(time, cron, timeZone);
    if (missed !== undefined && missed <= after) this.deps.log('An image update was still running; the times of the schedule during it are left out.');
    this.checkedUntil = Math.max(this.checkedUntil, after);
  }

  /** One pass now, unless one runs. Never throws. */
  async run(): Promise<void> {
    if (this.running) {
      this.deps.log('An image update is still running; this time of the schedule is left out.');
      return;
    }
    this.running = true;
    try {
      // Review round 9 of PR #57 (T1): not together with the observe of a check (both keep the store of IDs).
      await this.observing?.catch(() => undefined);
      await this.deps.settings.refresh();
      await this.deps.pass();
    } catch (error) {
      this.deps.log(`The images could not be maintained: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}

/**
 * Runs one subcommand of `argv` (without node and the script). Resolves with the exit code; `run` resolves only when the
 * monitor is idle (plan step 8, PR B, Q5), with 0.
 */
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
      // Review round 1 of PR #63 (F2): optionally the `at` of the record as the loop read it.
      const at = args.length === 3 && /^\d{1,16}$/.test(args[2]) ? Number(args[2]) : undefined;
      if (args.length < 2 || (args.length > 2 && !Number.isSafeInteger(at)) || !isSourceId(args[0]) || !isRemoteEnvironmentId(args[1])) {
        err('Invalid record.\n');
        return EXIT_INVALID;
      }
      if ((await removeRecord(dir, args[0], args[1], at)) && at !== undefined) out('removed\n');
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
      // Review round 2 of PR #63 (R2-10): the removals run /opt/devenv/monitor.js under the lock of /state, so they always
      // act on /state; deps.stateDir only moves the reading (the tests).
      // Plan step 8, PR B (D2): the lock files of the volume (as the workers open them; deps.stateDir for the tests).
      const lockEnvironment = deps.lockEnvironment ?? stopLocker(stopLockDeps(deps.stateDir ?? REMOTE_MONITOR_STATE_DIR));
      const loop = new RemoteMonitorLoop({ docker, removeRecord: recordRemover(deps.exec), dir, now, log, timing, lockEnvironment, monotonic: deps.monotonic });
      const idleExitMs = idleExitFromEnv(deps.env);
      // Plan step 3 (pipe loading): the extension waits for this line (REMOTE_MONITOR_READY_TEXT) after `docker run`.
      log(`${REMOTE_MONITOR_READY_TEXT} (Node.js ${process.version}, a check every ${tickMs / 1000} s).`);
      // Monitor cleanup, user decision 2026-09-29 (R4): the temporary files that killed writes of the volume left behind.
      // Only here, at the start of `run`: a leftover younger than STATE_TEMPORARY_MAX_AGE_MS at a start stays until the
      // next start (review round 9 of PR #63, A2).
      const leftovers = await removeStaleStateTemporaryFiles(deps.stateDir ?? REMOTE_MONITOR_STATE_DIR, now());
      if (leftovers.length > 0) log(`Removed ${leftovers.length} leftover temporary file(s) of the volume.`);
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
        const schedule = new ImageSchedule({ now, log, settings, pass: () => images.pass(), observe: () => images.observe() });
        log(`Image updates of ${settings.value.prefixes.join(', ')}: in ${Math.round(firstMs / 1000)} s, then at "${settings.value.schedule}" (cron, ${settings.value.timeZone}).`);
        setTimeout(() => void schedule.run(), firstMs);
        // The Docker tests: a fixed interval (DEVENV_IMAGE_INTERVAL_MS) instead of the schedule.
        if (intervalMs !== undefined) setInterval(() => void schedule.run(), intervalMs);
        else setInterval(() => void schedule.check(), IMAGE_CHECK_MS);
      }
      // Plan step 8, PR B (Q5): with image maintenance, the monitor never exits by itself.
      const maintainsImages = prefixesFromEnv(deps.env).length > 0;
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      for (;;) {
        await loop.tick();
        // Plan step 8, PR B (Q5): only here, between two ticks, so never while it holds a lock or stops a container; the
        // removals of the records (each under the lock of the records) end first. The records stay in the volume.
        if (!maintainsImages && loop.idleMs() >= idleExitMs) {
          await loop.removals;
          log(`No environment container ran for ${Math.round(idleExitMs / 1000)} s and image updates are off; the Session Monitor exits. The next open starts it again.`);
          return 0;
        }
        await sleep(tickMs);
      }
    }
    default:
      err('Usage: monitor.js run | heartbeat <json> | records <environment id> | forget <source> <environment id> [<at>] | images - | settings -\n');
      return EXIT_INVALID;
  }
}

/** What runEntry needs of the process (the tests give their own). */
export interface EntryDeps {
  onSignal(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  exit(code: number): void;
  err(text: string): void;
  main(argv: readonly string[]): Promise<number>;
}

function processEntryDeps(): EntryDeps {
  return {
    onSignal: (signal, listener) => process.on(signal, listener),
    exit: (code) => process.exit(code),
    err: (text) => process.stderr.write(text),
    main: (argv) => main(argv, { env: process.env }),
  };
}

/**
 * Runs the subcommand `argv` as the program of this process: SIGTERM and SIGINT end it with 0 (`docker stop`), the exit
 * code of the subcommand ends it, a failure ends it with 1.
 */
export function runEntry(argv: readonly string[], deps: EntryDeps = processEntryDeps()): Promise<void> {
  deps.onSignal('SIGTERM', () => deps.exit(0));
  deps.onSignal('SIGINT', () => deps.exit(0));
  return deps.main(argv).then(
    (code) => deps.exit(code),
    (error: unknown) => {
      deps.err(`${error instanceof Error ? error.message : String(error)}\n`);
      deps.exit(1);
    },
  );
}

/**
 * Plan step 3 (pipe loading): the function that the pipe loader of the container starts (REMOTE_MONITOR_ENTRY), at the
 * first start and after each restart: the loop (`run`). `_input`: what the loader read after the script (nothing is
 * expected; the standard input is not read).
 */
export function startMonitor(_input = '', deps: EntryDeps = processEntryDeps()): void {
  void runEntry(['run'], deps);
}

// Only when this file is the entry module (`docker exec … node /opt/devenv/monitor.js <subcommand>`), not when the loader
// or a test loads it.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void runEntry(process.argv.slice(2));
}
