// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup C4 (plan step 11J): the ensure runs on the production MonitorEngine of the worker (engineMonitor) over a fake
// of the worker's engine port (DockerEngine), as the worker runs it over the Engine API. Before, it ran on a testkit
// that read a CLI-shaped fake the way the extension read the Docker CLI before plan step 11D2 (cliMonitorEngine.testkit,
// removed). Changed fixtures throughout: the answers are those of the port (the inspect of the engine, an exec result or
// the engine's refusal of the exec, the list of IDs, the clock of the daemon, the outcome of the attached create)
// instead of CLI output; the calls are those of the port (`inspect <name>`, `rm <id>`, `start <id>`, `exec <container>
// <command>`, `ps <label>`, `info`, `run <name>` with the spec of the create) instead of CLI arguments. The decisions,
// the calls and their order are checked as before. The tests of the CLI reading itself went with the testkit (the PR
// lists them); the production create and readings have their own tests (engineClient.attached.test.ts,
// engineClient.ensureR1.test.ts, engineMonitor*.test.ts).
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BUNDLE_LINE_LENGTH, PIPE_LOADER, bundleHash, encodeBundle } from '../loader/pipeLoader';
import { abortError, type Logger } from '../ports';
import { EngineError, type DockerEngine, type EngineExecResult, type MonitorCreated, type MonitorRunSpec } from '../worker/dockerEngine';
import { unusedEngine } from '../worker/dockerEngine.testkit';
import { engineMonitor } from '../worker/engineMonitor';
import {
  LABEL_MONITOR_CREATE,
  LABEL_SESSION_MONITOR,
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_SCRIPT_PATH,
  imagePrefixesOf,
  remoteMonitorLabelValue,
} from './protocol';
import {
  REMOTE_MONITOR_CONFLICT_WAITS_MS,
  REMOTE_MONITOR_CREATED_WAITS_MS,
  REMOTE_MONITOR_DOCKER_TIMEOUT_MS,
  REMOTE_MONITOR_LOG,
  REMOTE_MONITOR_STALE_CREATED_MS,
  RemoteSessionMonitor,
} from './remoteSessionMonitor';
import { parseDockerTime, type MonitorEngine } from './monitorEngine';

const SCRIPT = 'console.log("monitor")';
const TAG = 'devenv-helper:0123456789ab';
const SOCKET = '/var/run/docker.sock';
const LABEL = remoteMonitorLabelValue(SCRIPT, TAG);

/** The result of an exec in the container (DockerEngine.exec). */
const result = (exitCode: number | null, stdout = '', stderr = '', timedOut = false): EngineExecResult => ({ exitCode, stdout, stderr, timedOut });
/** Review round 2 of PR #69 (A-R2-2): the ID of the inspected monitor container. */
const MONITOR_ID = 'feed'.padEnd(64, '1');
/**
 * The inspect of the monitor container by the engine (DockerEngine.inspect): its status, exit code, labels, restart count
 * (review round 1 of PR #69, A-R1-1), ID (review round 2 of PR #69, A-R2-2) and, when given, its creation time (PR #69
 * review round 4, A-R4-1; without it the creation time cannot be read). `state`: true is `running`, false is `exited`
 * (with `exitCode`), a string is that status.
 */
const inspected = (state: boolean | string, label: string | undefined, exitCode = 0, restartCount: unknown = 0, id: unknown = MONITOR_ID, created?: unknown) => {
  const status = state === true ? 'running' : state === false ? 'exited' : state;
  return {
    Id: id,
    State: { Status: status, ExitCode: exitCode },
    Config: { Labels: label === undefined ? {} : { [LABEL_SESSION_MONITOR]: label, other: 'x' } },
    RestartCount: restartCount,
    ...(created === undefined ? {} : { Created: created }),
  };
};
/** The engine has no container of the name (the port answers undefined). */
const MISSING = undefined;
/** Review round 1 of PR #69 (A-R1-2): the ID of the container of a create, as the list of its nonce gives it. */
const CREATED_ID = 'c0ffee'.padEnd(64, '0');
/** The answers for a create after a missing container, with the container of the create found by its nonce label. */
const missingThenCreated = (args: readonly string[]): unknown => (args[0] === 'inspect' ? MISSING : args[0] === 'ps' ? [CREATED_ID] : undefined);
/** A failed `sha256sum` without a stored script (coreutils). */
const NO_SCRIPT = result(1, '', `sha256sum: ${REMOTE_MONITOR_SCRIPT_PATH}: No such file or directory\n`);
/** The engine's refusal of the name of the create (status 409, its message as the engine client gives it). */
const CONFLICT = 'Conflict. The container name "/devenv-session-monitor" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.';
/** The removal of the container is already in progress (another window). */
const inProgress = () => Promise.reject(new EngineError(`removal of container ${MONITOR_ID} is already in progress`, 409));

/** A call of the engine port, as the fake records it (see the module comment); `signal` and `timeoutMs` as the port got them. */
interface EngineCall {
  args: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The spec and the input (the script line) of a create. */
  spec?: MonitorRunSpec;
  input?: string;
}

/** What the attached create of the engine (createAttached) reports for the container of a create. */
type OnCreate = (call: EngineCall, index: number) => MonitorCreated | Promise<MonitorCreated>;
/** The monitor container starts and prints its ready line. */
const STARTS: OnCreate = () => ({ kind: 'ready' });
/** The engine refuses the name: another container has it. */
const CONFLICTED: OnCreate = () => ({ kind: 'exited', detail: CONFLICT, conflict: true });
/** The container ends before its ready line with `detail` (its error output, or the engine client's text without one). */
const ENDS =
  (detail = 'the container ended before it reported its start'): OnCreate =>
  () => ({ kind: 'exited', detail, conflict: false });
/** No ready line: the time limit of the create ends it (`timeout`), a cancel of its signal (`aborted`), as the engine client does. */
const HANGS: OnCreate = (call) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), call.timeoutMs);
    call.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve({ kind: 'aborted' });
      },
      { once: true },
    );
  });

/**
 * The fake of the worker's engine port: `answer` answers each call but the create (undefined is the port's empty answer:
 * no container for an inspect, done for a removal or a start, no IDs for a list, an exec with exit code 0 and no output,
 * an empty time); a rejected promise is the failure of the call. `onCreate` is the outcome of each create.
 */
class FakeDocker {
  readonly calls: EngineCall[] = [];
  /** The script lines that reached the engine (one per create that went ahead). */
  readonly inputs: string[] = [];
  readonly engine: DockerEngine;

  constructor(
    answer: (args: readonly string[], index: number, call: EngineCall) => unknown,
    onCreate: OnCreate = STARTS,
  ) {
    const reply = async (call: EngineCall): Promise<unknown> => {
      this.calls.push(call);
      return answer(call.args, this.calls.length - 1, call);
    };
    let creates = 0;
    this.engine = {
      ...unusedEngine(),
      inspect: async (kind, name, signal) => {
        expect(kind).toBe('container');
        return reply({ args: ['inspect', name], signal });
      },
      removeContainer: async (id, signal) => {
        await reply({ args: ['rm', id], signal });
      },
      start: async (id, signal) => {
        await reply({ args: ['start', id], signal });
      },
      exec: async (container, command, options = {}) =>
        ((await reply({ args: ['exec', container, ...command], signal: options.signal, timeoutMs: options.timeoutMs })) as EngineExecResult | undefined) ?? result(0),
      containerIds: async (filters, signal) => ((await reply({ args: ['ps', ...(filters.label ?? [])], signal })) as string[] | undefined) ?? [],
      systemTime: async (signal) => ((await reply({ args: ['info'], signal })) as string | undefined) ?? '',
      createAttached: async (spec, options) => {
        const call: EngineCall = { args: ['run', spec.name], signal: options.signal, timeoutMs: options.timeoutMs, spec, input: options.input };
        this.calls.push(call);
        expect(options.readyText).toBe(REMOTE_MONITOR_READY_TEXT);
        // As the engine client: a cancel before anything was sent rejects, and nothing exists then.
        if (options.signal?.aborted) throw abortError();
        this.inputs.push(options.input);
        return onCreate(call, creates++);
      },
    };
  }

  commands(): string[] {
    return this.calls.map((call) => call.args[0]);
  }

  /** The spec of the create of the call at `index`. */
  spec(index: number): MonitorRunSpec {
    const spec = this.calls[index].spec;
    if (spec === undefined) throw new Error(`The call ${index} is no create.`);
    return spec;
  }
}

/** The nonce of a create (LABEL_MONITOR_CREATE) in its spec. */
const createIdOf = (spec: MonitorRunSpec | undefined): string | undefined => spec?.labels[LABEL_MONITOR_CREATE];
/** The list of the containers of the nonce of the create `spec`. */
const nonceList = (spec: MonitorRunSpec | undefined) => ['ps', `${LABEL_MONITOR_CREATE}=${createIdOf(spec)}`];

/**
 * Whether the signals of `calls` follow `controller` (engineMonitor links the signal of each call of the port to the
 * signal of ensure, within the time limit of the call): none aborted before its abort, each aborted after it.
 */
function expectSignalsFollow(calls: readonly EngineCall[], controller: AbortController): void {
  expect(calls.length).toBeGreaterThan(0);
  if (!controller.signal.aborted) {
    expect(calls.map((call) => call.signal?.aborted)).toEqual(calls.map(() => false));
    controller.abort();
  }
  expect(calls.map((call) => call.signal?.aborted)).toEqual(calls.map(() => true));
}

class Log implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
  output(): void {}
}

function monitor(docker: FakeDocker, logger = new Log(), script = SCRIPT): RemoteSessionMonitor {
  return new RemoteSessionMonitor({ engine: engineMonitor(docker.engine), logger, script: async () => script });
}

