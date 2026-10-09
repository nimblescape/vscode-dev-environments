// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of 11H2 (reviewer B, mutation testing: its probes, adopted; each kills a mutant that survived the
// tests of 11H2): the commits of the update service become paths in the store (serverFolder, the lock file, the link
// script), so each must be exactly 40 hex characters (no `..`, no `/` before or after); the lock of a version without a
// wait closes its file on every outcome, and only once; its folder `locks` is never a link. The store is a temporary
// folder (never the home folder); nothing needs root. And the small rules: at most MAX_SERVER_COMMITS commits, a
// temporary folder's name from its start, the log line of a fetch of the background run.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCK_BUSY_EXIT } from '../helperChannel/protocol';
import type { HttpStreamTransport, HttpTransport } from '../http';
import { MAX_SERVER_COMMITS, MAX_SERVER_COMMITS_BYTES, ensureServer, parseServerCommits, serverCommits, storeTryLock, temporaryFolderVersion, type VscodeStoreDeps } from './vscodeServerStore';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const NAME = `stable-linux-x64-${COMMIT}`;

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-11h2r1-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The open file descriptors of this process (Linux). */
const openFds = () => fs.readdirSync('/proc/self/fd').length;

describe('11H2 review round 1 (B): the commits of the update service are exactly 40 hex characters', () => {
  it('refuses a commit with anything before or after it (a path in the store)', () => {
    for (const commit of [`../../../${COMMIT}`, `x${COMMIT}`, `${COMMIT}/..`, `${COMMIT}0`, `${COMMIT}\n`]) {
      expect(parseServerCommits(JSON.stringify([commit])), commit).toBeUndefined();
    }
  });

  it('refuses an answer over the cap even when the transport gave it whole', () => {
    const body = JSON.stringify([COMMIT]) + ' '.repeat(MAX_SERVER_COMMITS_BYTES);
    expect(parseServerCommits(body)).toBeUndefined();
  });

  it('takes only the answer 200', async () => {
    const transport: HttpTransport = { request: async () => ({ status: 203, headers: {}, body: JSON.stringify([COMMIT]) }) };
    await expect(serverCommits(transport, 'stable', 'linux-x64', new AbortController().signal)).rejects.toThrow('HTTP 203');
  });
});

describe.skipIf(!fs.existsSync('/proc/self/fd'))('11H2 review round 1 (B): the lock of a version without a wait closes its file', () => {
  it('when the lock is held (busy) and when flock fails or cannot be started', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'locks'));
    const before = openFds();
    expect(await storeTryLock(root, NAME, () => ({ exited: Promise.resolve({ exitCode: LOCK_BUSY_EXIT }), kill: () => {} }))).toEqual({ kind: 'busy' });
    expect((await storeTryLock(root, NAME, () => ({ exited: Promise.resolve({ exitCode: 1 }), kill: () => {} }))).kind).toBe('failed');
    expect(
      (
        await storeTryLock(root, NAME, () => {
          throw new Error('spawn failed');
        })
      ).kind,
    ).toBe('failed');
    expect(
      (
        await storeTryLock(root, NAME, () => ({
          exited: Promise.reject(new Error('gone')),
          kill: () => {},
        }))
      ).kind,
    ).toBe('failed');
    expect(openFds()).toBe(before);
  });

  it('a second release closes nothing (the number of its file may belong to another file by then)', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'locks'));
    const locked = await storeTryLock(root, NAME, () => ({ exited: Promise.resolve({ exitCode: 0 }), kill: () => {} }));
    expect(locked.kind).toBe('locked');
    if (locked.kind !== 'locked') return;
    locked.release();
    const other = fs.openSync(path.join(root, 'other'), 'w');
    try {
      locked.release();
      expect(() => fs.fstatSync(other)).not.toThrow();
    } finally {
      try {
        fs.closeSync(other);
      } catch {
        // Closed by the second release (the probe fails above).
      }
    }
  });
});

describe('11H2 review round 1 (B): the folder of the lock files', () => {
  it('a link in its place fails, and no lock file is made at its target', async () => {
    const root = tempDir();
    const elsewhere = tempDir();
    fs.symlinkSync(elsewhere, path.join(root, 'locks'));
    const attempt = await storeTryLock(root, NAME, () => ({ exited: Promise.resolve({ exitCode: 0 }), kill: () => {} }));
    expect(attempt.kind).toBe('failed');
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});

describe('11H2 review round 1 (B): the small rules of the store', () => {
  it('refuses more than MAX_SERVER_COMMITS commits (within the byte cap)', () => {
    const many = Array.from({ length: MAX_SERVER_COMMITS + 1 }, (_, index) => index.toString(16).padStart(40, '0'));
    expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThanOrEqual(MAX_SERVER_COMMITS_BYTES);
    expect(parseServerCommits(JSON.stringify(many))).toBeUndefined();
    expect(parseServerCommits(JSON.stringify(many.slice(1)))).toHaveLength(MAX_SERVER_COMMITS);
  });

  it('a temporary folder names its version from the start of its name', () => {
    expect(temporaryFolderVersion(`xstable-linux-x64-${COMMIT}-ab`)).toBeUndefined();
    expect(temporaryFolderVersion(`../stable-linux-x64-${COMMIT}-ab`)).toBeUndefined();
  });

  it('a fetch of the background run that fails names the run and no fallback of the Dev Containers extension', async () => {
    const warnings: string[] = [];
    const unused = () => {
      throw new Error('not used');
    };
    const deps = (background: boolean): VscodeStoreDeps => ({
      root: tempDir(),
      transport: { request: unused, stream: unused } as unknown as HttpTransport & HttpStreamTransport,
      architecture: unused,
      lock: async () => Promise.reject(new Error('lock refused')),
      unpack: unused,
      logger: { info: () => {}, warn: (message: string) => void warnings.push(message), error: () => {}, output: () => {} } as unknown as VscodeStoreDeps['logger'],
      ...(background ? { background: true } : {}),
    });
    const server = { commit: COMMIT, quality: 'stable' as const };
    expect(await ensureServer(deps(true), server, 'linux-x64', new AbortController().signal)).toBe(false);
    expect(await ensureServer(deps(true), server, 'linux-x64', AbortSignal.abort())).toBe(false);
    expect(await ensureServer(deps(false), server, 'linux-x64', AbortSignal.abort())).toBe(false);
    expect(warnings).toEqual([
      `The VS Code server ${COMMIT} (stable) for linux-x64 could not be fetched into the shared store (lock refused).`,
      `The VS Code server ${COMMIT} (stable) for linux-x64 could not be fetched into the shared store (the run was ended).`,
      `The VS Code server ${COMMIT} (stable) for linux-x64 could not be fetched into the shared store (the open was cancelled); the Dev Containers extension installs it in the container.`,
    ]);
  });
});
