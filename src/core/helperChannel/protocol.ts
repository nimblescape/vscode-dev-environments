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
// Before it exits, it cancels the operations that still run: their Docker calls end (SIGTERM, then SIGKILL) and the
// containers that they started with their cleanup label are removed (`docker rm -f`, review round 1, S1: by the label
// of the operation, never by a name, so no container that the operation did not start can be removed).
import { createHash, randomBytes } from 'crypto';
import { PIPE_LOADER } from '../loader/pipeLoader';
import { LABEL_CHANNEL_STEP, LABEL_HELPER_CHANNEL, WORKSPACES_ROOT } from '../names';
import type { EnvironmentStates, StateEnvironment } from '../pipeline/refreshStates';
import { isStorageId } from '../storage/paths';
import type { ContainerState } from '../types';

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
/** The script ends a Docker call with SIGTERM, then after this time with SIGKILL. */
export const CHANNEL_KILL_GRACE_MS = 5_000;
/** Time limit of the `docker rm -f` of the cleanup of an operation. */
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
 * helper): each Docker call that it runs with its exit code and duration, and what the operation reports.
 */
export interface LogAnswer {
  t: 'log';
  id: number;
  level: 'info' | 'warn';
  text: string;
}

/** A piece of output of the operation `id` (of a tool that it runs, for the log; or data of the `docker` operation). */
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
 * user's computer has), `connect` (the data that the window needs to connect). `payload`: checked by the extension.
 */
export interface AskAnswer {
  t: 'ask';
  id: number;
  ask: number;
  kind: AskKind;
  payload: unknown;
}

export const ASK_KINDS = ['question', 'local', 'record', 'secret', 'connect'] as const;
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
    const item =
      typeof raw === 'object' && raw !== null && typeof (raw as { toJSON?: unknown }).toJSON === 'function' ? (raw as { toJSON(key: string): unknown }).toJSON(key) : raw;
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
 * added later (plan step 11A) is masked from then on.
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
    if (rest !== '') this.forward(rest);
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
 * Review round 1 (S1): the label of the containers that an operation starts and that its cancel removes. The caller
 * puts `--label nimblescape.devenv.channel-step=<value>` (channelStepLabel) on each container that it starts and names
 * the value as the cleanup of the operation; the cleanup removes exactly the containers with that label.
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
 * A new cleanup label value (96 random bits). Use one per call and never again: the containers of a cancelled or lost
 * operation can still be removed later (the cleanup of the script can run up to 35 s after the cancel, and after a lost
 * connection only when the script ends by its silence).
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

/** `docker`: one Docker call. Its output comes as `out` messages; the value is DockerOperationValue. */
export const OP_DOCKER = 'docker';
/** `probe`: whether the Docker CLI of the container reaches its engine; the value is ProbeValue. */
export const OP_PROBE = 'probe';
/**
 * Review round 4 (M1): `sweep` removes the channel containers of the engine that were created but never started (a
 * connection that broke between the create and the start of `docker run -i --rm`, which then never ends and is never
 * removed): `docker container prune` of the stopped containers with LABEL_HELPER_CHANNEL older than SWEEP_MIN_AGE (so
 * never one of an open that runs now); running channels are never touched. The value is the prune output.
 */
export const OP_SWEEP = 'sweep';
export const SWEEP_MIN_AGE = '10m';

/** The arguments of the sweep (the `-f` of prune only skips its question; it removes stopped containers only). */
export function sweepArgs(): string[] {
  return ['container', 'prune', '-f', '--filter', `label=${LABEL_HELPER_CHANNEL}`, '--filter', `until=${SWEEP_MIN_AGE}`];
}

/** Limits of the `docker` operation. */
export const MAX_DOCKER_ARGS = 1_000;
export const MAX_DOCKER_ARG_LENGTH = 64 * 1024;
export const MAX_DOCKER_INPUT_LENGTH = 1024 * 1024;

