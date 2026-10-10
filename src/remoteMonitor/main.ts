// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Entry point of the Session Monitor of a Docker engine (unit 7, PR 2; plan step 8, PR A: on every engine, local and
// remote; implementation notes 16). Plan step 11D2: bundled into the worker's script as the module `devenv:monitor-script`
// (scripts/workerScripts.mjs), which the worker gives the monitor container that it creates. The container
// devenv-session-monitor (image: the worker's own helper image by its monitor tag, plan step 11D3, of which the monitor
// runs only Node.js, `flock` (the lock of the records, and the environment lock of an automatic stop: stopLock.ts over
// src/core/helperChannel/lockFile.ts) and `timeout` (the run limit under the lock of the records); the Docker socket of
// its engine at /var/run/docker.sock; the volume devenv-session-monitor at /state) runs the pipe loader (plan step 3,
// src/core/loader/pipeLoader.ts): at the first start it gets the script over its standard input, stores it at
// /opt/devenv/monitor.js and calls startMonitor (`run`); after a restart it starts the stored file again. The workers run
// the other subcommands in it as `node /opt/devenv/monitor.js …` (an exec over the Engine API of an entry of the registry
// of the container scripts, monitorFlow.ts; plan step 11I, U2):
//   run                          the loop: a tick every 15 s (rules.ts); each automatic stop under the environment lock
//                                (plan step 8, PR B, D2); exits with 0 after REMOTE_IDLE_EXIT_MS without a running
//                                environment container and without a fresh record while it maintains no images (Q5;
//                                review round 1 of PR #86, A-R1-1; round 2, A-R2-1: a created one does not count);
//                                plan step 11H2 (D1 of 2026-10-09): unless it runs permanently (DEVENV_MONITOR_PERMANENT:
//                                a remote engine, or stopLocalMonitorWhenIdle off), image updates or not; and its
//                                background run (background.ts) by the schedule of cacheUpdateSchedule (CacheSchedule)
//   heartbeat <json>             writes the records of one heartbeat (exit 0; 2 for an invalid argument, nothing written)
//   forget <source> <env id>     removes that record file, valid or not (Delete of an environment)
//   forget <source> <env id> <at>  removes it only while it holds a valid record with that `at`, then prints `removed`
//                                (the loop; review round 1 of PR #63, F2; review round 4, N4-2: no other meaning of an `at`)
//   images -                     writes the image list of standard input (the image maintenance)
//   settings -                   writes the image settings of standard input (the image maintenance)
// Plan step 11I (U10, decision of 2026-10-08): the subcommand `records` is removed (only tests used it).
// It uses Node.js built-ins, small pure modules of src/core, and (plan step 11I, U1, decision of 2026-10-08) the worker's
// client of the Engine API (engine.ts: src/helperChannel/engineClient.ts over engineApi.ts): it talks to its engine over
// that socket, never through a Docker CLI. Every argument and every file it reads is checked (protocol.ts); it never acts
// on a container without the label nimblescape.devenv.environment-id, and it removes nothing but its own files (records,
// leftover temporary files of the volume; monitor cleanup, user decision 2026-09-29) and, with image maintenance, older
// images of the prefixes; plan step 11H2: and, in the shared VS Code server store that it mounts at /vscode, the server
// versions and the temporary folders that its cleanup names (background.ts). The log goes to stdout (`docker logs devenv-session-monitor`), one line per event.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID, VSCODE_STORE_DIR } from '../core/names';
import { isMissing, type EngineContainerSummary } from '../core/worker/dockerEngine';
import {
  HEARTBEAT_FOLDER,
  IMAGE_LIST_FILE,
  CACHE_RUN_FILE,
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
} from '../core/remoteMonitor/protocol';
import { engineFailure, socketEngine, type LoopEngine, type MonitorEngineParts, type VscodeEngine } from './engine';
import { BACKGROUND_ENGINE_TIMEOUT_MS, BackgroundRun, type CacheRunStore, type VscodeBackgroundDeps } from './background';
import { CLOCK_RESET_MS, parseCacheRunState, type CacheRunState } from './backgroundRules';
import { DEFAULT_CACHE_UPDATE_SCHEDULE, cacheRunDue, parseCacheSchedule, type CacheSchedule as ParsedCacheSchedule } from '../core/remoteMonitor/cacheSettings';
import { MONITOR_PERMANENT_ENV, MONITOR_VSCODE_STORE_ENV } from '../core/remoteMonitor/remoteSessionMonitor';
import type { HttpTransport } from '../core/http';
import { proxiedHttpsTransport } from '../core/proxyTransport';
import { storeLock, storeTryLock, unpackServer } from '../core/worker/vscodeServerStore';
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
import { DEFAULT_IMAGE_TIME_ZONE, isTimeZone, nextCronTime } from '../core/remoteMonitor/cron';
import {
  ImageMaintenance,
  REMOTE_IMAGE_FIRST_PASS_MS,
  parseReplacedImages,
  prefixesFromEnv,
} from './images';
import { stopLockDeps, stopLocker, type StopLocker } from './stopLock';

