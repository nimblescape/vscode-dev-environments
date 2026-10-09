// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, D3 and the plan's 11H2 row): what the Session Monitor's background run uses of the
// store: the released commits of the update service (the host fixed, the answer capped and strictly parsed), the version
// of a temporary folder, the lock of a version without a wait (`flock -n`), and the marker of the last use of a version
// (the modification time of its folder), which the open sets too.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCK_BUSY_EXIT } from '../helperChannel/protocol';
import type { FlockProcess } from '../helperChannel/lockFile';
import type { HttpRequest, HttpResponse, HttpStreamTransport, HttpTransport } from '../http';
import { silentLogger } from '../ports';
import {
  MAX_SERVER_COMMITS_BYTES,
  ensureEngineServer,
  markServerUsed,
  parseServerCommits,
  serverCommits,
  serverCommitsUrl,
  serverFolder,
  serverLockFile,
  storeTryLock,
  temporaryFolderVersion,
  type VscodeStoreDeps,
} from './vscodeServerStore';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-vscode-11h2-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function readyServer(root: string, commit = COMMIT): string {
  const folder = serverFolder(root, { commit, quality: 'stable' }, 'linux-x64');
  fs.mkdirSync(path.join(folder, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'bin', 'code-server'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(folder, 'node'), '');
  return folder;
}

describe('the released commits of the update service (plan step 11H2, D3)', () => {
  it('asks the fixed host for the commits of a quality and platform', () => {
    expect(serverCommitsUrl('stable', 'linux-x64')).toBe('https://update.code.visualstudio.com/api/commits/stable/server-linux-x64');
    expect(serverCommitsUrl('insider', 'linux-arm64')).toBe('https://update.code.visualstudio.com/api/commits/insider/server-linux-arm64');
  });

  it('takes a JSON array of 40-hex commits, newest first', () => {
    expect(parseServerCommits(JSON.stringify([COMMIT, OTHER]))).toEqual([COMMIT, OTHER]);
    expect(parseServerCommits(` [ "${COMMIT}" ] `)).toEqual([COMMIT]);
  });

  it('refuses anything else: no array, empty, a short, upper-case or foreign entry, a duplicate, too large', () => {
    for (const body of [
      '',
      'not json',
      JSON.stringify({ commits: [COMMIT] }),
      '[]',
      JSON.stringify([COMMIT.slice(1)]),
      JSON.stringify([COMMIT.toUpperCase()]),
      JSON.stringify([COMMIT, 'https://example.com']),
      JSON.stringify([COMMIT, 7]),
      JSON.stringify([COMMIT, COMMIT]),
      JSON.stringify(`${COMMIT}`),
    ]) {
      expect(parseServerCommits(body), body).toBeUndefined();
    }
    const many = Array.from({ length: Math.ceil(MAX_SERVER_COMMITS_BYTES / 43) + 1 }, (_, index) => index.toString(16).padStart(40, '0'));
    expect(parseServerCommits(JSON.stringify(many))).toBeUndefined();
  });

  it('requests with the cap and rejects a status other than 200 or an invalid answer', async () => {
    const requests: HttpRequest[] = [];
    const answer = (response: HttpResponse): HttpTransport => ({
      request: async (request) => {
        requests.push(request);
        return response;
      },
    });
    const signal = new AbortController().signal;
    expect(await serverCommits(answer({ status: 200, headers: {}, body: JSON.stringify([COMMIT]) }), 'stable', 'linux-x64', signal)).toEqual([COMMIT]);
    expect(requests[0]).toMatchObject({ method: 'GET', url: serverCommitsUrl('stable', 'linux-x64'), maxBodyBytes: MAX_SERVER_COMMITS_BYTES });
    await expect(serverCommits(answer({ status: 404, headers: {}, body: '[]' }), 'stable', 'linux-x64', signal)).rejects.toThrow('HTTP 404');
    await expect(serverCommits(answer({ status: 200, headers: {}, body: '{"url":"x"}' }), 'stable', 'linux-x64', signal)).rejects.toThrow('no list of commits');
  });
});

describe('the temporary folders of the store (plan step 11H2)', () => {
  it('names the version of a temporary folder of a download or a removal, and nothing else', () => {
    expect(temporaryFolderVersion(`stable-linux-x64-${COMMIT}-0a1b2c3d4e5f`)).toEqual({ quality: 'stable', platform: 'linux-x64', commit: COMMIT, version: `stable-linux-x64-${COMMIT}` });
    expect(temporaryFolderVersion(`insider-linux-arm64-${COMMIT}-ab`)?.version).toBe(`insider-linux-arm64-${COMMIT}`);
    for (const name of [`stable-linux-x64-${COMMIT}`, `beta-linux-x64-${COMMIT}-ab`, `stable-darwin-${COMMIT}-ab`, `stable-linux-x64-${COMMIT}-XY`, '..', 'server.lock']) {
      expect(temporaryFolderVersion(name), name).toBeUndefined();
    }
  });
});

describe('the lock of a version without a wait (plan step 11H2, flock -n)', () => {
  const flock = (outcome: Awaited<FlockProcess['exited']>, seen: Array<readonly string[]>) => (args: readonly string[]) => {
    seen.push(args);
    return { exited: Promise.resolve(outcome), kill: () => {} };
  };

  it('runs flock -n on the lock file of the version and gives its release; a held lock is busy', async () => {
    const root = tempDir();
    const seen: Array<readonly string[]> = [];
    const locked = await storeTryLock(root, `stable-linux-x64-${COMMIT}`, flock({ exitCode: 0 }, seen));
    expect(locked.kind).toBe('locked');
    expect(seen[0]).toEqual(['-n', '-E', String(LOCK_BUSY_EXIT), '3']);
    expect(fs.lstatSync(serverLockFile(root, `stable-linux-x64-${COMMIT}`)).isFile()).toBe(true);
    if (locked.kind === 'locked') locked.release();
    expect(await storeTryLock(root, `stable-linux-x64-${COMMIT}`, flock({ exitCode: LOCK_BUSY_EXIT }, seen))).toEqual({ kind: 'busy' });
    expect((await storeTryLock(root, `stable-linux-x64-${COMMIT}`, flock({ exitCode: 1 }, seen))).kind).toBe('failed');
    expect((await storeTryLock(root, `stable-linux-x64-${COMMIT}`, flock({ exitCode: null, error: 'ENOENT' }, seen))).kind).toBe('failed');
    // The lock file stays (lock files are never removed).
    expect(fs.existsSync(serverLockFile(root, `stable-linux-x64-${COMMIT}`))).toBe(true);
  });

  it('refuses a lock file that is a link (opened without following it)', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'locks'));
    fs.symlinkSync(path.join(root, 'elsewhere'), serverLockFile(root, `stable-linux-x64-${COMMIT}`));
    const attempt = await storeTryLock(root, `stable-linux-x64-${COMMIT}`, () => ({ exited: Promise.resolve({ exitCode: 0 }), kill: () => {} }));
    expect(attempt.kind).toBe('failed');
    expect(fs.existsSync(path.join(root, 'elsewhere'))).toBe(false);
  });

  it('with the real flock: free, then busy while another holder keeps it, free again after its release', async () => {
    const root = tempDir();
    const first = await storeTryLock(root, `stable-linux-x64-${COMMIT}`);
    expect(first.kind).toBe('locked');
    expect((await storeTryLock(root, `stable-linux-x64-${COMMIT}`)).kind).toBe('busy');
    if (first.kind === 'locked') first.release();
    const again = await storeTryLock(root, `stable-linux-x64-${COMMIT}`);
    expect(again.kind).toBe('locked');
    if (again.kind === 'locked') again.release();
  });
});

