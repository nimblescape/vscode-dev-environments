// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Download of the Docker Desktop installer (concept section 9: only over HTTPS, only from desktop.docker.com).
import * as fs from 'fs';
import * as https from 'https';
import { pipeline } from 'stream/promises';
import { abortError } from '../ports';
import { isOfficialDownloadUrl } from './dockerSetup';

const MAX_REDIRECTS = 5;

/** A response of GET: the status, the headers (names in lower case), and the body as a stream. */
export interface DownloadResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: NodeJS.ReadableStream;
}

/** GET of one URL, without following redirects. Rejects with an AbortError when the signal aborts. */
export type HttpGet = (url: string, signal: AbortSignal) => Promise<DownloadResponse>;

/** GET with the Node.js `https` module (VS Code applies its proxy settings to it in the extension host). */
export const nodeHttpsGet: HttpGet = (url, signal) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, { signal }, (response) => {
      resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: response });
    });
    request.on('error', reject);
  });

export interface DownloadOptions {
  /** HTTPS URL of desktop.docker.com. */
  url: string;
  /** The file to write. A partial download is written next to it (`.download`) and removed on failure. */
  target: string;
  signal?: AbortSignal;
  /** Called while bytes arrive; `total` from Content-Length, when known. */
  onProgress?: (received: number, total: number | undefined) => void;
  /** For tests. Default: `nodeHttpsGet`. */
  get?: HttpGet;
}

function header(headers: DownloadResponse['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Ends a response that is not read, so that its connection is released. */
function discard(response: DownloadResponse): void {
  const body = response.body as NodeJS.ReadableStream & { destroy?: () => void };
  body.destroy?.();
}

/**
 * Downloads `url` to `target`. Throws when the URL, or the target of a redirect, is not an HTTPS URL of
 * desktop.docker.com, on an HTTP error, and with an AbortError when the signal aborts. Existing `target` is replaced only after a
 * complete download.
 */
export async function downloadFile(options: DownloadOptions): Promise<void> {
  const get = options.get ?? nodeHttpsGet;
  const signal = options.signal ?? new AbortController().signal;
  if (!isOfficialDownloadUrl(options.url)) throw new Error(`Downloads come only from https://desktop.docker.com: ${options.url}`);
  // The partial file is always a new file ('wx' below), never one that exists or a link that another program put there.
  // Removed before the request: the body must not start to flow before the pipeline reads it.
  await fs.promises.rm(`${options.target}.download`, { force: true });
  let url = options.url;
  let response: DownloadResponse | undefined;
  for (let redirects = 0; ; redirects++) {
    if (signal.aborted) throw abortError();
    response = await get(url, signal);
    const location = header(response.headers, 'location');
    if (response.statusCode < 300 || response.statusCode >= 400 || !location) break;
    discard(response);
    if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects for ${options.url}.`);
    const next = new URL(location, url).href;
    // Docker's link of the latest version points to a versioned file of the same host: a redirect never leaves it.
    if (!isOfficialDownloadUrl(next)) {
      throw new Error(`The download of ${options.url} was redirected to ${next}, which is not HTTPS on desktop.docker.com.`);
    }
    url = next;
  }
  if (response.statusCode !== 200) {
    discard(response);
    throw new Error(`The download of ${url} failed with HTTP status ${response.statusCode}.`);
  }
  const length = Number.parseInt(header(response.headers, 'content-length') ?? '', 10);
  const total = Number.isFinite(length) && length >= 0 ? length : undefined;
  let received = 0;
  response.body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    options.onProgress?.(received, total);
  });
  const partial = `${options.target}.download`;
  try {
    await pipeline(response.body, fs.createWriteStream(partial, { flags: 'wx' }), { signal });
    if (total !== undefined && received !== total) {
      throw new Error(`The download of ${url} ended after ${received} of ${total} bytes.`);
    }
    await fs.promises.rename(partial, options.target);
  } catch (error) {
    await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    if (signal.aborted) throw abortError();
    throw error;
  }
}
