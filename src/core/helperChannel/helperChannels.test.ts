// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockerTargetOf, remoteContextName, LOCAL_DOCKER_TARGET, type DockerTarget } from '../docker/dockerHost';
import { operationDockerTarget } from '../docker/dockerTargets';
import { abortError, silentLogger, type Logger, type StartedProcess } from '../ports';
import { UserFacingError } from '../errors';
import { EnvironmentLockError } from '../docker/environmentLock';
import { HelperChannel, HelperChannelError, HelperOperationError } from './helperChannel';
import {
  CHANNEL_OPEN_WAIT_MS,
  CHANNEL_PROBE_TIMEOUT_MS,
  CHANNEL_REFRESH_TIMEOUT_MS,
  CHANNEL_RETRY_AFTER_FAILURE_MS,
  HelperChannels,
  channelRunArgs,
  openHelperChannel,
} from './helperChannels';
import { PIPE_LOADER, bundleHash } from '../loader/pipeLoader';
import { CHANNEL_IDLE_CLOSE_MS, CHANNEL_PROTOCOL_VERSION, LABEL_HELPER_CHANNEL, LOCK_BUSY_CODE, MAX_REFRESH_ENVIRONMENTS, encodeMessage, parseClientMessage, refreshValue } from './protocol';
import { EXPECTED_STATES, REFRESH_ENVIRONMENTS } from '../pipeline/refreshStates.testkit';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextName('build-box'));
/** Plan step 5, PR A: the engine identity (ENGINE_IDENTITY_ARGS) of the engine of the tests. */
const ENGINE = '"7b1c7a44-2f0e-4d38-9d1d-3a8f7b0e8c11" "/var/lib/docker"';
const directEngine = async () => ({ exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false });

/** A channel stand-in with the parts that HelperChannels uses. */
function fakeChannel() {
  const closeListeners: ((reason: string) => void)[] = [];
  const channel = {
    isOpen: true,
    busy: 0,
    lastUsed: Date.now(),
    closed: 0,
    onClose: (listener: (reason: string) => void) => {
      closeListeners.push(listener);
      return () => {};
    },
    close: () => {
      channel.isOpen = false;
      channel.closed++;
      for (const listener of closeListeners) listener('closed');
    },
    // Review round 4 (M3): dispose closes at once.
    closeNow: () => channel.close(),
    lose: () => {
      channel.isOpen = false;
      for (const listener of closeListeners) listener('lost');
    },
    docker: vi.fn(async () => ({ exitCode: 0, stdout: 'out', stderr: '', timedOut: false })),
  };
  return channel;
}

function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = { ...silentLogger, info: (text) => lines.push(text), warn: (text) => lines.push(text) };
  return { logger, lines };
}

