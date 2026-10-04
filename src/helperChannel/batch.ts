// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the operations `batch`, `batchStep` and `batchChunk` of the worker (src/core/helperChannel/batch.ts).
// `batch` starts one helper container per operation with the volume of the environment and talks to it as a client of
// its ChannelServer (the HelperChannel of the extension, over the open input and the output of its `docker run -i`);
// `batchStep` relays one step to it, with its secret, its time limit and its cancel, and passes its progress, log
// lines and output back; `batchChunk` keeps the pieces of an input that is longer than one request. The helper ends
// with the operation: its input ends (it exits; `--rm`), and the worker removes the container by its session label. It
// also ends by itself as the worker does (the end of its input when the worker ends, its silence, its idle time).
import * as fs from 'fs';
import {
  BATCH_MISSING_VOLUME_CODE,
  BATCH_READY_STEP,
  BATCH_HOLD_LIMIT_MS,
  MAX_BATCH_INPUT_CHARACTERS,
  MAX_CONCURRENT_BATCHES,
  batchRunArgs,
  batchVolumeArgs,
  parseBatchChunkParams,
  parseBatchParams,
  parseBatchStepParams,
  parseBatchStepValue,
  type BatchParams,
} from '../core/helperChannel/batch';
import { HelperChannel, HelperChannelError, HelperOperationError, collectBatchStep, type HelperBatchSession } from '../core/helperChannel/helperChannel';
import { MAX_CLIENT_LINE, channelStepLabel, newCleanupLabel } from '../core/helperChannel/protocol';
import { MAX_CAPTURED_OUTPUT_BYTES } from '../core/helper/analysisLimits';
import { bundleHash } from '../core/loader/pipeLoader';
import { abortError, isAbortError, type Logger, type StartedProcess } from '../core/ports';
import { abortedOrAfter } from './lock';
import { OperationError, type OperationContext, type OperationHandler } from './server';

// Plan step 6, PR B: the code lives with the messages (the client names it).
export { BATCH_MISSING_VOLUME_CODE };

/** A batch session of this worker. */
export interface BatchSession {
  /** The client of the helper, once it answered. */
  channel?: HelperChannel;
  /** The context of the step that runs (its log lines go there); at most one at a time. */
  step?: OperationContext;
  /** The inputs of `batchChunk` by their ID, and their characters in all. */
  inputs: Map<string, string>;
  inputSize: number;
}

export interface BatchDeps {
  sessions: Map<string, BatchSession>;
  /** The script of this process, as the loader stored it (the helper is loaded with the same script). */
  readScript(): string;
  /** Only for the tests. */
  holdLimitMs?: number;
  openTimeoutMs?: number;
}

/** The deps of the worker: its own script file (the loader `require`d it from there). */
export function batchDeps(): BatchDeps {
  return { sessions: new Map(), readScript: () => fs.readFileSync(__filename, 'utf8') };
}

function sessionOf(deps: BatchDeps, session: string): BatchSession & { channel: HelperChannel } {
  const entry = deps.sessions.get(session);
  if (entry?.channel === undefined || !entry.channel.isOpen) throw new OperationError('closed', 'The batch session is not open.');
  return entry as BatchSession & { channel: HelperChannel };
}

/** Removes the containers of the session label (never by a name), when the operation ended without a cancel. */
async function removeByLabel(context: OperationContext, session: string): Promise<void> {
  const listed = await context.docker(['ps', '-aq', '--no-trunc', '--filter', `label=${channelStepLabel(session)}`]);
  const ids = listed.stdout.split('\n').map((line) => line.trim()).filter((line) => /^[0-9a-f]{12,64}$/.test(line));
  if (ids.length > 0) await context.docker(['rm', '-f', ...ids]);
}

/** A batch helper that runs, with the client of its ChannelServer. */
interface StartedBatchHelper {
  channel: HelperChannel;
  /** Ends it: its input ends (it exits; `--rm`), and its containers are removed by the session label. Never rejects. */
  finish(): Promise<void>;
}

/**
 * Starts the batch helper of `p` (the volume must exist) and opens the client of its ChannelServer; on a failure,
 * everything that it started is ended before it throws an OperationError. Its log lines go to `logTo()`. Plan step 11B3b:
 * the `batch` operation and the worker's own batch session (workerBatchSession) start it the same way.
 */
