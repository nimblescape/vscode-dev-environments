// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BUNDLE_LINE_LENGTH, PIPE_LOADER, bundleHash, encodeBundle } from '../loader/pipeLoader';
import { abortError, type Logger, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import {
  IMAGE_MAINTENANCE_LABEL_PART,
  LABEL_MONITOR_CREATE,
  LABEL_SESSION_MONITOR,
  REMOTE_MONITOR_READY_TEXT,
  REMOTE_MONITOR_SCRIPT_PATH,
  forgetCommand,
  heartbeatCommand,
  imagePrefixesOf,
  remoteMonitorLabelValue,
} from './protocol';
import {
  REMOTE_MONITOR_CLIENT_EXIT_WAIT_MS,
  REMOTE_MONITOR_CONFLICT_WAITS_MS,
  REMOTE_MONITOR_CREATED_WAITS_MS,
  REMOTE_MONITOR_DOCKER_TIMEOUT_MS,
  REMOTE_MONITOR_LOG_OPTIONS,
  REMOTE_MONITOR_STALE_CREATED_MS,
  RemoteSessionMonitor,
  isMissingContainer,
  parseDockerTime,
} from './remoteSessionMonitor';

const SCRIPT = 'console.log("monitor")';
const TAG = 'devenv-helper:0123456789ab';
const SOCKET = '/var/run/docker.sock';
const LABEL = remoteMonitorLabelValue(SCRIPT, TAG);
const SOURCE = '0123456789abcdef0123456789abcdef';
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

const result = (exitCode: number, stdout = '', stderr = ''): RunResult => ({ exitCode, stdout, stderr, timedOut: false });
/** Review round 2 of PR #69 (A-R2-2): the ID of the inspected monitor container. */
const MONITOR_ID = 'feed'.padEnd(64, '1');
/**
 * The answer of `docker container inspect`: `{{json .State.Status}}\t{{json .State.ExitCode}}\t{{json .Config.Labels}}`
 * `\t{{json .RestartCount}}\t{{json .Id}}` (review round 1 of PR #69, A-R1-1: the restart count added, 0 by default;
 * review round 2 of PR #69, A-R2-2: the ID added, MONITOR_ID by default).
 * `state`: true is `running`, false is `exited` (with `exitCode`), a string is that status.
 */
// PR #69 review round 4, A-R4-1: changed helper (before: five fields): `created`, when given, is the sixth field
// `{{json .Created}}`; without it the answer has five fields (an unreadable creation time).
const inspected = (state: boolean | string, label: string | undefined, exitCode = 0, restartCount = 0, id: unknown = MONITOR_ID, created?: unknown): RunResult => {
  const status = state === true ? 'running' : state === false ? 'exited' : state;
  const labels = JSON.stringify(label === undefined ? {} : { [LABEL_SESSION_MONITOR]: label, other: 'x' });
  const createdField = created === undefined ? '' : `\t${JSON.stringify(created)}`;
  return result(0, `${JSON.stringify(status)}\t${exitCode}\t${labels}\t${restartCount}\t${JSON.stringify(id)}${createdField}\n`);
};
/** Review round 1 of PR #69 (A-R1-2): the ID of the container of a create, as `docker ps -aq --no-trunc` prints it. */
const CREATED_ID = 'c0ffee'.padEnd(64, '0');
/** The answers for a create after a missing container, with the container of the create found by its nonce label. */
const missingThenCreated = (args: readonly string[]): RunResult =>
  args[0] === 'container' ? MISSING : args[0] === 'ps' ? result(0, `${CREATED_ID}\n`) : result(0);
/** The nonce of the create in the arguments of `docker run` (LABEL_MONITOR_CREATE). */
const createIdOf = (args: readonly string[]): string | undefined =>
  args.find((arg) => arg.startsWith(`${LABEL_MONITOR_CREATE}=`))?.slice(LABEL_MONITOR_CREATE.length + 1);
const MISSING = result(1, '', 'Error response from daemon: No such container: devenv-session-monitor');
const READY_LINE = `2026-09-29T10:00:00.000Z ${REMOTE_MONITOR_READY_TEXT} (Node.js v24.0.0, a check every 15 s).\n`;
/** A failed `sha256sum` without a stored script (coreutils). */
const NO_SCRIPT = result(1, '', `sha256sum: ${REMOTE_MONITOR_SCRIPT_PATH}: No such file or directory\n`);
const CONFLICT = 'docker: Error response from daemon: Conflict. The container name "/devenv-session-monitor" is already in use.\n';

/** The attached `docker run` of the monitor (RemoteMonitorDocker.start). */
class FakeClient implements StartedProcess {
  readonly written: string[] = [];
  ended = false;
  killed = false;
  /** PR #69 review round 4, A-R4-1: false for a client that does not end at once when it is killed. */
  exitOnKill = true;
  private stdout: ((text: string) => void) | undefined;
  private stderr: ((text: string) => void) | undefined;
  private resolveExit: (value: { exitCode: number | null }) => void = () => {};
  readonly exited = new Promise<{ exitCode: number | null; error?: Error }>((resolve) => (this.resolveExit = resolve));

  constructor(private readonly onWrite: (client: FakeClient, text: string) => void) {}

  write(text: string): boolean {
    this.written.push(text);
    queueMicrotask(() => this.onWrite(this, text));
    return true;
  }
  end(): void {
    this.ended = true;
  }
  kill(): void {
    this.killed = true;
    if (this.exitOnKill) this.exit(null);
  }
  onStdout(listener: (text: string) => void): void {
    this.stdout = listener;
  }
  onStderr(listener: (text: string) => void): void {
    this.stderr = listener;
  }
  say(text: string): void {
    this.stdout?.(text);
  }
  complain(text: string): void {
    this.stderr?.(text);
  }
  exit(exitCode: number | null): void {
    this.resolveExit({ exitCode });
  }
}

/** What the monitor container does with its script: it starts and prints its ready line. */
const STARTS = (client: FakeClient) => client.say(READY_LINE);

class FakeDocker {
  readonly calls: Array<{ args: string[]; options?: RunOptions }> = [];
  readonly clients: FakeClient[] = [];
  constructor(
    private readonly answer: (args: readonly string[], index: number) => RunResult | Promise<RunResult>,
    private readonly onWrite: ((client: FakeClient, text: string) => void) | null = STARTS,
  ) {}

  async run(args: readonly string[], options?: RunOptions): Promise<RunResult> {
    this.calls.push({ args: [...args], options });
    return this.answer(args, this.calls.length - 1);
  }

  /** Plan step 3 (pipe loading): the attached `docker run`; its call is recorded as `run`. Null: no Docker CLI. */
  start(args: readonly string[]): StartedProcess | undefined {
    this.calls.push({ args: [...args] });
    if (this.onWrite === null) return undefined;
    const client = new FakeClient(this.onWrite);
    this.clients.push(client);
    return client;
  }

  commands(): string[] {
    return this.calls.map((call) => (call.args[0] === 'container' ? `inspect` : call.args[0]));
  }
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
  return new RemoteSessionMonitor({ docker, logger, script: async () => script });
}

describe('RemoteSessionMonitor.ensure', () => {
  it('does nothing when the container of this version runs', async () => {
    const docker = new FakeDocker(() => inspected(true, LABEL));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect']);
    // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: the format
    // {{json .State.Running}}\t{{json .Config.Labels}}; now the status and the exit code, for the decision table of ensure).
    // Review round 1 of PR #69 (A-R1-1): changed expectation (before: without \t{{json .RestartCount}}): the restart count,
    // so that a container that Docker restarted is checked for its stored script.
    // Review round 2 of PR #69 (A-R2-2): changed expectation (before: without \t{{json .Id}}): the ID, so that a replace
    // removes this container by its ID and never one that another window created meanwhile.
    // PR #69 review round 4, A-R4-1: changed expectation (before: without \t{{json .Created}}): the creation time, so that
    // a `created` container is removed only when it is certainly abandoned (its age on the clock of the daemon).
    expect(docker.calls[0].args).toEqual([
      'container',
      'inspect',
      '--format',
      '{{json .State.Status}}\t{{json .State.ExitCode}}\t{{json .Config.Labels}}\t{{json .RestartCount}}\t{{json .Id}}\t{{json .Created}}',
      'devenv-session-monitor',
    ]);
  });

  it('starts the container of this version when it is stopped', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(false, LABEL) : result(0)));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('started');
    // PR #69 review round 4, A-R4-4: changed expectation (before: ['start', 'devenv-session-monitor'] and nothing else):
    // started by its ID, then its stored script is checked (here an answer without a hash: kept).
    expect(docker.calls.map((call) => call.args)).toEqual([
      expect.anything(),
      ['start', MONITOR_ID],
      ['exec', 'devenv-session-monitor', 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH],
    ]);
  });

  it('replaces a container of another version (another script or helper image)', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, 'aaaaaaaaaaaa') : result(0, 'id\n')));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'rm', 'run']);
    // Review round 2 of PR #69 (A-R2-2): changed expectation (before: ['rm', '-f', 'devenv-session-monitor']): by the ID
    // that inspect read.
    expect(docker.calls[1].args).toEqual(['rm', '-f', MONITOR_ID]);
  });

  // PR #69 review round 4, A-R4-5: changed test (before: "… removes the container by its name", 'created' after
  // ['rm', '-f', 'devenv-session-monitor']): never by the name; an ID that cannot be read fails, and nothing is removed.
  it('A-R2-2, A-R4-5: a replace whose inspect gave no readable ID fails and removes nothing', async () => {
    for (const id of [null, 42, 'not-an-id', 'A'.repeat(64), 'f'.repeat(63)]) {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, 'aaaaaaaaaaaa', 0, 0, id) : result(0, 'id\n')));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET), String(id)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect']);
      expect(logger.lines.join('\n')).toContain('the ID of the Session Monitor container cannot be read; it is kept.');
    }
    // Without the fifth field (an older answer) too.
    const short = new FakeDocker((args) =>
      args[0] === 'container' ? result(0, `"running"\t0\t${JSON.stringify({ [LABEL_SESSION_MONITOR]: 'aaaaaaaaaaaa' })}\t0\n`) : result(0, 'id\n'),
    );
    expect(await monitor(short).ensure(TAG, SOCKET)).toBe('failed');
    expect(short.commands()).toEqual(['inspect']);
  });

  it('A-R2-2: when another window replaced the container meanwhile, the removal by the old ID misses and the create accepts the new one', async () => {
    const conflict = (client: FakeClient) => {
      client.complain(CONFLICT);
      client.exit(125);
    };
    const docker = new FakeDocker((args, index) => {
      if (args[0] === 'rm') return result(1, '', `Error response from daemon: No such container: ${MONITOR_ID}\n`);
      // PR #69 review round 4, A-R4-2: the conflict check finds no container with the nonce of this create.
      if (args[0] === 'ps') return result(0);
      return index === 0 ? inspected(true, LABEL, 0, 1) : args[0] === 'exec' ? NO_SCRIPT : inspected(true, LABEL, 0, 0, 'b'.repeat(64));
    }, conflict);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    // PR #69 review round 4, A-R4-2: changed expectation (before: without 'ps'): the conflict is checked by the nonce.
    expect(docker.commands()).toEqual(['inspect', 'exec', 'rm', 'run', 'ps', 'inspect']);
    expect(docker.calls[2].args).toEqual(['rm', '-f', MONITOR_ID]);
    expect(docker.calls.some((call) => call.args[0] === 'rm' && call.args.includes('devenv-session-monitor'))).toBe(false);
  });

  it('runs the helper image of the open by its checked image ID, with the label and the log line of its tag (review round 1 of PR #64, S1)', async () => {
    const imageId = `sha256:${'7'.repeat(64)}`;
    const docker = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0, 'id\n')));
    const logger = new Log();
    expect(await monitor(docker, logger).ensure(TAG, SOCKET, undefined, imageId)).toBe('created');
    const byId = docker.calls[1].args;
    const byTag = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0, 'id\n')));
    await monitor(byTag).ensure(TAG, SOCKET);
    // The same arguments as with the tag, the label included; only the image reference differs. Review round 1 of PR #69
    // (A-R1-2): changed expectation (before: the arguments compared as they are): the nonce of each create differs too.
    const byTagArgs = byTag.calls[1].args.map((arg) => (arg === TAG ? imageId : arg === `${LABEL_MONITOR_CREATE}=${createIdOf(byTag.calls[1].args)}` ? `${LABEL_MONITOR_CREATE}=${createIdOf(byId)}` : arg));
    expect(byId).toEqual(byTagArgs);
    expect(createIdOf(byId)).not.toBe(createIdOf(byTag.calls[1].args));
    expect(byId).toContain(`${LABEL_SESSION_MONITOR}=${LABEL}`);
    expect(byId).not.toContain(TAG);
    expect(logger.lines).toContain(`info The Session Monitor on the Docker host was created (devenv-session-monitor, image ${TAG}).`);
  });

  it('replaces a container of the name without the label', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, undefined) : result(0)));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'rm', 'run']);
  });

  it('creates a missing container: its own network-less, capability-less container with the socket and the volume', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0, 'id\n')));
    expect(await monitor(docker).ensure(TAG, '/run/user/1000/docker.sock')).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'run']);
    const args = docker.calls[1].args;
    const createId = createIdOf(args);
    expect(createId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(args).toEqual([
      'run',
      // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: '-d'): attached with an open
      // input, and ending the client passes no signal on to the container.
      '-i',
      '--sig-proxy=false',
      // Changed expectation (review round 4 of PR #64, R4-8): never a pull, like the helper runs.
      '--pull',
      'never',
      '--name',
      'devenv-session-monitor',
      '--label',
      `${LABEL_SESSION_MONITOR}=${LABEL}`,
      // Review round 1 of PR #69 (A-R1-2): changed expectation (before: no second label): the nonce of this create.
      '--label',
      `${LABEL_MONITOR_CREATE}=${createId}`,
      '--restart',
      'unless-stopped',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      // Monitor cleanup, user decision 2026-09-29 (R5): the log of the monitor is capped, with the driver named.
      '--log-driver',
      'json-file',
      '--log-opt',
      'max-size=1m',
      '--log-opt',
      'max-file=2',
      '-v',
      '/run/user/1000/docker.sock:/var/run/docker.sock',
      '-v',
      'devenv-session-monitor:/state',
      TAG,
      // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: 'sh', '-c', REMOTE_MONITOR_BOOTSTRAP,
      // 'sh', SCRIPT): the pipe loader with the path, the hash and the entry; the script is not on the command line.
      'node',
      '-e',
      PIPE_LOADER,
      REMOTE_MONITOR_SCRIPT_PATH,
      bundleHash(SCRIPT),
      'startMonitor',
    ]);
    // No published port, no environment variable of this computer, never DOCKER_HOST.
    const options = args.slice(0, args.indexOf(TAG));
    expect(options.filter((arg) => /^(-p|--publish|-e|--env|--privileged)$/.test(arg) || arg.includes('DOCKER_HOST'))).toEqual([]);
    expect(args).not.toContain(SCRIPT);
    expect(docker.calls[1].options?.env).toBeUndefined();
    // The script is the first and only input line; then the client is let go.
    const client = docker.clients[0];
    expect(client.written).toEqual([encodeBundle(SCRIPT)]);
    expect(client.ended).toBe(true);
    expect(client.killed).toBe(true);
  });

  it('accepts the container that another window created at the same time', async () => {
    // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: `docker run -d` answered 125 with
    // the conflict; now the attached client reports it on stderr and ends with 125).
    const conflict = (client: FakeClient) => {
      client.complain(CONFLICT);
      client.exit(125);
    };
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? result(0) : inspected(true, LABEL)), conflict);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect']): the conflict is checked
    // by the nonce of this create first (none: a true conflict).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
  });

  it('fails (logged, no throw) when the other window created another version', async () => {
    const logger = new Log();
    // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: `docker run -d` answered 125).
    // PR #69 review round 4, A-R4-2: changed fixture (before: 'Conflict. The container name is already in use.' alone):
    // only the daemon's message at a line start is a conflict, so the message of the daemon as the CLI prints it.
    const conflict = (client: FakeClient) => {
      client.complain('Error response from daemon: Conflict. The container name "/devenv-session-monitor" is already in use by container "abc".\n');
      client.exit(125);
    };
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? result(0) : inspected(true, 'bbbbbbbbbbbb')), conflict);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    expect(logger.lines.join('\n')).toMatch(/warn The Session Monitor on the Docker host could not be started: .*only while this computer is online/);
    // Plan step 3: the container of the other window is not removed. PR #69 review round 4, A-R4-2: changed expectation
    // (before: ['inspect', 'run', 'inspect']): the nonce is checked, and the failure cleans up by the nonce (nothing).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'ps']);
  });

  it('fails (logged) when Docker does not answer, and does not create anything', async () => {
    const logger = new Log();
    const docker = new FakeDocker(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) as unknown as RunResult);
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0)));
    const logger = new Log();
    expect(await monitor(docker, logger, script).ensure(TAG, SOCKET)).toBe('created');
    const args = docker.calls[1].args;
    expect(args.join(' ').length).toBeLessThan(5_000);
    expect(args.some((arg) => arg.includes('quoted'))).toBe(false);
    expect(args.slice(-2)).toEqual([bundleHash(script), 'startMonitor']);
    expect(docker.clients[0].written).toEqual([encodeBundle(script)]);
    // Never in the log either.
    expect(logger.lines.some((line) => line.includes('quoted'))).toBe(false);
  });

  it('fails when the script cannot be read', async () => {
    const docker = new FakeDocker(() => MISSING);
    const failing = new RemoteSessionMonitor({ docker, logger: new Log(), script: async () => Promise.reject(new Error('ENOENT')) });
    expect(await failing.ensure(TAG, SOCKET)).toBe('failed');
  });

  it('passes a cancellation on', async () => {
    const docker = new FakeDocker(() => Promise.reject(abortError()));
    await expect(monitor(docker).ensure(TAG, SOCKET, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('gives the tests their own names, labels, and variables', () => {
    const custom = new RemoteSessionMonitor({
      docker: new FakeDocker(() => result(0)),
      logger: new Log(),
      script: async () => SCRIPT,
      containerName: 'devenv-test-monitor',
      volumeName: 'devenv-test-monitor-state',
      labels: { 'devenv-test.run': 'abc' },
      containerEnv: { DEVENV_MONITOR_TICK_MS: '500' },
    });
    const args = custom.runArgs(TAG, SOCKET, LABEL, SCRIPT);
    expect(args).toContain('devenv-test-monitor');
    expect(args).toContain('devenv-test-monitor-state:/state');
    expect(args).toContain('devenv-test.run=abc');
    expect(args).toContain('DEVENV_MONITOR_TICK_MS=500');
  });
});

// Plan step 3 (pipe loading, user decisions 2026-09-29): the state of the container decides, and the create is the
// attached `docker run` that gets the script on its input and is let go after the ready line.
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
    ['exited', 0, 'started', ['inspect', 'start', 'exec']],
    ['exited', 137, 'started', ['inspect', 'start', 'exec']],
    ['exited', 1, 'started', ['inspect', 'start', 'exec']],
    // The loader refused (exit 3), or the container never ran as it should: replaced.
    ['exited', 3, 'created', ['inspect', 'rm', 'run']],
    // PR #69 review round 4, A-R4-1: changed expectation (before: ['created', 0, 'created', ['inspect', 'rm', 'run']]):
    // a `created` one may be the create of another window; the tests of review round 4 (A-R4-1) cover it.
    ['restarting', 3, 'created', ['inspect', 'rm', 'run']],
    ['dead', 0, 'created', ['inspect', 'rm', 'run']],
  ] as const) {
    it(`the container of this version, ${state} with exit code ${exitCode} → ${outcome}`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(state, LABEL, exitCode) : result(0)));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe(outcome);
      expect(docker.commands()).toEqual(commands);
      // PR #69 review round 4, A-R4-4: changed expectation (before: ['start', 'devenv-session-monitor']): by the ID.
      if (outcome === 'started') expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
      // Review round 2 of PR #69 (A-R2-2): changed expectation (before: ['rm', '-f', 'devenv-session-monitor']): by the ID.
      if (outcome === 'created') expect(docker.calls[1].args).toEqual(['rm', '-f', MONITOR_ID]);
    });
  }

  it('waits for the ready line also when it comes in pieces, after other output', async () => {
    const pieces = (client: FakeClient) => {
      client.say('2026-09-29T10:00:00.000Z Session Mon');
      setTimeout(() => client.say('itor started (Node.js v24.0.0, a check every 15 s).\n'), 10);
    };
    const docker = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0)), pieces);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.clients[0].killed).toBe(true);
  });

  it('fails without a ready line within the time limit: the client is killed and the container removed', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const docker = new FakeDocker(missingThenCreated, () => {});
    const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(REMOTE_MONITOR_DOCKER_TIMEOUT_MS);
    expect(await ensured).toBe('failed');
    // Review round 1 of PR #69 (A-R1-2): changed expectation (before: ['inspect', 'run', 'rm'] with `rm -f
    // devenv-session-monitor`): the container of this create is found by its nonce and removed by its ID.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[2].args).toEqual(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL_MONITOR_CREATE}=${createIdOf(docker.calls[1].args)}`]);
    expect(docker.calls[3].args).toEqual(['rm', '-f', CREATED_ID]);
    expect(docker.clients[0].ended).toBe(true);
    expect(docker.clients[0].killed).toBe(true);
    expect(logger.lines.join('\n')).toContain('did not report its start within 60 seconds');
  });

  it('fails when the loader exits with 3: its line is logged, the container removed, the script never', async () => {
    const logger = new Log();
    const refused = (client: FakeClient) => {
      client.complain('devenv loader: the bundle does not match its hash\n');
      client.exit(3);
    };
    const docker = new FakeDocker(missingThenCreated, refused);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    // Review round 1 of PR #69 (A-R1-2): changed expectation (before: ['inspect', 'run', 'rm'] by the name): by the nonce.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[3].args).toEqual(['rm', '-f', CREATED_ID]);
    expect(logger.lines.join('\n')).toContain('docker run failed: devenv loader: the bundle does not match its hash');
    expect(logger.lines.some((line) => line.includes(SCRIPT))).toBe(false);
  });

  it('fails when the client ends before the ready line without a word', async () => {
    const docker = new FakeDocker(missingThenCreated, (client) => client.exit(1));
    const logger = new Log();
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    // Review round 1 of PR #69 (A-R1-2): changed expectation (before: ['inspect', 'run', 'rm'] by the name): by the nonce.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[3].args).toEqual(['rm', '-f', CREATED_ID]);
    expect(logger.lines.join('\n')).toContain('docker run failed: exit code 1');
  });

  it('passes a cancellation during the create on, after it killed the client and removed the container', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker(missingThenCreated, () => controller.abort());
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.clients[0].killed).toBe(true);
    // Review round 1 of PR #69 (A-R1-2): changed expectation (before: ['inspect', 'run', 'rm'] by the name): by the nonce.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[3].args).toEqual(['rm', '-f', CREATED_ID]);
    // The removal does not take the cancelled signal.
    expect(docker.calls[2].options?.signal).toBeUndefined();
    expect(docker.calls[3].options?.signal).toBeUndefined();
  });

  it('fails without a Docker CLI to start', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0)), null);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run']);
  });

  // User decision 2026-09-29 (3): replaces src/remoteMonitor/bundle.test.ts, which checked that the script fit the command
  // line: the real script, built as esbuild.mjs does, and the most prefixes that the settings allow; no part of the
  // script is on the command line, which stays short.
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
    const args = monitor(new FakeDocker(() => result(0)), new Log(), script).runArgs(TAG, '/run/user/1000/docker.sock', LABEL, script, {
      prefixes: most,
      schedule: '7 6 * * *',
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    expect(args.slice(-6)).toEqual(['node', '-e', PIPE_LOADER, REMOTE_MONITOR_SCRIPT_PATH, bundleHash(script), 'startMonitor']);
    for (let at = 0; at + 64 <= script.length; at += 4096) {
      const piece = script.slice(at, at + 64);
      expect(args.some((arg) => arg.includes(piece))).toBe(false);
    }
    expect(args.join(' ').length).toBeLessThan(10_000);
  });
});