/** Time limit of the container list (plan step 11I, U1: of the list of the engine). */
export const LIST_TIMEOUT_MS = 30_000;
/**
 * Time limit of one stop (the container gets its own stop time, 10 s unless it sets another, before SIGKILL; plan step
 * 11I, U1: the request of the engine, as `docker stop` without a time).
 */
export const STOP_TIMEOUT_MS = 60_000;
/** A record file larger than this is not read. */
const MAX_RECORD_BYTES = 4096;
/** Exit code for an invalid argument. */
export const EXIT_INVALID = 2;

/** The folder of the records in the volume. */
export function heartbeatDir(stateDir: string = REMOTE_MONITOR_STATE_DIR): string {
  return path.join(stateDir, HEARTBEAT_FOLDER);
}

/**
 * Plan step 11I (U1, decision of 2026-10-08): the containers of the list of the engine (LoopEngine.containerSummaries, by
 * the label of an environment; review round 1 of PR #126, F1: the list as it is, no inspect) as the rules take them: the
 * ID, the state as the list names it (`running`, `exited`, `paused`, …, the word that `{{.State}}` of `docker ps`
 * printed), the name, and the environment ID and the Compose service of their labels (an empty service for the dev
 * container, as `{{.Label …}}` printed a missing label). A container with an invalid ID or environment ID is skipped (as
 * an invalid line of `docker ps` was).
 */
