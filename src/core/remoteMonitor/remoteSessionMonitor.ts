// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Session Monitor container on a remote Docker host, from the side of this computer (unit 7, PR 2; implementation
// notes 16): the open pipeline ensures it (ensure), the window of Close and Keep Running sends one heartbeat, and Delete
// removes the record of this computer. The Docker calls go through the current Docker context of the operation
// (ContainerAdapter.run and start pin DOCKER_CONTEXT); DOCKER_HOST is never set. No `vscode`.
//
// Plan step 3 (pipe loading, user decisions 2026-09-29): the container runs the pipe loader; the script is never an
// argument or a variable. ensure starts `docker run -i --sig-proxy=false …` attached, writes the script as the first line
// of its input, waits for the monitor's REMOTE_MONITOR_READY_TEXT, then ends its input and the client (the container
// goes on: no signal is passed on). The loader stores the script at REMOTE_MONITOR_SCRIPT_PATH, so a restart of the
// container resumes from it without input. Neither the script line nor any other input is logged.
import { randomUUID } from 'crypto';
import { errorMessage } from '../errors';
import { LOADER_EXIT_CODE, MAX_BUNDLE_LINE_LENGTH, bundleHash, encodeBundle, loaderCommand, readableStderr } from '../loader/pipeLoader';
import { abortError, isAbortError, type Logger, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import {
  IMAGE_MAINTENANCE_LABEL_PART,
  LABEL_MONITOR_CREATE,
  LABEL_SESSION_MONITOR,
  REMOTE_MONITOR_CONTAINER,
  REMOTE_MONITOR_ENTRY,
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_SCRIPT_PATH,
  REMOTE_MONITOR_STATE_DIR,
  REMOTE_MONITOR_VOLUME,
  forgetCommand,
  heartbeatCommand,
  isUnderRecordsLock,
  monitorExecFailure,
  imageSettingsCommand,
  imagesCommand,
  parseRecordsOutput,
  recordsCommand,
  remoteMonitorLabelValue,
  type HeartbeatInput,
  type ImageSettings,
  type RecordsOutput,
} from './protocol';

/** Time limit of each Docker call of ensure (an SSH connection plus the call). */
export const REMOTE_MONITOR_DOCKER_TIMEOUT_MS = 60_000;
/** Time limit of a heartbeat, `records`, and `forget` (`docker exec`). */
export const REMOTE_MONITOR_EXEC_TIMEOUT_MS = 20_000;
/** The characters of the end of stderr of the attached `docker run` that are kept (for the conflict and the log). */
const STDERR_TAIL_LENGTH = 4_000;

/**
 * Monitor cleanup, user decision 2026-09-29 (R5): the log options of the monitor container, `docker logs` of at most
 * about 2 MB. Not part of the label (remoteMonitorLabelValue covers the script, the helper tag and whether it maintains
 * images): a running monitor keeps its log settings until it is replaced for another reason.
 */
export const REMOTE_MONITOR_LOG_OPTIONS: readonly string[] = ['--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2'];

/** The part of ContainerAdapter that is used here. */
export interface RemoteMonitorDocker {
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** `docker <args>` with an open standard input (the attached `docker run` of the monitor); undefined without a CLI. */
  start(args: readonly string[]): StartedProcess | undefined;
}

export interface RemoteSessionMonitorOptions {
  docker: RemoteMonitorDocker;
  logger: Logger;
  /** The content of dist/remoteMonitor.js. */
  script: () => Promise<string>;
  /**
   * User requests 2026-09-28: the image maintenance of the monitor: the prefixes of the images that it updates and cleans
   * (the setting remoteImageUpdates, a trailing `*` dropped; none: no image maintenance), the schedule (a cron expression,
   * the setting remoteImageUpdateSchedule), and the time zone of this computer.
   */
  imageMaintenance?: () => ImageMaintenanceSettings;
  /** Only for the Docker tests: another container and volume name, more labels, and variables of the container. */
  containerName?: string;
  volumeName?: string;
  labels?: Readonly<Record<string, string>>;
  containerEnv?: Readonly<Record<string, string>>;
}

/** See RemoteSessionMonitorOptions.imageMaintenance. */
export interface ImageMaintenanceSettings {
  prefixes: readonly string[];
  /** A cron expression of five fields (user request 2026-09-28, "in a guided cron style manner"). */
  schedule: string;
  timeZone: string;
}

/** What ensure found or did. `failed`: logged as a warning; the open goes on. */
export type EnsureOutcome = 'running' | 'started' | 'created' | 'failed';

/** The result of a `docker exec` in the monitor container. `missing`: the container does not exist or does not run. */
export type MonitorExecResult = { ok: true; stdout: string } | { ok: false; missing: boolean; detail: string };

/**
 * The state of the monitor container: missing, or its status (`created`, `running`, `paused`, `restarting`, `removing`,
 * `exited`, `dead`), the exit code of its last run, its label, how often Docker restarted it by its restart policy since
 * its last start by a client (`RestartCount`; 0 when it cannot be read), its ID (64 hex digits; undefined when it
 * cannot be read; review round 2 of PR #69, A-R2-2), and when the daemon created it (`.Created`, milliseconds since the
 * epoch on the clock of the daemon; undefined when it cannot be read; review round 4 of PR #69, A-R4-1).
 */
type Inspected =
  | { exists: false }
  | { exists: true; status: string; exitCode: number | undefined; label: string; restartCount: number; id: string | undefined; createdAt: number | undefined };

/**
 * Review round 2 of PR #69 (A-R2-2): what `docker exec <name> sha256sum REMOTE_MONITOR_SCRIPT_PATH` tells about the
 * stored script: `same` (its hash), `other` (definite evidence of another or no stored script, or a container that does
 * not run it), `unknown` (the check itself failed: no answer in time, a transport error, an unexpected answer).
 */
type StoredScript = 'same' | 'other' | 'unknown';

/**
 * A failed `sha256sum` that shows that no script is stored (coreutils, BusyBox) or that the container does not run.
 * Review round 3 of PR #69 (B-R3-1): each alternative is tied to the start of a line of its source (`sha256sum`, the
 * daemon or the CLI, the OCI runtime), so an unrelated line of a transport failure (an SSH warning about an identity
 * file, a missing daemon socket) that also says "No such file or directory" is no evidence; a miss counts as `unknown`
 * (kept). A-R3-4: a stored script that cannot be read (`Permission denied`, BusyBox or coreutils) is no evidence of
 * another or no script either (before, BusyBox's `can't open` counted). A-R3-5: the runtime's refusal of an exec in a
 * container that stopped between two restarts is evidence that it does not run (the wording of newer runc and the older
 * one).
 */
const NO_STORED_SCRIPT =
  /^sha256sum: .*No such file or directory|^(?:Error response from daemon|Error): (?:No such container: |container \S+ is (?:not running|restarting)\b)|^(?:Error response from daemon: )?OCI runtime exec failed: exec failed: cannot exec (?:in a stopped container|a container that has stopped)\b/im;

/** Review round 3 of PR #69 (A-R3-1): another window removes the same container right now; its removal goes on. */
const REMOVAL_IN_PROGRESS = /removal of container .* is already in progress/i;

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

/**
 * Review round 4 of PR #69 (A-R4-1): how long a create that failed waits for its killed client to end before it looks
 * for its container by the nonce, so that the list runs after the create request of that client is done.
 */
export const REMOTE_MONITOR_CLIENT_EXIT_WAIT_MS = 5_000;

/**
 * Review round 4 of PR #69 (A-R4-2): the name conflict of the create, only the daemon's own message at the start of a
 * line (the CLI prefixes `docker: `), and only with the exit code 125 of the CLI: the stderr of the attached run also
 * holds the container's own stderr (the loader's `devenv loader: …` line, Node.js warnings) and SSH warnings.
 */
const NAME_CONFLICT = /^(?:docker: )?Error response from daemon: Conflict\. The container name\b.*\bis already in use\b/m;
/** The exit code of the Docker CLI when the daemon refused the create (review round 4 of PR #69, A-R4-2). */
const DOCKER_CLI_DAEMON_ERROR = 125;

/** How the attached `docker run` of the monitor ended for ensure. */
type Created = { kind: 'ready' } | { kind: 'exited'; detail: string; conflict: boolean } | { kind: 'timeout' } | { kind: 'aborted' };

/** A status in which the container runs its script (paused: it goes on when it is unpaused). */
function isRunning(status: string): boolean {
  return status === 'running' || status === 'paused';
}

/** A failed call because the container does not exist (or does not run, for `docker exec`). */
export function isMissingContainer(result: Pick<RunResult, 'stderr' | 'timedOut' | 'exitCode'>): boolean {
  return !result.timedOut && result.exitCode !== 0 && /no such (container|object)|is not running/i.test(result.stderr);
}

/** The Session Monitor container of the engine of the current Docker context. */
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
   * Create: the attached `docker run -i --sig-proxy=false` (runArgs) gets the script as its first input line, and the
   * monitor is up when its output has REMOTE_MONITOR_READY_TEXT within REMOTE_MONITOR_DOCKER_TIMEOUT_MS; then the client
   * is ended. Review round 3 of PR #69 (A-R3-1, A-R3-2): on a name conflict (another window creates or removes the
   * container meanwhile) it looks again (resolveConflict): while that container is `created` or `removing` it waits and
   * looks again (review round 5 of PR #69, A-R5-1: `created` 12.75 s at most, REMOTE_MONITOR_CREATED_WAITS_MS;
   * `removing` REMOTE_MONITOR_CONFLICT_WAITS_MS; one counter for both; review round 6 of PR #69, A-R6-1: only the
   * budget of 9 waits ends the looks, a shorter list repeats its last wait, so a container that stays `removing` gets
   * 9 waits, 7.75 s, 10 looks in all); a matching one that runs or is paused is
   * accepted; when the name is free, the create is tried once more (once only); anything else (still `created` after the
   * waits, another label, another status) fails. Nothing is removed there: the container is not ours. Review round 4 of
   * PR #69: a conflict is only the daemon's message at a line start with the CLI's exit 125 (A-R4-2), and only when no
   * container has the nonce of this create (a list that fails is a failure); a matching running container that Docker
   * restarted is accepted only with the stored script of this version (A-R4-3); a conflict that fails removes the
   * container of its nonce (none after a true conflict). Any other failure (no ready line in time, the container ended, a
   * cancellation) kills the client, waits up to REMOTE_MONITOR_CLIENT_EXIT_WAIT_MS for its end (A-R4-1), and
   * removes the container of this create (by the nonce label LABEL_MONITOR_CREATE, best effort; review round 1 of PR
   * #69, A-R1-2: never by its name). `socketPath`: the source of the socket mount on the host of the
   * engine (as for the workspace helper, rootless aware). `helperImage`: the image reference of `docker run` when it is
   * not `helperTag`: the checked image ID of the helper image of the open (review round 1 of PR #64, S1; review round 3
   * of PR #64, P2); the label and the log lines keep the tag. Never throws, except an AbortError; a failure is logged as
   * a warning.
   */
  async ensure(helperTag: string, socketPath: string, signal?: AbortSignal, helperImage?: string): Promise<EnsureOutcome> {
    const { logger } = this.options;
    try {
      const script = await this.options.script();
      // Plan step 3 (user decision 2026-09-29): the memory guard of the loader, before an old monitor is removed.
      const scriptLine = encodeBundle(script);
      if (scriptLine.length - 1 > MAX_BUNDLE_LINE_LENGTH) {
        throw new Error(`The script of the Session Monitor is too long (${scriptLine.length - 1} characters as JSON).`);
      }
      const images = this.options.imageMaintenance?.();
      // Review round 1 of PR #57 (C): only whether it maintains images is part of the label (its network); the prefixes,
      // the schedule and the time zone come with `settings -` (imageSettings), so computers with other settings or another
      // time zone on the same engine do not replace it at each open.
      const label = remoteMonitorLabelValue(script, helperTag, images && images.prefixes.length > 0 ? [IMAGE_MAINTENANCE_LABEL_PART] : []);
      // Review round 1 of PR #69 (A-R1-2): the nonce of this create, so that a failure removes only its own container.
      const createId = randomUUID();
      const runArgs = this.runArgs(helperImage ?? helperTag, socketPath, label, script, images, createId);
      let current = await this.inspect(signal);
      // Review round 4 of PR #69 (A-R4-1): a `created` container (of any label) may be the create of another window
      // between its create and its start: look again for a while before anything is decided.
      if (current.exists && current.status === 'created') current = await this.waitWhileCreated(current, signal);
      if (current.exists) {
        const decided = await this.decide(current, label, script, signal);
        if (decided !== 'replace') return decided;
        // Review round 2 of PR #69 (A-R2-2), review round 4 (A-R4-5): by its ID only, so never a container that another
        // window created meanwhile.
        await this.docker(['rm', '-f', this.idOf(current)], signal);
      }
      let created = await this.create(runArgs, scriptLine, signal);
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
        const found = await this.resolveConflict(label, script, signal);
        if (found === 'running') return 'running';
        if (found === 'missing' && !triedAgain) {
          triedAgain = true;
          created = await this.create(runArgs, scriptLine, signal);
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
    } catch (error) {
      if (isAbortError(error)) throw error;
      logger.warn(
        `The Session Monitor on the Docker host could not be started: ${errorMessage(error)} Without it, a container there stops after its waiting time only while this computer is online and Docker is set to that host.`,
      );
      return 'failed';
    }
  }

  /**
   * What ensure does with the existing container `current` (see ensure): `running` or `started` (kept), or `replace`
   * (removed by its ID, then created). Throws when it is kept but ensure fails (a `created` one that may still be
   * starting, an ID that cannot be read).
   */
  private async decide(current: Inspected & { exists: true }, label: string, script: string, signal: AbortSignal | undefined): Promise<'running' | 'started' | 'replace'> {
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
    if (current.label !== label) {
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
      await this.docker(['start', id], signal);
      let stored = await this.storedScript(script, signal);
      if (stored === 'unknown') stored = await this.checkAgain(current, script, signal);
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
   * Review round 4 of PR #69 (A-R4-1): how long ago (ms) the daemon created `current`, by its `.Created` and the clock
   * of the daemon (`docker info --format '{{json .SystemTime}}'`), so the clock of this computer does not count.
   * Undefined when either cannot be read (logged); a cancellation passes.
   */
  private async ageOnDaemon(current: Inspected & { exists: true }, signal: AbortSignal | undefined): Promise<number | undefined> {
    const { logger } = this.options;
    if (current.createdAt === undefined) {
      logger.info(`The creation time of the Session Monitor container cannot be read (${this.containerName}).`);
      return undefined;
    }
    let result: RunResult;
    try {
      result = await this.options.docker.run(['info', '--format', '{{json .SystemTime}}'], { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      logger.info(`The time of the Docker host cannot be read: ${errorMessage(error)}`);
      return undefined;
    }
    const now = result.exitCode === 0 && !result.timedOut ? parseDockerTime(parseJson(result.stdout.trim())) : undefined;
    if (now === undefined) {
      logger.info(`The time of the Docker host cannot be read: ${result.timedOut ? 'no answer in time' : result.stderr.trim() || `exit code ${result.exitCode}`}`);
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
  private async resolveConflict(label: string, script: string, signal: AbortSignal | undefined): Promise<'running' | 'missing' | 'other'> {
    for (let attempt = 0; ; attempt += 1) {
      const found = await this.inspect(signal);
      if (!found.exists) return 'missing';
      if (found.label === label && isRunning(found.status)) {
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
   * The attached `docker run` of the monitor: writes `scriptLine` (the first line of the loader), waits for the ready line,
   * the end of the client, the time limit, or the cancellation, and then ends the input and the client in every case
   * (after the ready line, the container goes on alone: `--sig-proxy=false`).
   */
  private async create(args: readonly string[], scriptLine: string, signal: AbortSignal | undefined): Promise<Created> {
    const client = this.options.docker.start(args);
    if (client === undefined) throw new Error('The Docker CLI cannot be started.');
    const created = await new Promise<Created>((resolve) => {
      let output = '';
      let stderr = '';
      let settled = false;
      const settle = (value: Created) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => settle({ kind: 'timeout' }), REMOTE_MONITOR_DOCKER_TIMEOUT_MS);
      const onAbort = () => settle({ kind: 'aborted' });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      client.onStdout((text) => {
        // Only the tail is kept: enough for the ready line across pieces of output.
        output = (output + text).slice(-8_192);
        if (output.includes(REMOTE_MONITOR_READY_TEXT)) settle({ kind: 'ready' });
      });
      client.onStderr((text) => {
        stderr = (stderr + text).slice(-STDERR_TAIL_LENGTH);
      });
      void client.exited.then(({ exitCode, error }) => {
        // Review round 1 of PR #69 (A-R1-3): the conflict is recognised in the whole tail, but only its short lines are
        // logged (Node.js prints the source line of an uncaught error, and the script is one long line). Review round 2 of PR #69 (A-R2-3): the
        // script has short lines too, so readableStderr also drops the source excerpt by its shape.
        const detail = error ? error.message : readableStderr(stderr, STDERR_TAIL_LENGTH) || `exit code ${exitCode}`;
        // Review round 4 of PR #69 (A-R4-2): only the daemon's message at a line start, and only with the CLI's exit 125.
        settle({ kind: 'exited', detail, conflict: !error && exitCode === DOCKER_CLI_DAEMON_ERROR && NAME_CONFLICT.test(stderr) });
      });
      if (!settled) {
        try {
          client.write(scriptLine);
        } catch {
          // A client whose input is closed reports its end (exited).
        }
      }
    });
    client.end();
    client.kill();
    // Review round 4 of PR #69 (A-R4-1): after a failure, wait (bounded) for the killed client to end, so that the list
    // of the cleanup by the nonce runs after its create request is done and no `created` container is left behind.
    if (created.kind !== 'ready') await exitedWithin(client, REMOTE_MONITOR_CLIENT_EXIT_WAIT_MS);
    return created;
  }

  /**
   * `docker rm -f` of the container of a failed create; a failure is ignored (the next open replaces it anyway). Review
   * round 1 of PR #69 (A-R1-2): by the nonce label of this create (`docker ps -aq --no-trunc --filter label=…`, then
   * `docker rm -f <id>`), never by the name: when the create failed because another window removed and replaced the
   * container meanwhile ("No such container"), the container of the name is that of the other window.
   */
  private async removeBestEffort(createId: string): Promise<void> {
    try {
      const listed = await this.listOwn(createId, undefined);
      for (const id of listed ?? []) {
        await this.options.docker.run(['rm', '-f', id], { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS });
      }
    } catch {
      // Best effort.
    }
  }

  /**
   * The IDs of the containers with the nonce `createId` of a create (`docker ps -aq --no-trunc --filter label=…`; only
   * full IDs of 64 hex digits); undefined when the list fails. A cancellation passes (review round 4 of PR #69, A-R4-2:
   * the conflict check passes the signal of ensure; the cleanup passes none).
   */
  private async listOwn(createId: string, signal: AbortSignal | undefined): Promise<string[] | undefined> {
    let listed: RunResult;
    try {
      listed = await this.options.docker.run(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL_MONITOR_CREATE}=${createId}`], {
        timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return undefined;
    }
    if (listed.exitCode !== 0 || listed.timedOut) return undefined;
    return listed.stdout.split(/\s+/).filter((line) => /^[0-9a-f]{64}$/.test(line));
  }

  /**
   * Review round 1 of PR #69 (A-R1-1), review round 2 (A-R2-2): whether the running container holds the script
   * (`docker exec <name> sha256sum REMOTE_MONITOR_SCRIPT_PATH`, StoredScript). Exit 0 with its bundleHash → `same`; exit
   * 0 with another hash of 64 hex digits → `other`; a failed call whose stderr says that no file is stored or that the
   * container does not run (NO_STORED_SCRIPT) → `other`. No answer in time, a thrown error, another answer, or another
   * stderr → `unknown`. A cancellation passes. Review round 3 of PR #69 (A-R3-5): when the exec fails after the stream
   * was hijacked (the runtime's refusal of an exec in a container that just stopped), the daemon writes the error to the
   * stdout of the exec and the CLI exits 126, so a failed call is matched on stderr and stdout; every alternative of
   * NO_STORED_SCRIPT starts a line, so a hash on stdout never matches.
   */
  private async storedScript(script: string, signal: AbortSignal | undefined): Promise<StoredScript> {
    let result: RunResult;
    try {
      result = await this.options.docker.run(['exec', this.containerName, 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH], {
        timeoutMs: REMOTE_MONITOR_EXEC_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return 'unknown';
    }
    if (result.timedOut) return 'unknown';
    if (result.exitCode === 0) {
      const hash = result.stdout.trim().split(/\s+/)[0] ?? '';
      if (!/^[0-9a-f]{64}$/.test(hash)) return 'unknown';
      return hash === bundleHash(script) ? 'same' : 'other';
    }
    return NO_STORED_SCRIPT.test(`${result.stderr}\n${result.stdout}`) ? 'other' : 'unknown';
  }

  /** One heartbeat (`monitor.js heartbeat <json>` under the lock of the records, heartbeatCommand). */
  async heartbeat(input: HeartbeatInput): Promise<MonitorExecResult> {
    return this.exec(heartbeatCommand(input));
  }

  /** The records of an environment (`monitor.js records <id>`); undefined when they cannot be read. */
  async records(environmentId: string): Promise<RecordsOutput | undefined> {
    const result = await this.exec(recordsCommand(environmentId));
    return result.ok ? parseRecordsOutput(result.stdout) : undefined;
  }

  /**
   * User request 2026-09-28 ("all images"): stores the repositories that the extension read from the registry, for the
   * image maintenance of the monitor (`monitor.js images -`, the list on stdin). Best effort: a failure is logged.
   */
  async images(repositories: readonly string[]): Promise<boolean> {
    return this.execWithInput(imagesCommand(), JSON.stringify({ repositories }), 'The image list');
  }

  /**
   * Review round 1 of PR #57 (C): stores the settings of the image maintenance of this computer in the monitor (`monitor.js
   * settings -`, on stdin); it uses them from its next check on. Best effort: a failure is logged. Review round 1 (D):
   * resolves with false on a failure, so the caller tries again at the next open.
   */
  async imageSettings(settings: ImageMaintenanceSettings): Promise<boolean> {
    const input: ImageSettings = { prefixes: [...settings.prefixes], schedule: settings.schedule, timeZone: settings.timeZone };
    return this.execWithInput(imageSettingsCommand(), JSON.stringify(input), 'The image settings');
  }

  private async execWithInput(command: readonly string[], input: string, what: string): Promise<boolean> {
    try {
      const result = await this.options.docker.run(['exec', '-i', this.containerName, ...command], { timeoutMs: REMOTE_MONITOR_EXEC_TIMEOUT_MS, input });
      if (result.exitCode === 0 && !result.timedOut) return true;
      this.options.logger.warn(`${what} could not be given to the Session Monitor: ${result.timedOut ? 'no answer in time' : result.stderr.trim() || `exit code ${result.exitCode}`}`);
    } catch (error) {
      this.options.logger.warn(`${what} could not be given to the Session Monitor: ${errorMessage(error)}`);
    }
    return false;
  }

  /** Removes the record of `source` for an environment (Delete). Best effort: a failure is logged. */
  async forget(source: string, environmentId: string): Promise<void> {
    const result = await this.exec(forgetCommand(source, environmentId));
    if (!result.ok && !result.missing) {
      this.options.logger.warn(`The heartbeat record of ${environmentId} could not be removed from the Session Monitor: ${result.detail}`);
    }
  }

  /**
   * The arguments of `docker run` for the monitor container. `helperImage`: the helper tag, or an image ID (S1). Plan
   * step 3 (pipe loading): attached with an open input (`-i`, no `-d`) and without passing signals on
   * (`--sig-proxy=false`), so ending the client leaves the container running; the command is the pipe loader with the
   * path, the hash of `script`, and REMOTE_MONITOR_ENTRY. The script itself goes over the input (ensure), never here.
   * `createId`: the nonce of this create (LABEL_MONITOR_CREATE; review round 1 of PR #69, A-R1-2), which ensure always
   * passes.
   */
  runArgs(helperImage: string, socketPath: string, label: string, script: string, images?: ImageMaintenanceSettings, createId?: string): string[] {
    const imagePrefixes = images?.prefixes ?? [];
    // Review round 4 of PR #64 (R4-8): never a pull, like the helper runs: the helper image exists only on the engine, and
    // a missing image must not be looked up in a registry under its name.
    const args = ['run', '-i', '--sig-proxy=false', '--pull', 'never', '--name', this.containerName, '--label', `${LABEL_SESSION_MONITOR}=${label}`];
    if (createId !== undefined) args.push('--label', `${LABEL_MONITOR_CREATE}=${createId}`);
    for (const [key, value] of Object.entries(this.options.labels ?? {})) args.push('--label', `${key}=${value}`);
    // Our own container: it survives a restart of the daemon (the refusal of restart policies is for the containers of
    // repositories); after a restart the loader resumes from the stored script. No published port, no capability: it
    // needs the socket and its volume. User requests 2026-09-28: with image maintenance it reads the tags of the
    // registry, so it has the default network then (outbound only); without it, no network.
    args.push('--restart', 'unless-stopped');
    if (imagePrefixes.length === 0) args.push('--network', 'none');
    args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
    // Monitor cleanup, user decision 2026-09-29 (R5): its own Docker log is capped (two files of at most 1 MB). The driver
    // is named, as max-size fails on a host whose default driver is journald or syslog.
    args.push(...REMOTE_MONITOR_LOG_OPTIONS);
    args.push('-v', `${socketPath}:/var/run/docker.sock`, '-v', `${this.volumeName}:${REMOTE_MONITOR_STATE_DIR}`);
    for (const [key, value] of Object.entries(this.options.containerEnv ?? {})) args.push('-e', `${key}=${value}`);
    if (images && imagePrefixes.length > 0) {
      // Plan step 3: the command line holds no script, so all prefixes fit (imagePrefixesOf keeps them within
      // MAX_IMAGE_PREFIXES_JSON_LENGTH); the whole list comes with `settings -` at each open anyway.
      args.push(
        '-e',
        `DEVENV_IMAGE_PREFIXES=${JSON.stringify(imagePrefixes)}`,
        '-e',
        `DEVENV_IMAGE_SCHEDULE=${images.schedule}`,
        '-e',
        `DEVENV_IMAGE_TZ=${images.timeZone}`,
      );
    }
    args.push(helperImage, ...loaderCommand({ path: REMOTE_MONITOR_SCRIPT_PATH, hash: bundleHash(script), entry: REMOTE_MONITOR_ENTRY }));
    return args;
  }

  private async exec(command: readonly string[]): Promise<MonitorExecResult> {
    try {
      const result = await this.options.docker.run(['exec', this.containerName, ...command], { timeoutMs: REMOTE_MONITOR_EXEC_TIMEOUT_MS });
      if (result.exitCode === 0 && !result.timedOut) return { ok: true, stdout: result.stdout };
      const detail = result.timedOut
        ? `docker exec did not end within ${REMOTE_MONITOR_EXEC_TIMEOUT_MS / 1000} seconds.`
        : (result.stderr || result.stdout).trim() || monitorExecFailure(result.exitCode, '', isUnderRecordsLock(command));
      return { ok: false, missing: isMissingContainer(result), detail };
    } catch (error) {
      return { ok: false, missing: false, detail: errorMessage(error) };
    }
  }

  private async inspect(signal: AbortSignal | undefined): Promise<Inspected> {
    const args = [
      'container',
      'inspect',
      '--format',
      `{{json .State.Status}}\t{{json .State.ExitCode}}\t{{json .Config.Labels}}\t{{json .RestartCount}}\t{{json .Id}}\t{{json .Created}}`,
      this.containerName,
    ];
    const result = await this.options.docker.run(args, { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal });
    if (result.exitCode !== 0) {
      if (isMissingContainer(result)) return { exists: false };
      throw new Error(`docker container inspect failed: ${result.timedOut ? 'no answer in time' : result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
    const [statusText = '', exitCodeText = '', labelsText = '', restartCountText = '', idText = '', createdText = ''] = result.stdout.trim().split('\t');
    const status = parseJson(statusText);
    const exitCode = parseJson(exitCodeText);
    const labels = parseJson(labelsText);
    const restartCount = parseJson(restartCountText);
    const id = parseJson(idText);
    const value = typeof labels === 'object' && labels !== null ? (labels as Record<string, unknown>)[LABEL_SESSION_MONITOR] : undefined;
    return {
      exists: true,
      status: typeof status === 'string' ? status : '',
      exitCode: typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : undefined,
      label: typeof value === 'string' ? value : '',
      restartCount: typeof restartCount === 'number' && Number.isInteger(restartCount) && restartCount > 0 ? restartCount : 0,
      id: typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) ? id : undefined,
      createdAt: parseDockerTime(parseJson(createdText)),
    };
  }

  private async docker(args: readonly string[], signal: AbortSignal | undefined): Promise<void> {
    const result = await this.options.docker.run(args, { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal });
    // Review round 3 of PR #69 (A-R3-1): an `rm` whose container is gone or is being removed by another window already.
    const tolerated = args[0] === 'rm' && (isMissingContainer(result) || (!result.timedOut && REMOVAL_IN_PROGRESS.test(result.stderr)));
    if (result.exitCode !== 0 && !tolerated) {
      throw new Error(`docker ${args[0]} failed: ${result.timedOut ? 'no answer in time' : result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
  }
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

/**
 * Review round 4 of PR #69 (A-R4-1): a time of Docker as JSON gives it (Go's RFC 3339 with nanoseconds, `Z` or an
 * offset), in milliseconds since the epoch; undefined for anything else (never a guess).
 */
export function parseDockerTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const fraction = Number(`0.${match[7] ?? '0'}`);
  const zone = match[8];
  const offsetMinutes = zone === 'Z' ? 0 : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) + Math.floor(fraction * 1000) - offsetMinutes * 60_000;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day ? ms : undefined;
}

/** Review round 4 of PR #69 (A-R4-1): waits until `client` ended, at most `ms`. */
function exitedWithin(client: StartedProcess, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void client.exited.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
