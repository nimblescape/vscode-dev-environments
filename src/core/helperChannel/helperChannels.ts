// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper channels of a window (user request 2026-09-28, step 1 of the remote speedup): at most one per remote Docker
// host, opened at its first use, closed after CHANNEL_IDLE_CLOSE_MS without an operation, and opened again after it was
// lost. When it cannot be opened (for example the helper image is not on the host yet), the callers take the way
// without it, and it is not tried again for CHANNEL_RETRY_AFTER_FAILURE_MS. Only for remote hosts: the local Docker
// needs no channel. No `vscode`.
import * as crypto from 'crypto';
import { runWithDockerTarget } from '../docker/dockerTargets';
import type { DockerTarget } from '../docker/dockerHost';
import { HELPER_DOCKER_SOCKET, LABEL_HELPER_RUN } from '../names';
import type { Logger, RunResult, StartedProcess } from '../ports';
import { HelperChannel, HelperChannelError, type ChannelDockerOptions } from './helperChannel';
import {
  CHANNEL_IDLE_CLOSE_MS,
  CHANNEL_LOADER,
  LABEL_HELPER_CHANNEL,
  OP_PROBE,
  channelLabelValue,
  parseProbeValue,
} from './protocol';

/** After a channel could not be opened, the next attempt for that host waits this long. */
export const CHANNEL_RETRY_AFTER_FAILURE_MS = 5 * 60_000;
/** Time limit of the probe after the start. */
export const CHANNEL_PROBE_TIMEOUT_MS = 30_000;
/** How often the idle channels are looked for. */
export const CHANNEL_SWEEP_INTERVAL_MS = 60_000;

/**
 * `docker run` arguments of a channel container: `--rm -i`, never a pull (the helper image is built by the open
 * pipeline; without it the start fails and the caller takes the way without the channel), the labels, no network, no
 * capability, no new privileges, only the Docker socket of the engine. The command is the loader of protocol.ts.
 */
