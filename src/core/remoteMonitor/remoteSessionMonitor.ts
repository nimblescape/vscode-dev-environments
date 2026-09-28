// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Session Monitor container on a remote Docker host, from the side of this computer (unit 7, PR 2; implementation
// notes 16): the open pipeline ensures it (ensure), the window of Close and Keep Running sends one heartbeat, and Delete
// removes the record of this computer. The Docker calls go through the current Docker context of the operation
// (ContainerAdapter.run pins DOCKER_CONTEXT); DOCKER_HOST is never set. No `vscode`.
import { errorMessage } from '../errors';
import { isAbortError, type Logger, type RunOptions, type RunResult } from '../ports';
import {
  LABEL_SESSION_MONITOR,
  MAX_SCRIPT_LENGTH,
  REMOTE_MONITOR_CONTAINER,
  REMOTE_MONITOR_SCRIPT_PATH,
  REMOTE_MONITOR_STATE_DIR,
  REMOTE_MONITOR_VOLUME,
  forgetCommand,
  heartbeatCommand,
  imagesCommand,
  parseRecordsOutput,
  recordsCommand,
  remoteMonitorLabelValue,
  type HeartbeatInput,
  type RecordsOutput,
} from './protocol';

/** Time limit of each Docker call of ensure (an SSH connection plus the call). */
export const REMOTE_MONITOR_DOCKER_TIMEOUT_MS = 60_000;
/** Time limit of a heartbeat, `records`, and `forget` (`docker exec`). */
export const REMOTE_MONITOR_EXEC_TIMEOUT_MS = 20_000;

/**
 * The container's command: it writes the script (its last argument) to REMOTE_MONITOR_SCRIPT_PATH and runs it. At each
 * start of the container, so the file always matches the container.
 */
export const REMOTE_MONITOR_BOOTSTRAP = `mkdir -p /opt/devenv && printf %s "$1" > ${REMOTE_MONITOR_SCRIPT_PATH} && exec node ${REMOTE_MONITOR_SCRIPT_PATH} run`;

/** The part of ContainerAdapter that is used here. */
export interface RemoteMonitorDocker {
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

export interface RemoteSessionMonitorOptions {
  docker: RemoteMonitorDocker;
  logger: Logger;
  /** The content of dist/remoteMonitor.js. */
  script: () => Promise<string>;
  /**
   * User requests 2026-09-28: the image maintenance of the monitor: the prefixes of the images that it updates and cleans
   * (the setting remoteImageUpdates, a trailing `*` dropped; none: no image maintenance), the daily time (`HH:MM`, the
   * setting remoteImageUpdateTime), and the time zone of this computer.
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
  time: string;
  timeZone: string;
}

/** What ensure found or did. `failed`: logged as a warning; the open goes on. */
export type EnsureOutcome = 'running' | 'started' | 'created' | 'failed';

/** The result of a `docker exec` in the monitor container. `missing`: the container does not exist or does not run. */
export type MonitorExecResult = { ok: true; stdout: string } | { ok: false; missing: boolean; detail: string };

/** The state of the monitor container: missing, or running and its label. */
type Inspected = { exists: false } | { exists: true; running: boolean; label: string };

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
   * Makes sure that the monitor container runs the current script with the helper image `helperTag`: one with the
   * matching label that runs → nothing; that is stopped → `docker start`; missing or with another label → `docker rm -f`,
   * then `docker run`. When another window created it meanwhile (a name conflict), it looks once more and accepts a
   * matching one that runs. `socketPath`: the source of the socket mount on the host of the engine (as for the workspace
   * helper, rootless aware). Never throws, except an AbortError; a failure is logged as a warning.
   */
  async ensure(helperTag: string, socketPath: string, signal?: AbortSignal): Promise<EnsureOutcome> {
    const { logger } = this.options;
    try {
      const script = await this.options.script();
      if (script.length > MAX_SCRIPT_LENGTH) throw new Error(`The script of the Session Monitor is too long (${script.length} characters).`);
      const images = this.options.imageMaintenance?.();
      const label = remoteMonitorLabelValue(script, helperTag, images && images.prefixes.length > 0 ? [...images.prefixes, images.time, images.timeZone] : []);
      const current = await this.inspect(signal);
      if (current.exists && current.label === label) {
        if (current.running) return 'running';
        await this.docker(['start', this.containerName], signal);
        logger.info(`The Session Monitor on the Docker host was started again (${this.containerName}).`);
        return 'started';
      }
      if (current.exists) {
        logger.info(`The Session Monitor on the Docker host is of another version; it is replaced (${this.containerName}).`);
        await this.docker(['rm', '-f', this.containerName], signal);
      }
      const created = await this.options.docker.run(this.runArgs(helperTag, socketPath, label, script, images), {
        timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS,
        signal,
      });
      if (created.exitCode === 0) {
        logger.info(`The Session Monitor on the Docker host was created (${this.containerName}, image ${helperTag}).`);
        return 'created';
      }
      // Another window created it at the same time: accept it when it is the same version and runs.
      if (/conflict|already in use/i.test(created.stderr)) {
        const again = await this.inspect(signal);
        if (again.exists && again.label === label && again.running) return 'running';
      }
      throw new Error(`docker run failed: ${(created.stderr || created.stdout).trim() || `exit code ${created.exitCode}`}`);
    } catch (error) {
      if (isAbortError(error)) throw error;
      logger.warn(
        `The Session Monitor on the Docker host could not be started: ${errorMessage(error)} Without it, a container there stops after its waiting time only while this computer is online and Docker is set to that host.`,
      );
      return 'failed';
    }
  }

