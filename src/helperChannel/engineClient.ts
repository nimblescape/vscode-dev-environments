// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1: the port `DockerEngine` of the flows in the worker (src/core/worker/dockerEngine.ts) over the Docker
// Engine API (engineApi.ts). One request per call, no `docker` process; `exec` runs over a hijacked connection, so the
// standard input of a script (its secret) never becomes an argument.
import { publicInfo, toContainerInfo, toLabels } from '../core/docker/dockerObjects';
import {
  EngineError,
  type DockerEngine,
  type EngineContainer,
  type EngineExecOptions,
  type EngineExecResult,
  type EngineFilters,
  type EngineImage,
  type EngineObjectKind,
  type EnginePullLogin,
  type EngineRun,
} from '../core/worker/dockerEngine';
import { abortError, isAbortError } from '../core/ports';
import { errorMessage } from '../core/errors';
import { readableStderr } from '../core/loader/pipeLoader';
import type { MonitorCreated, MonitorRunSpec } from '../core/remoteMonitor/monitorEngine';
import * as crypto from 'crypto';
import { hasTagOrDigest } from '../core/helperChannel/protocol';
import { StringDecoder } from 'string_decoder';
import { engineApi, engineErrorMessage, engineHijack, type EngineAnswer, type EngineApi, type EngineHijackRequest, type EngineStream } from './engineApi';

/**
 * The container of an inspect answer, read as the pipeline reads `docker inspect` (toContainerInfo of dockerObjects.ts,
 * plan step 11B3: one reading for both), with the exit code and the restarts.
 */
function containerOf(value: unknown): EngineContainer | undefined {
  const inspected = toContainerInfo(value);
  if (inspected === undefined) return undefined;
  const raw = value as { State?: { ExitCode?: unknown }; RestartCount?: unknown };
  const container: EngineContainer = publicInfo(inspected);
  if (typeof raw.State?.ExitCode === 'number') container.exitCode = raw.State.ExitCode;
  if (typeof raw.RestartCount === 'number') container.restartCount = raw.RestartCount;
  if (inspected.created !== '') container.created = inspected.created;
  return container;
}

/** The Engine API answer as JSON, or undefined when it cannot be read. */
function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** The hijacked start of an exec (engineHijack). */
export type EngineHijack = (request: EngineHijackRequest) => Promise<EngineStream>;

/** The path of an inspect of each kind. */
const INSPECT_PATHS: Record<EngineObjectKind, (reference: string) => string> = {
  container: (reference) => `/containers/${encodeURIComponent(reference)}/json`,
  image: (reference) => `/images/${encodeURIComponent(reference)}/json`,
  volume: (reference) => `/volumes/${encodeURIComponent(reference)}`,
  network: (reference) => `/networks/${encodeURIComponent(reference)}`,
};

/** The query of the filters of a list request. */
function filtersQuery(filters: EngineFilters): string {
  return `filters=${encodeURIComponent(JSON.stringify(filters))}`;
}

/**
 * The value of the header X-Registry-Auth: the credentials as JSON in URL-safe Base64 **with** its padding, as the
 * Docker CLI sends them (Go's base64.URLEncoding). Review round 1 of PR #89 (A-R1-1): the engine decodes it strictly and
 * ignores a header it cannot decode, so Node's `base64url` (without `=`) made it pull anonymously in 2 of 3 cases.
 * `identitytoken`: an identity token of `docker login` instead of a user and password (A-R1-3).
 */
