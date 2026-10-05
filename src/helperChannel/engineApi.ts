// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 10A (decision of 2026-10-03, "every remote action is a worker operation"): the worker talks to the Docker
// Engine API over the socket of its engine itself, without a `docker` process per call. Only what the operations need:
// a request with a JSON or empty body, the answer as text (bounded), or as it comes (onChunk). Unversioned paths: the
// engine answers with its own API version. Registry credentials go only into the header of a request, never into a
// file or an argument.
import * as http from 'http';
import type { Duplex } from 'stream';
import { HELPER_DOCKER_SOCKET } from '../core/names';
import { abortError } from '../core/ports';
import { EngineError } from '../core/worker/dockerEngine';

/** The most text of an answer that is kept (beyond: cut, and `truncated` is set). */
export const MAX_ENGINE_ANSWER_CHARACTERS = 1024 * 1024;

export interface EngineRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  /** The path with its query, for example `/containers/<id>/start`. */
  path: string;
  headers?: Record<string, string>;
  /** A JSON body (sent with `Content-Type: application/json`). */
  json?: unknown;
  signal?: AbortSignal;
  /** The answer as it comes, instead of in `body`. */
  onChunk?: (text: string) => void;
  /**
   * Plan step 11G1: the answer decoded as Latin-1 instead of UTF-8, so that each character of `body` is one byte of the
   * answer (`Buffer.from(body, 'latin1')` gives the bytes back): for a binary answer such as the tar archive of
   * `GET /containers/<id>/archive`, whose offsets are byte offsets. MAX_ENGINE_ANSWER_CHARACTERS then counts bytes.
   */
  latin1?: boolean;
}

export interface EngineAnswer {
  status: number;
  /** The text of the answer (empty with onChunk), at most MAX_ENGINE_ANSWER_CHARACTERS. */
  body: string;
  truncated: boolean;
}

/** One request to the Docker Engine API. */
export type EngineApi = (request: EngineRequest) => Promise<EngineAnswer>;

/**
 * Plan step 11B1: a hijacked connection of the Engine API (`POST /exec/<id>/start`): the engine answers 101 and the
 * connection carries the streams of the process. `write` and `end` are its standard input; the output goes to the
 * `onFrame` of the request as the engine frames it (stream 1 stdout, 2 stderr). `ended` resolves when the engine ended
 * the output cleanly, and rejects when the connection broke, when the output was not framed, or when it ended in the
 * middle of a frame (review round 1 of plan step 11B1, A-R1-2: a broken connection is never a clean end).
 */
export interface EngineStream {
  write(data: Buffer | string): boolean;
  end(): void;
  readonly ended: Promise<void>;
  /** Ends the connection at once (a cancel, or the end of the exec). */
  destroy(): void;
}

/** A request of engineHijack; `onFrame` is given before the connection exists, so no output can come before it. */
export interface EngineHijackRequest extends Pick<EngineRequest, 'path' | 'json' | 'signal'> {
  onFrame: (stream: 1 | 2, data: Buffer) => void;
}

/** The largest frame that the parser accepts (a bigger length is no output of a process, but a broken stream). */
export const MAX_ENGINE_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * The Engine API over the Unix socket `socketPath` (default: the socket of the worker's engine). Rejects with an
 * AbortError when the signal aborts (the request is destroyed), and with the error of the connection otherwise.
 */
export function engineApi(socketPath: string = HELPER_DOCKER_SOCKET): EngineApi {
  return (request) =>
    new Promise<EngineAnswer>((resolve, reject) => {
      if (request.signal?.aborted) {
        reject(abortError());
        return;
      }
      const body = request.json === undefined ? undefined : Buffer.from(JSON.stringify(request.json), 'utf8');
      const headers: Record<string, string> = { ...request.headers, Host: 'docker' };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(body.length);
      }
      let settled = false;
      const finish = (error: Error | undefined, answer?: EngineAnswer) => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener('abort', onAbort);
        if (error !== undefined) reject(error);
        else resolve(answer!);
      };
      const req = http.request({ socketPath, method: request.method, path: request.path, headers }, (res) => {
        res.setEncoding(request.latin1 === true ? 'latin1' : 'utf8');
        let text = '';
        let truncated = false;
        res.on('data', (chunk: string) => {
          if (request.onChunk !== undefined) {
            request.onChunk(chunk);
            return;
          }
          if (text.length + chunk.length > MAX_ENGINE_ANSWER_CHARACTERS) {
            text += chunk.slice(0, Math.max(0, MAX_ENGINE_ANSWER_CHARACTERS - text.length));
            truncated = true;
            // Review round 1 of PR #114 (A-L3): the read of a file of an image (latin1) ends at the bound at once, instead of
            // reading the rest of a large file until its time limit; its caller counts a truncated answer as unknown.
            if (request.latin1 === true) {
              finish(undefined, { status: res.statusCode ?? 0, body: text, truncated });
              req.destroy();
            }
          } else {
            text += chunk;
          }
        });
        res.on('end', () => finish(undefined, { status: res.statusCode ?? 0, body: text, truncated }));
        res.on('error', (error) => finish(error));
      });
      const onAbort = () => {
        req.destroy();
        finish(abortError());
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (error) => finish(error));
      req.end(body);
    });
}