/**
 * Parameters of `docker`: `docker <args>` without a shell. `input`: its standard input, then closed (the secret of the
 * operation instead when `inputIsSecret`). `cleanup` (review round 1, S1): a cleanup label value (isCleanupLabel); when
 * the operation is cancelled, the containers with the label channelStepLabel(cleanup) are removed. The args must put
 * that label on a container that the call starts.
 */
export interface DockerOperationParams {
  args: string[];
  input?: string;
  inputIsSecret?: boolean;
  cleanup?: string;
}

export interface DockerOperationValue {
  exitCode: number | null;
}

export interface ProbeValue {
  /** The server version of the engine, or undefined when `docker version` failed. */
  serverVersion?: string;
  detail: string;
  /**
   * Plan step 5, PR A: the identity of the engine behind the socket of the container, the output of ENGINE_IDENTITY_ARGS
   * (trimmed), or undefined when that call failed. The extension compares it with the same call without the worker.
   */
  engine?: string;
}

/** Plan step 5, PR A: `docker info` with the ID and the root folder of the engine (the engine identity of ProbeValue). */
export const ENGINE_IDENTITY_ARGS: readonly string[] = ['info', '--format', '{{json .ID}} {{json .DockerRootDir}}'];
/** The longest engine identity. */
export const MAX_ENGINE_IDENTITY_LENGTH = 1_024;

/**
 * An engine identity as ENGINE_IDENTITY_ARGS prints it: two JSON strings on one line, the ID not empty, at most
 * MAX_ENGINE_IDENTITY_LENGTH characters. Undefined for anything else (also a warning line of the CLI).
 */
export function engineIdentity(stdout: string): string | undefined {
  const text = stdout.trim();
  if (text.length > MAX_ENGINE_IDENTITY_LENGTH) return undefined;
  const match = /^("(?:[^"\\\n]|\\.)*") ("(?:[^"\\\n]|\\.)*")$/.exec(text);
  if (!match) return undefined;
  try {
    const id: unknown = JSON.parse(match[1]);
    const root: unknown = JSON.parse(match[2]);
    return typeof id === 'string' && id !== '' && typeof root === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

function isDockerArg(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_DOCKER_ARG_LENGTH && !value.includes('\0');
}

/** The strict check of DockerOperationParams (the script). */
export function parseDockerOperationParams(value: unknown): DockerOperationParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['args'], ['input', 'inputIsSecret', 'cleanup'])) return undefined;
  const { args, input, inputIsSecret, cleanup } = value;
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_DOCKER_ARGS || !args.every(isDockerArg)) return undefined;
  if (input !== undefined && (typeof input !== 'string' || input.length > MAX_DOCKER_INPUT_LENGTH)) return undefined;
  if (inputIsSecret !== undefined && typeof inputIsSecret !== 'boolean') return undefined;
  if (inputIsSecret === true && input !== undefined) return undefined;
  if (cleanup !== undefined && !isCleanupLabel(cleanup)) return undefined;
  const params: DockerOperationParams = { args: args as string[] };
  if (input !== undefined) params.input = input as string;
  if (inputIsSecret === true) params.inputIsSecret = true;
  if (cleanup !== undefined) params.cleanup = cleanup;
  return params;
}

/** The check of DockerOperationValue (the extension). */
export function parseDockerOperationValue(value: unknown): DockerOperationValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['exitCode'])) return undefined;
  const { exitCode } = value;
  return exitCode === null || (typeof exitCode === 'number' && Number.isInteger(exitCode)) ? { exitCode } : undefined;
}

