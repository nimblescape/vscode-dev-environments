// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 6, PR B: the operations `batch`, `batchStep` and `batchChunk` of the worker (src/core/helperChannel/batch.ts).
// `batch` starts one helper container per operation with the volume of the environment and talks to it as a client of
// its ChannelServer (the HelperChannel of the extension, over its open input and its output; plan step 11G3: attached
// over the Engine API of the worker's engine, DockerEngine.runAttached, instead of the worker's own `docker run -i`);
// `batchStep` relays one step to it, with its secret, its time limit and its cancel, and passes its progress, log
// lines and output back; `batchChunk` keeps the pieces of an input that is longer than one request. The helper ends
// with the operation: its input ends (it exits; AutoRemove), and the worker removes the container by its session label. It
// also ends by itself as the worker does (the end of its input when the worker ends, its silence, its idle time).
import * as fs from 'fs';
import {
  BATCH_MISSING_VOLUME_CODE,
  BATCH_READY_STEP,
  BATCH_HOLD_LIMIT_MS,
  MAX_BATCH_INPUT_CHARACTERS,
  MAX_CONCURRENT_BATCHES,
  batchRunSpec,
  parseBatchChunkParams,
  parseBatchParams,
  parseBatchStepParams,
  parseBatchStepValue,
  type BatchParams,
} from '../core/helperChannel/batch';
import { HelperChannel, HelperChannelError, HelperOperationError, collectBatchStep, type HelperBatchSession } from '../core/helperChannel/helperChannel';
import { CHANNEL_CLEANUP_TIMEOUT_MS, CHANNEL_KILL_GRACE_MS, MAX_CLIENT_LINE, channelStepLabel, newCleanupLabel } from '../core/helperChannel/protocol';
import { MAX_CAPTURED_OUTPUT_BYTES } from '../core/helper/analysisLimits';
import { bundleHash } from '../core/loader/pipeLoader';
import { abortError, isAbortError, type Logger } from '../core/ports';
import { EngineError, type DockerEngine, type EngineAttachedRun } from '../core/worker/dockerEngine';
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
  /** Plan step 11G3: the port of the worker's engine for an operation, over which the helper runs. */
  engineOf: (context: OperationContext) => DockerEngine;
  /** The script of this process, as the loader stored it (the helper is loaded with the same script). */
  readScript(): string;
  /** Only for the tests. */
  holdLimitMs?: number;
  openTimeoutMs?: number;
}

/** The deps of the worker: its own script file (the loader `require`d it from there), and the port of its engine (plan step 11G3). */
export function batchDeps(engineOf: (context: OperationContext) => DockerEngine): BatchDeps {
  return { sessions: new Map(), engineOf, readScript: () => fs.readFileSync(__filename, 'utf8') };
}

function sessionOf(deps: BatchDeps, session: string): BatchSession & { channel: HelperChannel } {
  const entry = deps.sessions.get(session);
  if (entry?.channel === undefined || !entry.channel.isOpen) throw new OperationError('closed', 'The batch session is not open.');
  return entry as BatchSession & { channel: HelperChannel };
}

/**
 * Plan step 11G3: removes the containers of the session label over the Engine API (the list by the label, then a forced
 * removal of exactly those IDs; never by a name), within CHANNEL_CLEANUP_TIMEOUT_MS and never with the cancel signal,
 * so that it runs after a cancel too.
 */