async function startBatchHelper(deps: BatchDeps, context: OperationContext, p: BatchParams, logTo: () => Pick<OperationContext, 'log'>): Promise<StartedBatchHelper> {
  const ended = new AbortController();
  let call: Promise<unknown> | undefined;
  let channel: HelperChannel | undefined;
  const finish = async (): Promise<void> => {
    // Its input ends: the helper cancels its step and exits (`--rm`); the call is ended after CHANNEL_CLOSE_KILL_MS.
    channel?.close();
    if (channel === undefined) ended.abort();
    await call;
    // On a cancel the server removes the containers of the session label; otherwise this does (once one was started).
    // Plan step 11B3b: never rejects (a session that the worker's own flow closes must not fail it); a failure is logged.
    if (call !== undefined && !context.signal.aborted) {
      await removeByLabel(context, p.session).catch((error: unknown) => context.log(`The batch helper ${p.session.slice(0, 8)} could not be removed: ${(error as Error).message}`, 'warn'));
    }
  };
  try {
    // Never let `--mount` create an empty volume without our labels: the volume must exist.
    const inspect = await context.docker(batchVolumeArgs(p.volume));
    if (context.signal.aborted) throw new OperationError('cancelled', 'The batch operation was cancelled.');
    if (inspect.exitCode !== 0 || inspect.stdout.trim() !== p.volume) {
      throw new OperationError(BATCH_MISSING_VOLUME_CODE, `The volume ${p.volume} does not exist; the batch helper was not started.`);
    }
    let script: string;
    try {
      script = deps.readScript();
    } catch (error) {
      throw new OperationError('failed', `The script of the worker cannot be read: ${(error as Error).message}`);
    }
    let input: { write(text: string): boolean; end(): void } | undefined;
    let onStdout: (text: string) => void = () => {};
    let onStderr: (text: string) => void = () => {};
    const run = context.docker(batchRunArgs({ ...p, scriptHash: bundleHash(script) }), {
      cleanup: p.session,
      discardStdout: true,
      signal: ended.signal,
      onInput: (writer) => (input = writer),
      onStdout: (text) => onStdout(text),
      onStderr: (text) => onStderr(text),
    });
    call = run;
    const process: StartedProcess = {
      write: (text) => input?.write(text) ?? false,
      end: () => input?.end(),
      kill: () => ended.abort(),
      onStdout: (listener) => (onStdout = listener),
      onStderr: (listener) => (onStderr = listener),
      exited: run.then((result) => (result.error !== undefined && result.exitCode === null ? { exitCode: null, error: new Error(result.error) } : { exitCode: result.exitCode })),
    };
    const logger: Logger = {
      info: (message) => logTo().log(message),
      warn: (message) => logTo().log(message, 'warn'),
      error: (message) => logTo().log(message, 'warn'),
      output: () => {},
    };
    try {
      // The steps of one operation can carry up to MAX_BATCH_INPUT_CHARACTERS of input over this local pipe. The helper
      // is not lost for late answers: while the connection of the extension is slower than the output of a step, the
      // server pauses the reading of the helper's output (and its pongs); a helper that ends is seen by its exit.
      channel = await HelperChannel.open(process, script, {
        logger,
        name: `batch ${p.session.slice(0, 8)}`,
        openTimeoutMs: deps.openTimeoutMs,
        maxRequestBytes: 3 * MAX_CLIENT_LINE,
        pongTimeoutMs: BATCH_HOLD_LIMIT_MS,
      });
    } catch (error) {
      if (context.signal.aborted) throw new OperationError('cancelled', 'The batch operation was cancelled.');
      throw new OperationError('failed', (error as Error).message);
    }
    return { channel, finish };
  } catch (error) {
    await finish();
    throw error;
  }
}

