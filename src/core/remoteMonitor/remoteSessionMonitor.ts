// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Session Monitor container on a Docker engine (unit 7, PR 2; implementation notes 16; plan step 8, PR A: on every
// engine, local and remote): its ensure. Plan step 11D2 (decision of 2026-10-03): it runs in the worker of the engine,
// over the port MonitorEngine (the Engine API, src/core/worker/engineMonitor.ts); before, the extension ran it with the
// Docker CLI. The windows send their heartbeats through the operation `heartbeat` (11D1). No `vscode`.
//
// Plan step 3 (pipe loading, user decisions 2026-09-29): the container runs the pipe loader; the script is never an
// argument or a variable. The create writes the script as the first line of the container's input, waits for the
// monitor's REMOTE_MONITOR_READY_TEXT, then closes its input (the container goes on). The loader stores the script at
// REMOTE_MONITOR_SCRIPT_PATH, so a restart of the container resumes from it without input. Neither the script line nor
// any other input is logged.
import { randomUUID } from 'crypto';
import { errorMessage } from '../errors';
import { LOADER_EXIT_CODE, MAX_BUNDLE_LINE_LENGTH, bundleHash, encodeBundle, loaderCommand } from '../loader/pipeLoader';
import { abortError, isAbortError, type Logger } from '../ports';
import { VSCODE_STORE_DIR } from '../names';
import { IDLE_MONITOR_RESTART_POLICY, monitorRestartPolicy } from './cacheSettings';
import type { MonitorEngine, MonitorInspected, MonitorRunSpec } from './monitorEngine';
import {
  LABEL_MONITOR_CREATE,
  LABEL_SESSION_MONITOR,
  REMOTE_MONITOR_CONTAINER,
  REMOTE_MONITOR_ENTRY,
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_SCRIPT_PATH,
  REMOTE_MONITOR_STATE_DIR,
  REMOTE_MONITOR_VOLUME,
  PERMANENT_LOCAL_LABEL_PART,
  PERMANENT_REMOTE_LABEL_PART,
  monitorModeOf,
  remoteMonitorLabelValue,
  vscodeStoreLabelPart,
  type MonitorMode,
  type MonitorSettings,
} from './protocol';

/** Time limit of each Docker call of ensure (an SSH connection plus the call). */
export const REMOTE_MONITOR_DOCKER_TIMEOUT_MS = 60_000;
/** Time limit of the check of the stored script (a process in the container). */
export const REMOTE_MONITOR_EXEC_TIMEOUT_MS = 20_000;

/**
 * Monitor cleanup, user decision 2026-09-29 (R5): the log of the monitor container, `docker logs` of at most about 2 MB.
 * Not part of the label (remoteMonitorLabelValue covers the script, the helper tag and whether it maintains images): a
 * running monitor keeps its log settings until it is replaced for another reason.
 */
export const REMOTE_MONITOR_LOG: MonitorRunSpec['log'] = { driver: 'json-file', maxSize: '1m', maxFile: '2' };

/**
 * Plan step 8, PR B (Q5): the restart policy of the monitor container (see runArgs). Every monitor of an older version
 * is replaced at the next open, as its script, and so its label, changed with this policy. Plan step 11H2 (the user's
 * decision "unless-stopped" of 2026-10-09): the policy of a monitor that ends when idle; a permanent one has
 * `unless-stopped` (monitorRestartPolicy).
 */
export const MONITOR_RESTART_POLICY = IDLE_MONITOR_RESTART_POLICY;

export interface RemoteSessionMonitorOptions {
  /** Plan step 11D2: the engine of the monitor (the worker's, over the Engine API). */
  engine: MonitorEngine;
  logger: Logger;
  /** The script of the monitor (plan step 11D2: the module `devenv:monitor-script` of the worker's bundle). */
  script: () => Promise<string>;
  /**
   * User requests 2026-09-28: the image maintenance of the monitor: the prefixes of the images that it updates and cleans
   * (the setting imageUpdates, a trailing `*` dropped; none: no image maintenance), the schedule (a cron expression,
   * the setting imageUpdateSchedule), and the time zone of this computer. Plan step 11H2 (D1 and D2 of 2026-10-09): the
   * schedule of its whole background run (the setting cacheUpdateSchedule: a cron expression or an interval in minutes),
   * and whether it runs permanently.
   */
  imageMaintenance?: () => ImageMaintenanceSettings;
  /**
   * Plan step 11H2: the shared VS Code server store of the engine (the volume that the worker mounts at VSCODE_STORE_DIR,
   * OwnHelper.vscodeStore), which the monitor mounts there too; none: the monitor has no store, and its background run
   * leaves the VS Code server out.
   */
  vscodeStoreVolume?: string;
  /** Only for the Docker tests: another container and volume name, more labels, and variables of the container. */
  containerName?: string;
  volumeName?: string;
  labels?: Readonly<Record<string, string>>;
  containerEnv?: Readonly<Record<string, string>>;
}

