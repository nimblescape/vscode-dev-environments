// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The logic of the script of the helper channel (src/core/helperChannel/protocol.ts): it reads the messages of the
// extension, runs each operation (operations.ts) with an OperationContext, and answers with progress, output, and one
// result per operation. It ends by itself when the connection is lost (the four ways in protocol.ts); before it exits,
// it cancels every operation that runs (their signals abort) and waits for their results. It never writes the secret or
// the parameters of an operation anywhere. Plan step 11I1, PR B1: the removal of the containers of a cleanup label after
// a cancel (only the removed `docker` operation used it) is gone. Plan step 11I (PR A): so are the Docker calls of the
// script (OperationContext.docker, the last ones were the probe and the sweep): an operation acts on the engine only
// through its port (DockerEngine, section 0 of the plan), and the script starts no process of its own.
import {
  CHANNEL_CLEANUP_TIMEOUT_MS,
  CHANNEL_KILL_GRACE_MS,
  CHANNEL_PROTOCOL_VERSION,
  CHANNEL_SERVER_IDLE_EXIT_MS,
  CHANNEL_SILENCE_EXIT_MS,
  LineSplitter,
  MAX_CLIENT_LINE,
  MAX_SERVER_LINE,
  OUTPUT_CHUNK_CHARACTERS,
  encodeMessage,
  parseClientMessage,
  refusedOperationId,
  isAskKind,
  MAX_OPEN_ASKS,
  MAX_MASKED_SECRETS,
  MAX_SECRETS,
  type AnswerRequest,
  type AskKind,
  type Secrets,
  type OperationFailure,
  type OperationRequest,
  type ServerMessage,
} from '../core/helperChannel/protocol';
import { StreamRedactor, redact, redactValue } from '../core/helperChannel/protocol';
import { abortError } from '../core/ports';

// Plan step 6, PR B: moved to protocol.ts (the extension masks the output of a batch step too).
export { StreamRedactor, redact };

/** Review round 2 (C1): the longest text of a log or progress message (a longer one is cut, with `…`). */
export const MAX_LOG_TEXT = 16 * 1024;

/**
 * What an operation can do. Its signal aborts when it is cancelled (by the extension, at its time limit, or at the end of
 * the script). Plan step 11I (PR A): no Docker call (`docker`, removed): the engine only through the port of the
 * operation (DockerEngine).
 */
export interface OperationContext {
  readonly signal: AbortSignal;
  /**
   * Plan step 11A: the named secrets of the request (SECRET_TOKEN, SECRET_REGISTRY, …), with those that the answers of its
   * requests added. Only ever input of a process or the header of a request to the engine; each is masked in all that
   * the operation sends back.
   */
  readonly secrets: Secrets;
  /** Plan step 11A: true when the operation has no secret at all. */
  hasNoSecret(): boolean;
  /**
   * Plan step 11E3a (decision B1 of 2026-10-05): the operation no longer holds the secret `name` (it asks again when it
   * needs it); its value stays masked in all that the operation sends back (maskedValues).
   */
  forgetSecret(name: string): void;
  /**
   * Plan step 11E1 (review round 1 of PR #102, A-M1): every secret value that the operation ever held (also one that a
   * later answer replaced), as the server masks them, for the output that an operation keeps of its own processes.
   */
  maskedValues(): readonly string[];
  /**
   * Plan step 11A: a request to the extension (AskKind) that the operation waits for: resolves with the value of the
   * answer (its secrets join `secrets`); rejects with OperationError (the answer's failure, or `unsupported` when the
   * extension has no handler), or with an AbortError when the operation ends.
   */
  ask(kind: AskKind, payload: unknown): Promise<unknown>;
  progress(step: string, detail?: string): void;
  /** A line of the log of the extension. */
  log(text: string, level?: 'info' | 'warn'): void;
  output(stream: 'stdout' | 'stderr', text: string): void;
  /**
   * Plan step 11G3: output that the operation reads from the engine itself (the attached batch helper) is paused and
   * resumed while the connection of the extension is congested (review round 2, A2), until the returned function removes
   * it or the operation ends. Optional, for the fake contexts of the tests.
   */
  pausable?(target: Pausable): () => void;
}