export function remoteContainersOf(containers: readonly EngineContainerSummary[]): RemoteContainer[] {
  const result: RemoteContainer[] = [];
  for (const container of containers) {
    const environmentId = container.labels[LABEL_ENVIRONMENT_ID];
    if (!/^[0-9a-f]{12,64}$/.test(container.id) || !isRemoteEnvironmentId(environmentId)) continue;
    result.push({ id: container.id, state: container.state, name: container.name, environmentId, composeService: container.labels[LABEL_COMPOSE_SERVICE] ?? '' });
  }
  return result;
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
 * Returns the ids of the ignored entries. The caller holds the kernel lock of the records (the entry monitorHeartbeat of
 * the registry of the container scripts runs `heartbeat` under `flock`), so two heartbeats read and replace the records
 * one after the other.
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
    // Review round 1 of PR #87 (A-R1-2): the record of a release says so (rules.ts, decide).
    const record: HeartbeatRecord = { at: now, keepRunning: environment.keepRunning, limitSeconds: input.limitSeconds, seq: environment.seq };
    if (input.release === true) record.release = true;
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
 * (the entry monitorHeartbeat), where no other heartbeat writes one. Nothing else is touched; a failure is ignored.
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
  /**
   * Plan step 11I (U1, decision of 2026-10-08): the engine of the monitor over the Engine API (engine.ts), in place of the
   * Docker CLI of its container: the list of the containers of the environments and their stops.
   */
  engine: LoopEngine;
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
   * last seen running (or Docker did not answer, which is not known to be idle); the start of the loop at first. Review
   * round 1 of PR #86, A-R1-1: also when the decision of a tick was `active` (a fresh record; review round 2 of PR #86,
   * A-R2-1: only that, no longer a `created` labelled container or a keep of an environment whose container has not
   * ended).
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
   * finished ticks saw it. A kept environment that runs counts as running. Review round 1 of PR #86, A-R1-1: nor was a
   * tick `active` (decide).
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
    const { engine, log } = this.deps;
    // Plan step 11I (U1, decision of 2026-10-08): the containers with the label of an environment, stopped ones included
    // (as `docker ps -a --filter label=…` before), from the engine within the time limit of the list; review round 1 of
    // PR #126 (F1): as its list gives them, without an inspect of each.
    let listed: EngineContainerSummary[];
    try {
      listed = await engine.containerSummaries(LABEL_ENVIRONMENT_ID, AbortSignal.timeout(LIST_TIMEOUT_MS));
    } catch (error) {
      if (!this.listFailing) log(`Docker does not answer; nothing is stopped while it does not answer. ${engineFailure(error, LIST_TIMEOUT_MS)}`);
      this.listFailing = true;
      // Plan step 8, PR B (Q5): not known to be idle.
      this.activeAt = this.monotonic();
      return [];
    }
    if (this.listFailing) log('Docker answers again.');
    this.listFailing = false;
    const containers = remoteContainersOf(listed);
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
    // Review round 1 of PR #86, A-R1-1: a fresh record (a window still sends heartbeats, for example while an open clones
    // and builds before its container exists) counts as activity too (decide: `active`). Review round 2 of PR #86, A-R2-1:
    // a `created` container or a keep alone does not, so a container left `created` for ever lets the monitor exit.
    if (decision.active) this.activeAt = this.monotonic();
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
    // Plan step 11I (U1, decision of 2026-10-08): the containers with the label of this environment from the engine (as
    // `docker ps -a --filter label=…=<id>` before), filtered by its ID again; review round 1 of PR #126 (F1): as its list
    // gives them, without an inspect of each.
    let listed: EngineContainerSummary[];
    try {
      listed = await this.deps.engine.containerSummaries(`${LABEL_ENVIRONMENT_ID}=${environmentId}`, AbortSignal.timeout(LIST_TIMEOUT_MS));
    } catch (error) {
      throw new Error(`its containers could not be listed again. ${engineFailure(error, LIST_TIMEOUT_MS)}`);
    }
    const records = (await readRecords(this.deps.dir)).filter((record) => record.environmentId === environmentId);
    const now = this.deps.now();
    const decision = decide({
      now,
      containers: remoteContainersOf(listed).filter((container) => container.environmentId === environmentId),
      records,
      state: { ...this.state, lastTickAt: now },
      timing: this.deps.timing ?? DEFAULT_REMOTE_TIMING,
    });
    const stop = decision.stop.find((entry) => entry.environmentId === environmentId);
    if (stop === undefined) this.deps.log(`${environmentId} is not stopped: a heartbeat or another change came before its lock was taken.`);
    return stop;
  }

  /**
   * The stop of the containers of one stop, the dev container first. True when all are stopped (or gone). Plan step 11I
   * (U1, decision of 2026-10-08): the stop of the engine without a time (the container's own stop time, as `docker stop`
   * without `-t`) within STOP_TIMEOUT_MS; a container that is gone (404) counts as stopped, as "no such container" of
   * the CLI did, and any other failure of the request (the engine's refusal, no answer in time, a broken connection) is
   * a failed stop, as an exit code of the CLI was.
   */
  private async stopContainers(environmentId: string, { containers, reason }: RemoteStop): Promise<boolean> {
    const { engine, log } = this.deps;
    let failed = false;
    for (const container of containers) {
      log(`Stopping the container ${container.name} of ${environmentId}: ${reason}.`);
      try {
        await engine.stop(container.id, undefined, AbortSignal.timeout(STOP_TIMEOUT_MS));
      } catch (error) {
        if (isMissing(error)) continue;
        failed = true;
        // Tried again at the next tick; logged once per series.
        if (!this.stopFailedLogged.has(environmentId)) log(`The container ${container.name} could not be stopped: ${engineFailure(error, STOP_TIMEOUT_MS)}`);
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
 * it maintains no images. Review round 1 of PR #86, A-R1-1: nor a fresh record (RemoteDecision.active), so an open whose
 * clone and build take longer than this keeps it (its window sends heartbeats for its busy mark). Review round 2 of PR
 * #86, A-R2-1: a `created` container or a keep without a running container does not keep it. The next open ensures it again (`docker start`), and
 * again right after its container started; the heartbeats of a window start it again when it is missing (their repair,
 * Q4).
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
  /**
   * Plan step 11I (U1, decision of 2026-10-08): the engine of `run` (the loop and the image maintenance); default: the
   * port over the socket of the container (socketEngine). The tests pass a fake engine.
   */
  engine?: MonitorEngineParts;
  /**
   * The images (user requests 2026-09-28): the registry, and the standard input of `images -`. Cleanup C5 (plan step
   * 11J, C1; decision of 2026-10-10): the HTTPS of the registry requests, made afresh for each pass of the images
   * (default: the proxy of the daemon of the engine, proxiedHttpsTransport, as the VS Code part and the worker).
   */
  registryTransport?: () => HttpTransport;
  readStdin?: () => Promise<string>;
  /** Review round 2 of PR #63 (R2-4): the start of the removals of `run` (recordRemover). */
  exec?: ExecFile;
  /** Plan step 8, PR B (D2): the lock of an automatic stop (default: stopLocker on the lock files of the volume). */
  lockEnvironment?: StopLocker;
  /**
   * Plan step 11H2: the VS Code part of the background run (default: vscodeBackgroundDeps of the environment and the
   * engine; the tests give their own or none).
   */
  vscodeBackground?: () => VscodeBackgroundDeps | undefined;
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
 * Review round 1 of 11H2 (reviewer B, D2): and of cache-run.json (written at the end of every background run).
 */
export const STATE_TEMPORARY_FILE = /^(images|image-settings|replaced-images|cache-run)\.json\.\d+\.\d+\.tmp$/;
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
 * instead of the daily time), 100..86400000 ms each. Plan step 11H2: of the whole background run (the first check of its
 * schedule after the start, and a fixed interval of runs instead of the schedule).
 */
export function imageTimesFromEnv(env: NodeJS.ProcessEnv): { firstMs: number; intervalMs?: number } {
  const read = (text: string | undefined) => (text !== undefined && /^\d{3,8}$/.test(text) && Number(text) >= 100 ? Number(text) : undefined);
  return { firstMs: read(env.DEVENV_IMAGE_FIRST_MS) ?? REMOTE_IMAGE_FIRST_PASS_MS, intervalMs: read(env.DEVENV_IMAGE_INTERVAL_MS) };
}

/**
 * The schedule of the passes (user request 2026-09-28, "in a guided cron style manner"): DEVENV_IMAGE_SCHEDULE (a cron
 * expression of five fields, the setting imageUpdateSchedule before plan step 11H2) in DEVENV_IMAGE_TZ (the time zone of the computer
 * that created the monitor). Invalid or missing: `7 6 * * *` (06:07) in Europe/Vienna. Plan step 11H2 (D2, decision of
 * 2026-10-09): the schedule of the whole background run, the setting cacheUpdateSchedule (parseCacheSchedule: a cron
 * expression or an interval in minutes); invalid or missing: DEFAULT_CACHE_UPDATE_SCHEDULE (every 17 minutes).
 */
export function cacheScheduleFromEnv(env: NodeJS.ProcessEnv): { schedule: ParsedCacheSchedule; timeZone: string } {
  return {
    schedule: parseCacheSchedule(env.DEVENV_IMAGE_SCHEDULE) ?? parseCacheSchedule(DEFAULT_CACHE_UPDATE_SCHEDULE)!,
    timeZone: isTimeZone(env.DEVENV_IMAGE_TZ) ? env.DEVENV_IMAGE_TZ : DEFAULT_IMAGE_TIME_ZONE,
  };
}

/** Plan step 11H2 (D1): the monitor runs permanently (DEVENV_MONITOR_PERMANENT `1`, part of its label). */
export function permanentFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env[MONITOR_PERMANENT_ENV] === '1';
}

/** The IDs of images that pulls replaced (review round 6 of PR #57, F1), in the volume. */
export const REPLACED_IMAGES_FILE = 'replaced-images.json';
/** How often the monitor looks whether a time of the schedule has come (as cron: every minute). */
export const IMAGE_CHECK_MS = 60_000;

/**
 * The settings of the image maintenance with the parsed schedule. Plan step 11H2 (D2): the schedule of the whole
 * background run (a cron expression or an interval).
 */
export interface ActiveCacheSettings extends ImageSettings {
  parsed: ParsedCacheSchedule;
}

/** Plan step 11H2: the text of the schedule for the log. */
function scheduleText({ parsed, timeZone }: ActiveCacheSettings): string {
  return parsed.kind === 'interval' ? `every ${parsed.minutes} minutes` : `at "${parsed.text}" (cron, ${timeZone})`;
}

/**
 * Review round 1 of PR #57 (C): the settings of the image maintenance: those of the container (DEVENV_IMAGE_*), or the
 * newer ones that an extension stored in the volume (`monitor.js settings -`, image-settings.json), read again before
 * each check. So another computer (another time zone, another schedule) does not replace the container. Plan step 11H2
 * (D2): the settings of the whole background run (CurrentImageSettings before).
 */
export class CurrentCacheSettings {
  value: ActiveCacheSettings;
  private stored = '';

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly stateDir: string,
    private readonly log: (message: string) => void,
  ) {
    const { schedule, timeZone } = cacheScheduleFromEnv(env);
    this.value = { prefixes: prefixesFromEnv(env), schedule: schedule.text, timeZone, parsed: schedule };
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
    this.value = { ...settings, parsed: parseCacheSchedule(settings.schedule)! };
    this.log(`Background run settings: images of ${settings.prefixes.join(', ') || 'no prefixes'}; ${scheduleText(this.value)}.`);
  }
}