// Review round 1 of PR #69: a monitor whose first load was cut off (A-R1-1), the removal of a failed create by its
// nonce (A-R1-2), the log of stderr (A-R1-3), and the tests of reviewer B (B-R1-2, B-R1-3, B-R1-4, B-R1-5, B-R1-7).
describe('RemoteSessionMonitor.ensure (review round 1 of PR #69)', () => {
  const SHA256SUM = ['exec', 'devenv-session-monitor', 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH];
  const sha256sumOutput = (hash: string) => result(0, `${hash}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`);

  const NO_FILE_COREUTILS = result(1, '', `sha256sum: ${REMOTE_MONITOR_SCRIPT_PATH}: No such file or directory\n`);
  const NO_FILE_BUSYBOX = result(1, '', `sha256sum: can't open '${REMOTE_MONITOR_SCRIPT_PATH}': No such file or directory\n`);
  const TIMED_OUT = { exitCode: null, stdout: '', stderr: '', timedOut: true } as unknown as RunResult;
  // Review round 2 of PR #69 (A-R2-2): only definite evidence of another or no stored script replaces the monitor.
  const replacing = [
    ['no stored script (coreutils)', NO_FILE_COREUTILS],
    ['no stored script (BusyBox)', NO_FILE_BUSYBOX],
    ['another stored script', sha256sumOutput(bundleHash(`${SCRIPT}// changed`))],
    ['a container that is not running', result(1, '', 'Error response from daemon: container 4f1c2a9e is not running\n')],
    ['a container that is restarting', result(1, '', 'Error response from daemon: Container 4f1c2a9e is restarting, wait until the container is running\n')],
    ['a container that is gone', result(1, '', 'Error response from daemon: No such container: devenv-session-monitor\n')],
    // Review round 3 of PR #69 (B-R3-1): the forms of the CLI, the daemon and the runtime, each at the start of a line.
    ['a container that is gone (the CLI)', result(1, '', 'Error: No such container: devenv-session-monitor\n')],
    ['a container that is restarting (its full ID)', result(1, '', `Error response from daemon: Container ${MONITOR_ID} is restarting, wait until the container is running\n`)],
    // Review round 3 of PR #69 (A-R3-5): the runtime refuses the exec in a container that stopped between two restarts.
    ['a container that stopped (the OCI runtime)', result(126, '', 'OCI runtime exec failed: exec failed: cannot exec in a stopped container: unknown\n')],
    [
      'a container that stopped (the OCI runtime, from the daemon)',
      result(126, '', 'Error response from daemon: OCI runtime exec failed: exec failed: cannot exec in a stopped container: unknown\n'),
    ],
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
    ['no answer in time after a partial answer', { exitCode: null, stdout: '', stderr: 'No such file or directory\n', timedOut: true } as unknown as RunResult],
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
  const answering = (state: string, answer: RunResult | Error) =>
    new FakeDocker((args) => {
      if (args[0] === 'container') return inspected(state, LABEL, 3, 1);
      if (args[0] === 'exec') return answer instanceof Error ? Promise.reject(answer) : answer;
      return result(0);
    });

  for (const [what, answer] of replacing) {
    it(`A-R1-1: running with RestartCount 1 and ${what} → replaced`, async () => {
      const logger = new Log();
      const docker = answering('running', answer);
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
      expect(docker.commands()).toEqual(['inspect', 'exec', 'rm', 'run']);
      expect(docker.calls[1].args).toEqual(SHA256SUM);
      expect(docker.calls[1].options?.timeoutMs).toBe(20_000);
      // Review round 2 of PR #69 (A-R2-2): changed expectation (before: ['rm', '-f', 'devenv-session-monitor']): by the ID.
      expect(docker.calls[2].args).toEqual(['rm', '-f', MONITOR_ID]);
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
      expect(docker.commands()).toEqual(['inspect', 'exec']);
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
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(state, LABEL, 0, 1) : args[0] === 'exec' ? sha256sumOutput(bundleHash(SCRIPT)) : result(0)));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      // Review round 2 of PR #69 (A-R2-1): changed expectation for paused (before: ['inspect', 'exec'] as for running).
      expect(docker.commands()).toEqual(state === 'paused' ? ['inspect'] : ['inspect', 'exec']);
      if (state === 'running') expect(docker.calls[1].args).toEqual(SHA256SUM);
    });

    it(`A-R1-1: ${state} with RestartCount 0 → running without any other call`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(state, LABEL, 0, 0) : result(1)));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect']);
    });
  }

  it('A-R1-1: a larger RestartCount is checked too; one that cannot be read counts as 0', async () => {
    // Review round 2 of PR #69 (A-R2-2): changed expectation (before: the check answered result(1) without stderr, which
    // is no evidence now and keeps the monitor): it answers that no script is stored.
    const restarted = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, LABEL, 3, 17) : args[0] === 'exec' ? NO_FILE_COREUTILS : result(0)));
    expect(await monitor(restarted).ensure(TAG, SOCKET)).toBe('created');
    expect(restarted.commands()).toEqual(['inspect', 'exec', 'rm', 'run']);
    const unreadable = new FakeDocker((args) =>
      args[0] === 'container' ? result(0, `"running"\t0\t${JSON.stringify({ [LABEL_SESSION_MONITOR]: LABEL })}\tnull\n`) : result(1),
    );
    expect(await monitor(unreadable).ensure(TAG, SOCKET)).toBe('running');
    expect(unreadable.commands()).toEqual(['inspect']);
  });

  it('A-R1-1: a cancellation during the check of the stored script passes', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, LABEL, 0, 1) : Promise.reject(abortError())));
    await expect(monitor(docker).ensure(TAG, SOCKET, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.commands()).toEqual(['inspect', 'exec']);
  });

  it('A-R1-2: a create whose client ends with "No such container" removes only its own container, by its nonce', async () => {
    const gone = (client: FakeClient) => {
      client.complain('docker: Error response from daemon: No such container: 4f1c2a9e.\n');
      client.exit(125);
    };
    const docker = new FakeDocker(missingThenCreated, gone);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    const createId = createIdOf(docker.calls[1].args);
    expect(createId).toBeDefined();
    expect(docker.calls.map((call) => call.args)).toEqual([
      expect.arrayContaining(['container', 'inspect']),
      expect.arrayContaining(['run', `${LABEL_MONITOR_CREATE}=${createId}`]),
      ['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL_MONITOR_CREATE}=${createId}`],
      ['rm', '-f', CREATED_ID],
    ]);
    expect(docker.calls.some((call) => call.args[0] === 'rm' && call.args.includes('devenv-session-monitor'))).toBe(false);
  });

  it('A-R1-2: nothing is removed when no container has the nonce, or the list fails; each create has its own nonce', async () => {
    const none = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0, '\n')), (client) => client.exit(1));
    expect(await monitor(none).ensure(TAG, SOCKET)).toBe('failed');
    expect(none.commands()).toEqual(['inspect', 'run', 'ps']);
    const failing = new FakeDocker((args) => (args[0] === 'container' ? MISSING : args[0] === 'ps' ? result(1, CREATED_ID, 'error') : result(0)), (client) => client.exit(1));
    expect(await monitor(failing).ensure(TAG, SOCKET)).toBe('failed');
    expect(failing.commands()).toEqual(['inspect', 'run', 'ps']);
    // Review round 2 of PR #69 (note of reviewer B): changed test (before: two instances): one instance, ensure twice.
    const twice = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0)));
    const once = monitor(twice);
    await once.ensure(TAG, SOCKET);
    await once.ensure(TAG, SOCKET);
    const runs = twice.calls.filter((call) => call.args[0] === 'run').map((call) => createIdOf(call.args));
    expect(runs).toHaveLength(2);
    expect(runs[0]).not.toBe(runs[1]);
    // Not part of the label of the version.
    expect(remoteMonitorLabelValue(SCRIPT, TAG)).toBe(LABEL);
  });

  it('A-R1-3: a long line of stderr (the source line of an uncaught error) is not logged, the loader line is', async () => {
    const logger = new Log();
    const crashed = (client: FakeClient) => {
      client.complain(`/opt/devenv/monitor.js:1\n${'y'.repeat(4_000)}\n`);
      client.complain('devenv loader: x\n');
      client.exit(3);
    };
    const docker = new FakeDocker(missingThenCreated, crashed);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    const log = logger.lines.join('\n');
    expect(log).toContain('docker run failed: devenv loader: x');
    expect(log).not.toContain('yyyyyyyyyy');
  });

  it('A-R1-3: at the cap of the tail its first line (the cut end of a longer one) is dropped, even when it is short', async () => {
    const logger = new Log();
    const rest = `${'short line\n'.repeat(300)}devenv loader: x\n`;
    const cut = 4_000 - rest.length - 1;
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThanOrEqual(1_000);
    const crashed = (client: FakeClient) => {
      client.complain(`${'z'.repeat(10_000)}\n${rest}`);
      client.exit(3);
    };
    const docker = new FakeDocker(missingThenCreated, crashed);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    const log = logger.lines.join('\n');
    expect(log).toContain('short line\ndevenv loader: x');
    expect(log).not.toContain('z');
  });

  it('B-R1-2: other output without the ready line is not a start', async () => {
    const other = (client: FakeClient) => {
      client.say('2026-09-29T10:00:00.000Z something else\n');
      setTimeout(() => client.exit(1), 20);
    };
    const docker = new FakeDocker(missingThenCreated, other);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
  });

  it('B-R1-3: a conflict with a container of this version that does not run is a failure', async () => {
    const conflict = (client: FakeClient) => {
      client.complain(CONFLICT);
      client.exit(125);
    };
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? result(0) : inspected(false, LABEL, 3)), conflict);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // Not ours: not removed. PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect']):
    // the nonce is checked first, and the failure cleans up by the nonce only (nothing).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'ps']);
    expect(docker.calls.some((call) => call.args[0] === 'rm')).toBe(false);
  });

  it('B-R1-4: a signal aborted before the create is passed on without writing the script or waiting for the monitor', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args) => {
      if (args[0] === 'container') controller.abort();
      return missingThenCreated(args);
    });
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.clients[0].written).toEqual([]);
    expect(docker.clients[0].killed).toBe(true);
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
  });

  it('B-R1-5: a script whose line is exactly MAX_BUNDLE_LINE_LENGTH is accepted', async () => {
    const script = 'a'.repeat(MAX_BUNDLE_LINE_LENGTH - 2);
    expect(encodeBundle(script).length - 1).toBe(MAX_BUNDLE_LINE_LENGTH);
    const docker = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0)));
    expect(await monitor(docker, new Log(), script).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.clients[0].written[0]).toHaveLength(MAX_BUNDLE_LINE_LENGTH + 1);
  });

  it('B-R1-7: a conflict whose stderr comes in two pieces is still recognised', async () => {
    const conflict = (client: FakeClient) => {
      client.complain('docker: Error response from daemon: Conflict. The container name "/devenv-session-monitor" is already in use');
      client.complain(' by container "abc". You have to remove (or rename) that container to be able to reuse that name.\n');
      client.exit(125);
    };
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? result(0) : inspected(true, LABEL)), conflict);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect']): the nonce check.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
  });
});