/** Plan step 11G3: output whose reading can be paused (OperationContext.pausable). */
export interface Pausable {
  pause(): void;
  resume(): void;
}

/** A failure with a code for the extension (for example `invalid` for parameters that the check refused). */
export class OperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

/** An operation: checks its parameters itself; resolves with its value (JSON). */
export type OperationHandler = (params: unknown, context: OperationContext) => Promise<unknown>;

export interface ServerDeps {
  /** Writes a line to the standard output. False when it cannot be written anymore (the connection is gone). */
  write(text: string): boolean;
  operations: Readonly<Record<string, OperationHandler>>;
  /**
   * Review round 2 (A2): true while more than CHANNEL_OUTPUT_HIGH_WATER characters wait to be written (the connection is
   * slower than the output), and `listener` once they are written. While congested, the output that the operations read
   * themselves (OperationContext.pausable) is paused.
   */
  congested?(): boolean;
  onDrain?(listener: () => void): void;
  /** Ends the process. Called once. */
  exit(code: number): void;
  /** Only for the tests: shorter times (main.ts: DEVENV_CHANNEL_SILENCE_MS). */
  silenceMs?: number;
  idleMs?: number;
}

/**
 * The hard deadline of the exit after the shutdown began: the grace of the processes of the operations (a step of the
 * batch helper, the batch helper itself: SIGTERM, then SIGKILL after CHANNEL_KILL_GRACE_MS) and the removal of the batch
 * helpers by their label (CHANNEL_CLEANUP_TIMEOUT_MS), with a margin.
 */
export const SHUTDOWN_DEADLINE_MS = CHANNEL_KILL_GRACE_MS + CHANNEL_CLEANUP_TIMEOUT_MS + 5_000;

interface Running {
  request: OperationRequest;
  controller: AbortController;
  /** Plan step 11G3: the output that the operation reads from the engine itself (OperationContext.pausable). */
  pausables: Set<Pausable>;
  cancelled: boolean;
  timedOut: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** Resolves when the result was sent. */
  finished: Promise<void>;
  /** The output of the operation, with its secrets masked (also when a chunk splits one). */
  redactors: Record<'stdout' | 'stderr', StreamRedactor>;
  /** Plan step 11A: the secrets of the request and of the answers to its requests, by name. */
  secrets: Record<string, string>;
  /**
   * Review round 1 of plan step 11A (A-R1-2): every value that the operation ever held, masked until its end, also when
   * an answer gave its name a new value.
   */
  masked: string[];
  /** Review round 1 of plan step 11A (A-R1-6): no new request once the operation ended. */
  asksClosed: boolean;
  /** Plan step 11A: the open requests to the extension, by their number. */
  asks: Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>;
  nextAsk: number;
}

/** The logic of the script: one instance per process. */
export class ChannelServer {
  private readonly running = new Map<number, Running>();
  /** Review round 2 (A2): the output that the operations read is paused until the waiting answers are written. */
  private outputPaused = false;
  private readonly splitter: LineSplitter;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private readonly silenceMs: number;
  private readonly idleMs: number;

  constructor(private readonly deps: ServerDeps) {
    this.silenceMs = deps.silenceMs ?? CHANNEL_SILENCE_EXIT_MS;
    this.idleMs = deps.idleMs ?? CHANNEL_SERVER_IDLE_EXIT_MS;
    this.splitter = new LineSplitter(MAX_CLIENT_LINE, (line) => this.onLine(line), () => this.shutdown());
  }

  /** Starts the timers; call once before the first input. */
  start(): void {
    this.touchSilence();
    this.touchIdle();
  }

  /**
   * Text of the standard input. Review round 5 (F3): any text that arrives shows that the connection lives, also in the
   * middle of a long request (the pings wait behind it), so the silence counts from it; a hung connection sends none.
   */
  input(text: string): void {
    if (this.stopping) return;
    if (text !== '') this.touchSilence();
    this.splitter.push(text);
  }

  /** The standard input ended or failed: the connection is gone. */
  inputEnded(): void {
    this.shutdown();
  }