async function removeByLabel(engine: DockerEngine, session: string): Promise<void> {
  const limit = AbortSignal.timeout(CHANNEL_CLEANUP_TIMEOUT_MS);
  const ids = await engine.containerIds({ label: [channelStepLabel(session)] }, limit);
  // Review round 1 of PR #115 (A-L3): each container on its own (one failure does not keep the others), and one that the
  // engine is removing already (409: AutoRemove at the same time) is gone; the first other failure is thrown at the end.
  let failure: unknown;
  for (const id of ids) {
    try {
      await engine.removeContainer(id, limit);
    } catch (error) {
      if (error instanceof EngineError && error.status === 409) continue;
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

/** A batch helper that runs, with the client of its ChannelServer. */
interface StartedBatchHelper {
  channel: HelperChannel;
  /** Ends it: its input ends (it exits; AutoRemove), and its containers are removed by the session label. Never rejects. */
  finish(): Promise<void>;
}

/**
 * Starts the batch helper of `p` (the volume must exist) and opens the client of its ChannelServer; on a failure,
 * everything that it started is ended before it throws an OperationError. Its log lines go to `logTo()`. Plan step 11B3b:
 * the `batch` operation and the worker's own batch session (workerBatchSession) start it the same way. Plan step 11G3:
 * over the Engine API of the worker's engine (DockerEngine.runAttached), no `docker run` of the worker's own; a cancel
 * of the operation stops and removes it, and its containers are removed by the session label after it in every case.
 */
async function startBatchHelper(deps: BatchDeps, context: OperationContext, p: BatchParams, logTo: () => Pick<OperationContext, 'log'>): Promise<StartedBatchHelper> {
  const engine = deps.engineOf(context);
  const cancelled = () => new OperationError('cancelled', 'The batch operation was cancelled.');
  let run: EngineAttachedRun | undefined;
  // Plan step 11G3: set once the create was sent; the engine may then hold a container of the session label.
  let createSent = false;
  let channel: HelperChannel | undefined;
  let unpause: () => void = () => {};
  let finished: Promise<void> | undefined;
  const finish = (): Promise<void> =>
    (finished ??= (async () => {
      // Its input ends: the helper cancels its step and exits (AutoRemove); it is killed after CHANNEL_CLOSE_KILL_MS.
      channel?.close();
      if (channel === undefined) run?.process.kill();
      await run?.process.exited;
      unpause();
      // Plan step 11G3: also after a cancel (the server no longer removes it: it started no Docker call for it).
      // Plan step 11B3b: never rejects (a session that the worker's own flow closes must not fail it); a failure is logged.
      if (createSent) {
        await removeByLabel(engine, p.session).catch((error: unknown) => context.log(`The batch helper ${p.session.slice(0, 8)} could not be removed: ${(error as Error).message}`, 'warn'));
      }
    })());
  try {
    // Never let the create make an empty volume without our labels: the volume must exist (a 404 is a missing volume).
    let volume: unknown;
    try {
      volume = await engine.inspect('volume', p.volume, context.signal);
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) throw cancelled();
      throw new OperationError('failed', `The volume ${p.volume} could not be inspected: ${(error as Error).message}`);
    }
    if (context.signal.aborted) throw cancelled();
    if ((volume as { Name?: unknown } | undefined)?.Name !== p.volume) {
      throw new OperationError(BATCH_MISSING_VOLUME_CODE, `The volume ${p.volume} does not exist; the batch helper was not started.`);
    }
    let script: string;
    try {
      script = deps.readScript();
    } catch (error) {
      throw new OperationError('failed', `The script of the worker cannot be read: ${(error as Error).message}`);
    }
    try {
      createSent = true;
      // Plan step 11G3: the cancel of the operation stops and removes it (SIGTERM, then SIGKILL after the kill grace of
      // the server, as its Docker calls end).
      run = await engine.runAttached(batchRunSpec({ ...p, scriptHash: bundleHash(script) }), { signal: context.signal, stopSeconds: CHANNEL_KILL_GRACE_MS / 1000 });
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) throw cancelled();
      throw new OperationError('failed', `The batch helper could not be started: ${(error as Error).message}`);
    }
    // Review round 2 (A2) of the server: its output waits while the connection of the extension is congested.
    unpause = context.pausable?.(run) ?? (() => {});
    const logger: Logger = {
      info: (message) => logTo().log(message),
      warn: (message) => logTo().log(message, 'warn'),
      error: (message) => logTo().log(message, 'warn'),
      output: () => {},
    };
    try {
      // The steps of one operation can carry up to MAX_BATCH_INPUT_CHARACTERS of input over this connection. The helper
      // is not lost for late answers: while the connection of the extension is slower than the output of a step, the
      // server pauses the reading of the helper's output (and its pongs); a helper that ends is seen by its exit.
      channel = await HelperChannel.open(run.process, script, {
        logger,
        name: `batch ${p.session.slice(0, 8)}`,
        openTimeoutMs: deps.openTimeoutMs,
        maxRequestBytes: 3 * MAX_CLIENT_LINE,
        pongTimeoutMs: BATCH_HOLD_LIMIT_MS,
      });
    } catch (error) {
      if (context.signal.aborted) throw cancelled();
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
      // Review round 1 of PR #115 (A-L4): the session is forgotten after its helper was removed, so a new batch of the same
      // session cannot start meanwhile and lose its container to this removal by the session label.
      await helper?.finish();
      deps.sessions.delete(p.session);
    }
  };
}

/**
 * Plan step 11B3b: a batch session of a flow that runs in this worker (the lock of its environment held here, see
 * workerLock.ts): the helper starts as for `batch`, from the image and with the socket of `p` (the worker's own), and its
 * steps go straight to it, with the same checks and the same result as through the extension (collectBatchStep). It ends
 * with `close`, or with the operation of `context`. It never counts as a session of the `batch` operation, so no request
 * of the extension reaches it. Review round 1 of 11B3b (A-R1-3): nor against MAX_CONCURRENT_BATCHES and its hold limit:
 * there is one per held lock of an environment, and it ends with the operation (its time limit) at the latest.
 */
export async function workerBatchSession(deps: BatchDeps, context: OperationContext, p: { volume: string; image: string; socket: string }): Promise<HelperBatchSession> {
  const session = newCleanupLabel();
  const params = parseBatchParams({ session, volume: p.volume, image: p.image, socket: p.socket });
  if (params === undefined) throw new HelperChannelError('unsendable', 'The batch request is invalid.');
  context.progress('batch', p.volume);
  return sessionOfHelper(session, await startBatchHelper(deps, context, params, () => context));
}

/** The client of a started batch helper that a session needs (review round 1 of 11B3b: apart, for its tests). */
export interface BatchHelperClient {
  channel: Pick<HelperChannel, 'operation' | 'onClose'>;
  finish(): Promise<void>;
}

/**
 * Plan step 11B3b: the HelperBatchSession over a started batch helper (workerBatchSession): each step checked as the
 * extension's client checks it (parseBatchStepParams, MAX_BATCH_INPUT_CHARACTERS) and collected as it collects it
 * (collectBatchStep); `lost` only for an end without `close`; `close` once, and never rejecting.
 */
export function sessionOfHelper(session: string, helper: BatchHelperClient): HelperBatchSession {
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
      closed ??= helper.finish().catch(() => undefined);
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
