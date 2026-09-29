// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Monitor cleanup, user decision 2026-09-29 (R6–R8): the sweep of the storage folder by the Session Monitor.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeJsonAtomic } from './atomicJson';
import { StoragePaths } from './paths';
import {
  ATOMIC_TEMPORARY_FILE,
  STALE_DISCONNECT_MAX_AGE_MS,
  STALE_PENDING_MAX_AGE_MS,
  STALE_TEMPORARY_MAX_AGE_MS,
  sweepStorage,
} from './storageSweep';

const ENV_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ENV_B = '7c1d2e3f-0000-4000-8000-000000000002';
const ENV_C = '7c1d2e3f-0000-4000-8000-000000000003';
const WINDOW = 'b7c1d2e3-0000-4000-8000-000000000001';
const T0 = Date.parse('2026-09-29T12:00:00.000Z');
const MINUTE = 60_000;

let root: string;
let paths: StoragePaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-sweep-'));
  paths = new StoragePaths(root);
  paths.ensureDirectoriesSync();
  fs.mkdirSync(paths.disconnectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Writes a file with the modification time `mtime`. */
function write(file: string, text: string, mtime = T0): void {
  fs.writeFileSync(file, text);
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

function pending(environmentId: string, createdAt: number): string {
  return JSON.stringify({ environmentId, windowId: WINDOW, createdAt: new Date(createdAt).toISOString() });
}

function request(environmentId: string, requestedAt: number): string {
  return JSON.stringify({ environmentId, operation: 'stop', requestedAt: new Date(requestedAt).toISOString(), requestedBy: WINDOW, reason: 'manual' });
}

function names(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

describe('sweepStorage', () => {
  it('R6: removes pending connection files more than an hour from now, both ways, and keeps younger ones', async () => {
    write(paths.pendingFile(ENV_A), pending(ENV_A, T0 - STALE_PENDING_MAX_AGE_MS - 1));
    write(paths.pendingFile(ENV_B), pending(ENV_B, T0 + STALE_PENDING_MAX_AGE_MS + 1));
    write(paths.pendingFile(ENV_C), pending(ENV_C, T0 - STALE_PENDING_MAX_AGE_MS));
    const removed = await sweepStorage(paths, T0);
    expect(removed.pending.sort()).toEqual([path.join('pending', `${ENV_A}.json`), path.join('pending', `${ENV_B}.json`)].sort());
    expect(names(paths.pendingDir)).toEqual([`${ENV_C}.json`]);
  });

  it('R6: a pending file without a valid time counts by its modification time; other names are left alone', async () => {
    write(paths.pendingFile(ENV_A), '{ broken', T0 - 2 * STALE_PENDING_MAX_AGE_MS);
    write(paths.pendingFile(ENV_B), '{ broken', T0 - MINUTE);
    write(path.join(paths.pendingDir, 'notes.txt'), 'x', T0 - 48 * 60 * MINUTE);
    write(path.join(paths.pendingDir, 'a.b.json'), pending(ENV_C, 0), T0 - 48 * 60 * MINUTE);
    await sweepStorage(paths, T0);
    expect(names(paths.pendingDir)).toEqual([`${ENV_B}.json`, 'a.b.json', 'notes.txt']);
  });

  it('R7: removes disconnect requests older than 10 minutes and keeps younger ones', async () => {
    write(paths.disconnectFile(ENV_A), request(ENV_A, T0 - STALE_DISCONNECT_MAX_AGE_MS - 1));
    write(paths.disconnectFile(ENV_B), request(ENV_B, T0 - STALE_DISCONNECT_MAX_AGE_MS));
    write(paths.disconnectFile(ENV_C), request(ENV_C, T0 + STALE_DISCONNECT_MAX_AGE_MS + 1));
    const removed = await sweepStorage(paths, T0);
    expect(removed.disconnect.sort()).toEqual([path.join('disconnect', `${ENV_A}.json`), path.join('disconnect', `${ENV_C}.json`)].sort());
    expect(names(paths.disconnectDir)).toEqual([`${ENV_B}.json`]);
  });

  it('R8: removes the temporary files of writeJsonAtomic older than an hour in the storage folders, and nothing else', async () => {
    const old = T0 - STALE_TEMPORARY_MAX_AGE_MS - MINUTE;
    const young = T0 - STALE_TEMPORARY_MAX_AGE_MS + MINUTE;
    const temp = (dir: string, name: string, hex: string) => path.join(dir, `.${name}.1234.${hex}.tmp`);
    for (const dir of [paths.root, paths.sessionsDir, paths.pendingDir, paths.operationsDir, paths.disconnectDir]) {
      write(temp(dir, 'x.json', '0123abcd'), '{}', old);
      write(temp(dir, 'y.json', '89abcdef'), '{}', young);
    }
    // Not of writeJsonAtomic: kept whatever their age.
    write(path.join(paths.root, '.x.json.1234.ABCDEF01.tmp'), '{}', old);
    write(path.join(paths.root, 'x.json.1234.0123abcd.tmp'), '{}', old);
    write(path.join(paths.root, 'registry.json'), '{}', old);
    // In another folder: not swept.
    fs.mkdirSync(path.join(root, 'other'));
    write(temp(path.join(root, 'other'), 'x.json', '0123abcd'), '{}', old);
    const removed = await sweepStorage(paths, T0);
    expect(removed.temporary).toHaveLength(5);
    for (const dir of [paths.sessionsDir, paths.pendingDir, paths.operationsDir, paths.disconnectDir]) {
      expect(names(dir)).toEqual(['.y.json.1234.89abcdef.tmp']);
    }
    expect(names(paths.root)).toContain('.x.json.1234.ABCDEF01.tmp');
    expect(names(paths.root)).toContain('x.json.1234.0123abcd.tmp');
    expect(names(paths.root)).toContain('registry.json');
    expect(names(paths.root)).not.toContain('.x.json.1234.0123abcd.tmp');
    expect(names(path.join(root, 'other'))).toEqual(['.x.json.1234.0123abcd.tmp']);
  });

  it('R8: the pattern matches the names that writeJsonAtomic makes', async () => {
    const spy = vi.spyOn(fs.promises, 'writeFile');
    try {
      await writeJsonAtomic(path.join(paths.pendingDir, `${ENV_A}.json`), { a: 1 });
      const written = spy.mock.calls.map((call) => path.basename(String(call[0])));
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(ATOMIC_TEMPORARY_FILE);
    } finally {
      spy.mockRestore();
    }
  });

  it('never removes a link or what it points to, nor a folder, and does not enter a folder that is a link', async () => {
    const old = T0 - 48 * 60 * MINUTE;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-sweep-outside-'));
    try {
      const target = path.join(outside, 'target.json');
      write(target, pending(ENV_A, 0), old);
      fs.symlinkSync(target, paths.pendingFile(ENV_A));
      fs.symlinkSync(target, path.join(paths.root, '.x.json.1.0123abcd.tmp'));
      fs.mkdirSync(path.join(paths.sessionsDir, '.x.json.1.0123abcd.tmp'));
      write(path.join(outside, '.x.json.1.0123abcd.tmp'), '{}', old);
      fs.rmSync(paths.disconnectDir, { recursive: true });
      fs.symlinkSync(outside, paths.disconnectDir);
      const removed = await sweepStorage(paths, T0);
      expect(removed).toEqual({ pending: [], disconnect: [], temporary: [] });
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(path.join(outside, '.x.json.1.0123abcd.tmp'))).toBe(true);
      expect(fs.lstatSync(paths.pendingFile(ENV_A)).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores missing folders', async () => {
    const empty = new StoragePaths(path.join(root, 'missing'));
    expect(await sweepStorage(empty, T0)).toEqual({ pending: [], disconnect: [], temporary: [] });
  });
});
