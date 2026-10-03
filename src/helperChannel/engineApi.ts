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