describe('RemoteSessionMonitor.ensure', () => {
  it('does nothing when the container of this version runs', async () => {
    const docker = new FakeDocker(() => inspected(true, LABEL));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect']);
    // Cleanup C4 (plan step 11J): changed expectation (before: the arguments of `docker container inspect --format …`
    // with the status, the exit code, the labels, the restart count, the ID and the creation time): the inspect of the
    // container by its name, whose answer engineMonitor reads for the same fields (monitorInspected).
    expect(docker.calls[0].args).toEqual(['inspect', 'devenv-session-monitor']);
  });

  it('starts the container of this version when it is stopped', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL) : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('started');
    // PR #69 review round 4, A-R4-4: changed expectation (before: ['start', 'devenv-session-monitor'] and nothing else):
    // started by its ID, then its stored script is checked (here an answer without a hash: kept).
    expect(docker.calls.map((call) => call.args)).toEqual([
      expect.anything(),
      ['start', MONITOR_ID],
      ['exec', 'devenv-session-monitor', 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH],
      // Known gap of plan step 8 (fixed): changed expectation (before: nothing after the check): the check that fails is
      // followed by an inspect by the same ID (exited with 0 again: no evidence, kept).
      ['inspect', 'devenv-session-monitor'],
    ]);
  });

  it('replaces a container of another version (another script or helper image)', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'aaaaaaaaaaaa') : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'rm', 'run']);
    // Review round 2 of PR #69 (A-R2-2): changed expectation (before: by the name 'devenv-session-monitor'): by the ID
    // that inspect read.
    expect(docker.calls[1].args).toEqual(['rm', MONITOR_ID]);
  });

  // PR #69 review round 4, A-R4-5: changed test (before: "… removes the container by its name", 'created' after
  // the removal by 'devenv-session-monitor'): never by the name; an ID that cannot be read fails, and nothing is removed.
  it('A-R2-2, A-R4-5: a replace whose inspect gave no readable ID fails and removes nothing', async () => {
    for (const id of [null, 42, 'not-an-id', 'A'.repeat(64), 'f'.repeat(63)]) {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'aaaaaaaaaaaa', 0, 0, id) : undefined));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET), String(id)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect']);
      expect(logger.lines.join('\n')).toContain('the ID of the Session Monitor container cannot be read; it is kept.');
    }
    // Without an ID in the answer too.
    const short = new FakeDocker((args) => (args[0] === 'inspect' ? { State: { Status: 'running', ExitCode: 0 }, Config: { Labels: { [LABEL_SESSION_MONITOR]: 'aaaaaaaaaaaa' } }, RestartCount: 0 } : undefined));
    expect(await monitor(short).ensure(TAG, SOCKET)).toBe('failed');
    expect(short.commands()).toEqual(['inspect']);
  });

  it('A-R2-2: when another window replaced the container meanwhile, the removal by the old ID misses and the create accepts the new one', async () => {
    const docker = new FakeDocker((args, index) => {
      // Cleanup C4 (plan step 11J): changed fixture (before: the `rm` answered "No such container"): the port's removal of
      // a container that is gone is no failure.
      if (args[0] === 'rm') return undefined;
      // PR #69 review round 4, A-R4-2: the conflict check finds no container with the nonce of this create.
      if (args[0] === 'ps') return [];
      return index === 0 ? inspected(true, LABEL, 0, 1) : args[0] === 'exec' ? NO_SCRIPT : inspected(true, LABEL, 0, 0, 'b'.repeat(64));
    }, CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    // PR #69 review round 4, A-R4-2: changed expectation (before: without 'ps'): the conflict is checked by the nonce.
    expect(docker.commands()).toEqual(['inspect', 'exec', 'rm', 'run', 'ps', 'inspect']);
    expect(docker.calls[2].args).toEqual(['rm', MONITOR_ID]);
    expect(docker.calls.some((call) => call.args[0] === 'rm' && call.args.includes('devenv-session-monitor'))).toBe(false);
  });

  it('runs the helper image of the open by its checked image ID, with the label and the log line of its tag (review round 1 of PR #64, S1)', async () => {
    const imageId = `sha256:${'7'.repeat(64)}`;
    const docker = new FakeDocker(() => MISSING);
    const logger = new Log();
    expect(await monitor(docker, logger).ensure(TAG, SOCKET, undefined, imageId)).toBe('created');
    const byId = docker.spec(1);
    const byTag = new FakeDocker(() => MISSING);
    await monitor(byTag).ensure(TAG, SOCKET);
    // The same spec as with the tag, the label included; only the image reference differs. Review round 1 of PR #69
    // (A-R1-2): changed expectation (before: the arguments compared as they are): the nonce of each create differs too.
    const tagged = byTag.spec(1);
    expect(byId).toEqual({ ...tagged, image: imageId, labels: { ...tagged.labels, [LABEL_MONITOR_CREATE]: createIdOf(byId) } });
    expect(createIdOf(byId)).not.toBe(createIdOf(tagged));
    expect(byId.labels[LABEL_SESSION_MONITOR]).toBe(LABEL);
    expect(JSON.stringify(byId)).not.toContain(TAG);
    expect(logger.lines).toContain(`info The Session Monitor on the Docker host was created (devenv-session-monitor, image ${TAG}).`);
  });

  it('replaces a container of the name without the label', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, undefined) : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'rm', 'run']);
  });

  it('creates a missing container: its own network-less, capability-less container with the socket and the volume', async () => {
    const docker = new FakeDocker(() => MISSING);
    expect(await monitor(docker).ensure(TAG, '/run/user/1000/docker.sock')).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'run']);
    const spec = docker.spec(1);
    const createId = createIdOf(spec);
    expect(createId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Cleanup C4 (plan step 11J): changed expectation (before: the arguments of `docker run` that the CLI testkit built,
    // with `-i --sig-proxy=false --pull never`, `--cap-drop ALL` and `--security-opt no-new-privileges`, which that
    // testkit wrote itself): the spec of the attached create of the engine, which sets the open input, the dropped
    // capabilities, no new privileges and never a pull itself (engineClient.attached.test.ts).
    expect(spec).toEqual({
      name: 'devenv-session-monitor',
      image: TAG,
      // Review round 1 of PR #69 (A-R1-2): the nonce of this create next to the label of the version.
      labels: { [LABEL_SESSION_MONITOR]: LABEL, [LABEL_MONITOR_CREATE]: createId },
      // Changed expectation, plan step 8 PR B (Q5): was `unless-stopped`. The monitor exits with 0 when it is idle and stays
      // exited; a failure (the loader's exit 3) is still restarted.
      restartPolicy: 'on-failure',
      // Plan step 11H2 (D1, decision of 2026-10-09): changed expectation, no network `none` any more: the monitor always
      // has the default network (outbound only; still no published port).
      network: 'default',
      // Monitor cleanup, user decision 2026-09-29 (R5): the log of the monitor is capped, with the driver named.
      log: { driver: 'json-file', maxSize: '1m', maxFile: '2' },
      mounts: { socket: '/run/user/1000/docker.sock', volume: 'devenv-session-monitor', volumeTarget: '/state' },
      env: {},
      // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: 'sh', '-c', REMOTE_MONITOR_BOOTSTRAP,
      // 'sh', SCRIPT): the pipe loader with the path, the hash and the entry; the script is not on the command line.
      command: ['node', '-e', PIPE_LOADER, REMOTE_MONITOR_SCRIPT_PATH, bundleHash(SCRIPT), 'startMonitor'],
    });
    // No published port, no environment variable of this computer, never DOCKER_HOST.
    expect(JSON.stringify(spec)).not.toContain('DOCKER_HOST');
    expect(JSON.stringify(spec)).not.toContain(SCRIPT);
    // The create gets the time limit of a Docker call.
    expect(docker.calls[1].timeoutMs).toBe(REMOTE_MONITOR_DOCKER_TIMEOUT_MS);
    // The script is the first and only input line.
    expect(docker.inputs).toEqual([encodeBundle(SCRIPT)]);
  });

  it('accepts the container that another window created at the same time', async () => {
    // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: `docker run -d` answered 125 with
    // the conflict; now the attached create reports it).
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : inspected(true, LABEL)), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect']): the conflict is checked
    // by the nonce of this create first (none: a true conflict).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
  });

  it('fails (logged, no throw) when the other window created another version', async () => {
    const logger = new Log();
    // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: `docker run -d` answered 125).
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : inspected(true, 'bbbbbbbbbbbb')), CONFLICTED);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    // Changed expectation, plan step 8 PR A: the warning no longer says that the local Session Monitor stops it while this
    // computer is online (the windows send the heartbeats; an open is refused without the monitor, Q3).
    expect(logger.lines.join('\n')).toMatch(/warn The Session Monitor on the Docker host could not be started: docker run failed: .*already in use/);
    // Plan step 3: the container of the other window is not removed. PR #69 review round 4, A-R4-2: changed expectation
    // (before: ['inspect', 'run', 'inspect']): the nonce is checked, and the failure cleans up by the nonce (nothing).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'ps']);
  });

  it('fails (logged) when Docker does not answer, and does not create anything', async () => {
    const logger = new Log();
    // Cleanup C4 (plan step 11J): changed fixture (before: every CLI call timed out): every call of the port fails.
    const docker = new FakeDocker(() => Promise.reject(new Error('connect ETIMEDOUT /var/run/docker.sock')));
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect']);
    expect(logger.lines.some((line) => line.startsWith('warn'))).toBe(true);
  });

  // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: a script longer than
  // MAX_SCRIPT_LENGTH, 30000 characters, was refused; now only one whose JSON line is beyond the memory guard of the
  // loader, MAX_BUNDLE_LINE_LENGTH, before anything is removed).
  it('refuses a script whose line is longer than the loader takes', async () => {
    const docker = new FakeDocker(() => MISSING);
    // Each line feed doubles in JSON: short enough as text, too long as its line.
    expect(await monitor(docker, new Log(), '\n'.repeat(MAX_BUNDLE_LINE_LENGTH / 2 + 1)).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.calls).toEqual([]);
  });

  // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: PR #57 refused a command line
  // too long for Windows, also for a short script of quotes; now the script is never on the command line).
  it('a 1 MB script is accepted and never in argv', async () => {
    const script = `/* ${'"quoted" \\ line\n'.repeat(80_000)} */`;
    expect(script.length).toBeGreaterThan(1024 * 1024);
    const docker = new FakeDocker(() => MISSING);
    const logger = new Log();
    expect(await monitor(docker, logger, script).ensure(TAG, SOCKET)).toBe('created');
    // Cleanup C4 (plan step 11J): the spec of the create (its command, labels and variables) in place of the arguments of
    // `docker run`.
    const spec = docker.spec(1);
    expect(JSON.stringify(spec).length).toBeLessThan(5_000);
    expect(JSON.stringify(spec)).not.toContain('quoted');
    expect(spec.command.slice(-2)).toEqual([bundleHash(script), 'startMonitor']);
    expect(docker.inputs).toEqual([encodeBundle(script)]);
    // Never in the log either.
    expect(logger.lines.some((line) => line.includes('quoted'))).toBe(false);
  });

  it('fails when the script cannot be read', async () => {
    const docker = new FakeDocker(() => MISSING);
    const failing = new RemoteSessionMonitor({ engine: engineMonitor(docker.engine), logger: new Log(), script: async () => Promise.reject(new Error('ENOENT')) });
    expect(await failing.ensure(TAG, SOCKET)).toBe('failed');
  });

  it('passes a cancellation on', async () => {
    // Cleanup C4 (plan step 11J): changed fixture (before: the call rejected with an AbortError alone): the cancel of the
    // signal of ensure, which engineMonitor passes on as such (an AbortError without it is a failure of the call).
    const controller = new AbortController();
    const docker = new FakeDocker(() => {
      controller.abort();
      return Promise.reject(abortError());
    });
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('gives the tests their own names, labels, and variables', () => {
    const custom = new RemoteSessionMonitor({
      engine: engineMonitor(new FakeDocker(() => undefined).engine),
      logger: new Log(),
      script: async () => SCRIPT,
      containerName: 'devenv-test-monitor',
      volumeName: 'devenv-test-monitor-state',
      labels: { 'devenv-test.run': 'abc' },
      containerEnv: { DEVENV_MONITOR_TICK_MS: '500' },
    });
    // Cleanup C4 (plan step 11J): the spec of the create in place of the arguments of `docker run`.
    const spec = custom.runSpec(TAG, SOCKET, LABEL, SCRIPT);
    expect(spec.name).toBe('devenv-test-monitor');
    expect(spec.mounts).toMatchObject({ volume: 'devenv-test-monitor-state', volumeTarget: '/state' });
    expect(spec.labels['devenv-test.run']).toBe('abc');
    expect(spec.env).toEqual({ DEVENV_MONITOR_TICK_MS: '500' });
  });
});

