// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { abortError, type Logger, type RunOptions, type RunResult } from '../ports';
import {
  IMAGE_MAINTENANCE_LABEL_PART,
  LABEL_SESSION_MONITOR,
  MAX_SCRIPT_LENGTH,
  MAX_WINDOWS_COMMAND_LINE,
  REMOTE_MONITOR_SCRIPT_PATH,
  forgetCommand,
  heartbeatCommand,
  remoteMonitorLabelValue,
  windowsCommandLineLength,
} from './protocol';
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

  it('runs the helper image of the open by its checked image ID, with the label and the log line of its tag (review round 1 of PR #64, S1)', async () => {
    const imageId = `sha256:${'7'.repeat(64)}`;
    const docker = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0, 'id\n')));
    const logger = new Log();
    expect(await monitor(docker, logger).ensure(TAG, SOCKET, undefined, imageId)).toBe('created');
    const byId = docker.calls[1].args;
    const byTag = new FakeDocker((args) => (args[0] === 'container' ? MISSING : result(0, 'id\n')));
    await monitor(byTag).ensure(TAG, SOCKET);
    // The same arguments as with the tag, the label included; only the image reference differs.
    expect(byId).toEqual(byTag.calls[1].args.map((arg) => (arg === TAG ? imageId : arg)));
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
    expect(args).toEqual([
      'run',
      '-d',
      // Changed expectation (review round 4 of PR #64, R4-8): never a pull, like the helper runs.
      '--pull',
      'never',
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

  // PR #57: the whole command line counts (Windows escapes the quotes), before an old monitor is removed.
  it('refuses a command line that is too long for Windows, also for a shorter script of quotes', async () => {
    const docker = new FakeDocker(() => MISSING);
    expect(await monitor(docker, new Log(), '"'.repeat(17_000)).ensure(TAG, SOCKET)).toBe('failed');
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

  // Review round 9 of PR #57: the prefixes on the command line are cut to what Windows takes; `settings -` brings all.
  it('puts only as many prefixes on the command line as fit', () => {
    const many = Array.from({ length: 50 }, (_, index) => `ghcr.io/${String(index).padStart(2, '0')}${'a'.repeat(76)}`);
    const plain = monitor(new FakeDocker(() => result(0)));
    const script = 'x'.repeat(28_000);
    const args = plain.runArgs(TAG, SOCKET, LABEL, script, { ...IMAGES, prefixes: many });
    expect(windowsCommandLineLength(['docker', ...args])).toBeLessThanOrEqual(MAX_WINDOWS_COMMAND_LINE);
    const env = args.find((arg) => arg.startsWith('DEVENV_IMAGE_PREFIXES='))!;
    const sent = JSON.parse(env.slice('DEVENV_IMAGE_PREFIXES='.length)) as string[];
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(50);
    expect(sent).toEqual(many.slice(0, sent.length));
    // All of them when they fit.
    expect(plain.runArgs(TAG, SOCKET, LABEL, SCRIPT, { ...IMAGES, prefixes: many })).toContain(`DEVENV_IMAGE_PREFIXES=${JSON.stringify(many)}`);
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
