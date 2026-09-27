// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { abortError, type Logger, type RunOptions, type RunResult } from '../ports';
import { LABEL_SESSION_MONITOR, MAX_SCRIPT_LENGTH, REMOTE_MONITOR_SCRIPT_PATH, remoteMonitorLabelValue } from './protocol';
import { REMOTE_MONITOR_BOOTSTRAP, RemoteSessionMonitor, isMissingContainer } from './remoteSessionMonitor';

const SCRIPT = 'console.log("monitor")';
const TAG = 'devenv-helper:0123456789ab';
const SOCKET = '/var/run/docker.sock';
const LABEL = remoteMonitorLabelValue(SCRIPT, TAG);
const SOURCE = '0123456789abcdef0123456789abcdef';
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

const result = (exitCode: number, stdout = '', stderr = ''): RunResult => ({ exitCode, stdout, stderr, timedOut: false });
const inspected = (running: boolean, label: string | undefined): RunResult =>
  result(0, `${running}\t${JSON.stringify(label === undefined ? {} : { [LABEL_SESSION_MONITOR]: label, other: 'x' })}\n`);
const MISSING = result(1, '', 'Error response from daemon: No such container: devenv-session-monitor');

class FakeDocker {
  readonly calls: Array<{ args: string[]; options?: RunOptions }> = [];
  constructor(private readonly answer: (args: readonly string[], index: number) => RunResult | Promise<RunResult>) {}

  async run(args: readonly string[], options?: RunOptions): Promise<RunResult> {
    this.calls.push({ args: [...args], options });
    return this.answer(args, this.calls.length - 1);
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
    expect(docker.calls[0].args).toEqual(['container', 'inspect', '--format', '{{json .State.Running}}\t{{json .Config.Labels}}', 'devenv-session-monitor']);
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
    expect(args).toEqual([
      'run',
      '-d',
      '--name',
      'devenv-session-monitor',
      '--label',
      `${LABEL_SESSION_MONITOR}=${LABEL}`,
      '--restart',
      'unless-stopped',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '-v',
      '/run/user/1000/docker.sock:/var/run/docker.sock',
      '-v',
      'devenv-session-monitor:/state',
      TAG,
      'sh',
      '-c',
      REMOTE_MONITOR_BOOTSTRAP,
      'sh',
      SCRIPT,
    ]);
    // No published port, no environment variable of this computer, never DOCKER_HOST.
    const options = args.slice(0, args.indexOf(TAG));
    expect(options.filter((arg) => /^(-p|--publish|-e|--env|--privileged)$/.test(arg) || arg.includes('DOCKER_HOST'))).toEqual([]);
    expect(REMOTE_MONITOR_BOOTSTRAP).toContain(`exec node ${REMOTE_MONITOR_SCRIPT_PATH} run`);
    expect(docker.calls[1].options?.env).toBeUndefined();
  });

  it('accepts the container that another window created at the same time', async () => {
    const docker = new FakeDocker((args, index) => {
      if (args[0] === 'container') return index === 0 ? MISSING : inspected(true, LABEL);
      return result(125, '', 'docker: Error response from daemon: Conflict. The container name "/devenv-session-monitor" is already in use.');
    });
    expect(await monitor(docker).ensure(TAG, SOCKET)).toBe('running');
    expect(docker.commands()).toEqual(['inspect', 'run', 'inspect']);
  });

  it('fails (logged, no throw) when the other window created another version', async () => {
    const logger = new Log();
    const docker = new FakeDocker((args, index) => {
      if (args[0] === 'container') return index === 0 ? MISSING : inspected(true, 'bbbbbbbbbbbb');
      return result(125, '', 'Conflict. The container name is already in use.');
    });
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    expect(logger.lines.join('\n')).toMatch(/warn The Session Monitor on the Docker host could not be started: .*only while this computer is online/);
  });

  it('fails (logged) when Docker does not answer, and does not create anything', async () => {
    const logger = new Log();
    const docker = new FakeDocker(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) as unknown as RunResult);
    expect(await monitor(docker, logger).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.commands()).toEqual(['inspect']);
    expect(logger.lines.some((line) => line.startsWith('warn'))).toBe(true);
  });

  it('refuses a script that is too long for the command line', async () => {
    const docker = new FakeDocker(() => MISSING);
    expect(await monitor(docker, new Log(), 'x'.repeat(MAX_SCRIPT_LENGTH + 1)).ensure(TAG, SOCKET)).toBe('failed');
    expect(docker.calls).toEqual([]);
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

describe('RemoteSessionMonitor: heartbeat, records, forget', () => {
  it('sends a heartbeat with docker exec and a time limit', async () => {
    const docker = new FakeDocker(() => result(0));
    const heartbeat = { source: SOURCE, limitSeconds: 600, environments: [{ id: ID, keepRunning: true, seq: 1 }] };
    expect(await monitor(docker).heartbeat(heartbeat)).toEqual({ ok: true, stdout: '' });
    expect(docker.calls[0].args).toEqual(['exec', 'devenv-session-monitor', 'node', REMOTE_MONITOR_SCRIPT_PATH, 'heartbeat', JSON.stringify(heartbeat)]);
    expect(docker.calls[0].options?.timeoutMs).toBe(20_000);
  });

  it('tells a missing container from another failure', async () => {
    const heartbeat = { source: SOURCE, limitSeconds: 600, environments: [] };
    expect(await monitor(new FakeDocker(() => MISSING)).heartbeat(heartbeat)).toMatchObject({ ok: false, missing: true });
    const stopped = result(1, '', 'Error response from daemon: container 1234 is not running');
    expect(await monitor(new FakeDocker(() => stopped)).heartbeat(heartbeat)).toMatchObject({ ok: false, missing: true });
    const invalid = result(2, '', 'Invalid heartbeat.');
    expect(await monitor(new FakeDocker(() => invalid)).heartbeat(heartbeat)).toEqual({ ok: false, missing: false, detail: 'Invalid heartbeat.' });
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
    expect(docker.calls[0].args).toEqual(['exec', 'devenv-session-monitor', 'node', REMOTE_MONITOR_SCRIPT_PATH, 'forget', SOURCE, ID]);
    await monitor(new FakeDocker(() => MISSING), logger).forget(SOURCE, ID);
    expect(logger.lines).toEqual([]);
    await monitor(new FakeDocker(() => result(1, '', 'boom')), logger).forget(SOURCE, ID);
    expect(logger.lines).toEqual([`warn The heartbeat record of ${ID} could not be removed from the Session Monitor: boom`]);
  });

  it('isMissingContainer', () => {
    expect(isMissingContainer(MISSING)).toBe(true);
    expect(isMissingContainer(result(1, '', 'Error: No such object: devenv-session-monitor'))).toBe(true);
    expect(isMissingContainer(result(1, '', 'permission denied'))).toBe(false);
    expect(isMissingContainer({ ...MISSING, timedOut: true })).toBe(false);
  });
});
