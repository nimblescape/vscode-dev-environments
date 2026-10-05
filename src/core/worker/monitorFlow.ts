// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D1 (decision of 2026-10-03, "every remote action is a worker operation"): the commands of the Session
// Monitor container of the worker's engine (`monitor.js` in `devenv-session-monitor`), over the Engine API (`exec`): the
// heartbeat, its image settings and image list (on the input of the command), and Delete's `forget`. Before, the
// extension ran them as `docker exec` through the relay, and `docker exec -i` directly. Pure over the port; no `vscode`.
import { errorMessage } from '../errors';
import { MAX_MONITOR_DETAIL_LENGTH, type HeartbeatValue } from '../helperChannel/protocol';
import {
  REMOTE_MONITOR_CONTAINER,
  forgetCommand,
  heartbeatCommand,
  imageSettingsCommand,
  imagesCommand,
  isUnderRecordsLock,
  monitorExecFailure,
  type HeartbeatInput,
  type ImageSettings,
} from '../remoteMonitor/protocol';
import { EngineError, isMissing, type DockerEngine } from './dockerEngine';

/** The time limit of a command in the Session Monitor container (as REMOTE_MONITOR_EXEC_TIMEOUT_MS of the extension). */
export const MONITOR_EXEC_TIMEOUT_MS = 20_000;

/**
 * One command in the monitor container: ok, or the reason it failed; `missing` when the container does not exist or does
 * not run (a 404, or a 409 "is not running" of the engine). Never throws, except an AbortError of `signal`. `container`:
 * the monitor container (REMOTE_MONITOR_CONTAINER; a test names its own, the operations never do).
 */
export async function monitorCommand(
  engine: DockerEngine,
  command: readonly string[],
  options: { input?: string; signal?: AbortSignal; container?: string } = {},
): Promise<HeartbeatValue> {
  try {
    const result = await engine.exec(options.container ?? REMOTE_MONITOR_CONTAINER, command, {
      timeoutMs: MONITOR_EXEC_TIMEOUT_MS,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.exitCode === 0 && !result.timedOut) return { ok: true };
    const detail = result.timedOut
      ? `docker exec did not end within ${MONITOR_EXEC_TIMEOUT_MS / 1000} seconds.`
      : (result.stderr || result.stdout).trim() || monitorExecFailure(result.exitCode, '', isUnderRecordsLock(command));
    return { ok: false, missing: false, detail: clip(detail) };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const missing = isMissing(error) || (error instanceof EngineError && error.status === 409 && /is not running/i.test(error.message));
    return { ok: false, missing, detail: clip(errorMessage(error)) };
  }
}

/** One heartbeat of a window (heartbeatCommand, under the lock of the records). */
export function sendHeartbeat(engine: DockerEngine, input: HeartbeatInput, signal?: AbortSignal, container?: string): Promise<HeartbeatValue> {
  return monitorCommand(engine, heartbeatCommand(input), { signal, ...(container !== undefined ? { container } : {}) });
}

/**
 * The image settings or the image list for the monitor (`monitor.js settings -` or `images -`, JSON on the input). Plan
 * step 11E6 (decision D1 of 2026-10-05): the open gives them after its ensure (giveMonitorImages).
 */
export function sendMonitorSettings(engine: DockerEngine, params: { settings: ImageSettings } | { repositories: string[] }, signal?: AbortSignal, container?: string): Promise<HeartbeatValue> {
  const named = container !== undefined ? { container } : {};
  return 'settings' in params
    ? monitorCommand(engine, imageSettingsCommand(), { input: JSON.stringify(params.settings), signal, ...named })
    : monitorCommand(engine, imagesCommand(), { input: JSON.stringify({ repositories: params.repositories }), signal, ...named });
}

/** Delete's `forget`: the heartbeat record of `source` for the environment (forgetCommand, under the lock of the records). */
export function forgetRecord(engine: DockerEngine, source: string, environmentId: string, container?: string): Promise<HeartbeatValue> {
  return monitorCommand(engine, forgetCommand(source, environmentId), container !== undefined ? { container } : {});
}

function clip(text: string): string {
  return text.length > MAX_MONITOR_DETAIL_LENGTH ? `${text.slice(0, MAX_MONITOR_DETAIL_LENGTH - 1)}…` : text;
}