/** Plan step 11H2: the state of the background run in the volume (CACHE_RUN_FILE), written atomically (writeStateFile). */
export function cacheRunStore(stateDir: string): CacheRunStore {
  const read = async (): Promise<CacheRunState> => parseCacheRunState(await fs.promises.readFile(path.join(stateDir, CACHE_RUN_FILE), 'utf8').catch(() => '{}'));
  return {
    read,
    update: async (change) => writeStateFile(stateDir, CACHE_RUN_FILE, JSON.stringify({ ...(await read()), ...change })),
  };
}

/**
 * The passes of the image maintenance by the cron schedule (user request 2026-09-28, "in a guided cron style manner"):
 * every IMAGE_CHECK_MS, a pass when a time of the schedule came since the last check. At most one pass at a time: a time
 * that comes during a pass is left out. Plan step 11H2 (D2, decision of 2026-10-09): the one schedule of the whole
 * background run (ImageSchedule before), by the setting cacheUpdateSchedule: with an interval, a run when the end of the
 * last run is at least the interval ago; with a cron schedule, a run when a time of it came after the end of the last run
 * (cacheRunDue). The end of the last run is kept in the volume (CacheRunStore), so a restart of the monitor does not run
 * again at once: at its start it runs only when the run is due by that time (never ran: due).
 */
