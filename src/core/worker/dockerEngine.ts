// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1 (section 0 of the plan, one concept for commanding Docker): the one port through which a flow in the
// worker acts on its engine. It is implemented over the Docker Engine API (src/helperChannel/engineClient.ts); there is
// no `docker` process of our own behind it. The Docker CLI and Docker Compose run only as tools of the Dev Container CLI
// in the batch helper, and in the extension only for the bootstrap. Pure types and checks; no I/O, no `vscode`.
import { LABEL_COMPOSE_SERVICE } from '../names';
import type { ContainerInfo } from '../docker/dockerObjects';
import type { MonitorCreated, MonitorRunSpec } from '../remoteMonitor/monitorEngine';

/**
 * A container as a flow needs it: the pipeline's ContainerInfo (one shape, read by toContainerInfo of
 * dockerObjects.ts, plan step 11B3), with what `docker inspect` adds for the flows.
 */
export interface EngineContainer extends ContainerInfo {
  exitCode?: number;
  restartCount?: number;
  /** When the daemon created it (`Created`, RFC 3339). */
  created?: string;
}

/** Plan step 11B3: the kinds of objects whose inspect JSON the port reads. */
export type EngineObjectKind = 'container' | 'image' | 'volume' | 'network';

/** Plan step 11B3: the filters of a list request of the Engine API (`label`, `reference`, `dangling`, …). */
export type EngineFilters = Readonly<Record<string, readonly string[]>>;

/** Plan step 11B3: an image of a list (`GET /images/json`). */
export interface EngineImage {
  /** Its full ID (`sha256:…`). */
  id: string;
  /** Its references `repository:tag` (none for a dangling image). */
  repoTags: string[];
  repoDigests: string[];
  labels: Record<string, string>;
  /** When it was created (RFC 3339). */
  created: string;
}

/** Plan step 11B3: the registry login of a pull; the password or identity token is the secret `secretName` of the operation. */
export interface EnginePullLogin {
  serveraddress: string;
  /** Absent for an identity token. */
  username?: string;
  identityToken?: boolean;
  secretName: string;
}

/** What `exec` ran: the exit code of the process, and what it wrote. */
export interface EngineExecResult {
  /** `null` when the process ended through a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the time limit ended it. */
  timedOut: boolean;
}