  /** One heartbeat (`monitor.js heartbeat <json>`). */
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
  async images(repositories: readonly string[]): Promise<void> {
    try {
      const result = await this.options.docker.run(['exec', '-i', this.containerName, ...imagesCommand()], {
        timeoutMs: REMOTE_MONITOR_EXEC_TIMEOUT_MS,
        input: JSON.stringify({ repositories }),
      });
      if (result.exitCode !== 0 || result.timedOut) {
        this.options.logger.warn(`The image list could not be given to the Session Monitor: ${result.timedOut ? 'no answer in time' : result.stderr.trim() || `exit code ${result.exitCode}`}`);
      }
    } catch (error) {
      this.options.logger.warn(`The image list could not be given to the Session Monitor: ${errorMessage(error)}`);
    }
  }

  /** Removes the record of `source` for an environment (Delete). Best effort: a failure is logged. */
  async forget(source: string, environmentId: string): Promise<void> {
    const result = await this.exec(forgetCommand(source, environmentId));
    if (!result.ok && !result.missing) {
      this.options.logger.warn(`The heartbeat record of ${environmentId} could not be removed from the Session Monitor: ${result.detail}`);
    }
  }

  /** The arguments of `docker run` for the monitor container. */
  runArgs(helperTag: string, socketPath: string, label: string, script: string, images?: ImageMaintenanceSettings): string[] {
    const imagePrefixes = images?.prefixes ?? [];
    const args = ['run', '-d', '--name', this.containerName, '--label', `${LABEL_SESSION_MONITOR}=${label}`];
    for (const [key, value] of Object.entries(this.options.labels ?? {})) args.push('--label', `${key}=${value}`);
    // Our own container: it survives a restart of the daemon (the refusal of restart policies is for the containers of
    // repositories). No published port, no capability: it needs the socket and its volume. User requests 2026-09-28:
    // with image maintenance it reads the tags of the registry, so it has the default network then (outbound only);
    // without it, no network.
    args.push('--restart', 'unless-stopped');
    if (imagePrefixes.length === 0) args.push('--network', 'none');
    args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
    args.push('-v', `${socketPath}:/var/run/docker.sock`, '-v', `${this.volumeName}:${REMOTE_MONITOR_STATE_DIR}`);
    if (images && imagePrefixes.length > 0) {
      args.push('-e', `DEVENV_IMAGE_PREFIXES=${JSON.stringify(imagePrefixes)}`, '-e', `DEVENV_IMAGE_TIME=${images.time}`, '-e', `DEVENV_IMAGE_TZ=${images.timeZone}`);
    }
    for (const [key, value] of Object.entries(this.options.containerEnv ?? {})) args.push('-e', `${key}=${value}`);
    args.push(helperTag, 'sh', '-c', REMOTE_MONITOR_BOOTSTRAP, 'sh', script);
    return args;
  }

  private async exec(command: readonly string[]): Promise<MonitorExecResult> {
    try {
      const result = await this.options.docker.run(['exec', this.containerName, ...command], { timeoutMs: REMOTE_MONITOR_EXEC_TIMEOUT_MS });
      if (result.exitCode === 0 && !result.timedOut) return { ok: true, stdout: result.stdout };
      const detail = result.timedOut
        ? `docker exec did not end within ${REMOTE_MONITOR_EXEC_TIMEOUT_MS / 1000} seconds.`
        : (result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`;
      return { ok: false, missing: isMissingContainer(result), detail };
    } catch (error) {
      return { ok: false, missing: false, detail: errorMessage(error) };
    }
  }

  private async inspect(signal: AbortSignal | undefined): Promise<Inspected> {
    const args = ['container', 'inspect', '--format', `{{json .State.Running}}\t{{json .Config.Labels}}`, this.containerName];
    const result = await this.options.docker.run(args, { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal });
    if (result.exitCode !== 0) {
      if (isMissingContainer(result)) return { exists: false };
      throw new Error(`docker container inspect failed: ${result.timedOut ? 'no answer in time' : result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
    const [runningText = '', labelsText = ''] = result.stdout.trim().split('\t');
    let labels: unknown;
    try {
      labels = JSON.parse(labelsText);
    } catch {
      labels = undefined;
    }
    const value = typeof labels === 'object' && labels !== null ? (labels as Record<string, unknown>)[LABEL_SESSION_MONITOR] : undefined;
    return { exists: true, running: runningText === 'true', label: typeof value === 'string' ? value : '' };
  }

  private async docker(args: readonly string[], signal: AbortSignal | undefined): Promise<void> {
    const result = await this.options.docker.run(args, { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal });
    if (result.exitCode !== 0 && !(args[0] === 'rm' && isMissingContainer(result))) {
      throw new Error(`docker ${args[0]} failed: ${result.timedOut ? 'no answer in time' : result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
  }
}