describe('the marker of the last use of a version (plan step 11H2)', () => {
  it('sets the modification time of the folder, without following a link', async () => {
    const root = tempDir();
    const folder = readyServer(root);
    const past = new Date(Date.parse('2026-01-01T00:00:00Z'));
    fs.utimesSync(folder, past, past);
    const at = new Date(Date.parse('2026-10-09T12:00:00Z'));
    await markServerUsed(folder, at);
    expect(fs.lstatSync(folder).mtimeMs).toBe(at.getTime());
    const target = tempDir();
    fs.utimesSync(target, past, past);
    const link = path.join(root, 'link');
    fs.symlinkSync(target, link);
    await markServerUsed(link, at);
    expect(fs.statSync(target).mtimeMs).toBe(past.getTime());
    // A missing folder is no failure.
    await markServerUsed(path.join(root, 'missing'), at);
  });

  it('the open marks the version that it needs as used (ensureEngineServer)', async () => {
    const root = tempDir();
    const folder = readyServer(root);
    const past = new Date(Date.parse('2026-01-01T00:00:00Z'));
    fs.utimesSync(folder, past, past);
    const unused = () => {
      throw new Error('not used');
    };
    const deps: VscodeStoreDeps = {
      root,
      transport: { request: unused, stream: unused } as unknown as HttpTransport & HttpStreamTransport,
      architecture: async () => 'x86_64',
      lock: unused,
      unpack: unused,
      logger: silentLogger,
    };
    const before = Date.now();
    expect(await ensureEngineServer(deps, { commit: COMMIT, quality: 'stable' }, new AbortController().signal)).toBe('linux-x64');
    expect(fs.lstatSync(folder).mtimeMs).toBeGreaterThanOrEqual(before - 1000);
  });
});
