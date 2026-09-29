// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The extension's side of one helper channel (protocol.ts): it starts the script, checks the answer to `hello`, sends
// operations with ids, passes their progress and output on, and resolves each with its result. The progress of the
// helper becomes lines of the local log (user request 2026-09-28), its output goes to the log as it comes. A ping every
// CHANNEL_PING_INTERVAL_MS keeps the script alive; without an answer for CHANNEL_PONG_TIMEOUT_MS the channel counts as
// lost and `docker run` is stopped (the script ends by itself on the host, protocol.ts). The secret of an operation and
// its parameters are never logged. No `vscode`.
import { OutputTooLargeError } from '../process';
import { MAX_CAPTURED_OUTPUT_BYTES, MAX_CAPTURED_STDERR_CHARACTERS } from '../helper/analysisLimits';
import { MAX_BUNDLE_LINE_LENGTH, encodeBundle, readableStderr } from '../loader/pipeLoader';
import { abortError, type Logger, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import {
  CHANNEL_CLEANUP_TIMEOUT_MS,
  CHANNEL_KILL_GRACE_MS,
  CHANNEL_PING_INTERVAL_MS,
  CHANNEL_PONG_TIMEOUT_MS,
  CHANNEL_PROTOCOL_VERSION,
  CHANNEL_SLOT_WAIT_MS,
  LineSplitter,
  MAX_CHANNEL_REQUEST_BYTES,
  MAX_CLIENT_LINE,
  MAX_CONCURRENT_OPERATIONS,
  MAX_OPERATION_TIMEOUT_MS,
  MAX_SERVER_LINE,
  OP_DOCKER,
  encodeMessage,
  isSecret,
  parseDockerOperationParams,
  parseDockerOperationValue,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol';

/** The characters of the end of the stderr of `docker run` that are kept for the log (readableStderr). */
const STDERR_TAIL_LENGTH = 4_000;
/** Time for the start of the container and the answer to `hello` (an SSH connection, the container, Node.js). */
export const CHANNEL_OPEN_TIMEOUT_MS = 120_000;
/** After `close`, `docker run` gets this long to end by itself before it is stopped. */
export const CHANNEL_CLOSE_KILL_MS = 5_000;
/**
 * The extension waits this much longer than the time limit of an operation for its result before it gives up. Review
 * round 1 (P4): longer than the worst case of the script (the kill grace, then the cleanup), so that the caller learns of
 * the time limit only after the containers of the operation are removed.
 */
export const CHANNEL_RESULT_GRACE_MS = CHANNEL_KILL_GRACE_MS + CHANNEL_CLEANUP_TIMEOUT_MS + 15_000;

/**
 * The channel cannot be used. `closed`: it was closed or lost before the operation was sent (the caller can take the
 * way without the channel). `unsendable` (review round 1, P2, S6): the channel cannot carry this request (a line longer
 * than the script reads, parameters beyond the limits of the operation, a secret that cannot be masked); it was not
 * sent, and the caller can take the way without the channel. `lost`: the connection ended while the operation ran (its
 * outcome is not known). `open`: it could not be opened. `protocol`: the script answered with something invalid.
 */
export class HelperChannelError extends Error {
  constructor(
    readonly code: 'closed' | 'unsendable' | 'lost' | 'open' | 'protocol',
    message: string,
  ) {
    super(message);
    this.name = 'HelperChannelError';
  }
}

/** An operation failed in the helper (its code, see protocol.ts), or ended by its time limit. */
export class HelperOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = 'HelperOperationError';
  }
}

export interface OperationOptions {
  /** The GitHub token, if the operation needs it (protocol.ts: never logged, only input of a process). */
  secret?: string;
  timeoutMs?: number;
  /** Cancels the operation in the helper; the promise rejects with an AbortError at once. */
  signal?: AbortSignal;
  /** A step of the operation began (in addition to the line in the log). */
  onProgress?: (step: string, detail?: string) => void;
  /** Output of the operation. Without it, the output goes to the log. */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  /**
   * Review round 6 (R6-2): the longest wait of this call for a free place (default CHANNEL_SLOT_WAIT_MS); HelperChannels
   * gives what is left of its wait for the channel, so the two waits together stay within one.
   */
  slotWaitMs?: number;
}