/** See RemoteSessionMonitorOptions.imageMaintenance. */
export interface ImageMaintenanceSettings {
  prefixes: readonly string[];
  /**
   * A cron expression of five fields (user request 2026-09-28, "in a guided cron style manner"). Plan step 11H2 (D2): or
   * an interval in whole minutes (parseCacheSchedule).
   */
  schedule: string;
  timeZone: string;
  /** Plan step 11H2 (D1): the monitor runs permanently (MonitorSettings.permanent); missing: it ends when idle. */
  permanent?: MonitorSettings['permanent'];
  /** Review round 1 of 11H2 (A-L2): permanent because the engine is remote for this computer (MonitorSettings.remote). */
  remote?: MonitorSettings['remote'];
}

/** Plan step 11H2 (D1): the environment variable that tells the monitor that it runs permanently (`1`). */
export const MONITOR_PERMANENT_ENV = 'DEVENV_MONITOR_PERMANENT';
/** Plan step 11H2: the environment variable with the name of the VS Code server store that the monitor mounts. */
export const MONITOR_VSCODE_STORE_ENV = 'DEVENV_VSCODE_STORE';

/** What ensure found or did. `failed`: logged as a warning (ensureOrThrow rejects instead; plan step 8, PR A). */
export type EnsureOutcome = 'running' | 'started' | 'created' | 'failed';

type Inspected = MonitorInspected;

/**
 * Review round 2 of PR #69 (A-R2-2): what `docker exec <name> sha256sum REMOTE_MONITOR_SCRIPT_PATH` tells about the
 * stored script: `same` (its hash), `other` (definite evidence of another or no stored script, or a container that does
 * not run it), `unknown` (the check itself failed: no answer in time, a transport error, an unexpected answer).
 */
type StoredScript = 'same' | 'other' | 'unknown';

/**
 * Review round 3 of PR #69 (A-R3-1, A-R3-2): the waits (ms) between the looks at the container after a name conflict of
 * the create while that container is `created` (the attached `docker run` of another window between its create and its
 * start) or `removing` (the old monitor that another window removes): 3.75 s in all.
 */
export const REMOTE_MONITOR_CONFLICT_WAITS_MS: readonly number[] = [250, 500, 1_000, 1_000, 1_000];

/**
 * Review round 4 of PR #69 (A-R4-1): the waits (ms) between the looks at a container of the name that ensure finds
 * `created` (whatever its label) before it decides anything: the attached `docker run` of another window between its
 * create and its start (over SSH one to several seconds). 12.75 s in all.
 */
export const REMOTE_MONITOR_CREATED_WAITS_MS: readonly number[] = [250, 500, 1_000, 1_000, 2_000, 2_000, 2_000, 2_000, 2_000];

/**
 * Review round 5 of PR #69 (A-R5-1): the most waits of one look after a name conflict (resolveConflict), whatever the
 * status of the container between them: that of the longer list.
 */
const CONFLICT_LOOK_BUDGET = Math.max(REMOTE_MONITOR_CREATED_WAITS_MS.length, REMOTE_MONITOR_CONFLICT_WAITS_MS.length);

/**
 * Review round 4 of PR #69 (A-R4-1): a container that is still `created` after REMOTE_MONITOR_CREATED_WAITS_MS is
 * removed only when it is older than this on the clock of the daemon: every live create either starts its container or
 * gives up (and removes it by its nonce) within REMOTE_MONITOR_DOCKER_TIMEOUT_MS of its start, so an older one was
 * certainly abandoned (its client died between the create and the start).
 */
export const REMOTE_MONITOR_STALE_CREATED_MS = REMOTE_MONITOR_DOCKER_TIMEOUT_MS + 30_000;

/** A status in which the container runs its script (paused: it goes on when it is unpaused). */
function isRunning(status: string): boolean {
  return status === 'running' || status === 'paused';
}

/** The Session Monitor container of an engine (its ensure). */
export class RemoteSessionMonitor {
  readonly containerName: string;
  readonly volumeName: string;

  constructor(private readonly options: RemoteSessionMonitorOptions) {
    this.containerName = options.containerName ?? REMOTE_MONITOR_CONTAINER;
    this.volumeName = options.volumeName ?? REMOTE_MONITOR_VOLUME;
  }

