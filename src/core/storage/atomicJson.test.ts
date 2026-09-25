import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listJsonFiles,
  readJson,
  readJsonSync,
  removeFile,
  removeFileSync,
  withDirectoryLock,
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
    expect(readJsonSync(syncFile)).toEqual([1]);
  });

  it('reads a missing or invalid file as undefined', async () => {
    const file = path.join(root, 'x.json');
    await expect(readJson(file)).resolves.toBeUndefined();
    expect(readJsonSync(file)).toBeUndefined();
    fs.writeFileSync(file, '{');
    await expect(readJson(file)).resolves.toBeUndefined();
    expect(readJsonSync(file)).toBeUndefined();
  });

  it('removes files, and a missing file is not an error', async () => {
    const file = path.join(root, 'x.json');
    fs.writeFileSync(file, '{}');
    await removeFile(file);
    await removeFile(file);
    fs.writeFileSync(file, '{}');
    removeFileSync(file);
    removeFileSync(file);
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
});

describe('withDirectoryLock', () => {
  it('runs one holder at a time and removes the lock', async () => {
    const lock = path.join(root, 'x.lock');
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withDirectoryLock(lock, async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
        }, { retryMs: 5 }),
      ),
    );
    expect(maxActive).toBe(1);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('removes the lock also when the function throws', async () => {
    const lock = path.join(root, 'x.lock');
    await expect(withDirectoryLock(lock, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('takes over a stale lock', async () => {
    const lock = path.join(root, 'x.lock');
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(lock, old, old);
    await expect(withDirectoryLock(lock, async () => 'done')).resolves.toBe('done');
  });

  it('times out on a fresh lock', async () => {
    const lock = path.join(root, 'x.lock');
    fs.mkdirSync(lock);
    await expect(withDirectoryLock(lock, async () => 'never', { timeoutMs: 100, retryMs: 10 })).rejects.toThrow(/Timeout/);
    expect(fs.existsSync(lock)).toBe(true);
  });
});
