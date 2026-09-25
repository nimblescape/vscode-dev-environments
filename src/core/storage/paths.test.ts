// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StoragePaths,
  errorCode,
  isStorageId,
  isTransientFsError,
  listNames,
  parseClaimedOperationName,
  parseJson,
  readJsonTolerant,
  readJsonTolerantSync,
  readTextFile,
  readTextFileSync,
  retryTransient,
  retryTransientSync,
} from './paths';

const ENV_ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const WINDOW_ID = 'b7c1d2e3-0000-4000-8000-000000000001';

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('StoragePaths', () => {
  it('lays out the files of implementation notes 4', () => {
    const paths = new StoragePaths(root);
    expect(paths.root).toBe(root);
    expect(paths.registry).toBe(path.join(root, 'registry.json'));
    expect(paths.registryLock).toBe(path.join(root, 'registry.lock'));
    expect(paths.legacyRepositories).toBe(path.join(root, 'repositories.json'));
    // One list per GitHub account (concept 6.2): the repository names of one account are never shown to another.
    expect(paths.repositoriesFile('1001')).toBe(path.join(root, 'repositories-1001.json'));
    expect(() => paths.repositoriesFile('../1001')).toThrow(/Invalid account ID/);
    expect(() => paths.repositoriesFile('')).toThrow(/Invalid account ID/);
    expect(paths.sessionsDir).toBe(path.join(root, 'sessions'));
    expect(paths.pendingDir).toBe(path.join(root, 'pending'));
    expect(paths.operationsDir).toBe(path.join(root, 'operations'));
    expect(paths.reopen).toBe(path.join(root, 'reopen.json'));
    expect(paths.monitorSettings).toBe(path.join(root, 'monitor.json'));
    expect(paths.monitorLock).toBe(path.join(root, 'monitor.lock'));
    expect(paths.monitorLog).toBe(path.join(root, 'monitor.log'));
    expect(paths.helperState).toBe(path.join(root, 'helper.json'));
    expect(paths.sessionFile(WINDOW_ID)).toBe(path.join(root, 'sessions', `${WINDOW_ID}.json`));
    expect(paths.pendingFile(ENV_ID)).toBe(path.join(root, 'pending', `${ENV_ID}.json`));
    expect(paths.operationFile(ENV_ID)).toBe(path.join(root, 'operations', `${ENV_ID}.json`));
  });

  it('names claimed operation files so that they do not end in .json and can be parsed back', () => {
    const paths = new StoragePaths(root);
    const file = paths.claimedOperationFile(ENV_ID, WINDOW_ID, 1_727_190_000_123.7);
    expect(path.dirname(file)).toBe(paths.operationsDir);
    const name = path.basename(file);
    expect(name).toBe(`${ENV_ID}.claimed.1727190000123.${WINDOW_ID}`);
    expect(name.endsWith('.json')).toBe(false);
    expect(parseClaimedOperationName(name)).toEqual({
      environmentId: ENV_ID,
      claimedAtMs: 1_727_190_000_123,
      windowId: WINDOW_ID,
    });
    expect(parseClaimedOperationName(`${ENV_ID}.json`)).toBeUndefined();
    expect(parseClaimedOperationName(`${ENV_ID}.claimed.x.${WINDOW_ID}`)).toBeUndefined();
  });

  it.each(['', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a.json', 'a b', 'x'.repeat(129), 'ä'])(
    'rejects the unsafe ID %j',
    (id) => {
      const paths = new StoragePaths(root);
      expect(isStorageId(id)).toBe(false);
      expect(() => paths.sessionFile(id)).toThrow(/Invalid window ID/);
      expect(() => paths.pendingFile(id)).toThrow(/Invalid environment ID/);
      expect(() => paths.operationFile(id)).toThrow(/Invalid environment ID/);
      expect(() => paths.claimedOperationFile(ENV_ID, id, 0)).toThrow(/Invalid window ID/);
    },
  );

  it('accepts UUIDs and VS Code session IDs', () => {
    expect(isStorageId(ENV_ID)).toBe(true);
    expect(isStorageId('0d3b8c9a-1f2e-4d5c-8b7a-6e5f4d3c2b1a1727190000000')).toBe(true);
    expect(isStorageId(42)).toBe(false);
    expect(isStorageId(undefined)).toBe(false);
  });

  it('creates the folders, async and sync, and is idempotent', async () => {
    const paths = new StoragePaths(path.join(root, 'a', 'b'));
    await paths.ensureDirectories();
    await paths.ensureDirectories();
    for (const dir of [paths.root, paths.sessionsDir, paths.pendingDir, paths.operationsDir]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
    const syncPaths = new StoragePaths(path.join(root, 'sync'));
    syncPaths.ensureDirectoriesSync();
    syncPaths.ensureDirectoriesSync();
    for (const dir of [syncPaths.root, syncPaths.sessionsDir, syncPaths.pendingDir, syncPaths.operationsDir]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
  });
});

describe('retryTransient', () => {
  it('retries transient errors and returns the result', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(fsError('EPERM'))
      .mockRejectedValueOnce(fsError('EBUSY'))
      .mockRejectedValueOnce(fsError('EACCES'))
      .mockResolvedValue('ok');
    await expect(retryTransient(fn, { delayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('gives up after the attempts', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(fsError('EPERM'));
    await expect(retryTransient(fn, { attempts: 3, delayMs: 1 })).rejects.toMatchObject({ code: 'EPERM' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry other errors', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(fsError('ENOENT'));
    await expect(retryTransient(fn, { delayMs: 1 })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fn).toHaveBeenCalledTimes(1);
    const plain = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('boom'));
    await expect(retryTransient(plain)).rejects.toThrow('boom');
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('has a synchronous variant', () => {
    let calls = 0;
    const result = retryTransientSync(
      () => {
        calls++;
        if (calls < 3) throw fsError('EBUSY');
        return calls;
      },
      { delayMs: 1 },
    );
    expect(result).toBe(3);
    expect(() =>
      retryTransientSync(
        () => {
          throw fsError('EPERM');
        },
        { attempts: 2, delayMs: 1 },
      ),
    ).toThrow('EPERM');
    let enoent = 0;
    expect(() =>
      retryTransientSync(() => {
        enoent++;
        throw fsError('ENOENT');
      }),
    ).toThrow('ENOENT');
    expect(enoent).toBe(1);
  });

  it('classifies errors', () => {
    expect(errorCode(fsError('ENOENT'))).toBe('ENOENT');
    expect(errorCode(new Error('x'))).toBeUndefined();
    expect(errorCode('EPERM')).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(isTransientFsError(fsError('EPERM'))).toBe(true);
    expect(isTransientFsError(fsError('ENOENT'))).toBe(false);
  });
});

describe('reading files', () => {
  it('distinguishes a missing file from an unreadable one', async () => {
    const file = path.join(root, 'a.json');
    await expect(readTextFile(file)).resolves.toBeUndefined();
    expect(readTextFileSync(file)).toBeUndefined();
    fs.writeFileSync(file, '{"a":1}');
    await expect(readTextFile(file)).resolves.toBe('{"a":1}');
    expect(readTextFileSync(file)).toBe('{"a":1}');
    // A folder cannot be read as a file: this is an error, not a missing file.
    await expect(readTextFile(root)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(() => readTextFileSync(root)).toThrow();
  });

  it('parses JSON tolerantly', async () => {
    expect(parseJson('﻿{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('{"a":')).toBeUndefined();
    expect(parseJson('')).toBeUndefined();
    const file = path.join(root, 'b.json');
    fs.writeFileSync(file, 'not json');
    await expect(readJsonTolerant(file)).resolves.toBeUndefined();
    expect(readJsonTolerantSync(file)).toBeUndefined();
    await expect(readJsonTolerant(path.join(root, 'missing.json'))).resolves.toBeUndefined();
    await expect(readJsonTolerant(root)).resolves.toBeUndefined();
    expect(readJsonTolerantSync(root)).toBeUndefined();
    fs.writeFileSync(file, '[1,2]');
    await expect(readJsonTolerant(file)).resolves.toEqual([1, 2]);
    expect(readJsonTolerantSync(file)).toEqual([1, 2]);
  });

  it('lists names sorted, and a missing folder as empty', async () => {
    fs.writeFileSync(path.join(root, 'b'), '');
    fs.writeFileSync(path.join(root, 'a'), '');
    await expect(listNames(root)).resolves.toEqual(['a', 'b']);
    await expect(listNames(path.join(root, 'missing'))).resolves.toEqual([]);
    await expect(listNames(path.join(root, 'a'))).resolves.toEqual([]);
  });
});
