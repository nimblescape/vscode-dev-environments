// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper channels of a window (user request 2026-09-28, step 1 of the remote speedup): at most one per Docker
// engine, opened at its first use, closed after CHANNEL_IDLE_CLOSE_MS without an operation, and opened again after it was
// lost. When it cannot be opened, it is not tried again for CHANNEL_RETRY_AFTER_FAILURE_MS (clearFailures ends that
// wait). Plan step 5, PR A: for the local Docker too (user decision 2026-09-29), never for an unsupported endpoint. Plan
// step 5, PR D (rule D1 of 2026-09-30): a call that needs the worker (docker, refresh, lock) first makes it ready (the
// helper image, then the open in full, also within that wait); when it cannot, the call is refused, never taken the way
// without it. No `vscode`.
import * as crypto from 'crypto';
import { runWithDockerTarget } from '../docker/dockerTargets';
import type { DockerTarget } from '../docker/dockerHost';
import { bundleHash, loaderCommand } from '../loader/pipeLoader';
import { HELPER_DOCKER_SOCKET, LABEL_HELPER_RUN } from '../names';
import { EnvironmentLockError, type HeldEnvironmentLock } from '../docker/environmentLock';
import { errorMessage, isUserFacingError } from '../errors';
import { abortError, isAbortError, type Logger, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import { HelperChannel, HelperChannelError, HelperOperationError, type ChannelDockerOptions } from './helperChannel';
import {
  CHANNEL_ENTRY,
  CHANNEL_IDLE_CLOSE_MS,
  CHANNEL_SCRIPT_PATH,
  ENGINE_IDENTITY_ARGS,
  LABEL_HELPER_CHANNEL,
  LOCK_BUSY_CODE,
  LOCK_STATE_DIR,
  OP_PROBE,
  OP_REFRESH,
  OP_SWEEP,
  channelLabelValue,
  engineIdentity,
  parseProbeValue,
  parseRefreshParams,
  parseRefreshValue,
} from './protocol';
import type { EnvironmentStates, StateEnvironment } from '../pipeline/refreshStates';

/** Plan step 5, PR C: the time limit of the operation `refresh`. */
export const CHANNEL_REFRESH_TIMEOUT_MS = 5 * 60_000;

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
 * pipeline, or made ready by HelperChannelsOptions.prepare; without it the start fails), the labels, no network, no
 * capability, no new privileges, only the Docker socket of the engine. The command is the pipe loader (plan step 3) with
 * CHANNEL_SCRIPT_PATH, the hash of the script (`scriptHash`, bundleHash), and CHANNEL_ENTRY; the script itself comes as
 * the first line of the input (HelperChannel.open), never on the command line.
 */
