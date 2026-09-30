// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockerTargetOf, remoteContextName, LOCAL_DOCKER_TARGET, type DockerTarget } from '../docker/dockerHost';
import { operationDockerTarget } from '../docker/dockerTargets';
import { silentLogger, type Logger, type StartedProcess } from '../ports';
import { HelperChannel, HelperChannelError } from './helperChannel';
import {
  CHANNEL_OPEN_WAIT_MS,
  CHANNEL_RETRY_AFTER_FAILURE_MS,
  HelperChannels,
  channelRunArgs,
  openHelperChannel,
} from './helperChannels';
import { PIPE_LOADER, bundleHash } from '../loader/pipeLoader';
import { CHANNEL_IDLE_CLOSE_MS, CHANNEL_PROTOCOL_VERSION, LABEL_HELPER_CHANNEL, encodeMessage, parseClientMessage } from './protocol';

const REMOTE: DockerTarget = dockerTargetOf('ssh://build-box', remoteContextName('build-box'));

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

  it('opens no channel for the local Docker', async () => {
    const open = vi.fn();
    const channels = new HelperChannels({ open, logger: silentLogger });
    expect(await channels.get(LOCAL_DOCKER_TARGET)).toBeUndefined();
    expect(await channels.docker(LOCAL_DOCKER_TARGET, ['ps'])).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
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

  it('after a failure: the callers take the way without it, and the next attempt waits CHANNEL_RETRY_AFTER_FAILURE_MS', async () => {
    const channel = fakeChannel();
    const open = vi
      .fn()
      .mockRejectedValueOnce(new HelperChannelError('open', 'The helper channel to build-box could not be opened: no image.'))
      .mockResolvedValueOnce(channel);
    const { logger, lines } = recordingLogger();
    const channels = new HelperChannels({ open, logger });
    expect(await channels.docker(REMOTE, ['ps'])).toBeUndefined();
    expect(lines).toEqual([
      'The helper channel to build-box could not be opened: no image. Docker calls to build-box go without it; the next attempt in 5 minutes.',
    ]);
    await vi.advanceTimersByTimeAsync(CHANNEL_RETRY_AFTER_FAILURE_MS - 1_000);
    expect(await channels.get(REMOTE)).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await channels.get(REMOTE)).toBe(channel);
    channels.dispose();
  });

  it('docker: undefined when the channel closed before the call was sent; a call lost while it ran rejects', async () => {
    const channel = fakeChannel();
    const channels = new HelperChannels({ open: async () => channel as unknown as HelperChannel, logger: silentLogger });
    expect(await channels.docker(REMOTE, ['ps'])).toEqual({ exitCode: 0, stdout: 'out', stderr: '', timedOut: false });
    channel.docker.mockRejectedValueOnce(new HelperChannelError('closed', 'closed'));
    expect(await channels.docker(REMOTE, ['ps'])).toBeUndefined();
    // Review round 1 (P2): a call beyond what the channel carries is not sent either.
    channel.docker.mockRejectedValueOnce(new HelperChannelError('unsendable', 'too long'));
    expect(await channels.docker(REMOTE, ['ps'])).toBeUndefined();
    channel.docker.mockRejectedValueOnce(new HelperChannelError('lost', 'lost'));
    await expect(channels.docker(REMOTE, ['ps'])).rejects.toMatchObject({ code: 'lost' });
    channels.dispose();
  });

  it('a call waits for an opening channel at most CHANNEL_OPEN_WAIT_MS or its time limit, then takes the way without it; its signal ends the wait (review round 2, A4)', async () => {
    const channel = fakeChannel();
    let finishOpen!: (channel: HelperChannel) => void;
    const open = vi.fn(() => new Promise<HelperChannel>((resolve) => (finishOpen = resolve)));
    const channels = new HelperChannels({ open, logger: silentLogger });
    const first = channels.docker(REMOTE, ['ps'], { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toBeUndefined();
    const second = channels.docker(REMOTE, ['ps']);
    await vi.advanceTimersByTimeAsync(CHANNEL_OPEN_WAIT_MS);
    expect(await second).toBeUndefined();
    const controller = new AbortController();
    const third = channels.docker(REMOTE, ['ps'], { signal: controller.signal });
    controller.abort();
    await expect(third).rejects.toMatchObject({ name: 'AbortError' });
    // The opening went on: the next call uses the channel.
    finishOpen(channel as unknown as HelperChannel);
    expect(await channels.docker(REMOTE, ['ps'])).toMatchObject({ exitCode: 0 });
    expect(open).toHaveBeenCalledTimes(1);
    channels.dispose();
  });

  // Review round 6 (R6-2): the wait for the channel, the wait for a place and the time limit added up.
  it('takes the wait for the channel from the time limit and gives the rest of the wait to the wait for a place', async () => {
    const channel = fakeChannel();
    let finishOpen!: (channel: HelperChannel) => void;
    const channels = new HelperChannels({ open: () => new Promise<HelperChannel>((resolve) => (finishOpen = resolve)), logger: silentLogger });
    const call = channels.docker(REMOTE, ['ps'], { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    finishOpen(channel as unknown as HelperChannel);
    expect(await call).toMatchObject({ exitCode: 0 });
    expect(channel.docker).toHaveBeenCalledWith(['ps'], expect.objectContaining({ timeoutMs: 7_000, slotWaitMs: 2_000 }));
    channels.dispose();
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
    const args = channelRunArgs({ tag: 'devenv-helper:abc', socketPath: '/run/user/1000/docker.sock', containerName: 'devenv-channel-1', label: '1-x', scriptHash: hash });
    expect(args).toEqual([
      'run', '--rm', '-i', '--pull', 'never', '--name', 'devenv-channel-1',
      '--label', 'nimblescape.devenv.helper-run=true',
      '--label', `${LABEL_HELPER_CHANNEL}=1-x`,
      // Review round 2 (B3): no log of the channel on the host.
      '--network', 'none', '--log-driver', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', 'type=bind,source=/run/user/1000/docker.sock,target=/var/run/docker.sock',
      // Plan step 3 (pipe loading, user decision 2026-09-29): changed expectation (before: 'node', '-e', CHANNEL_LOADER).
      'devenv-helper:abc', 'node', '-e', PIPE_LOADER, '/opt/devenv/channel.js', hash, 'startChannel',
    ]);
    // Neither a restart policy nor -d: the container lives only as long as its connection.
    expect(args).not.toContain('--restart');
    expect(args).not.toContain('-d');
    expect(() => channelRunArgs({ tag: 't', socketPath: '/a,b', containerName: 'n', label: 'l', scriptHash: hash })).toThrow(HelperChannelError);
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
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0' } })));
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
        logger: silentLogger,
        script: async () => 'SCRIPT',
        helperTag: async () => 'devenv-helper:abc',
        socketPath: async () => '/var/run/docker.sock',
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
            queueMicrotask(() => stdout?.(encodeMessage({ t: 'result', id: message.id, ok: true, value: { serverVersion: '27.1.0', detail: 'Docker 27.1.0' } })));
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
        logger: silentLogger,
        script: async () => script,
        helperTag: async () => 'devenv-helper:abc',
        socketPath: async () => '/var/run/docker.sock',
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
        { start: () => process, logger: silentLogger, script: async () => 'S', helperTag: async () => 't', socketPath: async () => '/s' },
        REMOTE,
      ),
    ).rejects.toThrow('The helper channel to build-box does not reach Docker: permission denied while trying to connect to the Docker daemon socket');
    expect(ended).toBe(true);
  });

  it('fails to open without a Docker CLI', async () => {
    await expect(
      openHelperChannel(
        { start: () => undefined, logger: silentLogger, script: async () => 'S', helperTag: async () => 't', socketPath: async () => '/s' },
        REMOTE,
      ),
    ).rejects.toMatchObject({ code: 'open' });
  });
});