  /** True until it begins to exit. */
  get active(): boolean {
    return !this.stopping;
  }

  private send(message: ServerMessage): void {
    // While it exits, only the results of the cancelled operations still go out (if anyone reads them).
    if (this.stopping && message.t !== 'result') return;
    let line = encodeMessage(message);
    // Review round 2 (C1): a line longer than the extension reads would end the whole channel there; a result that
    // large fails instead (log and progress texts are cut before, output comes in pieces).
    if (line.length - 1 > MAX_SERVER_LINE && message.t === 'result') {
      line = encodeMessage({
        t: 'result',
        id: message.id,
        ok: false,
        error: { code: 'tooLarge', message: 'The result of the operation is too large for the helper channel.' },
        cancelled: false,
        timedOut: false,
      });
    }
    if (line.length - 1 > MAX_SERVER_LINE) return;
    let written = false;
    try {
      written = this.deps.write(line);
    } catch {
      written = false;
    }
    // The standard output cannot be written: nobody reads the answers anymore.
    if (!written) {
      this.shutdown();
      return;
    }
    if (!this.outputPaused && this.deps.congested?.() === true) this.pauseOutput();
  }

  /**
   * Review round 2 (A2): pauses the output that the operations read from the engine themselves (plan step 11G3:
   * OperationContext.pausable) until the waiting answers are written. Plan step 11I (PR A): the only output that it
   * pauses (before: also the output of the Docker calls of the script, removed).
   */
  private pauseOutput(): void {
    this.outputPaused = true;
    for (const run of this.running.values()) {
      for (const target of run.pausables) target.pause();
    }
    this.deps.onDrain?.(() => {
      this.outputPaused = false;
      for (const run of this.running.values()) {
        for (const target of run.pausables) target.resume();
      }
    });
  }

  /** The output of an operation as `out` messages, in pieces of at most OUTPUT_CHUNK_CHARACTERS. */
  private sendOutput(id: number, stream: 'stdout' | 'stderr'): (text: string) => void {
    return (text) => {
      for (let start = 0; start < text.length; start += OUTPUT_CHUNK_CHARACTERS) {
        this.send({ t: 'out', id, stream, data: text.slice(start, start + OUTPUT_CHUNK_CHARACTERS) });
      }
    };
  }