/** Options of HelperChannel.docker: those of a Docker call, and what to remove on a cancel. */
export interface ChannelDockerOptions extends Pick<RunOptions, 'input' | 'timeoutMs' | 'signal' | 'onStdout' | 'onStderr'>, Pick<OperationOptions, 'slotWaitMs'> {
  /**
   * Review round 1 (S1): a cleanup label value (isCleanupLabel, protocol.ts). The args must put channelStepLabel(cleanup)
   * on each container that the call starts; a cancel removes exactly the containers with that label.
   */
  cleanup?: string;
  /**
   * Review round 1 (S4): the input of the call when it is a secret (the GitHub token): it travels as the secret of the
   * operation and is masked in everything that the helper sends back. Not together with `input`.
   */
  secretInput?: string;
}

export interface HelperChannelOptions {
  logger: Logger;
  /** Named in the log lines, for example the Docker host. */
  name: string;
  openTimeoutMs?: number;
  /** Only for the tests. */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  closeKillMs?: number;
  slotWaitMs?: number;
}

interface Pending {
  op: string;
  /** Review round 4 (M2): the cancel was sent; waiting for the script to confirm it. */
  cancelling?: boolean;
  startedAt: number;
  options: OperationOptions;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

/** One open channel. Create it with HelperChannel.open. */
export class HelperChannel {
  private state: 'opening' | 'open' | 'closed' = 'opening';
  private nextId = 1;
  private pingNumber = 0;
  private lastHeard = Date.now();
  private readonly pending = new Map<number, Pending>();
  /**
   * Review round 1 (L1, L5): the places of MAX_CONCURRENT_OPERATIONS that operations hold (sent, or about to be sent).
   * A place that ends goes straight to the next waiting operation, so no other caller can take it in between.
   */
  private slots = 0;
  /** Operations that wait for a free place; each gets the place of the operation that ended. */
  private readonly waiting: (() => void)[] = [];
  private readonly closeListeners = new Set<(reason: string) => void>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private stderrTail = '';
  private helloReceived: ((message: Extract<ServerMessage, { t: 'hello' }>) => void) | undefined;
  private closedReason: string | undefined;
  private lastUsedAt = Date.now();
  /** The operations that the script knows (its answer to `hello`). */
  operations: readonly string[] = [];
  /** process.version of the script. */
  nodeVersion = '';

  private constructor(
    private readonly process: StartedProcess,
    private readonly options: HelperChannelOptions,
  ) {}

  /**
   * Starts the channel on `process` (`docker run -i … node -e PIPE_LOADER …`, channelRunArgs): writes the script as the
   * first line (encodeBundle; the loader checks it against the hash of its command line), sends `hello`, and
   * waits for its answer. Throws HelperChannelError('open') and stops the process when that fails.
   */
  static async open(process: StartedProcess, script: string, options: HelperChannelOptions): Promise<HelperChannel> {
    const channel = new HelperChannel(process, options);
    await channel.start(script);
    return channel;
  }

  /** True while operations can be sent. */
  get isOpen(): boolean {
    return this.state === 'open';
  }

  /** The number of operations that run or wait. */
  get busy(): number {
    return this.pending.size + this.waiting.length;
  }

  /** The time of the last operation that was sent (Date.now). */
  get lastUsed(): number {
    return this.lastUsedAt;
  }