export function registryAuthHeader(credentials: { username: string; password: string; serveraddress: string } | { identitytoken: string; serveraddress: string }): string {
  return Buffer.from(JSON.stringify(credentials), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

interface PullMessage {
  status?: unknown;
  id?: unknown;
  progressDetail?: { current?: unknown };
  error?: unknown;
  errorDetail?: { message?: unknown };
}

/**
 * The line of `docker pull` for one message of the engine's progress stream, or undefined for the progress bars of a
 * layer (`Downloading`, `Extracting` with a current size), which `docker pull` without a terminal does not print either.
 */
export function pullLine(message: PullMessage): string | undefined {
  if (typeof message.status !== 'string') return undefined;
  if (message.progressDetail !== undefined && typeof message.progressDetail === 'object' && message.progressDetail !== null && message.progressDetail.current !== undefined) {
    return undefined;
  }
  return typeof message.id === 'string' && message.id !== '' ? `${message.id}: ${message.status}` : message.status;
}

/** The time of the engine (seconds since 1970) as RFC 3339. */
function isoOf(seconds: unknown): string {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : '';
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Plan step 11B1: the port over the Engine API of the worker's engine. `secretOf` gives the value of a secret that the
 * operation holds (OperationContext.secrets), for the standard input of an exec (EngineExecOptions.secretInputName) and
 * the login of a pull; the port of an operation is built with its own secrets (review round 1 of plan step 11B1, A-R1-3).
 */
export function dockerEngine(api: EngineApi = engineApi(), hijack: EngineHijack = engineHijack(), secretOf: (name: string) => string | undefined = () => undefined): DockerEngine {
  const fail = (answer: { status: number; body: string }): never => {
    throw new EngineError(engineErrorMessage({ ...answer, truncated: false }), answer.status);
  };
  const inspect = async (kind: EngineObjectKind, reference: string, signal?: AbortSignal): Promise<unknown> => {
    const answer = await api({ method: 'GET', path: INSPECT_PATHS[kind](reference), signal });
    if (answer.status === 404) return undefined;
    if (answer.status !== 200) fail(answer);
    const value = json(answer.body);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new EngineError(`The engine answered the inspect of the ${kind} ${reference} with an invalid value.`, answer.status);
    return value;
  };
  const list = async (path: string, signal?: AbortSignal): Promise<unknown> => {
    const answer = await api({ method: 'GET', path, signal });
    if (answer.status !== 200) fail(answer);
    if (answer.truncated) throw new EngineError(`The engine answered ${path.split('?')[0]} with more than can be read.`, answer.status);
    const value = json(answer.body);
    if (value === undefined) throw new EngineError(`The engine answered ${path.split('?')[0]} with an invalid value.`, answer.status);
    return value;
  };
  const containerIds = async (filters: EngineFilters, signal?: AbortSignal): Promise<string[]> => {
    const value = await list(`/containers/json?all=true&${filtersQuery(filters)}`, signal);
    if (!Array.isArray(value)) throw new EngineError('The engine answered the list of the containers with an invalid value.', 200);
    return value.map((entry) => (entry as { Id?: unknown })?.Id).filter((id): id is string => typeof id === 'string' && id !== '');
  };
  return {
    container: async (reference, signal) => {
      const value = await inspect('container', reference, signal);
      if (value === undefined) return undefined;
      const container = containerOf(value);
      if (container === undefined) throw new EngineError('The engine answered the inspect of a container with an invalid value.', 200);
      return container;
    },
    containers: async (label, signal) => {
      const found: EngineContainer[] = [];
      for (const id of await containerIds({ label: [label] }, signal)) {
        const value = await inspect('container', id, signal);
        // Removed since the list.
        if (value === undefined) continue;
        const container = containerOf(value);
        if (container !== undefined) found.push(container);
      }
      return found;
    },
    exec: (container, command, options = {}) => execInContainer(api, hijack, secretOf, container, command, options),
    stop: async (container, timeoutSeconds, signal) => {
      const query = timeoutSeconds === undefined ? '' : `?t=${timeoutSeconds}`;
      const answer = await api({ method: 'POST', path: `/containers/${encodeURIComponent(container)}/stop${query}`, signal });
      // 204: stopped; 304: it did not run.
      if (answer.status !== 204 && answer.status !== 304) fail(answer);
    },
    start: async (container, signal) => {
      const answer = await api({ method: 'POST', path: `/containers/${encodeURIComponent(container)}/start`, signal });
      // 204: started; 304: it runs already.
      if (answer.status !== 204 && answer.status !== 304) fail(answer);
    },
    version: async (signal) => {
      const value = (await list('/version', signal)) as { ApiVersion?: unknown; Version?: unknown };
      return { apiVersion: typeof value?.ApiVersion === 'string' ? value.ApiVersion : '', version: typeof value?.Version === 'string' ? value.Version : '' };
    },
    inspect,
    containerIds,
    images: async (filters, signal) => {
      const value = await list(`/images/json?${filtersQuery(filters)}`, signal);
      if (!Array.isArray(value)) throw new EngineError('The engine answered the list of the images with an invalid value.', 200);
      const images: EngineImage[] = [];
      for (const entry of value as Record<string, unknown>[]) {
        if (typeof entry?.Id !== 'string' || entry.Id === '') continue;
        images.push({
          id: entry.Id,
          // The engine names a dangling image `<none>:<none>` in older versions.
          repoTags: texts(entry.RepoTags).filter((tag) => tag !== '<none>:<none>'),
          repoDigests: texts(entry.RepoDigests).filter((digest) => digest !== '<none>@<none>'),
          labels: toLabels(entry.Labels),
          created: isoOf(entry.Created),
        });
      }
      return images;
    },
    volumeNames: async (filters, signal) => {
      const value = (await list(`/volumes?${filtersQuery(filters)}`, signal)) as { Volumes?: unknown };
      if (value?.Volumes !== null && !Array.isArray(value?.Volumes)) throw new EngineError('The engine answered the list of the volumes with an invalid value.', 200);
      return (value.Volumes ?? []).map((entry: unknown) => (entry as { Name?: unknown })?.Name).filter((name: unknown): name is string => typeof name === 'string' && name !== '');
    },
    networkNames: async (filters, signal) => {
      const value = await list(`/networks?${filtersQuery(filters)}`, signal);
      if (!Array.isArray(value)) throw new EngineError('The engine answered the list of the networks with an invalid value.', 200);
      return [...new Set(value.map((entry) => (entry as { Name?: unknown })?.Name).filter((name): name is string => typeof name === 'string' && name !== ''))];
    },
    removeContainer: async (container, signal) => {
      const answer = await api({ method: 'DELETE', path: `/containers/${encodeURIComponent(container)}?force=true`, signal });
      if (answer.status !== 204 && answer.status !== 404) fail(answer);
    },
    renameContainer: async (container, name, signal) => {
      const answer = await api({ method: 'POST', path: `/containers/${encodeURIComponent(container)}/rename?name=${encodeURIComponent(name)}`, signal });
      if (answer.status !== 204) fail(answer);
    },
    removeImage: async (reference, signal) => {
      const answer = await api({ method: 'DELETE', path: `/images/${encodeURIComponent(reference)}`, signal });
      if (answer.status === 200) return 'removed';
      if (answer.status === 404) return 'missing';
      // In use by a container, or the parent of another image.
      if (answer.status === 409) return 'inUse';
      return fail(answer);
    },
    createVolume: async (name, labels, signal) => {
      const answer = await api({ method: 'POST', path: '/volumes/create', json: { Name: name, Labels: labels }, signal });
      if (answer.status !== 201 && answer.status !== 200) fail(answer);
    },
    removeVolume: async (name, signal) => {
      const answer = await api({ method: 'DELETE', path: `/volumes/${encodeURIComponent(name)}`, signal });
      if (answer.status !== 204 && answer.status !== 404) fail(answer);
    },
    removeNetwork: async (name, signal) => {
      const answer = await api({ method: 'DELETE', path: `/networks/${encodeURIComponent(name)}`, signal });
      if (answer.status !== 204 && answer.status !== 404) fail(answer);
    },
    pull: (reference, options = {}) => pullImage(api, secretOf, reference, options),
    labelImage: async (image, labels, signal) => {
      const inspected = (await inspect('image', image, signal)) as { Config?: Record<string, unknown> } | undefined;
      if (inspected === undefined) throw new EngineError(`The image ${image} does not exist.`, 404);
      const config = { ...(inspected.Config ?? {}) };
      config.Labels = { ...toLabels(config.Labels), ...labels };
      // Created only to be committed: never started, and removed again; its command is never run.
      if (signal?.aborted) throw abortError();
      // Review round 1 of 11B3a (A-R1-7): without the signal, so that a cancel never leaves it behind created but unknown.
      // A commit of an image without a command gives it this container's `Cmd ['true']` (the engine merges the
      // container's command into an empty one, A-R1-5); the images of an environment have one, or Dev Containers sets it.
      // On the classic image store the commit is a child of the previous image, which is then kept (A-R1-6).
      // Review round 2 of 11B3a (A-R2-3): no label of ours on it; the commit would copy it into the image.
      // Review round 3 of 11B3a (A-R3-1, A-R3-3): a name of its own (the commit does not copy it), by which it is removed
      // also when its create did not answer within its time limit.
      const name = `devenv-label-${crypto.randomBytes(6).toString('hex')}`;
      const removeByName = () =>
        api({ method: 'DELETE', path: `/containers/${name}?force=true&v=true`, signal: AbortSignal.timeout(RUN_CLEANUP_TIMEOUT_MS) }).catch(() => undefined);
      const limit = AbortSignal.timeout(RUN_CLEANUP_TIMEOUT_MS);
      let created: EngineAnswer;
      try {
        created = await api({ method: 'POST', path: `/containers/create?name=${name}`, json: { Image: image, Cmd: ['true'], Entrypoint: [], Labels: {} }, signal: limit });
      } catch (error) {
        // Review round 4 of 11B3a (A-R4-2, A-R4-3): the engine may have created it although the answer failed; the name is
        // ours, so it goes in every case. A create that the engine ends only after this removal stays behind, never
        // started, findable by the `devenv-label-` name.
        await removeByName();
        if (!limit.aborted) throw error;
        throw new EngineError(`The engine did not answer the create of a container for the labels of ${image} within ${RUN_CLEANUP_TIMEOUT_MS / 1000} s.`, 0);
      }
      if (created.status !== 201) fail(created);
      const container = (json(created.body) as { Id?: unknown } | undefined)?.Id;
      if (typeof container !== 'string' || container === '') {
        await removeByName();
        throw new EngineError('The engine answered the create of a container with an invalid value.', created.status);
      }
      try {
        const [repository, tag] = splitTag(image);
        // The body is the configuration of the new image: the one of the image with the labels, not the container's.
        const committed = await api({
          method: 'POST',
          path: `/commit?container=${encodeURIComponent(container)}&repo=${encodeURIComponent(repository)}&tag=${encodeURIComponent(tag)}&pause=false`,
          json: config,
          signal,
        });
        if (committed.status !== 201) fail(committed);
        const id = (json(committed.body) as { Id?: unknown } | undefined)?.Id;
        if (typeof id !== 'string' || id === '') throw new EngineError('The engine answered the commit with an invalid value.', committed.status);
        return id;
      } finally {
        // Review round 1 of 11B3a (A-R1-1): with its anonymous volumes (`VOLUME` of the image), as `docker run --rm`.
        // Review round 2 of 11B3a (A-R2-2): within a time limit of its own, never the cancel signal.
        await api({ method: 'DELETE', path: `/containers/${encodeURIComponent(container)}?force=true&v=true`, signal: AbortSignal.timeout(RUN_CLEANUP_TIMEOUT_MS) }).catch(() => undefined);
      }
    },
    runContainer: (spec, options = {}) => runContainer(api, spec, options),
    systemTime: async (signal) => {
      const value = (await list('/info', signal)) as { SystemTime?: unknown };
      if (typeof value?.SystemTime !== 'string') throw new EngineError('The engine answered /info without its time.', 200);
      return value.SystemTime;
    },
    createAttached: (spec, options) => createAttached(api, hijack, spec, options),
  };
}

/**
 * Review round 2 of 11B3a (A-R2-2, A-R2-4): the time limit of the removal of a container of labelImage or runContainer,
 * and of the read of the log of a failed run; review round 3 (A-R3-3): also of the create of labelImage.
 */
export const RUN_CLEANUP_TIMEOUT_MS = 60_000;

/** The most of the output of runContainer that is kept. */
const MAX_RUN_OUTPUT_CHARACTERS = 64 * 1024;

/**
 * Plan step 11B3: `docker run --rm --init --pull never --network none` over the API: create, start, wait (within the
 * time limit), the output for its result, and the removal in every case.
 */
async function runContainer(
  api: EngineApi,
  spec: EngineRun,
  options: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  if (options.signal?.aborted) throw abortError();
  const ended = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, ended.signal]) : ended.signal;
  let timedOut = false;
  // Review round 2 of 11B3a (A-R2-2): the time limit covers the create too. A container whose create it cut may still
  // come to exist; the caller removes it by its labels (EnvironmentService.removeOwnershipContainers).
  let timer = options.timeoutMs === undefined ? undefined : setTimeout(() => ((timedOut = true), ended.abort()), options.timeoutMs);
  let id: string | undefined;
  try {
    const created = await api({
      method: 'POST',
      path: '/containers/create',
      signal,
      json: {
        Image: spec.image,
        Entrypoint: [spec.entrypoint],
        Cmd: [...spec.args],
        User: spec.user,
        Labels: spec.labels,
        HostConfig: {
          Init: true,
          NetworkMode: 'none',
          Mounts: spec.volumes.map((volume) => ({ Type: 'volume', Source: volume.name, Target: volume.target })),
        },
      },
    });
    if (created.status !== 201) throw new EngineError(engineErrorMessage({ ...created, truncated: false }), created.status);
    const createdId = (json(created.body) as { Id?: unknown } | undefined)?.Id;
    if (typeof createdId !== 'string' || createdId === '') throw new EngineError('The engine answered the create of a container with an invalid value.', created.status);
    id = createdId;
    const started = await api({ method: 'POST', path: `/containers/${id}/start`, signal });
    if (started.status !== 204 && started.status !== 304) throw new EngineError(engineErrorMessage({ ...started, truncated: false }), started.status);
    const waited = await api({ method: 'POST', path: `/containers/${id}/wait`, signal });
    if (waited.status !== 200) throw new EngineError(engineErrorMessage({ ...waited, truncated: false }), waited.status);
    // Review round 2 of 11B3a (A-R2-4): the time limit ends with the run; the log has a limit of its own, and without it
    // the exit code is still the answer.
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const code = (json(waited.body) as { StatusCode?: unknown } | undefined)?.StatusCode;
    const exitCode = typeof code === 'number' ? code : null;
    let output = '';
    if (exitCode !== 0) {
      // Review round 1 of 11B3a (A-R1-8): the end of the log, where the reason is.
      const limit = AbortSignal.timeout(RUN_CLEANUP_TIMEOUT_MS);
      const logs = await api({
        method: 'GET',
        path: `/containers/${id}/logs?stdout=true&stderr=true&tail=200`,
        signal: options.signal ? AbortSignal.any([options.signal, limit]) : limit,
      }).catch((error: unknown) => {
        if (options.signal?.aborted) throw error;
        return undefined;
      });
      // The frames of the log of a container without a terminal: their headers are left out.
      output = logs?.status === 200 ? logs.body.replace(/[\u0000-\u0002]\u0000\u0000\u0000[\s\S]{4}/g, '').slice(-MAX_RUN_OUTPUT_CHARACTERS) : '';
    }
    return { exitCode, output, timedOut: false };
  } catch (error) {
    if (timedOut) return { exitCode: null, output: '', timedOut: true };
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Removed in every case, also after a cancel (without its signal; review round 2 of 11B3a, A-R2-2: within a time
    // limit of its own).
    // Review round 1 of 11B3a (A-R1-1): with its anonymous volumes; a named volume (the workspace) is kept.
    if (id !== undefined) await api({ method: 'DELETE', path: `/containers/${id}?force=true&v=true`, signal: AbortSignal.timeout(RUN_CLEANUP_TIMEOUT_MS) }).catch(() => undefined);
  }
}

/** `repository:tag` of a reference with a tag (`registry:5000/name:1` → `registry:5000/name`, `1`); `latest` without one. */
function splitTag(reference: string): [string, string] {
  const slash = reference.lastIndexOf('/');
  const colon = reference.lastIndexOf(':');
  return colon > slash ? [reference.slice(0, colon), reference.slice(colon + 1)] : [reference, 'latest'];
}

/** `POST /images/create?fromImage=<reference>`, the login only in its header; the lines of `docker pull` to `onLine`. */
async function pullImage(
  api: EngineApi,
  secretOf: (name: string) => string | undefined,
  reference: string,
  options: { login?: EnginePullLogin; onLine?: (line: string) => void; signal?: AbortSignal },
): Promise<void> {
  // Review round 2 of 11B3a (A-R2-1): never a pull of every tag of a repository (`fromImage` without a tag).
  if (!hasTagOrDigest(reference)) throw new EngineError(`The pull of ${reference} needs a tag or a digest.`, 0);
  const headers: Record<string, string> = {};
  const login = options.login;
  if (login !== undefined) {
    const password = secretOf(login.secretName);
    if (password === undefined) throw new EngineError(`The operation holds no secret ${login.secretName} for the pull of ${reference}.`, 0);
    headers['X-Registry-Auth'] = registryAuthHeader(
      login.identityToken === true ? { identitytoken: password, serveraddress: login.serveraddress } : { username: login.username ?? '', password, serveraddress: login.serveraddress },
    );
  }
  let pending = '';
  // The start of the answer, for the message of an error answer (its body is one JSON object, not a stream).
  let head = '';
  let failure: string | undefined;
  const handleLine = (line: string) => {
    if (line.trim() === '') return;
    let message: PullMessage;
    try {
      message = JSON.parse(line) as PullMessage;
    } catch {
      options.onLine?.(line);
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    if (message.error !== undefined || message.errorDetail !== undefined) {
      failure ??= typeof message.errorDetail?.message === 'string' ? message.errorDetail.message : String(message.error);
      return;
    }
    const text = pullLine(message);
    if (text !== undefined) options.onLine?.(text);
  };
  const answer = await api({
    method: 'POST',
    path: `/images/create?fromImage=${encodeURIComponent(reference)}`,
    headers,
    signal: options.signal,
    onChunk: (chunk) => {
      if (head.length < 2_000) head += chunk.slice(0, 2_000 - head.length);
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        handleLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    },
  });
  handleLine(pending);
  if (answer.status !== 200) throw new EngineError(failure ?? engineErrorMessage({ ...answer, body: head }), answer.status);
  if (failure !== undefined) throw new EngineError(failure, answer.status);
}

/** The most text of each stream of an exec that the result keeps (onOutput still gets all of it). */
export const MAX_EXEC_OUTPUT_CHARACTERS = 1024 * 1024;

/** The output of an exec by stream, decoded across frames, each bounded (review round 1 of plan step 11B1, A-R1-13, A-R1-14). */
function execOutput(onOutput: EngineExecOptions['onOutput']) {
  const streams = { stdout: { decoder: new StringDecoder('utf8'), text: '' }, stderr: { decoder: new StringDecoder('utf8'), text: '' } };
  const add = (name: 'stdout' | 'stderr', text: string) => {
    if (text === '') return;
    const stream = streams[name];
    if (stream.text.length < MAX_EXEC_OUTPUT_CHARACTERS) stream.text += text.slice(0, MAX_EXEC_OUTPUT_CHARACTERS - stream.text.length);
    onOutput?.(name, text);
  };
  return {
    frame: (kind: 1 | 2, data: Buffer) => {
      const name = kind === 2 ? 'stderr' : 'stdout';
      add(name, streams[name].decoder.write(data));
    },
    result: () => {
      add('stdout', streams.stdout.decoder.end());
      add('stderr', streams.stderr.decoder.end());
      return { stdout: streams.stdout.text, stderr: streams.stderr.text };
    },
  };
}

/**
 * Plan step 11B1: one process in a running container. The exec is created, then started over a hijacked connection: its
 * standard input carries `input` (or the secret that `secretInputName` names), and its output comes back framed by
 * stream. `timeoutMs` covers every request of the exec and ends it (`timedOut`); the signal ends it with an AbortError.
 * Review round 1 of plan step 11B1: the time limit covers the create and the inspect too (A-R1-4); a process that
 * still runs when its output ended is a failure, never an exit code (A-R1-2); a secret that the operation does not hold
 * is a failure, never an empty input (A-R1-3).
 */
async function execInContainer(
  api: EngineApi,
  hijack: EngineHijack,
  secretOf: (name: string) => string | undefined,
  container: string,
  command: readonly string[],
  options: EngineExecOptions,
): Promise<EngineExecResult> {
  if (options.signal?.aborted) throw abortError();
  let input = options.input;
  if (options.secretInputName !== undefined) {
    input = secretOf(options.secretInputName);
    if (input === undefined) throw new EngineError(`The operation holds no secret ${options.secretInputName} for the process in the container.`, 0);
  }
  const ended = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, ended.signal]) : ended.signal;
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          ended.abort();
        }, options.timeoutMs);
  const output = execOutput(options.onOutput);
  try {
    const created = await api({
      method: 'POST',
      path: `/containers/${encodeURIComponent(container)}/exec`,
      signal,
      json: {
        AttachStdin: input !== undefined,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: [...command],
        ...(options.user !== undefined ? { User: options.user } : {}),
        ...(options.workdir !== undefined ? { WorkingDir: options.workdir } : {}),
      },
    });
    if (created.status !== 201) throw new EngineError(engineErrorMessage({ ...created, truncated: false }), created.status);
    const id = (json(created.body) as { Id?: unknown } | undefined)?.Id;
    if (typeof id !== 'string' || id === '') throw new EngineError('The engine answered the create of an exec with an invalid value.', created.status);
    const stream = await hijack({ path: `/exec/${encodeURIComponent(id)}/start`, json: { Detach: false, Tty: false }, signal, onFrame: output.frame });
    try {
      if (input !== undefined) stream.write(input);
      stream.end();
      await stream.ended;
    } finally {
      stream.destroy();
    }
    const inspected = await api({ method: 'GET', path: `/exec/${encodeURIComponent(id)}/json`, signal });
    if (inspected.status !== 200) throw new EngineError(engineErrorMessage({ ...inspected, truncated: false }), inspected.status);
    const state = json(inspected.body) as { ExitCode?: unknown; Running?: unknown } | undefined;
    if (state?.Running !== false) throw new EngineError('The output of the process in the container ended, but the process did not.', inspected.status);
    return { exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : null, ...output.result(), timedOut: false };
  } catch (error) {
    if (timedOut) return { exitCode: null, ...output.result(), timedOut: true };
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Plan step 11D2: the characters of the end of the error output of an attached create that are kept (for the log). */
const ATTACHED_STDERR_TAIL_LENGTH = 4_000;
/** Review round 4 of PR #69 (A-R4-2): the engine's refusal of a create whose name is in use. */
const NAME_CONFLICT = /\bConflict\. The container name\b.*\bis already in use\b/;

/**
 * Plan step 11D2 (plan step 3, pipe loading): the attached create of the Session Monitor over the API (DockerEngine.
 * createAttached): the create with an open input (OpenStdin, StdinOnce, as `docker run -i`), the attach (stdin, stdout,
 * stderr), the start, the input line, then the wait for `readyText` on the output (its end kept across frames), the end
 * of the output (the container ended), the time limit, or the cancel. The input is closed and the connection ended in
 * every case; the container goes on alone after its ready line.
 */
async function createAttached(
  api: EngineApi,
  hijack: EngineHijack,
  spec: MonitorRunSpec,
  options: { input: string; readyText: string; timeoutMs: number; signal?: AbortSignal },
): Promise<MonitorCreated> {
  if (options.signal?.aborted) throw abortError();
  const ended = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, ended.signal]) : ended.signal;
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), ended.abort()), options.timeoutMs);
  let stream: EngineStream | undefined;
  let stdout = '';
  let stderr = '';
  const decoders = { 1: new StringDecoder('utf8'), 2: new StringDecoder('utf8') };
  let onReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (onReady = resolve));
  const outcome = (error: unknown): MonitorCreated => {
    if (timedOut) return { kind: 'timeout' };
    if (options.signal?.aborted || isAbortError(error)) return { kind: 'aborted' };
    return { kind: 'exited', detail: errorMessage(error), conflict: false };
  };
  try {
    let created: EngineAnswer;
    try {
      created = await api({
        method: 'POST',
        path: `/containers/create?name=${encodeURIComponent(spec.name)}`,
        signal,
        json: {
          Image: spec.image,
          Cmd: [...spec.command],
          Labels: spec.labels,
          Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          OpenStdin: true,
          StdinOnce: true,
          Tty: false,
          HostConfig: {
            RestartPolicy: { Name: spec.restartPolicy },
            NetworkMode: spec.network === 'none' ? 'none' : 'default',
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
            LogConfig: { Type: spec.log.driver, Config: { 'max-size': spec.log.maxSize, 'max-file': spec.log.maxFile } },
            Binds: [`${spec.mounts.socket}:/var/run/docker.sock`, `${spec.mounts.volume}:${spec.mounts.volumeTarget}`],
          },
        },
      });
    } catch (error) {
      // The request was sent: the container may exist; the caller removes it by its labels.
      return outcome(error);
    }
    if (created.status !== 201) {
      const detail = engineErrorMessage({ ...created, truncated: false });
      return { kind: 'exited', detail, conflict: created.status === 409 && NAME_CONFLICT.test(detail) };
    }
    const id = (json(created.body) as { Id?: unknown } | undefined)?.Id;
    if (typeof id !== 'string' || id === '') return { kind: 'exited', detail: 'The engine answered the create of a container with an invalid value.', conflict: false };
    try {
      stream = await hijack({
        path: `/containers/${encodeURIComponent(id)}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        signal,
        onFrame: (kind, data) => {
          const text = decoders[kind].write(data);
          if (kind === 2) {
            stderr = (stderr + text).slice(-ATTACHED_STDERR_TAIL_LENGTH);
            return;
          }
          // Only the tail is kept: enough for the ready line across frames.
          stdout = (stdout + text).slice(-8_192);
          if (stdout.includes(options.readyText)) onReady();
        },
      });
      const started = await api({ method: 'POST', path: `/containers/${encodeURIComponent(id)}/start`, signal });
      if (started.status !== 204 && started.status !== 304) return { kind: 'exited', detail: engineErrorMessage({ ...started, truncated: false }), conflict: false };
      stream.write(options.input);
      const result = await Promise.race([
        ready.then((): MonitorCreated => ({ kind: 'ready' })),
        stream.ended.then(
          (): MonitorCreated => ({ kind: 'exited', detail: readableStderr(stderr, ATTACHED_STDERR_TAIL_LENGTH) || 'the container ended before it reported its start', conflict: false }),
          (error: unknown) => outcome(error),
        ),
        new Promise<MonitorCreated>((resolve) => signal.addEventListener('abort', () => resolve(outcome(undefined)), { once: true })),
      ]);
      return result;
    } catch (error) {
      return outcome(error);
    }
  } finally {
    clearTimeout(timer);
    if (stream !== undefined) {
      try {
        // The input ends (the loader read its line); the container goes on alone.
        stream.end();
      } catch {
        // A connection that ended already.
      }
      stream.destroy();
    }
  }
}
