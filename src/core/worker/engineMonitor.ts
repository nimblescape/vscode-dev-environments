// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D2 (decision of 2026-10-03, "every remote action is a worker operation"): the engine of the ensure of the
// Session Monitor (MonitorEngine) over the port of the worker's engine (DockerEngine, the Engine API). Each call has the
// time limit that the extension gave the same Docker call before (REMOTE_MONITOR_DOCKER_TIMEOUT_MS, the check of the
// stored script REMOTE_MONITOR_EXEC_TIMEOUT_MS); a call past it fails with "no answer in time", a cancel passes as an
// AbortError. No I/O of its own, no `vscode`.
import { errorMessage } from '../errors';
import { isAbortError, withTimeLimit } from '../ports';
import { NO_STORED_SCRIPT, REMOVAL_IN_PROGRESS, parseDockerTime, type MonitorEngine, type MonitorInspected } from '../remoteMonitor/monitorEngine';
import { LABEL_SESSION_MONITOR } from '../remoteMonitor/protocol';
import { REMOTE_MONITOR_DOCKER_TIMEOUT_MS, REMOTE_MONITOR_EXEC_TIMEOUT_MS } from '../remoteMonitor/remoteSessionMonitor';
import { runScript } from './containerScripts';
import { EngineError, isNotRunning, type DockerEngine } from './dockerEngine';

/**
 * `call` within `ms`: past it, an Error "no answer in time"; the cancel of `signal` passes as an AbortError. Cleanup after
 * plan step 11 (PR C2, B4): the one time-limited call (withTimeLimit), with the error of the ensure.
 */
export function limited<T>(ms: number, signal: AbortSignal | undefined, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return withTimeLimit(ms, signal, call, () => new Error('no answer in time'));
}

/** The inspect of a container as the ensure reads it (MonitorInspected). */
export function monitorInspected(value: unknown): MonitorInspected {
  if (value === undefined) return { exists: false };
  const raw = value as { State?: { Status?: unknown; ExitCode?: unknown }; Config?: { Labels?: unknown }; RestartCount?: unknown; Id?: unknown; Created?: unknown };
  const labels = raw.Config?.Labels;
  const label = typeof labels === 'object' && labels !== null ? (labels as Record<string, unknown>)[LABEL_SESSION_MONITOR] : undefined;
  const { RestartCount: restartCount, Id: id } = raw;
  const exitCode = raw.State?.ExitCode;
  return {
    exists: true,
    status: typeof raw.State?.Status === 'string' ? raw.State.Status : '',
    exitCode: typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : undefined,
    label: typeof label === 'string' ? label : '',
    restartCount: typeof restartCount === 'number' && Number.isInteger(restartCount) && restartCount > 0 ? restartCount : 0,
    id: typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) ? id : undefined,
    createdAt: parseDockerTime(raw.Created),
  };
}

/** MonitorEngine over the worker's engine (see the module comment). */
export function engineMonitor(engine: DockerEngine): MonitorEngine {
  return {
    async inspect(name, signal) {
      try {
        return monitorInspected(await limited(REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal, (limit) => engine.inspect('container', name, limit)));
      } catch (error) {
        if (isAbortError(error) && signal?.aborted) throw error;
        throw new Error(`docker container inspect failed: ${errorMessage(error)}`);
      }
    },

    async daemonTime(signal) {
      let text: string;
      try {
        text = await limited(REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal, (limit) => engine.systemTime(limit));
      } catch (error) {
        if (isAbortError(error) && signal?.aborted) throw error;
        return { reason: errorMessage(error) };
      }
      return parseDockerTime(text) ?? { reason: `the engine gave the time ${JSON.stringify(text.slice(0, 64))}` };
    },

    async remove(id, signal) {
      try {
        // A container that is gone is no failure (removeContainer).
        await limited(REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal, (limit) => engine.removeContainer(id, limit));
      } catch (error) {
        if (isAbortError(error) && signal?.aborted) throw error;
        // Review round 3 of PR #69 (A-R3-1): another window removes it right now.
        if (error instanceof EngineError && REMOVAL_IN_PROGRESS.test(error.message)) return;
        throw new Error(`docker rm failed: ${errorMessage(error)}`);
      }
    },

    async start(id, signal) {
      try {
        await limited(REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal, (limit) => engine.start(id, limit));
      } catch (error) {
        if (isAbortError(error) && signal?.aborted) throw error;
        throw new Error(`docker start failed: ${errorMessage(error)}`);
      }
    },

    async storedScript(name, signal) {
      try {
        // Plan step 11I (PR B): `sha256sum REMOTE_MONITOR_SCRIPT_PATH` as the script `monitorScriptHash` of the registry.
        const result = await runScript(engine, name, 'monitorScriptHash', [], { timeoutMs: REMOTE_MONITOR_EXEC_TIMEOUT_MS, ...(signal ? { signal } : {}) });
        if (result.timedOut) return 'unknown';
        if (result.exitCode === 0) return { hash: result.stdout };
        // Review round 3 of PR #69 (A-R3-5): the runtime's refusal of an exec in a container that just stopped comes on
        // the output of the exec; every alternative starts a line, so a hash never matches.
        return NO_STORED_SCRIPT.test(`${result.stderr}\n${result.stdout}`) ? 'none' : 'unknown';
      } catch (error) {
        if (isAbortError(error) && signal?.aborted) throw error;
        // The engine refused the exec: the container does not exist, does not run, or restarts. Cleanup after plan step 11
        // (PR C2, B5): the one rule (isNotRunning, with `restarting`, as NO_STORED_SCRIPT); before, any 404 counted.
        return isNotRunning(error, { restarting: true }) ? 'none' : 'unknown';
      }
    },

    async idsWithLabel(label, signal) {
      try {
        return await limited(REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal, (limit) => engine.containerIds({ label: [label] }, limit));
      } catch (error) {
        if (isAbortError(error) && signal?.aborted) throw error;
        return undefined;
      }
    },

    create: (spec, scriptLine, readyText, signal) =>
      engine.createAttached(spec, { input: scriptLine, readyText, timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, ...(signal ? { signal } : {}) }),
  };
}
