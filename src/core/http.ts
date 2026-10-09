// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as https from 'https';
import type { Readable } from 'stream';

export interface HttpRequest {
  method: 'GET' | 'HEAD' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Review round 1 of 11H1 (reviewer B): the largest body that httpsRequest reads for this request (lower than
   * MAX_BODY_BYTES; never higher); a larger one fails as "too large".
   */
  maxBodyBytes?: number;
}

export interface HttpResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  /** Body as text. Empty for HEAD. */
  body: string;
}

/**
 * HTTP client interface, so that tests can replace the network.
 * `request` rejects when the connection fails (for example a failed name resolution),
 * and with an `AbortError` when the signal aborts.
 */
export interface HttpTransport {
  request(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * One request with the Node.js `https` module; `options` adds to the request (plan step 11E3a: the connection through a
 * proxy). The body is read up to MAX_BODY_BYTES (or the lower `request.maxBodyBytes`).
 */
export function httpsRequest(request: HttpRequest, signal: AbortSignal | undefined, options: https.RequestOptions = {}): Promise<HttpResponse> {
  const maxBytes = Math.min(MAX_BODY_BYTES, request.maxBodyBytes ?? MAX_BODY_BYTES);
  return new Promise((resolve, reject) => {
    const req = https.request(
      request.url,
      { ...options, method: request.method, headers: request.headers, signal },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            // Review round 1 of 11H1: rejected here, not by the destroy alone (a body that came in one chunk would end
            // first and resolve without its content).
            const error = new Error(`Response of ${request.url} is too large.`);
            reject(error);
            req.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: responseHeaders(res), body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (request.body !== undefined) req.end(request.body);
    else req.end();
  });
}

/**
 * Plan step 11H1: a response whose body is read as it comes (a download to a file), never buffered or decoded. The
 * caller reads `body` to its end or destroys it.
 */
export interface HttpStreamResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: Readable;
}

/**
 * Plan step 11H1: a transport that streams the body of a GET (no redirect is followed; the caller decides). Rejects as
 * HttpTransport.request does; an abort of `signal` also ends the reading of the body.
 */
export interface HttpStreamTransport {
  stream(url: string, signal?: AbortSignal): Promise<HttpStreamResponse>;
}

/** The headers of a response, names in lower case. */
function responseHeaders(res: { headers: Record<string, string | string[] | undefined> }): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/**
 * Plan step 11H1: one GET with the Node.js `https` module whose body is streamed (HttpStreamTransport); `options` as in
 * httpsRequest (the connection through a proxy).
 */
export function httpsStream(url: string, signal: AbortSignal | undefined, options: https.RequestOptions = {}): Promise<HttpStreamResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...options, method: 'GET', signal }, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: responseHeaders(res), body: res });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Transport with the Node.js `https` module. In the extension host, VS Code applies its proxy settings to this module
 * (implementation notes 9).
 */
export const nodeHttpsTransport: HttpTransport = {
  request: (request, signal) => httpsRequest(request, signal),
};