export function channelRunArgs(p: { tag: string; socketPath: string; stateVolume: string; containerName: string; label: string; scriptHash: string }): string[] {
  // --mount is CSV: a path with a comma or a quote would change the mount.
  if (/[",]/.test(p.socketPath)) throw new HelperChannelError('open', `The Docker socket path ${p.socketPath} cannot be mounted.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(p.stateVolume)) throw new HelperChannelError('open', `The volume ${p.stateVolume} cannot be mounted.`);
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
    // Plan step 5, PR B: the volume of the Session Monitor, for the lock files of the environments (OP_LOCK).
    '--mount',
    `type=volume,source=${p.stateVolume},target=${LOCK_STATE_DIR}`,
    p.tag,
    ...loaderCommand({ path: CHANNEL_SCRIPT_PATH, hash: p.scriptHash, entry: CHANNEL_ENTRY }),
  ];
}

export interface ChannelOpenDeps {
  /** ContainerAdapter.start: `docker <args>` with the environment of the operation (its Docker context). */
  start(args: readonly string[]): StartedProcess | undefined;
  /**
   * Plan step 5, PR A: ContainerAdapter.runDirect: `docker <args>` without the worker, with the environment of the
   * operation (the engine identity of the open).
   */
  runDirect(args: readonly string[], options?: RunOptions): Promise<RunResult>;
  logger: Logger;
  /** The content of dist/helperChannel.js. */
  script(): Promise<string>;
  /** The tag of the workspace helper image (helperImageTag of the Dockerfile of the extension). */
  helperTag(): Promise<string>;
  /** The source of the socket mount on the host of the engine (rootless aware). */
  socketPath(target: DockerTarget): Promise<string>;
  /**
   * Plan step 5, PR B: the volume with the lock files of the environments: the volume of the Session Monitor
   * (REMOTE_MONITOR_VOLUME), the same for every engine, local and remote (the Docker tests: a volume of their own).
   */
  stateVolume: string;
}

/** The name of the engine of `target` in the log. */
function engineName(target: DockerTarget): string {
  return target.kind === 'local' ? 'the local Docker' : target.host;
}

/**
 * Opens a channel to the engine of `target`: starts the container with the Docker context of `target`, then checks
 * with the operation `probe` that the Docker CLI in it reaches its engine, and (plan step 5, PR A) that it is the engine
 * of `target`: the engine identity of the probe (ENGINE_IDENTITY_ARGS in the container) must be the one of the same call
 * without the worker (a socket mount of another engine, for example with DOCKER_HOST set to a TCP endpoint of this
 * computer, is refused). Throws HelperChannelError('open').
 */
export async function openHelperChannel(deps: ChannelOpenDeps, target: DockerTarget): Promise<HelperChannel> {
  const [script, tag, socketPath] = await Promise.all([deps.script(), deps.helperTag(), deps.socketPath(target)]);
  const containerName = `devenv-channel-${crypto.randomBytes(6).toString('hex')}`;
  const args = channelRunArgs({ tag, socketPath, stateVolume: deps.stateVolume, containerName, label: channelLabelValue(script), scriptHash: bundleHash(script) });
  const process = await runWithDockerTarget(target, async () => deps.start(args));
  if (process === undefined) throw new HelperChannelError('open', 'The Docker CLI cannot be started.');
  const name = engineName(target);
  const channel = await HelperChannel.open(process, script, { logger: deps.logger, name });
  let engine: string | undefined;
  try {
    const probe = parseProbeValue(await channel.operation(OP_PROBE, {}, { timeoutMs: CHANNEL_PROBE_TIMEOUT_MS }));
    if (probe?.serverVersion === undefined) throw new Error(probe?.detail ?? 'an invalid answer');
    engine = probe.engine;
  } catch (error) {
    channel.close();
    throw new HelperChannelError('open', `The helper channel to ${name} does not reach Docker: ${(error as Error).message}`);
  }
  // Plan step 5, PR A: the engine identity, compared with one call without the worker.
  let direct: string | undefined;
  let directDetail = '';
  try {
    const result = await runWithDockerTarget(target, () => deps.runDirect(ENGINE_IDENTITY_ARGS, { timeoutMs: CHANNEL_PROBE_TIMEOUT_MS }));
    direct = result.exitCode === 0 ? engineIdentity(result.stdout) : undefined;
    directDetail = result.stderr.trim().slice(-500);
  } catch (error) {
    directDetail = (error as Error).message;
  }
  if (engine === undefined || direct === undefined || engine !== direct) {
    channel.close();
    const why =
      engine === undefined
        ? 'the helper did not name its Docker engine'
        : direct === undefined
          ? `the Docker engine could not be identified without it${directDetail ? ` (${directDetail})` : ''}`
          : `it reaches another Docker engine (${engine}) than the Docker calls without it (${direct})`;
    throw new HelperChannelError('open', `The helper channel to ${name} was closed: ${why}.`);
  }
  // Review round 4 (M1): channel containers that an earlier open created but never started are removed, in the
  // background (a failure is logged; the channel is open already).
  if (channel.operations.includes(OP_SWEEP)) {
    void channel.operation(OP_SWEEP, {}, { timeoutMs: CHANNEL_PROBE_TIMEOUT_MS }).catch((error: unknown) => {
      deps.logger.info(`The stopped helper channel containers on ${name} could not be removed: ${(error as Error).message}`);
    });
  }
  return channel;
}

interface Entry {
  channel?: HelperChannel;
  opening?: Promise<HelperChannel | undefined>;
  failedAt?: number;
  /** Plan step 5, PR B: why the last open failed (for the refusal of a lock, user decision D1). */
  failure?: string;
}

export interface HelperChannelsOptions {
  open(target: DockerTarget): Promise<HelperChannel>;
  /**
   * Plan step 5, PR D (rule D1 of 2026-09-30): makes the state that a worker of `target` needs consistent before it is
   * opened for a call (docker, refresh): the helper image, built when its tag is missing (WorkspaceHelper.ensureImagePresent,
   * as withEnvironmentLock does before the lock). Rejects when it cannot; the call is then refused. An AbortError when
   * `signal` aborts.
   */
  prepare?(target: DockerTarget, signal: AbortSignal | undefined): Promise<void>;
  /**
   * PR #76 review round 1 (A-R1-1, A-R1-2): what the refresh of the sidebar, which no user starts, checks instead of
   * `prepare`: that the helper image is present (WorkspaceHelper.checkImagePresent), never a build, so a refresh neither
   * waits for a build without a time limit nor builds again after each failed build. Rejects when the image is missing or
   * cannot be checked; the refresh is then refused, and the next operation (Start, Stop, Delete) builds it.
   */
  checkPresent?(target: DockerTarget, signal: AbortSignal | undefined): Promise<void>;
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

/** The channels of this window, one per Docker engine (local and remote). */
export class HelperChannels {
  private readonly entries = new Map<string, Entry>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly options: HelperChannelsOptions) {
    this.sweepTimer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? CHANNEL_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /**
   * Plan step 5, PR A: the next get of every engine opens a channel again at once, also within
   * CHANNEL_RETRY_AFTER_FAILURE_MS after a failed open (the Docker engine began to answer, or the helper image was built).
   */
  clearFailures(): void {
    for (const entry of this.entries.values()) entry.failedAt = undefined;
  }

  /**
   * The open channel to the engine of `target`, opened now if needed. Undefined for an unsupported target, after
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
    // Plan step 5, PR A: the local Docker too; never an endpoint that is neither local nor SSH.
    if (this.disposed || (target.kind !== 'remote' && target.kind !== 'local')) return undefined;
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
        current.failure = (error as Error).message;
        this.options.logger.info(
          // Plan step 5, PR D (rule D1 of 2026-09-30): the calls that need it are refused, never run without it.
          `${(error as Error).message} The Docker calls of operations on ${engineName(target)} are refused until it is open.`,
        );
        return undefined;
      },
    );
    return current.opening;
  }

  /**
   * Plan step 5, PR D (rule D1 of 2026-09-30): the open channel to the engine of `target`, made ready now if needed: when
   * none is open, first `prepare` (the helper image; `checkPresent` when `passive`, for the refresh), then the open in
   * full (openInFull; when `passive`, the open that keeps the wait after a failed open, PR #76 review round 2, A-R2-1).
   * Throws
   * HelperChannelError('unavailable') with the cause when either fails, and an AbortError when `signal` aborts.
   */
  private async ready(target: DockerTarget, signal: AbortSignal | undefined, passive = false): Promise<HelperChannel> {
    if (signal?.aborted) throw abortError();
    const open = this.entries.get(keyOf(target))?.channel;
    if (open?.isOpen) return open;
    this.refuseUnsupported(target);
    // PR #76 review round 1 (A-R1-1, A-R1-2): the refresh only checks the helper image (checkPresent), never builds it.
    const prepare = passive ? this.options.checkPresent : this.options.prepare;
    if (prepare !== undefined) {
      try {
        await prepare(target, signal);
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw isAbortError(error) ? error : abortError();
        const cause = isUserFacingError(error) && error.detail ? `${error.message} ${error.detail}` : errorMessage(error);
        this.options.logger.warn(`The helper image for the worker on ${engineName(target)} could not be prepared: ${cause}`);
        throw new HelperChannelError('unavailable', `the helper image could not be prepared: ${cause}`);
      }
    }
    if (passive) {
      // PR #76 review round 2 (A-R2-1): the refresh keeps the wait after a failed open (CHANNEL_RETRY_AFTER_FAILURE_MS):
      // within it, it is refused at once; only an operation (docker, lock) opens again at once (openInFull).
      const channel = await this.get(target, { signal });
      if (channel !== undefined) return channel;
      this.refuseUnsupported(target);
      throw new HelperChannelError('unavailable', this.entries.get(keyOf(target))?.failure ?? 'the worker could not be opened');
    }
    return this.openInFull(target, signal);
  }

  /** Plan step 5, PR D: no worker for the window that closes, or for an endpoint that is neither local nor SSH. */
  private refuseUnsupported(target: DockerTarget): void {
    if (this.disposed) throw new HelperChannelError('unavailable', 'the window is closing');
    if (target.kind !== 'remote' && target.kind !== 'local') throw new HelperChannelError('unavailable', 'the Docker endpoint is neither local nor SSH');
  }

  /**
   * Plan step 5, PR B (moved here by PR D, shared by lock, docker and refresh): user decision D1 (an explicit attempt to
   * make the state consistent): the wait after a failed open ends for this engine, and the open is awaited in full (not
   * CHANNEL_OPEN_WAIT_MS). Throws HelperChannelError('unavailable') with the cause of the failed open, and an AbortError
   * when `signal` aborts.
   */
  private async openInFull(target: DockerTarget, signal: AbortSignal | undefined): Promise<HelperChannel> {
    const entry = this.entries.get(keyOf(target));
    if (entry !== undefined) entry.failedAt = undefined;
    const channel = await this.get(target, { signal });
    if (channel !== undefined) return channel;
    this.refuseUnsupported(target);
    throw new HelperChannelError('unavailable', this.entries.get(keyOf(target))?.failure ?? 'the worker could not be opened');
  }

  /**
   * One Docker call through the channel to the engine of `target`. Plan step 5, PR D (rule D1 of 2026-09-30): never the
   * way without it. Without an open channel, it is made ready first (ready): HelperChannelError('unavailable') when that
   * fails. A call that was not sent because the channel closed before is sent once more through a channel made ready
   * again (it did not run); a call beyond what the channel carries rejects with HelperChannelError('unsendable'). Rejects
   * as HelperChannel.docker otherwise (a lost channel while the call ran: HelperChannelError('lost'), whose outcome is
   * not known).
   */
  async docker(target: DockerTarget, args: readonly string[], options: ChannelDockerOptions = {}): Promise<RunResult> {
    for (let attempt = 0; ; attempt++) {
      const channel = await this.ready(target, options.signal);
      // Review round 6 (R6-2): the wait for a free place is at most CHANNEL_OPEN_WAIT_MS or the time limit of the call,
      // and HelperChannel.operation takes it from the time limit that it sends. Plan step 5, PR D: the time that made the
      // worker ready (a build of the helper image) is not taken from it; the lock awaits that in full too.
      const slotWaitMs = Math.min(CHANNEL_OPEN_WAIT_MS, options.timeoutMs ?? CHANNEL_OPEN_WAIT_MS);
      try {
        return await channel.docker(args, { ...options, slotWaitMs });
      } catch (error) {
        if (attempt === 0 && error instanceof HelperChannelError && error.code === 'closed') continue;
        throw error;
      }
    }
  }

  /**
   * Plan step 5, PR C: readEnvironmentStates in the worker of `target` (the operation `refresh`), with the strict checks of
   * its parameters and its value (protocol.ts). Plan step 5, PR D (rule D1 of 2026-09-30): never the way without it. The
   * worker is made ready first (ready: HelperChannelError('unavailable') when that fails, also for a worker without
   * `refresh`); parameters beyond the check reject with HelperChannelError('unsendable'); a refresh that was not sent
   * because the channel closed before is sent once more through a channel made ready again. Rejects when it was sent and
   * failed, or answered with an invalid value.
   */
  async refresh(target: DockerTarget, environments: readonly StateEnvironment[], signal?: AbortSignal): Promise<EnvironmentStates> {
    const params = parseRefreshParams({ environments });
    if (params === undefined) throw new HelperChannelError('unsendable', 'The environments are beyond what the refresh of the worker carries.');
    for (let attempt = 0; ; attempt++) {
      const channel = await this.ready(target, signal, true);
      if (!channel.operations.includes(OP_REFRESH)) throw new HelperChannelError('unavailable', 'the worker does not know the refresh');
      let value: unknown;
      try {
        value = await channel.operation(OP_REFRESH, params, { timeoutMs: CHANNEL_REFRESH_TIMEOUT_MS, signal });
      } catch (error) {
        if (attempt === 0 && error instanceof HelperChannelError && error.code === 'closed') continue;
        throw error;
      }
      const states = parseRefreshValue(value, params);
      if (states === undefined) throw new HelperChannelError('protocol', 'The worker answered the refresh with an invalid value.');
      return states;
    }
  }

  /**
   * Plan step 5, PR B: takes the lock of an environment in the worker of `target` and waits at most `waitSeconds` for
   * it. User decision D1: the worker is opened in full (openInFull; the caller ensured the helper image before). Throws
   * EnvironmentLockError: `busy` when another holder kept the lock for the whole wait (user decision D3), `unavailable`
   * when there is no worker (it could not be opened, it reaches another engine, it does not know the operation) or the
   * lock failed in it, with the cause. An AbortError when `signal` aborts. Never goes on without the lock.
   */
  async lock(target: DockerTarget, environmentId: string, waitSeconds: number, signal?: AbortSignal): Promise<HeldEnvironmentLock> {
    let channel: HelperChannel;
    try {
      channel = await this.openInFull(target, signal);
    } catch (error) {
      if (error instanceof HelperChannelError) throw new EnvironmentLockError('unavailable', error.message);
      throw error;
    }
    try {
      return await channel.lock(environmentId, waitSeconds, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof HelperOperationError && error.code === LOCK_BUSY_CODE) throw new EnvironmentLockError('busy', error.message);
      throw new EnvironmentLockError('unavailable', (error as Error).message);
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