describe('HelperChannels (user request 2026-09-28: the helper channel)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Plan step 5, PR A: changed expectation (before: no channel for the local Docker). The worker is used for the local
  // Docker too (user decision 2026-09-29), never for an unsupported endpoint.
  it('opens a channel for the local Docker, none for an unsupported endpoint', async () => {
    const channel = fakeChannel();
    const open = vi.fn(async () => channel as unknown as HelperChannel);
    const channels = new HelperChannels({ open, logger: silentLogger });
    expect(await channels.get(LOCAL_DOCKER_TARGET)).toBe(channel);
    expect(await channels.docker(LOCAL_DOCKER_TARGET, ['ps'])).toEqual({ exitCode: 0, stdout: 'out', stderr: '', timedOut: false });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(LOCAL_DOCKER_TARGET);
    const unsupported = dockerTargetOf('tcp://build-box:2375', 'tcp-box');
    expect(unsupported.kind).toBe('unsupported');
    expect(await channels.get(unsupported)).toBeUndefined();
    // Plan step 5, PR D (rule D1 of 2026-09-30): changed expectation (before: undefined, the call ran directly): refused.
    await expect(channels.docker(unsupported, ['ps'])).rejects.toMatchObject({ code: 'unavailable', message: 'the Docker endpoint is neither local nor SSH' });
    expect(open).toHaveBeenCalledTimes(1);
    channels.dispose();
  });

  // Plan step 5, PR A: the Docker engine began to answer, or the helper image was built.
  it('clearFailures ends the wait after a failed open', async () => {
    const channel = fakeChannel();
    const open = vi.fn().mockRejectedValueOnce(new HelperChannelError('open', 'no image.')).mockResolvedValueOnce(channel);
    const channels = new HelperChannels({ open, logger: silentLogger });
    expect(await channels.get(REMOTE)).toBeUndefined();
    expect(await channels.get(REMOTE)).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(1);
    channels.clearFailures();
    expect(await channels.get(REMOTE)).toBe(channel);
    expect(open).toHaveBeenCalledTimes(2);
    channels.dispose();
  });

  it('opens one channel per host at its first use, shared by callers at the same time', async () => {
    const channel = fakeChannel();
    const open = vi.fn(async () => channel as unknown as HelperChannel);
    const channels = new HelperChannels({ open, logger: silentLogger });
    const [a, b] = await Promise.all([channels.get(REMOTE), channels.get(REMOTE)]);
    expect(a).toBe(channel);
    expect(b).toBe(channel);
    expect(await channels.get(REMOTE)).toBe(channel);
    expect(open).toHaveBeenCalledTimes(1);
    const other = dockerTargetOf('ssh://other-box', remoteContextName('other-box'));
    await channels.get(other);
    expect(open).toHaveBeenCalledTimes(2);
    channels.dispose();
  });

  // Review round 5 (F1): a context of the user pointed to another host under the same name.
  it('opens a channel of its own for the same context with another endpoint; the old one gets no new call', async () => {
    const first = fakeChannel();
    const second = fakeChannel();
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const channels = new HelperChannels({ open, logger: silentLogger });
    const before = dockerTargetOf('ssh://host-a', 'prod');
    const after = dockerTargetOf('ssh://host-b', 'prod');
    expect(await channels.get(before)).toBe(first);
    expect(await channels.get(after)).toBe(second);
    expect(open).toHaveBeenLastCalledWith(after);
    expect(await channels.get(after)).toBe(second);
    expect(open).toHaveBeenCalledTimes(2);
    channels.dispose();
  });

  it('opens it again after it was lost', async () => {
    const first = fakeChannel();
    const second = fakeChannel();
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const channels = new HelperChannels({ open, logger: silentLogger });
    expect(await channels.get(REMOTE)).toBe(first);
    first.lose();
    expect(await channels.get(REMOTE)).toBe(second);
    channels.dispose();
  });

  // Plan step 5, PR D (rule D1 of 2026-09-30): changed expectation (before: the call was undefined and ran directly,
  // and the log said so): the call is refused with the cause of the failed open, and the log says that the calls are
  // refused. The wait of `get` after the failure stays.
  it('after a failure: the call is refused with the cause, and the next attempt of get waits CHANNEL_RETRY_AFTER_FAILURE_MS', async () => {
    const channel = fakeChannel();
    const open = vi
      .fn()
      .mockRejectedValueOnce(new HelperChannelError('open', 'The helper channel to build-box could not be opened: no image.'))
      .mockResolvedValueOnce(channel);
    const { logger, lines } = recordingLogger();
    const channels = new HelperChannels({ open, logger });
    await expect(channels.docker(REMOTE, ['ps'])).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The helper channel to build-box could not be opened: no image.',
    });
    expect(lines).toEqual([
      'The helper channel to build-box could not be opened: no image. The Docker calls of operations on build-box are refused until it is open.',
    ]);
    await vi.advanceTimersByTimeAsync(CHANNEL_RETRY_AFTER_FAILURE_MS - 1_000);
    expect(await channels.get(REMOTE)).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await channels.get(REMOTE)).toBe(channel);
    channels.dispose();
  });

  // Plan step 5, PR D (rule D1 of 2026-09-30): changed expectation (before: undefined for a call that was not sent, which
  // then ran directly): a call that was not sent because the channel closed is sent once more through a channel made
  // ready again (it did not run); closed twice, or beyond what the channel carries, it rejects.
  it('docker: sends once more when the channel closed before the call was sent; not sent twice, unsendable, or lost while it ran rejects', async () => {
    const channel = fakeChannel();
    const channels = new HelperChannels({ open: async () => channel as unknown as HelperChannel, logger: silentLogger });
    expect(await channels.docker(REMOTE, ['ps'])).toEqual({ exitCode: 0, stdout: 'out', stderr: '', timedOut: false });
    channel.docker.mockRejectedValueOnce(new HelperChannelError('closed', 'closed'));
    expect(await channels.docker(REMOTE, ['ps'])).toEqual({ exitCode: 0, stdout: 'out', stderr: '', timedOut: false });
    expect(channel.docker).toHaveBeenCalledTimes(3);
    channel.docker.mockRejectedValueOnce(new HelperChannelError('closed', 'closed')).mockRejectedValueOnce(new HelperChannelError('closed', 'closed again'));
    await expect(channels.docker(REMOTE, ['ps'])).rejects.toMatchObject({ code: 'closed', message: 'closed again' });
    // Review round 1 (P2): a call beyond what the channel carries is not sent either.
    channel.docker.mockRejectedValueOnce(new HelperChannelError('unsendable', 'too long'));
    await expect(channels.docker(REMOTE, ['ps'])).rejects.toMatchObject({ code: 'unsendable' });
    channel.docker.mockRejectedValueOnce(new HelperChannelError('lost', 'lost'));
    await expect(channels.docker(REMOTE, ['ps'])).rejects.toMatchObject({ code: 'lost' });
    channels.dispose();
  });

  // Plan step 5, PR D (rule D1 of 2026-09-30): changed expectation (before: a call waited at most CHANNEL_OPEN_WAIT_MS or
  // its time limit, then took the way without the channel): a call awaits the open in full, as the lock does; its signal
  // still ends its wait (review round 2, A4), not the opening.
  it('a call awaits an opening channel in full, also beyond CHANNEL_OPEN_WAIT_MS and its time limit; its signal ends the wait (review round 2, A4)', async () => {
    const channel = fakeChannel();
    let finishOpen!: (channel: HelperChannel) => void;
    const open = vi.fn(() => new Promise<HelperChannel>((resolve) => (finishOpen = resolve)));
    const channels = new HelperChannels({ open, logger: silentLogger });
    let firstDone = false;
    const first = channels.docker(REMOTE, ['ps'], { timeoutMs: 1_000 }).finally(() => (firstDone = true));
    const second = channels.docker(REMOTE, ['ps']);
    await vi.advanceTimersByTimeAsync(CHANNEL_OPEN_WAIT_MS + 1_000);
    expect(firstDone).toBe(false);
    const controller = new AbortController();
    const third = channels.docker(REMOTE, ['ps'], { signal: controller.signal });
    controller.abort();
    await expect(third).rejects.toMatchObject({ name: 'AbortError' });
    // The opening went on: the waiting calls use the channel.
    finishOpen(channel as unknown as HelperChannel);
    expect(await first).toMatchObject({ exitCode: 0 });
    expect(await second).toMatchObject({ exitCode: 0 });
    expect(open).toHaveBeenCalledTimes(1);
    channels.dispose();
  });

  // Review round 6 (R6-2): the wait for the channel, the wait for a place and the time limit added up. Plan step 5, PR D
  // (rule D1 of 2026-09-30): changed expectation (before: timeoutMs 7_000, slotWaitMs 2_000): the open is awaited in full
  // like a state repair, so it is not taken from the time limit; the wait for a place stays at most CHANNEL_OPEN_WAIT_MS
  // or the time limit (HelperChannel.operation takes it from the time limit that it sends).
  it('awaits the open apart from the time limit, and waits for a place at most CHANNEL_OPEN_WAIT_MS or the time limit', async () => {
    const channel = fakeChannel();
    let finishOpen!: (channel: HelperChannel) => void;
    const channels = new HelperChannels({ open: () => new Promise<HelperChannel>((resolve) => (finishOpen = resolve)), logger: silentLogger });
    const call = channels.docker(REMOTE, ['ps'], { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    finishOpen(channel as unknown as HelperChannel);
    expect(await call).toMatchObject({ exitCode: 0 });
    expect(channel.docker).toHaveBeenCalledWith(['ps'], expect.objectContaining({ timeoutMs: 10_000, slotWaitMs: CHANNEL_OPEN_WAIT_MS }));
    expect(await channels.docker(REMOTE, ['ps'], { timeoutMs: 2_000 })).toMatchObject({ exitCode: 0 });
    expect(channel.docker).toHaveBeenLastCalledWith(['ps'], expect.objectContaining({ timeoutMs: 2_000, slotWaitMs: 2_000 }));
    channels.dispose();
  });

  // Plan step 5, PR D (rule D1 of 2026-09-30): the state is made consistent before a call: the helper image, then the
  // open in full, also within the wait after a failed open.
  it('docker: without an open worker, prepares the helper image and opens it in full, also within the wait after a failed open', async () => {
    const channel = fakeChannel();
    const open = vi.fn().mockRejectedValueOnce(new HelperChannelError('open', 'no image.')).mockResolvedValueOnce(channel);
    const prepare = vi.fn(async () => {});
    const channels = new HelperChannels({ open, prepare, logger: silentLogger });
    expect(await channels.get(REMOTE)).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    expect(await channels.docker(REMOTE, ['ps'], { signal })).toMatchObject({ exitCode: 0 });
    expect(prepare).toHaveBeenCalledWith(REMOTE, signal);
    expect(open).toHaveBeenCalledTimes(2);
    // With an open worker, nothing is prepared again.
    expect(await channels.docker(REMOTE, ['ps'])).toMatchObject({ exitCode: 0 });
    expect(prepare).toHaveBeenCalledTimes(1);
    channels.dispose();
  });

  it('docker: a helper image that cannot be prepared refuses the call with the cause, and opens nothing', async () => {
    const open = vi.fn(async () => fakeChannel() as unknown as HelperChannel);
    const prepare = vi.fn(async () => {
      throw new UserFacingError('helperFailed', 'The workspace helper could not be prepared.', 'no space left on device');
    });
    const { logger, lines } = recordingLogger();
    const channels = new HelperChannels({ open, prepare, logger });
    await expect(channels.docker(REMOTE, ['stop', 'c'])).rejects.toMatchObject({
      name: 'HelperChannelError',
      code: 'unavailable',
      message: 'the helper image could not be prepared: The workspace helper could not be prepared. no space left on device',
    });
    expect(open).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('The helper image for the worker on build-box could not be prepared');
    // An abort of the preparation is an abort, not a refusal.
    prepare.mockImplementationOnce(async () => {
      throw abortError();
    });
    await expect(channels.docker(REMOTE, ['ps'])).rejects.toMatchObject({ name: 'AbortError' });
    channels.dispose();
    // After dispose: refused, nothing prepared.
    prepare.mockClear();
    await expect(channels.docker(REMOTE, ['ps'])).rejects.toMatchObject({ code: 'unavailable', message: 'the window is closing' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('closes a channel without an operation for CHANNEL_IDLE_CLOSE_MS, not one that is busy', async () => {
    const channel = fakeChannel();
    const channels = new HelperChannels({ open: async () => channel as unknown as HelperChannel, logger: silentLogger });
    await channels.get(REMOTE);
    channel.busy = 1;
    await vi.advanceTimersByTimeAsync(CHANNEL_IDLE_CLOSE_MS + 60_000);
    expect(channel.closed).toBe(0);
    channel.busy = 0;
    channel.lastUsed = Date.now();
    await vi.advanceTimersByTimeAsync(CHANNEL_IDLE_CLOSE_MS - 60_000);
    expect(channel.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(channel.closed).toBe(1);
    channels.dispose();
  });

  it('dispose closes every channel, also one that opens meanwhile, and opens none after it', async () => {
    const open1 = fakeChannel();
    const open2 = fakeChannel();
    let finishOpen!: (channel: HelperChannel) => void;
    const open = vi
      .fn()
      .mockResolvedValueOnce(open1)
      .mockImplementationOnce(() => new Promise((resolve) => (finishOpen = resolve)));
    const channels = new HelperChannels({ open, logger: silentLogger });
    await channels.get(REMOTE);
    const pending = channels.get(dockerTargetOf('ssh://other-box', remoteContextName('other-box')));
    channels.dispose();
    expect(open1.closed).toBe(1);
    finishOpen(open2 as unknown as HelperChannel);
    expect(await pending).toBeUndefined();
    expect(open2.closed).toBe(1);
    expect(await channels.get(REMOTE)).toBeUndefined();
  });
});

describe('channelRunArgs and openHelperChannel', () => {
  it('runs the helper image with --rm -i, never a pull, no network, no capability, only the socket, and the loader', () => {
    const hash = bundleHash('SCRIPT');
    // Plan step 5, PR B: changed call: the state volume with the lock files is mounted too.
    const args = channelRunArgs({ tag: 'devenv-helper:abc', socketPath: '/run/user/1000/docker.sock', stateVolume: 'devenv-session-monitor', containerName: 'devenv-channel-1', label: '1-x', scriptHash: hash });
    expect(args).toEqual([
      'run', '--rm', '-i', '--pull', 'never', '--name', 'devenv-channel-1',
      '--label', 'nimblescape.devenv.helper-run=true',
      '--label', `${LABEL_HELPER_CHANNEL}=1-x`,
      // Review round 2 (B3): no log of the channel on the host.
      '--network', 'none', '--log-driver', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', 'type=bind,source=/run/user/1000/docker.sock,target=/var/run/docker.sock',
      // Plan step 5, PR B: changed expectation: the volume of the Session Monitor at /state, for the lock files.
      '--mount', 'type=volume,source=devenv-session-monitor,target=/state',
      // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: 'node', '-e', CHANNEL_LOADER).
      'devenv-helper:abc', 'node', '-e', PIPE_LOADER, '/opt/devenv/channel.js', hash, 'startChannel',
    ]);
    // Neither a restart policy nor -d: the container lives only as long as its connection.
    expect(args).not.toContain('--restart');
    expect(args).not.toContain('-d');
    expect(() => channelRunArgs({ tag: 't', socketPath: '/a,b', stateVolume: 'v', containerName: 'n', label: 'l', scriptHash: hash })).toThrow(HelperChannelError);
    // Plan step 5, PR B: a volume name that could change the mount (CSV) or be an option is refused.
    for (const stateVolume of ['a,b', '-v', 'a"b', '', 'a=b']) {
      expect(() => channelRunArgs({ tag: 't', socketPath: '/s', stateVolume, containerName: 'n', label: 'l', scriptHash: hash })).toThrow(HelperChannelError);
    }
  });

  it('starts the container with the Docker context of the target and checks the engine with probe', async () => {
    let started: { args: readonly string[]; context: string | undefined } | undefined;
    let stdout: ((text: string) => void) | undefined;
    const written: string[] = [];
    const process: StartedProcess = {
      write: (text) => {
        written.push(text);
        for (const line of text.split('\n').filter((part) => part !== '')) {
          const message = parseClientMessage(line);
          if (message?.t === 'hello') {
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['docker', 'probe', 'sweep'] })));
          }
          if (message?.t === 'op' && message.op === 'probe') {
            // Plan step 5, PR A: changed answer: the probe names its engine (ProbeValue.engine).
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: ENGINE } })));
          }
        }
        return true;
      },
      end: () => {},
      kill: () => {},
      onStdout: (listener) => (stdout = listener),
      onStderr: () => {},
      exited: new Promise(() => {}),
    };
    const channel = await openHelperChannel(
      {
        start: (args) => {
          started = { args, context: operationDockerTarget()?.context };
          return process;
        },
        // Plan step 5, PR A: the engine identity without the worker.
        runDirect: async () => ({ exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false }),
        logger: silentLogger,
        script: async () => 'SCRIPT',
        helperTag: async () => 'devenv-helper:abc',
        socketPath: async () => '/var/run/docker.sock',
        stateVolume: 'devenv-session-monitor',
      },
      REMOTE,
    );
    expect(started?.context).toBe(REMOTE.context);
    expect(started?.args).toContain('devenv-helper:abc');
    expect(started?.args[started.args.indexOf('--name') + 1]).toMatch(/^devenv-channel-[0-9a-f]{12}$/);
    expect(channel.isOpen).toBe(true);
    expect(written[0]).toBe(`${JSON.stringify('SCRIPT')}\n`);
    // Plan step 3 (pipe loading): the loader gets the hash of that script, never the script.
    expect(started?.args.slice(-4)).toEqual([PIPE_LOADER, '/opt/devenv/channel.js', bundleHash('SCRIPT'), 'startChannel']);
    // Review round 4 (M1): then the sweep of never-started channel containers, in the background.
    expect(written.some((line) => line.includes('"op":"sweep"'))).toBe(true);
    channel.close();
  });

  // Plan step 3 (pipe loading, user decision 2026-09-29): the script size limit of the command line is gone.
  it('a 1 MB script is accepted and never in argv', async () => {
    const script = `/* ${'a "quoted" \\ line\n'.repeat(60_000)} */`;
    expect(script.length).toBeGreaterThan(1024 * 1024);
    let args: readonly string[] = [];
    let stdout: ((text: string) => void) | undefined;
    const written: string[] = [];
    const process: StartedProcess = {
      write: (text) => {
        written.push(text);
        for (const line of text.split('\n').filter((part) => part !== '' && part.length < 10_000)) {
          const message = parseClientMessage(line);
          if (message?.t === 'hello') {
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['docker', 'probe'] })));
          }
          if (message?.t === 'op' && message.op === 'probe') {
            // Plan step 5, PR A: changed answer: the probe names its engine (ProbeValue.engine).
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0', engine: ENGINE } })));
          }
        }
        return true;
      },
      end: () => {},
      kill: () => {},
      onStdout: (listener) => (stdout = listener),
      onStderr: () => {},
      exited: new Promise(() => {}),
    };
    const channel = await openHelperChannel(
      {
        start: (startArgs) => {
          args = startArgs;
          return process;
        },
        // Plan step 5, PR A: the engine identity without the worker.
        runDirect: async () => ({ exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false }),
        logger: silentLogger,
        script: async () => script,
        helperTag: async () => 'devenv-helper:abc',
        socketPath: async () => '/var/run/docker.sock',
        stateVolume: 'devenv-session-monitor',
      },
      REMOTE,
    );
    expect(channel.isOpen).toBe(true);
    expect(written[0]).toBe(`${JSON.stringify(script)}\n`);
    expect(args.join(' ').length).toBeLessThan(5_000);
    expect(args.some((arg) => arg.includes('quoted'))).toBe(false);
    expect(args.slice(-2)).toEqual([bundleHash(script), 'startChannel']);
    channel.close();
  });

  it('closes the channel and fails to open when the probe does not reach Docker', async () => {
    let stdout: ((text: string) => void) | undefined;
    let ended = false;
    const process: StartedProcess = {
      write: (text) => {
        for (const line of text.split('\n').filter((part) => part !== '')) {
          const message = parseClientMessage(line);
          if (message?.t === 'hello') queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['probe'] })));
          if (message?.t === 'op') {
            queueMicrotask(() =>
              stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { detail: 'permission denied while trying to connect to the Docker daemon socket' } })),
            );
          }
        }
        return true;
      },
      end: () => (ended = true),
      kill: () => {},
      onStdout: (listener) => (stdout = listener),
      onStderr: () => {},
      exited: new Promise(() => {}),
    };
    await expect(
      openHelperChannel(
        { start: () => process, runDirect: directEngine, logger: silentLogger, script: async () => 'S', helperTag: async () => 't', socketPath: async () => '/s', stateVolume: 'devenv-session-monitor' },
        REMOTE,
      ),
    ).rejects.toThrow('The helper channel to build-box does not reach Docker: permission denied while trying to connect to the Docker daemon socket');
    expect(ended).toBe(true);
  });

  it('fails to open without a Docker CLI', async () => {
    await expect(
      openHelperChannel(
        { start: () => undefined, runDirect: directEngine, logger: silentLogger, script: async () => 'S', helperTag: async () => 't', socketPath: async () => '/s', stateVolume: 'devenv-session-monitor' },
        REMOTE,
      ),
    ).rejects.toMatchObject({ code: 'open' });
  });
});

