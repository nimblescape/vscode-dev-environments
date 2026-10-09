// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The helper channel (user request 2026-09-28, step 1 of the remote speedup): one `docker run -i --rm` of the workspace
// helper per window and remote Docker host that stays open. The extension sends operations; the script in the container
// (src/helperChannel, dist/helperChannel.js) runs all steps of an operation there, against the Docker socket of its
// engine, and reports progress, output, and one result. So an operation costs one message instead of an SSH connection
// per Docker call. The messages are JSON, one per line, on the standard input and output of `docker run`. Pure
// functions and constants of both sides; no I/O. No `vscode`.
//
// The start (plan step 3, pipe loading): the container runs the pipe loader (src/core/loader/pipeLoader.ts) with
// CHANNEL_SCRIPT_PATH, the hash of the script, and CHANNEL_ENTRY. The first line that the extension writes is the script
// as a JSON string (encodeBundle); the loader checks its hash, stores it at CHANNEL_SCRIPT_PATH, and calls its
// `startChannel` with the rest of the input. So the script has no length limit of the command line.
//
// The container must end by itself when the connection is lost (user request 2026-09-28: nothing on the Docker host
// can clean up after it). Four independent ways, each enough alone:
//   1. The end of its standard input (the connection closed, or the extension ended `docker run`): it exits.
//   2. No message for CHANNEL_SILENCE_EXIT_MS (the connection hangs without an end, for example after the computer went
//      to sleep): it exits. The extension sends a ping every CHANNEL_PING_INTERVAL_MS while the channel is open.
//   3. No operation for CHANNEL_SERVER_IDLE_EXIT_MS and none runs (the extension did not close it): it exits.
//   4. `--rm` removes the container when the script ended; tini (the entry point of the image) passes signals on.
// Before it exits, it cancels the operations that still run: their requests to the engine end (plan step 11I, PR A: the
// script runs no Docker CLI of its own), and the batch helpers of their flows are stopped and removed by their session
// label (review round 1, S1: never by a name, so no container that the operation did not start can be removed;
// src/helperChannel/batch.ts).
import { createHash, randomBytes } from 'crypto';
import { PIPE_LOADER } from '../loader/pipeLoader';
import { LABEL_CHANNEL_STEP, LABEL_HELPER_CHANNEL, LABEL_HELPER_RUN, WORKSPACES_ROOT } from '../names';
import type { EnvironmentStates, StateEnvironment } from '../pipeline/refreshStates';
import { isStorageId } from '../storage/paths';
import { LABEL_SESSION_MONITOR, isSourceId, parseHeartbeatInput, parseImageListInput, parseImageSettingsInput, type HeartbeatInput, type ImageSettings } from '../remoteMonitor/protocol';
import type { ContainerState, GitSummary } from '../types';
import { isGitSummary } from '../git/gitSummary';
import { isUserErrorCode, type UserErrorCode } from '../errors';

export { LABEL_HELPER_CHANNEL };

/**
 * The version of the messages. The extension closes a channel whose script answers with another one. Plan step 6, PR B:
 * 2 (the batch helper: `batch`, `batchStep`, `batchChunk`); no migration (decision 2026-09-29, "Versions"). Plan step
 * 11A: 3 (named secrets, and the requests of the worker: `ask` and `answer`).
 */
export const CHANNEL_PROTOCOL_VERSION = 3;
/** Where the loader writes the script (the file system of the container). */
export const CHANNEL_SCRIPT_PATH = '/opt/devenv/channel.js';
/** The function of the script that the loader starts (src/helperChannel/main.ts). */
export const CHANNEL_ENTRY = 'startChannel';

/** The extension sends a ping this often while a channel is open. */
export const CHANNEL_PING_INTERVAL_MS = 15_000;
/** The script exits when no message came for this long (four pings missed). */
export const CHANNEL_SILENCE_EXIT_MS = 60_000;
/**
 * The extension takes a channel as lost when no answer came for this long. Review round 1 (P3): it is checked at each
 * ping, so the loss is noticed at most CHANNEL_PONG_TIMEOUT_MS + CHANNEL_PING_INTERVAL_MS (45 s) after the last answer,
 * before the script's silence (60 s) ends it.
 */
export const CHANNEL_PONG_TIMEOUT_MS = 30_000;
/** The extension closes a channel without an operation for this long. */
export const CHANNEL_IDLE_CLOSE_MS = 10 * 60_000;
/** The script exits when no operation came for this long and none runs (a backstop to CHANNEL_IDLE_CLOSE_MS). */
export const CHANNEL_SERVER_IDLE_EXIT_MS = 15 * 60_000;
/**
 * A process of an operation ends with SIGTERM, then after this time with SIGKILL: a step of the batch helper, and the
 * batch helper itself (its stop time). Plan step 11I (PR A): the script itself starts no process (before: its Docker
 * calls too).
 */
export const CHANNEL_KILL_GRACE_MS = 5_000;
/** Time limit of the removal of the containers of an operation by their label (the batch helper of a flow). */
export const CHANNEL_CLEANUP_TIMEOUT_MS = 30_000;

/** At most this many characters in one line from the extension (an operation with its parameters and its secret). */
export const MAX_CLIENT_LINE = 4 * 1024 * 1024;
/**
 * Review round 5 (F3): the longest request that the extension sends through the channel, in bytes of UTF-8. The pings
 * wait behind a request in the same stream, so a request must reach the script well within the pong time limit also on
 * a slow link (256 KiB at 30 s: about 70 kbit/s); a longer one is `unsendable` (plan step 5, PR D: refused).
 */
export const MAX_CHANNEL_REQUEST_BYTES = 256 * 1024;
/**
 * Review round 5 (F2): the longest wait of an operation for a free place (MAX_CONCURRENT_OPERATIONS are held); after it
 * the operation is `unsendable` (plan step 5, PR D: refused, never run without the channel).
 */
export const CHANNEL_SLOT_WAIT_MS = 5_000;
/** At most this many characters in one line from the script. */
export const MAX_SERVER_LINE = 4 * 1024 * 1024;
/** Output goes to the extension in pieces of at most this many characters. */
export const OUTPUT_CHUNK_CHARACTERS = 16 * 1024;
/** The longest secret of an operation (the GitHub token). */
export const MAX_SECRET_LENGTH = 4 * 1024;
/** Plan step 11A: the most named secrets of one operation (with those of its answers). */
export const MAX_SECRETS = 8;
/** Review round 2 of plan step 11A (A-R2-4): the most values that one operation masks (also the old values of a name). */
export const MAX_MASKED_SECRETS = 4 * MAX_SECRETS;
/**
 * Plan step 11A: the names of the secrets. `token`: the GitHub token (the clone, the token write into the dev container,
 * and every step whose output may hold it); `registry`: the password or identity token of a registry (a pull).
 */
export const SECRET_TOKEN = 'token';
export const SECRET_REGISTRY = 'registry';
/** Review round 1 (S6): the shortest secret; a shorter one could not be masked, so it is refused. */
export const MIN_SECRET_LENGTH = 4;
/** The largest time limit of an operation (one day). */
export const MAX_OPERATION_TIMEOUT_MS = 24 * 60 * 60_000;
/** At most this many operations of one channel run at the same time; more wait in the extension. */
export const MAX_CONCURRENT_OPERATIONS = 8;

/** The first message of the extension after the script. */
export interface HelloRequest {
  t: 'hello';
  protocol: number;
}

export interface PingRequest {
  t: 'ping';
  n: number;
}

/**
 * Named secrets of an operation (plan step 11A; before: one `secret`): name (isSecretName) → value (isSecret).
 */
export type Secrets = Readonly<Record<string, string>>;

/**
 * An operation: the script runs all its steps and answers with one `result`. `params`: checked by the operation.
 * `secrets` (for example the GitHub token as SECRET_TOKEN): kept apart from `params`, so that no log of the parameters
 * can contain them; a secret never becomes an argument or a variable of a process in the script, only input of one or
 * the header of a request to the engine, and every one is masked in all that the script sends back. `timeoutMs`: the
 * operation is cancelled after it.
 */
export interface OperationRequest {
  t: 'op';
  id: number;
  op: string;
  params: unknown;
  secrets?: Secrets;
  timeoutMs?: number;
}

/**
 * Plan step 11A: the answer of the extension to the request `ask` of the operation `id`: its value, and secrets that the
 * operation gets from then on (masked like those of the request); or a failure.
 */
export type AnswerRequest =
  | { t: 'answer'; id: number; ask: number; ok: true; value: unknown; secrets?: Secrets }
  | { t: 'answer'; id: number; ask: number; ok: false; error: OperationFailure };

/** Cancels the operation `id`. The script answers with its `result`. */
export interface CancelRequest {
  t: 'cancel';
  id: number;
}

export type ClientMessage = HelloRequest | PingRequest | OperationRequest | CancelRequest | AnswerRequest;

export interface HelloAnswer {
  t: 'hello';
  protocol: number;
  /** process.version of the script. */
  node: string;
  /** The operations that the script knows. */
  ops: string[];
}

export interface PongAnswer {
  t: 'pong';
  n: number;
}

/** A step of the operation `id` began (for the progress notification and the log). */
export interface ProgressAnswer {
  t: 'progress';
  id: number;
  step: string;
  detail?: string;
}

/**
 * A line of the log of the operation `id` (user request 2026-09-28: the local log is as detailed as the work of the
 * helper): what the operation reports. Plan step 11I (PR A): the script runs no Docker CLI call of its own, so it logs
 * none (before: each one with its exit code and duration).
 */
export interface LogAnswer {
  t: 'log';
  id: number;
  level: 'info' | 'warn';
  text: string;
}

/** A piece of output of the operation `id` (of a tool that it runs, for the log; or data of a batch step). */
export interface OutputAnswer {
  t: 'out';
  id: number;
  stream: 'stdout' | 'stderr';
  data: string;
}