  private touchSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.shutdown(), this.silenceMs);
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.running.size === 0) this.shutdown();
      else this.touchIdle();
    }, this.idleMs);
  }

  private onLine(line: string): void {
    const message = parseClientMessage(line);
    if (message === undefined) {
      const id = refusedOperationId(line);
      if (id !== undefined && !this.running.has(id)) this.fail(id, { code: 'invalid', message: 'The request is invalid.' }, false, false);
      return;
    }
    this.touchSilence();
    switch (message.t) {
      case 'hello':
        this.send({ t: 'hello', protocol: CHANNEL_PROTOCOL_VERSION, node: process.version, ops: Object.keys(this.deps.operations).sort() });
        return;
      case 'ping':
        this.send({ t: 'pong', n: message.n });
        return;
      case 'cancel': {
        const run = this.running.get(message.id);
        if (run) {
          this.cancel(run, false);
          return;
        }
        // Review round 4 (M2): the extension reports the cancel only when the script confirmed it.
        this.send({ t: 'cancelled', id: message.id });
        return;
      }
      case 'op':
        this.touchIdle();
        this.startOperation(message);
        return;
      case 'answer':
        this.answer(message);
        return;
    }
  }

  /**
   * Plan step 11A: sends the request `kind` of the operation `run` to the extension and waits for its answer. At most
   * MAX_OPEN_ASKS at a time; the payload is masked as everything that the script sends.
   */
  private ask(run: Running, kind: AskKind, payload: unknown): Promise<unknown> {
    if (run.asksClosed || run.controller.signal.aborted || !this.running.has(run.request.id)) return Promise.reject(abortError());
    if (!isAskKind(kind)) return Promise.reject(new OperationError('invalid', `There is no request ${String(kind)}.`));
    if (run.asks.size >= MAX_OPEN_ASKS) return Promise.reject(new OperationError('invalid', 'Too many open requests to the extension.'));
    const ask = run.nextAsk++;
    // Review round 1 of plan step 11A (A-R1-1, A-R1-4): masked value by value before it is encoded.
    let message: ServerMessage;
    try {
      message = { t: 'ask', id: run.request.id, ask, kind, payload: redactValue(payload ?? null, run.masked) ?? null };
      if (encodeMessage(message).length - 1 > MAX_SERVER_LINE) return Promise.reject(new OperationError('invalid', 'The request to the extension is too large.'));
    } catch {
      return Promise.reject(new OperationError('invalid', 'The request to the extension cannot be sent.'));
    }
    return new Promise<unknown>((resolve, reject) => {
      run.asks.set(ask, { resolve, reject });
      this.send(message);
    });
  }

  /** Plan step 11A: the answer of the extension to a request of a running operation (others are ignored). */
  private answer(message: AnswerRequest): void {
    const run = this.running.get(message.id);
    const pending = run?.asks.get(message.ask);
    if (run === undefined || pending === undefined) return;
    run.asks.delete(message.ask);
    if (!message.ok) {
      pending.reject(new OperationError(message.error.code, message.error.message));
      return;
    }
    if (message.secrets !== undefined) {
      const merged = { ...run.secrets, ...message.secrets };
      if (Object.keys(merged).length > MAX_SECRETS) {
        pending.reject(new OperationError('invalid', 'The answer brings more secrets than an operation can hold.'));
        return;
      }
      // Review round 2 of plan step 11A (A-R2-4): every value stays masked, at most MAX_MASKED_SECRETS of them.
      const added = [...new Set(Object.values(message.secrets))].filter((value) => !run.masked.includes(value));
      if (run.masked.length + added.length > MAX_MASKED_SECRETS) {
        pending.reject(new OperationError('invalid', 'The answer brings more secrets than an operation can mask.'));
        return;
      }
      Object.assign(run.secrets, message.secrets);
      run.masked.push(...added);
    }
    pending.resolve(message.value);
  }

  /** Plan step 11A: the open requests of an operation that ends are rejected with an AbortError. */
  private endAsks(run: Running): void {
    run.asksClosed = true;
    for (const pending of run.asks.values()) pending.reject(abortError());
    run.asks.clear();
  }

  private fail(id: number, error: OperationFailure, cancelled: boolean, timedOut: boolean): void {
    this.send({ t: 'result', id, ok: false, error, cancelled, timedOut });
  }

  private startOperation(request: OperationRequest): void {
    if (this.running.has(request.id)) {
      this.fail(request.id, { code: 'invalid', message: 'An operation with this id runs already.' }, false, false);
      return;
    }
    const handler = Object.prototype.hasOwnProperty.call(this.deps.operations, request.op) ? this.deps.operations[request.op] : undefined;
    if (handler === undefined) {
      this.fail(request.id, { code: 'unknown', message: `The helper does not know the operation ${request.op}.` }, false, false);
      return;
    }
    let resolveFinished!: () => void;
    const id = request.id;
    const secrets: Record<string, string> = { ...request.secrets };
    const masked = Object.values(secrets);
    const values = () => masked;
    const run: Running = {
      request,
      controller: new AbortController(),
      pausables: new Set(),
      cancelled: false,
      timedOut: false,
      finished: new Promise<void>((resolve) => (resolveFinished = resolve)),
      redactors: { stdout: new StreamRedactor(values, this.sendOutput(id, 'stdout')), stderr: new StreamRedactor(values, this.sendOutput(id, 'stderr')) },
      secrets,
      masked,
      asksClosed: false,
      asks: new Map(),
      nextAsk: 1,
    };
    this.running.set(request.id, run);
    if (request.timeoutMs !== undefined) run.timeoutTimer = setTimeout(() => this.cancel(run, true), request.timeoutMs);
    const context = this.contextOf(run);
    let outcome: { ok: true; value: unknown } | { ok: false; error: OperationFailure };
    void (async () => {
      try {
        const value = await handler(request.params, context);
        outcome = { ok: true, value };
      } catch (error) {
        outcome = {
          ok: false,
          // Review round 1 of PR #89 (A-R1-4): the message may carry text of the engine or a registry: masked too.
          error:
            error instanceof OperationError
              ? { code: error.code, message: redact(error.message, masked) }
              : { code: 'failed', message: redact(messageOf(error), masked) },
        };
      }
      if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
      this.endAsks(run);
      // Plan step 11G3: the output that it read from the engine itself is no longer paused with the others.
      for (const target of run.pausables) if (this.outputPaused) target.resume();
      run.pausables.clear();
      run.redactors.stdout.flush();
      run.redactors.stderr.flush();
      const aborted = run.cancelled || run.timedOut;
      this.running.delete(request.id);
      this.touchIdle();
      if (aborted) {
        const message = run.timedOut ? 'The operation did not end in time.' : 'The operation was cancelled.';
        this.fail(request.id, { code: run.timedOut ? 'timeout' : 'cancelled', message }, run.cancelled, run.timedOut);
      } else if (outcome.ok) {
        // Review round 1 of plan step 11A (pre-existing gap): the value of a result is masked too.
        let value: unknown;
        try {
          value = redactValue(outcome.value, masked);
        } catch {
          this.fail(request.id, { code: 'invalid', message: 'The result of the operation cannot be sent.' }, false, false);
          resolveFinished();
          return;
        }
        this.send({ t: 'result', id: request.id, ok: true, value });
      } else {
        this.fail(request.id, outcome.error, false, false);
      }
      resolveFinished();
    })();
  }

  private contextOf(run: Running): OperationContext {
    const id = run.request.id;
    const mask = (text: string) => redact(text, run.masked);
    return {
      signal: run.controller.signal,
      get secrets(): Secrets {
        return { ...run.secrets };
      },
      hasNoSecret: () => Object.keys(run.secrets).length === 0,
      forgetSecret: (name) => void delete run.secrets[name],
      maskedValues: () => [...run.masked],
      ask: (kind, payload) => this.ask(run, kind, payload),
      progress: (step, detail) =>
        this.send(
          detail === undefined ? { t: 'progress', id, step: clip(mask(step)) } : { t: 'progress', id, step: clip(mask(step)), detail: clip(mask(detail)) },
        ),
      log: (text, level = 'info') => this.send({ t: 'log', id, level, text: clip(mask(text)) }),
      output: (stream, text) => run.redactors[stream].push(text),
      pausable: (target) => {
        if (this.running.get(id) !== run) return () => {};
        run.pausables.add(target);
        if (this.outputPaused) target.pause();
        return () => {
          // Never left paused: it may still be read after it was removed (the end of the batch helper).
          if (run.pausables.delete(target) && this.outputPaused) target.resume();
        };
      },
    };
  }

  /**
   * Cancels an operation: its signal aborts and its open requests to the extension end. Its result follows when its
   * handler ended (plan step 11I, PR A: the script has no Docker call of its own to end; before: SIGTERM, then SIGKILL).
   */
  private cancel(run: Running, timedOut: boolean): void {
    if (run.cancelled || run.timedOut) return;
    if (timedOut) run.timedOut = true;
    else run.cancelled = true;
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    run.controller.abort();
    this.endAsks(run);
  }

  /**
   * Ends the script: no more messages are read; every operation is cancelled (its signal aborts); then exit, once every
   * cancelled operation sent its result. A hard deadline (SHUTDOWN_DEADLINE_MS) makes sure that it exits even when a
   * handler does not end.
   */
  shutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const deadline = setTimeout(() => this.deps.exit(0), SHUTDOWN_DEADLINE_MS);
    const runs = [...this.running.values()];
    for (const run of runs) this.cancel(run, false);
    void Promise.all(runs.map((run) => run.finished)).then(() => {
      clearTimeout(deadline);
      this.deps.exit(0);
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Review round 2 (C1): a text of a log or progress message, cut to MAX_LOG_TEXT characters. */
export function clip(text: string): string {
  return text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT)}…` : text;
}