/** The check of ProbeValue (the extension). */
export function parseProbeValue(value: unknown): ProbeValue | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['detail'], ['serverVersion', 'engine']) || typeof value.detail !== 'string') return undefined;
  if (value.serverVersion !== undefined && typeof value.serverVersion !== 'string') return undefined;
  // Plan step 5, PR A: an engine identity is one that engineIdentity accepts, unchanged.
  if (value.engine !== undefined && (typeof value.engine !== 'string' || engineIdentity(value.engine) !== value.engine)) return undefined;
  const probe: ProbeValue = { detail: value.detail };
  if (value.serverVersion !== undefined) probe.serverVersion = value.serverVersion as string;
  if (value.engine !== undefined) probe.engine = value.engine as string;
  return probe;
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
/** The user of `docker exec -u`: no white space, never an option. */
const EXEC_USER = /^[^\s\0-][^\s\0]{0,255}$/;
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

/**
 * `lock`: the lock of one environment on the Docker host (decision 2026-09-29, "Concurrency"): the worker opens
 * lockFilePath (in the volume of the Session Monitor, mounted into every worker; O_NOFOLLOW, folder 0700, file 0600),
 * runs `flock -w <waitSeconds> -E LOCK_BUSY_EXIT <fd>` on the inherited file descriptor, reports the progress
 * LOCK_HELD_STEP when it holds the lock, and holds it until the operation is cancelled (at most LOCK_HOLD_LIMIT_MS). The
 * kernel frees the lock when the worker ends, whatever the way. The lock files are never deleted. Parameters LockParams;
 * the value is `{}`; a lock that stayed held elsewhere fails with the code LOCK_BUSY_CODE. It carries no secret.
 */
export const OP_LOCK = 'lock';
/** The mount point of the volume of the Session Monitor in the worker (as REMOTE_MONITOR_STATE_DIR in the monitor). */
export const LOCK_STATE_DIR = '/state';
/** The folder of the lock files in that volume. */
export const LOCK_FOLDER = 'locks';
/** The exit code of `flock -E` when the lock stayed held by another holder for the whole wait. */
export const LOCK_BUSY_EXIT = 75;
/** The failure code of a lock that another window or computer holds (user decision D3). */
export const LOCK_BUSY_CODE = 'busy';
/** The progress step that says that the lock is held. */
export const LOCK_HELD_STEP = 'locked';
/** The longest wait for a lock, in seconds. */
export const MAX_LOCK_WAIT_SECONDS = 60;
/**
 * The backstop of a held lock: the worker lets go of it after this time (6 hours). Plan step 6, PR A: before 2 hours,
 * which a first open (a long build, `up`, the lifecycle commands, and a question to the user that stays open, all under
 * the lock) could exceed; now the same as the longest life of a busy mark (BUSY_MARK_MAX_AGE_MS in src/core/busy.ts).
 */
export const LOCK_HOLD_LIMIT_MS = 6 * 60 * 60_000;
/**
 * The lock operations of one worker at the same time. They do not take one of the MAX_CONCURRENT_OPERATIONS places: a
 * held lock would keep its place for the whole operation, and the Docker calls of that operation would wait behind it.
 */
export const MAX_CONCURRENT_LOCKS = 16;
/**
 * PR #74 review round 1 (A-R1-2): the Docker calls under held locks (HelperChannel `reserved`) of one worker at the same
 * time. They take none of the MAX_CONCURRENT_OPERATIONS places and never wait for one, so the other operations of the
 * window cannot starve an operation that holds a lock halfway. One call at a time per held lock, like the locks.
 */
export const MAX_CONCURRENT_LOCKED_OPERATIONS = MAX_CONCURRENT_LOCKS;

export interface LockParams {
  environmentId: string;
  waitSeconds: number;
}

/** The strict check of LockParams (both sides): a storage ID (isStorageId) and a whole wait of 1..MAX_LOCK_WAIT_SECONDS s. */
export function parseLockParams(value: unknown): LockParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['environmentId', 'waitSeconds'])) return undefined;
  const { environmentId, waitSeconds } = value;
  if (!isStorageId(environmentId)) return undefined;
  if (typeof waitSeconds !== 'number' || !Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > MAX_LOCK_WAIT_SECONDS) return undefined;
  return { environmentId, waitSeconds };
}

