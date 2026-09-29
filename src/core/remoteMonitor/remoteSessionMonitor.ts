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
import { errorMessage } from '../errors';
import { LOADER_EXIT_CODE, MAX_BUNDLE_LINE_LENGTH, bundleHash, encodeBundle, loaderCommand } from '../loader/pipeLoader';
import { abortError, isAbortError, type Logger, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import {
  IMAGE_MAINTENANCE_LABEL_PART,
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
 * `exited`, `dead`), the exit code of its last run, and its label.
 */
type Inspected = { exists: false } | { exists: true; status: string; exitCode: number | undefined; label: string };

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
   * - the matching label and running or paused → nothing;
   * - the matching label and exited with an exit code other than LOADER_EXIT_CODE → `docker start` (the loader resumes
   *   from the stored script);
   * - the matching label and created, restarting, dead, removing, or exited with LOADER_EXIT_CODE (the loader refused
   *   its stored script and its input), another label, or none → `docker rm -f`, then create;
   * - missing → create.
   * Create: the attached `docker run -i --sig-proxy=false` (runArgs) gets the script as its first input line, and the
   * monitor is up when its output has REMOTE_MONITOR_READY_TEXT within REMOTE_MONITOR_DOCKER_TIMEOUT_MS; then the client
   * is ended. When another window created it meanwhile (a name conflict), it looks once more and accepts a matching one
   * that runs. Any other failure (no ready line in time, the container ended, a cancellation) kills the client and
   * removes the container (`docker rm -f`, best effort). `socketPath`: the source of the socket mount on the host of the
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
      const runArgs = this.runArgs(helperImage ?? helperTag, socketPath, label, script, images);
      const current = await this.inspect(signal);
      if (current.exists && current.label === label) {
        if (isRunning(current.status)) return 'running';
        if (current.status === 'exited' && current.exitCode !== LOADER_EXIT_CODE) {
          await this.docker(['start', this.containerName], signal);
          logger.info(`The Session Monitor on the Docker host was started again (${this.containerName}).`);
          return 'started';
        }
        const how = current.status === 'exited' ? `exited with ${current.exitCode}` : current.status;
        logger.info(`The Session Monitor on the Docker host does not run (${how}); it is replaced (${this.containerName}).`);
      } else if (current.exists) {
        logger.info(`The Session Monitor on the Docker host is of another version; it is replaced (${this.containerName}).`);
      }
      if (current.exists) await this.docker(['rm', '-f', this.containerName], signal);
      const created = await this.create(runArgs, scriptLine, signal);
      if (created.kind === 'ready') {
        logger.info(`The Session Monitor on the Docker host was created (${this.containerName}, image ${helperTag}).`);
        return 'created';
      }
      // Another window created it at the same time: accept it when it is the same version and runs. It is not ours, so it
      // is not removed.
      if (created.kind === 'exited' && created.conflict) {
        const again = await this.inspect(signal);
        if (again.exists && again.label === label && isRunning(again.status)) return 'running';
        throw new Error(`docker run failed: ${created.detail}`);
      }
      await this.removeBestEffort();
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
        stderr = (stderr + text).slice(-4_000);
      });
      void client.exited.then(({ exitCode, error }) => {
        const detail = error ? error.message : stderr.trim() || `exit code ${exitCode}`;
        settle({ kind: 'exited', detail, conflict: /conflict|already in use/i.test(stderr) });
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
    return created;
  }

  /** `docker rm -f` of the monitor after a failed create; a failure is ignored (the next open replaces it anyway). */
  private async removeBestEffort(): Promise<void> {
    try {
      await this.options.docker.run(['rm', '-f', this.containerName], { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS });
    } catch {
      // Best effort.
    }
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
   */
  runArgs(helperImage: string, socketPath: string, label: string, script: string, images?: ImageMaintenanceSettings): string[] {
    const imagePrefixes = images?.prefixes ?? [];
    // Review round 4 of PR #64 (R4-8): never a pull, like the helper runs: the helper image exists only on the engine, and
    // a missing image must not be looked up in a registry under its name.
    const args = ['run', '-i', '--sig-proxy=false', '--pull', 'never', '--name', this.containerName, '--label', `${LABEL_SESSION_MONITOR}=${label}`];
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
    const args = ['container', 'inspect', '--format', `{{json .State.Status}}\t{{json .State.ExitCode}}\t{{json .Config.Labels}}`, this.containerName];
    const result = await this.options.docker.run(args, { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal });
    if (result.exitCode !== 0) {
      if (isMissingContainer(result)) return { exists: false };
      throw new Error(`docker container inspect failed: ${result.timedOut ? 'no answer in time' : result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
    const [statusText = '', exitCodeText = '', labelsText = ''] = result.stdout.trim().split('\t');
    const status = parseJson(statusText);
    const exitCode = parseJson(exitCodeText);
    const labels = parseJson(labelsText);
    const value = typeof labels === 'object' && labels !== null ? (labels as Record<string, unknown>)[LABEL_SESSION_MONITOR] : undefined;
    return {
      exists: true,
      status: typeof status === 'string' ? status : '',
      exitCode: typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : undefined,
      label: typeof value === 'string' ? value : '',
    };
  }

  private async docker(args: readonly string[], signal: AbortSignal | undefined): Promise<void> {
    const result = await this.options.docker.run(args, { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal });
    if (result.exitCode !== 0 && !(args[0] === 'rm' && isMissingContainer(result))) {
      throw new Error(`docker ${args[0]} failed: ${result.timedOut ? 'no answer in time' : result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