// Plan step 3 (pipe loading, user decisions 2026-09-29): the state of the container decides, and the create is the
// attached create that gets the script on its input and is let go after the ready line.
describe('RemoteSessionMonitor.ensure with the pipe loader', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins the ready text of the monitor', () => {
    expect(REMOTE_MONITOR_READY_TEXT).toBe('Session Monitor started');
  });

  for (const [state, exitCode, outcome, commands] of [
    ['running', 0, 'running', ['inspect']],
    ['paused', 0, 'running', ['inspect']],
    // Stopped by `docker stop`, a daemon restart without the policy, or an error of the script: the stored script resumes.
    // PR #69 review round 4, A-R4-4: changed expectation (before: ['inspect', 'start']): then the stored script is checked
    // (here an answer without a hash: no evidence, kept).
    // Known gap of plan step 8 (fixed): changed expectation (before: ['inspect', 'start', 'exec']): a check that fails
    // is followed by an inspect by the same ID (here exited again with an exit code other than 3 and the same
    // RestartCount: no evidence, kept).
    ['exited', 0, 'started', ['inspect', 'start', 'exec', 'inspect']],
    ['exited', 137, 'started', ['inspect', 'start', 'exec', 'inspect']],
    ['exited', 1, 'started', ['inspect', 'start', 'exec', 'inspect']],
    // The loader refused (exit 3), or the container never ran as it should: replaced.
    ['exited', 3, 'created', ['inspect', 'rm', 'run']],
    // PR #69 review round 4, A-R4-1: changed expectation (before: ['created', 0, 'created', ['inspect', 'rm', 'run']]):
    // a `created` one may be the create of another window; the tests of review round 4 (A-R4-1) cover it.
    ['restarting', 3, 'created', ['inspect', 'rm', 'run']],
    ['dead', 0, 'created', ['inspect', 'rm', 'run']],
  ] as const) {
    it(`the container of this version, ${state} with exit code ${exitCode} → ${outcome}`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(state, LABEL, exitCode) : undefined));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe(outcome);
      expect(docker.commands()).toEqual(commands);
      // PR #69 review round 4, A-R4-4: changed expectation (before: by the name 'devenv-session-monitor'): by the ID.
      if (outcome === 'started') expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
      // Review round 2 of PR #69 (A-R2-2): changed expectation (before: by the name 'devenv-session-monitor'): by the ID.
      if (outcome === 'created') expect(docker.calls[1].args).toEqual(['rm', MONITOR_ID]);
    });
  }

  it('fails without a ready line within the time limit: the container is removed', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const docker = new FakeDocker(missingThenCreated, HANGS);
    const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(REMOTE_MONITOR_DOCKER_TIMEOUT_MS);
    expect(await ensured).toBe('failed');
    // Review round 1 of PR #69 (A-R1-2): changed expectation (before: ['inspect', 'run', 'rm'] with the removal by the
    // name): the container of this create is found by its nonce and removed by its ID.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[1].timeoutMs).toBe(REMOTE_MONITOR_DOCKER_TIMEOUT_MS);
    expect(docker.calls[2].args).toEqual(nonceList(docker.spec(1)));
    expect(docker.calls[3].args).toEqual(['rm', CREATED_ID]);
    expect(logger.lines.join('\n')).toContain('did not report its start within 60 seconds');
  });

  it('fails when the loader exits with 3: its line is logged, the container removed, the script never', async () => {
    const logger = new Log();
    const docker = new FakeDocker(missingThenCreated, ENDS('devenv loader: the bundle does not match its hash'));
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    // Review round 1 of PR #69 (A-R1-2): changed expectation (before: ['inspect', 'run', 'rm'] by the name): by the nonce.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[3].args).toEqual(['rm', CREATED_ID]);
    expect(logger.lines.join('\n')).toContain('docker run failed: devenv loader: the bundle does not match its hash');
    expect(logger.lines.some((line) => line.includes(SCRIPT))).toBe(false);
  });

  it('fails when the container ends before the ready line without a word', async () => {
    const docker = new FakeDocker(missingThenCreated, ENDS());
    const logger = new Log();
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    // Review round 1 of PR #69 (A-R1-2): changed expectation (before: ['inspect', 'run', 'rm'] by the name): by the nonce.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[3].args).toEqual(['rm', CREATED_ID]);
    // Cleanup C4 (plan step 11J): changed expectation (before: "exit code 1", the end of the CLI client): the text of the
    // engine client for a container that ended without error output.
    expect(logger.lines.join('\n')).toContain('docker run failed: the container ended before it reported its start');
  });

  it('passes a cancellation during the create on, after it removed the container', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker(missingThenCreated, () => {
      controller.abort();
      return { kind: 'aborted' };
    });
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    // Review round 1 of PR #69 (A-R1-2): changed expectation (before: ['inspect', 'run', 'rm'] by the name): by the nonce.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[3].args).toEqual(['rm', CREATED_ID]);
    // The removal does not take the cancelled signal (Cleanup C4, plan step 11J: changed expectation, before no signal at
    // all; engineMonitor gives each call the signal of its own time limit).
    expect(docker.calls[2].signal?.aborted).toBe(false);
    expect(docker.calls[3].signal?.aborted).toBe(false);
  });

  // Cleanup C4 (plan step 11J): changed test (before: "fails without a Docker CLI to start", the CLI client that could
  // not be started): a create that fails before its container exists. The port allows that rejection when nothing was
  // sent; the production client rejects only on a cancelled signal and reports a failed connection as `exited` (review
  // round 1 of PR #140, L1), so this pins the port's contract, not a failure the client produces.
  it('fails when the create fails before its container exists', async () => {
    const docker = new FakeDocker(() => MISSING, () => Promise.reject(new EngineError('connect ENOENT /var/run/docker.sock', 0)));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run']);
  });

  // User decision 2026-09-29 (3): replaces src/remoteMonitor/bundle.test.ts, which checked that the script fit the command
  // line: the real script, built as esbuild.mjs does, and the most prefixes that the settings allow; no part of the
  // script is in the spec of the create (its command, labels and variables), which stays short.
  it('the command line holds no bundle (the real script, the most prefixes)', { timeout: 30_000 }, async () => {
    const built = await esbuild.build({
      entryPoints: [path.resolve(__dirname, '../../remoteMonitor/main.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      minify: true,
      write: false,
      logLevel: 'silent',
    });
    const script = built.outputFiles[0].text;
    expect(script).toContain(REMOTE_MONITOR_READY_TEXT);
    const most = imagePrefixesOf(Array.from({ length: 50 }, (_, index) => `ghcr.io/${String(index).padStart(2, '0')}${'a'.repeat(118)}*`));
    const spec = monitor(new FakeDocker(() => undefined), new Log(), script).runSpec(TAG, '/run/user/1000/docker.sock', LABEL, script, {
      prefixes: most,
      schedule: '7 6 * * *',
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    expect(spec.command).toEqual(['node', '-e', PIPE_LOADER, REMOTE_MONITOR_SCRIPT_PATH, bundleHash(script), 'startMonitor']);
    const text = JSON.stringify(spec);
    for (let at = 0; at + 64 <= script.length; at += 4096) {
      const piece = script.slice(at, at + 64);
      expect(text.includes(piece)).toBe(false);
    }
    expect(text.length).toBeLessThan(10_000);
  });
});

// Review round 1 of PR #69: a monitor whose first load was cut off (A-R1-1), the removal of a failed create by its
// nonce (A-R1-2), and the tests of reviewer B (B-R1-3, B-R1-4, B-R1-5).
describe('RemoteSessionMonitor.ensure (review round 1 of PR #69)', () => {
  const SHA256SUM = ['exec', 'devenv-session-monitor', 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH];
  const sha256sumOutput = (hash: string) => result(0, `${hash}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`);

  const NO_FILE_COREUTILS = result(1, '', `sha256sum: ${REMOTE_MONITOR_SCRIPT_PATH}: No such file or directory\n`);
  const NO_FILE_BUSYBOX = result(1, '', `sha256sum: can't open '${REMOTE_MONITOR_SCRIPT_PATH}': No such file or directory\n`);
  const TIMED_OUT = result(null, '', '', true);
  // Review round 2 of PR #69 (A-R2-2): only definite evidence of another or no stored script replaces the monitor.
  // Cleanup C4 (plan step 11J): changed fixtures (before: the stderr of the Docker CLI): the engine refuses the exec in a
  // container that does not run, restarts, or is gone (its status and message), and the daemon or the runtime writes to
  // the output of an exec that it started. Removed with the CLI forms of NO_STORED_SCRIPT: "a container that is gone
  // (the CLI)" (`Error: No such container: …`) and "a container that stopped (the OCI runtime, from the daemon)" (the
  // runtime's message after the CLI's prefix `Error response from daemon: `); the engine reports neither.
  const replacing = [
    ['no stored script (coreutils)', NO_FILE_COREUTILS],
    ['no stored script (BusyBox)', NO_FILE_BUSYBOX],
    ['another stored script', sha256sumOutput(bundleHash(`${SCRIPT}// changed`))],
    ['a container that is not running', new EngineError('container 4f1c2a9e is not running', 409)],
    ['a container that is restarting', new EngineError('Container 4f1c2a9e is restarting, wait until the container is running', 409)],
    ['a container that is gone', new EngineError('No such container: devenv-session-monitor', 404)],
    ['a container that is restarting (its full ID)', new EngineError(`Container ${MONITOR_ID} is restarting, wait until the container is running`, 409)],
    // Review round 3 of PR #69 (A-R3-5): the runtime refuses the exec in a container that stopped between two restarts.
    ['a container that stopped (the OCI runtime)', result(126, '', 'OCI runtime exec failed: exec failed: cannot exec in a stopped container: unknown\n')],
    ['a container that stopped (the older runc wording)', result(126, '', 'OCI runtime exec failed: exec failed: cannot exec a container that has stopped: unknown\n')],
    // Review round 3 of PR #69 (A-R3-5): after the stream was hijacked, the daemon writes the error to the stdout of the exec.
    ['a container that stopped (the OCI runtime, on stdout, exit 126)', result(126, 'OCI runtime exec failed: exec failed: cannot exec in a stopped container: unknown\r\n', '')],
    // Review round 3 of PR #69 (A-R3-4): changed expectation (before: here, replaced): a stored script that cannot be read
    // (BusyBox's `can't open … Permission denied`) is no evidence of another or no script; it is in `keeping` now.
  ] as const;
  // Review round 2 of PR #69 (A-R2-2): a check that fails is no evidence; the monitor is kept.
  const keeping = [
    ['no answer in time', TIMED_OUT],
    // A call that timed out is no evidence, whatever it printed before.
    ['no answer in time after a partial answer', result(null, '', 'No such file or directory\n', true)],
    ['a failed call', new Error('Docker Desktop is not installed.')],
    ['an SSH failure', result(255, '', 'error during connect: ssh: connect to host build-box port 22: Connection refused\n')],
    ['an empty answer', result(0, '')],
    ['a failed call that printed the hash', result(1, `${bundleHash(SCRIPT)}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`, 'error')],
    // Review round 3 of PR #69 (A-R3-4): changed expectation (before: in `replacing`): a stored script that cannot be read
    // is no evidence, for BusyBox as for coreutils.
    ['a stored script that cannot be read (BusyBox)', result(1, '', `sha256sum: can't open '${REMOTE_MONITOR_SCRIPT_PATH}': Permission denied\n`)],
    ['a stored script that cannot be read (coreutils)', result(1, '', `sha256sum: ${REMOTE_MONITOR_SCRIPT_PATH}: Permission denied\n`)],
    // Review round 3 of PR #69 (B-R3-1): "No such file or directory" of the transport is no evidence of the stored script.
    [
      'an SSH failure whose stderr names a missing identity file',
      result(
        255,
        '',
        'error during connect: Get "http://docker.example.com/v1.47/exec/1/json": command [ssh -- build-box docker system dial-stdio] has exited with exit status 255, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=Warning: Identity file /home/u/.ssh/id_devenv not accessible: No such file or directory.\n',
      ),
    ],
    ['a missing daemon socket', result(1, '', 'Error response from daemon: dial unix /var/run/docker.sock: connect: no such file or directory\n')],
    // Review round 3 of PR #69 (verifier notes): another failure of the OCI runtime is no evidence that the container stopped.
    [
      'another failure of the OCI runtime',
      result(126, '', 'OCI runtime exec failed: exec failed: unable to start container process: exec: "sha256sum": executable file not found in $PATH: unknown\n'),
    ],
  ] as const;
  const answering = (state: string, answer: EngineExecResult | Error) =>
    new FakeDocker((args) => {
      if (args[0] === 'inspect') return inspected(state, LABEL, 3, 1);
      if (args[0] === 'exec') return answer instanceof Error ? Promise.reject(answer) : answer;
      return undefined;
    });

  for (const [what, answer] of replacing) {
    it(`A-R1-1: running with RestartCount 1 and ${what} → replaced`, async () => {
      const logger = new Log();
      const docker = answering('running', answer);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
      expect(docker.commands()).toEqual(['inspect', 'exec', 'rm', 'run']);
      expect(docker.calls[1].args).toEqual(SHA256SUM);
      expect(docker.calls[1].timeoutMs).toBe(20_000);
      // Review round 2 of PR #69 (A-R2-2): changed expectation (before: by the name 'devenv-session-monitor'): by the ID.
      expect(docker.calls[2].args).toEqual(['rm', MONITOR_ID]);
      expect(logger.lines).toContain('info The Session Monitor on the Docker host was restarted without its script; it is replaced (devenv-session-monitor).');
    });
  }

  for (const [what, answer] of keeping) {
    // Review round 2 of PR #69 (A-R2-2): changed expectation (before: replaced, ['inspect', 'exec', 'rm', 'run']): a
    // check that fails keeps the monitor, logged at info level.
    it(`A-R2-2: running with RestartCount 1 and ${what} → kept, logged`, async () => {
      const logger = new Log();
      const docker = answering('running', answer);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('running');
      // Known gap of plan step 8 (fixed): changed expectation (before: ['inspect', 'exec']): a check that fails is
      // followed by an inspect by the same ID and, still running with the same RestartCount, by one more check.
      expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect', 'exec']);
      expect(docker.calls[1].args).toEqual(SHA256SUM);
      expect(logger.lines).toEqual([
        'info The Session Monitor on the Docker host was restarted and its stored script could not be checked; it is kept (devenv-session-monitor).',
      ]);
    });
  }

  for (const [what, answer] of [...replacing, ...keeping, ['the stored script of this version', sha256sumOutput(bundleHash(SCRIPT))] as const]) {
    // Review round 2 of PR #69 (A-R2-1): changed expectation (before: ['inspect', 'exec'] and replaced or kept as for
    // running): Docker refuses `docker exec` in a paused container, so a paused one is kept without a check.
    it(`A-R2-1: paused with RestartCount 1 (${what} if it were asked) → running, no exec`, async () => {
      const logger = new Log();
      const docker = answering('paused', answer);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect']);
      expect(logger.lines).toEqual([]);
    });
  }

  for (const state of ['running', 'paused'] as const) {
    it(`A-R1-1: ${state} with RestartCount 1 and the stored script of this version → running, nothing removed`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(state, LABEL, 0, 1) : args[0] === 'exec' ? sha256sumOutput(bundleHash(SCRIPT)) : undefined));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      // Review round 2 of PR #69 (A-R2-1): changed expectation for paused (before: ['inspect', 'exec'] as for running).
      expect(docker.commands()).toEqual(state === 'paused' ? ['inspect'] : ['inspect', 'exec']);
      if (state === 'running') expect(docker.calls[1].args).toEqual(SHA256SUM);
    });

    it(`A-R1-1: ${state} with RestartCount 0 → running without any other call`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(state, LABEL, 0, 0) : result(1)));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect']);
    });
  }

  it('A-R1-1: a larger RestartCount is checked too; one that cannot be read counts as 0', async () => {
    // Review round 2 of PR #69 (A-R2-2): changed expectation (before: the check answered result(1) without stderr, which
    // is no evidence now and keeps the monitor): it answers that no script is stored.
    const restarted = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, LABEL, 3, 17) : args[0] === 'exec' ? NO_FILE_COREUTILS : undefined));
    expect(await monitor(restarted).ensure(TAG, SOCKET)).toBe('created');
    expect(restarted.commands()).toEqual(['inspect', 'exec', 'rm', 'run']);
    const unreadable = new FakeDocker((args) => (args[0] === 'inspect' ? { State: { Status: 'running', ExitCode: 0 }, Config: { Labels: { [LABEL_SESSION_MONITOR]: LABEL } }, RestartCount: null } : result(1)));
    expect(await monitor(unreadable).ensure(TAG, SOCKET)).toBe('running');
    expect(unreadable.commands()).toEqual(['inspect']);
  });

  it('A-R1-1: a cancellation during the check of the stored script passes', async () => {
    // Cleanup C4 (plan step 11J): changed fixture, the cancel of the signal of ensure (see "passes a cancellation on").
    const controller = new AbortController();
    const docker = new FakeDocker((args) => {
      if (args[0] === 'inspect') return inspected(true, LABEL, 0, 1);
      controller.abort();
      return Promise.reject(abortError());
    });
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.commands()).toEqual(['inspect', 'exec']);
  });

  it('A-R1-2: a create whose container is gone ("No such container") removes only its own container, by its nonce', async () => {
    const docker = new FakeDocker(missingThenCreated, ENDS('No such container: 4f1c2a9e.'));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    const createId = createIdOf(docker.spec(1));
    expect(createId).toBeDefined();
    expect(docker.calls.map((call) => call.args)).toEqual([
      ['inspect', 'devenv-session-monitor'],
      ['run', 'devenv-session-monitor'],
      ['ps', `${LABEL_MONITOR_CREATE}=${createId}`],
      ['rm', CREATED_ID],
    ]);
    expect(docker.calls.some((call) => call.args[0] === 'rm' && call.args.includes('devenv-session-monitor'))).toBe(false);
  });

  it('A-R1-2: nothing is removed when no container has the nonce, or the list fails; each create has its own nonce', async () => {
    const none = new FakeDocker((args) => (args[0] === 'inspect' ? MISSING : []), ENDS());
    expect(await monitor(none).ensure(TAG, SOCKET)).toBe('failed');
    expect(none.commands()).toEqual(['inspect', 'run', 'ps']);
    const failing = new FakeDocker((args) => (args[0] === 'inspect' ? MISSING : args[0] === 'ps' ? Promise.reject(new EngineError('error', 500)) : undefined), ENDS());
    expect(await monitor(failing).ensure(TAG, SOCKET)).toBe('failed');
    expect(failing.commands()).toEqual(['inspect', 'run', 'ps']);
    // Review round 2 of PR #69 (note of reviewer B): changed test (before: two instances): one instance, ensure twice.
    const twice = new FakeDocker(() => MISSING);
    const once = monitor(twice);
    await once.ensure(TAG, SOCKET);
    await once.ensure(TAG, SOCKET);
    const runs = twice.calls.filter((call) => call.args[0] === 'run').map((call) => createIdOf(call.spec));
    expect(runs).toHaveLength(2);
    expect(runs[0]).not.toBe(runs[1]);
    // Not part of the label of the version.
    expect(remoteMonitorLabelValue(SCRIPT, TAG)).toBe(LABEL);
  });

  it('B-R1-3: a conflict with a container of this version that does not run is a failure', async () => {
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : inspected(false, LABEL, 3)), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // Not ours: not removed. PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect']):
    // the nonce is checked first, and the failure cleans up by the nonce only (nothing).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'ps']);
    expect(docker.calls.some((call) => call.args[0] === 'rm')).toBe(false);
  });

  it('B-R1-4: a signal aborted before the create is passed on without writing the script or waiting for the monitor', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args) => {
      if (args[0] === 'inspect') controller.abort();
      return missingThenCreated(args);
    });
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.inputs).toEqual([]);
    // Cleanup C4 (plan step 11J): changed expectation (before: ['inspect', 'run', 'ps', 'rm'], the cleanup after the CLI
    // client had started): the create gets the cancelled signal, and the engine client sends nothing then, so there is
    // nothing to remove.
    expect(docker.commands()).toEqual(['inspect', 'run']);
    expect(docker.calls[1].signal).toBe(controller.signal);
  });

  it('B-R1-5: a script whose line is exactly MAX_BUNDLE_LINE_LENGTH is accepted', async () => {
    const script = 'a'.repeat(MAX_BUNDLE_LINE_LENGTH - 2);
    expect(encodeBundle(script).length - 1).toBe(MAX_BUNDLE_LINE_LENGTH);
    const docker = new FakeDocker(() => MISSING);
    expect(await monitor(docker, new Log(), script).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.inputs[0]).toHaveLength(MAX_BUNDLE_LINE_LENGTH + 1);
  });
});

