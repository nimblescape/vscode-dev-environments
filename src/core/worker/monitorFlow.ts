// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D1 (decision of 2026-10-03, "every remote action is a worker operation"): the commands of the Session
// Monitor container of the worker's engine (`monitor.js` in `devenv-session-monitor`), over the Engine API (`exec`): the
// heartbeat, its image settings and image list (on the input of the command), and Delete's `forget`. Before, the
// extension ran them as `docker exec` through the relay, and `docker exec -i` directly. Pure over the port; no `vscode`.
// Plan step 11I (U2, decision of 2026-10-08): each command is an entry of the registry of the container scripts
// (monitorHeartbeat, monitorForget, monitorSettings, monitorImages in containerScripts.ts), run by runScript; this module
// builds no command of its own.
import { errorMessage } from '../errors';
import { MAX_MONITOR_DETAIL_LENGTH, type HeartbeatValue } from '../helperChannel/protocol';
import { REMOTE_MONITOR_CONTAINER, isUnderRecordsLock, monitorExecFailure, type HeartbeatInput, type ImageSettings } from '../remoteMonitor/protocol';
import { runScript, scriptCommand, type ContainerScript } from './containerScripts';
import { isMissing, isNotRunning, type DockerEngine } from './dockerEngine';

/** The time limit of a command in the Session Monitor container (as REMOTE_MONITOR_EXEC_TIMEOUT_MS of the extension). */
export const MONITOR_EXEC_TIMEOUT_MS = 20_000;

/** Plan step 11I (U2, decision of 2026-10-08): the entries of the registry that run in the Session Monitor container. */
export type MonitorScript = Extract<ContainerScript, 'monitorHeartbeat' | 'monitorForget' | 'monitorSettings' | 'monitorImages'>;

/**
 * One command in the monitor container: ok, or the reason it failed; `missing` when the container does not exist or does
 * not run (isNotRunning, or the caller's own rule `missing`). Never throws, except an AbortError of `signal`. `container`:
 * the monitor container (REMOTE_MONITOR_CONTAINER; a test names its own, the operations never do). Plan step 11I (U2,
 * decision of 2026-10-08): the command is the entry `name` of the registry with its arguments, run by runScript; `input`
 * only for an entry that reads one (runScript refuses it for any other). A command under the lock of the records still
 * names the busy lock or the kill when it fails without a word of its own.
 */
export async function monitorCommand(
  engine: DockerEngine,
  name: MonitorScript,
  args: readonly string[],
  options: { input?: string; signal?: AbortSignal; container?: string; missing?: (error: unknown) => boolean } = {},
): Promise<HeartbeatValue> {
  try {
    const result = await runScript(engine, options.container ?? REMOTE_MONITOR_CONTAINER, name, args, {
      timeoutMs: MONITOR_EXEC_TIMEOUT_MS,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.exitCode === 0 && !result.timedOut) return { ok: true };
    const detail = result.timedOut
      ? `docker exec did not end within ${MONITOR_EXEC_TIMEOUT_MS / 1000} seconds.`
      : (result.stderr || result.stdout).trim() || monitorExecFailure(result.exitCode, '', isUnderRecordsLock(scriptCommand(name, args)));
    return { ok: false, missing: false, detail: clip(detail) };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Cleanup after plan step 11 (PR C2, B5): the one rule (isNotRunning) unless the caller gives its own (Delete's
    // forget); before, any 404 counted.
    const missing = (options.missing ?? isNotRunning)(error);
    return { ok: false, missing, detail: clip(errorMessage(error)) };
  }
}

/** One heartbeat of a window (the entry monitorHeartbeat, under the lock of the records). */
export function sendHeartbeat(engine: DockerEngine, input: HeartbeatInput, signal?: AbortSignal, container?: string): Promise<HeartbeatValue> {
  return monitorCommand(engine, 'monitorHeartbeat', [JSON.stringify(input)], { signal, ...(container !== undefined ? { container } : {}) });
}

/**
 * The image settings or the image list for the monitor (the entries monitorSettings and monitorImages: `monitor.js
 * settings -` or `images -`, JSON on the input). Plan step 11E6 (decision D1 of 2026-10-05): the open gives them after
 * its ensure (giveMonitorImages).
 */
export function sendMonitorSettings(engine: DockerEngine, params: { settings: ImageSettings } | { repositories: string[] }, signal?: AbortSignal, container?: string): Promise<HeartbeatValue> {
  const named = container !== undefined ? { container } : {};
  return 'settings' in params
    ? monitorCommand(engine, 'monitorSettings', [], { input: JSON.stringify(params.settings), signal, ...named })
    : monitorCommand(engine, 'monitorImages', [], { input: JSON.stringify({ repositories: params.repositories }), signal, ...named });
}

/**
 * Delete's `forget`: the heartbeat record of `source` for the environment (the entry monitorForget, under the lock of the
 * records). Cleanup after plan step 11 (PR C2, B5; review round 1, A-C2-5): `missing` keeps its rule from before, any 404
 * (also "No such exec instance": the monitor container went away between the create and the start of the exec) or a 409
 * "is not running", because Delete logs no record of a monitor that does not run (workerSessionMonitor); the one rule
 * would make that race a warning.
 */
export function forgetRecord(engine: DockerEngine, source: string, environmentId: string, container?: string): Promise<HeartbeatValue> {
  return monitorCommand(engine, 'monitorForget', [source, environmentId], { missing: forgetMissing, ...(container !== undefined ? { container } : {}) });
}

/** The rule of `missing` for Delete's forget (forgetRecord): any 404 of the engine, or the container does not run. */
function forgetMissing(error: unknown): boolean {
  return isMissing(error) || isNotRunning(error);
}

function clip(text: string): string {
  return text.length > MAX_MONITOR_DETAIL_LENGTH ? `${text.slice(0, MAX_MONITOR_DETAIL_LENGTH - 1)}…` : text;
}