/** The folder of the lock files under `stateDir`. */
export function lockFolder(stateDir: string = LOCK_STATE_DIR): string {
  return `${stateDir}/${LOCK_FOLDER}`;
}

/** The lock file of an environment (its ID checked by parseLockParams). */
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

/**
 * Plan step 10A (decision of 2026-10-03): `pull`, the download of an image by the worker over the Engine API
 * (`POST /images/create`). Parameters PullParams; the secret of the operation is the registry password (only with
 * `username` and `serveraddress`), which the worker sends only in the header X-Registry-Auth. Its output is the progress
 * of the download, as `docker pull` prints it. Value: `{}`.
 */
export const OP_PULL = 'pull';
/** The longest image reference of a pull. */
export const MAX_PULL_REFERENCE_LENGTH = 512;

export interface PullParams {
  /** The image, always with a tag or a digest (pullReference), so the engine never pulls every tag of a repository. */
  reference: string;
  /** With a secret: the user of the registry, and its server (`https://index.docker.io/v1/` for Docker Hub). */
  username?: string;
  serveraddress?: string;
  /**
   * Review round 1 of PR #89 (A-R1-3): the secret is an identity token of `docker login` (sent as `identitytoken`, with
   * `serveraddress` and without `username`).
   */
  identityToken?: true;
}

/** A tag (as the Docker reference grammar has it) and a digest. */
const PULL_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const PULL_DIGEST = /^[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}$/;

/**
 * Review round 1 of PR #89 (A-R1-2): true when `reference` ends in a valid digest (`@<digest>`) or a valid tag after its
 * last `/`. An empty tag (`node:`) is none: the engine would take it for "pull every tag".
 */
function hasTagOrDigest(reference: string): boolean {
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

/** The strict check of PullParams (both sides). */
export function parsePullParams(value: unknown): PullParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['reference'], ['username', 'serveraddress', 'identityToken'])) return undefined;
  const { reference, username, serveraddress } = value;
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > MAX_PULL_REFERENCE_LENGTH) return undefined;
  if (/[\s\0]/.test(reference) || reference.startsWith('-') || !hasTagOrDigest(reference)) return undefined;
  const { identityToken } = value;
  if (identityToken !== undefined && (identityToken !== true || username !== undefined || typeof serveraddress !== 'string')) return undefined;
  if (identityToken === undefined && (username === undefined) !== (serveraddress === undefined)) return undefined;
  const params: PullParams = { reference };
  if (identityToken === true && typeof serveraddress === 'string') {
    if (serveraddress.length === 0 || serveraddress.length > 512 || /[\s\0]/.test(serveraddress)) return undefined;
    params.serveraddress = serveraddress;
    params.identityToken = true;
    return params;
  }
  if (username !== undefined) {
    if (typeof username !== 'string' || username.length === 0 || username.length > 256 || /[\0\n\r]/.test(username)) return undefined;
    if (typeof serveraddress !== 'string' || serveraddress.length === 0 || serveraddress.length > 512 || /[\s\0]/.test(serveraddress)) return undefined;
    params.username = username;
    params.serveraddress = serveraddress;
  }
  return params;
}

/**
 * Plan step 10A (decision of 2026-10-03): `startContainers`, `POST /containers/<id>/start` of each container by its full
 * ID, in order (the stopped side services of a Docker Compose dev container). No secret. Value: `{}`; a container that
 * runs already counts as started.
 */
export const OP_START_CONTAINERS = 'startContainers';
/** The most containers of one startContainers. */
export const MAX_START_CONTAINERS = 64;

export interface StartContainersParams {
  ids: string[];
}

/** The strict check of StartContainersParams (both sides). */
export function parseStartContainersParams(value: unknown): StartContainersParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['ids'])) return undefined;
  const { ids } = value;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_START_CONTAINERS) return undefined;
  if (!ids.every((id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id))) return undefined;
  return { ids: [...(ids as string[])] };
}