// Review round 2 of PR #69: the tests of reviewer B.
describe('RemoteSessionMonitor.ensure (review round 2 of PR #69, B-R2)', () => {
  // Without the signal, a cancellation during the check would be ignored until the time limit of the call (up to 20 s)
  // ends it: the cancellation of the open is delayed by up to 20 s.
  it('B-R2-2: the check of the stored script gets the signal of ensure, so a cancellation stops it', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args, _index, call) => {
      if (args[0] === 'inspect') return inspected(true, LABEL, 0, 1);
      return new Promise<EngineExecResult>((resolve, reject) => {
        call.signal?.addEventListener('abort', () => reject(abortError()));
        // Without the signal: the time limit of the call ends it.
        setTimeout(() => resolve(result(null, '', '', true)), 100);
      });
    });
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.commands()).toEqual(['inspect', 'exec']);
    expect(docker.calls[1].signal).toBe(controller.signal);
  });
});

// User requests 2026-09-28: the image maintenance of the monitor, only on a remote host. Cleanup C4 (plan step 11J): the
// spec of the create in place of the arguments of `docker run` that the removed CLI testkit built (cliRunArgs).
describe('RemoteSessionMonitor: images', () => {
  const PREFIXES = ['ghcr.io/majikmate/devcontainer-classroom', 'ghcr.io/majikmate/devcontainer-dev'];
  // User request 2026-09-28 ("in a guided cron style manner"): the daily time 06:07 became the cron schedule `7 6 * * *`.
  const IMAGES = { prefixes: PREFIXES, schedule: '7 6 * * *', timeZone: 'Europe/Vienna' };

  it('gives the container the prefixes and outbound network; without prefixes still no network', () => {
    const plain = monitor(new FakeDocker(() => undefined));
    // Plan step 11H2 (D1, decision of 2026-10-09): changed expectation, the default network also without prefixes (was
    // the network `none`).
    expect(plain.runSpec(TAG, SOCKET, LABEL, SCRIPT).network).toBe('default');
    const spec = plain.runSpec(TAG, SOCKET, LABEL, SCRIPT, IMAGES);
    expect(spec.network).toBe('default');
    expect(spec.env.DEVENV_IMAGE_PREFIXES).toBe(JSON.stringify(PREFIXES));
    // User request 2026-09-28: "1 minute after the monitor starts then in the morning again, at 6:07 CEST"; the daily time
    // became a cron schedule ("in a guided cron style manner").
    expect(spec.env.DEVENV_IMAGE_SCHEDULE).toBe('7 6 * * *');
    expect(spec.env.DEVENV_IMAGE_TZ).toBe('Europe/Vienna');
    // Plan step 11H2 (D1 and D2): changed expectation, without prefixes the default network too and the schedule of the
    // background run (was the network `none`), but no prefixes.
    const withoutPrefixes = plain.runSpec(TAG, SOCKET, LABEL, SCRIPT, { ...IMAGES, prefixes: [] });
    expect(withoutPrefixes.network).toBe('default');
    expect(withoutPrefixes.env).toEqual({ DEVENV_IMAGE_SCHEDULE: '7 6 * * *', DEVENV_IMAGE_TZ: 'Europe/Vienna' });
    // No published port: the spec has none to give (the create of the engine drops every capability and sets no new
    // privileges itself: engineClient.attached.test.ts).
    expect(Object.keys(spec).sort()).toEqual(['command', 'env', 'image', 'labels', 'log', 'mounts', 'name', 'network', 'restartPolicy']);
  });

  // Monitor cleanup, user decision 2026-09-29 (R5): the log of the monitor is capped with and without image maintenance,
  // with the json-file driver named (max-size alone fails where journald or syslog is the default driver).
  it('caps the Docker log of the container in every variant', () => {
    const plain = monitor(new FakeDocker(() => undefined));
    // Plan step 11D2: changed, the log of the container as the create of the engine takes it (before: the CLI options).
    expect(REMOTE_MONITOR_LOG).toEqual({ driver: 'json-file', maxSize: '1m', maxFile: '2' });
    for (const spec of [plain.runSpec(TAG, SOCKET, LABEL, SCRIPT), plain.runSpec(TAG, SOCKET, LABEL, SCRIPT, IMAGES)]) {
      expect(spec.log).toEqual({ driver: 'json-file', maxSize: '1m', maxFile: '2' });
    }
  });

  // Review round 1 of PR #57 (C; K): the prefixes, the time and the time zone were part of the label, so two computers
  // with other settings replaced the monitor of a shared engine at each open. Now only whether it maintains images is
  // (its network); the settings come with `settings -`.
  // Plan step 11H2 (D1, decision of 2026-10-09): changed expectation, the image maintenance is no part of the label any more
  // (the monitor always has its network), so turning it on or off keeps the running monitor too (was: replaced, with the
  // label part `image-maintenance`); its mode is (remoteSessionMonitor.11H2.test.ts).
  it('replaces the container when the image maintenance is turned on or off, not when its settings differ', async () => {
    const withImages = LABEL;
    expect(remoteMonitorLabelValue(SCRIPT, TAG, [])).toBe(LABEL);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, LABEL) : undefined));
    const withSetting = new RemoteSessionMonitor({ engine: engineMonitor(docker.engine), logger: new Log(), script: async () => SCRIPT, imageMaintenance: () => IMAGES });
    expect(await withSetting.ensure(TAG, SOCKET)).toBe('running');
    expect(docker.calls.some((call) => call.args[0] === 'rm' || call.args[0] === 'run')).toBe(false);
    // Another computer: other prefixes, another schedule, another time zone: the running monitor stays.
    for (const other of [
      { ...IMAGES, prefixes: ['ghcr.io/acme/base'] },
      { ...IMAGES, schedule: '0 5 * * 1-5' },
      { ...IMAGES, timeZone: 'America/New_York' },
    ]) {
      const running = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, withImages) : undefined));
      const otherComputer = new RemoteSessionMonitor({ engine: engineMonitor(running.engine), logger: new Log(), script: async () => SCRIPT, imageMaintenance: () => other });
      expect(await otherComputer.ensure(TAG, SOCKET)).toBe('running');
      expect(running.calls.some((call) => call.args[0] === 'rm' || call.args[0] === 'run')).toBe(false);
    }
    // Turned off: plan step 11H2 (D1), changed expectation, kept (was replaced: no network again).
    const off = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, withImages) : undefined));
    const offComputer = new RemoteSessionMonitor({ engine: engineMonitor(off.engine), logger: new Log(), script: async () => SCRIPT, imageMaintenance: () => ({ ...IMAGES, prefixes: [] }) });
    expect(await offComputer.ensure(TAG, SOCKET)).toBe('running');
  });

  // Review round 9 of PR #57: the prefixes on the command line were cut to what Windows takes; `settings -` brings all.
  // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: only as many prefixes as fit
  // next to a script of 28000 characters; now the command line holds no script, so all of them go, and its length does
  // not depend on the script).
  it('puts all prefixes on the command line, whatever the length of the script', () => {
    const many = Array.from({ length: 50 }, (_, index) => `ghcr.io/${String(index).padStart(2, '0')}${'a'.repeat(76)}`);
    const plain = monitor(new FakeDocker(() => undefined));
    const script = 'x'.repeat(28_000);
    const spec = plain.runSpec(TAG, SOCKET, LABEL, script, { ...IMAGES, prefixes: many });
    expect(spec.env.DEVENV_IMAGE_PREFIXES).toBe(JSON.stringify(many));
    expect(JSON.stringify(spec).includes(script)).toBe(false);
    const short = plain.runSpec(TAG, SOCKET, LABEL, SCRIPT, { ...IMAGES, prefixes: many });
    expect(JSON.stringify(short).length).toBe(JSON.stringify(spec).length);
  });
});