  /** `listener` is called once when the channel closes or is lost, with the reason. */
  onClose(listener: (reason: string) => void): () => void {
    if (this.state === 'closed') {
      listener(this.closedReason ?? 'closed');
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private async start(script: string): Promise<void> {
    const { logger, name } = this.options;
    const splitter = new LineSplitter(MAX_SERVER_LINE, (line) => this.onLine(line), () => this.lose('a line of the helper is too long'));
    this.process.onStdout((text) => splitter.push(text));
    this.process.onStderr((text) => {
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_LENGTH);
    });
    void this.process.exited.then(({ exitCode, error }) => {
      // Review round 1 of PR #69 (A-R1-3): only the short lines of the tail reach the log (Node.js prints the source line
      // of an uncaught error, and the script is one long line).
      const detail = error ? error.message : readableStderr(this.stderrTail, STDERR_TAIL_LENGTH) || `exit code ${exitCode}`;
      this.lose(`the helper ended (${detail})`);
    });
    // Review round 1 (P6): the loader limits the escaped line, so the same is checked here (plan step 3: the memory guard
    // of the pipe loader, MAX_BUNDLE_LINE_LENGTH).
    const scriptLine = encodeBundle(script);
    if (scriptLine.length - 1 > MAX_BUNDLE_LINE_LENGTH) {
      this.lose('the script is too long');
      throw new HelperChannelError('open', `The script of the helper channel is too long (${scriptLine.length - 1} characters as JSON).`);
    }
    const openTimeoutMs = this.options.openTimeoutMs ?? CHANNEL_OPEN_TIMEOUT_MS;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let removeCloseListener: (() => void) | undefined;
    const hello = new Promise<Extract<ServerMessage, { t: 'hello' }>>((resolve, reject) => {
      this.helloReceived = resolve;
      openTimer = setTimeout(() => reject(new Error(`no answer within ${openTimeoutMs / 1000} seconds`)), openTimeoutMs);
      removeCloseListener = this.onClose((reason) => reject(new Error(reason)));
    });
    this.process.write(scriptLine);
    this.send({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION });
    let answer: Extract<ServerMessage, { t: 'hello' }>;
    try {
      answer = await hello;
    } catch (error) {
      this.lose('it could not be opened');
      throw new HelperChannelError('open', `The helper channel to ${name} could not be opened: ${(error as Error).message}`);
    } finally {
      clearTimeout(openTimer);
      removeCloseListener?.();
    }
    // Review round 1 (L4): the same piece of output may have ended the channel right after the answer.
    if (this.state === 'closed') {
      throw new HelperChannelError('open', `The helper channel to ${name} could not be opened: ${this.closedReason ?? 'it was closed'}.`);
    }
    if (answer.protocol !== CHANNEL_PROTOCOL_VERSION) {
      this.close();
      throw new HelperChannelError('open', `The helper channel to ${name} speaks version ${answer.protocol}, not ${CHANNEL_PROTOCOL_VERSION}.`);
    }
    this.operations = answer.ops;
    this.nodeVersion = answer.node;
    this.state = 'open';
    this.lastHeard = Date.now();
    this.pingTimer = setInterval(() => this.ping(), this.options.pingIntervalMs ?? CHANNEL_PING_INTERVAL_MS);
    logger.info(`Helper channel to ${name} is open (Node.js ${answer.node}; operations: ${answer.ops.join(', ')}).`);
  }

  private send(message: ClientMessage): boolean {
    return this.write(encodeMessage(message));
  }

  /** Writes a line; a failed write loses the channel. */
  private write(line: string): boolean {
    if (this.state === 'closed') return false;
    let written = false;
    try {
      written = this.process.write(line);
    } catch {
      written = false;
    }
    if (!written) this.lose('its input cannot be written');
    return written;
  }

  private ping(): void {
    if (this.state !== 'open') return;
    if (Date.now() - this.lastHeard >= (this.options.pongTimeoutMs ?? CHANNEL_PONG_TIMEOUT_MS)) {
      this.lose('the helper does not answer');
      return;
    }
    this.send({ t: 'ping', n: ++this.pingNumber });
  }

  private onLine(line: string): void {
    const message = parseServerMessage(line);
    if (message === undefined) {
      this.lose('the helper sent an invalid message');
      return;
    }
    this.lastHeard = Date.now();
    switch (message.t) {
      case 'hello':
        this.helloReceived?.(message);
        this.helloReceived = undefined;
        return;
      case 'pong':
        return;
      case 'cancelled': {
        // Review round 4 (M2): the script confirmed the cancel of an operation that had ended there already.
        const pending = this.pending.get(message.id);
        if (!pending?.cancelling) return;
        this.finish(message.id);
        this.logResult(message.id, pending, 'cancelled');
        pending.reject(abortError());
        return;
      }
      case 'progress': {
        const pending = this.pending.get(message.id);
        if (!pending || pending.cancelling) return;
        this.options.logger.info(`[${this.options.name}] ${pending.op}#${message.id}: ${message.step}${message.detail ? ` – ${message.detail}` : ''}`);
        pending.options.onProgress?.(message.step, message.detail);
        return;
      }
      case 'log': {
        const pending = this.pending.get(message.id);
        if (!pending || pending.cancelling) return;
        const line = `[${this.options.name}] ${pending.op}#${message.id}: ${message.text}`;
        if (message.level === 'warn') this.options.logger.warn(line);
        else this.options.logger.info(line);
        return;
      }
      case 'out': {
        const pending = this.pending.get(message.id);
        if (!pending || pending.cancelling) return;
        if (pending.options.onOutput) pending.options.onOutput(message.stream, message.data);
        else this.options.logger.output(message.data);
        return;
      }
      case 'result': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.finish(message.id);
        // Review round 4 (M2): a result after the cancel was sent: the script ends it (or removes its containers when
        // the cancel crossed a result), so the caller gets the cancel it asked for.
        if (pending.cancelling) {
          this.logResult(message.id, pending, 'cancelled');
          pending.reject(abortError());
          return;
        }
        this.logResult(message.id, pending, message.ok ? undefined : message.error.message);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new HelperOperationError(message.error.code, message.error.message, message.timedOut));
        return;
      }
    }
  }