export function channelRunArgs(p: { tag: string; socketPath: string; containerName: string; label: string }): string[] {
  // --mount is CSV: a path with a comma or a quote would change the mount.
  if (/[",]/.test(p.socketPath)) throw new HelperChannelError('open', `The Docker socket path ${p.socketPath} cannot be mounted.`);
  return [
    'run',
    '--rm',
    '-i',
    '--pull',
    'never',
    '--name',
    p.containerName,
    '--label',
    `${LABEL_HELPER_RUN}=true`,
    '--label',
    `${LABEL_HELPER_CHANNEL}=${p.label}`,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--mount',
    `type=bind,source=${p.socketPath},target=${HELPER_DOCKER_SOCKET}`,
    p.tag,
    'node',
    '-e',
    CHANNEL_LOADER,
  ];
}

export interface ChannelOpenDeps {
  /** ContainerAdapter.start: `docker <args>` with the environment of the operation (its Docker context). */
  start(args: readonly string[]): StartedProcess | undefined;
  logger: Logger;
  /** The content of dist/helperChannel.js. */
  script(): Promise<string>;
  /** The tag of the workspace helper image (helperImageTag of the Dockerfile of the extension). */
  helperTag(): Promise<string>;
  /** The source of the socket mount on the host of the engine (rootless aware). */
  socketPath(target: DockerTarget): Promise<string>;
}

/**
 * Opens a channel to the engine of `target`: starts the container with the Docker context of `target`, then checks
 * with the operation `probe` that the Docker CLI in it reaches its engine. Throws HelperChannelError('open').
 */
export async function openHelperChannel(deps: ChannelOpenDeps, target: DockerTarget): Promise<HelperChannel> {
  const [script, tag, socketPath] = await Promise.all([deps.script(), deps.helperTag(), deps.socketPath(target)]);
  const containerName = `devenv-channel-${crypto.randomBytes(6).toString('hex')}`;
  const args = channelRunArgs({ tag, socketPath, containerName, label: channelLabelValue(script) });
  const process = await runWithDockerTarget(target, async () => deps.start(args));
  if (process === undefined) throw new HelperChannelError('open', 'The Docker CLI cannot be started.');
  const channel = await HelperChannel.open(process, script, { logger: deps.logger, name: target.host });
  try {
    const probe = parseProbeValue(await channel.operation(OP_PROBE, {}, { timeoutMs: CHANNEL_PROBE_TIMEOUT_MS }));
    if (probe?.serverVersion === undefined) throw new Error(probe?.detail ?? 'an invalid answer');
  } catch (error) {
    channel.close();
    throw new HelperChannelError('open', `The helper channel to ${target.host} does not reach Docker: ${(error as Error).message}`);
  }
  return channel;
}

interface Entry {
  channel?: HelperChannel;
  opening?: Promise<HelperChannel | undefined>;
  failedAt?: number;
}

export interface HelperChannelsOptions {
  open(target: DockerTarget): Promise<HelperChannel>;
  logger: Logger;
  idleCloseMs?: number;
  retryAfterFailureMs?: number;
  sweepIntervalMs?: number;
}

/** The key of the engine of a target: its Docker context, else its endpoint. */
function keyOf(target: DockerTarget): string {
  return target.context ?? target.endpoint;
}

/** The channels of this window, one per remote host. */
export class HelperChannels {
  private readonly entries = new Map<string, Entry>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly options: HelperChannelsOptions) {
    this.sweepTimer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? CHANNEL_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /**
   * The open channel to the engine of `target`, opened now if needed. Undefined for a target that is not remote, after
   * dispose, and when it cannot be opened (logged once per attempt; the next attempt after CHANNEL_RETRY_AFTER_FAILURE_MS).
   * Never throws.
   */
  async get(target: DockerTarget): Promise<HelperChannel | undefined> {
    if (this.disposed || target.kind !== 'remote') return undefined;
    const key = keyOf(target);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = {};
      this.entries.set(key, entry);
    }
    if (entry.channel?.isOpen) return entry.channel;
    if (entry.opening) return entry.opening;
    const retryAfter = this.options.retryAfterFailureMs ?? CHANNEL_RETRY_AFTER_FAILURE_MS;
    if (entry.failedAt !== undefined && Math.abs(Date.now() - entry.failedAt) < retryAfter) return undefined;
    const current = entry;
    current.channel = undefined;
    current.opening = this.options.open(target).then(
      (channel) => {
        current.opening = undefined;
        if (this.disposed) {
          channel.close();
          return undefined;
        }
        current.channel = channel;
        current.failedAt = undefined;
        channel.onClose(() => {
          if (current.channel === channel) current.channel = undefined;
        });
        return channel;
      },
      (error: unknown) => {
        current.opening = undefined;
        current.failedAt = Date.now();
        this.options.logger.info(
          `${(error as Error).message} Docker calls to ${target.host} go without it; the next attempt in ${Math.round(retryAfter / 60_000)} minutes.`,
        );
        return undefined;
      },
    );
    return current.opening;
  }

  /**
   * One Docker call through the channel to the engine of `target`. Undefined when there is no channel, or it closed
   * before the call was sent: the caller takes the way without it. Rejects as HelperChannel.docker otherwise (a lost
   * channel while the call ran: HelperChannelError('lost'), whose outcome is not known).
   */
  async docker(target: DockerTarget, args: readonly string[], options: ChannelDockerOptions = {}): Promise<RunResult | undefined> {
    const channel = await this.get(target);
    if (channel === undefined) return undefined;
    try {
      return await channel.docker(args, options);
    } catch (error) {
      if (error instanceof HelperChannelError && error.code === 'closed') return undefined;
      throw error;
    }
  }

  /** Closes the channels without an operation for CHANNEL_IDLE_CLOSE_MS. */
  sweep(): void {
    const idleMs = this.options.idleCloseMs ?? CHANNEL_IDLE_CLOSE_MS;
    for (const entry of this.entries.values()) {
      const channel = entry.channel;
      if (channel?.isOpen && channel.busy === 0 && Date.now() - channel.lastUsed >= idleMs) {
        this.options.logger.info('A helper channel was closed after a time without use.');
        entry.channel = undefined;
        channel.close();
      }
    }
  }

  /** Closes every channel (the window closes). */
  dispose(): void {
    this.disposed = true;
    clearInterval(this.sweepTimer);
    for (const entry of this.entries.values()) entry.channel?.close();
    this.entries.clear();
  }
}