/** The operation `batch` (see the module comment). */
export function batchOperation(deps: BatchDeps): OperationHandler {
  return async (params, context) => {
    const p = parseBatchParams(params);
    if (p === undefined) throw new OperationError('invalid', 'The parameters of the batch operation are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'The batch operation takes no secret.');
    if (deps.sessions.has(p.session)) throw new OperationError('invalid', 'The batch session exists already.');
    if (deps.sessions.size >= MAX_CONCURRENT_BATCHES) throw new OperationError('busy', 'The worker holds too many batch helpers.');
    // Taken at once, so that two batches that start together count against the cap.
    const entry: BatchSession = { inputs: new Map(), inputSize: 0 };
    deps.sessions.set(p.session, entry);
    let helper: StartedBatchHelper | undefined;
    try {
      context.progress('batch', p.volume);
      // The log lines of the client go to the step that runs, else to this operation.
      helper = await startBatchHelper(deps, context, p, () => entry.step ?? context);
      const channel = helper.channel;
      entry.channel = channel;
      const lost = new Promise<string>((resolve) => channel.onClose(resolve));
      context.progress(BATCH_READY_STEP, p.session);
      const reason = await Promise.race([abortedOrAfter(context.signal, deps.holdLimitMs ?? BATCH_HOLD_LIMIT_MS).then(() => undefined), lost]);
      if (context.signal.aborted) throw new OperationError('cancelled', 'The batch operation was cancelled.');
      if (reason !== undefined) throw new OperationError('failed', `The batch helper ended: ${reason}.`);
      throw new OperationError('timeout', 'The batch helper was held for its longest time and was ended.');
    } finally {
      deps.sessions.delete(p.session);
      await helper?.finish();
    }
  };
}

/**
 * Plan step 11B3b: a batch session of a flow that runs in this worker (the lock of its environment held here, see
 * workerLock.ts): the helper starts as for `batch`, from the image and with the socket of `p` (the worker's own), and its
 * steps go straight to it, with the same checks and the same result as through the extension (collectBatchStep). It ends
 * with `close`, or with the operation of `context`. It never counts as a session of the `batch` operation, so no request
 * of the extension reaches it.
 */
export async function workerBatchSession(deps: BatchDeps, context: OperationContext, p: { volume: string; image: string; socket: string }): Promise<HelperBatchSession> {
  const session = newCleanupLabel();
  const params = parseBatchParams({ session, volume: p.volume, image: p.image, socket: p.socket });
  if (params === undefined) throw new HelperChannelError('unsendable', 'The batch request is invalid.');
  context.progress('batch', p.volume);
  const helper = await startBatchHelper(deps, context, params, () => context);
  let closing = false;
  const lost = new Promise<string>((resolve) => helper.channel.onClose((reason) => (closing ? undefined : resolve(reason))));
  let closed: Promise<void> | undefined;
  return {
    session,
    lost,
    step: async (kind, stepParams, options = {}) => {
      if (options.signal?.aborted) throw abortError();
      const value = stepParams === undefined ? null : stepParams;
      const request: Record<string, unknown> = { session, kind, params: value };
      if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs;
      if (parseBatchStepParams(request) === undefined) throw new HelperChannelError('unsendable', 'The batch step is invalid.');
      if (JSON.stringify(value).length > MAX_BATCH_INPUT_CHARACTERS) throw new HelperChannelError('unsendable', `The input of the step ${kind} is too large for the batch helper.`);
      return collectBatchStep(kind, options, MAX_CAPTURED_OUTPUT_BYTES, (signal, onOutput) =>
        helper.channel.operation(kind, value, {
          ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
          timeoutMs: options.timeoutMs,
          signal,
          onOutput,
        }),
      );
    },
    close: () => {
      closing = true;
      closed ??= helper.finish();
      return closed;
    },
  };
}

/** The operation `batchStep`: one step in the helper of the session, at most one at a time. */
export function batchStepOperation(deps: BatchDeps): OperationHandler {
  return async (params, context) => {
    const p = parseBatchStepParams(params);
    if (p === undefined) throw new OperationError('invalid', 'The parameters of the batch step are invalid.');
    const entry = sessionOf(deps, p.session);
    if (entry.step !== undefined) throw new OperationError('busy', 'Another step of the batch session runs.');
    let stepParams = p.params;
    if (p.input !== undefined) {
      const text = entry.inputs.get(p.input);
      if (text === undefined) throw new OperationError('invalid', 'The input of the batch step is missing.');
      entry.inputs.delete(p.input);
      entry.inputSize -= text.length;
      try {
        stepParams = JSON.parse(text);
      } catch {
        throw new OperationError('invalid', 'The input of the batch step is invalid.');
      }
    }
    entry.step = context;
    try {
      const value = await entry.channel.operation(p.kind, stepParams, {
        // Plan step 11A: the named secrets of the step go on as they are.
        ...(context.hasNoSecret() ? {} : { secrets: context.secrets }),
        timeoutMs: p.timeoutMs,
        signal: context.signal,
        onProgress: (step, detail) => context.progress(step, detail),
        onOutput: (stream, text) => context.output(stream, text),
      });
      const checked = parseBatchStepValue(value);
      if (checked === undefined) throw new OperationError('protocol', 'The batch helper answered the step with an invalid value.');
      return checked;
    } catch (error) {
      if (error instanceof OperationError || isAbortError(error)) throw error;
      if (error instanceof HelperOperationError) throw new OperationError(error.timedOut ? 'timeout' : error.code, error.message);
      throw new OperationError(error instanceof HelperChannelError ? error.code : 'failed', (error as Error).message);
    } finally {
      entry.step = undefined;
    }
  };
}

/** The operation `batchChunk`: a piece of the input of a later step of the session. */
export function batchChunkOperation(deps: BatchDeps): OperationHandler {
  return async (params, context) => {
    const p = parseBatchChunkParams(params);
    if (p === undefined) throw new OperationError('invalid', 'The parameters of the batch input are invalid.');
    if (!context.hasNoSecret()) throw new OperationError('invalid', 'A batch input takes no secret.');
    const entry = sessionOf(deps, p.session);
    if (entry.inputSize + p.data.length > MAX_BATCH_INPUT_CHARACTERS) throw new OperationError('tooLarge', 'The inputs of the batch session are too large.');
    entry.inputs.set(p.input, (entry.inputs.get(p.input) ?? '') + p.data);
    entry.inputSize += p.data.length;
    return {};
  };
}
