// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of plan step 11H1 (reviewer B, mutation testing): probes of the rules of the shared VS Code server store
// (vscodeServerStore.ts) that no test held: the store's own folders as links (the worker never writes outside the store),
// links in the archive (readableForAll never changes a file outside the store), --no-same-owner, the upper-case SHA-256
// of the update service, the redirects 307 and 308, the Content-Length check, the modes of the temporary files and the
// lock folder, an existing archive file, a body that ignores the abort, and the cancel and the time limit of `tar`.
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpStreamResponse } from '../http';
import { silentLogger, type Logger } from '../ports';
import { downloadToFile, ensureServer, serverFolder, serverPlatform, storeLock, unpackServer, type VscodeStoreDeps } from './vscodeServerStore';

const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };
const DOWNLOAD = 'https://vscode.download.prss.microsoft.com/dbazure/download/stable/0123/vscode-server-linux-x64.tar.gz';
const NAME = `stable-linux-x64-${SERVER.commit}`;

const temps: string[] = [];
function tempDir(prefix = 'devenv-vscode-probe-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
const savedPath = process.env.PATH;
afterEach(() => {
  vi.restoreAllMocks();
  process.env.PATH = savedPath;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** A server archive (one top folder with bin/code-server, node, out/main.js), plus what `extra` adds into the top folder. */
function archive(extra: (top: string) => void = () => undefined, tarArgs: string[] = []): Buffer {
  const dir = tempDir('devenv-vscode-probe-archive-');
  const top = path.join(dir, 'vscode-server-linux-x64');
  fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(top, 'out'), { recursive: true });
  fs.writeFileSync(path.join(top, 'bin', 'code-server'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(top, 'node'), 'ELF', { mode: 0o755 });
  fs.writeFileSync(path.join(top, 'out', 'main.js'), '//', { mode: 0o644 });
  extra(top);
  const file = path.join(dir, 'server.tar.gz');
  const made = spawnSync('tar', ['-czf', file, ...tarArgs, '-C', dir, 'vscode-server-linux-x64']);
  if (made.status !== 0) throw new Error(`tar: ${made.stderr.toString()}`);
  return fs.readFileSync(file);
}

interface Options {
  body?: Buffer;
  api?: Record<string, unknown>;
  downloads?: Record<string, () => HttpStreamResponse>;
}

function harness(options: Options = {}, more: Partial<VscodeStoreDeps> = {}) {
  const root = tempDir();
  const log: string[] = [];
  const logger: Logger = { ...silentLogger, info: (message) => log.push(`info ${message}`), warn: (message) => log.push(`warn ${message}`) };
  const body = options.body ?? archive();
  const deps: VscodeStoreDeps = {
    root,
    transport: {
      request: async () => ({ status: 200, headers: {}, body: JSON.stringify(options.api ?? { url: DOWNLOAD, sha256hash: sha256(body) }) }),
      stream: async (url: string) => {
        const answer = options.downloads?.[url];
        if (answer) return answer();
        if (url === DOWNLOAD) return { status: 200, headers: {}, body: Readable.from([body]) };
        return { status: 404, headers: {}, body: Readable.from([]) };
      },
    },
    architecture: async () => 'x86_64',
    lock: async () => () => undefined,
    unpack: (file, folder, signal) => unpackServer(file, folder, signal),
    logger,
    ...more,
  };
  return { deps, root, log, body, folder: serverFolder(root, SERVER, 'linux-x64') };
}

const signal = () => new AbortController().signal;
/** Every path below `dir` (relative), sorted. */
const tree = (dir: string): string[] => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).sort() : []);

describe('the worker never writes outside the store (review round 1 of 11H1, reviewer B)', () => {
  it('the temporary folder of the store as a link: refused, nothing written or removed where it points', async () => {
    const h = harness();
    const elsewhere = tempDir();
    // A folder there named like a leftover of this version: it must stay.
    fs.mkdirSync(path.join(elsewhere, `${NAME}-0123456789ab`));
    fs.symlinkSync(elsewhere, path.join(h.root, 'tmp'));
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(false);
    expect(tree(elsewhere)).toEqual([`${NAME}-0123456789ab`]);
    expect(h.log[h.log.length - 1]).toContain('is not a folder');
  });

  it('a folder of the server path as a link: refused, nothing written where it points', async () => {
    const h = harness();
    const elsewhere = tempDir();
    fs.symlinkSync(elsewhere, path.join(h.root, 'server'));
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(false);
    expect(tree(elsewhere)).toEqual([]);
    expect(h.log[h.log.length - 1]).toContain('is not a folder');
  });

  it('a link in the archive: the file it points to keeps its mode (readableForAll leaves links as they are)', async () => {
    const outside = path.join(tempDir(), 'secret');
    fs.writeFileSync(outside, 'x', { mode: 0o600 });
    fs.chmodSync(outside, 0o600);
    const h = harness({ body: archive((top) => fs.symlinkSync(outside, path.join(top, 'out', 'link'))) });
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(true);
    expect(fs.lstatSync(path.join(h.folder, 'out', 'link')).isSymbolicLink()).toBe(true);
    expect(fs.statSync(outside).mode & 0o777).toBe(0o600);
  });

  it('the files of the archive belong to the worker, never to the owner that the archive names (--no-same-owner)', async () => {
    const uid = process.getuid?.();
    const h = harness({ body: archive(undefined, ['--owner=4321', '--group=4321', '--numeric-owner']) });
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(true);
    for (const file of ['node', 'bin/code-server', 'out/main.js']) expect(fs.lstatSync(path.join(h.folder, file)).uid).toBe(uid);
  });
});

describe('what the update service and the download answer (review round 1 of 11H1, reviewer B)', () => {
  it('puts the server into place with one rename of its unpacked folder (a first check without the lock never sees half of it)', async () => {
    const h = harness();
    const rename = vi.spyOn(fs.promises, 'rename');
    const cp = vi.spyOn(fs.promises, 'cp');
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(true);
    const last = rename.mock.calls[rename.mock.calls.length - 1];
    expect(String(last[1])).toBe(h.folder);
    expect(String(last[0])).toMatch(new RegExp(`^${h.root}/tmp/${NAME}-[0-9a-f]{12}/server$`));
    expect(cp).not.toHaveBeenCalled();
  });

  it('ends the body of a redirect, and refuses an answer other than 200 (206)', async () => {
    const body = archive();
    const next = 'https://cdn.example.com/server.tar.gz';
    const redirectBody = Readable.from([Buffer.from('moved')]);
    const h = harness({
      body,
      downloads: {
        [DOWNLOAD]: () => ({ status: 302, headers: { location: next }, body: redirectBody }),
        [next]: () => ({ status: 206, headers: {}, body: Readable.from([body]) }),
      },
    });
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(false);
    expect(h.log[h.log.length - 1]).toContain('(the download answered HTTP 206)');
    expect(redirectBody.destroyed).toBe(true);
  });

  it('refuses an archive whose node is a folder (bin/code-server and node must be plain files)', async () => {
    const h = harness({
      body: archive((top) => {
        fs.rmSync(path.join(top, 'node'));
        fs.mkdirSync(path.join(top, 'node'));
      }),
    });
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(false);
    expect(h.log[h.log.length - 1]).toContain('(the archive has no bin/code-server or no node)');
    expect(fs.existsSync(h.folder)).toBe(false);
  });

  it.each([
    ['an answer other than 200 (203)', 203, { url: DOWNLOAD, sha256hash: 'a'.repeat(64) }, 'the update service answered HTTP 203'],
    ['a SHA-256 with more characters', 200, { url: DOWNLOAD, sha256hash: `${'a'.repeat(64)}0` }, 'the update service answered no SHA-256'],
    ['a SHA-256 that is no hexadecimal', 200, { url: DOWNLOAD, sha256hash: 'z'.repeat(64) }, 'the update service answered no SHA-256'],
  ])('refuses %s of the update service before any download', async (_name, status, answer, why) => {
    const h = harness();
    const streamed: string[] = [];
    h.deps.transport = {
      request: async () => ({ status, headers: {}, body: JSON.stringify(answer) }),
      stream: async (url: string) => {
        streamed.push(url);
        return { status: 404, headers: {}, body: Readable.from([]) };
      },
    };
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(false);
    expect(h.log[h.log.length - 1]).toContain(`(${why})`);
    expect(streamed).toEqual([]);
  });

  it('takes the SHA-256 of the update service in upper case', async () => {
    const body = archive();
    const h = harness({ body, api: { url: DOWNLOAD, sha256hash: sha256(body).toUpperCase() } });
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(true);
  });

  it.each([307, 308])('follows a redirect %s to https', async (status) => {
    const body = archive();
    const next = 'https://cdn.example.com/server.tar.gz';
    const h = harness({
      body,
      downloads: {
        [DOWNLOAD]: () => ({ status, headers: { location: next }, body: Readable.from([]) }),
        [next]: () => ({ status: 200, headers: {}, body: Readable.from([body]) }),
      },
    });
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(true);
  });

  it('refuses a download whose Content-Length is over the limit before it reads the body', async () => {
    const body = archive();
    let read = false;
    const h = harness(
      {
        body,
        downloads: {
          [DOWNLOAD]: () => ({
            status: 200,
            headers: { 'content-length': String(body.length + 1) },
            body: new Readable({
              read() {
                read = true;
                this.push(body);
                this.push(null);
              },
            }),
          }),
        },
      },
      { maxBytes: body.length },
    );
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(false);
    expect(h.log[h.log.length - 1]).toContain(`(the download is larger than ${body.length} bytes)`);
    expect(read).toBe(false);
  });

  it('takes a download of exactly the limit', async () => {
    const body = archive();
    const h = harness({ body }, { maxBytes: body.length });
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(true);
  });

  it('the archive and its folders are private while they are downloaded and unpacked', async () => {
    const seen: Record<string, number> = {};
    const h = harness();
    h.deps.unpack = async (file, folder, abort) => {
      const mode = (p: string) => fs.lstatSync(p).mode & 0o777;
      seen.tmp = mode(path.dirname(path.dirname(file)));
      seen.own = mode(path.dirname(file));
      seen.archive = mode(file);
      seen.unpacked = mode(folder);
      await unpackServer(file, folder, abort);
    };
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', signal())).toBe(true);
    expect(seen).toEqual({ tmp: 0o700, own: 0o700, archive: 0o600, unpacked: 0o700 });
  });

  it('never writes into an existing file (downloadToFile)', async () => {
    const file = path.join(tempDir(), 'server.tar.gz');
    fs.writeFileSync(file, 'old');
    const transport = { stream: async () => ({ status: 200, headers: {}, body: Readable.from([Buffer.from('new')]) }) };
    await expect(downloadToFile(transport, DOWNLOAD, file, 100, signal())).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
  });

  it('a cancel ends a download whose body does not end by itself (downloadToFile)', async () => {
    const file = path.join(tempDir(), 'server.tar.gz');
    // A body that sends one piece and then nothing, and does not watch the signal.
    const body = new Readable({ read() {} });
    body.push(Buffer.from('partial'));
    const transport = { stream: async () => ({ status: 200, headers: {}, body }) };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(downloadToFile(transport, DOWNLOAD, file, 100, controller.signal)).rejects.toThrow();
  });

  it('maps the architecture of the engine whatever its case and white space', () => {
    expect(serverPlatform(' X86_64\n')).toBe('linux-x64');
    expect(serverPlatform('AARCH64')).toBe('linux-arm64');
  });
});

describe('the lock folder and tar (review round 1 of 11H1, reviewer B)', () => {
  it('creates the folder of the lock files private (0700)', async () => {
    const root = tempDir();
    const release = await storeLock(root, NAME, 5, signal(), () => ({ exited: Promise.resolve({ exitCode: 0 }), kill: () => undefined }));
    expect(fs.lstatSync(path.join(root, 'locks')).mode & 0o777).toBe(0o700);
    release();
  });

  it('closes the lock file when the lock cannot be taken', async () => {
    if (!fs.existsSync('/proc/self/fd')) return;
    const root = tempDir();
    const open = () => fs.readdirSync('/proc/self/fd').filter((fd) => {
      try {
        return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(path.join(root, 'locks'));
      } catch {
        return false;
      }
    }).length;
    await expect(storeLock(root, NAME, 5, signal(), () => ({ exited: Promise.resolve({ exitCode: 1 }), kill: () => undefined }))).rejects.toThrow('flock failed');
    expect(open()).toBe(0);
  });

  /** A `tar` on the PATH that sleeps (a hung unpack). */
  function sleepingTar(): void {
    const bin = tempDir('devenv-vscode-probe-bin-');
    fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    process.env.PATH = `${bin}:${savedPath ?? '/usr/bin:/bin'}`;
  }

  it('a cancel ends a running tar', async () => {
    sleepingTar();
    const dir = tempDir();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await expect(unpackServer(path.join(dir, 'a.tar.gz'), dir, controller.signal)).rejects.toThrow('the unpack was cancelled');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('the time limit ends a running tar', async () => {
    sleepingTar();
    const dir = tempDir();
    const started = Date.now();
    await expect(unpackServer(path.join(dir, 'a.tar.gz'), dir, signal(), 200)).rejects.toThrow('the unpack took longer than 0 s');
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
