// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D2 (decision of 2026-10-03, "every remote action is a worker operation"): what the ensure of the Session
// Monitor container (RemoteSessionMonitor) asks of its Docker engine, as a port of its own. Before, the extension's
// RemoteMonitorDocker took the arguments of the Docker CLI (`docker container inspect --format …`, `docker run -i …`); now
// the worker implements it over the Engine API (src/core/worker/engineMonitor.ts). The decision logic of the ensure is
// unchanged. Pure types and the shared readings of the engine's answers; no I/O, no `vscode`.

/**
 * The state of the monitor container: missing, or its status (`created`, `running`, `paused`, `restarting`, `removing`,
 * `exited`, `dead`), the exit code of its last run, its label (LABEL_SESSION_MONITOR), how often Docker restarted it by
 * its restart policy since its last start by a client (`RestartCount`; 0 when it cannot be read), its ID (64 hex digits;
 * undefined when it cannot be read; review round 2 of PR #69, A-R2-2), and when the daemon created it (milliseconds
 * since the epoch on the clock of the daemon; undefined when it cannot be read; review round 4 of PR #69, A-R4-1).
 */
export type MonitorInspected =
  | { exists: false }
  | { exists: true; status: string; exitCode: number | undefined; label: string; restartCount: number; id: string | undefined; createdAt: number | undefined };

/**
 * What the check of the stored script of the running container found (`sha256sum` of REMOTE_MONITOR_SCRIPT_PATH in it):
 * its hash (as printed; the caller checks it), `none` (definite evidence that no script is stored or that the container
 * does not run), or `unknown` (the check itself failed: no answer in time, a transport error, an unexpected answer).
 */
export type MonitorStoredScript = { hash: string } | 'none' | 'unknown';

/** How the attached create of the monitor ended: its ready line, its end (with a name conflict), the time limit, a cancel. */
export type MonitorCreated = { kind: 'ready' } | { kind: 'exited'; detail: string; conflict: boolean } | { kind: 'timeout' } | { kind: 'aborted' };

/** The container of the monitor as its create makes it (RemoteSessionMonitor.runSpec). */
export interface MonitorRunSpec {
  name: string;
  /** The helper tag, or the checked image ID of the helper image, or its monitor tag (plan step 11D3; never pulled). */
  image: string;
  /**
   * Plan step 11D3 (option B of 2026-10-03): the image ID that the container must have when `image` is a tag (the
   * monitor tag of the pinned helper image). The create checks it before the start; another image is a failure of the
   * create (`exited`), and the caller removes the container by its labels.
   */
  imageId?: string;
  labels: Record<string, string>;
  /**
   * Plan step 8, PR B (Q5): `on-failure`. Plan step 11H2 (the user's decision "unless-stopped" of 2026-10-09):
   * `unless-stopped` for a monitor that runs permanently (monitorRestartPolicy).
   */
  restartPolicy: 'on-failure' | 'unless-stopped';
  /**
   * User requests 2026-09-28: the default network with image maintenance (outbound only), else none. Plan step 11H2 (D1
   * of 2026-10-09): always the default network (the VS Code server of its background run; it publishes no port).
   */
  network: 'none' | 'default';
  /** Monitor cleanup, user decision 2026-09-29 (R5): the json-file driver with two files of at most 1 MB. */
  log: { driver: 'json-file'; maxSize: string; maxFile: string };
  /**
   * The socket of the engine and the state volume. Plan step 11H2: and the shared VS Code server store of the engine
   * (`store`: its volume, read-write at its target, with `nocopy` as the worker mounts it), when the worker has one.
   */
  mounts: { socket: string; volume: string; volumeTarget: string; store?: { volume: string; target: string } };
  env: Record<string, string>;
  /** The pipe loader with the path, the hash of the script and its entry (loaderCommand). */
  command: string[];
}

/** The engine of the monitor container (see the module comment). Each call is bounded by the implementation. */
export interface MonitorEngine {
  /** The container `name`; rejects with the cause when it cannot be read (a missing one is `exists: false`). */
  inspect(name: string, signal?: AbortSignal): Promise<MonitorInspected>;
  /** The clock of the daemon in milliseconds since the epoch, or the reason it cannot be read. A cancel passes. */
  daemonTime(signal?: AbortSignal): Promise<number | { reason: string }>;
  /**
   * Removes the container `id` (by its ID, never its name). A container that is gone, or whose removal another window
   * runs already (review round 3 of PR #69, A-R3-1), is no failure; anything else rejects with the cause.
   */
  remove(id: string, signal?: AbortSignal): Promise<void>;
  /** Starts the container `id`; rejects with the cause. */
  start(id: string, signal?: AbortSignal): Promise<void>;
  /** The check of the stored script of the container `name` (MonitorStoredScript). A cancel passes. */
  storedScript(name: string, signal?: AbortSignal): Promise<MonitorStoredScript>;
  /** The IDs of the containers with the label `label` (`key=value`), stopped ones included; undefined when the list fails. */
  idsWithLabel(label: string, signal?: AbortSignal): Promise<string[] | undefined>;
  /**
   * The attached create of the monitor (plan step 3, pipe loading): creates the container of `spec`, writes `scriptLine`
   * (the first line of the loader) to its input, and waits for `readyText` on its output, its end, the time limit, or the
   * cancellation; then its input is closed (the container goes on alone). Never rejects, except for a failure before the
   * container exists (then nothing is left behind).
   */
  create(spec: MonitorRunSpec, scriptLine: string, readyText: string, signal?: AbortSignal): Promise<MonitorCreated>;
}

/**
 * A failed `sha256sum` that shows that no script is stored, or that the container does not run (in its output or the
 * engine's message). Review round 3 of PR #69 (B-R3-1): each alternative is tied to the start of a line of its source
 * (`sha256sum`, the OCI runtime), so an unrelated line of a transport failure that also says "No such file or
 * directory" is no evidence. A-R3-4: a stored script that cannot be read (`Permission denied`) is no evidence either.
 * A-R3-5: the runtime's refusal of an exec in a container that stopped between two restarts is evidence that it does not
 * run (the wording of newer runc and the older one), which the daemon writes to the output of the exec. Plan step 11D2:
 * the engine's refusal of the exec itself comes as its status (engineMonitor). Cleanup C4 (plan step 11J): the forms of
 * the Docker CLI are gone (`Error response from daemon: ` or `Error: ` before "No such container" or "container … is not
 * running/restarting", and before the runtime's message): over the Engine API the exec's output carries only what the
 * process and the daemon write to it, never the CLI's prefixes, so only the removed CLI testkit of the ensure produced them.
 */
export const NO_STORED_SCRIPT =
  /^sha256sum: .*No such file or directory|^OCI runtime exec failed: exec failed: cannot exec (?:in a stopped container|a container that has stopped)\b/im;

/** Review round 3 of PR #69 (A-R3-1): another window removes the same container right now; its removal goes on. */
export const REMOVAL_IN_PROGRESS = /removal of container .* is already in progress/i;

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
