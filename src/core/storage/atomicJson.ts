// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// JSON files in the global storage folder (implementation notes 4).
// Every write is atomic: a temporary file in the same folder, then a rename.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The temporary file of an atomic write of `file`: `.<name>.<pid>.<8 hex>.tmp` in the same folder. Every atomic writer
 * of the global storage folder names its temporary file with it (writeJsonAtomic, the
 * heartbeat of SessionCoordinator, computerId.ts; before plan step 8, PR C also the log of the local Session Monitor), so that the sweep of the storage folder (storageSweep.ts, R8,
 * ATOMIC_TEMPORARY_FILE) removes one that a killed write left behind (review round 9 of PR #63, A4/B6).
 */
export function atomicTemporaryPath(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
}

/** Reads a JSON file. Returns `undefined` if the file does not exist or does not contain valid JSON. */
export async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = atomicTemporaryPath(file);
  try {
    await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await fs.promises.rename(temp, file);
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Synchronous variant for `deactivate()` (implementation notes 4). */
export function writeJsonAtomicSync(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = atomicTemporaryPath(file);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Ignore.
    }
    throw error;
  }
}

/** Removes a file. A missing file is not an error. */
export async function removeFile(file: string): Promise<void> {
  await fs.promises.rm(file, { force: true });
}

/**
 * Full paths of the `*.json` files in a folder. Temporary files are not included. A missing folder (ENOENT, or ENOTDIR as
 * listNames of paths.ts) gives an empty list. Plan step 5, PR D (rule D1 of 2026-09-30): any other error (permissions, a
 * disk error, a link loop) is thrown: a folder that cannot be read is never "nothing there" (the other-window checks
 * then count it as not known).
 */
export async function listJsonFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  return names.filter((name) => name.endsWith('.json') && !name.startsWith('.')).map((name) => path.join(dir, name));
}

export interface LockOptions {
  /** A lock older than this counts as stale and is removed. Default: 10 seconds. */
  staleMs?: number;
  /** Maximum time to wait for the lock. Default: 15 seconds. */
  timeoutMs?: number;
  /** Time between two attempts. Default: 50 milliseconds. */
  retryMs?: number;
}

/**
 * Runs `fn` while holding a lock. The lock is a folder created with `mkdir`, and removed after `fn` ends
 * (implementation notes 4). A lock older than `staleMs` counts as stale.
 */
export async function withDirectoryLock<T>(lockDir: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retryMs = options.retryMs ?? 50;
  const start = Date.now();
  await fs.promises.mkdir(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      await fs.promises.mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.promises.stat(lockDir);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.promises.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock disappeared between mkdir and stat: try again at once.
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timeout while waiting for the lock ${lockDir}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.promises.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}
