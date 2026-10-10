// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H1 (decisions of 2026-10-03, "Shared VS Code server store" and "The caches never slow down an open"): the
// fetch of a VS Code server into the shared store (ensureServer), with a fake HTTPS transport, a temporary folder as the
// store, and the real `tar` (a tiny archive made here). Every failure is one line and "not ready"; the temporary files go
// on every outcome.
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, HttpStreamResponse } from '../http';
import { LOCK_BUSY_EXIT } from '../helperChannel/protocol';
import type { FlockProcess } from '../helperChannel/lockFile';
import { silentLogger, type Logger } from '../ports';
import {
  MAX_SERVER_ARCHIVE_BYTES,
  MAX_SERVER_REDIRECTS,
  SERVER_FETCH_TIMEOUT_MS,
  ensureEngineServer,
  ensureServer,
  serverLockFile,
  serverVersionName,
  isServerReady,
  serverFolder,
  serverPlatform,
  serverVersionUrl,
  storeLock,
  unpackServer,
  type VscodeStoreDeps,
} from './vscodeServerStore';

const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };
const DOWNLOAD = 'https://vscode.download.prss.microsoft.com/dbazure/download/stable/0123/vscode-server-linux-x64.tar.gz';

const temps: string[] = [];
function tempDir(prefix = 'devenv-vscode-store-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A server archive as the update service has it: one top folder with `bin/code-server`, `node` and more. */
function archive(options: { node?: boolean; top?: string } = {}): Buffer {
  const dir = tempDir('devenv-vscode-archive-');
  const top = path.join(dir, options.top ?? 'vscode-server-linux-x64');
  fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(top, 'out'), { recursive: true });
  fs.writeFileSync(path.join(top, 'bin', 'code-server'), '#!/bin/sh\necho server\n', { mode: 0o700 });
  if (options.node !== false) fs.writeFileSync(path.join(top, 'node'), 'ELF', { mode: 0o700 });
  fs.writeFileSync(path.join(top, 'out', 'main.js'), '//', { mode: 0o600 });
  fs.chmodSync(path.join(top, 'out'), 0o700);
  const file = path.join(dir, 'server.tar.gz');
  const made = spawnSync('tar', ['-czf', file, '-C', dir, options.top ?? 'vscode-server-linux-x64']);
  if (made.status !== 0) throw new Error(`tar: ${made.stderr.toString()}`);
  return fs.readFileSync(file);
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

interface FakeServe {
  /** The answer of the update service (default: the URL and the SHA-256 of `body`). */
  api?: HttpResponse;
  /** The answers of the download, by URL (default: `body` at DOWNLOAD). */
  downloads?: Record<string, (signal?: AbortSignal) => HttpStreamResponse>;
  body?: Buffer;
}

/** A transport that answers the update service and the download, and records each URL. */
function transport(serve: FakeServe) {
  const body = serve.body ?? archive();
  const urls: string[] = [];
  const t: VscodeStoreDeps['transport'] = {
    request: async (request: HttpRequest) => {
      urls.push(request.url);
      return serve.api ?? { status: 200, headers: {}, body: JSON.stringify({ url: DOWNLOAD, sha256hash: sha256(body), name: '1.105.0' }) };
    },
    stream: async (url: string, signal?: AbortSignal) => {
      urls.push(url);
      const answer = serve.downloads?.[url];
      if (answer) return answer(signal);
      if (url === DOWNLOAD) return { status: 200, headers: { 'content-length': String(body.length) }, body: Readable.from([body]) };
      return { status: 404, headers: {}, body: Readable.from([]) };
    },
  };
  return { transport: t, urls, body };
}

function harness(serve: FakeServe = {}, more: Partial<VscodeStoreDeps> = {}) {
  const root = tempDir();
  const log: string[] = [];
  const logger: Logger = { ...silentLogger, info: (message) => log.push(`info ${message}`), warn: (message) => log.push(`warn ${message}`) };
  const locks: Array<{ root: string; name: string; waitSeconds: number }> = [];
  let released = 0;
  const fake = transport(serve);
  const deps: VscodeStoreDeps = {
    root,
    transport: fake.transport,
    architecture: async () => 'x86_64',
    lock: async (lockRoot, name, waitSeconds) => {
      locks.push({ root: lockRoot, name, waitSeconds });
      return () => {
        released++;
      };
    },
    unpack: (file, folder, signal) => unpackServer(file, folder, signal),
    logger,
    ...more,
  };
  const folder = serverFolder(root, SERVER, 'linux-x64');
  return { deps, root, log, locks, released: () => released, urls: fake.urls, folder };
}

const signal = () => new AbortController().signal;
const tmpEntries = (root: string): string[] => (fs.existsSync(path.join(root, 'tmp')) ? fs.readdirSync(path.join(root, 'tmp')) : []);

describe('the platform and the URL of a server (plan step 11H1)', () => {
  it('maps the architecture of the engine; anything else has no server', () => {
    expect(serverPlatform('x86_64')).toBe('linux-x64');
    expect(serverPlatform('amd64')).toBe('linux-x64');
    expect(serverPlatform('aarch64')).toBe('linux-arm64');
    expect(serverPlatform('arm64')).toBe('linux-arm64');
    for (const other of ['armv7l', 'ppc64le', 's390x', 'riscv64', '', 'x86']) expect(serverPlatform(other)).toBeUndefined();
  });

  it('asks the fixed update service, never a URL of a parameter', () => {
    expect(serverVersionUrl(SERVER, 'linux-arm64')).toBe(`https://update.code.visualstudio.com/api/versions/commit:${SERVER.commit}/server-linux-arm64/stable`);
    expect(serverFolder('/vscode', { ...SERVER, quality: 'insider' }, 'linux-x64')).toBe(`/vscode/server/insider/linux-x64/${SERVER.commit}`);
    expect(SERVER_FETCH_TIMEOUT_MS).toBe(600_000);
    expect(MAX_SERVER_ARCHIVE_BYTES).toBe(512 * 1024 * 1024);
    expect(MAX_SERVER_REDIRECTS).toBe(5);
  });
});

describe('ensureServer (plan step 11H1)', () => {
  it('a server that is ready: nothing is asked, fetched, or locked', async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.folder, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(h.folder, 'bin', 'code-server'), '');
    fs.writeFileSync(path.join(h.folder, 'node'), '');
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBe('linux-x64');
    expect(h.urls).toEqual([]);
    expect(h.locks).toEqual([]);
    expect(h.log).toEqual([]);
  });

  it('downloads, checks, unpacks and renames the server into place, readable for all, under the lock', async () => {
    const h = harness();
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBe('linux-x64');
    expect(h.urls).toEqual([serverVersionUrl(SERVER, 'linux-x64'), DOWNLOAD]);
    // The lock of this server version (decision of 2026-10-09: one download of a version at a time on the engine).
    expect(h.locks).toEqual([{ root: h.root, name: `stable-linux-x64-${SERVER.commit}`, waitSeconds: 600 }]);
    expect(h.released()).toBe(1);
    expect(await isServerReady(h.folder)).toBe(true);
    const mode = (file: string) => fs.statSync(path.join(h.folder, file)).mode & 0o777;
    // Folders 0755, files their mode plus read, and execute where an execute bit was set (0700 → 0755, 0600 → 0644).
    expect(mode('.')).toBe(0o755);
    expect(mode('bin')).toBe(0o755);
    expect(mode('out')).toBe(0o755);
    expect(mode('bin/code-server')).toBe(0o755);
    expect(mode('node')).toBe(0o755);
    expect(mode('out/main.js')).toBe(0o644);
    for (const folder of ['server', 'server/stable', 'server/stable/linux-x64']) expect(fs.statSync(path.join(h.root, folder)).mode & 0o777).toBe(0o755);
    // The temporary files are gone.
    expect(tmpEntries(h.root)).toEqual([]);
    expect(h.log).toEqual([
      `info Downloading the VS Code server ${SERVER.commit} (stable) for linux-x64 into the shared store of the engine.`,
      `info The VS Code server ${SERVER.commit} (stable) for linux-x64 is in the shared store.`,
    ]);
  });

  it('checks again under the lock: a server that another fetch put into place is not fetched again', async () => {
    const h = harness();
    h.deps.lock = async () => {
      fs.mkdirSync(path.join(h.folder, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(h.folder, 'bin', 'code-server'), '');
      fs.writeFileSync(path.join(h.folder, 'node'), '');
      return () => undefined;
    };
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBe('linux-x64');
    expect(h.urls).toEqual([]);
    expect(h.log).toEqual([
      `info Downloading the VS Code server ${SERVER.commit} (stable) for linux-x64 into the shared store of the engine.`,
      `info The VS Code server ${SERVER.commit} (stable) for linux-x64 was put into the shared store by another window in the meantime.`,
    ]);
  });

  it('ensureServer takes the platform (the Session Monitor of plan step 11H2 calls it): arm64 into its own folder', async () => {
    const h = harness();
    const arm = serverFolder(h.root, SERVER, 'linux-arm64');
    expect(await ensureServer(h.deps, SERVER, 'linux-arm64', signal())).toBe(true);
    expect(h.urls[0]).toBe(serverVersionUrl(SERVER, 'linux-arm64'));
    expect(h.locks.map((lock) => lock.name)).toEqual([serverVersionName(SERVER, 'linux-arm64')]);
    expect(await isServerReady(arm)).toBe(true);
    expect(fs.existsSync(h.folder)).toBe(false);
  });

  it('an engine that does not say its architecture: nothing is fetched (one line)', async () => {
    const h = harness({}, {
      architecture: async () => {
        throw new Error('no answer');
      },
    });
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBeUndefined();
    expect(h.urls).toEqual([]);
    expect(h.log).toEqual([`warn The VS Code server ${SERVER.commit} (stable) is not fetched into the shared store: the architecture of the engine could not be read (no answer).`]);
  });

  it('the engine of another architecture: nothing is fetched (one line)', async () => {
    const h = harness({}, { architecture: async () => 'ppc64le' });
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBeUndefined();
    expect(h.urls).toEqual([]);
    expect(h.log).toEqual([`info The VS Code server ${SERVER.commit} (stable) is not fetched into the shared store: the engine's architecture "ppc64le" has no server there.`]);
  });

  /** The failure line of a fetch, after the line that announces it. */
  const failure = (log: string[]) => {
    expect(log).toHaveLength(2);
    expect(log[1]).toMatch(/^warn The VS Code server .* for linux-x64 could not be fetched into the shared store \(.*\); the Dev Containers extension installs it in the container\.$/);
    return log[1];
  };

  it('a SHA-256 that is not the one of the update service: not ready, nothing in place, the temporary files gone', async () => {
    const body = archive();
    const h = harness({ body, api: { status: 200, headers: {}, body: JSON.stringify({ url: DOWNLOAD, sha256hash: 'f'.repeat(64) }) } });
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBeUndefined();
    expect(failure(h.log)).toContain(`the SHA-256 of the download ${sha256(body)} is not the ${'f'.repeat(64)} of the update service`);
    expect(fs.existsSync(h.folder)).toBe(false);
    expect(tmpEntries(h.root)).toEqual([]);
    expect(h.released()).toBe(1);
  });

  it.each([
    ['an HTTP error of the update service', { status: 404, headers: {}, body: '' }, 'the update service answered HTTP 404'],
    ['no JSON', { status: 200, headers: {}, body: '<html>' }, 'the update service answered no JSON'],
    ['no SHA-256', { status: 200, headers: {}, body: JSON.stringify({ url: DOWNLOAD }) }, 'the update service answered no SHA-256'],
    ['a URL without TLS', { status: 200, headers: {}, body: JSON.stringify({ url: 'http://example.com/s.tar.gz', sha256hash: 'a'.repeat(64) }) }, 'the update service answered no https URL'],
  ])('%s: not ready', async (_name, api, why) => {
    const h = harness({ api });
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBeUndefined();
    expect(failure(h.log)).toContain(`(${why})`);
    expect(h.urls).toEqual([serverVersionUrl(SERVER, 'linux-x64')]);
  });

  it('an HTTP error of the download: not ready', async () => {
    const h = harness({ downloads: { [DOWNLOAD]: () => ({ status: 503, headers: {}, body: Readable.from([]) }) } });
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBeUndefined();
    expect(failure(h.log)).toContain('(the download answered HTTP 503)');
    expect(tmpEntries(h.root)).toEqual([]);
  });

  it('a download larger than the limit, by its length or by what comes: not ready, the file gone', async () => {
    const body = archive();
    for (const headers of [{ 'content-length': String(body.length) }, {}] as Array<Record<string, string>>) {
      const h = harness({ body, downloads: { [DOWNLOAD]: () => ({ status: 200, headers, body: Readable.from([body]) }) } }, { maxBytes: body.length - 1 });
      expect(await ensureEngineServer(h.deps, SERVER, signal())).toBeUndefined();
      expect(failure(h.log)).toContain(`(the download is larger than ${body.length - 1} bytes)`);
      expect(tmpEntries(h.root)).toEqual([]);
    }
  });

  it('follows at most five redirects, each to an https URL', async () => {
    const hop = (n: number): string => `https://cdn${n}.example.com/server.tar.gz`;
    const redirect = (to: string) => () => ({ status: 302, headers: { location: to }, body: Readable.from([]) });
    const body = archive();
    // Five hops: taken.
    const five: Record<string, () => HttpStreamResponse> = { [DOWNLOAD]: redirect(hop(1)) };
    for (let n = 1; n < 5; n++) five[hop(n)] = redirect(hop(n + 1));
    five[hop(5)] = () => ({ status: 200, headers: {}, body: Readable.from([body]) });
    const ok = harness({ body, downloads: five });
    expect(await ensureEngineServer(ok.deps, SERVER, signal())).toBe('linux-x64');
    expect(ok.urls).toHaveLength(7);
    // Six: refused.
    const six = { ...five, [hop(5)]: redirect(hop(6)), [hop(6)]: () => ({ status: 200, headers: {}, body: Readable.from([body]) }) };
    const tooMany = harness({ body, downloads: six });
    expect(await ensureEngineServer(tooMany.deps, SERVER, signal())).toBeUndefined();
    expect(failure(tooMany.log)).toContain('(the download was redirected more than 5 times)');
    // A relative location is taken against the current URL; one to http is refused, and one without a location.
    const relative = harness({ body, downloads: { [DOWNLOAD]: redirect('/other/server.tar.gz'), 'https://vscode.download.prss.microsoft.com/other/server.tar.gz': () => ({ status: 200, headers: {}, body: Readable.from([body]) }) } });
    expect(await ensureEngineServer(relative.deps, SERVER, signal())).toBe('linux-x64');
    const plain = harness({ body, downloads: { [DOWNLOAD]: redirect('http://cdn.example.com/server.tar.gz') } });
    expect(await ensureEngineServer(plain.deps, SERVER, signal())).toBeUndefined();
    expect(failure(plain.log)).toContain('(the download was redirected to a URL that is not https)');
    const none = harness({ body, downloads: { [DOWNLOAD]: () => ({ status: 301, headers: {}, body: Readable.from([]) }) } });
    expect(await ensureEngineServer(none.deps, SERVER, signal())).toBeUndefined();
    expect(failure(none.log)).toContain('(the download was redirected to a URL that is not https)');
  });

  /** A download that sends a first piece and then nothing until it is aborted. */
  const hanging = (signal?: AbortSignal): HttpStreamResponse => {
    const body = new Readable({ read() {} });
    body.push(Buffer.from('partial'));
    signal?.addEventListener('abort', () => body.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    return { status: 200, headers: {}, body };
  };

  it('the time limit of the whole fetch: not ready, the temporary files gone', async () => {
    const h = harness({ downloads: { [DOWNLOAD]: hanging } }, { timeoutMs: 1000 });
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBeUndefined();
    expect(failure(h.log)).toContain('(the fetch took longer than 1 s)');
    expect(tmpEntries(h.root)).toEqual([]);
    expect(h.released()).toBe(1);
  });

  it('a cancel of the open ends the fetch: not ready, the temporary files gone', async () => {
    const controller = new AbortController();
    const h = harness({
      downloads: {
        [DOWNLOAD]: (abort) => {
          setTimeout(() => controller.abort(), 20);
          return hanging(abort);
        },
      },
    });
    expect(await ensureEngineServer(h.deps, SERVER, controller.signal)).toBeUndefined();
    expect(failure(h.log)).toContain('(the open was cancelled)');
    expect(tmpEntries(h.root)).toEqual([]);
    expect(fs.existsSync(h.folder)).toBe(false);
  });

  it('a lock that cannot be taken: not ready, nothing fetched', async () => {
    const h = harness({}, {
      lock: async () => {
        throw new Error('the lock of the server stayed held for 600 s');
      },
    });
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBeUndefined();
    expect(failure(h.log)).toContain('(the lock of the server stayed held for 600 s)');
    expect(h.urls).toEqual([]);
  });

  it('an archive that tar cannot unpack, or without node: not ready, the temporary files gone', async () => {
    const garbage = Buffer.from('this is no gzip archive');
    const bad = harness({ body: garbage });
    expect(await ensureEngineServer(bad.deps, SERVER, signal())).toBeUndefined();
    expect(failure(bad.log)).toMatch(/\(tar failed \(exit code \d+\)/);
    expect(tmpEntries(bad.root)).toEqual([]);
    const noNode = harness({ body: archive({ node: false }) });
    expect(await ensureEngineServer(noNode.deps, SERVER, signal())).toBeUndefined();
    expect(failure(noNode.log)).toContain('(the archive has no bin/code-server or no node)');
    expect(fs.existsSync(noNode.folder)).toBe(false);
  });

  it('removes the leftovers of a download of the same version that ended without its cleanup, never those of others', async () => {
    const h = harness();
    const version = serverVersionName(SERVER, 'linux-x64');
    fs.mkdirSync(path.join(h.root, 'tmp', `${version}-0123456789ab`, 'server'), { recursive: true });
    fs.writeFileSync(path.join(h.root, 'tmp', `${version}-0123456789ab`, 'server.tar.gz'), 'x');
    // A download of another version may run now (under its own lock): its folder stays.
    const other = `stable-linux-arm64-${SERVER.commit}-ba9876543210`;
    fs.mkdirSync(path.join(h.root, 'tmp', other), { recursive: true });
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBe('linux-x64');
    expect(tmpEntries(h.root)).toEqual([other]);
  });

  it('each download has a temporary folder of its own, named by its version', async () => {
    const h = harness();
    const seen: string[] = [];
    h.deps.unpack = async (archive, folder, abort) => {
      seen.push(path.relative(h.root, archive), path.relative(h.root, folder));
      await unpackServer(archive, folder, abort);
    };
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBe('linux-x64');
    const prefix = `tmp/${serverVersionName(SERVER, 'linux-x64')}-`;
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(new RegExp(`^${prefix}[0-9a-f]{12}/server\\.tar\\.gz$`));
    expect(seen[1]).toBe(path.join(path.dirname(seen[0]), 'server'));
    expect(tmpEntries(h.root)).toEqual([]);
  });

  it('replaces a folder of the commit that is not ready', async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.folder, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(h.folder, 'half'), '');
    expect(await ensureEngineServer(h.deps, SERVER, signal())).toBe('linux-x64');
    expect(await isServerReady(h.folder)).toBe(true);
    expect(fs.existsSync(path.join(h.folder, 'half'))).toBe(false);
  });

  it('a link in place of bin/code-server or node is not ready', async () => {
    const folder = path.join(tempDir(), 'server');
    fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'node'), '');
    fs.symlinkSync('/bin/sh', path.join(folder, 'bin', 'code-server'));
    expect(await isServerReady(folder)).toBe(false);
  });
});

