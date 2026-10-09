// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D2: the tests of the ensure of the Session Monitor (remoteSessionMonitor.test.ts) were written against the
// Docker CLI (its arguments and answers). The ensure now asks a MonitorEngine (the worker implements it over the Engine
// API, engineMonitor.ts); this testkit implements that port over the CLI-shaped fake of those tests, the way the extension
// read the CLI before, so their decisions, their calls and their order are checked as before. Only for tests.
import { readableStderr } from '../loader/pipeLoader';
import { errorMessage } from '../errors';
import { isAbortError, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import { NO_STORED_SCRIPT, REMOVAL_IN_PROGRESS, parseDockerTime, type MonitorCreated, type MonitorEngine, type MonitorInspected, type MonitorRunSpec } from './monitorEngine';
import { LABEL_SESSION_MONITOR, REMOTE_MONITOR_SCRIPT_PATH } from './protocol';
import { REMOTE_MONITOR_DOCKER_TIMEOUT_MS, REMOTE_MONITOR_EXEC_TIMEOUT_MS } from './remoteSessionMonitor';

/** The CLI-shaped Docker of the tests (`docker <args>`, and the attached `docker run -i`). */
export interface CliDocker {
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
  start(args: readonly string[]): StartedProcess | undefined;
}

/** The characters of the end of stderr of the attached `docker run` that are kept (for the conflict and the log). */
const STDERR_TAIL_LENGTH = 4_000;
/** How long a create that failed waits for its killed client to end (review round 4 of PR #69, A-R4-1). */
export const CLI_CLIENT_EXIT_WAIT_MS = 5_000;
/** The name conflict of the create (review round 4 of PR #69, A-R4-2), with the exit code 125 of the CLI. */
const NAME_CONFLICT = /^(?:docker: )?Error response from daemon: Conflict\. The container name\b.*\bis already in use\b/m;
const DOCKER_CLI_DAEMON_ERROR = 125;

/** A failed call because the container does not exist (or does not run, for `docker exec`). */
export function isMissingContainer(result: Pick<RunResult, 'stderr' | 'timedOut' | 'exitCode'>): boolean {
  return !result.timedOut && result.exitCode !== 0 && /no such (container|object)|is not running/i.test(result.stderr);
}

/** The arguments of `docker run` that the extension built for a MonitorRunSpec (its order). */
export function cliRunArgs(spec: MonitorRunSpec): string[] {
  const { [LABEL_SESSION_MONITOR]: label, ...others } = spec.labels;
  const args = ['run', '-i', '--sig-proxy=false', '--pull', 'never', '--name', spec.name, '--label', `${LABEL_SESSION_MONITOR}=${label}`];
  for (const [key, value] of Object.entries(others)) args.push('--label', `${key}=${value}`);
  args.push('--restart', spec.restartPolicy);
  if (spec.network === 'none') args.push('--network', 'none');
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  args.push('--log-driver', spec.log.driver, '--log-opt', `max-size=${spec.log.maxSize}`, '--log-opt', `max-file=${spec.log.maxFile}`);
  args.push('-v', `${spec.mounts.socket}:/var/run/docker.sock`, '-v', `${spec.mounts.volume}:${spec.mounts.volumeTarget}`);
  // Plan step 11H2: the shared VS Code server store, read-write with `nocopy` (engineClient: a mount with NoCopy).
  if (spec.mounts.store !== undefined) args.push('--mount', `type=volume,source=${spec.mounts.store.volume},target=${spec.mounts.store.target},volume-nocopy`);
  for (const [key, value] of Object.entries(spec.env)) args.push('-e', `${key}=${value}`);
  args.push(spec.image, ...spec.command);
  return args;
}

/** MonitorEngine over the CLI-shaped Docker of the tests (see the module comment). */
export function cliMonitorEngine(docker: CliDocker): MonitorEngine {
  return {
    async inspect(name, signal) {
      const args = [
        'container',
        'inspect',
        '--format',
        `{{json .State.Status}}\t{{json .State.ExitCode}}\t{{json .Config.Labels}}\t{{json .RestartCount}}\t{{json .Id}}\t{{json .Created}}`,
        name,
      ];
      const result = await docker.run(args, { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal });
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
      const found: MonitorInspected = {
        exists: true,
        status: typeof status === 'string' ? status : '',
        exitCode: typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : undefined,
        label: typeof value === 'string' ? value : '',
        restartCount: typeof restartCount === 'number' && Number.isInteger(restartCount) && restartCount > 0 ? restartCount : 0,
        id: typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) ? id : undefined,
        createdAt: parseDockerTime(parseJson(createdText)),
      };
      return found;
    },

    async daemonTime(signal) {
      let result: RunResult;
      try {
        result = await docker.run(['info', '--format', '{{json .SystemTime}}'], { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal });
      } catch (error) {
        if (isAbortError(error)) throw error;
        return { reason: errorMessage(error) };
      }
      const now = result.exitCode === 0 && !result.timedOut ? parseDockerTime(parseJson(result.stdout.trim())) : undefined;
      if (now === undefined) return { reason: result.timedOut ? 'no answer in time' : result.stderr.trim() || `exit code ${result.exitCode}` };
      return now;
    },

    async remove(id, signal) {
      await call(docker, ['rm', '-f', id], signal);
    },

    async start(id, signal) {
      await call(docker, ['start', id], signal);
    },

    async storedScript(name, signal) {
      let result: RunResult;
      try {
        result = await docker.run(['exec', name, 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH], { timeoutMs: REMOTE_MONITOR_EXEC_TIMEOUT_MS, signal });
      } catch (error) {
        if (isAbortError(error)) throw error;
        return 'unknown';
      }
      if (result.timedOut) return 'unknown';
      if (result.exitCode === 0) return { hash: result.stdout };
      return NO_STORED_SCRIPT.test(`${result.stderr}\n${result.stdout}`) ? 'none' : 'unknown';
    },

    async idsWithLabel(label, signal) {
      let listed: RunResult;
      try {
        listed = await docker.run(['ps', '-aq', '--no-trunc', '--filter', `label=${label}`], { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal });
      } catch (error) {
        if (isAbortError(error)) throw error;
        return undefined;
      }
      if (listed.exitCode !== 0 || listed.timedOut) return undefined;
      return listed.stdout.split(/\s+/).filter((line) => line !== '');
    },

    create: (spec, scriptLine, readyText, signal) => createAttached(docker, spec, scriptLine, readyText, signal),
  };
}