  /**
   * Makes sure that the monitor container runs the current script with the helper image `helperTag`, by the state of the
   * container with the name (plan step 3, pipe loading):
   * - the matching label and running or paused → nothing; review round 1 of PR #69 (A-R1-1): when Docker restarted a
   *   running one (RestartCount > 0), `docker exec … sha256sum` checks the stored script (a restarted container whose
   *   first load was cut off has none: its loader exits 3 again and again; only in the rare case of a first run that was
   *   killed before it wrote its marker does it wait up to 60 s for an input, as `running`, and this check catches it);
   *   review round 2 of PR #69 (A-R2-1, A-R2-2): only definite evidence of another or no stored script (storedScript
   *   `other`) → `docker rm -f`, then create; a check that fails keeps it (logged), and a paused one is kept without a
   *   check (Docker refuses `docker exec` in a paused container); known gap of plan step 8 (fixed): a check that fails
   *   is followed by checkAgain (an inspect by the same ID: restarting, exited with LOADER_EXIT_CODE or a grown
   *   RestartCount → replaced; still running → one more check), so a check cut off by the exit of the loader no longer
   *   keeps a monitor in an exit-3 loop;
   * - the matching label and exited with an exit code other than LOADER_EXIT_CODE → `docker start <ID>` (the loader
   *   resumes from the stored script); review round 4 of PR #69 (A-R4-4): then the stored script is checked as for a
   *   restarted one: `same` → started; definite evidence of another or no stored script (`other`: a first run killed
   *   before its script was stored exits 3 at once) → `docker rm -f <ID>`, then create; a check that fails → checkAgain
   *   as for a restarted one, then kept (logged) without evidence;
   * - created (any label): review round 4 of PR #69 (A-R4-1): it may be the create of another window between its create
   *   and its start, so ensure looks again, 12.75 s at most (REMOTE_MONITOR_CREATED_WAITS_MS; a cancellation ends the
   *   wait), while the same ID stays `created`; review round 5 of PR #69 (A-R5-2): when another ID is found still
   *   `created`, the waits start once more for it (once only, 25.5 s at most in all); any other state it finds (gone,
   *   running, another ID after that, …) goes through this table. Still `created` → `docker rm -f <ID>`, then create, only when the daemon created it more than
   *   REMOTE_MONITOR_STALE_CREATED_MS ago by the clock of the daemon (`.Created` and `docker info` SystemTime); younger,
   *   or an age that cannot be read → kept, `failed`;
   * - the matching label and restarting, dead, removing, or exited with LOADER_EXIT_CODE (the loader refused its stored
   *   script and its input), another label, or none → `docker rm -f <ID>`, then create;
   * - missing → create.
   * Review round 2 of PR #69 (A-R2-2): `docker rm -f` removes the container by the ID that inspect read, so a window never
   * removes a container that another window created meanwhile: its `rm` gets "No such container", and its create meets
   * the name conflict, which accepts a matching container that runs. Review round 4 of PR #69 (A-R4-5): never by the
   * name: when the ID cannot be read, nothing is removed or started and ensure fails.
   * Review round 3 of PR #69 (A-R3-1): an `rm` that finds the removal of that container already in progress (another
   * window removes it) is tolerated too, and the create goes on to the name conflict.
   * Create: the attached create (runSpec, MonitorEngine.create; plan step 11D2: over the Engine API) gets the script as
   * the first line of its input, and the monitor is up when its output has REMOTE_MONITOR_READY_TEXT within
   * REMOTE_MONITOR_DOCKER_TIMEOUT_MS; then its input is closed. Review round 3 of PR #69 (A-R3-1, A-R3-2): on a name conflict (another window creates or removes the
   * container meanwhile) it looks again (resolveConflict): while that container is `created` or `removing` it waits and
   * looks again (review round 5 of PR #69, A-R5-1: `created` 12.75 s at most, REMOTE_MONITOR_CREATED_WAITS_MS;
   * `removing` REMOTE_MONITOR_CONFLICT_WAITS_MS; one counter for both; review round 6 of PR #69, A-R6-1: only the
   * budget of 9 waits ends the looks, a shorter list repeats its last wait, so a container that stays `removing` gets
   * 9 waits, 7.75 s, 10 looks in all); a matching one that runs or is paused is
   * accepted; when the name is free, the create is tried once more (once only); anything else (still `created` after the
   * waits, another label, another status) fails. Nothing is removed there: the container is not ours. Review round 4 of
   * PR #69: a conflict is only the daemon's refusal of the name (A-R4-2; plan step 11D2: its status 409 with that
   * message), and only when no container has the nonce of this create (a list that fails is a failure); a matching running container that Docker
   * restarted is accepted only with the stored script of this version (A-R4-3); a conflict that fails removes the
   * container of its nonce (none after a true conflict). Any other failure (no ready line in time, the container ended, a
   * cancellation) removes the container of this create (plan step 11D2: the wait for the end of the CLI client of review
   * round 4 of PR #69, A-R4-1, is gone; review round 1 of PR #100, A-L1: a create request that the time limit or the
   * cancel cut off may still make its container after this removal; that `created` container is replaced as abandoned
   * after REMOTE_MONITOR_STALE_CREATED_MS) (by the nonce label LABEL_MONITOR_CREATE, best effort; review round 1 of PR
   * #69, A-R1-2: never by its name). `socketPath`: the source of the socket mount on the host of the
   * engine (as for the workspace helper, rootless aware). `helperImage`: the image of the container when it is not
   * `helperTag`: the checked image ID of the helper image of the open (review round 1 of PR #64, S1; review round 3
   * of PR #64, P2), or (plan step 11D3) its monitor tag, with `imageId`, the image ID that the created container must
   * have (checked by the create before its start); the label and the log lines keep the tag. Never throws, except an AbortError; a failure is logged as
   * a warning.
   */
  async ensure(helperTag: string, socketPath: string, signal?: AbortSignal, helperImage?: string, imageId?: string): Promise<EnsureOutcome> {
    try {
      return await this.ensureOrThrow(helperTag, socketPath, signal, helperImage, imageId);
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.options.logger.warn(`The Session Monitor on the Docker host could not be started: ${errorMessage(error)}`);
      return 'failed';
    }
  }