// Plan step 5, PR A: a worker that talks to another engine is refused.
describe('the engine identity at the open (plan step 5, PR A)', () => {
  /** A channel process that answers hello and a probe with `engine`; `ended()` after the extension closed it. */
  function probeProcess(engine: string | undefined) {
    let stdout: ((text: string) => void) | undefined;
    let ended = false;
    const process: StartedProcess = {
      write: (text) => {
        for (const line of text.split('\n').filter((part) => part !== '')) {
          const message = parseClientMessage(line);
          if (message?.t === 'hello') {
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: 'v24', ops: ['docker', 'probe'] })));
          }
          if (message?.t === 'op' && message.op === 'probe') {
            const value = { serverVersion: '27.1.0', detail: 'Docker 27.1.0', ...(engine === undefined ? {} : { engine }) };
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value })));
          }
        }
        return true;
      },
      end: () => (ended = true),
      kill: () => {},
      onStdout: (listener) => (stdout = listener),
      onStderr: () => {},
      exited: new Promise(() => {}),
    };
    return { process, ended: () => ended };
  }

  it('opens for the local Docker when the engine is the one without the worker, compared in the context of the target', async () => {
    const worker = probeProcess(ENGINE);
    const direct: { args: readonly string[]; context: string | undefined; timeoutMs: number | undefined }[] = [];
    const target = dockerTargetOf('unix:///run/user/1000/docker.sock', 'rootless');
    expect(target.kind).toBe('local');
    const channel = await openHelperChannel(
      {
        start: () => worker.process,
        runDirect: async (args, options) => {
          direct.push({ args, context: operationDockerTarget()?.context, timeoutMs: options?.timeoutMs });
          return { exitCode: 0, stdout: `${ENGINE}\n`, stderr: '', timedOut: false };
        },
        logger: silentLogger,
        script: async () => 'S',
        helperTag: async () => 't',
        socketPath: async () => '/run/user/1000/docker.sock',
        stateVolume: 'devenv-session-monitor',
      },
      target,
    );
    expect(channel.isOpen).toBe(true);
    // PR #71 review round 1 (B-R1-1): the direct call has a time limit, so a hanging engine cannot keep the open pending.
    expect(direct).toEqual([
      { args: ['info', '--format', '{{json .ID}} {{json .DockerRootDir}}'], context: 'rootless', timeoutMs: CHANNEL_PROBE_TIMEOUT_MS },
    ]);
    channel.close();
  });

  for (const [what, engine, directStdout] of [
    ['another engine', '"other-id" "/var/lib/docker"', ENGINE],
    ['a worker that names no engine', undefined, ENGINE],
    ['an engine that cannot be identified without the worker', ENGINE, ''],
  ] as const) {
    it(`refuses ${what}: the worker is closed, the open fails, and the next attempt waits`, async () => {
      vi.useFakeTimers();
      try {
        const worker = probeProcess(engine);
        const { logger, lines } = recordingLogger();
        const open = vi.fn((target: DockerTarget) =>
          openHelperChannel(
            {
              start: () => worker.process,
              runDirect: async () => ({ exitCode: directStdout === '' ? 1 : 0, stdout: directStdout, stderr: '', timedOut: false }),
              logger: silentLogger,
              script: async () => 'S',
              helperTag: async () => 't',
              socketPath: async () => '/var/run/docker.sock',
              stateVolume: 'devenv-session-monitor',
            },
            target,
          ),
        );
        const channels = new HelperChannels({ open, logger });
        // Plan step 5, PR D (rule D1 of 2026-09-30): changed expectation (before: undefined, the call ran directly, and the
        // log said so): the call is refused with the cause.
        await expect(channels.docker(LOCAL_DOCKER_TARGET, ['ps'])).rejects.toMatchObject({
          code: 'unavailable',
          message: expect.stringContaining('The helper channel to the local Docker was closed:'),
        });
        expect(worker.ended()).toBe(true);
        expect(lines.join('\n')).toContain('The helper channel to the local Docker was closed:');
        expect(lines.join('\n')).toContain('The Docker calls of operations on the local Docker are refused until it is open.');
        expect(await channels.get(LOCAL_DOCKER_TARGET)).toBeUndefined();
        expect(open).toHaveBeenCalledTimes(1);
        channels.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

describe('HelperChannels.refresh (plan step 5, PR C)', () => {
  function refreshChannel(ops: string[], answer: () => Promise<unknown>) {
    const channel = { ...fakeChannel(), operations: ops, operation: vi.fn(answer) };
    const channels = new HelperChannels({ open: async () => channel as unknown as HelperChannel, logger: silentLogger });
    return { channel, channels };
  }

  it('reads the states in one operation, without a secret, and checks its value', async () => {
    const { channel, channels } = refreshChannel(['docker', 'probe', 'refresh'], async () => refreshValue(EXPECTED_STATES));
    expect(await channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_ENVIRONMENTS)).toEqual(EXPECTED_STATES);
    expect(channel.operation).toHaveBeenCalledTimes(1);
    expect(channel.operation).toHaveBeenCalledWith('refresh', { environments: REFRESH_ENVIRONMENTS }, { timeoutMs: CHANNEL_REFRESH_TIMEOUT_MS });
    channels.dispose();
  });

  // Plan step 5, PR D (rule D1 of 2026-09-30): changed expectation (before: undefined in each of these cases, and the
  // service read directly): each is refused; a refresh that was not sent because the channel closed is sent once more.
  it('rejects without a worker with `refresh`, for parameters beyond the check, or when it was not sent', async () => {
    const older = refreshChannel(['docker', 'probe', 'sweep'], async () => refreshValue(EXPECTED_STATES));
    await expect(older.channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_ENVIRONMENTS)).rejects.toMatchObject({ code: 'unavailable' });
    expect(older.channel.operation).not.toHaveBeenCalled();
    const unsupported = dockerTargetOf('tcp://build-box:2375', 'tcp-box');
    await expect(older.channels.refresh(unsupported, REFRESH_ENVIRONMENTS)).rejects.toMatchObject({ code: 'unavailable' });
    older.channels.dispose();

    const current = refreshChannel(['refresh'], async () => refreshValue(EXPECTED_STATES));
    const many = Array.from({ length: MAX_REFRESH_ENVIRONMENTS + 1 }, (_, index) => ({ ...REFRESH_ENVIRONMENTS[0], id: `env-${index}` }));
    await expect(current.channels.refresh(LOCAL_DOCKER_TARGET, many)).rejects.toMatchObject({ code: 'unsendable' });
    await expect(current.channels.refresh(LOCAL_DOCKER_TARGET, [{ ...REFRESH_ENVIRONMENTS[0], containerName: '-x' }])).rejects.toMatchObject({ code: 'unsendable' });
    expect(current.channel.operation).not.toHaveBeenCalled();
    current.channels.dispose();

    for (const code of ['closed', 'unsendable'] as const) {
      const notSent = refreshChannel(['refresh'], async () => {
        throw new HelperChannelError(code, 'not sent');
      });
      await expect(notSent.channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_ENVIRONMENTS)).rejects.toMatchObject({ code });
      expect(notSent.channel.operation).toHaveBeenCalledTimes(code === 'closed' ? 2 : 1);
      notSent.channels.dispose();
    }
    const closedOnce = refreshChannel(['refresh'], async () => refreshValue(EXPECTED_STATES));
    closedOnce.channel.operation.mockRejectedValueOnce(new HelperChannelError('closed', 'not sent'));
    expect(await closedOnce.channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_ENVIRONMENTS)).toEqual(EXPECTED_STATES);
    closedOnce.channels.dispose();
  });

  // Plan step 5, PR D (rule D1 of 2026-09-30): the refresh makes the worker ready like a Docker call. PR #76 review round 1
  // (A-R1-1, A-R1-2): it only checks the helper image (checkPresent) and never prepares (builds) it.
  it('checks the helper image and opens the worker in full; a failure refuses the refresh with the cause', async () => {
    const channel = { ...fakeChannel(), operations: ['refresh'], operation: vi.fn(async () => refreshValue(EXPECTED_STATES)) };
    const open = vi.fn().mockRejectedValueOnce(new HelperChannelError('open', 'no image.')).mockResolvedValueOnce(channel);
    const prepare = vi.fn(async () => {});
    const checkPresent = vi.fn(async () => {});
    const channels = new HelperChannels({ open, prepare, checkPresent, logger: silentLogger });
    await expect(channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_ENVIRONMENTS)).rejects.toMatchObject({ code: 'unavailable', message: 'no image.' });
    // Within the wait after the failed open, the next refresh opens again.
    expect(await channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_ENVIRONMENTS)).toEqual(EXPECTED_STATES);
    // PR #76 review round 1 (A-R1-1, A-R1-2): checked, never prepared (was: prepared twice).
    expect(checkPresent).toHaveBeenCalledTimes(2);
    expect(prepare).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
    channels.dispose();
    const refused = new HelperChannels({
      open,
      prepare,
      checkPresent: async () => {
        throw new Error('Cannot connect to the Docker daemon');
      },
      logger: silentLogger,
    });
    await expect(refused.refresh(LOCAL_DOCKER_TARGET, REFRESH_ENVIRONMENTS)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'the helper image could not be prepared: Cannot connect to the Docker daemon',
    });
    expect(open).toHaveBeenCalledTimes(2);
    expect(prepare).not.toHaveBeenCalled();
    refused.dispose();
  });

  // PR #76 review round 1 (A-R1-1, A-R1-2): a missing helper image refuses each refresh at once and never starts a build,
  // also after many refreshes; a Docker call of an operation still prepares (builds) it.
  it('a missing helper image refuses each refresh without a build; a Docker call still prepares it', async () => {
    const channel = { ...fakeChannel(), operations: ['refresh'], operation: vi.fn(async () => refreshValue(EXPECTED_STATES)) };
    const open = vi.fn(async () => channel as unknown as HelperChannel);
    const prepare = vi.fn(async () => {});
    const checkPresent = vi.fn(async () => {
      throw new Error('The workspace helper image is not on this Docker engine.');
    });
    const channels = new HelperChannels({ open, prepare, checkPresent, logger: silentLogger });
    for (let i = 0; i < 5; i++) {
      await expect(channels.refresh(REMOTE, REFRESH_ENVIRONMENTS)).rejects.toMatchObject({
        code: 'unavailable',
        message: 'the helper image could not be prepared: The workspace helper image is not on this Docker engine.',
      });
    }
    expect(checkPresent).toHaveBeenCalledTimes(5);
    expect(prepare).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await channels.docker(REMOTE, ['ps']);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(checkPresent).toHaveBeenCalledTimes(5);
    channels.dispose();
  });

  it('rejects when the worker failed or answered with an invalid value', async () => {
    const lost = refreshChannel(['refresh'], async () => {
      throw new HelperChannelError('lost', 'lost');
    });
    await expect(lost.channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_ENVIRONMENTS)).rejects.toMatchObject({ code: 'lost' });
    lost.channels.dispose();
    const wrong = { ...refreshValue(EXPECTED_STATES), branches: [{ id: REFRESH_ENVIRONMENTS[3].id, branch: 'main' }] };
    const invalid = refreshChannel(['refresh'], async () => wrong);
    await expect(invalid.channels.refresh(LOCAL_DOCKER_TARGET, REFRESH_ENVIRONMENTS)).rejects.toMatchObject({ code: 'protocol' });
    invalid.channels.dispose();
  });
});