/** Why an operation failed. `code`: a word that the extension can map (for example `invalid`, `unknown`, `failed`). */
export interface OperationFailure {
  code: string;
  message: string;
}

/** The end of the operation `id`: its value, or its failure; `cancelled`/`timedOut` when it was ended. */
export type ResultAnswer =
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: OperationFailure; cancelled: boolean; timedOut: boolean };

/**
 * Review round 4 (M2): the script received the cancel of the operation `id`, which had ended already (its result may
 * have crossed the cancel): the containers of its cleanup labels are removed (the exit waits for that). A cancel of an
 * operation that still runs is answered by its result instead.
 */
export interface CancelledAnswer {
  t: 'cancelled';
  id: number;
}

/**
 * Plan step 11A (decision of 2026-10-03, the worker is the deputy): a request of the operation `id` to the extension,
 * which answers it with `answer` (number `ask`, counted per operation). ASK_KINDS: `question` (a question to the user),
 * `local` (state on the user's computer), `record` (a change of the local records), `secret` (a secret that only the
 * user's computer has). `payload`: checked by the extension. Plan step 11E6 (decision A1 of 2026-10-05): no `connect`
 * request; the operation `open` answers with what the window needs to connect, and the extension connects it after the
 * lock of the environment is released.
 */
export interface AskAnswer {
  t: 'ask';
  id: number;
  ask: number;
  kind: AskKind;
  payload: unknown;
}

export const ASK_KINDS = ['question', 'local', 'record', 'secret'] as const;
export type AskKind = (typeof ASK_KINDS)[number];
/** Plan step 11A: the most open requests of one operation. */
export const MAX_OPEN_ASKS = 16;

export function isAskKind(value: unknown): value is AskKind {
  return typeof value === 'string' && (ASK_KINDS as readonly string[]).includes(value);
}

export type ServerMessage = HelloAnswer | PongAnswer | ProgressAnswer | LogAnswer | OutputAnswer | ResultAnswer | CancelledAnswer | AskAnswer;

// Plan step 6, PR B: moved here from src/helperChannel/server.ts (the extension masks the output of a batch step too).
// Plan step 11A: every secret of an operation (named secrets, also those of its answers).
/** The values to mask: those of at least MIN_SECRET_LENGTH characters, longest first (a secret inside another one). */
function maskable(secrets: Iterable<string>): string[] {
  return [...new Set([...secrets].filter((secret) => secret.length >= MIN_SECRET_LENGTH))].sort((a, b) => b.length - a.length);
}

/** Every secret of `secrets` (values; at least MIN_SECRET_LENGTH characters) replaced by `***`. */
export function redact(text: string, secrets: Iterable<string> | string | undefined): string {
  if (secrets === undefined) return text;
  let masked = text;
  for (const secret of maskable(typeof secrets === 'string' ? [secrets] : secrets)) masked = masked.split(secret).join('***');
  return masked;
}

/**
 * Review round 1 of plan step 11A (A-R1-1): every string and key of a JSON value with the secrets masked, before it is
 * encoded (in the encoded text a secret with `"` or `\\` would no longer match). Throws for a value that JSON cannot
 * hold (a cycle, a BigInt, a function).
 */
export function redactValue(value: unknown, secrets: Iterable<string>): unknown {
  const list = maskable(secrets);
  const seen = new Set<object>();
  const walk = (raw: unknown, key = ''): unknown => {
    // Review round 2 of plan step 11A (A-R2-1): as JSON.stringify, an object with toJSON sends what toJSON returns.
    const json =
      typeof raw === 'object' && raw !== null && typeof (raw as { toJSON?: unknown }).toJSON === 'function' ? (raw as { toJSON(key: string): unknown }).toJSON(key) : raw;
    // Review round 3 of plan step 11A (A-R3-2): as JSON.stringify, a boxed string, number or boolean is its primitive.
    const item = json instanceof String || json instanceof Number || json instanceof Boolean ? json.valueOf() : json;
    if (typeof item === 'string') return list.length === 0 ? item : redact(item, list);
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (item === undefined) return undefined;
    if (typeof item !== 'object') throw new TypeError(`A ${typeof item} cannot be sent.`);
    if (seen.has(item)) throw new TypeError('A value with a cycle cannot be sent.');
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) {
      result = item.map((entry, index) => walk(entry, String(index)) ?? null);
    } else {
      const entries = Object.entries(item as Record<string, unknown>)
        .map(([name, entry]) => [list.length === 0 ? name : redact(name, list), walk(entry, name)] as const)
        .filter(([, entry]) => entry !== undefined);
      // Review round 2 of plan step 11A (A-R2-2): two keys that mask to the same text would lose one value.
      if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new TypeError('Two keys are the same once their secrets are masked.');
      result = Object.fromEntries(entries);
    }
    seen.delete(item);
    return result;
  };
  return walk(value);
}

/**
 * Passes a stream on with the secrets masked, also when a chunk splits one: the last characters that could be the start
 * of a secret wait for the next chunk; flush passes them on. `secrets` is read at each piece, so a secret that an answer
 * added later (plan step 11A) is masked from then on. Plan step 11E1 (review round 2 of PR #102, A-M1): a held-back tail
 * of MIN_SECRET_LENGTH characters or more is the start of a secret whose rest never came (a stream cut by a time limit or
 * a cancel); flush passes it on as `***`. A shorter one passes as it is (it says nothing; review round 1 of PR #80).
 * Review round 3 of PR #102 (A-L1): flush cannot tell a cut stream from one that ended normally, so a normal end whose
 * last 4 or more characters start a secret ends in `***` too (output without a final line feed); kept on purpose, a
 * stream's end is masked toward the secret.
 */
export class StreamRedactor {
  private buffer = '';
  private readonly secrets: () => Iterable<string>;

  constructor(
    secrets: Iterable<string> | string | undefined | (() => Iterable<string>),
    private readonly forward: (text: string) => void,
  ) {
    this.secrets = typeof secrets === 'function' ? secrets : () => (secrets === undefined ? [] : typeof secrets === 'string' ? [secrets] : secrets);
  }

  push(text: string): void {
    if (text === '') return;
    const secrets = maskable(this.secrets());
    if (secrets.length === 0) {
      const pending = this.buffer + text;
      this.buffer = '';
      this.forward(pending);
      return;
    }
    const masked = redact(this.buffer + text, secrets);
    // Keep the longest tail that could be the start of a secret.
    let cut = masked.length;
    for (let length = Math.min(secrets[0].length - 1, masked.length); length > 0; length--) {
      const tail = masked.slice(masked.length - length);
      if (secrets.some((secret) => secret.length > length && secret.startsWith(tail))) {
        cut = masked.length - length;
        break;
      }
    }
    this.buffer = masked.slice(cut);
    if (cut > 0) this.forward(masked.slice(0, cut));
  }

  flush(): void {
    const rest = this.buffer;
    this.buffer = '';
    if (rest !== '') this.forward(rest.length >= MIN_SECRET_LENGTH ? '***' : rest);
  }
}

