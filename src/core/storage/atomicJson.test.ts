// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listJsonFiles,
  readJson,
  removeFile,
  writeJsonAtomic,
  writeJsonAtomicSync,
} from './atomicJson';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('atomic JSON files', () => {
  it('writes into missing folders and leaves no temporary file', async () => {
    const file = path.join(root, 'a', 'b', 'x.json');
    await writeJsonAtomic(file, { a: 1 });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['x.json']);
    await expect(readJson(file)).resolves.toEqual({ a: 1 });
    const syncFile = path.join(root, 'c', 'y.json');
    writeJsonAtomicSync(syncFile, [1]);
    expect(fs.readdirSync(path.dirname(syncFile))).toEqual(['y.json']);
    // Plan step 11I (PR D): read with readJson (before: readJsonSync, which nothing else used and is removed).
    await expect(readJson(syncFile)).resolves.toEqual([1]);
  });

  it('reads a missing or invalid file as undefined', async () => {
    const file = path.join(root, 'x.json');
    // Plan step 11I (PR D): changed, without readJsonSync (nothing used it; removed).
    await expect(readJson(file)).resolves.toBeUndefined();
    fs.writeFileSync(file, '{');
    await expect(readJson(file)).resolves.toBeUndefined();
  });

  it('removes files, and a missing file is not an error', async () => {
    const file = path.join(root, 'x.json');
    fs.writeFileSync(file, '{}');
    await removeFile(file);
    await removeFile(file);
    // Plan step 11I (PR D): changed, without removeFileSync (nothing used it; removed).
    expect(fs.existsSync(file)).toBe(false);
  });

  it('lists only visible .json files', async () => {
    for (const name of ['a.json', '.a.json.1.ff.tmp', 'b.txt', 'c.json', 'x.claimed.1.w']) {
      fs.writeFileSync(path.join(root, name), '');
    }
    const listed = (await listJsonFiles(root)).map((file) => path.basename(file)).sort();
    expect(listed).toEqual(['a.json', 'c.json']);
    await expect(listJsonFiles(path.join(root, 'missing'))).resolves.toEqual([]);
  });

  // Plan step 5, PR D (rule D1 of 2026-09-30): a folder that cannot be read is never "nothing there".
  it('lists a missing folder or a file as empty, and throws for a folder that cannot be read', async () => {
    const file = path.join(root, 'file');
    fs.writeFileSync(file, '');
    await expect(listJsonFiles(file)).resolves.toEqual([]);
    const readdir = fs.promises.readdir;
    const denied = path.join(root, 'denied');
    fs.mkdirSync(denied);
    fs.writeFileSync(path.join(denied, 'a.json'), '{}');
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (dir: fs.PathLike, ...rest: unknown[]) => {
      if (String(dir) === denied) throw Object.assign(new Error(`EACCES: permission denied, scandir '${denied}'`), { code: 'EACCES' });
      return (readdir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
    }) as typeof fs.promises.readdir);
    try {
      await expect(listJsonFiles(denied)).rejects.toMatchObject({ code: 'EACCES' });
      await expect(listJsonFiles(root)).resolves.toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
