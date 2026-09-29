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
import { REMOTE_MONITOR_DOCKER_TIMEOUT_MS, REMOTE_MONITOR_LOG_OPTIONS, RemoteSessionMonitor, isMissingContainer } from './remoteSessionMonitor';

const SCRIPT = 'console.log("monitor")';
const TAG = 'devenv-helper:0123456789ab';
const SOCKET = '/var/run/docker.sock';
const LABEL = remoteMonitorLabelValue(SCRIPT, TAG);
const SOURCE = '0123456789abcdef0123456789abcdef';
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

const result = (exitCode: number, stdout = '', stderr = ''): RunResult => ({ exitCode, stdout, stderr, timedOut: false });
/**
 * The answer of `docker container inspect`: `{{json .State.Status}}\t{{json .State.ExitCode}}\t{{json .Config.Labels}}`
 * `\t{{json .RestartCount}}` (review round 1 of PR #69, A-R1-1: the restart count added, 0 by default).
 * `state`: true is `running`, false is `exited` (with `exitCode`), a string is that status.
 */
const inspected = (state: boolean | string, label: string | undefined, exitCode = 0, restartCount = 0): RunResult => {
  const status = state === true ? 'running' : state === false ? 'exited' : state;
  const labels = JSON.stringify(label === undefined ? {} : { [LABEL_SESSION_MONITOR]: label, other: 'x' });
  return result(0, `${JSON.stringify(status)}\t${exitCode}\t${labels}\t${restartCount}\n`);
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
const CONFLICT = 'docker: Error response from daemon: Conflict. The container name "/devenv-session-monitor" is already in use.\n';

/** The attached `docker run` of the monitor (RemoteMonitorDocker.start). */
class FakeClient implements StartedProcess {
  readonly written: string[] = [];
  ended = false;
  killed = false;
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
    this.exit(null);
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
    expect(docker.calls[0].args).toEqual([
      'container',
      'inspect',
      '--format',
      '{{json .State.Status}}\t{{json .State.ExitCode}}\t{{json .Config.Labels}}\t{{json .RestartCount}}',
      'devenv-session-monitor',
    ]);
  });

  it('starts the container of this version when it is stopped', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(false, LABEL) : result(0)));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('started');
    expect(docker.calls.map((call) => call.args)).toEqual([expect.anything(), ['start', 'devenv-session-monitor']]);
  });

  it('replaces a container of another version (another script or helper image)', async () => {
    const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, 'aaaaaaaaaaaa') : result(0, 'id\n')));
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('created');
    expect(docker.commands()).toEqual(['inspect', 'rm', 'run']);
    expect(docker.calls[1].args).toEqual(['rm', '-f', 'devenv-session-monitor']);
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
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : inspected(true, LABEL)), conflict);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'run', 'inspect']);
  });

  it('fails (logged, no throw) when the other window created another version', async () => {
    const logger = new Log();
    // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: `docker run -d` answered 125).
    const conflict = (client: FakeClient) => {
      client.complain('Conflict. The container name is already in use.');
      client.exit(125);
    };
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : inspected(true, 'bbbbbbbbbbbb')), conflict);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    expect(logger.lines.join('\n')).toMatch(/warn The Session Monitor on the Docker host could not be started: .*only while this computer is online/);
    // Plan step 3: the container of the other window is not removed.
    expect(docker.commands()).toEqual(['inspect', 'run', 'inspect']);
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
    ['exited', 0, 'started', ['inspect', 'start']],
    ['exited', 137, 'started', ['inspect', 'start']],
    ['exited', 1, 'started', ['inspect', 'start']],
    // The loader refused (exit 3), or the container never ran as it should: replaced.
    ['exited', 3, 'created', ['inspect', 'rm', 'run']],
    ['created', 0, 'created', ['inspect', 'rm', 'run']],
    ['restarting', 3, 'created', ['inspect', 'rm', 'run']],
    ['dead', 0, 'created', ['inspect', 'rm', 'run']],
  ] as const) {
    it(`the container of this version, ${state} with exit code ${exitCode} → ${outcome}`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(state, LABEL, exitCode) : result(0)));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe(outcome);
      expect(docker.commands()).toEqual(commands);
      if (outcome === 'started') expect(docker.calls[1].args).toEqual(['start', 'devenv-session-monitor']);
      if (outcome === 'created') expect(docker.calls[1].args).toEqual(['rm', '-f', 'devenv-session-monitor']);
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

  for (const state of ['running', 'paused'] as const) {
    for (const [what, answer] of [
      ['no stored script', result(1, '', `sha256sum: ${REMOTE_MONITOR_SCRIPT_PATH}: No such file or directory\n`)],
      ['another stored script', sha256sumOutput(bundleHash(`${SCRIPT}// changed`))],
      ['no answer in time', { exitCode: null, stdout: '', stderr: '', timedOut: true } as unknown as RunResult],
      ['a failed call', new Error('Docker Desktop is not installed.')],
      ['an empty answer', result(0, '')],
      ['a failed call that printed the hash', result(1, `${bundleHash(SCRIPT)}  ${REMOTE_MONITOR_SCRIPT_PATH}\n`, 'error')],
    ] as const) {
      it(`A-R1-1: ${state} with RestartCount 1 and ${what} → replaced`, async () => {
        const logger = new Log();
        const docker = new FakeDocker((args) => {
          if (args[0] === 'container') return inspected(state, LABEL, 3, 1);
          if (args[0] === 'exec') return answer instanceof Error ? Promise.reject(answer) : answer;
          return result(0);
        });
        expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('created');
        expect(docker.commands()).toEqual(['inspect', 'exec', 'rm', 'run']);
        expect(docker.calls[1].args).toEqual(SHA256SUM);
        expect(docker.calls[1].options?.timeoutMs).toBe(20_000);
        expect(docker.calls[2].args).toEqual(['rm', '-f', 'devenv-session-monitor']);
        expect(logger.lines).toContain('info The Session Monitor on the Docker host was restarted without its script; it is replaced (devenv-session-monitor).');
      });
    }

    it(`A-R1-1: ${state} with RestartCount 1 and the stored script of this version → running, nothing removed`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(state, LABEL, 0, 1) : args[0] === 'exec' ? sha256sumOutput(bundleHash(SCRIPT)) : result(0)));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect', 'exec']);
      expect(docker.calls[1].args).toEqual(SHA256SUM);
    });

    it(`A-R1-1: ${state} with RestartCount 0 → running without any other call`, async () => {
      const docker = new FakeDocker((args) => (args[0] === 'container' ? inspected(state, LABEL, 0, 0) : result(1)));
      expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
      expect(docker.commands()).toEqual(['inspect']);
    });
  }

  it('A-R1-1: a larger RestartCount is checked too; one that cannot be read counts as 0', async () => {
    const restarted = new FakeDocker((args) => (args[0] === 'container' ? inspected(true, LABEL, 3, 17) : args[0] === 'exec' ? result(1) : result(0)));
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
    const twice = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0)));
    await monitor(twice).ensure(TAG, SOCKET);
    await monitor(twice).ensure(TAG, SOCKET);
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
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : inspected(false, LABEL, 3)), conflict);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('failed');
    // Not ours: not removed.
    expect(docker.commands()).toEqual(['inspect', 'run', 'inspect']);
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
    const docker = new FakeDocker((args, index) => (index === 0 ? MISSING : inspected(true, LABEL)), conflict);
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'run', 'inspect']);
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