// Review round 3 of PR #69 (A-R3-1, A-R3-2): two windows that replace or create the monitor at the same time. The
// removal of the old monitor tolerates a removal in progress; a name conflict of the create waits a few seconds while the
// container of the name is `created` or `removing`, accepts only a matching running or paused one, creates once more when
// the name became free, and never removes anything but the container of its own nonce.
describe('RemoteSessionMonitor.ensure (review round 3 of PR #69, A-R3)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The first create meets the name conflict; the next one (if any) starts. */
  const conflictThenStarts: OnCreate = (call, index) => (index === 0 ? CONFLICTED(call, index) : STARTS(call, index));
  /** The answers of the inspects in their order; the last one repeats. */
  const inspects = (...answers: unknown[]) => {
    let at = 0;
    return () => answers[Math.min(at++, answers.length - 1)];
  };
  // PR #69 review round 4, A-R4-2: changed helper (before: the removals and the lists): the conflict is now checked by
  // the nonce of this create (`ps`, a read), so only the `rm` calls count as removals; noncePs checks that every `ps` is
  // the list of the nonce of a create of this ensure.
  const removals = (docker: FakeDocker) => docker.calls.filter((call) => call.args[0] === 'rm');
  const noncePs = (docker: FakeDocker) => {
    const nonces = docker.calls.filter((call) => call.args[0] === 'run').map((call) => createIdOf(call.spec));
    for (const call of docker.calls.filter((each) => each.args[0] === 'ps')) {
      expect(call.args).toHaveLength(2);
      expect(nonces.map((nonce) => `${LABEL_MONITOR_CREATE}=${nonce}`)).toContain(call.args[1]);
    }
  };

  it('A-R3-1: an rm that finds the removal already in progress goes on; the create waits for the name and creates once more', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const next = inspects(inspected(true, 'old-label'), inspected('removing', 'old-label'), MISSING);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'rm' ? inProgress() : undefined), conflictThenStarts);
    const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ensured).toBe('created');
    // PR #69 review round 4, A-R4-2: changed expectation (before: without 'ps'): the nonce check after the conflict.
    expect(docker.commands()).toEqual(['inspect', 'rm', 'run', 'ps', 'inspect', 'inspect', 'run']);
    noncePs(docker);
    // Only the old monitor by its ID, once; nothing in the conflict loop.
    expect(removals(docker).map((call) => call.args)).toEqual([['rm', MONITOR_ID]]);
    const runs = docker.calls.filter((call) => call.args[0] === 'run');
    expect(createIdOf(runs[1].spec)).toBe(createIdOf(runs[0].spec));
    expect(docker.inputs[1]).toBe(encodeBundle(SCRIPT));
    expect(logger.lines.some((line) => line.startsWith('warn'))).toBe(false);
  });

  it('A-R3-1: an rm that fails otherwise still fails, without a create', async () => {
    for (const answer of [
      () => Promise.reject(new EngineError('permission denied', 403)),
      // Cleanup C4 (plan step 11J): changed fixture (before: a call past its time limit whose stderr named the removal in
      // progress): a failure that is no refusal of the engine is no removal in progress, whatever its text.
      () => Promise.reject(new Error(`removal of container ${MONITOR_ID} is already in progress`)),
    ]) {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'old-label') : args[0] === 'rm' ? answer() : undefined));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect', 'rm']);
    }
  });

  it('A-R3-2: a conflict with a matching container that another window is still creating waits until it runs', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, inspected('created', LABEL), inspected('created', LABEL), inspected(true, LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ensured).toBe('running');
    // PR #69 review round 4, A-R4-2: changed expectation (before: without 'ps'): the nonce check after the conflict.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'inspect', 'inspect']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R3-2: a paused matching container after a removal is accepted too', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, inspected('removing', 'old-label'), inspected('paused', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ensured).toBe('running');
    expect(removals(docker)).toEqual([]);
  });

  it('A-R3-2: a container that is still created after a few seconds is a failure, never accepted and never removed', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const next = inspects(MISSING, inspected('created', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    let settled = false;
    const ensured = monitor(docker, logger)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    // The waits for a `removing` one: a few seconds in all.
    const conflictTotal = REMOTE_MONITOR_CONFLICT_WAITS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(conflictTotal).toBeGreaterThanOrEqual(2_000);
    expect(conflictTotal).toBeLessThanOrEqual(5_000);
    // PR #69 review round 5, A-R5-1: changed expectation (before: REMOTE_MONITOR_CONFLICT_WAITS_MS, 3.75 s): a `created`
    // one gets the waits of the first look (REMOTE_MONITOR_CREATED_WAITS_MS, 12.75 s).
    const total = REMOTE_MONITOR_CREATED_WAITS_MS.reduce((sum, ms) => sum + ms, 0);
    await vi.advanceTimersByTimeAsync(total - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    // PR #69 review round 4, A-R4-2: changed expectation (before: without the two 'ps'): the nonce check after the
    // conflict, and the cleanup by the nonce before the failure (it finds nothing: the conflict made no container).
    // PR #69 review round 5, A-R5-1: changed expectation (before: a look after each of REMOTE_MONITOR_CONFLICT_WAITS_MS).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', ...REMOTE_MONITOR_CREATED_WAITS_MS.map(() => 'inspect'), 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
    noncePs(docker);
    expect(logger.lines.join('\n')).toMatch(/warn The Session Monitor on the Docker host could not be started: docker run failed: .*already in use/);
  });

  it('A-R3-2: a running container of another label after a removal is a failure, not removed', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, inspected('removing', LABEL), inspected(true, 'other-label'));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ensured).toBe('failed');
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect', 'inspect']).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R3-2: another status (restarting) fails at once, without a wait', async () => {
    const next = inspects(MISSING, inspected('restarting', LABEL, 3));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect']).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R3-1: when the name is free after a conflict, the create is tried once more only', async () => {
    const docker = new FakeDocker(() => MISSING, CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect', 'run', 'inspect']): the
    // nonce check after each conflict, and the cleanup by the nonce before the failure.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'run', 'ps', 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
    noncePs(docker);
  });

  it('A-R3-1: a create once more that fails otherwise removes only the container of its own nonce', async () => {
    // PR #69 review round 4, A-R4-2: changed fixture (before: every list named CREATED_ID): the nonce check after the
    // conflict finds no container (the conflict made none); only the cleanup after the second create finds it.
    let lists = 0;
    const docker = new FakeDocker(
      (args) => (args[0] === 'inspect' ? MISSING : args[0] === 'ps' ? (lists++ === 0 ? [] : [CREATED_ID]) : undefined),
      (call, index) => (index === 0 ? CONFLICTED(call, index) : ENDS()(call, index)),
    );
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect', 'run', 'ps', 'rm'], the
    // calls at 4 and 5): the nonce check after the conflict.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[5].args).toEqual(nonceList(docker.spec(4)));
    expect(docker.calls[6].args).toEqual(['rm', CREATED_ID]);
  });

  it('A-R3-2: a cancellation during a wait of the conflict passes at once, and nothing is removed', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const next = inspects(MISSING, inspected('created', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect'], the inspect at 2): the
    // nonce check after the conflict, which gets the signal too.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
    // The list and the inspect of the conflict get the signal (Cleanup C4, plan step 11J: changed expectation, before the
    // signal itself; engineMonitor links it to the time limit of each call).
    expect([docker.calls[2], docker.calls[3]].map((call) => call.signal?.aborted)).toEqual([false, false]);
    controller.abort();
    await rejected;
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
    expect(removals(docker)).toEqual([]);
    expect([docker.calls[2], docker.calls[3]].map((call) => call.signal?.aborted)).toEqual([true, true]);
  });
});

// Review round 3 of PR #69: the tests of reviewer B (mutation testing).
describe('RemoteSessionMonitor.ensure (review round 3 of PR #69, B-R3)', () => {
  const SHA = ['exec', 'devenv-session-monitor', 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH];
  const restartedWith = (answer: EngineExecResult) => new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, LABEL, 0, 1) : args[0] === 'exec' ? answer : undefined));

  // B-R3-1: NO_STORED_SCRIPT is searched in the whole stderr, so a transport failure whose stderr has an unrelated
  // "No such file or directory" (an SSH warning, a missing socket) replaces a running monitor on no evidence.
  for (const [what, stderr] of [
    ['an SSH warning about an identity file, then a reset connection', 'Warning: Identity file /home/u/.ssh/id_devenv not accessible: No such file or directory.\nerror during connect: Get "http://docker.example.com/v1.47/containers/devenv-session-monitor/json": read: connection reset by peer\n'],
    ['a missing known_hosts file, then a failed connection', 'hostfile_replace_entries: link /home/u/.ssh/known_hosts to /home/u/.ssh/known_hosts.old: No such file or directory\nssh: connect to host build-box port 22: Connection timed out\n'],
  ] as const) {
    it(`B-R3-1: a failed check with ${what} keeps the monitor`, async () => {
      const docker = restartedWith(result(255, '', stderr));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      // Known gap of plan step 8 (fixed): changed expectation (before: ['inspect', 'exec']): a check that fails is
      // followed by an inspect by the same ID and, still running with the same RestartCount, by one more check.
      expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect', 'exec']);
    });
  }

  // B-R3-2: an answer of exit 0 that is no hash of 64 lower-case hex digits is no evidence (hash-i, hash-noStart,
  // hash-noEnd, hash-plus survived).
  for (const [what, stdout] of [
    ['the hash in upper case', `${bundleHash(SCRIPT).toUpperCase()}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`],
    ['a hash with a prefix', `\\${bundleHash(`${SCRIPT}x`)}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`],
    ['65 hex digits', `${bundleHash(`${SCRIPT}x`)}0  ${REMOTE_MONITOR_SCRIPT_PATH}\n`],
    ['63 hex digits', `${bundleHash(`${SCRIPT}x`).slice(1)}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`],
  ] as const) {
    it(`B-R3-2: an answer with ${what} keeps the monitor`, async () => {
      const docker = restartedWith(result(0, stdout));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      // Known gap of plan step 8 (fixed): changed expectation (before: ['inspect', 'exec']): a check that fails is
      // followed by an inspect by the same ID and, still running with the same RestartCount, by one more check.
      expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect', 'exec']);
      expect(docker.calls[1].args).toEqual(SHA);
    });
  }

  // B-R3-3: the removal of the old monitor gets the signal of ensure (M-rmNoSignal survived): a cancellation of the open
  // must not wait up to 60 s for it.
  it('B-R3-3: the removal of the old monitor gets the signal of ensure', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'old-label') : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET, controller.signal)).toBe('created');
    expect(docker.calls[1].args).toEqual(['rm', MONITOR_ID]);
    // Cleanup C4 (plan step 11J): changed expectation (before: the signal itself): linked to it by engineMonitor.
    expectSignalsFollow([docker.calls[1]], controller);
  });

  // B-R3-4: the cleanup of a failed create removes only what the list of its nonce gave as a full ID (M-rbe-filterOff
  // survived): never a name or another word of the answer.
  it('B-R3-4: the cleanup of a failed create removes only full IDs of its list', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? MISSING : args[0] === 'ps' ? ['devenv-session-monitor', CREATED_ID.slice(0, 12), CREATED_ID] : undefined), ENDS());
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.calls.filter((call) => call.args[0] === 'rm').map((call) => call.args)).toEqual([['rm', CREATED_ID]]);
  });

  // B-R3-5: an ID that is not exactly 64 lower-case hex digits is not used (id-noStart, id-noEnd survived).
  for (const id of [`x${MONITOR_ID}`, `${MONITOR_ID}0`]) {
    it(`B-R3-5: an inspected ID ${id.startsWith('x') ? 'with a prefix' : 'with a suffix'} is not used for the removal`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'old-label', 0, 0, id) : undefined));
      // PR #69 review round 4, A-R4-5: changed expectation (before: 'created' after the removal by the name): never removed
      // by its name; the ensure fails and removes nothing.
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect']);
    });
  }
});