  /** The line of the end of an operation of steps (the `docker` operation logs its call itself). */
  private logResult(id: number, pending: Pending, failure: string | undefined): void {
    if (pending.op === OP_DOCKER && failure === undefined) return;
    const seconds = ((Date.now() - pending.startedAt) / 1000).toFixed(1);
    const line = `[${this.options.name}] ${pending.op}#${id}: ${failure === undefined ? 'done' : `failed: ${failure}`} after ${seconds} s.`;
    if (failure === undefined) this.options.logger.info(line);
    else this.options.logger.warn(line);
  }

  /** Removes an operation from the pending ones and gives its place to the next waiting one. */
  private finish(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.onAbort) pending.options.signal?.removeEventListener('abort', pending.onAbort);
    // Review round 1 (P10): the idle time counts from the end of the last operation, not from its start.
    this.lastUsedAt = Date.now();
    this.releaseSlot();
    return pending;
  }

  /** Gives a place to the next waiting operation, or frees it. */
  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.slots--;
  }

  /**
   * Waits for the place of an operation that ends (MAX_CONCURRENT_OPERATIONS are held). Review round 5 (F2): at most
   * `waitMs`; then `unsendable` (not sent), so the caller takes the way without the channel.
   */
  private waitForSlot(signal: AbortSignal | undefined, waitMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const leave = () => {
        const index = this.waiting.indexOf(go);
        if (index >= 0) this.waiting.splice(index, 1);
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
      };
      const go = () => {
        leave();
        resolve();
      };
      const onAbort = () => {
        leave();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        leave();
        reject(new HelperChannelError('unsendable', `The helper channel to ${this.options.name} has no free place in time.`));
      }, waitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(go);
    });
  }

  /**
   * Runs the operation `op` in the helper. Resolves with its value; rejects with HelperOperationError (a failure or its
   * time limit), an AbortError (the signal), or HelperChannelError (`closed` or `unsendable`: not sent; `lost`: the
   * channel ended while it ran).
   */
  async operation(op: string, params: unknown, options: OperationOptions = {}): Promise<unknown> {
    if (options.signal?.aborted) throw abortError();
    if (this.state !== 'open') throw new HelperChannelError('closed', `The helper channel to ${this.options.name} is closed.`);
    // Review round 2 (A5): what the script refuses as a whole is not sent: a time limit that is no whole number of
    // milliseconds from 1 to MAX_OPERATION_TIMEOUT_MS; a missing `params` travels as null (JSON drops undefined).
    if (options.timeoutMs !== undefined && !(Number.isInteger(options.timeoutMs) && options.timeoutMs >= 1 && options.timeoutMs <= MAX_OPERATION_TIMEOUT_MS)) {
      throw new HelperChannelError('unsendable', `The time limit ${options.timeoutMs} cannot be sent through the helper channel.`);
    }
    const id = this.nextId++;
    const message: ClientMessage = { t: 'op', id, op, params: params === undefined ? null : params };
    if (options.secret !== undefined) {
      if (!isSecret(options.secret)) throw new HelperChannelError('unsendable', 'The secret cannot be sent through the helper channel.');
      message.secret = options.secret;
    }
    if (options.timeoutMs !== undefined) message.timeoutMs = options.timeoutMs;
    let line = encodeMessage(message);
    // Review round 1 (P2): a longer line would end the whole channel in the script (and every operation on it). Review
    // round 5 (F3): the limit of what the channel carries is lower (MAX_CHANNEL_REQUEST_BYTES), so the pings behind a
    // request are not late on a slow link.
    if (line.length - 1 > MAX_CLIENT_LINE || Buffer.byteLength(line, 'utf8') - 1 > MAX_CHANNEL_REQUEST_BYTES) {
      throw new HelperChannelError('unsendable', `The request ${op} is too long for the helper channel (${line.length} characters).`);
    }
    // A free place is taken at once, so the operation is written in the same turn as the call.
    const queuedAt = Date.now();
    if (this.slots < MAX_CONCURRENT_OPERATIONS) this.slots++;
    else {
      const waitMs = Math.min(options.slotWaitMs ?? this.options.slotWaitMs ?? CHANNEL_SLOT_WAIT_MS, options.timeoutMs ?? Number.POSITIVE_INFINITY);
      await this.waitForSlot(options.signal, Math.max(0, waitMs));
    }
    // Review round 6 (R6-2): the time limit counts from the call, so the wait for a place is taken from it (the line only
    // gets shorter, so its limits still hold).
    let timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && Date.now() > queuedAt) {
      timeoutMs = Math.max(1, timeoutMs - (Date.now() - queuedAt));
      message.timeoutMs = timeoutMs;
      line = encodeMessage(message);
    }
    // Review round 1 (L1): the signal or the channel may have ended while it waited for its place.
    if (options.signal?.aborted || this.state !== 'open') {
      this.releaseSlot();
      if (options.signal?.aborted) throw abortError();
      throw new HelperChannelError('closed', `The helper channel to ${this.options.name} is closed.`);
    }
    // Review round 1 (L3): the operation counts as pending only once it was written, so a failed write is `closed`
    // (not sent), never `lost`. The answers come later (stream events), never during the write.
    if (!this.write(line)) {
      this.releaseSlot();
      throw new HelperChannelError('closed', `The helper channel to ${this.options.name} is closed.`);
    }
    this.lastUsedAt = Date.now();
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { op, startedAt: Date.now(), options, resolve, reject };
      // The `docker` operation logs its one call itself; an operation of steps gets a line at its start and its end.
      if (op !== OP_DOCKER) this.options.logger.info(`[${this.options.name}] ${op}#${id}: started.`);
      this.pending.set(id, pending);
      if (timeoutMs !== undefined) {
        // The helper ends the operation at its time limit and answers; this is for a helper that does not answer.
        pending.timer = setTimeout(() => {
          this.send({ t: 'cancel', id });
          this.finish(id);
          this.logResult(id, pending, 'the helper did not answer in time');
          reject(new HelperOperationError('timeout', `The operation ${op} did not end in time.`, true));
        }, timeoutMs + CHANNEL_RESULT_GRACE_MS);
      }
      if (options.signal) {
        // Review round 4 (M2): the AbortError comes when the script confirmed the cancel (its result, or `cancelled`),
        // usually within a round trip; when the channel is lost first, the operation rejects as lost (outcome unknown).
        pending.onAbort = () => {
          pending.cancelling = true;
          if (!this.send({ t: 'cancel', id }) && this.pending.has(id)) {
            this.finish(id);
            reject(new HelperChannelError('lost', `The cancel of ${op} could not be sent to ${this.options.name}.`));
          }
        };
        options.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
    });
  }

  /**
   * One Docker call in the helper (the operation `docker`), with the result of ProcessRunner.run: the standard output
   * (at most MAX_CAPTURED_OUTPUT_BYTES, beyond: the call is cancelled and OutputTooLargeError thrown), the end of the
   * standard error output, and `timedOut` after its time limit. Rejects as `operation`.
   */
  async docker(args: readonly string[], options: ChannelDockerOptions = {}): Promise<RunResult> {
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let tooLarge = false;
    const tooLargeAbort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, tooLargeAbort.signal]) : tooLargeAbort.signal;
    if (options.input !== undefined && options.secretInput !== undefined) throw new Error('A Docker call has either an input or a secret input.');
    const params: Record<string, unknown> = { args: [...args] };
    if (options.input !== undefined) params.input = options.input;
    if (options.secretInput !== undefined) params.inputIsSecret = true;
    if (options.cleanup !== undefined) params.cleanup = options.cleanup;
    // Review round 1 (P2): a call beyond the limits of the operation is not sent; the caller takes the way without it.
    if (parseDockerOperationParams(params) === undefined) {
      throw new HelperChannelError('unsendable', 'The Docker call is beyond the limits of the helper channel.');
    }
    try {
      const value = await this.operation(OP_DOCKER, params, {
        secret: options.secretInput,
        timeoutMs: options.timeoutMs,
        slotWaitMs: options.slotWaitMs,
        signal,
        onOutput: (stream, text) => {
          if (stream === 'stdout') {
            if (tooLarge) return;
            stdoutBytes += Buffer.byteLength(text, 'utf8');
            if (stdoutBytes > MAX_CAPTURED_OUTPUT_BYTES) {
              tooLarge = true;
              stdout = '';
              tooLargeAbort.abort();
              return;
            }
            stdout += text;
            options.onStdout?.(text);
          } else {
            stderr += text;
            if (stderr.length > 2 * MAX_CAPTURED_STDERR_CHARACTERS) stderr = stderr.slice(-MAX_CAPTURED_STDERR_CHARACTERS);
            options.onStderr?.(text);
          }
        },
      });
      const checked = parseDockerOperationValue(value);
      if (checked === undefined) throw new HelperChannelError('protocol', 'The helper answered the docker operation with an invalid value.');
      if (stderr.length > MAX_CAPTURED_STDERR_CHARACTERS) stderr = stderr.slice(-MAX_CAPTURED_STDERR_CHARACTERS);
      return { exitCode: checked.exitCode, stdout, stderr, timedOut: false };
    } catch (error) {
      if (tooLarge) throw new OutputTooLargeError('docker', MAX_CAPTURED_OUTPUT_BYTES);
      if (error instanceof HelperOperationError && error.timedOut) {
        return { exitCode: null, stdout, stderr: stderr.slice(-MAX_CAPTURED_STDERR_CHARACTERS), timedOut: true };
      }
      throw error;
    }
  }

  /**
   * Closes the channel: its input ends, so the script cancels what still runs and exits; `docker run` is stopped if it
   * has not ended after CHANNEL_CLOSE_KILL_MS. Operations that still run reject with HelperChannelError('lost').
   */
  close(): void {
    if (this.state === 'closed') return;
    this.shutDown('closed', 'it was closed');
    try {
      this.process.end();
    } catch {
      // It ended already.
    }
    const timer = setTimeout(() => this.process.kill(), this.options.closeKillMs ?? CHANNEL_CLOSE_KILL_MS);
    void this.process.exited.then(() => clearTimeout(timer));
  }

  /**
   * Review round 4 (M3): closes the channel at once (the window closes or the extension host ends): `docker run` and the
   * programs that it started get SIGKILL now, not after CHANNEL_CLOSE_KILL_MS, so nothing is left on this computer.
   * The container on the host ends by the end of its input (the connection ends) or at the latest by its silence.
   */
  closeNow(): void {
    if (this.state !== 'closed') this.shutDown('closed', 'it was closed');
    if (this.process.killNow) this.process.killNow();
    else this.process.kill();
  }

  /** The channel is lost: `docker run` is stopped at once. */
  private lose(reason: string): void {
    if (this.state === 'closed') return;
    if (this.state === 'open') this.options.logger.warn(`The helper channel to ${this.options.name} was lost: ${reason}.`);
    this.shutDown('lost', reason);
    this.process.kill();
  }

  private shutDown(kind: 'closed' | 'lost', reason: string): void {
    this.state = 'closed';
    this.closedReason = reason;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const id of [...this.pending.keys()]) {
      const pending = this.finish(id);
      pending?.reject(
        new HelperChannelError(
          'lost',
          kind === 'closed'
            ? `The helper channel to ${this.options.name} was closed while ${pending.op} ran.`
            : `The helper channel to ${this.options.name} was lost while ${pending.op} ran: ${reason}.`,
        ),
      );
    }
    // Each waiting operation gets a place, sees the closed channel, and gives it back.
    for (const go of this.waiting.splice(0)) go();
    for (const listener of [...this.closeListeners]) {
      try {
        listener(reason);
      } catch {
        // A listener must not stop the others.
      }
    }
    this.closeListeners.clear();
  }
}
