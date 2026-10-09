// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 2 of plan step 11H1: a download never moves away or removes a folder of the server that is already ready
// (a dev container may run the server from it); it keeps that folder and drops its own copy. A fake transport and a fake
// unpack (no `tar`); the store is a temporary folder.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../ports';
import { ensureServer, isServerReady, serverFolder, type VscodeStoreDeps } from './vscodeServerStore';

const SERVER = { commit: '0123456789abcdef0123456789abcdef01234567', quality: 'stable' as const };
const DOWNLOAD = 'https://vscode.download.prss.microsoft.com/dbazure/download/stable/0123/vscode-server-linux-x64.tar.gz';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A ready server (bin/code-server and node) in `folder`, with the file `marker`. */
function readyServer(folder: string, marker: string): void {
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(folder, 'node'), 'ELF', { mode: 0o755 });
  fs.writeFileSync(path.join(folder, marker), '');
}

function harness(unpack: VscodeStoreDeps['unpack']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-store-r2-'));
  temps.push(root);
  const body = Buffer.from('the archive');
  const log: string[] = [];
  const logger: Logger = { ...silentLogger, info: (message) => log.push(`info ${message}`), warn: (message) => log.push(`warn ${message}`) };
  const deps: VscodeStoreDeps = {
    root,
    transport: {
      request: async () => ({ status: 200, headers: {}, body: JSON.stringify({ url: DOWNLOAD, sha256hash: createHash('sha256').update(body).digest('hex') }) }),
      stream: async (url) => (url === DOWNLOAD ? { status: 200, headers: {}, body: Readable.from([body]) } : { status: 404, headers: {}, body: Readable.from([]) }),
    },
    architecture: async () => 'x86_64',
    lock: async () => () => undefined,
    unpack,
    logger,
  };
  return { deps, root, log, folder: serverFolder(root, SERVER, 'linux-x64') };
}

describe('a download keeps a folder of the server that is ready (review round 2 of 11H1)', () => {
  it('the folder became ready during the download: it stays as it is, the new copy goes', async () => {
    let folder = '';
    const h = harness(async (_archive, unpacked) => {
      readyServer(unpacked, 'new');
      // Another writer finished the folder of the commit while this download ran.
      readyServer(folder, 'kept');
    });
    folder = h.folder;
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', new AbortController().signal)).toBe(true);
    expect(await isServerReady(h.folder)).toBe(true);
    expect(fs.existsSync(path.join(h.folder, 'kept'))).toBe(true);
    expect(fs.existsSync(path.join(h.folder, 'new'))).toBe(false);
    // The temporary folder of the download (with the new copy) is gone.
    expect(fs.readdirSync(path.join(h.root, 'tmp'))).toEqual([]);
    expect(h.log.filter((line) => line.startsWith('warn'))).toEqual([]);
  });

  it('a folder that is not ready is still replaced by the download', async () => {
    const h = harness(async (_archive, unpacked) => readyServer(unpacked, 'new'));
    fs.mkdirSync(path.join(h.folder, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(h.folder, 'half'), '');
    expect(await ensureServer(h.deps, SERVER, 'linux-x64', new AbortController().signal)).toBe(true);
    expect(fs.existsSync(path.join(h.folder, 'new'))).toBe(true);
    expect(fs.existsSync(path.join(h.folder, 'half'))).toBe(false);
    expect(fs.readdirSync(path.join(h.root, 'tmp'))).toEqual([]);
  });
});
