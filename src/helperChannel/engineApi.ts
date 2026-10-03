// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 10A (decision of 2026-10-03, "every remote action is a worker operation"): the worker talks to the Docker
// Engine API over the socket of its engine itself, without a `docker` process per call. Only what the operations need:
// a request with a JSON or empty body, the answer as text (bounded), or as it comes (onChunk). Unversioned paths: the
// engine answers with its own API version. Registry credentials go only into the header of a request, never into a
// file or an argument.
import * as http from 'http';
import { HELPER_DOCKER_SOCKET } from '../core/names';
import { abortError } from '../core/ports';

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
 * Plan step 11B1: a hijacked connection of the Engine API (`POST /exec/<id>/start`, `/containers/<id>/attach`): the
 * engine answers 101 and the connection carries the streams of the process. `write` and `end` are its standard input;
 * `onFrame` gets the output as the engine frames it (stream 1 stdout, 2 stderr; 0 when the exec has a terminal and the
 * output comes raw), and `ended` resolves when the engine closed it.
 */
export interface EngineStream {
  write(data: Buffer | string): boolean;
  end(): void;
  onFrame(listener: (stream: 0 | 1 | 2, data: Buffer) => void): void;
  readonly ended: Promise<void>;
  /** Ends the connection at once (a cancel). */
  destroy(): void;
}

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
        res.setEncoding('utf8');
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
 * Rejects with an AbortError when the signal aborts, with the error of the connection, or with an Error naming the
 * status when the engine answered something else.
 */
export function engineHijack(socketPath: string = HELPER_DOCKER_SOCKET) {
  return (request: Pick<EngineRequest, 'path' | 'json' | 'signal'>): Promise<EngineStream> =>
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
        if (settled) return;
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
      // The engine answers 200 with a raw stream when it does not upgrade (an older API), and 101 with an upgrade.
      req.on('response', (res) => {
        if (res.statusCode === 200) {
          finish(undefined, engineStream(req, res, Buffer.alloc(0), request.signal));
          return;
        }
        res.resume();
        finish(new Error(`The engine answered the hijacked request with HTTP status ${res.statusCode ?? 0}.`));
      });
      req.on('upgrade', (_res, socket, head) => finish(undefined, engineStream(socket, socket, head, request.signal)));
      req.end(body);
    });
}

/** The frames of a hijacked connection (8 byte header: stream, 3 bytes of padding, 4 bytes of length). */
function engineStream(
  input: { write(data: Buffer | string): boolean; end(): void; destroy(): void },
  output: NodeJS.EventEmitter & { destroy?(): void },
  head: Buffer,
  signal: AbortSignal | undefined,
): EngineStream {
  let buffer = head;
  const listeners: ((stream: 0 | 1 | 2, data: Buffer) => void)[] = [];
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
  const emit = (stream: 0 | 1 | 2, data: Buffer) => {
    for (const listener of listeners) listener(stream, data);
  };
  const consume = () => {
    for (;;) {
      if (buffer.length < 8) return;
      const kind = buffer[0];
      // A stream that is not framed (a terminal): everything is output of the process.
      if (kind > 2 || buffer[1] !== 0 || buffer[2] !== 0 || buffer[3] !== 0) {
        emit(0, buffer);
        buffer = Buffer.alloc(0);
        return;
      }
      const length = buffer.readUInt32BE(4);
      if (buffer.length < 8 + length) return;
      emit(kind as 0 | 1 | 2, buffer.subarray(8, 8 + length));
      buffer = buffer.subarray(8 + length);
    }
  };
  consume();
  output.on('data', (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    consume();
  });
  const end = () => {
    if (buffer.length > 0) {
      emit(0, buffer);
      buffer = Buffer.alloc(0);
    }
    resolveEnded();
  };
  output.on('end', end);
  output.on('close', end);
  output.on('error', end);
  const destroy = () => {
    try {
      input.destroy();
    } catch {
      // It ended already.
    }
    output.destroy?.();
    end();
  };
  signal?.addEventListener('abort', destroy, { once: true });
  return {
    write: (data) => input.write(data),
    end: () => input.end(),
    onFrame: (listener) => listeners.push(listener),
    ended,
    destroy,
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