// Review round 4 of PR #69, reviewer A: a `created` container is removed only when it is certainly abandoned (A-R4-1),
// the name conflict is only the engine's refusal of the name and no container of our nonce (A-R4-2), a restarted
// container after a conflict is accepted only with its stored script (A-R4-3), a started exited container is checked for
// its stored script (A-R4-4), and nothing is ever removed or started by the name (A-R4-5).
describe('RemoteSessionMonitor.ensure (review round 4 of PR #69, A-R4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SHA = ['exec', 'devenv-session-monitor', 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH];
  const SAME = result(0, `${bundleHash(SCRIPT)}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`);
  const TIMED_OUT = result(null, '', '', true);
  const OTHER_ID = 'beef'.padEnd(64, '2');
  /** `.Created` of the inspected container, as Docker gives it (nanoseconds), and the same in ms. */
  const CREATED_AT = '2026-09-30T10:00:00.123456789Z';
  const CREATED_MS = Date.UTC(2026, 8, 30, 10, 0, 0, 123);
  const createdIn = (label: string | undefined, id: unknown = MONITOR_ID) => inspected('created', label, 0, 0, id, CREATED_AT);
  /** The clock of the daemon (DockerEngine.systemTime) at `ageMs` after the create, with an offset as the daemon may give it. */
  const systemTime = (ageMs: number) => {
    const at = new Date(CREATED_MS + ageMs + 2 * 3_600_000);
    return `${at.toISOString().slice(0, 23)}456789+02:00`;
  };
  const inspects = (...answers: unknown[]) => {
    let at = 0;
    return () => answers[Math.min(at++, answers.length - 1)];
  };
  const removals = (docker: FakeDocker) => docker.calls.filter((call) => call.args[0] === 'rm');
  const CREATED_WAIT_TOTAL = REMOTE_MONITOR_CREATED_WAITS_MS.reduce((sum, ms) => sum + ms, 0);
  const allCreatedLooks = ['inspect', ...REMOTE_MONITOR_CREATED_WAITS_MS.map(() => 'inspect')];

  it('A-R4-1: the created-wait is bounded to 10-15 s and the stale age is the Docker time limit plus 30 s', () => {
    expect(CREATED_WAIT_TOTAL).toBeGreaterThanOrEqual(10_000);
    expect(CREATED_WAIT_TOTAL).toBeLessThanOrEqual(15_000);
    expect(REMOTE_MONITOR_STALE_CREATED_MS).toBe(REMOTE_MONITOR_DOCKER_TIMEOUT_MS + 30_000);
  });

  // PR #69 review round 5, B-R5-6: a failed create that never ends fails, with its cleanup, within the Docker time limit
  // plus 10 s of fake time. Cleanup C4 (plan step 11J): changed fixture (before: a CLI client that did not end when it
  // was killed): a create without an answer, which the time limit of the create ends.
  it('B-R5-6: a failed create that never ends fails within the Docker time limit plus 10 s', async () => {
    vi.useFakeTimers();
    const docker = new FakeDocker(missingThenCreated, HANGS);
    let outcome: string | undefined;
    void monitor(docker)
      .ensure(TAG, SOCKET)
      .then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(REMOTE_MONITOR_DOCKER_TIMEOUT_MS + 10_000);
    expect(outcome).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
  });

  it('A-R4-1: a matching created container that another window starts meanwhile is accepted, never removed', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), createdIn(LABEL), inspected(true, LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'inspect']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R4-1: a matching created container that goes on to paused is accepted too', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), inspected('paused', LABEL, 0, 3));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('running');
    expect(removals(docker)).toEqual([]);
  });

  it('A-R4-1: a created container that is gone meanwhile (the other window gave up) is created, nothing removed', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), MISSING);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'run']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R4-1: a created container that exits with 3 meanwhile goes through the table (replaced by its ID)', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), inspected(false, LABEL, 3));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'rm', 'run']);
    expect(docker.calls[2].args).toEqual(['rm', MONITOR_ID]);
  });

  it('A-R4-1: another ID at the name during the wait ends the wait; that container goes through the table', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), inspected(true, LABEL, 0, 0, OTHER_ID));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'inspect']);
  });

  // PR #69 review round 5, A-R5-2: changed test (before: another ID found `created` ended the wait at once and was judged
  // by its age: ['inspect', 'inspect', 'info'], failed): the waits start once more for the new ID. It starts → running;
  // still `created` after the second wait → judged by its own age: young, so kept (failed), nothing removed.
  it('A-R4-1, A-R5-2: a created container of another ID gets the wait once more; it starts → running, nothing removed', async () => {
    vi.useFakeTimers();
    // The old ID was abandoned long ago, but another window just created a new one (its own Created, 1 s before now).
    const now = REMOTE_MONITOR_STALE_CREATED_MS * 10;
    const young = inspected('created', LABEL, 0, 0, OTHER_ID, new Date(CREATED_MS + now - 1_000).toISOString());
    const next = inspects(createdIn(LABEL), young, young, inspected(true, LABEL, 0, 0, OTHER_ID));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(now) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'inspect', 'inspect']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R4-1, A-R5-2: a created container of another ID still created after the second wait is judged by its own age: young, so kept', async () => {
    vi.useFakeTimers();
    const now = REMOTE_MONITOR_STALE_CREATED_MS * 10;
    const young = inspected('created', LABEL, 0, 0, OTHER_ID, new Date(CREATED_MS + now - 1_000).toISOString());
    const next = inspects(createdIn(LABEL), young);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(now) : undefined));
    let settled = false;
    const ensured = monitor(docker)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    // The first look at the new ID uses the first wait (250 ms) of the first list; then its own full list.
    const first = REMOTE_MONITOR_CREATED_WAITS_MS[0];
    await vi.advanceTimersByTimeAsync(first + CREATED_WAIT_TOTAL - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'inspect', ...REMOTE_MONITOR_CREATED_WAITS_MS.map(() => 'inspect'), 'info']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R4-1: a matching container that stays created but is young fails after the bounded wait, nothing removed', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(10_000) : undefined));
    let settled = false;
    const ensured = monitor(docker, logger)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    expect(docker.commands()).toEqual([...allCreatedLooks, 'info']);
    // Cleanup C4 (plan step 11J): changed expectation (before: the arguments of `docker info --format …`): the clock of
    // the daemon from the port.
    expect(docker.calls.at(-1)?.args).toEqual(['info']);
    expect(removals(docker)).toEqual([]);
    expect(logger.lines.join('\n')).toMatch(/warn .*created 10 seconds ago and has not started yet .*it is kept\./);
  });

  it('A-R4-1: a matching container that stays created and is older than the stale age is removed by its ID, then created', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS + 1) : undefined));
    const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('created');
    expect(docker.commands()).toEqual([...allCreatedLooks, 'info', 'rm', 'run']);
    expect(removals(docker).map((call) => call.args)).toEqual([['rm', MONITOR_ID]]);
    expect(logger.lines).toContain('info The Session Monitor on the Docker host was created 90 seconds ago and never started; it is replaced (devenv-session-monitor).');
  });

  it('A-R4-1: exactly at the stale age it is kept', async () => {
    vi.useFakeTimers();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('failed');
    expect(removals(docker)).toEqual([]);
  });

  // Cleanup C4 (plan step 11J): changed fixtures (before: the answers of `docker info`): the clock of the port, or its
  // failure.
  for (const [what, info] of [
    ['a failed docker info', () => Promise.reject(new EngineError('Cannot connect to the Docker daemon', 500))],
    ['docker info without an answer in time', () => Promise.reject(new Error('no answer in time'))],
    ['docker info that throws', () => Promise.reject(new Error('Docker Desktop is not installed.'))],
    ['a time of the daemon that is not a time', () => 'yesterday'],
    ['an empty answer of docker info', () => ''],
    ['a time of the daemon without a zone', () => '2026-09-30T10:05:00'],
  ] as const) {
    it(`A-R4-1: ${what} keeps an old created container (failed, nothing removed)`, async () => {
      vi.useFakeTimers();
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? info() : undefined));
      const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
      await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
      expect(await ensured).toBe('failed');
      expect(docker.commands()).toEqual([...allCreatedLooks, 'info']);
      expect(removals(docker)).toEqual([]);
      expect(logger.lines.some((line) => line.startsWith('info The time of the Docker host cannot be read'))).toBe(true);
      expect(logger.lines.join('\n')).toContain('its age cannot be read; it is kept.');
    });
  }

  // PR #69 review round 5, B-R5-2: a creation time after the daemon's clock (the clock was set back) is a negative age,
  // never a large one (Math.abs survived): the young container of a live create is kept.
  it('B-R5-2: a created container whose creation time is after the clock of the daemon is kept', async () => {
    vi.useFakeTimers();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(-(REMOTE_MONITOR_STALE_CREATED_MS + 60_000)) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('failed');
    expect(docker.commands()).toEqual([...allCreatedLooks, 'info']);
    expect(removals(docker)).toEqual([]);
  });

  // PR #69 review round 5, B-R5-3: a cancellation during `docker info` of the age check passes as an AbortError (the
  // rethrow survived); nothing is removed and nothing runs after it.
  it('B-R5-3: a cancellation during docker info of the age check passes; nothing removed, nothing after it', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const docker = new FakeDocker((args) => {
      if (args[0] === 'inspect') return createdIn(LABEL);
      if (args[0] === 'info') {
        controller.abort();
        return Promise.reject(abortError());
      }
      return undefined;
    });
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    await rejected;
    expect(docker.commands()).toEqual([...allCreatedLooks, 'info']);
    expect(removals(docker)).toEqual([]);
  });

  for (const [what, created] of [
    ['no creation time', undefined],
    ['Docker\'s zero time', '0001-01-01T00:00:00Z'],
    ['a creation time that is not one', 'soon'],
    ['a creation time that is a number', 1_727_690_400],
  ] as const) {
    it(`A-R4-1: a created container with ${what} is kept without asking the daemon's clock`, async () => {
      vi.useFakeTimers();
      const docker = new FakeDocker((args) =>
        args[0] === 'inspect' ? inspected('created', LABEL, 0, 0, MONITOR_ID, created) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS * 100) : undefined,
      );
      const ensured = monitor(docker).ensure(TAG, SOCKET);
      await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
      expect(await ensured).toBe('failed');
      expect(docker.commands()).toEqual(allCreatedLooks);
      expect(removals(docker)).toEqual([]);
    });
  }

  it('A-R4-1: a created container of another label is not removed at once either: young → kept, old → removed by its ID', async () => {
    vi.useFakeTimers();
    for (const [age, outcome] of [
      [5_000, 'failed'],
      [REMOTE_MONITOR_STALE_CREATED_MS + 60_000, 'created'],
    ] as const) {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn('old-label') : args[0] === 'info' ? systemTime(age) : undefined));
      const ensured = monitor(docker).ensure(TAG, SOCKET);
      await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
      expect(await ensured).toBe(outcome);
      expect(removals(docker).map((call) => call.args)).toEqual(outcome === 'created' ? [['rm', MONITOR_ID]] : []);
    }
  });

  it('A-R4-1: an old created container whose ID cannot be read is kept (never removed by its name)', async () => {
    vi.useFakeTimers();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL, null) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS * 2) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('failed');
    expect(removals(docker)).toEqual([]);
    expect(docker.commands()).not.toContain('run');
  });

  // Cleanup C4 (plan step 11J): changed expectation (before: each call got the signal itself, and `docker info` the time
  // limit REMOTE_MONITOR_DOCKER_TIMEOUT_MS of the CLI testkit): engineMonitor links the signal of each call to that of
  // ensure, within the time limit of a Docker call (engineMonitor.ensureR1.test.ts pins that limit).
  it('A-R4-1: a cancellation during the created-wait passes at once; the looks and docker info get the signal', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(300);
    expect(docker.commands()).toEqual(['inspect', 'inspect']);
    expect(docker.calls.map((call) => call.signal?.aborted)).toEqual([false, false]);
    controller.abort();
    await rejected;
    expect(docker.commands()).toEqual(['inspect', 'inspect']);
    expect(docker.calls.map((call) => call.signal?.aborted)).toEqual([true, true]);
    // docker info with the signal.
    const timed = new FakeDocker((args) => (args[0] === 'inspect' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(1_000) : undefined));
    const other = new AbortController();
    const again = monitor(timed).ensure(TAG, SOCKET, other.signal);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await again).toBe('failed');
    expectSignalsFollow(timed.calls.filter((call) => call.args[0] === 'info'), other);
  });

  it('A-R4-2: a conflict while a container with the nonce of this create exists is no conflict: removed by its nonce, fails', async () => {
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [CREATED_ID] : inspected(true, LABEL)), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'ps', 'rm']);
    expect(removals(docker).map((call) => call.args)).toEqual([['rm', CREATED_ID]]);
    expect(docker.calls[2].args).toEqual(nonceList(docker.spec(1)));
  });

  // Cleanup C4 (plan step 11J): changed fixtures (before: the answers of `docker ps`): the failure of the list of the port.
  for (const [what, list] of [
    ['a list of the nonce that fails', () => Promise.reject(new EngineError('error during connect', 500))],
    ['a list of the nonce without an answer in time', () => Promise.reject(new Error('no answer in time'))],
    ['a list of the nonce that throws', () => Promise.reject(new Error('spawn failed'))],
  ] as const) {
    it(`A-R4-2: ${what} after a conflict fails; nothing is accepted or removed`, async () => {
      const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? list() : inspected(true, LABEL)), CONFLICTED);
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'ps']);
      expect(removals(docker)).toEqual([]);
    });
  }

  // PR #69 review round 5, B-R5-4: a cancellation during the nonce check after a conflict passes as an AbortError (the
  // rethrow in listOwn survived): no cleanup, no look at the container, no warning.
  it('B-R5-4: a cancellation during the nonce check after a conflict passes; nothing removed, no warning', async () => {
    const controller = new AbortController();
    const logger = new Log();
    const docker = new FakeDocker((args, index) => {
      if (index === 0) return MISSING;
      if (args[0] === 'ps') {
        controller.abort();
        return Promise.reject(abortError());
      }
      return inspected(true, LABEL);
    }, CONFLICTED);
    await expect(monitor(docker, logger).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps']);
    expect(logger.lines.some((line) => line.startsWith('warn'))).toBe(false);
  });

  // Cleanup C4 (plan step 11J): changed expectation (before: the options of the CLI testkit, the signal and its time limit
  // REMOTE_MONITOR_DOCKER_TIMEOUT_MS; none for the cleanup): the signal of the nonce check follows that of ensure; that of
  // the cleanup does not (engineMonitor gives it only its own time limit, engineMonitor.ensureR1.test.ts).
  it('A-R4-2: the nonce check after a conflict gets the signal; the cleanup does not', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : inspected(true, 'other-label')), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET, controller.signal)).toBe('failed');
    const lists = docker.calls.filter((call) => call.args[0] === 'ps');
    expect(lists).toHaveLength(2);
    expectSignalsFollow([lists[0]], controller);
    expect(lists[1].signal?.aborted).toBe(false);
  });

  // A-R4-3: after a conflict, a matching running container that Docker restarted is accepted only with its stored script.
  for (const [what, answer, outcome] of [
    ['the stored script of this version', SAME, 'running'],
    ['no stored script', NO_SCRIPT, 'failed'],
    ['a check without an answer in time', TIMED_OUT, 'failed'],
  ] as const) {
    it(`A-R4-3: a conflict with a matching running container with RestartCount 2 and ${what} → ${outcome}, nothing removed`, async () => {
      const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : args[0] === 'exec' ? answer : inspected(true, LABEL, 0, 2)), CONFLICTED);
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe(outcome);
      expect(docker.commands()).toEqual(outcome === 'running' ? ['inspect', 'run', 'ps', 'inspect', 'exec'] : ['inspect', 'run', 'ps', 'inspect', 'exec', 'ps']);
      expect(docker.calls[4].args).toEqual(SHA);
      expect(removals(docker)).toEqual([]);
    });
  }

  // PR #69 review round 5, B-R5-5: the check of the stored script of a restarted container after a conflict gets the
  // signal of ensure (the signal survived) and a time limit.
  it('B-R5-5: the stored-script check after a conflict gets the signal and a time limit of ensure', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : args[0] === 'exec' ? SAME : inspected(true, LABEL, 0, 2)), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET, controller.signal)).toBe('running');
    const exec = docker.calls.find((call) => call.args[0] === 'exec');
    expect(exec?.signal).toBe(controller.signal);
    expect(exec?.timeoutMs).toBeGreaterThan(0);
  });

  it('A-R4-3: a conflict with a matching paused container with RestartCount 2 is accepted without a check', async () => {
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? [] : inspected('paused', LABEL, 0, 2)), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
  });

  // A-R4-4: an exited container of this version is started by its ID, then its stored script is checked.
  it('A-R4-4: started by its ID with the stored script of this version → started', async () => {
    const logger = new Log();
    const controller = new AbortController();
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL, 137) : args[0] === 'exec' ? SAME : undefined));
    expect(await monitor(docker, logger).ensure(TAG, SOCKET, controller.signal)).toBe('started');
    expect(docker.calls.map((call) => call.args)).toEqual([expect.anything(), ['start', MONITOR_ID], SHA]);
    expect(docker.calls[2].signal).toBe(controller.signal);
    // Cleanup C4 (plan step 11J): changed expectation for the start (before: the signal itself): linked to it.
    expectSignalsFollow([docker.calls[1]], controller);
    expect(logger.lines).toEqual(['info The Session Monitor on the Docker host was started again (devenv-session-monitor).']);
  });

  for (const [what, answer] of [
    ['no stored script', NO_SCRIPT],
    // Cleanup C4 (plan step 11J): changed fixture (before: the CLI's stderr): the engine refuses the exec.
    ['a container that exits 3 again at once (restarting)', new EngineError(`Container ${MONITOR_ID} is restarting, wait until the container is running`, 409)],
    ['another stored script', result(0, `${bundleHash(`${SCRIPT}x`)}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`)],
  ] as const) {
    it(`A-R4-4: started, then ${what} → removed by that ID and created`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL, 0) : args[0] === 'exec' ? (answer instanceof Error ? Promise.reject(answer) : answer) : undefined));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
      expect(docker.commands()).toEqual(['inspect', 'start', 'exec', 'rm', 'run']);
      expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
      expect(docker.calls[3].args).toEqual(['rm', MONITOR_ID]);
      expect(logger.lines).toContain('info The Session Monitor on the Docker host was started again without its script; it is replaced (devenv-session-monitor).');
    });
  }

  for (const [what, answer] of [
    ['a check without an answer in time', TIMED_OUT],
    ['an SSH failure', result(255, '', 'ssh: connect to host build-box port 22: Connection refused\n')],
  ] as const) {
    it(`A-R4-4: started, then ${what} → kept (started, logged), nothing removed`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL, 0) : args[0] === 'exec' ? answer : undefined));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('started');
      // Known gap of plan step 8 (fixed): changed expectation (before: ['inspect', 'start', 'exec']): a check that
      // fails is followed by an inspect by the same ID (here exited again with an exit code other than 3 and the same
      // RestartCount: no evidence, kept).
      expect(docker.commands()).toEqual(['inspect', 'start', 'exec', 'inspect']);
      expect(logger.lines).toEqual([
        'info The Session Monitor on the Docker host was started again and its stored script could not be checked; it is kept (devenv-session-monitor).',
      ]);
    });
  }

  it('A-R4-4: a failed start fails, nothing removed', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL, 0) : args[0] === 'start' ? Promise.reject(new EngineError('permission denied', 403)) : undefined));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'start']);
  });

  // A-R4-5: never by the name. An ID that cannot be read keeps the container and fails, for each path of the table.
  for (const [what, answer, commands] of [
    ['exited (to be started)', inspected(false, LABEL, 0, 0, null), ['inspect']],
    ['exited with 3', inspected(false, LABEL, 3, 0, null), ['inspect']],
    ['restarting', inspected('restarting', LABEL, 3, 0, null), ['inspect']],
    ['dead', inspected('dead', LABEL, 0, 0, null), ['inspect']],
    ['of another label', inspected(true, 'old-label', 0, 0, null), ['inspect']],
    ['running with RestartCount 1 and no stored script', inspected(true, LABEL, 0, 1, null), ['inspect', 'exec']],
  ] as const) {
    it(`A-R4-5: a container ${what} whose ID cannot be read is kept: failed, nothing removed or started by its name`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? answer : args[0] === 'exec' ? NO_SCRIPT : undefined));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(commands);
      expect(docker.calls.some((call) => call.args.includes('devenv-session-monitor') && call.args[0] !== 'inspect' && call.args[0] !== 'exec')).toBe(false);
      expect(logger.lines.join('\n')).toContain('the ID of the Session Monitor container cannot be read; it is kept.');
      expect(logger.lines.some((line) => line.includes('it is replaced'))).toBe(false);
    });
  }

  it('A-R4-1: parseDockerTime reads Docker times and nothing else', () => {
    expect(parseDockerTime(CREATED_AT)).toBe(CREATED_MS);
    expect(parseDockerTime('2026-09-30T12:00:00.123+02:00')).toBe(CREATED_MS);
    expect(parseDockerTime('2026-09-30T06:30:00.123999-03:30')).toBe(CREATED_MS);
    expect(parseDockerTime('2026-09-30T10:00:00Z')).toBe(CREATED_MS - 123);
    for (const bad of [undefined, null, 1, '', 'soon', '2026-09-30T10:00:00', '2026-09-30 10:00:00Z', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-09-30T24:00:00Z', '0001-01-01T00:00:00Z', '2026-09-30T10:00:00.1234567890Z', ` ${CREATED_AT}`]) {
      expect(parseDockerTime(bad), String(bad)).toBeUndefined();
    }
  });
});