export class CacheSchedule {
  /** The end of the last run (the stored one at first; undefined: none is known). */
  private lastEndAt: number | undefined;
  private loaded = false;
  private running = false;
  /** Review round 9 of PR #57 (T1): a check that takes longer than a minute (a slow list of the images) is not joined. */
  private checking = false;
  /** The observe of a check that runs now; a pass waits for it (review round 9, T1). */
  private observing: Promise<void> | undefined;

  constructor(
    private readonly deps: {
      now: () => number;
      log: (message: string) => void;
      settings: Pick<CurrentCacheSettings, 'value' | 'refresh'>;
      pass: () => Promise<void>;
      /** Review round 8 of PR #57 (S3): at each check while no pass runs (the IDs of the images of the repositories). */
      observe?: () => Promise<void>;
      /** Plan step 11H2: the end of the last run in the volume. */
      state: Pick<CacheRunStore, 'read' | 'update'>;
    },
  ) {}

  /** One check: a run when it is due (cacheRunDue). */
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
    if (!this.loaded) {
      this.loaded = true;
      this.lastEndAt = (await this.deps.state.read().catch((): CacheRunState => ({}))).lastEndAt;
    }
    if (!this.running && this.deps.observe) {
      this.observing = this.deps.observe().finally(() => (this.observing = undefined));
      await this.observing;
    }
    const time = this.deps.now();
    // Review round 4 of PR #57 (L1): a clock that steps back by more than CLOCK_RESET_MS behind the end of the last run (a
    // clock that was far ahead, then corrected) starts the schedule again from now; otherwise no run would come until the
    // clock caught up. Review round 2 of PR #57 (R3): a smaller step back runs no time that was handled already again.
    if (this.lastEndAt !== undefined && time < this.lastEndAt - CLOCK_RESET_MS) {
      this.deps.log(`The clock of the host went back by ${Math.round((this.lastEndAt - time) / 60_000)} minutes; the schedule of the background run goes on from now.`);
      this.lastEndAt = time;
      await this.deps.state.update({ lastEndAt: time }).catch(() => undefined);
    }
    if (this.running || !cacheRunDue(this.deps.settings.value.parsed, this.lastEndAt, time, this.deps.settings.value.timeZone)) return;
    await this.run();
    // Review round 10 of PR #57 (U1): the times of a cron schedule that came during the run are left out (logged); the
    // end of the run counts, so no second run follows at once.
    const { parsed, timeZone } = this.deps.settings.value;
    const missed = parsed.kind === 'cron' ? nextCronTime(time, parsed.cron, timeZone) : undefined;
    if (missed !== undefined && missed <= this.deps.now()) this.deps.log('A background run was still running; the times of the schedule during it are left out.');
  }

  /**
   * Review round 1 of 11H2 (A-L8): whether a run runs now; review round 2 (R1): until its end is stored. Review round 2
   * (A2-M1): the idle exit asks at each tick and never waits for the run (settled() of round 1 is gone).
   */
  get busy(): boolean {
    return this.running;
  }

  /** One run now, unless one runs; then its end is kept (in the volume too). Never throws. */
  run(): Promise<void> {
    if (this.running) {
      this.deps.log('A background run is still running; this time of the schedule is left out.');
      return Promise.resolve();
    }
    this.running = true;
    return this.runOnce();
  }

  private async runOnce(): Promise<void> {
    try {
      // Review round 9 of PR #57 (T1): not together with the observe of a check (both keep the store of IDs).
      await this.observing?.catch(() => undefined);
      await this.deps.settings.refresh();
      await this.deps.pass();
    } catch (error) {
      this.deps.log(`The background run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.loaded = true;
      this.lastEndAt = this.deps.now();
      await this.deps.state.update({ lastEndAt: this.lastEndAt }).catch((error: unknown) => {
        this.deps.log(`The end of the background run could not be stored: ${error instanceof Error ? error.message : String(error)}`);
      });
      // Review round 2 of 11H2 (reviewer B, R1): the run counts as running (busy) until its end is stored, so the idle
      // exit never ends the process during that write.
      this.running = false;
    }
  }
}

/**
 * The HTTPS of the monitor: through the proxy of the daemon of `engine` (decision C1 of 2026-10-05, as the worker; its
 * settings read once, when the first request needs them, within BACKGROUND_ENGINE_TIMEOUT_MS). Plan step 11H2: the VS
 * Code part of the background run; cleanup C5 (plan step 11J, C1; decision of 2026-10-10): the registry requests of the
 * image maintenance too.
 */
export function daemonProxyTransport(engine: Pick<VscodeEngine, 'proxy'>): ReturnType<typeof proxiedHttpsTransport> {
  return proxiedHttpsTransport(() => engine.proxy(AbortSignal.timeout(BACKGROUND_ENGINE_TIMEOUT_MS)));
}

/**
 * Plan step 11H2: the VS Code part of the background run in the container: the store that the worker mounts, read-write
 * at VSCODE_STORE_DIR (its volume named by DEVENV_VSCODE_STORE, which RemoteSessionMonitor.runSpec sets with the mount),
 * the HTTPS of the proxy of the daemon (decision C1 of 2026-10-05, as the worker), the lock of a server version with and
 * without a wait, and `tar`. Undefined without a valid store name (no store mounted).
 */
export function vscodeBackgroundDeps(
  env: NodeJS.ProcessEnv,
  engine: VscodeEngine,
  log: (message: string) => void,
  stateDir: string = REMOTE_MONITOR_STATE_DIR,
): VscodeBackgroundDeps | undefined {
  const storeVolume = env[MONITOR_VSCODE_STORE_ENV];
  if (storeVolume === undefined || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(storeVolume)) return undefined;
  return {
    store: {
      root: VSCODE_STORE_DIR,
      transport: daemonProxyTransport(engine),
      architecture: (signal) => engine.architecture(signal),
      lock: (root, name, waitSeconds, signal) => storeLock(root, name, waitSeconds, signal),
      unpack: (archive, folder, signal) => unpackServer(archive, folder, signal),
      logger: { info: log, warn: log, error: (message) => log(message), output: () => {} },
      background: true,
    },
    storeVolume,
    engine,
    tryLock: (name) => storeTryLock(VSCODE_STORE_DIR, name),
    // Review round 2 of 11H3 (A-L4): the extension lists in the run's own volume (deps.stateDir of `run` for the tests).
    extensionStateDir: stateDir,
  };
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
      // Plan step 11I (U1, decision of 2026-10-08): the engine over the socket of the container, not the Docker CLI.
      const engine = deps.engine ?? socketEngine();
      // Review round 2 of PR #63 (R2-10): the removals run /opt/devenv/monitor.js under the lock of /state, so they always
      // act on /state; deps.stateDir only moves the reading (the tests).
      // Plan step 8, PR B (D2): the lock files of the volume (as the workers open them; deps.stateDir for the tests).
      const lockEnvironment = deps.lockEnvironment ?? stopLocker(stopLockDeps(deps.stateDir ?? REMOTE_MONITOR_STATE_DIR));
      const loop = new RemoteMonitorLoop({ engine, removeRecord: recordRemover(deps.exec), dir, now, log, timing, lockEnvironment, monotonic: deps.monotonic });
      const idleExitMs = idleExitFromEnv(deps.env);
      // Plan step 3 (pipe loading): the extension waits for this line (REMOTE_MONITOR_READY_TEXT) after `docker run`.
      log(`${REMOTE_MONITOR_READY_TEXT} (Node.js ${process.version}, a check every ${tickMs / 1000} s).`);
      // Monitor cleanup, user decision 2026-09-29 (R4): the temporary files that killed writes of the volume left behind.
      // Only here, at the start of `run`: a leftover younger than STATE_TEMPORARY_MAX_AGE_MS at a start stays until the
      // next start (review round 9 of PR #63, A2).
      const leftovers = await removeStaleStateTemporaryFiles(deps.stateDir ?? REMOTE_MONITOR_STATE_DIR, now());
      if (leftovers.length > 0) log(`Removed ${leftovers.length} leftover temporary file(s) of the volume.`);
      const stateDir = deps.stateDir ?? REMOTE_MONITOR_STATE_DIR;
      // User requests 2026-09-28: the images of the prefixes, one minute after the start and then at each time of the
      // schedule. Plan step 11H2 (D2, decision of 2026-10-09): the whole background run (the images, the VS Code server,
      // the cleanup of the store) by the one schedule of the setting cacheUpdateSchedule, also without prefixes (D5: they
      // govern only the images); the first check one minute after the start runs it when it is due by the end of the last
      // run in the volume.
      const settings = new CurrentCacheSettings(deps.env, stateDir, log);
      await settings.refresh();
      const images = new ImageMaintenance({
        engine,
        registryTransport: deps.registryTransport ?? (() => daemonProxyTransport(engine)),
        log,
        prefixes: () => settings.value.prefixes,
        knownRepositories: () => readImageList(stateDir),
        // Review round 6 of PR #57 (F1): the IDs that pulls replaced, in the volume.
        replaced: {
          read: async () => parseReplacedImages(await fs.promises.readFile(path.join(stateDir, REPLACED_IMAGES_FILE), 'utf8').catch(() => '{}')),
          write: (value) => writeStateFile(stateDir, REPLACED_IMAGES_FILE, JSON.stringify(value)),
        },
      });
      const state = cacheRunStore(stateDir);
      // Plan step 11H2: the VS Code part afresh for each run (BackgroundRunDeps.vscode).
      const vscodeOf = deps.vscodeBackground ?? (() => vscodeBackgroundDeps(deps.env, engine, log, stateDir));
      const vscode = vscodeOf();
      const background = new BackgroundRun({ log, now, images: () => images.pass(), vscode: vscodeOf, state });
      const schedule = new CacheSchedule({ now, log, settings, pass: () => background.run(), observe: () => images.observe(), state });
      const { firstMs, intervalMs } = imageTimesFromEnv(deps.env);
      const permanent = permanentFromEnv(deps.env);
      log(
        `Background run (images of ${settings.value.prefixes.join(', ') || 'no prefixes'}, the VS Code server${vscode === undefined ? ' left out: no store' : ''}, the cleanup): ` +
          `first check in ${Math.round(firstMs / 1000)} s, then ${scheduleText(settings.value)}; ${permanent ? 'runs permanently' : `ends after ${Math.round(idleExitMs / 1000)} s without a running environment`}.`,
      );
      // Unreferenced: the loop below keeps the process; a monitor that exits when idle does not wait for them.
      setTimeout(() => {
        // The Docker tests: a fixed interval (DEVENV_IMAGE_INTERVAL_MS) of runs instead of the schedule.
        if (intervalMs !== undefined) {
          void schedule.run();
          setInterval(() => void schedule.run(), intervalMs).unref?.();
        } else {
          void schedule.check();
          setInterval(() => void schedule.check(), IMAGE_CHECK_MS).unref?.();
        }
      }, firstMs).unref?.();
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      // Review round 2 of 11H2 (reviewer A, A2-M1): the wait for a run is logged once per idle time.
      let waitLogged = false;
      for (;;) {
        await loop.tick();
        // Plan step 8, PR B (Q5): only here, between two ticks, so never while it holds a lock or stops a container; the
        // removals of the records (each under the lock of the records) end first. The records stay in the volume. Plan
        // step 11H2 (D1 of 2026-10-09): a permanent monitor (a remote engine, or stopLocalMonitorWhenIdle off) never exits
        // when idle; one that ends when idle does so also with image updates (before, they kept it).
        if (!permanent && loop.idleMs() >= idleExitMs) {
          // Review round 1 of 11H2 (A-L8): not during a background run (a download would be cut, and its end not stored).
          // Review round 2 of 11H2 (reviewer A, A2-M1): the loop does not wait for the run: it goes on ticking (the stops of
          // environments whose windows closed, the heartbeats) and exits at the first idle tick after the run's end.
          if (schedule.busy) {
            if (!waitLogged) log('No environment container runs, but a background run is running; the Session Monitor exits after its end.');
            waitLogged = true;
            await sleep(tickMs);
            continue;
          }
          await loop.removals;
          // Review round 3 of 11H2 (reviewer A, A3-L1; reviewer B, D1): the timer of the schedule can start a run while the
          // removals end, so the exit looks again; the next idle tick waits for that run as above.
          if (schedule.busy) continue;
          // Review round 1 of PR #86, A-R1-1: the text names the fresh heartbeats too.
          log(`No environment container ran and no heartbeat was fresh for ${Math.round(idleExitMs / 1000)} s, and it does not run permanently; the Session Monitor exits. The next open starts it again.`);
          return 0;
        }
        waitLogged = false;
        await sleep(tickMs);
      }
    }
    default:
      // Plan step 11I (U10, decision of 2026-10-08): `records` is no subcommand any more.
      err('Usage: monitor.js run | heartbeat <json> | forget <source> <environment id> [<at>] | images - | settings -\n');
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
