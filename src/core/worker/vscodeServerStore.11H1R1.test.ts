// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11H1: the time limit of the fetch covers the read of the engine's architecture and of the
// daemon's proxy settings (A-L1), the store drops setuid, setgid and sticky bits (A-L2), and the answer of the update
// service is read with a size cap (reviewer B).
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import { httpsRequest, type HttpRequest } from '../http';
import { silentLogger, type Logger } from '../ports';
import { proxiedHttpsTransport } from '../proxyTransport';
import { MAX_UPDATE_SERVICE_BYTES, ensureEngineServer, ensureServer, readableForAll, unpackServer, type VscodeStoreDeps } from './vscodeServerStore';

const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };

const temps: string[] = [];
const servers: http.Server[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-store-r1-'));
  temps.push(dir);
  return dir;
}
const savedPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = savedPath;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Settles `promise` or says 'pending' after `ms` (so a hang fails the test at once instead of its time limit). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);
}

function deps(more: Partial<VscodeStoreDeps>): { deps: VscodeStoreDeps; log: string[]; requests: HttpRequest[] } {
  const log: string[] = [];
  const requests: HttpRequest[] = [];
  const logger: Logger = { ...silentLogger, info: (message) => log.push(`info ${message}`), warn: (message) => log.push(`warn ${message}`) };
  return {
    log,
    requests,
    deps: {
      root: tempDir(),
      transport: {
        request: async (request) => {
          requests.push(request);
          return { status: 404, headers: {}, body: '' };
        },
        stream: async () => {
          throw new Error('no download in this test');
        },
      },
      architecture: async () => 'x86_64',
      lock: async () => () => undefined,
      unpack: async () => undefined,
      logger,
      ...more,
    },
  };
}