/** The options of `exec` (plan step 11B1: the one primitive through which every script runs in a container). */
export interface EngineExecOptions {
  /** The user of the process, as `docker exec -u` takes it. */
  user?: string;
  /** Its working folder. */
  workdir?: string;
  /** Its standard input, then closed. */
  input?: string;
  /**
   * The name of the secret of the operation (OperationContext.secrets) whose value is its standard input instead: never
   * an argument, never a log line. A name, not a value (review round 1 of plan step 11B1, A-R1-3: ContainerAdapter's
   * `secretInput` is a value); an exec fails when the operation holds no such secret.
   */
  secretInputName?: string;
  /**
   * The output as it comes, in addition to the result. Plan step 11E1 (review round 1 of PR #102, A-L1): masked with
   * every secret of the operation, like the result; a tail that could start a secret comes with the next piece.
   */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Plan step 11E3a: the proxy of the daemon, as `docker info` shows it (Docker masks a password in it as `xxxxx`). */
export interface EngineProxy {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

/**
 * Plan step 11B1: the port of the engine. It grows with the flows that move into the worker (plan steps 11B2 to 11E);
 * every method here is one request to the Engine API, and every script that runs in a container goes through `exec`
 * (containerScripts.ts). Each method rejects with an EngineError, or with an AbortError when the signal aborts.
 */
export interface DockerEngine {
  /** The container `reference` (a name or an ID), or undefined when it does not exist. */
  container(reference: string, signal?: AbortSignal): Promise<EngineContainer | undefined>;
  /** The containers with the label `label` (`<key>` or `<key>=<value>`), stopped ones included. */
  containers(label: string, signal?: AbortSignal): Promise<EngineContainer[]>;
  /** One process in a running container (the one primitive for the scripts of containerScripts.ts). */
  exec(container: string, command: readonly string[], options?: EngineExecOptions): Promise<EngineExecResult>;
  /**
   * Stops the container (SIGTERM, then SIGKILL after `timeoutSeconds`, or after its own stop time when it is not given,
   * as `docker stop`); a container that is not running is left alone.
   */
  stop(container: string, timeoutSeconds?: number, signal?: AbortSignal): Promise<void>;
  /** Starts the container; one that runs already is left alone. */
  start(container: string, signal?: AbortSignal): Promise<void>;
  /** Plan step 11B3: the API version (`GET /version`, for example `1.48`) and the version of the engine. */
  version(signal?: AbortSignal): Promise<{ apiVersion: string; version: string }>;
  /** Plan step 11B3: the inspect JSON of an object (the same as `docker inspect`), or undefined when it does not exist. */
  inspect(kind: EngineObjectKind, reference: string, signal?: AbortSignal): Promise<unknown>;
  /** Plan step 11B3: the full IDs of the containers that match `filters`, stopped ones included. */
  containerIds(filters: EngineFilters, signal?: AbortSignal): Promise<string[]>;
  /** Plan step 11B3: the images that match `filters` (`dangling` included only when asked for). */
  images(filters: EngineFilters, signal?: AbortSignal): Promise<EngineImage[]>;
  /** Plan step 11B3: the names of the volumes that match `filters`. */
  volumeNames(filters: EngineFilters, signal?: AbortSignal): Promise<string[]>;
  /** Plan step 11B3: the names of the networks that match `filters`. */
  networkNames(filters: EngineFilters, signal?: AbortSignal): Promise<string[]>;
  /** Plan step 11B3: removes a container, running or not (`docker rm -f`); a missing one is no failure. */
  removeContainer(container: string, signal?: AbortSignal): Promise<void>;
  /** Plan step 11B3: renames a container (`docker rename`). */
  renameContainer(container: string, name: string, signal?: AbortSignal): Promise<void>;
  /** Plan step 11B3: removes an image without force: `missing` and `inUse` (409) are answers, not failures. */
  removeImage(reference: string, signal?: AbortSignal): Promise<'removed' | 'missing' | 'inUse'>;
  /** Plan step 11D3: tags the image `image` (an ID) as `reference` (`repository:tag`); a tag of another image moves. */
  tagImage(image: string, reference: string, signal?: AbortSignal): Promise<void>;
  /** Plan step 11B3: creates a volume with its labels; an existing one of the name is kept as it is (as `docker volume create`). */
  createVolume(name: string, labels: Record<string, string>, signal?: AbortSignal): Promise<void>;
  /** Plan step 11B3: removes a volume; a missing one is no failure, one in use is (409). */
  removeVolume(name: string, signal?: AbortSignal): Promise<void>;
  /** Plan step 11B3: removes a network; a missing one is no failure, one in use is. */
  removeNetwork(name: string, signal?: AbortSignal): Promise<void>;
  /**
   * Plan step 11B3: pulls `reference` (`POST /images/create`), the login only in the header X-Registry-Auth; each line
   * of `docker pull` goes to `onLine`. Throws with the message of the engine when the pull fails.
   */
  pull(reference: string, options?: { login?: EnginePullLogin; onLine?: (line: string) => void; signal?: AbortSignal }): Promise<void>;
  /**
   * Plan step 11B3 (decision of 2026-10-03, no extra containers where the API suffices): gives the image `image` the
   * labels `labels` without a build: a container is created from it (never started), committed under the same name with
   * `LABEL` changes, and removed. Answers the ID of the new image.
   */
  labelImage(image: string, labels: Record<string, string>, signal?: AbortSignal): Promise<string>;
  /**
   * Plan step 11G1 (decision of 2026-10-03, no extra containers where the API suffices): the content of the regular file
   * at the absolute path `path` of the image `image`, as UTF-8 text, read without running anything: a container is
   * created from the image (never started), the file is read through `GET /containers/<id>/archive`, and the container is
   * removed. Undefined when the path is missing, is no regular file (a link, a folder), or is larger than
   * MAX_IMAGE_FILE_BYTES; rejects with an EngineError for a missing image and the other failures.
   */
  imageFile(image: string, path: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Plan step 11D2: the clock of the daemon (`GET /info`, its SystemTime as Docker writes it). */
  systemTime(signal?: AbortSignal): Promise<string>;
  /**
   * Plan step 11E3a (decision C1 of 2026-10-05): the proxy of the daemon (`GET /info`: HttpProxy, HttpsProxy, NoProxy), an
   * empty one left out; the worker's outbound requests use it.
   */
  proxy(signal?: AbortSignal): Promise<EngineProxy>;
  /**
   * Plan step 11D2 (the Session Monitor container, plan step 3 pipe loading): creates the container of `spec` with an open
   * input, attaches to it, starts it, writes `input`, and waits for `readyText` on its output, its end, `timeoutMs`, or
   * the cancellation; then its input is closed (the container goes on alone). A create that the engine refuses is
   * `exited` (`conflict`: the name is in use); any other failure after the create request was sent is `exited`, `timeout`
   * (`timeoutMs` covers the create request too) or `aborted`, so the caller removes the container of this create by its
   * labels. Rejects only when nothing was sent.
   */
  createAttached(spec: MonitorRunSpec, options: { input: string; readyText: string; timeoutMs: number; signal?: AbortSignal }): Promise<MonitorCreated>;
}

/** Plan step 11G1: the largest file that DockerEngine.imageFile reads (in bytes). */
export const MAX_IMAGE_FILE_BYTES = 512 * 1024;

/** A failure of the engine: its message, and the HTTP status that it answered with. */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/** True when the engine answered that the container, image, volume or network does not exist. */
export function isMissing(error: unknown): boolean {
  return error instanceof EngineError && error.status === 404;
}

/**
 * Whether a container of an environment is its dev container: without the label nimblescape.devenv.compose-service of
 * the other services of Docker Compose, or with the name of the environment.
 */
export function isDevContainer(container: { name: string; labels: Record<string, string> }, containerName: string): boolean {
  return container.labels[LABEL_COMPOSE_SERVICE] === undefined || container.name === containerName;
}