/** One line of the channel (JSON and a line feed; JSON.stringify escapes every line feed in a string). */
export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` has all `required` keys and no key beyond them and `optional`. */
export function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => key in value) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The name of an operation: lower camel case. */
export function isOperationName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-zA-Z0-9]{0,63}$/.test(value);
}

/** A secret that the channel can carry: MIN_SECRET_LENGTH..MAX_SECRET_LENGTH characters. */
export function isSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_SECRET_LENGTH && value.length <= MAX_SECRET_LENGTH;
}

/** Plan step 11A: the name of a secret: lower camel case. */
export function isSecretName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-zA-Z0-9]{0,31}$/.test(value);
}

/** Plan step 11A: named secrets that the channel can carry: 1..MAX_SECRETS names (isSecretName) with values (isSecret). */
export function parseSecrets(value: unknown): Secrets | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_SECRETS) return undefined;
  const secrets: Record<string, string> = {};
  for (const [name, secret] of entries) {
    if (!isSecretName(name) || !isSecret(secret)) return undefined;
    secrets[name] = secret;
  }
  return secrets;
}

/**
 * Review round 1 (S1): the label of the containers that an operation starts and removes by it, never by a name. Plan
 * step 11I1, PR B1: now the session label of a batch helper (`nimblescape.devenv.channel-step=<session>`,
 * channelStepLabel), which the worker removes by that label (src/helperChannel/batch.ts).
 */
export { LABEL_CHANNEL_STEP };

/**
 * A cleanup label value: 24 hex digits, as newCleanupLabel makes them (review round 2, B4: a value of its own per call,
 * never a fixed one, so that no other call or window can have containers with it).
 */
export function isCleanupLabel(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{24}$/.test(value);
}

/**
 * A new cleanup label value (96 random bits). Use one per batch session and never again: its containers can still be
 * removed by the label after the session ended.
 */
export function newCleanupLabel(): string {
  return randomBytes(12).toString('hex');
}

/** The `--label` value of a container of a step: `nimblescape.devenv.channel-step=<value>`. */
export function channelStepLabel(value: string): string {
  return `${LABEL_CHANNEL_STEP}=${value}`;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** A message of the extension, strictly checked (the script). Undefined for anything else. */
export function parseClientMessage(line: string): ClientMessage | undefined {
  if (line.length > MAX_CLIENT_LINE) return undefined;
  const value = parseJson(line);
  if (!isRecord(value)) return undefined;
  switch (value.t) {
    case 'hello':
      return hasOnlyKeys(value, ['t', 'protocol']) && isId(value.protocol) ? { t: 'hello', protocol: value.protocol } : undefined;
    case 'ping':
      return hasOnlyKeys(value, ['t', 'n']) && isId(value.n) ? { t: 'ping', n: value.n } : undefined;
    case 'cancel':
      return hasOnlyKeys(value, ['t', 'id']) && isId(value.id) ? { t: 'cancel', id: value.id } : undefined;
    case 'op': {
      if (!hasOnlyKeys(value, ['t', 'id', 'op', 'params'], ['secrets', 'timeoutMs']) || !isId(value.id) || !isOperationName(value.op)) {
        return undefined;
      }
      const { timeoutMs } = value;
      const secrets = value.secrets === undefined ? undefined : parseSecrets(value.secrets);
      if (value.secrets !== undefined && secrets === undefined) return undefined;
      if (timeoutMs !== undefined && (!isId(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_OPERATION_TIMEOUT_MS)) return undefined;
      const request: OperationRequest = { t: 'op', id: value.id, op: value.op, params: value.params };
      if (secrets !== undefined) request.secrets = secrets;
      if (timeoutMs !== undefined) request.timeoutMs = timeoutMs as number;
      return request;
    }
    case 'answer': {
      if (!isId(value.id) || !isId(value.ask)) return undefined;
      if (value.ok === true) {
        if (!hasOnlyKeys(value, ['t', 'id', 'ask', 'ok'], ['value', 'secrets'])) return undefined;
        const secrets = value.secrets === undefined ? undefined : parseSecrets(value.secrets);
        if (value.secrets !== undefined && secrets === undefined) return undefined;
        const answer: AnswerRequest = { t: 'answer', id: value.id, ask: value.ask, ok: true, value: value.value };
        if (secrets !== undefined) answer.secrets = secrets;
        return answer;
      }
      if (value.ok !== false || !hasOnlyKeys(value, ['t', 'id', 'ask', 'ok', 'error']) || !isFailure(value.error)) return undefined;
      return { t: 'answer', id: value.id, ask: value.ask, ok: false, error: { code: value.error.code, message: value.error.message } };
    }
    default:
      return undefined;
  }
}

/** The id of an operation that parseClientMessage refused, when it has one, so that the script can answer it. */
export function refusedOperationId(line: string): number | undefined {
  if (line.length > MAX_CLIENT_LINE) return undefined;
  const value = parseJson(line);
  return isRecord(value) && value.t === 'op' && isId(value.id) ? value.id : undefined;
}

function isFailure(value: unknown): value is OperationFailure {
  return isRecord(value) && hasOnlyKeys(value, ['code', 'message']) && typeof value.code === 'string' && typeof value.message === 'string';
}

/** A message of the script, strictly checked (the extension). Undefined for anything else. */
export function parseServerMessage(line: string): ServerMessage | undefined {
  if (line.length > MAX_SERVER_LINE) return undefined;
  const value = parseJson(line);
  if (!isRecord(value)) return undefined;
  switch (value.t) {
    case 'hello':
      return hasOnlyKeys(value, ['t', 'protocol', 'node', 'ops']) &&
        isId(value.protocol) &&
        typeof value.node === 'string' &&
        Array.isArray(value.ops) &&
        value.ops.every(isOperationName)
        ? { t: 'hello', protocol: value.protocol, node: value.node, ops: value.ops as string[] }
        : undefined;
    case 'pong':
      return hasOnlyKeys(value, ['t', 'n']) && isId(value.n) ? { t: 'pong', n: value.n } : undefined;
    case 'cancelled':
      return hasOnlyKeys(value, ['t', 'id']) && isId(value.id) ? { t: 'cancelled', id: value.id } : undefined;
    case 'progress': {
      if (!hasOnlyKeys(value, ['t', 'id', 'step'], ['detail']) || !isId(value.id) || typeof value.step !== 'string') return undefined;
      if (value.detail !== undefined && typeof value.detail !== 'string') return undefined;
      const progress: ProgressAnswer = { t: 'progress', id: value.id, step: value.step };
      if (value.detail !== undefined) progress.detail = value.detail as string;
      return progress;
    }
    case 'log':
      return hasOnlyKeys(value, ['t', 'id', 'level', 'text']) &&
        isId(value.id) &&
        (value.level === 'info' || value.level === 'warn') &&
        typeof value.text === 'string'
        ? { t: 'log', id: value.id, level: value.level, text: value.text }
        : undefined;
    case 'out':
      return hasOnlyKeys(value, ['t', 'id', 'stream', 'data']) &&
        isId(value.id) &&
        (value.stream === 'stdout' || value.stream === 'stderr') &&
        typeof value.data === 'string'
        ? { t: 'out', id: value.id, stream: value.stream, data: value.data }
        : undefined;
    case 'ask':
      return hasOnlyKeys(value, ['t', 'id', 'ask', 'kind'], ['payload']) && isId(value.id) && isId(value.ask) && isAskKind(value.kind)
        ? { t: 'ask', id: value.id, ask: value.ask, kind: value.kind, payload: value.payload }
        : undefined;
    case 'result': {
      if (!isId(value.id)) return undefined;
      if (value.ok === true) {
        return hasOnlyKeys(value, ['t', 'id', 'ok'], ['value']) ? { t: 'result', id: value.id, ok: true, value: value.value } : undefined;
      }
      if (value.ok !== false || !hasOnlyKeys(value, ['t', 'id', 'ok', 'error', 'cancelled', 'timedOut'])) return undefined;
      const { error, cancelled, timedOut } = value;
      if (!isFailure(error) || typeof cancelled !== 'boolean' || typeof timedOut !== 'boolean') return undefined;
      return { t: 'result', id: value.id, ok: false, error: { code: error.code, message: error.message }, cancelled, timedOut };
    }
    default:
      return undefined;
  }
}

/**
 * Splits a stream of text into lines. A line longer than `maxLine` is an error of the other side: `onTooLong` is called
 * once and nothing more is passed on.
 */
export class LineSplitter {
  private buffer = '';
  private broken = false;

  constructor(
    private readonly maxLine: number,
    private readonly onLine: (line: string) => void,
    private readonly onTooLong: () => void,
  ) {}

  push(text: string): void {
    if (this.broken) return;
    this.buffer += text;
    let start = 0;
    for (;;) {
      const end = this.buffer.indexOf('\n', start);
      if (end < 0) break;
      const line = this.buffer.slice(start, end);
      start = end + 1;
      if (line.length > this.maxLine) {
        this.fail();
        return;
      }
      if (line.trim() !== '') this.onLine(line);
      if (this.broken) return;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > this.maxLine) this.fail();
  }

  private fail(): void {
    this.broken = true;
    this.buffer = '';
    this.onTooLong();
  }
}

/**
 * The label value of a channel container: the protocol and 12 hex digits of sha256 of the script and the loader (plan
 * step 3: a new loader is a new version of the container too).
 */
export function channelLabelValue(script: string): string {
  const hash = createHash('sha256').update(script, 'utf8').update('\n', 'utf8').update(PIPE_LOADER, 'utf8');
  return `${CHANNEL_PROTOCOL_VERSION}-${hash.digest('hex').slice(0, 12)}`;
}

// ---- The operations of step 1 ----

// Plan step 11I1, PR B1: the operation `docker` (one Docker call relayed for the extension) is gone.
/**
 * `probe`: whether the worker reaches the engine behind its socket, and which engine it is (plan step 5, PR A). Plan step
 * 11I (PR A): over the port of the engine (the version and the identity that the Engine API answers), no Docker CLI of
 * the worker. No parameters (parseProbeParams); the value is ProbeValue.
 */
export const OP_PROBE = 'probe';
/**
 * Review round 4 (M1): `sweep` removes the channel containers of the engine that were created but never started (a
 * connection that broke between the create and the start of `docker run -i --rm`, which then never ends and is never
 * removed): the prune of the stopped containers with LABEL_HELPER_CHANNEL older than SWEEP_MIN_AGE (so never one of an
 * open that runs now); running channels are never touched. Plan step 11I (PR A): the prune of the port of the engine
 * (`POST /containers/prune` with SWEEP_FILTERS; before: `docker container prune -f` of the worker's Docker CLI with the
 * same two filters). Plan step 11I (U5, decision of 2026-10-08): every stopped helper container (LABEL_HELPER_RUN), the
 * channels and the batch helpers of the worker alike, never the Session Monitor: a batch helper has AutoRemove, which
 * applies only once it started, so one that a killed worker left between its create and its start stayed `created`
 * forever and held the volume of its environment, which a later Delete then could not remove. No parameters
 * (parseSweepParams); the value is SweepValue.
 */
export const OP_SWEEP = 'sweep';
export const SWEEP_MIN_AGE = '10m';

/**
 * Plan step 11I (PR A): the filters of the prune of the sweep (a prune removes stopped containers only): created more
 * than SWEEP_MIN_AGE ago (by the clock of the engine). Plan step 11I (U5, decision of 2026-10-08): the label
 * LABEL_HELPER_RUN with any value, which every helper container carries (the channels, the batch helpers; before: the
 * label of the channels, LABEL_HELPER_CHANNEL), and never the label LABEL_SESSION_MONITOR (`label!`): the Session
 * Monitor carries no LABEL_HELPER_RUN, and this guard keeps it out also if it ever did.
 */
export const SWEEP_FILTERS: Readonly<Record<'label' | 'label!' | 'until', readonly string[]>> = {
  label: [LABEL_HELPER_RUN],
  'label!': [LABEL_SESSION_MONITOR],
  until: [SWEEP_MIN_AGE],
};

/**
 * Plan step 11I (PR A): the parameters of an operation that takes none (`probe`, `sweep`): `{}`, or null (a missing
 * `params` travels as null). Anything else is refused.
 */
export type NoParams = Record<string, never>;

function parseNoParams(value: unknown): NoParams | undefined {
  return value === null || value === undefined || (isRecord(value) && Object.keys(value).length === 0) ? {} : undefined;
}

/** Plan step 11I (PR A): the strict check of the parameters of `probe` (both sides): none. */
export function parseProbeParams(value: unknown): NoParams | undefined {
  return parseNoParams(value);
}

/** Plan step 11I (PR A): the strict check of the parameters of `sweep` (both sides): none. */
export function parseSweepParams(value: unknown): NoParams | undefined {
  return parseNoParams(value);
}

/**
 * Plan step 5, PR A: the identity of a Docker engine, its ID (never empty) and its root folder, as `GET /info` of the
 * Engine API names them (`ID`, `DockerRootDir`). Plan step 11I (PR A): two identities are compared as these values
 * (sameEngine), never as text: the Docker CLI of the extension prints them as JSON in Go's form (`{{json}}` escapes `<`,
 * `>` and `&`, JSON.stringify does not), while the worker reads them over the Engine API.
 */
export interface EngineIdentity {
  id: string;
  rootDir: string;
}

export interface ProbeValue {
  /**
   * The version of the engine (`Version` of `GET /version`, as `docker version --format '{{.Server.Version}}'` prints
   * it), or undefined when it could not be read.
   */
  serverVersion?: string;
  detail: string;
  /**
   * Plan step 5, PR A: the identity of the engine behind the socket of the worker, or undefined when it could not be
   * read. The extension compares it with the identity that its own Docker CLI reads without the worker
   * (ENGINE_IDENTITY_ARGS). Plan step 11I (PR A): the values of `GET /info` (before: the text of ENGINE_IDENTITY_ARGS of
   * the worker's own Docker CLI).
   */
  engine?: EngineIdentity;
}

/**
 * Plan step 5, PR A: `docker info` with the ID and the root folder of the engine: the identity of the engine as the
 * Docker CLI of the extension reads it without the worker (engineIdentity).
 */
export const ENGINE_IDENTITY_ARGS: readonly string[] = ['info', '--format', '{{json .ID}} {{json .DockerRootDir}}'];
/** The longest output of ENGINE_IDENTITY_ARGS, and the longest ID and root folder of an EngineIdentity. */
export const MAX_ENGINE_IDENTITY_LENGTH = 1_024;

/**
 * The engine identity in the output of ENGINE_IDENTITY_ARGS: two JSON strings on one line, the ID not empty, at most
 * MAX_ENGINE_IDENTITY_LENGTH characters. Undefined for anything else (also a warning line of the CLI). Plan step 11I
 * (PR A): its values (before: the text, which the extension compared with the text of the worker's call).
 */
export function engineIdentity(stdout: string): EngineIdentity | undefined {
  const text = stdout.trim();
  if (text.length > MAX_ENGINE_IDENTITY_LENGTH) return undefined;
  const match = /^("(?:[^"\\\n]|\\.)*") ("(?:[^"\\\n]|\\.)*")$/.exec(text);
  if (!match) return undefined;
  try {
    return parseEngineIdentity({ id: JSON.parse(match[1]) as unknown, rootDir: JSON.parse(match[2]) as unknown });
  } catch {
    return undefined;
  }
}

/**
 * Plan step 11I (PR A): the check of an EngineIdentity (the identity that the worker answers, and the one of the port):
 * the ID a string of 1 to MAX_ENGINE_IDENTITY_LENGTH characters, the root folder a string of at most
 * MAX_ENGINE_IDENTITY_LENGTH characters, nothing else.
 */
export function parseEngineIdentity(value: unknown): EngineIdentity | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'rootDir'])) return undefined;
  const { id, rootDir } = value;
  if (typeof id !== 'string' || id === '' || id.length > MAX_ENGINE_IDENTITY_LENGTH) return undefined;
  if (typeof rootDir !== 'string' || rootDir.length > MAX_ENGINE_IDENTITY_LENGTH) return undefined;
  return { id, rootDir };
}

/** Plan step 11I (PR A): whether two identities name the same engine: the same ID and the same root folder. */
export function sameEngine(a: EngineIdentity, b: EngineIdentity): boolean {
  return a.id === b.id && a.rootDir === b.rootDir;
}

/** The longest detail of a probe that did not reach the engine (the worker keeps the end of the reason). */
export const MAX_PROBE_DETAIL_LENGTH = 2_000;

/** The check of ProbeValue (the extension). */
export function parseProbeValue(value: unknown): ProbeValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['detail'], ['serverVersion', 'engine']) || typeof value.detail !== 'string') return undefined;
  // Review round 1 of PR #122 (B, L2): the extension puts the detail into a message; the worker cuts it to this length.
  if (value.detail.length > MAX_PROBE_DETAIL_LENGTH) return undefined;
  if (value.serverVersion !== undefined && typeof value.serverVersion !== 'string') return undefined;
  // Plan step 5, PR A; plan step 11I (PR A): the identity of the engine as its checked values (parseEngineIdentity).
  const engine = value.engine === undefined ? undefined : parseEngineIdentity(value.engine);
  if (value.engine !== undefined && engine === undefined) return undefined;
  const probe: ProbeValue = { detail: value.detail };
  if (value.serverVersion !== undefined) probe.serverVersion = value.serverVersion as string;
  if (engine !== undefined) probe.engine = engine;
  return probe;
}

/** Plan step 11I (PR A): the value of `sweep`: how many stopped channel containers it removed. */
export interface SweepValue {
  removed: number;
}

/** Plan step 11I (PR A): the check of SweepValue (the extension): a whole number from 0, nothing else. */
export function parseSweepValue(value: unknown): SweepValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['removed'])) return undefined;
  const { removed } = value;
  return typeof removed === 'number' && Number.isSafeInteger(removed) && removed >= 0 ? { removed } : undefined;
}

// ---- Plan step 5, PR C: the batched refresh ----

/**
 * `refresh`: readEnvironmentStates (src/core/pipeline/refreshStates.ts) in the worker: the containers and volumes of the
 * environments and the branches of their running dev containers, in one operation. It only reads; it carries no
 * secret. Parameters RefreshParams, value RefreshValue.
 */
export const OP_REFRESH = 'refresh';
/** The most environments of one refresh (more: the refresh runs without the worker). */
export const MAX_REFRESH_ENVIRONMENTS = 200;
/** The longest branch name of a RefreshValue. */
export const MAX_REFRESH_BRANCH_LENGTH = 1_024;

export interface RefreshParams {
  environments: StateEnvironment[];
}

export interface RefreshValue {
  runtime: Array<{ id: string; container: ContainerState; volume: boolean; servicesRunning?: true }>;
  branches: Array<{ id: string; branch: string }>;
}

/** A container or volume name that Docker accepts, never an option. */
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
/** The user of `docker exec -u`: no white space, never an option. Plan step 11E4b: also the remote user of an open. */
export const EXEC_USER = /^[^\s\0-][^\s\0]{0,255}$/;
/** repositoryFolder: `/workspaces/<name of the repository>`. */
const REPOSITORY_FOLDER = new RegExp(`^${WORKSPACES_ROOT}/(?!\\.\\.?$)[^/\\s\\0]{1,255}$`);

function parseStateEnvironment(value: unknown): StateEnvironment | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'containerName', 'volumeName', 'folder', 'branch'], ['user'])) return undefined;
  const { id, containerName, volumeName, user, folder, branch } = value;
  if (!isStorageId(id) || typeof containerName !== 'string' || !DOCKER_NAME.test(containerName)) return undefined;
  if (typeof volumeName !== 'string' || !DOCKER_NAME.test(volumeName)) return undefined;
  if (typeof folder !== 'string' || !REPOSITORY_FOLDER.test(folder) || typeof branch !== 'boolean') return undefined;
  if (user !== undefined && (typeof user !== 'string' || !EXEC_USER.test(user))) return undefined;
  const env: StateEnvironment = { id, containerName, volumeName, folder, branch };
  if (user !== undefined) env.user = user;
  return env;
}

/**
 * The strict check of RefreshParams (both sides: the extension checks what it sends, so a list beyond the check is read
 * without the worker): at most MAX_REFRESH_ENVIRONMENTS environments with distinct IDs.
 */
export function parseRefreshParams(value: unknown): RefreshParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['environments']) || !Array.isArray(value.environments)) return undefined;
  const list: unknown[] = value.environments;
  if (list.length > MAX_REFRESH_ENVIRONMENTS) return undefined;
  const environments: StateEnvironment[] = [];
  const ids = new Set<string>();
  for (const item of list) {
    const env = parseStateEnvironment(item);
    if (env === undefined || ids.has(env.id)) return undefined;
    ids.add(env.id);
    environments.push(env);
  }
  return { environments };
}

/** The value of `refresh` from the states of readEnvironmentStates. */
export function refreshValue(states: EnvironmentStates): RefreshValue {
  return {
    runtime: [...states.runtime].map(([id, state]) => ({
      id,
      container: state.container,
      volume: state.volume,
      ...(state.servicesRunning === true ? { servicesRunning: true as const } : {}),
    })),
    branches: [...states.branches].map(([id, branch]) => ({ id, branch })),
  };
}

/**
 * The strict check of RefreshValue against its parameters (the extension): one state for each environment and no
 * other, and branches only of the running dev containers whose branch was asked for. Undefined for anything else.
 */
export function parseRefreshValue(value: unknown, params: RefreshParams): EnvironmentStates | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['runtime', 'branches'])) return undefined;
  const { runtime, branches } = value;
  if (!Array.isArray(runtime) || !Array.isArray(branches)) return undefined;
  const asked = new Map(params.environments.map((env) => [env.id, env]));
  const states: EnvironmentStates = { runtime: new Map(), branches: new Map() };
  for (const item of runtime as unknown[]) {
    if (!isRecord(item) || !hasOnlyKeys(item, ['id', 'container', 'volume'], ['servicesRunning'])) return undefined;
    const { id, container, volume, servicesRunning } = item;
    if (typeof id !== 'string' || !asked.has(id) || states.runtime.has(id)) return undefined;
    if (container !== 'running' && container !== 'stopped' && container !== 'missing') return undefined;
    if (typeof volume !== 'boolean' || (servicesRunning !== undefined && servicesRunning !== true)) return undefined;
    states.runtime.set(id, servicesRunning === true ? { container, volume, servicesRunning: true } : { container, volume });
  }
  if (states.runtime.size !== asked.size) return undefined;
  for (const item of branches as unknown[]) {
    if (!isRecord(item) || !hasOnlyKeys(item, ['id', 'branch'])) return undefined;
    const { id, branch } = item;
    if (typeof id !== 'string' || asked.get(id)?.branch !== true || states.runtime.get(id)?.container !== 'running') return undefined;
    if (states.branches.has(id) || typeof branch !== 'string' || branch === '' || branch.length > MAX_REFRESH_BRANCH_LENGTH) return undefined;
    if (branch !== branch.trim() || /[\0\n\r]/.test(branch)) return undefined;
    states.branches.set(id, branch);
  }
  return states;
}

// ---- Plan step 5, PR B: the environment lock ----

// The lock of one environment on the Docker host (decision 2026-09-29, "Concurrency"): the worker opens lockFilePath (in
// the volume of the Session Monitor, mounted into every worker; O_NOFOLLOW, folder 0700, file 0600) and runs
// `flock -w <waitSeconds> -E LOCK_BUSY_EXIT <fd>` on the inherited file descriptor (src/helperChannel/lock.ts). The kernel
// frees the lock when the worker ends, whatever the way. The lock files are never deleted; a lock that stayed held
// elsewhere fails with the code LOCK_BUSY_CODE. Plan step 11I1, PR B1: the operation `lock` (the lock held for the
// extension) is gone; the flows of the worker take the lock themselves.

/** The mount point of the volume of the Session Monitor in the worker (as REMOTE_MONITOR_STATE_DIR in the monitor). */
export const LOCK_STATE_DIR = '/state';
/** The folder of the lock files in that volume. */
export const LOCK_FOLDER = 'locks';
/** The exit code of `flock -E` when the lock stayed held by another holder for the whole wait. */
export const LOCK_BUSY_EXIT = 75;
/** The failure code of a lock that another window or computer holds (user decision D3). */
export const LOCK_BUSY_CODE = 'busy';
/**
 * Plan step 11B2 (review round 1, A-R1-3): the code of a flow whose lock could not be taken for another reason than a
 * holder elsewhere (the lock file, flock): nothing was changed, as `unavailable` of the lock before the move.
 */
export const LOCK_UNAVAILABLE_CODE = 'lockUnavailable';
/** The longest wait for a lock, in seconds. */
export const MAX_LOCK_WAIT_SECONDS = 60;
/**
 * The backstop of a held lock: 6 hours (plan step 11I1, PR B1: now only the limit of a batch helper, BATCH_HOLD_LIMIT_MS).
 * Plan step 6, PR A: before 2 hours, which a first open (a long build, `up`, the lifecycle commands, and a question to
 * the user that stays open, all under the lock) could exceed; now the same as the longest life of a busy mark
 * (BUSY_MARK_MAX_AGE_MS in src/core/busy.ts).
 */
export const LOCK_HOLD_LIMIT_MS = 6 * 60 * 60_000;

/** The folder of the lock files under `stateDir`. */
export function lockFolder(stateDir: string = LOCK_STATE_DIR): string {
  return `${stateDir}/${LOCK_FOLDER}`;
}

/** The lock file of an environment (its ID a storage ID, isStorageId). */
export function lockFilePath(environmentId: string, stateDir: string = LOCK_STATE_DIR): string {
  return `${lockFolder(stateDir)}/${environmentId}.lock`;
}

/** The arguments of `flock` on the file descriptor `fd` that it inherits from the worker. */
export function flockArgs(waitSeconds: number, fd: number): string[] {
  return ['-w', String(waitSeconds), '-E', String(LOCK_BUSY_EXIT), String(fd)];
}

/**
 * Plan step 8, PR B (user decision D2): the arguments of `flock` for an automatic stop of the Session Monitor container:
 * no wait (`-n`); a lock held by an operation exits with LOCK_BUSY_EXIT, and the monitor tries again at a later tick.
 */
export function flockNoWaitArgs(fd: number): string[] {
  return ['-n', '-E', String(LOCK_BUSY_EXIT), String(fd)];
}

// Plan step 11I1, PR B1: the operations `pull` and `startContainers` (plan step 10A) are gone; the flows of the worker
// pull over the port of its engine (DockerEngine.pull), with a reference that has a tag or a digest (pullReference).

/** A tag (as the Docker reference grammar has it) and a digest. */
const PULL_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const PULL_DIGEST = /^[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}$/;

/**
 * Review round 1 of PR #89 (A-R1-2): true when `reference` ends in a valid digest (`@<digest>`) or a valid tag after its
 * last `/`. An empty tag (`node:`) is none: the engine would take it for "pull every tag".
 */
export function hasTagOrDigest(reference: string): boolean {
  const at = reference.indexOf('@');
  if (at >= 0) return PULL_DIGEST.test(reference.slice(at + 1));
  const colon = reference.lastIndexOf(':');
  return colon > reference.lastIndexOf('/') && PULL_TAG.test(reference.slice(colon + 1));
}

/** `reference` with the tag `latest` when it has neither a tag nor a digest (the default of `docker pull`). */
export function pullReference(reference: string): string {
  if (reference.includes('@')) return reference;
  const lastSlash = reference.lastIndexOf('/');
  return reference.lastIndexOf(':') > lastSlash ? reference : `${reference}:latest`;
}

/**
 * Plan step 11B1 (decision of 2026-10-03, the worker is the deputy): `tokenRemove`, the first flow that runs in the
 * worker. It empties the token folder of the dev container of an environment (concept section 9) and asks the extension
 * for the record of the environment (its remote user). Parameters TokenRemoveParams, value TokenRemoveValue; no secret.
 */
export const OP_TOKEN_REMOVE = 'tokenRemove';

export interface TokenRemoveParams {
  environmentId: string;
  containerName: string;
}

export interface TokenRemoveValue {
  outcome: 'removed' | 'notRunning';
  container?: string;
}

/** The strict check of TokenRemoveParams (both sides). */
export function parseTokenRemoveParams(value: unknown): TokenRemoveParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['environmentId', 'containerName'])) return undefined;
  const { environmentId, containerName } = value;
  if (!isStorageId(environmentId) || typeof containerName !== 'string' || !DOCKER_NAME.test(containerName)) return undefined;
  return { environmentId, containerName };
}

/** The check of TokenRemoveValue (the extension). */
export function parseTokenRemoveValue(value: unknown): TokenRemoveValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['outcome'], ['container'])) return undefined;
  const { outcome, container } = value;
  if (outcome !== 'removed' && outcome !== 'notRunning') return undefined;
  if (container !== undefined && (typeof container !== 'string' || !/^[0-9a-f]{12}$/.test(container))) return undefined;
  return container === undefined ? { outcome } : { outcome, container };
}

/**
 * Plan step 11B2 (decision of 2026-10-03, the worker is the deputy): `stop`, the Stop of an environment in the worker.
 * Under the lock of the environment, which the worker takes itself (waitSeconds): the Git state of the
 * running dev container (as `user`, in `folder`), then the stop of the dev container and of the running containers of
 * the other services of Docker Compose. Parameters StopParams, value StopValue; no secret, no request to the extension.
 */
export const OP_STOP = 'stop';

export interface StopParams {
  environmentId: string;
  containerName: string;
  /** The repository folder in the container (repositoryFolder). */
  folder: string;
  /** The remote user, for the Git state. */
  user?: string;
  waitSeconds: number;
}

export interface StopValue {
  /** `stopped`: the dev container ran and is stopped now. `notRunning`: it did not run. */
  outcome: 'stopped' | 'notRunning';
  /** The Git state that the running dev container had before its stop, when it could be read. */
  gitSummary?: GitSummary;
  /** The names of the containers of the other services that were stopped (at most MAX_STOPPED_SERVICES). */
  services: string[];
  /**
   * Review round 1 of 11B2 (A-R1-2): the reasons of the containers that could not be stopped; the others were stopped
   * anyway, and the Git state is answered with them (the extension records it, then reports these).
   */
  failures: string[];
}

/** The most service containers that a StopValue names. */
export const MAX_STOPPED_SERVICES = 256;
/** The longest reason in StopValue.failures. */
export const MAX_STOP_FAILURE_LENGTH = 1000;

/** The strict check of StopParams (both sides). */
export function parseStopParams(value: unknown): StopParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['environmentId', 'containerName', 'folder', 'waitSeconds'], ['user'])) return undefined;
  const { environmentId, containerName, folder, user, waitSeconds } = value;
  if (!isStorageId(environmentId) || typeof containerName !== 'string' || !DOCKER_NAME.test(containerName)) return undefined;
  if (typeof folder !== 'string' || !REPOSITORY_FOLDER.test(folder)) return undefined;
  if (user !== undefined && (typeof user !== 'string' || !EXEC_USER.test(user))) return undefined;
  if (typeof waitSeconds !== 'number' || !Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > MAX_LOCK_WAIT_SECONDS) return undefined;
  return { environmentId, containerName, folder, ...(user !== undefined ? { user } : {}), waitSeconds };
}

/** The check of StopValue (the extension). */
export function parseStopValue(value: unknown): StopValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['outcome', 'services', 'failures'], ['gitSummary'])) return undefined;
  const { outcome, gitSummary, services, failures } = value;
  if (outcome !== 'stopped' && outcome !== 'notRunning') return undefined;
  if (gitSummary !== undefined && (outcome !== 'stopped' || !isGitSummary(gitSummary))) return undefined;
  if (!Array.isArray(services) || services.length > MAX_STOPPED_SERVICES || !services.every((name) => typeof name === 'string' && DOCKER_NAME.test(name))) return undefined;
  if (!Array.isArray(failures) || failures.length > MAX_STOPPED_SERVICES + 1 || !failures.every((text) => typeof text === 'string' && text.length <= MAX_STOP_FAILURE_LENGTH)) return undefined;
  const summary = gitSummary === undefined ? undefined : (({ branch, uncommittedFiles, unpushedCommits, stashes, recordedAt }: GitSummary) => ({ branch, uncommittedFiles, unpushedCommits, stashes, recordedAt }))(gitSummary);
  return { outcome, ...(summary !== undefined ? { gitSummary: summary } : {}), services: [...(services as string[])], failures: [...(failures as string[])] };
}

/**
 * Plan step 11B3b (decision of 2026-10-03, the worker is the deputy; user decision of 2026-10-04): a refusal of the
 * pipeline in the worker (a UserFacingError: not signed in, another Docker host, the volume missing, the lock busy, the
 * helper that could not be opened, …), answered as the value of a flow so that the extension shows it as before the move.
 * Never `cancelled` (a cancel ends the operation as such).
 */
export interface FlowRefusal {
  code: Exclude<UserErrorCode, 'cancelled'>;
  message: string;
  detail?: string;
  /** The refusal of the batch scope (BatchHelperUnavailableError). */
  batchHelperUnavailable?: true;
}

/** The longest message and detail of a FlowRefusal. */
export const MAX_REFUSAL_MESSAGE_LENGTH = 4000;
export const MAX_REFUSAL_DETAIL_LENGTH = 16_000;

/** The check of a FlowRefusal (the extension). */
export function parseFlowRefusal(value: unknown): FlowRefusal | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['code', 'message'], ['detail', 'batchHelperUnavailable'])) return undefined;
  const { code, message, detail, batchHelperUnavailable } = value;
  if (!isUserErrorCode(code) || code === 'cancelled') return undefined;
  if (typeof message !== 'string' || message === '' || message.length > MAX_REFUSAL_MESSAGE_LENGTH) return undefined;
  if (detail !== undefined && (typeof detail !== 'string' || detail.length > MAX_REFUSAL_DETAIL_LENGTH)) return undefined;
  if (batchHelperUnavailable !== undefined && batchHelperUnavailable !== true) return undefined;
  return { code, message, ...(detail !== undefined ? { detail } : {}), ...(batchHelperUnavailable === true ? { batchHelperUnavailable } : {}) };
}

/**
 * Plan step 11B3b (user decision of 2026-10-04): `listConfigurations`, the listing of Select configuration in the worker:
 * the configuration paths in the volume of the environment, in the order of precedence (EnvironmentService
 * .listConfigurations, as the worker's own service runs it: the record through `record get`, the account through `local
 * account`, the lock that the worker takes itself, the batch helper on the worker's own image). Parameters
 * ListConfigurationsParams; value ListConfigurationsValue; no secret.
 */
export const OP_LIST_CONFIGURATIONS = 'listConfigurations';

export interface ListConfigurationsParams {
  environmentId: string;
  /** The Docker host of the operation as the extension resolved it ('' for the local Docker; DockerTargets.host). */
  dockerHost: string;
  /** The window that sends the operation (EnvironmentServiceDeps.owner). */
  owner: { windowId: string; pid: number };
}

/** The paths, or the refusal of the pipeline. */
export type ListConfigurationsValue = { configPaths: string[] } | { refused: FlowRefusal };

/** The most configuration paths that a listing answers, and the longest path. */
export const MAX_LISTED_CONFIGURATIONS = 1000;
export const MAX_CONFIGURATION_PATH_LENGTH = 1024;
/** The longest Docker host of the parameters of a flow. */
const MAX_DOCKER_HOST_LENGTH = 1024;

/** The strict check of ListConfigurationsParams (both sides). */
export function parseListConfigurationsParams(value: unknown): ListConfigurationsParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['environmentId', 'dockerHost', 'owner'])) return undefined;
  const { environmentId } = value;
  if (!isStorageId(environmentId)) return undefined;
  const target = parseOperationTarget(value.dockerHost, value.owner);
  return target === undefined ? undefined : { environmentId, ...target };
}

/** Plan step 11C3: the Docker host and the window of an operation (the parameters of every flow). */
function parseOperationTarget(dockerHost: unknown, owner: unknown): { dockerHost: string; owner: { windowId: string; pid: number } } | undefined {
  if (typeof dockerHost !== 'string' || dockerHost.length > MAX_DOCKER_HOST_LENGTH || /[\u0000-\u001f\u007f]/.test(dockerHost)) return undefined;
  if (!isRecord(owner) || !hasOnlyKeys(owner, ['windowId', 'pid'])) return undefined;
  const { windowId, pid } = owner;
  if (!isStorageId(windowId) || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { dockerHost, owner: { windowId, pid } };
}

/** The check of ListConfigurationsValue (the extension). */
export function parseListConfigurationsValue(value: unknown): ListConfigurationsValue | undefined {
  if (!isRecord(value)) return undefined;
  if (hasOnlyKeys(value, ['refused'])) {
    const refused = parseFlowRefusal(value.refused);
    return refused === undefined ? undefined : { refused };
  }
  if (!hasOnlyKeys(value, ['configPaths'])) return undefined;
  const { configPaths } = value;
  if (!Array.isArray(configPaths) || configPaths.length > MAX_LISTED_CONFIGURATIONS) return undefined;
  if (!configPaths.every((path) => typeof path === 'string' && path !== '' && path.length <= MAX_CONFIGURATION_PATH_LENGTH && !/[\u0000-\u001f\u007f]/.test(path))) return undefined;
  return { configPaths: [...(configPaths as string[])] };
}

/**
 * Plan step 11C2a (decisions of 2026-10-03 and 2026-10-04): `delete`, the Delete of an environment in the worker
 * (EnvironmentService.delete, as the worker's own service runs it): the busy mark through `record markBusy`/`clearBusy`,
 * the removal under the lock that the worker takes itself, the entry through `record remove`, the session files of the
 * environment, and the heartbeat record of `monitorSource` in the Session Monitor of the engine, which the worker forgets
 * itself. Parameters DeleteParams; value DeleteValue; no secret.
 */
export const OP_DELETE = 'delete';

export interface DeleteParams {
  environmentId: string;
  /** The Docker host of the operation as the extension resolved it ('' for the local Docker; DockerTargets.host). */
  dockerHost: string;
  /** The window that sends the operation (EnvironmentServiceDeps.owner). */
  owner: { windowId: string; pid: number };
  /** The additional volumes that the user confirmed for removal (concept 7.14 step 4). */
  additionalVolumesToRemove: string[];
  /** The id of this computer in the Session Monitor (its heartbeat records; isSourceId). */
  monitorSource: string;
}

/** Deleted, or the refusal of the pipeline. */
export type DeleteValue = { deleted: true } | { refused: FlowRefusal };

/** The most additional volumes of a Delete. */
export const MAX_DELETE_VOLUMES = 1000;

/** The strict check of DeleteParams (both sides). */
export function parseDeleteParams(value: unknown): DeleteParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['environmentId', 'dockerHost', 'owner', 'additionalVolumesToRemove', 'monitorSource'])) return undefined;
  const base = parseListConfigurationsParams({ environmentId: value.environmentId, dockerHost: value.dockerHost, owner: value.owner });
  if (base === undefined) return undefined;
  const { additionalVolumesToRemove, monitorSource } = value;
  if (!Array.isArray(additionalVolumesToRemove) || additionalVolumesToRemove.length > MAX_DELETE_VOLUMES) return undefined;
  if (!additionalVolumesToRemove.every((name) => typeof name === 'string' && DOCKER_NAME.test(name))) return undefined;
  if (!isSourceId(monitorSource)) return undefined;
  return { ...base, additionalVolumesToRemove: [...(additionalVolumesToRemove as string[])], monitorSource };
}

/** The check of DeleteValue (the extension). */
export function parseDeleteValue(value: unknown): DeleteValue | undefined {
  if (!isRecord(value)) return undefined;
  if (hasOnlyKeys(value, ['refused'])) {
    const refused = parseFlowRefusal(value.refused);
    return refused === undefined ? undefined : { refused };
  }
  return hasOnlyKeys(value, ['deleted']) && value.deleted === true ? { deleted: true } : undefined;
}

/**
 * Plan step 11C2b (decisions of 2026-10-03 and 2026-10-04): `deleteCheck`, the check of Delete and its questions in the
 * worker (EnvironmentService.deleteCheck, deleteCheck.ts): the Git state (refreshed in the running dev container and
 * recorded through `record recordGitSummary`), the data of services and the volumes that Delete may remove, and the
 * questions as `question` requests. Parameters DeleteCheckParams; value DeleteCheckValue; no secret.
 */
export const OP_DELETE_CHECK = 'deleteCheck';

export interface DeleteCheckParams {
  environmentId: string;
  /** The Docker host of the operation as the extension resolved it ('' for the local Docker; DockerTargets.host). */
  dockerHost: string;
  /** The window that sends the operation (EnvironmentServiceDeps.owner). */
  owner: { windowId: string; pid: number };
  /** The name of the repository that the user sees (the questions name it). */
  repository: string;
  /** A window of this computer is connected to the environment (the confirmation says it closes its connection). */
  otherWindow: boolean;
}

/** The decision of the user (DeleteDecision of deleteCheck.ts), or the refusal of the pipeline. */
export type DeleteCheckValue =
  | { decision: 'delete'; additionalVolumesToRemove: string[] }
  | { decision: 'open' }
  | { decision: 'cancel' }
  | { refused: FlowRefusal };

/** The strict check of DeleteCheckParams (both sides). */
export function parseDeleteCheckParams(value: unknown): DeleteCheckParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['environmentId', 'dockerHost', 'owner', 'repository', 'otherWindow'])) return undefined;
  const base = parseListConfigurationsParams({ environmentId: value.environmentId, dockerHost: value.dockerHost, owner: value.owner });
  if (base === undefined) return undefined;
  const { repository, otherWindow } = value;
  if (typeof repository !== 'string' || repository === '' || repository.length > 256 || /[\u0000-\u001f\u007f]/.test(repository)) return undefined;
  if (typeof otherWindow !== 'boolean') return undefined;
  return { ...base, repository, otherWindow };
}

/** The check of DeleteCheckValue (the extension). */
export function parseDeleteCheckValue(value: unknown): DeleteCheckValue | undefined {
  if (!isRecord(value)) return undefined;
  if (hasOnlyKeys(value, ['refused'])) {
    const refused = parseFlowRefusal(value.refused);
    return refused === undefined ? undefined : { refused };
  }
  if (hasOnlyKeys(value, ['decision']) && (value.decision === 'open' || value.decision === 'cancel')) return { decision: value.decision };
  if (!hasOnlyKeys(value, ['decision', 'additionalVolumesToRemove']) || value.decision !== 'delete') return undefined;
  const { additionalVolumesToRemove } = value;
  if (!Array.isArray(additionalVolumesToRemove) || additionalVolumesToRemove.length > MAX_DELETE_VOLUMES) return undefined;
  if (!additionalVolumesToRemove.every((name) => typeof name === 'string' && DOCKER_NAME.test(name))) return undefined;
  return { decision: 'delete', additionalVolumesToRemove: [...(additionalVolumesToRemove as string[])] };
}

/**
 * Plan step 11C1 (decisions of 2026-10-03 and 2026-10-04): `windowState`, what an attached window reads of its dev
 * container, by the worker: its state, why it must not be used as it is (`outdated`, with `checks`, the host access
 * checks of its repository), and with `branch` the branch of the repository (the Git user and folder). It only reads;
 * no lock, no secret, no request to the extension. Parameters WindowStateParams; value WindowStateValue.
 */
export const OP_WINDOW_STATE = 'windowState';

export interface WindowStateParams {
  environmentId: string;
  containerName: string;
  /** The host access checks of the repository now (hostAccessChecks): for `outdated`. */
  checks: 'on' | 'off';
  /** When given: the branch of the repository in the running container. */
  branch?: { folder: string; user?: string };
}

export interface WindowStateValue {
  state: ContainerState;
  /** Why the container must not be used as it is (containerIsCurrent): `version` or `hostAccess`. */
  outdated?: 'version' | 'hostAccess';
  /** With `branch`: the branch, `null` for a detached HEAD; left out when it could not be read. */
  branch?: string | null;
}

/** The longest branch name of a WindowStateValue. */
export const MAX_BRANCH_LENGTH = 255;

/** The strict check of WindowStateParams (both sides). */
export function parseWindowStateParams(value: unknown): WindowStateParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['environmentId', 'containerName', 'checks'], ['branch'])) return undefined;
  const { environmentId, containerName, checks, branch } = value;
  if (!isStorageId(environmentId) || typeof containerName !== 'string' || !DOCKER_NAME.test(containerName)) return undefined;
  if (checks !== 'on' && checks !== 'off') return undefined;
  if (branch === undefined) return { environmentId, containerName, checks };
  if (!isRecord(branch) || !hasOnlyKeys(branch, ['folder'], ['user'])) return undefined;
  const { folder, user } = branch;
  if (typeof folder !== 'string' || !REPOSITORY_FOLDER.test(folder)) return undefined;
  if (user !== undefined && (typeof user !== 'string' || !EXEC_USER.test(user))) return undefined;
  return { environmentId, containerName, checks, branch: { folder, ...(user !== undefined ? { user } : {}) } };
}

/** The check of WindowStateValue (the extension). */
export function parseWindowStateValue(value: unknown): WindowStateValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['state'], ['outdated', 'branch'])) return undefined;
  const { state, outdated, branch } = value;
  if (state !== 'running' && state !== 'stopped' && state !== 'missing') return undefined;
  if (outdated !== undefined && outdated !== 'version' && outdated !== 'hostAccess') return undefined;
  if (branch !== undefined && branch !== null && (typeof branch !== 'string' || branch === '' || branch.length > MAX_BRANCH_LENGTH || /[\u0000-\u001f\u007f]/.test(branch))) return undefined;
  return { state, ...(outdated !== undefined ? { outdated } : {}), ...(branch !== undefined ? { branch } : {}) };
}

/**
 * Plan step 11C3 (decisions of 2026-10-03 and 2026-10-04): `reconcile`, the registry rebuilt from the labels of the
 * volumes of the engine (concept 7.5 "registry lost"; EnvironmentService.reconcileFromVolumes), by the worker: it reads
 * the volumes and the containers there, and the entries go to the extension as `record restore`, which adds them under
 * its registry lock. No lock of an environment, no secret. Parameters ReconcileParams; value ReconcileValue.
 */
export const OP_RECONCILE = 'reconcile';

export interface ReconcileParams {
  /** The Docker host of the operation as the extension resolved it ('' for the local Docker; DockerTargets.host). */
  dockerHost: string;
  /** The window that sends the operation (EnvironmentServiceDeps.owner). */
  owner: { windowId: string; pid: number };
}

/** The number of entries that the extension added. */
export interface ReconcileValue {
  added: number;
}

/** The most entries of one `record restore` (the environments of one engine). */
export const MAX_RESTORE_ENTRIES = 1000;

/** The strict check of ReconcileParams (both sides). */
export function parseReconcileParams(value: unknown): ReconcileParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['dockerHost', 'owner'])) return undefined;
  return parseOperationTarget(value.dockerHost, value.owner);
}

/** The check of ReconcileValue (the extension). */
export function parseReconcileValue(value: unknown): ReconcileValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['added'])) return undefined;
  const { added } = value;
  return typeof added === 'number' && Number.isSafeInteger(added) && added >= 0 && added <= MAX_RESTORE_ENTRIES ? { added } : undefined;
}

/**
 * Plan step 11D1 (decisions of 2026-10-03, "every remote action is a worker operation"): `heartbeat`, one heartbeat of
 * this computer to the Session Monitor container of the worker's engine (`monitor.js heartbeat` under the lock of the
 * records, the entry monitorHeartbeat of the registry of the container scripts since plan step 11I, U2), over the Engine
 * API. The window decides what it sends (its environments, their keep flags, the limit); the worker sends it. No request
 * to the extension, no secret. Parameters HeartbeatParams; value HeartbeatValue.
 */
export const OP_HEARTBEAT = 'heartbeat';

export interface HeartbeatParams {
  heartbeat: HeartbeatInput;
}

/** `missing`: the monitor container does not exist or does not run (the window starts it again). */
export type HeartbeatValue = { ok: true } | { ok: false; missing: boolean; detail: string };

/** The longest detail of a failed heartbeat or monitor command. */
export const MAX_MONITOR_DETAIL_LENGTH = 2000;

/** The strict check of HeartbeatParams (both sides): the heartbeat as the monitor takes it (parseHeartbeatInput). */
export function parseHeartbeatParams(value: unknown): HeartbeatParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['heartbeat'])) return undefined;
  const heartbeat = parseHeartbeatInput(JSON.stringify(value.heartbeat) ?? '');
  return heartbeat === undefined ? undefined : { heartbeat };
}

/** The check of HeartbeatValue (the extension). */
export function parseHeartbeatValue(value: unknown): HeartbeatValue | undefined {
  if (!isRecord(value)) return undefined;
  if (hasOnlyKeys(value, ['ok']) && value.ok === true) return { ok: true };
  if (!hasOnlyKeys(value, ['ok', 'missing', 'detail']) || value.ok !== false || typeof value.missing !== 'boolean') return undefined;
  if (typeof value.detail !== 'string' || value.detail.length > MAX_MONITOR_DETAIL_LENGTH) return undefined;
  return { ok: false, missing: value.missing, detail: value.detail };
}

/**
 * Plan step 11D1 (user decisions Q2 of 2026-10-02 and of 2026-10-04): `recordGitState`, the Git state of the running dev
 * container of an environment that a window releases (EnvironmentService.recordGitState), read by the worker and
 * recorded through `record recordGitSummary`. Parameters RecordGitStateParams; value RecordGitStateValue.
 */
export const OP_RECORD_GIT_STATE = 'recordGitState';

export interface RecordGitStateParams {
  environmentId: string;
  /** The Docker host of the operation ('' for the local Docker). */
  dockerHost: string;
  /** The window that sends the operation. */
  owner: { windowId: string; pid: number };
}

/** `recorded`: the Git state was read and recorded. */
export interface RecordGitStateValue {
  recorded: boolean;
}

/** The strict check of RecordGitStateParams (both sides). */
export function parseRecordGitStateParams(value: unknown): RecordGitStateParams | undefined {
  return parseListConfigurationsParams(value);
}

/** The check of RecordGitStateValue (the extension). */
export function parseRecordGitStateValue(value: unknown): RecordGitStateValue | undefined {
  return isRecord(value) && hasOnlyKeys(value, ['recorded']) && typeof value.recorded === 'boolean' ? { recorded: value.recorded } : undefined;
}

/**
 * Plan step 11D2 (decision of 2026-10-03): `monitorEnsure`, the ensure of the Session Monitor container of the worker's
 * engine (RemoteSessionMonitor.ensureOrThrow over the Engine API), with the worker's own helper image (its tag and ID)
 * and socket, and the script of its bundle. `images`: the image maintenance of this computer (the settings imageUpdates
 * and imageUpdateSchedule, in its time zone); with prefixes the monitor gets the default network. A failure fails the
 * operation with its cause. No request, no secret. Parameters MonitorEnsureParams; value MonitorEnsureValue.
 */
export const OP_MONITOR_ENSURE = 'monitorEnsure';

export interface MonitorEnsureParams {
  images: ImageSettings;
}

export interface MonitorEnsureValue {
  outcome: 'running' | 'started' | 'created';
}

/** The strict check of MonitorEnsureParams (both sides): the settings as the monitor takes them (prefixes may be none). */
export function parseMonitorEnsureParams(value: unknown): MonitorEnsureParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['images'])) return undefined;
  const images = parseImageSettingsInput(JSON.stringify(value.images) ?? '');
  return images === undefined ? undefined : { images };
}

/** The check of MonitorEnsureValue (the extension). */
export function parseMonitorEnsureValue(value: unknown): MonitorEnsureValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['outcome'])) return undefined;
  const { outcome } = value;
  return outcome === 'running' || outcome === 'started' || outcome === 'created' ? { outcome } : undefined;
}

/**
 * Plan step 11E6 (decisions of 2026-10-03 and 2026-10-04; A1 and D1 of 2026-10-05): `open`, the open of an environment by
 * the worker's own pipeline (EnvironmentService.open of a repository, `target`, or EnvironmentService.openEnvironment of
 * an existing environment, `environmentId`), under the lock that the worker takes itself. Its records go to the
 * extension as the specific requests of the open; its questions are `question` requests; the token is asked (`secret
 * token`), the registry logins too (`secret registry`). It makes sure that the Session Monitor of its engine runs, with
 * the image maintenance of this computer (`images`, and the image list `repositories` when the extension has one to give)
 * (D1). It answers with what the window needs to connect (A1): the extension connects it after the lock is released.
 * Parameters OpenParams; value OpenValue.
 */
export const OP_OPEN = 'open';

/** Plan step 11E6: the settings of this computer that the open reads (the settings of the pipeline, for its repository). */
export interface OpenSettings {
  updateImagesOnConnect: boolean;
  /** The host access checks of the repository of the open (hostAccessChecks): never the whole list of the setting. */
  hostAccessChecks: 'on' | 'off';
  waitingTimeSeconds: number;
  stopOnClose: boolean;
  respectShutdownActionNone: boolean;
  /** The time limit of the heartbeats (stopAfterSeconds reads it); missing: the default. */
  stopAfterMinutes?: number;
}

export interface OpenParams {
  /** The Docker host of the operation as the extension resolved it ('' for the local Docker; DockerTargets.host). */
  dockerHost: string;
  /** The window that sends the operation (EnvironmentServiceDeps.owner). */
  owner: { windowId: string; pid: number };
  /** The id of this computer in the Session Monitor, for the first heartbeat of the open (isSourceId). */
  monitorSource: string;
  settings: OpenSettings;
  /** Decision D1 of 2026-10-05: the image maintenance of this computer, for the ensure of the Session Monitor. */
  images: ImageSettings;
  /** Decision D1: the image repositories that the extension read from GitHub, when it has a list to give. */
  repositories?: string[];
  /** The repository of the open (the questions name it; a first open creates its environment). */
  repository: string;
  /** An existing environment (reconnect, reopen, switch, rebuild); not with `target`. */
  environmentId?: string;
  /** The open of the repository for the signed-in account (RepositoryTarget without its name); not with `environmentId`. */
  target?: { defaultBranch?: string | null; configPaths: string[]; trusted: boolean };
  /** A manual rebuild (OpenOptions.forceRebuild). */
  forceRebuild?: true;
  /** Select configuration (OpenOptions.configPath). */
  configPath?: string;
}

/** What the window needs to connect (decision A1), or the refusal of the pipeline; `imageListSent`: the list was given. */
export type OpenValue = ({ opened: OpenedEnvironment } | { refused: FlowRefusal }) & { imageListSent?: true };

export interface OpenedEnvironment {
  environmentId: string;
  containerName: string;
  remoteWorkspaceFolder: string;
}

/** Plan step 11E6: the progress of an open whose `step` is this carries the detail of the current step (ProgressReporter.detail). */
export const OPEN_PROGRESS_DETAIL = 'detail';

/** The longest branch of the parameters of the open, and the longest remote workspace folder of its value. */
const MAX_OPEN_BRANCH_LENGTH = 255;
const MAX_REMOTE_FOLDER_LENGTH = 4096;

function plainOpenText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value !== '' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The strict check of OpenSettings. */
function parseOpenSettings(value: unknown): OpenSettings | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['updateImagesOnConnect', 'hostAccessChecks', 'waitingTimeSeconds', 'stopOnClose', 'respectShutdownActionNone'], ['stopAfterMinutes'])) return undefined;
  const { updateImagesOnConnect, hostAccessChecks, waitingTimeSeconds, stopOnClose, respectShutdownActionNone, stopAfterMinutes } = value;
  if (typeof updateImagesOnConnect !== 'boolean' || typeof stopOnClose !== 'boolean' || typeof respectShutdownActionNone !== 'boolean') return undefined;
  if (hostAccessChecks !== 'on' && hostAccessChecks !== 'off') return undefined;
  if (typeof waitingTimeSeconds !== 'number' || !Number.isFinite(waitingTimeSeconds)) return undefined;
  if (stopAfterMinutes !== undefined && (typeof stopAfterMinutes !== 'number' || !Number.isFinite(stopAfterMinutes))) return undefined;
  return {
    updateImagesOnConnect,
    hostAccessChecks,
    waitingTimeSeconds,
    stopOnClose,
    respectShutdownActionNone,
    ...(stopAfterMinutes !== undefined ? { stopAfterMinutes } : {}),
  };
}

/**
 * The strict check of OpenParams (both sides). Review round 1 of PR #108 (A-L2): the computer (`monitorSource`) and the
 * settings are required, so that a wiring without them fails here instead of sending no first heartbeat.
 */
export function parseOpenParams(value: unknown): OpenParams | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['dockerHost', 'owner', 'monitorSource', 'settings', 'images', 'repository'], ['repositories', 'environmentId', 'target', 'forceRebuild', 'configPath'])
  ) {
    return undefined;
  }
  const operationTarget = parseOperationTarget(value.dockerHost, value.owner);
  if (operationTarget === undefined) return undefined;
  const { monitorSource, repository, environmentId, target, forceRebuild, configPath } = value;
  if (!isSourceId(monitorSource)) return undefined;
  if (!plainOpenText(repository, 256) || !/^[^/\s]+\/[^/\s]+$/.test(repository)) return undefined;
  const settings = parseOpenSettings(value.settings);
  if (settings === undefined) return undefined;
  const images = parseImageSettingsInput(JSON.stringify(value.images) ?? '');
  if (images === undefined) return undefined;
  let repositories: string[] | undefined;
  if (value.repositories !== undefined) {
    repositories = parseImageListInput(JSON.stringify({ repositories: value.repositories }) ?? '');
    if (repositories === undefined) return undefined;
  }
  // Exactly one of the two: an existing environment, or the repository for the signed-in account.
  if ((environmentId === undefined) === (target === undefined)) return undefined;
  if (environmentId !== undefined && !isStorageId(environmentId)) return undefined;
  let checkedTarget: OpenParams['target'];
  if (target !== undefined) {
    if (!isRecord(target) || !hasOnlyKeys(target, ['configPaths', 'trusted'], ['defaultBranch'])) return undefined;
    const { defaultBranch, configPaths, trusted } = target;
    if (typeof trusted !== 'boolean') return undefined;
    if (defaultBranch !== undefined && defaultBranch !== null && !plainOpenText(defaultBranch, MAX_OPEN_BRANCH_LENGTH)) return undefined;
    if (!Array.isArray(configPaths) || configPaths.length > MAX_LISTED_CONFIGURATIONS || !configPaths.every((path) => plainOpenText(path, MAX_CONFIGURATION_PATH_LENGTH))) return undefined;
    checkedTarget = { ...(defaultBranch !== undefined ? { defaultBranch } : {}), configPaths: [...(configPaths as string[])], trusted };
  }
  if (forceRebuild !== undefined && forceRebuild !== true) return undefined;
  if (configPath !== undefined && !plainOpenText(configPath, MAX_CONFIGURATION_PATH_LENGTH)) return undefined;
  return {
    ...operationTarget,
    monitorSource,
    settings,
    images,
    ...(repositories !== undefined ? { repositories } : {}),
    repository,
    ...(environmentId !== undefined ? { environmentId } : {}),
    ...(checkedTarget !== undefined ? { target: checkedTarget } : {}),
    ...(forceRebuild === true ? { forceRebuild } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
  };
}

/** The check of OpenValue (the extension): a container name of Docker, an absolute folder. */
export function parseOpenValue(value: unknown): OpenValue | undefined {
  if (!isRecord(value)) return undefined;
  const { imageListSent } = value;
  if (imageListSent !== undefined && imageListSent !== true) return undefined;
  const sent = imageListSent === true ? { imageListSent: true as const } : {};
  if (hasOnlyKeys(value, ['refused'], ['imageListSent'])) {
    const refused = parseFlowRefusal(value.refused);
    return refused === undefined ? undefined : { refused, ...sent };
  }
  if (!hasOnlyKeys(value, ['opened'], ['imageListSent']) || !isRecord(value.opened) || !hasOnlyKeys(value.opened, ['environmentId', 'containerName', 'remoteWorkspaceFolder'])) return undefined;
  const { environmentId, containerName, remoteWorkspaceFolder } = value.opened;
  if (!isStorageId(environmentId) || typeof containerName !== 'string' || !DOCKER_NAME.test(containerName)) return undefined;
  if (!plainOpenText(remoteWorkspaceFolder, MAX_REMOTE_FOLDER_LENGTH) || !remoteWorkspaceFolder.startsWith('/')) return undefined;
  return { opened: { environmentId, containerName, remoteWorkspaceFolder }, ...sent };
}