describe('the time limit of the fetch covers its reads of the engine (review round 1 of 11H1, A-L1)', () => {
  it('a GET /info that never answers ends at the time limit: not fetched, one line', async () => {
    // The fake ignores its signal too: the limit ends the wait whatever the call does.
    const h = deps({ architecture: () => new Promise<string>(() => undefined), timeoutMs: 50 });
    expect(await within(ensureEngineServer(h.deps, SERVER, new AbortController().signal), 2_000)).toBeUndefined();
    expect(h.log).toEqual([`warn The VS Code server ${SERVER.commit} (stable) is not fetched into the shared store: the architecture of the engine could not be read (no answer within 0 s).`]);
  });

  it('the read of the architecture gets the signal of the limit', async () => {
    let seen: AbortSignal | undefined;
    const h = deps({
      architecture: (signal) => {
        seen = signal;
        return new Promise<string>(() => undefined);
      },
      timeoutMs: 50,
    });
    await within(ensureEngineServer(h.deps, SERVER, new AbortController().signal), 2_000);
    expect(seen?.aborted).toBe(true);
  });

  it('a cancel during the read of the architecture: not fetched, the cancel named', async () => {
    const h = deps({ architecture: () => new Promise<string>(() => undefined) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    expect(await within(ensureEngineServer(h.deps, SERVER, controller.signal), 2_000)).toBeUndefined();
    expect(h.log[0]).toContain('(the open was cancelled)');
  });

  it('proxy settings that never come end at the time limit (ensureServer): not ready, one line', async () => {
    const h = deps({ transport: proxiedHttpsTransport(() => new Promise(() => undefined)), timeoutMs: 50 });
    expect(await within(ensureServer(h.deps, SERVER, 'linux-x64', new AbortController().signal), 2_000)).toBe(false);
    expect(h.log.at(-1)).toContain('could not be fetched into the shared store (the fetch took longer than 0 s)');
  });

  it('the transport: a request whose proxy settings never come ends with its signal', async () => {
    const transport = proxiedHttpsTransport(() => new Promise(() => undefined));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(within(transport.request({ method: 'GET', url: 'https://update.code.visualstudio.com/x' }, controller.signal), 2_000)).rejects.toThrow(
      'The request ended before the proxy settings of the Docker engine were read.',
    );
    await expect(within(transport.stream('https://update.code.visualstudio.com/x', AbortSignal.abort()), 2_000)).rejects.toThrow('proxy settings');
  });
});

describe('readableForAll drops the setuid, setgid and sticky bits (review round 1 of 11H1, A-L2)', () => {
  it('keeps the permission bits plus read (and execute where any is set), without 07000', async () => {
    const dir = tempDir();
    const files: Array<[string, number, number]> = [
      ['setuid', 0o4755, 0o755],
      ['setgid', 0o2711, 0o755],
      ['sticky', 0o1644, 0o644],
      ['all', 0o7700, 0o755],
      ['plain', 0o600, 0o644],
    ];
    for (const [name, mode] of files) {
      fs.writeFileSync(path.join(dir, name), '');
      fs.chmodSync(path.join(dir, name), mode);
    }
    // Skip only where the file system does not keep the bits at all (then there is nothing to drop).
    if ((fs.statSync(path.join(dir, 'setuid')).mode & 0o7000) === 0) return;
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.chmodSync(path.join(dir, 'sub'), 0o3777);
    await readableForAll(dir);
    for (const [name, , wanted] of files) expect([name, fs.statSync(path.join(dir, name)).mode & 0o7777]).toEqual([name, wanted]);
    expect(fs.statSync(path.join(dir, 'sub')).mode & 0o7777).toBe(0o755);
  });
});

describe('the answer of the update service has a size cap (review round 1 of 11H1, reviewer B)', () => {
  it('asks for at most 64 KiB, and a larger answer is not ready (one line)', async () => {
    expect(MAX_UPDATE_SERVICE_BYTES).toBe(64 * 1024);
    const json = JSON.stringify({ url: 'https://example.com/server.tar.gz', sha256hash: 'a'.repeat(64) });
    const h = deps({});
    h.deps.transport.request = async (request) => {
      h.requests.push(request);
      return { status: 200, headers: {}, body: json + ' '.repeat(MAX_UPDATE_SERVICE_BYTES + 1 - json.length) };
    };
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', new AbortController().signal)).toBe(false);
    expect(h.requests.map((request) => request.maxBodyBytes)).toEqual([MAX_UPDATE_SERVICE_BYTES]);
    expect(h.log.at(-1)).toContain(`(the update service answered more than ${MAX_UPDATE_SERVICE_BYTES} bytes)`);
  });

  it('httpsRequest reads at most maxBodyBytes, never more than its own limit', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.end(Buffer.alloc(100, 'a'));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const options = { createConnection: () => net.connect(port, '127.0.0.1') };
    await expect(httpsRequest({ method: 'GET', url: 'https://update.code.visualstudio.com/x', maxBodyBytes: 99 }, undefined, options)).rejects.toThrow('is too large');
    expect((await httpsRequest({ method: 'GET', url: 'https://update.code.visualstudio.com/x', maxBodyBytes: 100 }, undefined, options)).body.length).toBe(100);
  });
});

describe('a tar that does not end (review round 1 of 11H1, reviewer B: S51, S52)', () => {
  /** A `tar` on the PATH that never ends by itself (it sleeps 30 s). */
  function sleepingTar(): void {
    const bin = tempDir();
    fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    process.env.PATH = `${bin}:${savedPath ?? '/usr/bin:/bin'}`;
  }

  /** A fetch whose download is `body`, with the hash of the update service right. */
  function fetching(more: Partial<VscodeStoreDeps>) {
    const body = Buffer.from('an archive');
    const url = 'https://vscode.download.prss.microsoft.com/server.tar.gz';
    let released = 0;
    const h = deps({
      lock: async () => () => {
        released++;
      },
      ...more,
    });
    h.deps.transport = {
      request: async () => ({ status: 200, headers: {}, body: JSON.stringify({ url, sha256hash: createHash('sha256').update(body).digest('hex') }) }),
      stream: async () => ({ status: 200, headers: {}, body: Readable.from([body]) }),
    };
    return { ...h, released: () => released };
  }

  it.each([
    ['the time limit of the whole fetch', { timeoutMs: 300, unpack: (archive: string, folder: string, signal: AbortSignal) => unpackServer(archive, folder, signal) }],
    ['the time limit of the unpack', { unpack: (archive: string, folder: string, signal: AbortSignal) => unpackServer(archive, folder, signal, 300) }],
  ])('%s kills it: not ready, the lock released, the temporary files gone', async (_name, more) => {
    sleepingTar();
    const h = fetching(more);
    const started = Date.now();
    expect(await within(ensureServer(h.deps, SERVER, 'linux-x64', new AbortController().signal), 5_000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(h.released()).toBe(1);
    expect(fs.readdirSync(path.join(h.deps.root, 'tmp'))).toEqual([]);
  });
});