// Review round 4 of PR #69: the tests of reviewer B (mutation testing; titled by the IDs of the findings), with the
// adjustments of the verifiers for the fixes of reviewer A's round 4 (start by ID, the nonce check after a conflict).
describe('RemoteSessionMonitor.ensure (review round 4 of PR #69, B-R4)', () => {
  // PR #69 review round 6, A-R6-2: B-R4-3 uses fake timers; every test here gets the real ones back.
  afterEach(() => {
    vi.useRealTimers();
  });

  const restartedWith = (answer: EngineExecResult) => new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, LABEL, 0, 1) : args[0] === 'exec' ? answer : undefined));

  // B-R4-1: the tolerance of a missing container or a removal in progress is for the removal only (T-notRmOnly
  // survived): a start that fails so must not report `started` while nothing runs. Cleanup C4 (plan step 11J): changed
  // fixtures (before: the CLI's stderr): the engine's refusals.
  for (const [what, answer] of [
    ['a missing container', () => Promise.reject(new EngineError(`No such container: ${MONITOR_ID}`, 404))],
    ['a removal in progress', inProgress],
  ] as const) {
    it(`B-R4-1: a docker start that finds ${what} fails`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL, 0) : args[0] === 'start' ? answer() : undefined));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect', 'start']);
      // Verifier note (PR #69 review round 4, A-R4-4): started by its ID.
      expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
      expect(logger.lines.join('\n')).toMatch(/^warn The Session Monitor on the Docker host could not be started: docker start failed/m);
    });
  }

  // B-R4-5: a failed removal without a message is a failure too (T-exitIgnored survived).
  it('B-R4-5: an rm that fails without stderr fails, without a create', async () => {
    const logger = new Log();
    // Cleanup C4 (plan step 11J): changed fixture (before: `docker rm` with exit code 1 and no stderr): the engine refuses
    // without a message, as the engine client reports it.
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(true, 'old-label') : args[0] === 'rm' ? Promise.reject(new EngineError('HTTP status 500', 500)) : undefined));
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'rm']);
    // Verifier note (PR #69 review round 4, A-R4-5): the rm is by the ID.
    expect(docker.calls[1].args).toEqual(['rm', MONITOR_ID]);
    // Cleanup C4 (plan step 11J): changed expectation (before: "exit code 1" of the CLI).
    expect(logger.lines.join('\n')).toContain('docker rm failed: HTTP status 500');
  });

  // B-R4-2: each alternative of NO_STORED_SCRIPT counts only at the start of a line of its source (the carets and the
  // colon after "No such container" survived): a transport failure that quotes the words mid-line, another missing
  // object of the daemon, or two unrelated lines are no evidence.
  const quoted = [
    ['a quoted sha256sum line', `error during connect: command [ssh -- build-box docker system dial-stdio] has exited with exit status 255: stderr=sha256sum: ${REMOTE_MONITOR_SCRIPT_PATH}: No such file or directory\n`],
    ['a quoted CLI line', 'error during connect: command [ssh -- build-box docker system dial-stdio] has exited with exit status 255: stderr=Error: No such container: devenv-session-monitor\n'],
    ['a quoted runtime line', 'error during connect: command [ssh -- build-box docker system dial-stdio] has exited with exit status 255: stderr=OCI runtime exec failed: exec failed: cannot exec in a stopped container: unknown\n'],
    ['a missing exec instance', 'Error response from daemon: No such exec instance: 0f3c2a9e\n'],
    ['an unreadable script and an unrelated SSH warning', `sha256sum: ${REMOTE_MONITOR_SCRIPT_PATH}: Permission denied\nWarning: Identity file /home/u/.ssh/id_devenv not accessible: No such file or directory.\n`],
  ] as const;
  for (const [what, stderr] of quoted) {
    it(`B-R4-2: a failed check with ${what} keeps the monitor`, async () => {
      const docker = restartedWith(result(1, '', stderr));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      // Known gap of plan step 8 (fixed): changed expectation (before: ['inspect', 'exec']): a check that fails is
      // followed by an inspect by the same ID and, still running with the same RestartCount, by one more check.
      expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect', 'exec']);
    });

    // Verifier note (PR #69 review round 4, A-R4-4): the start path decides on the same check, so the same cases keep a
    // started container too.
    it(`B-R4-2, A-R4-4: a started container whose check fails with ${what} is kept, nothing removed`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'inspect' ? inspected(false, LABEL, 137) : args[0] === 'exec' ? result(1, '', stderr) : undefined));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('started');
      // Known gap of plan step 8 (fixed): changed expectation (before: ['inspect', 'start', 'exec']): a check that
      // fails is followed by an inspect by the same ID (here exited again with an exit code other than 3 and the same
      // RestartCount: no evidence, kept).
      expect(docker.commands()).toEqual(['inspect', 'start', 'exec', 'inspect']);
      expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
    });
  }

  // B-R4-3: a cancellation between the look at the conflict and its wait passes at once (W-noPreAbort survived).
  it('B-R4-3: a cancellation during the look of the conflict passes without a wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let looks = 0;
    const docker = new FakeDocker((args) => {
      if (args[0] !== 'inspect') return undefined;
      looks += 1;
      if (looks === 1) return MISSING;
      controller.abort();
      return inspected('created', LABEL);
    }, CONFLICTED);
    // PR #69 review round 6, A-R6-2: changed expectation (before: a real elapsed time below 200 ms, which a loaded
    // machine can exceed): with fake timers, no time passes and the ensure has already rejected, with no timer left.
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await rejected;
    // Verifier note (PR #69 review round 4, A-R4-2): the nonce check changes the exact calls, so the outcome is checked.
    expect(docker.commands().filter((command) => command === 'run')).toHaveLength(1);
    expect(docker.commands()).not.toContain('rm');
  });

  // B-R4-4: a look of the conflict that fails is a failure, not a free name (L-inspectCatchMissing survived).
  it('B-R4-4: a failed inspect after a conflict fails without another create', async () => {
    let looks = 0;
    // Cleanup C4 (plan step 11J): changed fixture (before: an inspect past its time limit): the inspect of the port fails.
    const docker = new FakeDocker((args) => (args[0] !== 'inspect' ? undefined : (looks += 1) === 1 ? MISSING : Promise.reject(new Error('no answer in time'))), CONFLICTED);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // Verifier note (PR #69 review round 4, A-R4-2): the nonce check changes the exact calls, so the outcome is checked.
    expect(docker.commands().filter((command) => command === 'run')).toHaveLength(1);
    expect(docker.commands()).not.toContain('rm');
  });
});

// Review round 5 of PR #69: the findings of reviewer A.
describe('RemoteSessionMonitor.ensure (review round 5 of PR #69, A-R5)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const OTHER_ID = 'beef'.padEnd(64, '2');
  const THIRD_ID = 'dead'.padEnd(64, '3');
  const CREATED_AT = '2026-09-30T10:00:00.123456789Z';
  const CREATED_MS = Date.UTC(2026, 8, 30, 10, 0, 0, 123);
  const createdIn = (label: string | undefined, id: unknown = MONITOR_ID) => inspected('created', label, 0, 0, id, CREATED_AT);
  const systemTime = (ageMs: number) => new Date(CREATED_MS + ageMs).toISOString();
  const inspects = (...answers: unknown[]) => {
    let at = 0;
    return () => answers[Math.min(at++, answers.length - 1)];
  };
  const sum = (waits: readonly number[]) => waits.reduce((total, ms) => total + ms, 0);
  const removals = (docker: FakeDocker) => docker.calls.filter((call) => call.args[0] === 'rm' || call.args[0] === 'start');
  /** The inspects after a conflict: `created` until `untilMs` of fake time have passed, then `after`. */
  const createdUntil = (untilMs: number, after: unknown) => {
    const start = Date.now();
    let first = true;
    return () => {
      if (first) {
        first = false;
        return MISSING;
      }
      return Date.now() - start < untilMs ? inspected('created', LABEL) : after;
    };
  };

  it('A-R5-1: a conflict with a container that is created for about 8 s and then runs with the matching label → running, nothing removed', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const next = createdUntil(8_000, inspected(true, LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('running');
    expect(removals(docker)).toEqual([]);
    expect(docker.commands().filter((command) => command === 'run')).toHaveLength(1);
    expect(logger.lines.some((line) => line.startsWith('warn'))).toBe(false);
  });

  it('A-R5-1: a conflict with a container that stays created through all waits → failed after 12.75 s, nothing removed', async () => {
    vi.useFakeTimers();
    const next = createdUntil(Number.POSITIVE_INFINITY, MISSING);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    let settled = false;
    const ensured = monitor(docker)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS) - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    expect(removals(docker)).toEqual([]);
    expect(docker.commands().filter((command) => command === 'info')).toEqual([]);
  });

  // PR #69 review round 6, A-R6-1: changed title (before: "still gets the short waits only (3.75 s)").
  it('A-R5-1, A-R6-1: a container that stays removing gets the short waits, the last one repeated up to the budget (7.75 s), nothing removed', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, inspected('removing', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    let settled = false;
    const ensured = monitor(docker)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    // PR #69 review round 6, A-R6-1: changed expectation (before: REMOTE_MONITOR_CONFLICT_WAITS_MS only, 5 waits, 3.75 s):
    // only the budget (the longer list, 9 waits) ends the looks; the shorter list repeats its last wait.
    const budget = Math.max(REMOTE_MONITOR_CREATED_WAITS_MS.length, REMOTE_MONITOR_CONFLICT_WAITS_MS.length);
    const waits = Array.from({ length: budget }, (_, at) => REMOTE_MONITOR_CONFLICT_WAITS_MS[Math.min(at, REMOTE_MONITOR_CONFLICT_WAITS_MS.length - 1)]);
    expect(sum(waits)).toBe(7_750);
    await vi.advanceTimersByTimeAsync(sum(waits) - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    // PR #69 review round 6, A-R6-1: changed expectation (before: a look after each of REMOTE_MONITOR_CONFLICT_WAITS_MS).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', ...waits.map(() => 'inspect'), 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
  });

  // PR #69 review round 6, A-R6-1: a status that changes from `created` to `removing` late in the budget still gets a
  // wait (before: the counter was tested against the shorter list of `removing`, so the look ended at once, `failed`).
  it('A-R6-1: a conflict with a container that is created for six looks, then removing, then gone → a second create, nothing removed', async () => {
    vi.useFakeTimers();
    const created = inspected('created', LABEL);
    const next = inspects(MISSING, created, created, created, created, created, created, inspected('removing', LABEL), MISSING);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), (call, index) => (index === 0 ? CONFLICTED(call, index) : STARTS(call, index)));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('created');
    expect(docker.commands().filter((command) => command === 'run')).toHaveLength(2);
    expect(docker.commands()).not.toContain('rm');
    expect(docker.commands().filter((command) => command === 'inspect').length).toBeLessThanOrEqual(10);
  });

  it('A-R5-1: one counter for both lists: a status that changes between created and removing ends after the longer list at most', async () => {
    vi.useFakeTimers();
    // removing, created, removing, created, …: never more looks than the longer list has waits, plus the first.
    let at = 0;
    const next = () => (at++ === 0 ? MISSING : at % 2 === 0 ? inspected('removing', LABEL) : inspected('created', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('failed');
    const looks = docker.commands().filter((command) => command === 'inspect').length - 1;
    expect(looks).toBeLessThanOrEqual(Math.max(REMOTE_MONITOR_CREATED_WAITS_MS.length, REMOTE_MONITOR_CONFLICT_WAITS_MS.length) + 1);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R5-1: a created container after a conflict is never judged by its age, even when it is old (inspect only)', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, createdIn(LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS * 10) : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('failed');
    expect(docker.commands()).not.toContain('info');
    expect(removals(docker)).toEqual([]);
  });

  it('A-R5-1: a cancellation during a long created wait of the conflict passes at once, nothing removed', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const next = inspects(MISSING, inspected('created', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined), CONFLICTED);
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    // Past the old 3.75 s: still waiting.
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CONFLICT_WAITS_MS) + 1_000);
    const before = docker.commands();
    controller.abort();
    await rejected;
    expect(docker.commands()).toEqual(before);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R5-2: the restart of the created-wait for another ID happens once only: a third ID ends it (young → kept)', async () => {
    vi.useFakeTimers();
    const now = REMOTE_MONITOR_STALE_CREATED_MS * 10;
    const createdAtNow = new Date(CREATED_MS + now - 1_000).toISOString();
    const other = inspected('created', LABEL, 0, 0, OTHER_ID, createdAtNow);
    const third = inspected('created', LABEL, 0, 0, THIRD_ID, createdAtNow);
    const next = inspects(createdIn(LABEL), other, third);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(now) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(2 * sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'inspect', 'info']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R5-2: the whole created-wait stays bounded at 2 x 12.75 s even when the ID keeps changing', async () => {
    vi.useFakeTimers();
    let at = 0;
    const ids = [MONITOR_ID, OTHER_ID];
    // Old enough to be replaced only if the ID had been stable; it alternates, so the wait ends at the second change.
    const next = () => inspected('created', LABEL, 0, 0, ids[at++ % 2], CREATED_AT);
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(1_000) : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(2 * sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('failed');
    expect(docker.commands().filter((command) => command === 'inspect').length).toBeLessThanOrEqual(2 * REMOTE_MONITOR_CREATED_WAITS_MS.length + 1);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R5-2: a cancellation during the second created-wait passes at once, nothing removed', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const next = inspects(createdIn(LABEL), createdIn(LABEL, OTHER_ID));
    const docker = new FakeDocker((args) => (args[0] === 'inspect' ? next() : undefined));
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS) - 1_000);
    const before = docker.commands();
    expect(before.length).toBeGreaterThan(2);
    // Cleanup C4 (plan step 11J): changed expectation (before: each call got the signal itself): linked to it.
    expectSignalsFollow(docker.calls, controller);
    await rejected;
    expect(docker.commands()).toEqual(before);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R5-2: a second ID that is old and stays created after its own wait is removed by that ID, never by the name', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), createdIn(LABEL, OTHER_ID));
    const docker = new FakeDocker((args) =>
      args[0] === 'inspect' ? next() : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS + 1) : args[0] === 'ps' ? [CREATED_ID] : undefined,
    );
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(2 * sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('created');
    expect(docker.calls.filter((call) => call.args[0] === 'rm').map((call) => call.args)).toEqual([['rm', OTHER_ID]]);
  });
});