// Review round 2 of PR #69: the tests of reviewer B.
describe('RemoteSessionMonitor.ensure (review round 2 of PR #69, B-R2)', () => {
  // Without the signal, a cancellation during the check would be ignored until the time limit of the call (up to 20 s)
  // ends it: the cancellation of the open is delayed by up to 20 s.
  it('B-R2-2: the check of the stored script gets the signal of ensure, so a cancellation stops it', async () => {
    const controller = new AbortController();
    const docker: FakeDocker = new FakeDocker((args, index) => {
      if (args[0] === 'container') return inspected(true, LABEL, 0, 1);
      const signal = docker.calls[index].options?.signal;
      return new Promise<RunResult>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(abortError()));
        // Without the signal: the time limit of the call ends it.
        setTimeout(() => resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true } as unknown as RunResult), 100);
      });
    });
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.commands()).toEqual(['inspect', 'exec']);
    expect(docker.calls[1].options?.signal).toBe(controller.signal);
  });
});

describe('RemoteSessionMonitor: heartbeat, records, forget', () => {
  it('sends a heartbeat with docker exec and a time limit', async () => {
    const docker = new FakeDocker(() => result(0));
    const heartbeat = { source: SOURCE, limitSeconds: 600, environments: [{ id: ID, keepRunning: true, seq: 1 }] };
    expect(await monitor(docker).heartbeat(heartbeat)).toEqual({ ok: true, stdout: '' });
    // Review round 2 of PR #58: the heartbeat runs under the kernel lock of the records (heartbeatCommand).
    expect(docker.calls[0].args).toEqual(['exec', 'devenv-session-monitor', ...heartbeatCommand(heartbeat)]);
    expect(heartbeatCommand(heartbeat).slice(-4)).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'heartbeat', JSON.stringify(heartbeat)]);
    expect(docker.calls[0].options?.timeoutMs).toBe(20_000);
  });

  it('tells a missing container from another failure', async () => {
    const heartbeat = { source: SOURCE, limitSeconds: 600, environments: [] };
    expect(await monitor(new FakeDocker(() => MISSING)).heartbeat(heartbeat)).toMatchObject({ ok: false, missing: true });
    const stopped = result(1, '', 'Error response from daemon: container 1234 is not running');
    expect(await monitor(new FakeDocker(() => stopped)).heartbeat(heartbeat)).toMatchObject({ ok: false, missing: true });
    const invalid = result(2, '', 'Invalid heartbeat.');
    expect(await monitor(new FakeDocker(() => invalid)).heartbeat(heartbeat)).toEqual({ ok: false, missing: false, detail: 'Invalid heartbeat.' });
    // Review round 3 of PR #58 (F7): a lock that stayed busy and the time limit are named.
    expect(await monitor(new FakeDocker(() => result(75))).heartbeat(heartbeat)).toEqual({
      ok: false,
      missing: false,
      detail: 'the heartbeat records stayed locked by another command for 5 s',
    });
    // Review round 4 (H2): 137 is any SIGKILL (a command without the lock gets the bare exit code: protocol.test.ts).
    expect(await monitor(new FakeDocker(() => result(137))).heartbeat(heartbeat)).toMatchObject({
      detail: 'the command was killed (its limit of 10 s, or a kill from outside)',
    });
    const thrown = new FakeDocker(() => Promise.reject(new Error('Docker Desktop is not installed.')));
    expect(await monitor(thrown).heartbeat(heartbeat)).toEqual({ ok: false, missing: false, detail: 'Docker Desktop is not installed.' });
  });

  it('reads the records of an environment', async () => {
    const output = { now: 5, records: [{ source: SOURCE, at: 4, keepRunning: false }] };
    expect(await monitor(new FakeDocker(() => result(0, JSON.stringify(output)))).records(ID)).toEqual(output);
    expect(await monitor(new FakeDocker(() => result(0, 'garbage'))).records(ID)).toBeUndefined();
    expect(await monitor(new FakeDocker(() => MISSING)).records(ID)).toBeUndefined();
  });

  it('forgets a record; a failure is logged, a missing container is not', async () => {
    const logger = new Log();
    const docker = new FakeDocker(() => result(0));
    await monitor(docker, logger).forget(SOURCE, ID);
    // Review round 3 of PR #58 (F6): under the lock of the records, as a heartbeat.
    expect(docker.calls[0].args).toEqual(['exec', 'devenv-session-monitor', ...forgetCommand(SOURCE, ID)]);
    expect(forgetCommand(SOURCE, ID).slice(-5)).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', SOURCE, ID]);
    await monitor(new FakeDocker(() => MISSING), logger).forget(SOURCE, ID);
    expect(logger.lines).toEqual([]);
    await monitor(new FakeDocker(() => result(1, '', 'boom')), logger).forget(SOURCE, ID);
    expect(logger.lines).toEqual([`warn The heartbeat record of ${ID} could not be removed from the Session Monitor: boom`]);
    // Review round 5 of PR #58 (J2): forget runs under the lock of the records, so a kill is named in the log.
    await monitor(new FakeDocker(() => result(137)), logger).forget(SOURCE, ID);
    expect(logger.lines[1]).toBe(
      `warn The heartbeat record of ${ID} could not be removed from the Session Monitor: the command was killed (its limit of 10 s, or a kill from outside)`,
    );
  });

  it('isMissingContainer', () => {
    expect(isMissingContainer(MISSING)).toBe(true);
    expect(isMissingContainer(result(1, '', 'Error: No such object: devenv-session-monitor'))).toBe(true);
    expect(isMissingContainer(result(1, '', 'permission denied'))).toBe(false);
    expect(isMissingContainer({ ...MISSING, timedOut: true })).toBe(false);
  });
});

