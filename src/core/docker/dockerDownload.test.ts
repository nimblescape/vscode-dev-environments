// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough, Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAbortError } from '../ports';
import { downloadFile, type DownloadResponse, type HttpGet } from './dockerDownload';
import { DOCKER_DESKTOP_DOWNLOADS } from './dockerSetup';

const URL_DMG = DOCKER_DESKTOP_DOWNLOADS.macArm64;

let dir: string;
let target: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-download-'));
  target = path.join(dir, 'Docker.dmg');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function respond(statusCode: number, body: string | Readable = '', headers: Record<string, string> = {}): DownloadResponse {
  return { statusCode, headers, body: typeof body === 'string' ? Readable.from([Buffer.from(body)]) : body };
}

function fakeGet(responses: Record<string, () => DownloadResponse>): { get: HttpGet; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    get: async (url) => {
      urls.push(url);
      const next = responses[url];
      if (!next) throw new Error(`unexpected ${url}`);
      return next();
    },
  };
}

describe('downloadFile', () => {
  it('writes the file and reports the progress with the length', async () => {
    const { get, urls } = fakeGet({ [URL_DMG]: () => respond(200, 'installer', { 'content-length': '9' }) });
    const progress: Array<[number, number | undefined]> = [];
    await downloadFile({ url: URL_DMG, target, get, onProgress: (received, total) => progress.push([received, total]) });
    expect(fs.readFileSync(target, 'utf8')).toBe('installer');
    expect(urls).toEqual([URL_DMG]);
    expect(progress).toEqual([[9, 9]]);
    expect(fs.existsSync(`${target}.download`)).toBe(false);
  });

  it('follows HTTPS redirects', async () => {
    const mirror = 'https://desktop.docker.com/mac/main/arm64/123456/Docker.dmg';
    const { get, urls } = fakeGet({
      [URL_DMG]: () => respond(302, '', { location: '/mac/main/arm64/123456/Docker.dmg' }),
      [mirror]: () => respond(200, 'dmg'),
    });
    await downloadFile({ url: URL_DMG, target, get });
    expect(urls).toEqual([URL_DMG, mirror]);
    expect(fs.readFileSync(target, 'utf8')).toBe('dmg');
  });

  it('refuses a redirect that leaves HTTPS', async () => {
    const { get } = fakeGet({ [URL_DMG]: () => respond(301, '', { location: 'http://desktop.docker.com/Docker.dmg' }) });
    await expect(downloadFile({ url: URL_DMG, target, get })).rejects.toThrow(/not HTTPS on docker\.com/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each([
    ['another domain', 'https://desktop.docker.com.evil.example/Docker.dmg', false],
    ['a look-alike domain', 'https://evildocker.com/Docker.dmg', false],
    ['another host of Docker', 'https://download.docker.com/Docker.dmg', true],
  ])('follows a redirect to %s only on docker.com', async (_name, location, allowed) => {
    const { get } = fakeGet({ [URL_DMG]: () => respond(302, '', { location }), [location]: () => respond(200, 'dmg') });
    const result = downloadFile({ url: URL_DMG, target, get });
    if (allowed) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow(/not HTTPS on docker\.com/);
  });

  it('refuses a URL that is not HTTPS on desktop.docker.com, without a request', async () => {
    const { get, urls } = fakeGet({});
    for (const url of ['http://desktop.docker.com/mac/main/arm64/Docker.dmg', 'https://example.com/Docker.dmg']) {
      await expect(downloadFile({ url, target, get })).rejects.toThrow(/desktop\.docker\.com/);
    }
    expect(urls).toEqual([]);
  });

  it('stops after too many redirects', async () => {
    const { get } = fakeGet({ [URL_DMG]: () => respond(302, '', { location: URL_DMG }) });
    await expect(downloadFile({ url: URL_DMG, target, get })).rejects.toThrow(/Too many redirects/);
  });

  it('fails on an HTTP error and keeps an existing file', async () => {
    fs.writeFileSync(target, 'old');
    const { get } = fakeGet({ [URL_DMG]: () => respond(404, 'not found') });
    await expect(downloadFile({ url: URL_DMG, target, get })).rejects.toThrow(/HTTP status 404/);
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
  });

  it('fails on a short download and removes the partial file', async () => {
    const { get } = fakeGet({ [URL_DMG]: () => respond(200, 'inst', { 'content-length': '9' }) });
    await expect(downloadFile({ url: URL_DMG, target, get })).rejects.toThrow(/4 of 9 bytes/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('is cancelled with the signal and removes the partial file', async () => {
    const body = new PassThrough();
    const { get } = fakeGet({ [URL_DMG]: () => respond(200, body) });
    const controller = new AbortController();
    const done = downloadFile({
      url: URL_DMG,
      target,
      get,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    body.write(Buffer.from('part'));
    const error = await done.catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not start when the signal has aborted', async () => {
    const { get, urls } = fakeGet({ [URL_DMG]: () => respond(200, 'x') });
    const controller = new AbortController();
    controller.abort();
    const error = await downloadFile({ url: URL_DMG, target, get, signal: controller.signal }).catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(urls).toEqual([]);
  });
});