// Known gap of plan step 8 (fixed): a restarted monitor whose stored-script check is cut off by the exit 3 of its
// loader (between two restarts by the policy) was kept, in an exit-3 loop until the next open. A check that gives
// `unknown` is now followed by an inspect by the same ID: restarting, exited with 3, or a grown RestartCount is definite
// evidence (replaced by its ID); still running with the same RestartCount → one more check; anything else → kept.
describe('RemoteSessionMonitor.ensure: remote monitor restart check (known gap of plan step 8)', () => {
  const NAME = 'remote monitor restart check (known gap of plan step 8)';
  const SHA = ['exec', 'devenv-session-monitor', 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH];
  const SAME = result(0, `${bundleHash(SCRIPT)}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`);
  /**
   * A check cut off by the exit of the loader: the engine loses the exec without an answer that counts as evidence.
   * Cleanup C4 (plan step 11J): changed fixture (before: the CLI's "cannot attach: exec session ended unexpectedly"): the
   * engine client's failure for an exec whose output ended while the process did not.
   */
  const CUT_OFF = new EngineError('The output of the process in the container ended, but the process did not.', 200);
  const OTHER_ID = 'beef'.padEnd(64, '2');
  const KEPT_LOG = 'info The Session Monitor on the Docker host was restarted and its stored script could not be checked; it is kept (devenv-session-monitor).';
  const REPLACED_LOG = 'info The Session Monitor on the Docker host was restarted without its script; it is replaced (devenv-session-monitor).';
  /**
   * The answers of inspect and of the checks in order (the last one repeats); any other call succeeds. An Error is the
   * failure of the call; a function is called for its answer.
   */
  const sequenced = (inspects: readonly unknown[], checks: ReadonlyArray<EngineExecResult | Error>) => {
    let inspectIndex = 0;
    let checkIndex = 0;
    const answerOf = (answer: unknown) => (typeof answer === 'function' ? (answer as () => unknown)() : answer instanceof Error ? Promise.reject(answer) : answer);
    return new FakeDocker((args) => {
      if (args[0] === 'inspect') return answerOf(inspects[Math.min(inspectIndex++, inspects.length - 1)]);
      if (args[0] === 'exec') return answerOf(checks[Math.min(checkIndex++, checks.length - 1)]);
      return undefined;
    });
  };
  const RESTARTED = inspected(true, LABEL, 3, 1);

  for (const [what, again] of [
    ['found restarting', inspected('restarting', LABEL, 3, 1)],
    ['exited with 3', inspected(false, LABEL, 3, 1)],
    ['running with a grown RestartCount', inspected(true, LABEL, 3, 2)],
  ] as const) {
    it(`${NAME}: unknown, then ${what} → replaced by its ID`, async () => {
      const logger = new Log();
      const docker = sequenced([RESTARTED, again, MISSING], [CUT_OFF]);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
      expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect', 'rm', 'run']);
      expect(docker.calls[1].args).toEqual(SHA);
      expect(docker.calls[2].args.at(-1)).toBe('devenv-session-monitor');
      expect(docker.calls[3].args).toEqual(['rm', MONITOR_ID]);
      expect(logger.lines).toContain(REPLACED_LOG);
      expect(logger.lines).not.toContain(KEPT_LOG);
    });
  }

  it(`${NAME}: unknown, still running with the same RestartCount, the second check same → kept`, async () => {
    const logger = new Log();
    const docker = sequenced([RESTARTED, RESTARTED], [CUT_OFF, SAME]);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect', 'exec']);
    expect(docker.calls[3].args).toEqual(SHA);
    expect(logger.lines).toEqual([]);
  });

  it(`${NAME}: unknown, still running with the same RestartCount, the second check other → replaced by its ID`, async () => {
    const logger = new Log();
    const docker = sequenced([RESTARTED, RESTARTED, MISSING], [CUT_OFF, NO_SCRIPT]);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect', 'exec', 'rm', 'run']);
    expect(docker.calls[4].args).toEqual(['rm', MONITOR_ID]);
    expect(logger.lines).toContain(REPLACED_LOG);
  });

  it(`${NAME}: unknown twice → kept, logged`, async () => {
    const logger = new Log();
    const docker = sequenced([RESTARTED, RESTARTED], [CUT_OFF, CUT_OFF]);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect', 'exec']);
    expect(logger.lines).toEqual([KEPT_LOG]);
  });

  // Cleanup C4 (plan step 11J): changed fixtures (before: the answers of the CLI): the failures of the inspect of the port.
  for (const [what, again] of [
    ['a failed second inspect', new EngineError('error during connect: read: connection reset by peer', 500)],
    ['a second inspect without an answer in time', new Error('no answer in time')],
    ['a second inspect that throws', new Error('connect ENOENT /var/run/docker.sock')],
    ['a container that is gone at the second inspect', MISSING],
  ] as const) {
    it(`${NAME}: unknown, then ${what} → kept, nothing removed`, async () => {
      const logger = new Log();
      const docker = sequenced([RESTARTED, again], [CUT_OFF]);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect']);
      expect(logger.lines).toEqual([KEPT_LOG]);
    });
  }

  for (const [what, again] of [
    ['restarting', inspected('restarting', LABEL, 3, 1, OTHER_ID)],
    ['exited with 3', inspected(false, LABEL, 3, 1, OTHER_ID)],
    ['running with a grown RestartCount', inspected(true, LABEL, 3, 5, OTHER_ID)],
    ['running', inspected(true, LABEL, 0, 1, OTHER_ID)],
  ] as const) {
    it(`${NAME}: unknown, then an ID that changed (${what}) → kept, nothing removed`, async () => {
      const logger = new Log();
      const docker = sequenced([RESTARTED, again], [CUT_OFF, SAME]);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect']);
      expect(docker.calls.some((call) => call.args[0] === 'rm')).toBe(false);
      expect(logger.lines).toEqual([KEPT_LOG]);
    });
  }

  it(`${NAME}: unknown, then an ID that cannot be read → kept, nothing removed`, async () => {
    const docker = sequenced([RESTARTED, inspected('restarting', LABEL, 3, 2, 'not-an-id')], [CUT_OFF]);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect']);
  });

  it(`${NAME}: unknown, then paused → kept without another check`, async () => {
    const docker = sequenced([RESTARTED, inspected('paused', LABEL, 3, 1)], [CUT_OFF]);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect']);
  });

  it(`${NAME}: a cancellation during the second inspect passes, nothing removed`, async () => {
    // Cleanup C4 (plan step 11J): changed fixture, the cancel of the signal of ensure (see "passes a cancellation on").
    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
      return Promise.reject(abortError());
    };
    const docker = sequenced([RESTARTED, cancel], [CUT_OFF]);
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.commands()).toEqual(['inspect', 'exec', 'inspect']);
  });

  it(`${NAME}: the second inspect and check get the signal of ensure`, async () => {
    const controller = new AbortController();
    const docker = sequenced([RESTARTED, RESTARTED], [CUT_OFF, SAME]);
    expect(await monitor(docker).ensure(TAG, SOCKET, controller.signal)).toBe('running');
    expect(docker.calls[3].signal).toBe(controller.signal);
    // Cleanup C4 (plan step 11J): changed expectation for the inspect (before: the signal itself): linked to it.
    expectSignalsFollow([docker.calls[2]], controller);
  });

  // The start path (an exited container of this version) shares the check.
  const STOPPED = inspected(false, LABEL, 137, 0);
  for (const [what, again] of [
    ['found restarting', inspected('restarting', LABEL, 3, 1)],
    ['exited with 3', inspected(false, LABEL, 3, 0)],
    ['running with a grown RestartCount', inspected(true, LABEL, 0, 1)],
  ] as const) {
    it(`${NAME}: started, unknown, then ${what} → replaced by its ID`, async () => {
      const logger = new Log();
      const docker = sequenced([STOPPED, again, MISSING], [CUT_OFF]);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
      expect(docker.commands()).toEqual(['inspect', 'start', 'exec', 'inspect', 'rm', 'run']);
      expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
      expect(docker.calls[4].args).toEqual(['rm', MONITOR_ID]);
      expect(logger.lines).toContain('info The Session Monitor on the Docker host was started again without its script; it is replaced (devenv-session-monitor).');
    });
  }

  it(`${NAME}: started after earlier restarts (docker start resets RestartCount), unknown, then running with RestartCount 1 → replaced (review round 1 of PR #83, B-R1-1)`, async () => {
    const docker = sequenced([inspected(false, LABEL, 137, 4), inspected(true, LABEL, 0, 1), MISSING], [CUT_OFF, CUT_OFF]);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'start', 'exec', 'inspect', 'rm', 'run']);
    expect(docker.calls[4].args).toEqual(['rm', MONITOR_ID]);
  });

  it(`${NAME}: started, unknown, still running, the second check same → started`, async () => {
    const logger = new Log();
    const docker = sequenced([STOPPED, inspected(true, LABEL, 0, 0)], [CUT_OFF, SAME]);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('started');
    expect(docker.commands()).toEqual(['inspect', 'start', 'exec', 'inspect', 'exec']);
    expect(logger.lines).toEqual(['info The Session Monitor on the Docker host was started again (devenv-session-monitor).']);
  });

  it(`${NAME}: started, unknown twice → kept (started, logged)`, async () => {
    const logger = new Log();
    const docker = sequenced([STOPPED, inspected(true, LABEL, 0, 0)], [CUT_OFF, CUT_OFF]);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('started');
    expect(docker.commands()).toEqual(['inspect', 'start', 'exec', 'inspect', 'exec']);
    expect(logger.lines).toEqual([
      'info The Session Monitor on the Docker host was started again and its stored script could not be checked; it is kept (devenv-session-monitor).',
    ]);
  });

  it(`${NAME}: started, unknown, then a failed second inspect → kept (started), nothing removed`, async () => {
    const docker = sequenced([STOPPED, new EngineError('error during connect: EOF', 500)], [CUT_OFF]);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('started');
    expect(docker.commands()).toEqual(['inspect', 'start', 'exec', 'inspect']);
  });

  it(`${NAME}: started, unknown, then an ID that changed (restarting) → kept (started), nothing removed`, async () => {
    const docker = sequenced([STOPPED, inspected('restarting', LABEL, 3, 4, OTHER_ID)], [CUT_OFF]);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('started');
    expect(docker.commands()).toEqual(['inspect', 'start', 'exec', 'inspect']);
    expect(docker.calls.some((call) => call.args[0] === 'rm')).toBe(false);
  });
});

describe('the image ID of a monitor tag (plan step 11D3)', () => {
  it('the spec carries the image ID only when it is given, and the ensure passes it to the create', async () => {
    const plain = monitor(new FakeDocker(() => undefined));
    expect(plain.runSpec(TAG, SOCKET, LABEL, SCRIPT)).not.toHaveProperty('imageId');
    const id = `sha256:${'b'.repeat(64)}`;
    expect(plain.runSpec('devenv-monitor:0123456789ab', SOCKET, LABEL, SCRIPT, undefined, 'nonce', id)).toMatchObject({ image: 'devenv-monitor:0123456789ab', imageId: id });
    const specs: MonitorRunSpec[] = [];
    const engine: MonitorEngine = {
      inspect: async () => ({ exists: false }),
      daemonTime: async () => Date.now(),
      remove: async () => {},
      start: async () => {},
      storedScript: async () => 'none',
      idsWithLabel: async () => [],
      create: async (spec) => {
        specs.push(spec);
        return { kind: 'ready' };
      },
    };
    const ensuring = new RemoteSessionMonitor({ engine, logger: new Log(), script: async () => SCRIPT });
    expect(await ensuring.ensureOrThrow(TAG, SOCKET, undefined, 'devenv-monitor:0123456789ab', id)).toBe('created');
    expect(specs[0]).toMatchObject({ image: 'devenv-monitor:0123456789ab', imageId: id });
    expect(specs[0].labels[LABEL_SESSION_MONITOR]).toBe(remoteMonitorLabelValue(SCRIPT, TAG));
    expect(await new RemoteSessionMonitor({ engine, logger: new Log(), script: async () => SCRIPT }).ensure(TAG, SOCKET, undefined, 'devenv-monitor:0123456789ab', id)).toBe('created');
    expect(specs[1]).toMatchObject({ imageId: id });
  });
});