// User requests 2026-09-28: the image maintenance of the monitor, only on a remote host.
describe('RemoteSessionMonitor: images', () => {
  const PREFIXES = ['ghcr.io/majikmate/devcontainer-classroom', 'ghcr.io/majikmate/devcontainer-dev'];
  // User request 2026-09-28 ("in a guided cron style manner"): the daily time 06:07 became the cron schedule `7 6 * * *`.
  const IMAGES = { prefixes: PREFIXES, schedule: '7 6 * * *', timeZone: 'Europe/Vienna' };

  it('gives the container the prefixes and outbound network; without prefixes still no network', () => {
    const plain = monitor(new FakeDocker(() => result(0)));
    expect(plain.runArgs(TAG, SOCKET, LABEL, SCRIPT)).toEqual(expect.arrayContaining(['--network', 'none']));
    const args = plain.runArgs(TAG, SOCKET, LABEL, SCRIPT, IMAGES);
    expect(args).not.toContain('--network');
    expect(args).toContain(`DEVENV_IMAGE_PREFIXES=${JSON.stringify(PREFIXES)}`);
    // User request 2026-09-28: "1 minute after the monitor starts then in the morning again, at 6:07 CEST"; the daily time
    // became a cron schedule ("in a guided cron style manner").
    expect(args).toContain('DEVENV_IMAGE_SCHEDULE=7 6 * * *');
    expect(args).toContain('DEVENV_IMAGE_TZ=Europe/Vienna');
    expect(plain.runArgs(TAG, SOCKET, LABEL, SCRIPT, { ...IMAGES, prefixes: [] })).toEqual(expect.arrayContaining(['--network', 'none']));
    // Still no capability, no published port, no new privileges.
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']));
    expect(args.some((arg) => arg === '-p' || arg === '--publish')).toBe(false);
  });

  // Monitor cleanup, user decision 2026-09-29 (R5): the log of the monitor is capped with and without image maintenance,
  // with the json-file driver named (max-size alone fails where journald or syslog is the default driver).
  it('caps the Docker log of the container in every variant', () => {
    const plain = monitor(new FakeDocker(() => result(0)));
    const capped = ['--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2'];
    expect(REMOTE_MONITOR_LOG_OPTIONS).toEqual(capped);
    for (const args of [plain.runArgs(TAG, SOCKET, LABEL, SCRIPT), plain.runArgs(TAG, SOCKET, LABEL, SCRIPT, IMAGES)]) {
      const at = args.indexOf('--log-driver');
      expect(at).toBeGreaterThan(0);
      expect(args.slice(at, at + capped.length)).toEqual(capped);
      // Options of `docker run`, before the image.
      expect(at).toBeLessThan(args.indexOf(TAG));
    }
  });

  // Review round 1 of PR #57 (C; K): the prefixes, the time and the time zone were part of the label, so two computers
  // with other settings replaced the monitor of a shared engine at each open. Now only whether it maintains images is
  // (its network); the settings come with `settings -`.
  it('replaces the container when the image maintenance is turned on or off, not when its settings differ', async () => {
    const withImages = remoteMonitorLabelValue(SCRIPT, TAG, [IMAGE_MAINTENANCE_LABEL_PART]);
    expect(withImages).not.toBe(LABEL);
    expect(remoteMonitorLabelValue(SCRIPT, TAG, [])).toBe(LABEL);
    const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, LABEL) : result(0, 'id\n')));
    const withSetting = new RemoteSessionMonitor({ docker, logger: new Log(), script: async () => SCRIPT, imageMaintenance: () => IMAGES });
    expect(await withSetting.ensure(TAG, SOCKET)).toBe('created');
    const run = docker.calls.find((call) => call.args[0] === 'run');
    expect(run?.args).toContain(`${LABEL_SESSION_MONITOR}=${withImages}`);
    // Another computer: other prefixes, another schedule, another time zone: the running monitor stays.
    for (const other of [
      { ...IMAGES, prefixes: ['ghcr.io/acme/base'] },
      { ...IMAGES, schedule: '0 5 * * 1-5' },
      { ...IMAGES, timeZone: 'America/New_York' },
    ]) {
      const running = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, withImages) : result(0)));
      const otherComputer = new RemoteSessionMonitor({ docker: running, logger: new Log(), script: async () => SCRIPT, imageMaintenance: () => other });
      expect(await otherComputer.ensure(TAG, SOCKET)).toBe('running');
      expect(running.calls.some((call) => call.args[0] === 'rm' || call.args[0] === 'run')).toBe(false);
    }
    // Turned off: replaced (no network again).
    const off = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, withImages) : result(0, 'id\n')));
    const offComputer = new RemoteSessionMonitor({ docker: off, logger: new Log(), script: async () => SCRIPT, imageMaintenance: () => ({ ...IMAGES, prefixes: [] }) });
    expect(await offComputer.ensure(TAG, SOCKET)).toBe('created');
  });

  // Review round 9 of PR #57: the prefixes on the command line were cut to what Windows takes; `settings -` brings all.
  // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: only as many prefixes as fit
  // next to a script of 28000 characters; now the command line holds no script, so all of them go, and its length does
  // not depend on the script).
  it('puts all prefixes on the command line, whatever the length of the script', () => {
    const many = Array.from({ length: 50 }, (_, index) => `ghcr.io/${String(index).padStart(2, '0')}${'a'.repeat(76)}`);
    const plain = monitor(new FakeDocker(() => result(0)));
    const script = 'x'.repeat(28_000);
    const args = plain.runArgs(TAG, SOCKET, LABEL, script, { ...IMAGES, prefixes: many });
    expect(args).toContain(`DEVENV_IMAGE_PREFIXES=${JSON.stringify(many)}`);
    expect(args.some((arg) => arg.includes(script))).toBe(false);
    const short = plain.runArgs(TAG, SOCKET, LABEL, SCRIPT, { ...IMAGES, prefixes: many });
    expect(short.join(' ').length).toBe(args.join(' ').length);
  });

  it('gives the monitor the settings of this computer on stdin (docker exec -i settings -); false on a failure', async () => {
    const docker = new FakeDocker(() => result(0));
    const log = new Log();
    expect(await monitor(docker, log).imageSettings(IMAGES)).toBe(true);
    expect(docker.calls[0].args).toEqual(['exec', '-i', 'devenv-session-monitor', 'node', REMOTE_MONITOR_SCRIPT_PATH, 'settings', '-']);
    expect(docker.calls[0].options?.input).toBe(JSON.stringify(IMAGES));
    expect(await monitor(new FakeDocker(() => result(2, '', 'Invalid image settings.')), log).imageSettings(IMAGES)).toBe(false);
    expect(log.lines).toEqual(['warn The image settings could not be given to the Session Monitor: Invalid image settings.']);
  });

  it('gives the monitor the list of repositories on stdin (docker exec -i), and logs a failure', async () => {
    const docker = new FakeDocker(() => result(0));
    const log = new Log();
    // Review round 1 of PR #57 (D): true on success, false on a failure (the caller tries again at the next open).
    expect(await monitor(docker, log).images(['ghcr.io/majikmate/devcontainer-dev'])).toBe(true);
    expect(docker.calls[0].args).toEqual(['exec', '-i', 'devenv-session-monitor', 'node', REMOTE_MONITOR_SCRIPT_PATH, 'images', '-']);
    expect(docker.calls[0].options?.input).toBe(JSON.stringify({ repositories: ['ghcr.io/majikmate/devcontainer-dev'] }));
    const failing = new FakeDocker(() => result(2, '', 'Invalid image list.'));
    expect(await monitor(failing, log).images([])).toBe(false);
    expect(log.lines).toEqual(['warn The image list could not be given to the Session Monitor: Invalid image list.']);
  });
});

