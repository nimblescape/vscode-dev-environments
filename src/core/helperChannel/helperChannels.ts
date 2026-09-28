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
import { abortError, type Logger, type RunResult, type StartedProcess } from '../ports';
import { HelperChannel, HelperChannelError, type ChannelDockerOptions } from './helperChannel';
import {
  CHANNEL_IDLE_CLOSE_MS,
  CHANNEL_LOADER,
  LABEL_HELPER_CHANNEL,
  OP_PROBE,
  OP_SWEEP,
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
 * Review round 2 (A4): a call waits at most this long for a channel that is still being opened; then it takes the way
 * without it (the opening goes on for the next calls).
 */
export const CHANNEL_OPEN_WAIT_MS = 5_000;

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
    // Review round 2 (B3): the engine keeps no log of the channel (its commands and output), whatever its log driver.
    '--log-driver',
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
  // Review round 4 (M1): channel containers that an earlier open created but never started are removed, in the
  // background (a failure is logged; the channel is open already).
  if (channel.operations.includes(OP_SWEEP)) {
    void channel.operation(OP_SWEEP, {}, { timeoutMs: CHANNEL_PROBE_TIMEOUT_MS }).catch((error: unknown) => {
      deps.logger.info(`The stopped helper channel containers on ${target.host} could not be removed: ${(error as Error).message}`);
    });
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

/**
 * The key of the engine of a target: its Docker context and its endpoint. Review round 5 (F1): by the context alone, a
 * context of the user that was pointed to another host under the same name (`docker context update`) kept the channel
 * to the old engine, and the calls through it went there. The channel of the old endpoint gets no new operation and is
 * closed by the sweep after CHANNEL_IDLE_CLOSE_MS. Not seen: an SSH alias of `~/.ssh/config` pointed to another machine
 * (the same endpoint).
 */
function keyOf(target: DockerTarget): string {
  return JSON.stringify([target.context ?? null, target.endpoint]);
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
   * dispose, when it cannot be opened (logged once per attempt; the next attempt after CHANNEL_RETRY_AFTER_FAILURE_MS),
   * and when it is not open within `wait.waitMs`. Rejects only with an AbortError when `wait.signal` aborts (review
   * round 3, K5), as every call with that signal does.
   */
  async get(target: DockerTarget, wait: { signal?: AbortSignal; waitMs?: number } = {}): Promise<HelperChannel | undefined> {
    if (wait.signal?.aborted) throw abortError();
    const opening = this.channelFor(target);
    if (wait.waitMs === undefined && wait.signal === undefined) return opening;
    // Review round 2 (A4): the caller's signal and its time for the wait end the wait, not the opening.
    return new Promise<HelperChannel | undefined>((resolve, reject) => {
      const timer = wait.waitMs === undefined ? undefined : setTimeout(() => done(() => resolve(undefined)), wait.waitMs);
      const onAbort = () => done(() => reject(abortError()));
      wait.signal?.addEventListener('abort', onAbort, { once: true });
      let settled = false;
      const done = (settle: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        wait.signal?.removeEventListener('abort', onAbort);
        settle();
      };
      opening.then((channel) => done(() => resolve(channel)));
    });
  }

  /** The open channel, or the shared opening of one (see get). */
  private async channelFor(target: DockerTarget): Promise<HelperChannel | undefined> {
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
   * One Docker call through the channel to the engine of `target`. Undefined when there is no channel, or the call was
   * not sent (the channel closed before, or the call is beyond what it carries): the caller takes the way without it. Rejects as HelperChannel.docker otherwise (a lost
   * channel while the call ran: HelperChannelError('lost'), whose outcome is not known).
   */
  async docker(target: DockerTarget, args: readonly string[], options: ChannelDockerOptions = {}): Promise<RunResult | undefined> {
    const waitMs = Math.min(CHANNEL_OPEN_WAIT_MS, options.timeoutMs ?? CHANNEL_OPEN_WAIT_MS);
    const startedAt = Date.now();
    const channel = await this.get(target, { signal: options.signal, waitMs });
    if (channel === undefined) return undefined;
    // Review round 6 (R6-2): the wait for the channel and the wait for a free place share one wait of at most waitMs, and
    // the time limit counts from this call. So a call ends within its limit (plus the waits of at most 5 s when it
    // is not sent and the caller takes the way without the channel).
    const waited = Date.now() - startedAt;
    const timeoutMs = options.timeoutMs === undefined ? undefined : options.timeoutMs - waited;
    if (timeoutMs !== undefined && timeoutMs < 1) return undefined;
    try {
      return await channel.docker(args, { ...options, timeoutMs, slotWaitMs: Math.max(0, waitMs - waited) });
    } catch (error) {
      // Not sent: closed before, or beyond what the channel carries (review round 1, P2).
      if (error instanceof HelperChannelError && (error.code === 'closed' || error.code === 'unsendable')) return undefined;
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

  /**
   * Closes every channel (the window closes). Review round 4 (M3): at once (closeNow), because the extension host may end
   * right after, and no timer of it runs then.
   */
  dispose(): void {
    this.disposed = true;
    clearInterval(this.sweepTimer);
    for (const entry of this.entries.values()) entry.channel?.closeNow();
    this.entries.clear();
  }
}