describe('the lock of the store (plan step 11H1)', () => {
  /** A fake flock that exits with `exitCode`; records its arguments. */
  function flock(exitCode: number | null, error?: string) {
    const calls: Array<readonly string[]> = [];
    const killed: string[] = [];
    const start = (args: readonly string[]): FlockProcess => {
      calls.push(args);
      return { exited: Promise.resolve({ exitCode, ...(error !== undefined ? { error } : {}) }), kill: (s) => killed.push(s) };
    };
    return { start, calls, killed };
  }

  const NAME = `stable-linux-x64-${SERVER.commit}`;

  it('takes flock on the lock file of the server version with the wait; the release closes the file', async () => {
    const root = tempDir();
    const f = flock(0);
    const release = await storeLock(root, NAME, 600, signal(), f.start);
    expect(f.calls).toEqual([['-w', '600', '-E', String(LOCK_BUSY_EXIT), '3']]);
    expect(serverLockFile(root, NAME)).toBe(path.join(root, 'locks', `server-${NAME}.lock`));
    expect(fs.lstatSync(serverLockFile(root, NAME)).isFile()).toBe(true);
    expect(fs.statSync(serverLockFile(root, NAME)).mode & 0o777).toBe(0o600);
    release();
    release();
  });

  it('rejects a lock held for the whole wait, a failed flock, and a link as the lock file', async () => {
    await expect(storeLock(tempDir(), NAME, 5, signal(), flock(LOCK_BUSY_EXIT).start)).rejects.toThrow('the lock of the server stayed held for 5 s');
    await expect(storeLock(tempDir(), NAME, 5, signal(), flock(null, 'ENOENT').start)).rejects.toThrow('flock could not be started: ENOENT');
    await expect(storeLock(tempDir(), NAME, 5, signal(), flock(1).start)).rejects.toThrow('flock failed (exit code 1)');
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'locks'));
    const elsewhere = path.join(tempDir(), 'elsewhere');
    fs.symlinkSync(elsewhere, serverLockFile(root, NAME));
    await expect(storeLock(root, NAME, 5, signal(), flock(0).start)).rejects.toThrow();
    expect(fs.existsSync(elsewhere)).toBe(false);
    // The folder of the locks as a link is refused too.
    const linked = tempDir();
    fs.symlinkSync(tempDir(), path.join(linked, 'locks'));
    await expect(storeLock(linked, NAME, 5, signal(), flock(0).start)).rejects.toThrow('is not a folder');
  });

  it('with the real flock: a second holder waits, and gets it after the release', async () => {
    const root = tempDir();
    const first = await storeLock(root, NAME, 5, signal());
    await expect(storeLock(root, NAME, 1, signal())).rejects.toThrow('the lock of the server stayed held for 1 s');
    // Another version is not held by it (its download runs at the same time).
    const other = await storeLock(root, `stable-linux-arm64-${SERVER.commit}`, 1, signal());
    other();
    first();
    const second = await storeLock(root, NAME, 1, signal());
    second();
  });

  it('a cancel ends the wait (flock is killed)', async () => {
    const root = tempDir();
    const held = await storeLock(root, NAME, 5, signal());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(storeLock(root, NAME, 30, controller.signal)).rejects.toThrow('the wait for the lock of the server ended');
    held();
  });
});

describe('the unpack of the archive (plan step 11H1)', () => {
  it('strips the top folder, and ends tar on a cancel', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.tar.gz');
    fs.writeFileSync(file, archive());
    const folder = path.join(dir, 'out');
    fs.mkdirSync(folder);
    await unpackServer(file, folder, signal());
    expect(fs.readdirSync(folder).sort()).toEqual(['bin', 'node', 'out']);
    const controller = new AbortController();
    controller.abort();
    await expect(unpackServer(file, path.join(dir, 'none'), controller.signal)).rejects.toThrow('the unpack was ended');
  });
});
