// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11B1: the port `DockerEngine` of the flows in the worker (src/core/worker/dockerEngine.ts) over the Docker
// Engine API (engineApi.ts). One request per call, no `docker` process; `exec` runs over a hijacked connection, so the
// standard input of a script (its secret) never becomes an argument.
import { EngineError, type DockerEngine, type EngineContainer, type EngineExecOptions, type EngineExecResult } from '../core/worker/dockerEngine';
import { abortError } from '../core/ports';
import type { ContainerState } from '../core/types';
import { StringDecoder } from 'string_decoder';
import { engineApi, engineErrorMessage, engineHijack, type EngineApi, type EngineHijackRequest, type EngineStream } from './engineApi';

/** The state of a container as the flows know it (ContainerState); `rawState` keeps the status of the engine. */
function stateOf(running: boolean, paused: boolean): ContainerState {
  return running || paused ? 'running' : 'stopped';
}

interface InspectAnswer {
  Id?: unknown;
  Name?: unknown;
  Created?: unknown;
  RestartCount?: unknown;
  State?: { Status?: unknown; Running?: unknown; Paused?: unknown; ExitCode?: unknown };
  Config?: { Labels?: unknown; Image?: unknown };
  Image?: unknown;
  Mounts?: unknown;
}

function containerOf(value: InspectAnswer): EngineContainer | undefined {
  const id = value.Id;
  if (typeof id !== 'string' || id === '') return undefined;
  const status = typeof value.State?.Status === 'string' ? value.State.Status : '';
  const container: EngineContainer = {
    id,
    name: typeof value.Name === 'string' ? value.Name.replace(/^\//, '') : '',
    state: stateOf(value.State?.Running === true, value.State?.Paused === true),
    rawState: status,
    labels: typeof value.Config?.Labels === 'object' && value.Config.Labels !== null ? ({ ...value.Config.Labels } as Record<string, string>) : {},
    image: typeof value.Config?.Image === 'string' ? value.Config.Image : '',
  };
  if (typeof value.Image === 'string') container.imageId = value.Image;
  if (typeof value.State?.ExitCode === 'number') container.exitCode = value.State.ExitCode;
  if (typeof value.RestartCount === 'number') container.restartCount = value.RestartCount;
  if (typeof value.Created === 'string') container.created = value.Created;
  const mounts = value.Mounts;
  if (Array.isArray(mounts)) {
    const volumes = mounts
      .filter((mount): mount is { Type: string; Name: string } => typeof mount === 'object' && mount !== null && (mount as { Type?: unknown }).Type === 'volume')
      .map((mount) => mount.Name)
      .filter((name): name is string => typeof name === 'string');
    if (volumes.length > 0) container.volumes = volumes;
  }
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

/**
 * Plan step 11B1: the port over the Engine API of the worker's engine. `secretOf` gives the value of a secret that the
 * operation holds (OperationContext.secrets), for the standard input of an exec (EngineExecOptions.secretInputName);
 * the port of an operation is built with its own secrets (review round 1 of plan step 11B1, A-R1-3).
 */
export function dockerEngine(api: EngineApi = engineApi(), hijack: EngineHijack = engineHijack(), secretOf: (name: string) => string | undefined = () => undefined): DockerEngine {
  const fail = (answer: { status: number; body: string }): never => {
    throw new EngineError(engineErrorMessage({ ...answer, truncated: false }), answer.status);
  };
  return {
    container: async (reference, signal) => {
      const answer = await api({ method: 'GET', path: `/containers/${encodeURIComponent(reference)}/json`, signal });
      if (answer.status === 404) return undefined;
      if (answer.status !== 200) fail(answer);
      const value = json(answer.body);
      const container = typeof value === 'object' && value !== null ? containerOf(value as InspectAnswer) : undefined;
      if (container === undefined) throw new EngineError('The engine answered the inspect of a container with an invalid value.', answer.status);
      return container;
    },
    containers: async (label, signal) => {
      const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
      const answer = await api({ method: 'GET', path: `/containers/json?all=true&filters=${filters}`, signal });
      if (answer.status !== 200) fail(answer);
      const value = json(answer.body);
      if (!Array.isArray(value)) throw new EngineError('The engine answered the list of the containers with an invalid value.', answer.status);
      const found: EngineContainer[] = [];
      for (const entry of value as { Id?: unknown }[]) {
        if (typeof entry?.Id !== 'string') continue;
        const inspected = await api({ method: 'GET', path: `/containers/${encodeURIComponent(entry.Id)}/json`, signal });
        if (inspected.status === 404) continue;
        if (inspected.status !== 200) fail(inspected);
        const parsed = json(inspected.body);
        const container = typeof parsed === 'object' && parsed !== null ? containerOf(parsed as InspectAnswer) : undefined;
        if (container !== undefined) found.push(container);
      }
      return found;
    },
    exec: (container, command, options = {}) => execInContainer(api, hijack, secretOf, container, command, options),
    stop: async (container, timeoutSeconds, signal) => {
      const answer = await api({ method: 'POST', path: `/containers/${encodeURIComponent(container)}/stop?t=${timeoutSeconds}`, signal });
      // 204: stopped; 304: it did not run.
      if (answer.status !== 204 && answer.status !== 304) fail(answer);
    },
    start: async (container, signal) => {
      const answer = await api({ method: 'POST', path: `/containers/${encodeURIComponent(container)}/start`, signal });
      // 204: started; 304: it runs already.
      if (answer.status !== 204 && answer.status !== 304) fail(answer);
    },
  };
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
