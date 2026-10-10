// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Fix after the live check of 2026-10-10 (an open waited the 10 minutes of the fetch for a download of the VS Code server
// that hung): a download that receives nothing for the stall time ends as stalled (no answer, or no data of its body;
// every chunk starts the time again), the answer of the update service has the same time, and a failed download says how
// far it came. A cancel of the caller stays its own error.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpStreamResponse } from '../http';
import { silentLogger, type Logger } from '../ports';
import { DOWNLOAD_STALL_MS, downloadToFile, ensureServer, unpackServer, type VscodeStoreDeps } from './vscodeServerStore';

const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };
const URL_ = 'https://vscode.download.prss.microsoft.com/dbazure/download/stable/0123/vscode-server-linux-x64.tar.gz';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-stall-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const never = (): AbortSignal => new AbortController().signal;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A body that sends `first` and then nothing, until it is destroyed. */
function hangingBody(first: Buffer): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(first);
      }
    },
  });
}

/** A stream transport with one answer for URL_ (and the signal it was given). */
function streamOf(answer: (signal?: AbortSignal) => Promise<HttpStreamResponse>) {
  const signals: Array<AbortSignal | undefined> = [];
  return {
    signals,
    transport: {
      stream: (url: string, signal?: AbortSignal) => {
        signals.push(signal);
        return url === URL_ ? answer(signal) : Promise.resolve({ status: 404, headers: {}, body: Readable.from([]) });
      },
    },
  };
}

/** Rejects with an AbortError when `signal` aborts. */
function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), { once: true });
  });
}

describe('a download that receives nothing ends as stalled (live check of 2026-10-10)', () => {
  it('is 30 s by default', () => {
    expect(DOWNLOAD_STALL_MS).toBe(30_000);
  });

  it('a body that stops sending ends after the stall time, saying how far it came', async () => {
    const file = path.join(tempDir(), 'server.tar.gz');
    const t = streamOf(async () => ({ status: 200, headers: { 'content-length': String(3 * 1024 * 1024) }, body: hangingBody(Buffer.alloc(1024 * 1024)) }));
    const started = Date.now();
    await expect(downloadToFile(t.transport, URL_, file, 10 * 1024 * 1024, never(), undefined, undefined, 80)).rejects.toThrow(
      /^the download stalled: no data for 0 s after 1\.0 of 3\.0 MiB in \d+ s$/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('no answer at all ends after the stall time too, and the request gets an aborted signal', async () => {
    const file = path.join(tempDir(), 'server.tar.gz');
    const t = streamOf((signal) => untilAborted(signal));
    await expect(downloadToFile(t.transport, URL_, file, 1024, never(), undefined, undefined, 50)).rejects.toThrow(/^the download stalled: no data for 0 s after 0\.0 MiB in \d+ s$/);
    expect(t.signals[0]?.aborted).toBe(true);
  });

  it('every chunk starts the time again: a slow body that keeps sending finishes', async () => {
    const file = path.join(tempDir(), 'server.tar.gz');
    const chunks = Array.from({ length: 6 }, (_, i) => Buffer.from(`chunk ${i};`));
    const t = streamOf(async () => ({
      status: 200,
      headers: {},
      body: Readable.from(
        (async function* () {
          for (const chunk of chunks) {
            await sleep(40);
            yield chunk;
          }
        })(),
      ),
    }));
    // 6 chunks 40 ms apart: 240 ms in all, more than the stall time of 120 ms, never 120 ms without data.
    const hash = await downloadToFile(t.transport, URL_, file, 1024, never(), undefined, undefined, 120);
    expect(fs.readFileSync(file, 'utf8')).toBe(Buffer.concat(chunks).toString('utf8'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a connection reset in the body says how far it came', async () => {
    const file = path.join(tempDir(), 'server.tar.gz');
    const t = streamOf(async () => ({
      status: 200,
      headers: { 'content-length': String(4 * 1024 * 1024) },
      body: Readable.from(
        (async function* () {
          yield Buffer.alloc(2 * 1024 * 1024);
          throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        })(),
      ),
    }));
    await expect(downloadToFile(t.transport, URL_, file, 10 * 1024 * 1024, never())).rejects.toThrow(/^read ECONNRESET after 2\.0 of 4\.0 MiB in \d+ s$/);
  });

  it('a cancel of the caller stays the caller error (AbortError), never a stall', async () => {
    const file = path.join(tempDir(), 'server.tar.gz');
    const caller = new AbortController();
    const t = streamOf(async () => ({ status: 200, headers: {}, body: hangingBody(Buffer.from('x')) }));
    const download = downloadToFile(t.transport, URL_, file, 1024, caller.signal, undefined, undefined, 60_000);
    setTimeout(() => caller.abort(), 30);
    await expect(download).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('the fetch of a server with a stalled update service or download (live check of 2026-10-10)', () => {
  function deps(transport: VscodeStoreDeps['transport'], log: string[]): VscodeStoreDeps {
    const logger: Logger = { ...silentLogger, info: (message) => log.push(`info ${message}`), warn: (message) => log.push(`warn ${message}`) };
    return {
      root: tempDir(),
      transport,
      architecture: async () => 'x86_64',
      lock: async () => () => undefined,
      unpack: (file, folder, signal) => unpackServer(file, folder, signal),
      logger,
      stallMs: 60,
    };
  }

  it('an update service that does not answer: not ready after the stall time, one line', async () => {
    const log: string[] = [];
    const transport: VscodeStoreDeps['transport'] = {
      request: (_request, signal) => untilAborted(signal),
      stream: async () => ({ status: 404, headers: {}, body: Readable.from([]) }),
    };
    const started = Date.now();
    expect(await ensureServer(deps(transport, log), SERVER, 'linux-x64', never())).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(log.filter((line) => line.startsWith('warn'))).toEqual([
      `warn The VS Code server ${SERVER.commit} (stable) for linux-x64 could not be fetched into the shared store (the update service did not answer within 0 s); the Dev Containers extension installs it in the container.`,
    ]);
  });

  it('a download that stalls: not ready after the stall time, the line says how far it came, no temporary files', async () => {
    const log: string[] = [];
    const transport: VscodeStoreDeps['transport'] = {
      request: async () => ({ status: 200, headers: {}, body: JSON.stringify({ url: URL_, sha256hash: 'a'.repeat(64) }) }),
      stream: async () => ({ status: 200, headers: { 'content-length': String(2 * 1024 * 1024) }, body: hangingBody(Buffer.alloc(1024 * 1024)) }),
    };
    const d = deps(transport, log);
    expect(await ensureServer(d, SERVER, 'linux-x64', never())).toBe(false);
    const warn = log.find((line) => line.startsWith('warn')) ?? '';
    expect(warn).toMatch(/could not be fetched into the shared store \(the download stalled: no data for 0 s after 1\.0 of 2\.0 MiB in \d+ s\); the Dev Containers extension installs it/);
    expect(fs.existsSync(path.join(d.root, 'tmp')) ? fs.readdirSync(path.join(d.root, 'tmp')) : []).toEqual([]);
  });
});