// Plan step 5, PR B: HelperChannels.lock (user decisions D1 and D3).
describe('HelperChannels.lock (plan step 5, PR B)', () => {
  const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';

  function lockingChannel(lock: (id: string, wait: number) => Promise<unknown>) {
    return { ...fakeChannel(), lock: vi.fn(lock) };
  }

  it('user decision D1: ends the wait after a failed open and opens the worker for the lock', async () => {
    const held = { environmentId: ID };
    const channel = lockingChannel(async () => held);
    const open = vi.fn().mockRejectedValueOnce(new HelperChannelError('open', 'The helper channel could not be opened: no image.')).mockResolvedValueOnce(channel);
    // Plan step 5, PR D: the lock does not prepare the helper image itself (withEnvironmentLock ensured it before).
    const prepare = vi.fn(async () => {});
    const channels = new HelperChannels({ open, prepare, logger: silentLogger });
    expect(await channels.get(REMOTE)).toBeUndefined();
    // Within the wait after the failure, an explicit lock opens again.
    expect(await channels.lock(REMOTE, ID, 10)).toBe(held);
    expect(prepare).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
    expect(channel.lock).toHaveBeenCalledWith(ID, 10, undefined);
    channels.dispose();
  });

  it('user decision D1: without a worker it throws unavailable with the cause of the failed open, and never goes on', async () => {
    const open = vi.fn().mockRejectedValue(new HelperChannelError('open', 'The helper channel to build-box was closed: it reaches another Docker engine.'));
    const channels = new HelperChannels({ open, logger: silentLogger });
    const error = await channels.lock(REMOTE, ID, 10).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EnvironmentLockError);
    expect(error).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('another Docker engine') });
    const unsupported = dockerTargetOf('tcp://build-box:2375', 'tcp-box');
    await expect(channels.lock(unsupported, ID, 10)).rejects.toMatchObject({ kind: 'unavailable' });
    channels.dispose();
  });

  it('user decision D3: a busy lock of the worker is busy; any other failure is unavailable; an abort passes', async () => {
    const busy = lockingChannel(async () => {
      throw new HelperOperationError(LOCK_BUSY_CODE, 'held', false);
    });
    const channels = new HelperChannels({ open: async () => busy as unknown as HelperChannel, logger: silentLogger });
    await expect(channels.lock(REMOTE, ID, 10)).rejects.toMatchObject({ name: 'EnvironmentLockError', kind: 'busy' });
    busy.lock.mockImplementationOnce(async () => {
      throw new HelperChannelError('lost', 'lost');
    });
    await expect(channels.lock(REMOTE, ID, 10)).rejects.toMatchObject({ kind: 'unavailable' });
    busy.lock.mockImplementationOnce(async () => {
      throw abortError();
    });
    await expect(channels.lock(REMOTE, ID, 10)).rejects.toMatchObject({ name: 'AbortError' });
    channels.dispose();
  });
});