async function call(docker: CliDocker, args: readonly string[], signal: AbortSignal | undefined): Promise<void> {
  const result = await docker.run(args, { timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal });
  // Review round 3 of PR #69 (A-R3-1): an `rm` whose container is gone or is being removed by another window already.
  const tolerated = args[0] === 'rm' && (isMissingContainer(result) || (!result.timedOut && REMOVAL_IN_PROGRESS.test(result.stderr)));
  if (result.exitCode !== 0 && !tolerated) {
    throw new Error(`docker ${args[0]} failed: ${result.timedOut ? 'no answer in time' : result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }
}

/** The attached `docker run` of the monitor, as the extension ran it. */
async function createAttached(docker: CliDocker, spec: MonitorRunSpec, scriptLine: string, readyText: string, signal: AbortSignal | undefined): Promise<MonitorCreated> {
  const client = docker.start(cliRunArgs(spec));
  if (client === undefined) throw new Error('The Docker CLI cannot be started.');
  const created = await new Promise<MonitorCreated>((resolve) => {
    let output = '';
    let stderr = '';
    let settled = false;
    const settle = (value: MonitorCreated) => {
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
      output = (output + text).slice(-8_192);
      if (output.includes(readyText)) settle({ kind: 'ready' });
    });
    client.onStderr((text) => {
      stderr = (stderr + text).slice(-STDERR_TAIL_LENGTH);
    });
    void client.exited.then(({ exitCode, error }) => {
      const detail = error ? error.message : readableStderr(stderr, STDERR_TAIL_LENGTH) || `exit code ${exitCode}`;
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
  if (created.kind !== 'ready') await exitedWithin(client, CLI_CLIENT_EXIT_WAIT_MS);
  return created;
}

function exitedWithin(client: StartedProcess, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    void client.exited.then(done, done);
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