// Review round 3 of PR #69 (A-R3-1, A-R3-2): two windows that replace or create the monitor at the same time. The `rm`
// of the old monitor tolerates a removal in progress; a name conflict of the create waits a few seconds while the
// container of the name is `created` or `removing`, accepts only a matching running or paused one, creates once more when
// the name became free, and never removes anything but the container of its own nonce.
describe('RemoteSessionMonitor.ensure (review round 3 of PR #69, A-R3)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const IN_PROGRESS = result(1, '', `Error response from daemon: removal of container ${MONITOR_ID} is already in progress\n`);
  /** The first create meets the name conflict; the next one (if any) starts. */
  const conflictThenStarts = (docker: () => FakeDocker) => (client: FakeClient) => {
    if (docker().clients.indexOf(client) === 0) {
      client.complain(CONFLICT);
      client.exit(125);
    } else {
      STARTS(client);
    }
  };
  const alwaysConflict = (client: FakeClient) => {
    client.complain(CONFLICT);
    client.exit(125);
  };
  /** The answers of the inspects in their order; the last one repeats. */
  const inspects = (...answers: RunResult[]) => {
    let at = 0;
    return () => answers[Math.min(at++, answers.length - 1)];
  };
  // PR #69 review round 4, A-R4-2: changed helper (before: the `rm` and the `ps` calls): the conflict is now checked by
  // the nonce of this create (`ps`, a read), so only the `rm` calls count as removals; noncePs checks that every `ps` is
  // the list of the nonce of a create of this ensure.
  const removals = (docker: FakeDocker) => docker.calls.filter((call) => call.args[0] === 'rm');
  const noncePs = (docker: FakeDocker) => {
    const nonces = docker.calls.filter((call) => call.args[0] === 'run').map((call) => createIdOf(call.args));
    for (const call of docker.calls.filter((each) => each.args[0] === 'ps')) {
      expect(call.args.slice(0, 4)).toEqual(['ps', '-aq', '--no-trunc', '--filter']);
      expect(nonces.map((nonce) => `label=${LABEL_MONITOR_CREATE}=${nonce}`)).toContain(call.args[4]);
    }
  };

  it('A-R3-1: an rm that finds the removal already in progress goes on; the create waits for the name and creates once more', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const next = inspects(inspected(true, 'old-label'), inspected('removing', 'old-label'), MISSING);
    const docker: FakeDocker = new FakeDocker(
      (args) => (args[0] === 'container' ? next() : args[0] === 'rm' ? IN_PROGRESS : result(0)),
      conflictThenStarts(() => docker),
    );
    const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ensured).toBe('created');
    // PR #69 review round 4, A-R4-2: changed expectation (before: without 'ps'): the nonce check after the conflict.
    expect(docker.commands()).toEqual(['inspect', 'rm', 'run', 'ps', 'inspect', 'inspect', 'run']);
    noncePs(docker);
    // Only the old monitor by its ID, once; nothing in the conflict loop.
    expect(removals(docker).map((call) => call.args)).toEqual([['rm', '-f', MONITOR_ID]]);
    const runs = docker.calls.filter((call) => call.args[0] === 'run');
    expect(createIdOf(runs[1].args)).toBe(createIdOf(runs[0].args));
    expect(docker.clients[1].written).toEqual([encodeBundle(SCRIPT)]);
    expect(logger.lines.some((line) => line.startsWith('warn'))).toBe(false);
  });

  it('A-R3-1: an rm that fails otherwise still fails, without a create', async () => {
    for (const answer of [
      result(1, '', 'Error response from daemon: permission denied\n'),
      { exitCode: null, stdout: '', stderr: `removal of container ${MONITOR_ID} is already in progress`, timedOut: true } as unknown as RunResult,
    ]) {
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, 'old-label') : args[0] === 'rm' ? answer : result(0)));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect', 'rm']);
    }
  });

  it('A-R3-2: a conflict with a matching container that another window is still creating waits until it runs', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, inspected('created', LABEL), inspected('created', LABEL), inspected(true, LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)), alwaysConflict);
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)), alwaysConflict);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ensured).toBe('running');
    expect(removals(docker)).toEqual([]);
  });

  it('A-R3-2: a container that is still created after a few seconds is a failure, never accepted and never removed', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const next = inspects(MISSING, inspected('created', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)), alwaysConflict);
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)), alwaysConflict);
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ensured).toBe('failed');
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect', 'inspect']).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R3-2: another status (restarting) fails at once, without a wait', async () => {
    const next = inspects(MISSING, inspected('restarting', LABEL, 3));
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)), alwaysConflict);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect']).
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R3-1: when the name is free after a conflict, the create is tried once more only', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0)), alwaysConflict);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect', 'run', 'inspect']): the
    // nonce check after each conflict, and the cleanup by the nonce before the failure.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'run', 'ps', 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
    noncePs(docker);
  });

  it('A-R3-1: a create once more that fails otherwise removes only the container of its own nonce', async () => {
    // PR #69 review round 4, A-R4-2: changed fixture (before: every `ps` listed CREATED_ID): the nonce check after the
    // conflict finds no container (the conflict made none); only the cleanup after the second create finds it.
    let lists = 0;
    const docker: FakeDocker = new FakeDocker(
      (args) => (args[0] === 'container' ? MISSING : args[0] === 'ps' ? (lists++ === 0 ? result(0) : result(0, `${CREATED_ID}\n`)) : result(0)),
      (client) => (docker.clients.indexOf(client) === 0 ? alwaysConflict(client) : client.exit(1)),
    );
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect', 'run', 'ps', 'rm'], the
    // calls at 4 and 5): the nonce check after the conflict.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect', 'run', 'ps', 'rm']);
    expect(docker.calls[5].args).toEqual(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL_MONITOR_CREATE}=${createIdOf(docker.calls[4].args)}`]);
    expect(docker.calls[6].args).toEqual(['rm', '-f', CREATED_ID]);
  });

  it('A-R3-2: a cancellation during a wait of the conflict passes at once, and nothing is removed', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const next = inspects(MISSING, inspected('created', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)), alwaysConflict);
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    // PR #69 review round 4, A-R4-2: changed expectation (before: ['inspect', 'run', 'inspect'], the inspect at 2): the
    // nonce check after the conflict, which gets the signal too.
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
    controller.abort();
    await rejected;
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
    expect(removals(docker)).toEqual([]);
    // The inspects of the conflict get the signal.
    expect(docker.calls[2].options?.signal).toBe(controller.signal);
    expect(docker.calls[3].options?.signal).toBe(controller.signal);
  });
});

// Review round 3 of PR #69: the tests of reviewer B (mutation testing).
describe('RemoteSessionMonitor.ensure (review round 3 of PR #69, B-R3)', () => {
  const SHA = ['exec', 'devenv-session-monitor', 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH];
  const restartedWith = (answer: RunResult) =>
    new FakeDocker((args) => (args[0] === 'container' ? inspected(true, LABEL, 0, 1) : args[0] === 'exec' ? answer : result(0)));

  // B-R3-1: NO_STORED_SCRIPT is searched in the whole stderr, so a transport failure whose stderr has an unrelated
  // "No such file or directory" (an SSH warning, a missing socket) replaces a running monitor on no evidence.
  for (const [what, stderr] of [
    ['an SSH warning about an identity file, then a reset connection', 'Warning: Identity file /home/u/.ssh/id_devenv not accessible: No such file or directory.\nerror during connect: Get "http://docker.example.com/v1.47/containers/devenv-session-monitor/json": read: connection reset by peer\n'],
    ['a missing known_hosts file, then a failed connection', 'hostfile_replace_entries: link /home/u/.ssh/known_hosts to /home/u/.ssh/known_hosts.old: No such file or directory\nssh: connect to host build-box port 22: Connection timed out\n'],
  ] as const) {
    it(`B-R3-1: a failed check with ${what} keeps the monitor`, async () => {
      const docker = restartedWith(result(255, '', stderr));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect', 'exec']);
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
      expect(docker.commands()).toEqual(['inspect', 'exec']);
      expect(docker.calls[1].args).toEqual(SHA);
    });
  }

  // B-R3-3: the removal of the old monitor gets the signal of ensure (M-rmNoSignal survived): a cancellation of the open
  // must not wait up to 60 s for it.
  it('B-R3-3: the removal of the old monitor gets the signal of ensure', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, 'old-label') : result(0)));
    expect(await monitor(docker).ensure(TAG, SOCKET, controller.signal)).toBe('created');
    expect(docker.calls[1].args).toEqual(['rm', '-f', MONITOR_ID]);
    expect(docker.calls[1].options?.signal).toBe(controller.signal);
  });

  // B-R3-4: the cleanup of a failed create removes only what `docker ps -aq --no-trunc` listed as a full ID
  // (M-rbe-filterOff survived): never a name or another word of the output.
  it('B-R3-4: the cleanup of a failed create removes only full IDs of its list', async () => {
    const docker = new FakeDocker(
      (args) => (args[0] === 'container' ? MISSING : args[0] === 'ps' ? result(0, `devenv-session-monitor\n${CREATED_ID.slice(0, 12)}\n${CREATED_ID}\n`) : result(0)),
      (client) => client.exit(1),
    );
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.calls.filter((call) => call.args[0] === 'rm').map((call) => call.args)).toEqual([['rm', '-f', CREATED_ID]]);
  });

  // B-R3-5: an ID that is not exactly 64 lower-case hex digits is not used (id-noStart, id-noEnd survived).
  for (const id of [`x${MONITOR_ID}`, `${MONITOR_ID}0`]) {
    it(`B-R3-5: an inspected ID ${id.startsWith('x') ? 'with a prefix' : 'with a suffix'} is not used for the removal`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, 'old-label', 0, 0, id) : result(0)));
      // PR #69 review round 4, A-R4-5: changed expectation (before: 'created' after ['rm', '-f', 'devenv-session-monitor']):
      // never removed by its name; the ensure fails and removes nothing.
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect']);
    });
  }
});

// Review round 4 of PR #69, reviewer A: a `created` container is removed only when it is certainly abandoned (A-R4-1),
// the name conflict is only the daemon's message with exit 125 and no container of our nonce (A-R4-2), a restarted
// container after a conflict is accepted only with its stored script (A-R4-3), a started exited container is checked for
// its stored script (A-R4-4), and nothing is ever removed or started by the name (A-R4-5).
describe('RemoteSessionMonitor.ensure (review round 4 of PR #69, A-R4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SHA = ['exec', 'devenv-session-monitor', 'sha256sum', REMOTE_MONITOR_SCRIPT_PATH];
  const SAME = result(0, `${bundleHash(SCRIPT)}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`);
  const TIMED_OUT = { exitCode: null, stdout: '', stderr: '', timedOut: true } as unknown as RunResult;
  const OTHER_ID = 'beef'.padEnd(64, '2');
  /** `.Created` of the inspected container, as Docker prints it (nanoseconds), and the same in ms. */
  const CREATED_AT = '2026-09-30T10:00:00.123456789Z';
  const CREATED_MS = Date.UTC(2026, 8, 30, 10, 0, 0, 123);
  const createdIn = (label: string | undefined, id: unknown = MONITOR_ID) => inspected('created', label, 0, 0, id, CREATED_AT);
  /** `docker info --format '{{json .SystemTime}}'` at `ageMs` after the create, with an offset as the daemon may print it. */
  const systemTime = (ageMs: number) => {
    const at = new Date(CREATED_MS + ageMs + 2 * 3_600_000);
    const text = `${at.toISOString().slice(0, 23)}456789+02:00`;
    return result(0, `${JSON.stringify(text)}\n`);
  };
  const inspects = (...answers: RunResult[]) => {
    let at = 0;
    return () => answers[Math.min(at++, answers.length - 1)];
  };
  const removals = (docker: FakeDocker) => docker.calls.filter((call) => call.args[0] === 'rm');
  const CREATED_WAIT_TOTAL = REMOTE_MONITOR_CREATED_WAITS_MS.reduce((sum, ms) => sum + ms, 0);
  const allCreatedLooks = ['inspect', ...REMOTE_MONITOR_CREATED_WAITS_MS.map(() => 'inspect')];
  const alwaysConflict = (client: FakeClient) => {
    client.complain(CONFLICT);
    client.exit(125);
  };

  it('A-R4-1: the created-wait is bounded to 10-15 s and the stale age is the Docker time limit plus 30 s', () => {
    expect(CREATED_WAIT_TOTAL).toBeGreaterThanOrEqual(10_000);
    expect(CREATED_WAIT_TOTAL).toBeLessThanOrEqual(15_000);
    expect(REMOTE_MONITOR_STALE_CREATED_MS).toBe(REMOTE_MONITOR_DOCKER_TIMEOUT_MS + 30_000);
  });

  it('A-R4-1: a matching created container that another window starts meanwhile is accepted, never removed', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), createdIn(LABEL), inspected(true, LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'inspect']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R4-1: a matching created container that goes on to paused is accepted too', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), inspected('paused', LABEL, 0, 3));
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('running');
    expect(removals(docker)).toEqual([]);
  });

  it('A-R4-1: a created container that is gone meanwhile (the other window gave up) is created, nothing removed', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), MISSING);
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'run']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R4-1: a created container that exits with 3 meanwhile goes through the table (replaced by its ID)', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), inspected(false, LABEL, 3));
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)));
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'inspect', 'rm', 'run']);
    expect(docker.calls[2].args).toEqual(['rm', '-f', MONITOR_ID]);
  });

  it('A-R4-1: another ID at the name during the wait ends the wait; that container goes through the table', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), inspected(true, LABEL, 0, 0, OTHER_ID));
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)));
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : args[0] === 'info' ? systemTime(now) : result(0)));
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : args[0] === 'info' ? systemTime(now) : result(0)));
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(10_000) : result(0)));
    let settled = false;
    const ensured = monitor(docker, logger)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    expect(docker.commands()).toEqual([...allCreatedLooks, 'info']);
    expect(docker.calls.at(-1)?.args).toEqual(['info', '--format', '{{json .SystemTime}}']);
    expect(removals(docker)).toEqual([]);
    expect(logger.lines.join('\n')).toMatch(/warn .*created 10 seconds ago and has not started yet .*it is kept\./);
  });

  it('A-R4-1: a matching container that stays created and is older than the stale age is removed by its ID, then created', async () => {
    vi.useFakeTimers();
    const logger = new Log();
    const docker = new FakeDocker((args) =>
      args[0] === 'container' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS + 1) : result(0),
    );
    const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('created');
    expect(docker.commands()).toEqual([...allCreatedLooks, 'info', 'rm', 'run']);
    expect(removals(docker).map((call) => call.args)).toEqual([['rm', '-f', MONITOR_ID]]);
    expect(logger.lines).toContain('info The Session Monitor on the Docker host was created 90 seconds ago and never started; it is replaced (devenv-session-monitor).');
  });

  it('A-R4-1: exactly at the stale age it is kept', async () => {
    vi.useFakeTimers();
    const docker = new FakeDocker((args) =>
      args[0] === 'container' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS) : result(0),
    );
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('failed');
    expect(removals(docker)).toEqual([]);
  });

  for (const [what, info] of [
    ['a failed docker info', result(1, '', 'Cannot connect to the Docker daemon\n')],
    ['docker info without an answer in time', TIMED_OUT],
    ['docker info that throws', new Error('Docker Desktop is not installed.')],
    ['a time of the daemon that is not a time', result(0, '"yesterday"\n')],
    ['an empty answer of docker info', result(0, '')],
    ['a time of the daemon without a zone', result(0, '"2026-09-30T10:05:00"\n')],
  ] as const) {
    it(`A-R4-1: ${what} keeps an old created container (failed, nothing removed)`, async () => {
      vi.useFakeTimers();
      const logger = new Log();
      const docker = new FakeDocker((args) =>
        args[0] === 'container' ? createdIn(LABEL) : args[0] === 'info' ? (info instanceof Error ? Promise.reject(info) : info) : result(0),
      );
      const ensured = monitor(docker, logger).ensure(TAG, SOCKET);
      await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
      expect(await ensured).toBe('failed');
      expect(docker.commands()).toEqual([...allCreatedLooks, 'info']);
      expect(removals(docker)).toEqual([]);
      expect(logger.lines.some((line) => line.startsWith('info The time of the Docker host cannot be read'))).toBe(true);
      expect(logger.lines.join('\n')).toContain('its age cannot be read; it is kept.');
    });
  }

  for (const [what, created] of [
    ['no creation time', undefined],
    ['Docker\'s zero time', '0001-01-01T00:00:00Z'],
    ['a creation time that is not one', 'soon'],
    ['a creation time that is a number', 1_727_690_400],
  ] as const) {
    it(`A-R4-1: a created container with ${what} is kept without asking the daemon's clock`, async () => {
      vi.useFakeTimers();
      const docker = new FakeDocker((args) =>
        args[0] === 'container' ? inspected('created', LABEL, 0, 0, MONITOR_ID, created) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS * 100) : result(0),
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
      const docker = new FakeDocker((args) => (args[0] === 'container' ? createdIn('old-label') : args[0] === 'info' ? systemTime(age) : result(0)));
      const ensured = monitor(docker).ensure(TAG, SOCKET);
      await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
      expect(await ensured).toBe(outcome);
      expect(removals(docker).map((call) => call.args)).toEqual(outcome === 'created' ? [['rm', '-f', MONITOR_ID]] : []);
    }
  });

  it('A-R4-1: an old created container whose ID cannot be read is kept (never removed by its name)', async () => {
    vi.useFakeTimers();
    const docker = new FakeDocker((args) =>
      args[0] === 'container' ? createdIn(LABEL, null) : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS * 2) : result(0),
    );
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await ensured).toBe('failed');
    expect(removals(docker)).toEqual([]);
    expect(docker.commands()).not.toContain('run');
  });

  it('A-R4-1: a cancellation during the created-wait passes at once; the looks and docker info get the signal and a time limit', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const docker = new FakeDocker((args) => (args[0] === 'container' ? createdIn(LABEL) : result(0)));
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(300);
    expect(docker.commands()).toEqual(['inspect', 'inspect']);
    controller.abort();
    await rejected;
    expect(docker.commands()).toEqual(['inspect', 'inspect']);
    expect(docker.calls.every((call) => call.options?.signal === controller.signal)).toBe(true);
    // docker info with the signal and the time limit.
    const timed = new FakeDocker((args) => (args[0] === 'container' ? createdIn(LABEL) : args[0] === 'info' ? systemTime(1_000) : result(0)));
    const signal = new AbortController().signal;
    const again = monitor(timed).ensure(TAG, SOCKET, signal);
    await vi.advanceTimersByTimeAsync(CREATED_WAIT_TOTAL);
    expect(await again).toBe('failed');
    const info = timed.calls.find((call) => call.args[0] === 'info');
    expect(info?.options?.signal).toBe(signal);
    expect(info?.options?.timeoutMs).toBe(REMOTE_MONITOR_DOCKER_TIMEOUT_MS);
  });

  it('A-R4-1: after a failed create the cleanup by the nonce waits for the killed client to end (bounded)', async () => {
    vi.useFakeTimers();
    // A client that ends 100 ms after it was killed: the list runs after its end.
    const slow = new FakeDocker(missingThenCreated, (client) => {
      client.exitOnKill = false;
    });
    const ensured = monitor(slow).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(REMOTE_MONITOR_DOCKER_TIMEOUT_MS + 100);
    expect(slow.commands()).toEqual(['inspect', 'run']);
    slow.clients[0].exit(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(await ensured).toBe('failed');
    expect(slow.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
    // A client that never ends: the list runs after REMOTE_MONITOR_CLIENT_EXIT_WAIT_MS.
    const stuck = new FakeDocker(missingThenCreated, (client) => {
      client.exitOnKill = false;
    });
    const stuckEnsured = monitor(stuck).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(REMOTE_MONITOR_DOCKER_TIMEOUT_MS + REMOTE_MONITOR_CLIENT_EXIT_WAIT_MS - 1);
    expect(stuck.commands()).toEqual(['inspect', 'run']);
    await vi.advanceTimersByTimeAsync(1);
    expect(await stuckEnsured).toBe('failed');
    expect(stuck.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
  });

  it('A-R4-1: a ready create does not wait for the end of its client', async () => {
    vi.useFakeTimers();
    const docker = new FakeDocker(missingThenCreated, (client) => {
      client.exitOnKill = false;
      STARTS(client);
    });
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(0);
    expect(await ensured).toBe('created');
  });

  // A-R4-2: the conflict is only the daemon's message at a line start, with the CLI's exit 125.
  for (const [what, stderr, exitCode] of [
    ['the loader line of the container that mentions a conflict (exit 3)', 'devenv loader: the entry failed: Conflict. The container name "/x" is already in use\n', 3],
    ['the daemon message printed by the container (exit 3)', 'Error response from daemon: Conflict. The container name "/x" is already in use\n', 3],
    ['a warning line that holds the words (exit 125)', 'warning: Conflict. The container name "/x" is already in use\n', 125],
    ['a line of the container that says "already in use" (exit 1)', 'Error: port already in use; conflict\n', 1],
    ['a line of the container that says "conflict" (exit 125)', 'devenv loader: the entry failed: merge conflict\n', 125],
    ['a line of the container that says "already in use" (exit 125)', 'Error: the port is already in use\n', 125],
    ['the daemon message with exit 1', CONFLICT, 1],
  ] as const) {
    it(`A-R4-2: ${what} is no conflict: the create's own container is removed by its nonce, nothing inspected`, async () => {
      const docker = new FakeDocker(missingThenCreated, (client) => {
        client.complain(stderr);
        client.exit(exitCode);
      });
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'rm']);
      expect(docker.calls[3].args).toEqual(['rm', '-f', CREATED_ID]);
    });
  }

  it('A-R4-2: the daemon message after another line (an SSH warning) is still a conflict', async () => {
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? result(0) : inspected(true, LABEL)), (client) => {
      client.complain('Warning: Permanently added build-box to the list of known hosts.\r\n');
      client.complain('Error response from daemon: Conflict. The container name "/devenv-session-monitor" is already in use by container "abc".\n');
      client.exit(125);
    });
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
  });

  it('A-R4-2: a conflict while a container with the nonce of this create exists is no conflict: removed by its nonce, fails', async () => {
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? result(0, `${CREATED_ID}\n`) : inspected(true, LABEL)), alwaysConflict);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'ps', 'rm']);
    expect(removals(docker).map((call) => call.args)).toEqual([['rm', '-f', CREATED_ID]]);
    const nonce = createIdOf(docker.calls[1].args);
    expect(docker.calls[2].args).toEqual(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL_MONITOR_CREATE}=${nonce}`]);
  });

  for (const [what, list] of [
    ['a list of the nonce that fails', result(1, '', 'error during connect\n')],
    ['a list of the nonce without an answer in time', TIMED_OUT],
    ['a list of the nonce that throws', new Error('spawn failed')],
  ] as const) {
    it(`A-R4-2: ${what} after a conflict fails; nothing is accepted or removed`, async () => {
      const docker = new FakeDocker(
        (args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? (list instanceof Error ? Promise.reject(list) : list) : inspected(true, LABEL)),
        alwaysConflict,
      );
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'ps']);
      expect(removals(docker)).toEqual([]);
    });
  }

  it('A-R4-2: the nonce check after a conflict gets the signal and the time limit; the cleanup gets no signal', async () => {
    const controller = new AbortController();
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? result(0) : inspected(true, 'other-label')), alwaysConflict);
    expect(await monitor(docker).ensure(TAG, SOCKET, controller.signal)).toBe('failed');
    const lists = docker.calls.filter((call) => call.args[0] === 'ps');
    expect(lists).toHaveLength(2);
    expect(lists[0].options).toEqual({ timeoutMs: REMOTE_MONITOR_DOCKER_TIMEOUT_MS, signal: controller.signal });
    expect(lists[1].options?.signal).toBeUndefined();
  });

  // A-R4-3: after a conflict, a matching running container that Docker restarted is accepted only with its stored script.
  for (const [what, answer, outcome] of [
    ['the stored script of this version', SAME, 'running'],
    ['no stored script', NO_SCRIPT, 'failed'],
    ['a check without an answer in time', TIMED_OUT, 'failed'],
  ] as const) {
    it(`A-R4-3: a conflict with a matching running container with RestartCount 2 and ${what} → ${outcome}, nothing removed`, async () => {
      const docker = new FakeDocker(
        (args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? result(0) : args[0] === 'exec' ? answer : inspected(true, LABEL, 0, 2)),
        alwaysConflict,
      );
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe(outcome);
      expect(docker.commands()).toEqual(outcome === 'running' ? ['inspect', 'run', 'ps', 'inspect', 'exec'] : ['inspect', 'run', 'ps', 'inspect', 'exec', 'ps']);
      expect(docker.calls[4].args).toEqual(SHA);
      expect(removals(docker)).toEqual([]);
    });
  }

  it('A-R4-3: a conflict with a matching paused container with RestartCount 2 is accepted without a check', async () => {
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : args[0] === 'ps' ? result(0) : inspected('paused', LABEL, 0, 2)), alwaysConflict);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', 'inspect']);
  });

  // A-R4-4: an exited container of this version is started by its ID, then its stored script is checked.
  it('A-R4-4: started by its ID with the stored script of this version → started', async () => {
    const logger = new Log();
    const controller = new AbortController();
    const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(false, LABEL, 137) : args[0] === 'exec' ? SAME : result(0)));
    expect(await monitor(docker, logger).ensure(TAG, SOCKET, controller.signal)).toBe('started');
    expect(docker.calls.map((call) => call.args)).toEqual([expect.anything(), ['start', MONITOR_ID], SHA]);
    expect(docker.calls[1].options?.signal).toBe(controller.signal);
    expect(docker.calls[2].options?.signal).toBe(controller.signal);
    expect(logger.lines).toEqual(['info The Session Monitor on the Docker host was started again (devenv-session-monitor).']);
  });

  for (const [what, answer] of [
    ['no stored script', NO_SCRIPT],
    ['a container that exits 3 again at once (restarting)', result(1, '', `Error response from daemon: Container ${MONITOR_ID} is restarting, wait until the container is running\n`)],
    ['another stored script', result(0, `${bundleHash(`${SCRIPT}x`)}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`)],
  ] as const) {
    it(`A-R4-4: started, then ${what} → removed by that ID and created`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(false, LABEL, 0) : args[0] === 'exec' ? answer : result(0)));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
      expect(docker.commands()).toEqual(['inspect', 'start', 'exec', 'rm', 'run']);
      expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
      expect(docker.calls[3].args).toEqual(['rm', '-f', MONITOR_ID]);
      expect(logger.lines).toContain('info The Session Monitor on the Docker host was started again without its script; it is replaced (devenv-session-monitor).');
    });
  }

  for (const [what, answer] of [
    ['a check without an answer in time', TIMED_OUT],
    ['an SSH failure', result(255, '', 'ssh: connect to host build-box port 22: Connection refused\n')],
  ] as const) {
    it(`A-R4-4: started, then ${what} → kept (started, logged), nothing removed`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(false, LABEL, 0) : args[0] === 'exec' ? answer : result(0)));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('started');
      expect(docker.commands()).toEqual(['inspect', 'start', 'exec']);
      expect(logger.lines).toEqual([
        'info The Session Monitor on the Docker host was started again and its stored script could not be checked; it is kept (devenv-session-monitor).',
      ]);
    });
  }

  it('A-R4-4: a failed start fails, nothing removed', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(false, LABEL, 0) : args[0] === 'start' ? result(1, '', 'Error response from daemon: permission denied\n') : result(0)));
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
      const docker = new FakeDocker((args) => (args[0] === 'container' ? answer : args[0] === 'exec' ? NO_SCRIPT : result(0)));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(commands);
      expect(docker.calls.some((call) => call.args.includes('devenv-session-monitor') && call.args[0] !== 'container' && call.args[0] !== 'exec')).toBe(false);
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
  const restartedWith = (answer: RunResult) =>
    new FakeDocker((args) => (args[0] === 'container' ? inspected(true, LABEL, 0, 1) : args[0] === 'exec' ? answer : result(0)));
  const conflict = (client: FakeClient) => {
    client.complain(CONFLICT);
    client.exit(125);
  };

  // B-R4-1: the tolerance of a missing container or a removal in progress is for `rm` only (T-notRmOnly survived): a
  // `docker start` that fails so must not report `started` while nothing runs.
  for (const [what, answer] of [
    ['a missing container', MISSING],
    ['a removal in progress', result(1, '', `Error response from daemon: removal of container ${MONITOR_ID} is already in progress\n`)],
  ] as const) {
    it(`B-R4-1: a docker start that finds ${what} fails`, async () => {
      const logger = new Log();
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(false, LABEL, 0) : args[0] === 'start' ? answer : result(0)));
      expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
      expect(docker.commands()).toEqual(['inspect', 'start']);
      // Verifier note (PR #69 review round 4, A-R4-4): started by its ID.
      expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
      expect(logger.lines.join('\n')).toMatch(/^warn The Session Monitor on the Docker host could not be started: docker start failed/m);
    });
  }

  // B-R4-5: a failed rm without stderr is a failure too (T-exitIgnored survived).
  it('B-R4-5: an rm that fails without stderr fails, without a create', async () => {
    const logger = new Log();
    const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, 'old-label') : args[0] === 'rm' ? result(1, '', '') : result(0)));
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'rm']);
    // Verifier note (PR #69 review round 4, A-R4-5): the rm is by the ID.
    expect(docker.calls[1].args).toEqual(['rm', '-f', MONITOR_ID]);
    expect(logger.lines.join('\n')).toContain('docker rm failed: exit code 1');
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
      expect(docker.commands()).toEqual(['inspect', 'exec']);
    });

    // Verifier note (PR #69 review round 4, A-R4-4): the start path decides on the same check, so the same cases keep a
    // started container too.
    it(`B-R4-2, A-R4-4: a started container whose check fails with ${what} is kept, nothing removed`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(false, LABEL, 137) : args[0] === 'exec' ? result(1, '', stderr) : result(0)));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('started');
      expect(docker.commands()).toEqual(['inspect', 'start', 'exec']);
      expect(docker.calls[1].args).toEqual(['start', MONITOR_ID]);
    });
  }

  // B-R4-3: a cancellation between the look at the conflict and its wait passes at once (W-noPreAbort survived).
  it('B-R4-3: a cancellation during the look of the conflict passes without a wait', async () => {
    const controller = new AbortController();
    let looks = 0;
    const docker = new FakeDocker((args) => {
      if (args[0] !== 'container') return result(0);
      looks += 1;
      if (looks === 1) return MISSING;
      controller.abort();
      return inspected('created', LABEL);
    }, conflict);
    const started = Date.now();
    await expect(monitor(docker).ensure(TAG, SOCKET, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(200);
    // Verifier note (PR #69 review round 4, A-R4-2): the nonce check changes the exact calls, so the outcome is checked.
    expect(docker.commands().filter((command) => command === 'run')).toHaveLength(1);
    expect(docker.commands()).not.toContain('rm');
  });

  // B-R4-4: a look of the conflict that fails is a failure, not a free name (L-inspectCatchMissing survived).
  it('B-R4-4: a failed inspect after a conflict fails without another create', async () => {
    let looks = 0;
    const docker = new FakeDocker(
      (args) => (args[0] !== 'container' ? result(0) : (looks += 1) === 1 ? MISSING : { ...result(1, '', ''), timedOut: true }),
      conflict,
    );
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
  const systemTime = (ageMs: number) => result(0, `${JSON.stringify(new Date(CREATED_MS + ageMs).toISOString())}\n`);
  const inspects = (...answers: RunResult[]) => {
    let at = 0;
    return () => answers[Math.min(at++, answers.length - 1)];
  };
  const sum = (waits: readonly number[]) => waits.reduce((total, ms) => total + ms, 0);
  const removals = (docker: FakeDocker) => docker.calls.filter((call) => call.args[0] === 'rm' || call.args[0] === 'start');
  const alwaysConflict = (client: FakeClient) => {
    client.complain(CONFLICT);
    client.exit(125);
  };
  /** The inspects after a conflict: `created` until `untilMs` of fake time have passed, then `after`. */
  const createdUntil = (untilMs: number, after: RunResult) => {
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)), alwaysConflict);
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)), alwaysConflict);
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

  it('A-R5-1: a container that stays removing still gets the short waits only (3.75 s), nothing removed', async () => {
    vi.useFakeTimers();
    const next = inspects(MISSING, inspected('removing', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)), alwaysConflict);
    let settled = false;
    const ensured = monitor(docker)
      .ensure(TAG, SOCKET)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CONFLICT_WAITS_MS) - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ensured).toBe('failed');
    expect(docker.commands()).toEqual(['inspect', 'run', 'ps', ...REMOTE_MONITOR_CONFLICT_WAITS_MS.map(() => 'inspect'), 'inspect', 'ps']);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R5-1: one counter for both lists: a status that changes between created and removing ends after the longer list at most', async () => {
    vi.useFakeTimers();
    // removing, created, removing, created, …: never more looks than the longer list has waits, plus the first.
    let at = 0;
    const next = () => (at++ === 0 ? MISSING : at % 2 === 0 ? inspected('removing', LABEL) : inspected('created', LABEL));
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)), alwaysConflict);
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS * 10) : result(0)), alwaysConflict);
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)), alwaysConflict);
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : args[0] === 'info' ? systemTime(now) : result(0)));
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : args[0] === 'info' ? systemTime(1_000) : result(0)));
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
    const docker = new FakeDocker((args) => (args[0] === 'container' ? next() : result(0)));
    const ensured = monitor(docker).ensure(TAG, SOCKET, controller.signal);
    const rejected = expect(ensured).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(sum(REMOTE_MONITOR_CREATED_WAITS_MS) - 1_000);
    const before = docker.commands();
    expect(before.length).toBeGreaterThan(2);
    controller.abort();
    await rejected;
    expect(docker.commands()).toEqual(before);
    expect(docker.calls.every((call) => call.options?.signal === controller.signal)).toBe(true);
    expect(removals(docker)).toEqual([]);
  });

  it('A-R5-2: a second ID that is old and stays created after its own wait is removed by that ID, never by the name', async () => {
    vi.useFakeTimers();
    const next = inspects(createdIn(LABEL), createdIn(LABEL, OTHER_ID));
    const docker = new FakeDocker((args) =>
      args[0] === 'container' ? next() : args[0] === 'info' ? systemTime(REMOTE_MONITOR_STALE_CREATED_MS + 1) : args[0] === 'ps' ? result(0, `${CREATED_ID}\n`) : result(0),
    );
    const ensured = monitor(docker).ensure(TAG, SOCKET);
    await vi.advanceTimersByTimeAsync(2 * sum(REMOTE_MONITOR_CREATED_WAITS_MS));
    expect(await ensured).toBe('created');
    expect(docker.calls.filter((call) => call.args[0] === 'rm').map((call) => call.args)).toEqual([['rm', '-f', OTHER_ID]]);
  });
});