/**
 * Plan step 11B1: a hijacked request (`Upgrade: tcp`): resolves with the connection once the engine answered 101.
 * Rejects with an AbortError when the signal aborts, with the error of the connection, or with an EngineError with the
 * message and status of the engine when it answered anything else (review round 1 of plan step 11B1, A-R1-10, A-R1-20:
 * there is no way without the upgrade, so a 200 is refused too).
 */
export function engineHijack(socketPath: string = HELPER_DOCKER_SOCKET) {
  return (request: EngineHijackRequest): Promise<EngineStream> =>
    new Promise<EngineStream>((resolve, reject) => {
      if (request.signal?.aborted) {
        reject(abortError());
        return;
      }
      const body = request.json === undefined ? undefined : Buffer.from(JSON.stringify(request.json), 'utf8');
      const headers: Record<string, string> = { Host: 'docker', Connection: 'Upgrade', Upgrade: 'tcp' };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(body.length);
      }
      let settled = false;
      const finish = (error: Error | undefined, stream?: EngineStream) => {
        if (settled) {
          stream?.destroy();
          return;
        }
        settled = true;
        request.signal?.removeEventListener('abort', onAbort);
        if (error !== undefined) reject(error);
        else resolve(stream!);
      };
      const req = http.request({ socketPath, method: 'POST', path: request.path, headers });
      const onAbort = () => {
        req.destroy();
        finish(abortError());
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (error) => finish(error));
      req.on('response', (res) => {
        res.setEncoding('utf8');
        let text = '';
        res.on('data', (chunk: string) => {
          if (text.length < MAX_ENGINE_ANSWER_CHARACTERS) text += chunk;
        });
        const status = res.statusCode ?? 0;
        const refuse = () => finish(new EngineError(engineErrorMessage({ status, body: text, truncated: false }), status));
        res.on('end', refuse);
        res.on('error', refuse);
      });
      req.on('upgrade', (_res, socket, head) => finish(undefined, engineStream(socket, head, request.onFrame, request.signal)));
      req.end(body);
    });
}

/** The frames of a hijacked connection (8 byte header: stream, 3 bytes of padding, 4 bytes of length). */
function engineStream(socket: Duplex, head: Buffer, onFrame: EngineHijackRequest['onFrame'], signal: AbortSignal | undefined): EngineStream {
  let buffer = head;
  let resolveEnded!: () => void;
  let rejectEnded!: (error: Error) => void;
  const ended = new Promise<void>((resolve, reject) => {
    resolveEnded = resolve;
    rejectEnded = reject;
  });
  // The caller awaits `ended` only after it wrote the input; a failure before must not be an unhandled rejection.
  ended.catch(() => {});
  let done = false;
  const settle = (error: Error | undefined) => {
    if (done) return;
    done = true;
    signal?.removeEventListener('abort', onAbort);
    if (error === undefined) resolveEnded();
    else {
      rejectEnded(error);
      socket.destroy();
    }
  };
  /** Hands every whole frame to onFrame; false (and the stream fails) when the output is no frame. */
  const consume = (): boolean => {
    while (buffer.length >= 8) {
      // A listener that cancelled or ended the stream gets no further frame (review round 3 of 11B1, A-R3-1).
      if (done) return false;
      const kind = buffer[0];
      if ((kind !== 1 && kind !== 2) || buffer[1] !== 0 || buffer[2] !== 0 || buffer[3] !== 0) {
        settle(new Error('The engine sent output that is not framed.'));
        return false;
      }
      const length = buffer.readUInt32BE(4);
      if (length > MAX_ENGINE_FRAME_BYTES) {
        settle(new Error(`The engine sent a frame of ${length} bytes.`));
        return false;
      }
      if (buffer.length < 8 + length) return true;
      // A copy: the data must not keep the whole buffer of the connection alive, nor change with it.
      const data = Buffer.from(buffer.subarray(8, 8 + length));
      buffer = buffer.subarray(8 + length);
      try {
        onFrame(kind, data);
      } catch (error) {
        // Review round 2 of plan step 11B1 (A-R2-1): a listener that throws ends the exec, never the worker.
        settle(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    }
    return true;
  };
  socket.on('data', (chunk: Buffer) => {
    if (done) return;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    consume();
  });
  socket.on('end', () => {
    if (done) return;
    if (!consume()) return;
    settle(buffer.length === 0 ? undefined : new Error('The engine ended the output in the middle of a frame.'));
  });
  socket.on('error', (error: Error) => settle(error));
  socket.on('close', () => settle(new Error('The connection to the engine closed before the output ended.')));
  const onAbort = () => settle(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  // The output that came with the answer of the upgrade, now that onFrame is there (review round 1, A-R1-1).
  if (consume() && signal?.aborted) onAbort();
  return {
    write: (data) => socket.write(data),
    end: () => socket.end(),
    ended,
    destroy: () => {
      settle(abortError());
      socket.destroy();
    },
  };
}

/** The message of an error answer of the engine (`{"message": …}`), or the status. */
export function engineErrorMessage(answer: EngineAnswer): string {
  try {
    const value: unknown = JSON.parse(answer.body);
    if (typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string') {
      return (value as { message: string }).message;
    }
  } catch {
    // Not JSON.
  }
  const text = answer.body.trim();
  return text === '' ? `HTTP status ${answer.status}` : `HTTP status ${answer.status}: ${text.slice(0, 500)}`;
}