  /**
   * Plan step 8, PR A (user decision Q3 of 2026-10-02): ensure, but a failure rejects with its cause (an Error) instead
   * of `failed`, so the open is refused. Nothing is logged for the failure here; the caller says it.
   */
  async ensureOrThrow(helperTag: string, socketPath: string, signal?: AbortSignal, helperImage?: string, imageId?: string): Promise<Exclude<EnsureOutcome, 'failed'>> {
    const { logger } = this.options;
    const script = await this.options.script();
    // Plan step 3 (user decision 2026-09-29): the memory guard of the loader, before an old monitor is removed.
    const scriptLine = encodeBundle(script);
    if (scriptLine.length - 1 > MAX_BUNDLE_LINE_LENGTH) {
      throw new Error(`The script of the Session Monitor is too long (${scriptLine.length - 1} characters as JSON).`);
    }
    const images = this.options.imageMaintenance?.();
    // Review round 1 of PR #57 (C): the prefixes, the schedule and the time zone come with `settings -` (imageSettings),
    // so computers with other settings or another time zone on the same engine do not replace it at each open. Plan step
    // 11H2 (D1 of 2026-10-09): the label holds the mode (permanent or not: its restart policy and its exit when idle) in
    // place of whether it maintains images (its network, which it now always has).
    // Review round 1 of 11H2 (A-L2, A-L6): the label holds why it is permanent, and the store that it mounts.
    const mode = monitorModeOf(images);
    const store = this.options.vscodeStoreVolume;
    const label = monitorLabel(script, helperTag, mode, store);
    // Plan step 11H2 (D1): one engine can be local for one computer and remote for another, so an ensure takes a running
    // monitor of the same version that another computer runs permanently as current (acceptedLabels). Review round 1 of
    // 11H2 (A-L2): an ensure that sees the engine as local (permanent or not) takes a running `permanent-remote` one; one
    // that sees it as remote takes a running `permanent-local` one. So turning stopLocalMonitorWhenIdle on again replaces
    // this computer's own permanent monitor (`permanent-local`) at its next ensure.
    const other: MonitorMode = mode === PERMANENT_REMOTE_LABEL_PART ? PERMANENT_LOCAL_LABEL_PART : PERMANENT_REMOTE_LABEL_PART;
    const accepted = { label, running: monitorLabel(script, helperTag, other, store) };
    // Review round 1 of PR #69 (A-R1-2): the nonce of this create, so that a failure removes only its own container.
    const createId = randomUUID();
    const spec = this.runSpec(helperImage ?? helperTag, socketPath, label, script, images, createId, imageId);
    let current = await this.inspect(signal);
    // Review round 4 of PR #69 (A-R4-1): a `created` container (of any label) may be the create of another window
    // between its create and its start: look again for a while before anything is decided.
    if (current.exists && current.status === 'created') current = await this.waitWhileCreated(current, signal);
    if (current.exists) {
      const decided = await this.decide(current, accepted, script, signal);
      if (decided !== 'replace') return decided;
      // Review round 2 of PR #69 (A-R2-2), review round 4 (A-R4-5): by its ID only, so never a container that another
      // window created meanwhile.
      await this.options.engine.remove(this.idOf(current), signal);
    }
    let created = await this.create(spec, scriptLine, signal);
    let triedAgain = false;
    // Another window creates or removes it at the same time: accept it when it is the same version and runs. It is not
    // ours, so it is not removed. Review round 3 of PR #69 (A-R3-1, A-R3-2): wait while it is being created or removed,
    // and create once more when the name became free. A create that met the conflict made no container, so the nonce
    // of this create stays that of the next one.
    while (created.kind === 'exited' && created.conflict) {
      // Review round 4 of PR #69 (A-R4-2): a container with the nonce of this create means that this create did make
      // one: no conflict. A list that fails is no evidence either way: fail, and remove nothing but by the nonce.
      const own = await this.listOwn(createId, signal);
      if (own === undefined || own.length > 0) {
        await this.removeBestEffort(createId);
        throw new Error(`docker run failed: ${created.detail}`);
      }
      const found = await this.resolveConflict(accepted, script, signal);
      if (found === 'running') return 'running';
      if (found === 'missing' && !triedAgain) {
        triedAgain = true;
        created = await this.create(spec, scriptLine, signal);
        continue;
      }
      // Review round 4 of PR #69 (A-R4-2): by the nonce only, so after a true conflict it finds nothing.
      await this.removeBestEffort(createId);
      throw new Error(`docker run failed: ${created.detail}`);
    }
    if (created.kind === 'ready') {
      logger.info(`The Session Monitor on the Docker host was created (${this.containerName}, image ${helperTag}).`);
      return 'created';
    }
    await this.removeBestEffort(createId);
    if (created.kind === 'aborted') throw abortError();
    if (created.kind === 'timeout') {
      throw new Error(`the monitor did not report its start within ${REMOTE_MONITOR_DOCKER_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new Error(`docker run failed: ${created.detail}`);
  }

  /**
   * What ensure does with the existing container `current` (see ensure): `running` or `started` (kept), or `replace`
   * (removed by its ID, then created). Throws when it is kept but ensure fails (a `created` one that may still be
   * starting, an ID that cannot be read).
   */
  private async decide(current: Inspected & { exists: true }, accepted: AcceptedLabels, script: string, signal: AbortSignal | undefined): Promise<'running' | 'started' | 'replace'> {
    const { logger } = this.options;
    if (current.status === 'created') {
      // Review round 4 of PR #69 (A-R4-1): still `created` after the waits. Removed only when it is certainly abandoned.
      const age = await this.ageOnDaemon(current, signal);
      if (age === undefined) {
        throw new Error('the container of the Session Monitor has not started yet and its age cannot be read; it is kept.');
      }
      if (age <= REMOTE_MONITOR_STALE_CREATED_MS) {
        throw new Error(`the container of the Session Monitor was created ${Math.round(age / 1000)} seconds ago and has not started yet (another window may be starting it); it is kept.`);
      }
      this.idOf(current);
      logger.info(`The Session Monitor on the Docker host was created ${Math.round(age / 1000)} seconds ago and never started; it is replaced (${this.containerName}).`);
      return 'replace';
    }
    // Plan step 11H2 (D1): a running permanent monitor of the same version counts as current for an ensure that wants one
    // that ends when idle (accepted.running); anything else of another label is replaced.
    if (!labelAccepted(current, accepted)) {
      this.idOf(current);
      logger.info(`The Session Monitor on the Docker host is of another version; it is replaced (${this.containerName}).`);
      return 'replace';
    }
    if (isRunning(current.status)) {
      // Review round 1 of PR #69 (A-R1-1): a container that Docker restarted runs its stored script only when it has
      // one; one whose first load was cut off gets a new input without a writer and never its script. RestartCount 0
      // (a normal open, or the create of another window that is still loading) needs no extra call. Review round 2 of
      // PR #69 (A-R2-1): a paused one is kept without a check (Docker refuses `docker exec` in it).
      if (current.restartCount === 0 || current.status === 'paused') return 'running';
      // Review round 2 of PR #69 (A-R2-2): only definite evidence replaces it; a check that fails keeps it. Known gap of
      // plan step 8 (fixed): a check cut off by the exit of the loader is followed by checkAgain.
      let stored = await this.storedScript(script, signal);
      if (stored === 'unknown') stored = await this.checkAgain(current, script, signal);
      if (stored === 'same') return 'running';
      if (stored === 'unknown') {
        logger.info(`The Session Monitor on the Docker host was restarted and its stored script could not be checked; it is kept (${this.containerName}).`);
        return 'running';
      }
      this.idOf(current);
      logger.info(`The Session Monitor on the Docker host was restarted without its script; it is replaced (${this.containerName}).`);
      return 'replace';
    }
    if (current.status === 'exited' && current.exitCode !== LOADER_EXIT_CODE) {
      // Review round 4 of PR #69 (A-R4-4): started by its ID, then the stored script is checked as for a restarted one:
      // a first run killed before its script was stored exits 3 again at once. Only definite evidence replaces it.
      const id = this.idOf(current);
      await this.options.engine.start(id, signal);
      let stored = await this.storedScript(script, signal);
      // Review round 1 of PR #83 (B-R1-1): `docker start` resets RestartCount to 0, so the count before the start is no
      // base for a restart by the policy after it.
      if (stored === 'unknown') stored = await this.checkAgain({ ...current, restartCount: 0 }, script, signal);
      if (stored === 'same') {
        logger.info(`The Session Monitor on the Docker host was started again (${this.containerName}).`);
        return 'started';
      }
      if (stored === 'unknown') {
        logger.info(`The Session Monitor on the Docker host was started again and its stored script could not be checked; it is kept (${this.containerName}).`);
        return 'started';
      }
      logger.info(`The Session Monitor on the Docker host was started again without its script; it is replaced (${this.containerName}).`);
      return 'replace';
    }
    this.idOf(current);
    const how = current.status === 'exited' ? `exited with ${current.exitCode}` : current.status;
    logger.info(`The Session Monitor on the Docker host does not run (${how}); it is replaced (${this.containerName}).`);
    return 'replace';
  }

  /**
   * Known gap of plan step 8 (fixed): after a stored-script check of the container `current` that gave `unknown` (the
   * `docker exec` may be cut off when the loader exits 3 at once, between two restarts by the policy), the container
   * of the name is inspected again. The same ID found `restarting`, exited with LOADER_EXIT_CODE, or with a RestartCount
   * above that of `current` is definite evidence that it exits at once without its script → `other` (replaced by its ID).
   * The same ID still `running` with the same RestartCount → the stored script is checked once more (its answer counts;
   * `unknown` again keeps it). An inspect that fails, a missing container, another ID or an ID that cannot be read, or
   * any other state → `unknown` (no evidence: kept). Only inspects and execs; a cancellation passes (AbortError).
   */
  private async checkAgain(current: Inspected & { exists: true }, script: string, signal: AbortSignal | undefined): Promise<StoredScript> {
    let again: Inspected;
    try {
      again = await this.inspect(signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return 'unknown';
    }
    if (!again.exists || current.id === undefined || again.id !== current.id) return 'unknown';
    if (again.status === 'restarting' || (again.status === 'exited' && again.exitCode === LOADER_EXIT_CODE) || again.restartCount > current.restartCount) {
      return 'other';
    }
    if (again.status !== 'running') return 'unknown';
    return this.storedScript(script, signal);
  }

  /**
   * Review round 2 of PR #69 (A-R2-2), review round 4 (A-R4-5): the ID of the container that is removed or started;
   * throws when it cannot be read (never the name: the container of the name may be that of another window by then).
   */
  private idOf(current: Inspected & { exists: true }): string {
    if (current.id === undefined) throw new Error('the ID of the Session Monitor container cannot be read; it is kept.');
    return current.id;
  }

  /**
   * Review round 4 of PR #69 (A-R4-1): looks at the container of the name again while it stays `created` with the same
   * ID, with the waits of REMOTE_MONITOR_CREATED_WAITS_MS, and gives the first other state (gone, another status, another
   * ID) or the last look. Only inspects. A cancellation during a wait passes (AbortError).
   * Review round 5 of PR #69 (A-R5-2): when the name moves to another container that is still `created` (another window
   * removed an abandoned one and created its own, between its create and its start), the waits start once more for that
   * ID (once only: 2 × 12.75 s at most, one budget of looks); another ID after that, or one that cannot be read, ends the
   * wait, and that container is judged by its own age.
   */
  private async waitWhileCreated(first: Inspected & { exists: true }, signal: AbortSignal | undefined): Promise<Inspected> {
    const waits = REMOTE_MONITOR_CREATED_WAITS_MS;
    let found: Inspected = first;
    let id = first.id;
    let restarted = false;
    let step = 0;
    for (let looks = 0; looks < 2 * waits.length && step < waits.length; looks += 1) {
      await wait(waits[step], signal);
      step += 1;
      found = await this.inspect(signal);
      if (!found.exists || found.status !== 'created') return found;
      if (found.id !== id) {
        if (restarted || found.id === undefined) return found;
        restarted = true;
        id = found.id;
        step = 0;
      }
    }
    return found;
  }

  /**
   * Review round 4 of PR #69 (A-R4-1): how long ago (ms) the daemon created `current`, by its creation time and the clock
   * of the daemon (MonitorEngine.daemonTime), so the clock of this computer does not count.
   * Undefined when either cannot be read (logged); a cancellation passes.
   */
  private async ageOnDaemon(current: Inspected & { exists: true }, signal: AbortSignal | undefined): Promise<number | undefined> {
    const { logger } = this.options;
    if (current.createdAt === undefined) {
      logger.info(`The creation time of the Session Monitor container cannot be read (${this.containerName}).`);
      return undefined;
    }
    const now = await this.options.engine.daemonTime(signal);
    if (typeof now !== 'number') {
      logger.info(`The time of the Docker host cannot be read: ${now.reason}`);
      return undefined;
    }
    return now - current.createdAt;
  }

  /**
   * Review round 3 of PR #69 (A-R3-1, A-R3-2): what the container of the name is after a name conflict of the create:
   * `running` (the matching label, running or paused), `missing` (the name is free again), or `other` (anything else,
   * also a container that is still `created` after the waits of REMOTE_MONITOR_CREATED_WAITS_MS, review round 5 of PR
   * #69, A-R5-1, or still `removing` after the waits of REMOTE_MONITOR_CONFLICT_WAITS_MS; review round 6 of PR #69,
   * A-R6-1: CONFLICT_LOOK_BUDGET waits in all, whatever the status, a shorter list repeating its last wait, so a
   * container that stays `removing` gets 9 waits, 7.75 s, 10 looks in all). Only
   * inspects: it never removes anything. A cancellation during a wait passes (AbortError). Review round 4 of PR #69
   * (A-R4-3): a running one that Docker restarted (RestartCount > 0) is accepted only when it holds the stored script of
   * this version (storedScript `same`); otherwise `other` (the next open's first look decides on evidence).
   */
  private async resolveConflict(accepted: AcceptedLabels, script: string, signal: AbortSignal | undefined): Promise<'running' | 'missing' | 'other'> {
    for (let attempt = 0; ; attempt += 1) {
      const found = await this.inspect(signal);
      if (!found.exists) return 'missing';
      // Plan step 11H2 (D1): also a running permanent monitor of the same version for an ensure of one that ends when idle.
      if (labelAccepted(found, accepted) && isRunning(found.status)) {
        if (found.status === 'paused' || found.restartCount === 0) return 'running';
        return (await this.storedScript(script, signal)) === 'same' ? 'running' : 'other';
      }
      // Review round 5 of PR #69 (A-R5-1): a `created` one gets the waits of the first look (the create-to-start gap
      // of another window over SSH), a `removing` one the short ones. One counter for both, never reset, so the waits
      // end after the longer list at most, also when the status changes between them.
      // Review round 6 of PR #69 (A-R6-1): only CONFLICT_LOOK_BUDGET bounds the looks. A list shorter than the counter
      // repeats its last wait, so a status that changes late (`created`, then `removing`) still gets a wait.
      const waits = found.status === 'created' ? REMOTE_MONITOR_CREATED_WAITS_MS : found.status === 'removing' ? REMOTE_MONITOR_CONFLICT_WAITS_MS : undefined;
      if (waits === undefined || attempt >= CONFLICT_LOOK_BUDGET) return 'other';
      await wait(waits[Math.min(attempt, waits.length - 1)], signal);
    }
  }

  /**
   * The attached create of the monitor (MonitorEngine.create): writes `scriptLine` (the first line of the loader), waits for
   * the ready line, its end, the time limit (REMOTE_MONITOR_DOCKER_TIMEOUT_MS), or the cancellation, and then closes its
   * input in every case (after the ready line, the container goes on alone).
   */
  private create(spec: MonitorRunSpec, scriptLine: string, signal: AbortSignal | undefined) {
    return this.options.engine.create(spec, scriptLine, REMOTE_MONITOR_READY_TEXT, signal);
  }

  /**
   * The removal of the container of a failed create; a failure is ignored (the next open replaces it anyway). Review
   * round 1 of PR #69 (A-R1-2): by the nonce label of this create (the containers with it, then each by its ID), never by
   * the name: when the create failed because another window removed and replaced the
   * container meanwhile ("No such container"), the container of the name is that of the other window.
   */
  private async removeBestEffort(createId: string): Promise<void> {
    try {
      const listed = await this.listOwn(createId, undefined);
      for (const id of listed ?? []) {
        await this.options.engine.remove(id);
      }
    } catch {
      // Best effort.
    }
  }

  /**
   * The IDs of the containers with the nonce `createId` of a create (MonitorEngine.idsWithLabel; only full IDs of 64 hex
   * digits); undefined when the list fails. A cancellation passes (review round 4 of PR #69, A-R4-2:
   * the conflict check passes the signal of ensure; the cleanup passes none).
   */
  private async listOwn(createId: string, signal: AbortSignal | undefined): Promise<string[] | undefined> {
    const listed = await this.options.engine.idsWithLabel(`${LABEL_MONITOR_CREATE}=${createId}`, signal);
    return listed?.filter((id) => /^[0-9a-f]{64}$/.test(id));
  }

  /**
   * Review round 1 of PR #69 (A-R1-1), review round 2 (A-R2-2): whether the running container holds the script
   * (`sha256sum REMOTE_MONITOR_SCRIPT_PATH` in it, MonitorEngine.storedScript): its bundleHash → `same`; another hash of
   * 64 hex digits → `other`; definite evidence that no script is stored or that the container does not run (`none`,
   * NO_STORED_SCRIPT) → `other`. No answer in time, a failure, or another answer → `unknown`. A cancellation passes.
   */
  private async storedScript(script: string, signal: AbortSignal | undefined): Promise<StoredScript> {
    const found = await this.options.engine.storedScript(this.containerName, signal);
    if (found === 'none') return 'other';
    if (found === 'unknown') return 'unknown';
    const hash = found.hash.trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{64}$/.test(hash)) return 'unknown';
    return hash === bundleHash(script) ? 'same' : 'other';
  }

  /**
   * The container of the monitor as its create makes it (MonitorRunSpec). `helperImage`: the helper tag, or an image ID
   * (S1). Plan step 3 (pipe loading): the command is the pipe loader with the path, the hash of `script`, and
   * REMOTE_MONITOR_ENTRY; the script itself goes over the input (ensure), never here. `createId`: the nonce of this create
   * (LABEL_MONITOR_CREATE; review round 1 of PR #69, A-R1-2), which ensure always passes. Review round 4 of PR #64 (R4-8):
   * never a pull: the helper image exists only on the engine. `imageId` (plan step 11D3): the image ID that the
   * container of the tag `helperImage` must have (MonitorRunSpec.imageId).
   */
  runSpec(helperImage: string, socketPath: string, label: string, script: string, images?: ImageMaintenanceSettings, createId?: string, imageId?: string): MonitorRunSpec {
    const imagePrefixes = images?.prefixes ?? [];
    const permanent = images?.permanent === true;
    const labels: Record<string, string> = { [LABEL_SESSION_MONITOR]: label };
    if (createId !== undefined) labels[LABEL_MONITOR_CREATE] = createId;
    for (const [key, value] of Object.entries(this.options.labels ?? {})) labels[key] = value;
    const env: Record<string, string> = { ...(this.options.containerEnv ?? {}) };
    if (images && imagePrefixes.length > 0) {
      // Plan step 3: the command line holds no script, so all prefixes fit (imagePrefixesOf keeps them within
      // MAX_IMAGE_PREFIXES_JSON_LENGTH); the whole list comes with `settings -` at each open anyway.
      env.DEVENV_IMAGE_PREFIXES = JSON.stringify(imagePrefixes);
    }
    if (images) {
      // Plan step 11H2 (D2 of 2026-10-09): the schedule of the whole background run (the names of the variables stay
      // those of the image maintenance), also without prefixes: the VS Code server and the cleanup always run.
      env.DEVENV_IMAGE_SCHEDULE = images.schedule;
      env.DEVENV_IMAGE_TZ = images.timeZone;
    }
    // Plan step 11H2 (D1): the mode, fixed for the life of the container (it is part of its label).
    if (permanent) env[MONITOR_PERMANENT_ENV] = '1';
    const store = this.options.vscodeStoreVolume;
    if (store !== undefined) env[MONITOR_VSCODE_STORE_ENV] = store;
    return {
      name: this.containerName,
      image: helperImage,
      ...(imageId !== undefined ? { imageId } : {}),
      labels,
      // Our own container (the refusal of restart policies is for the containers of repositories). Plan step 8, PR B
      // (user decision Q5 of 2026-10-02): `on-failure`, no longer `unless-stopped`: the monitor exits with 0 when it is
      // idle (no running environment container for 5 minutes, REMOTE_IDLE_EXIT_MS of src/remoteMonitor/main.ts) and
      // stays exited until an open ensures it or the heartbeats of a window repair it; a failure (an uncaught error, the
      // loader's exit 3) is restarted, and the loader resumes from the stored script. Plan step 11H2 (the user's decision
      // "unless-stopped" of 2026-10-09): a permanent monitor (a remote engine, or stopLocalMonitorWhenIdle off) never
      // exits when idle and has `unless-stopped`, so Docker starts it again after a crash and after a restart of the
      // engine. No published port, no capability: it needs the socket and its volumes.
      restartPolicy: monitorRestartPolicy(permanent),
      // User requests 2026-09-28: with image maintenance it read the tags of the registry. Plan step 11H2 (D1 of
      // 2026-10-09): the background run always reaches the update service of VS Code, so it always has the default network
      // (outbound only: it publishes no port and accepts no connection).
      network: 'default',
      log: REMOTE_MONITOR_LOG,
      // Plan step 11H2: the store of the worker read-write at VSCODE_STORE_DIR, as the worker mounts it (nocopy).
      mounts: {
        socket: socketPath,
        volume: this.volumeName,
        volumeTarget: REMOTE_MONITOR_STATE_DIR,
        ...(store !== undefined ? { store: { volume: store, target: VSCODE_STORE_DIR } } : {}),
      },
      env,
      command: loaderCommand({ path: REMOTE_MONITOR_SCRIPT_PATH, hash: bundleHash(script), entry: REMOTE_MONITOR_ENTRY }),
    };
  }

  private inspect(signal: AbortSignal | undefined): Promise<Inspected> {
    return this.options.engine.inspect(this.containerName, signal);
  }
}

/**
 * Plan step 11H2 (D1 of 2026-10-09): the label of the monitor container (remoteMonitorLabelValue) for its mode: none for
 * one that ends when idle. Review round 1 of 11H2 (A-L2): `permanent-remote` or `permanent-local` for a permanent one
 * (PERMANENT_REMOTE_LABEL_PART, PERMANENT_LOCAL_LABEL_PART); (A-L6) and the store that it mounts (vscodeStoreLabelPart).
 */
export function monitorLabel(script: string, helperTag: string, mode: MonitorMode, store?: string): string {
  return remoteMonitorLabelValue(script, helperTag, [...(mode === 'idle' ? [] : [mode]), ...(store !== undefined ? [vscodeStoreLabelPart(store)] : [])]);
}

/**
 * Plan step 11H2 (D1): the labels that an ensure takes as current: its own `label`, and for an ensure of a monitor that
 * ends when idle also `running`, the label of the permanent monitor of the same version, while that container runs.
 */
interface AcceptedLabels {
  label: string;
  running?: string;
}

/** Plan step 11H2 (D1): whether the container `found` has a label that the ensure takes as current (AcceptedLabels). */
function labelAccepted(found: Inspected & { exists: true }, accepted: AcceptedLabels): boolean {
  return found.label === accepted.label || (accepted.running !== undefined && found.label === accepted.running && isRunning(found.status));
}

/** Review round 3 of PR #69 (A-R3-1, A-R3-2): waits `ms`; a cancellation ends the wait with an AbortError. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
