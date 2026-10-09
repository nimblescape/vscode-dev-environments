// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09, "11H: the shared VS Code server and the Session Monitor's daily run"; live check
// 3 of the user): the files of the shared extension cache in the store (the layout is in vscodeExtensions.ts): the record
// of an open's extension list (the worker), the listing of the cached `.vsix` files (the worker's seed, the monitor's
// cleanup), the read of the records (the monitor), and the download of one `.vsix` under the lock of its file (the
// monitor), streamed into a temporary file and renamed into place, as 11H1 fetches a server. No `vscode`.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isStorageId } from '../storage/paths';
import type { HttpStreamTransport } from '../http';
import type { Logger } from '../ports';
import {
  EXTENSION_FOLDERS,
  MAX_EXTENSION_RECORD_BYTES,
  combinedExtensions,
  formatExtensionRecord,
  parseExtensionRecord,
  type ChosenExtension,
  type ExtensionFolder,
  type ExtensionRecord,
  type ExtensionRef,
} from '../vscodeExtensions';
import { STORE_LOCK_FOLDER, downloadToFile } from './vscodeServerStore';

/** Plan step 11H3: the folder of the extension cache in the store. */
export const STORE_EXTENSION_FOLDER = 'extensions';
/** Plan step 11H3: the folder of the recorded lists (`extensions/wanted`). */
export const EXTENSION_WANTED_FOLDER = 'wanted';
/** Plan step 11H3: the folder of the downloads (`extensions/tmp`). */
export const EXTENSION_TEMP_FOLDER = 'tmp';
/** Plan step 11H3: the file of the monitor's failed entries (`extensions/failures.json`). */
export const EXTENSION_FAILURES_FILE = 'failures.json';
/** Plan step 11H3 (the brief: "size cap e.g. 200 MiB"): the largest `.vsix` that the monitor downloads. */
export const MAX_VSIX_BYTES = 200 * 1024 * 1024;
/** Plan step 11H3: the longest download of one `.vsix`, the wait for its lock included. */
export const VSIX_FETCH_TIMEOUT_MS = 10 * 60_000;

/** Plan step 11H3: the lock name of one file of the cache (its lock file is extensionLockFile). */
export function extensionLockFile(root: string, cacheName: string): string {
  return path.posix.join(root, STORE_LOCK_FOLDER, `extension-${cacheName}.lock`);
}

/** Plan step 11H3: the file of the store of a version (`extensions/<folder>/<cache name>`). */
export function extensionFile(root: string, folder: ExtensionFolder, cacheName: string): string {
  return path.posix.join(root, STORE_EXTENSION_FOLDER, folder, cacheName);
}

/**
 * Makes `folder` (and the folders above it up to `root`) with `mode` when it is missing, and checks that each is a plain
 * folder (never a link); 0755 folders get that mode back (the dev containers read the cache as their remote user).
 */
async function plainFolder(root: string, parts: readonly string[], modes: readonly number[]): Promise<string> {
  let folder = root;
  for (const [index, part] of parts.entries()) {
    folder = path.posix.join(folder, part);
    await fs.promises.mkdir(folder, { mode: modes[index] }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await fs.promises.lstat(folder);
    if (!stat.isDirectory()) throw new Error(`${folder} is not a folder`);
    if (modes[index] === 0o755 && (stat.mode & 0o777) !== 0o755) await fs.promises.chmod(folder, 0o755);
  }
  return folder;
}

/** Writes `text` to `folder/name` atomically: a new temporary file of the same folder (0600), then a rename. */
async function writeAtomically(folder: string, name: string, text: string, mode = 0o600): Promise<void> {
  const temp = path.posix.join(folder, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(temp, text, { flag: 'wx', mode });
    await fs.promises.rename(temp, path.posix.join(folder, name));
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Reads a plain file (never through a link) of at most `maxBytes`; undefined when it is missing or anything else. */
async function readPlainFile(file: string, maxBytes: number): Promise<string | undefined> {
  const stat = await fs.promises.lstat(file).catch(() => undefined);
  if (stat === undefined || !stat.isFile() || stat.size > maxBytes) return undefined;
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    return bytesRead > maxBytes ? undefined : buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Plan step 11H3 (the brief, item 1): records the extension list of an open of the environment `environmentId` in the
 * store (`extensions/wanted/<environment-id>.json`, written atomically, at most MAX_EXTENSION_RECORD_BYTES): the
 * configuration's extensions and the user's defaults, with the time of the open. `configuration` undefined (the open
 * could not read its configuration): the recorded configuration's list stays. Resolves with the list of the open
 * (combinedExtensions); rejects with the cause (the caller logs it).
 */
export async function recordExtensions(
  root: string,
  environmentId: string,
  configuration: readonly ExtensionRef[] | undefined,
  defaults: readonly ExtensionRef[],
  at: number,
): Promise<ExtensionRef[]> {
  if (!isStorageId(environmentId)) throw new Error(`the environment ID ${JSON.stringify(environmentId)} is invalid`);
  const folder = await plainFolder(root, [STORE_EXTENSION_FOLDER, EXTENSION_WANTED_FOLDER], [0o755, 0o700]);
  const name = `${environmentId}.json`;
  const previous = configuration === undefined ? parseExtensionRecord((await readPlainFile(path.posix.join(folder, name), MAX_EXTENSION_RECORD_BYTES)) ?? '') : undefined;
  const record: ExtensionRecord = { at, configuration: [...(configuration ?? previous?.configuration ?? [])], defaults: [...defaults] };
  await writeAtomically(folder, name, formatExtensionRecord(record));
  return combinedExtensions(record.configuration, record.defaults);
}

/** Plan step 11H3: the recorded lists of the store (a file that is not a valid record of an environment is left out). */
export async function readExtensionRecords(root: string): Promise<ExtensionRecord[]> {
  const folder = path.posix.join(root, STORE_EXTENSION_FOLDER, EXTENSION_WANTED_FOLDER);
  const records: ExtensionRecord[] = [];
  for (const entry of await fs.promises.readdir(folder).catch(() => [] as string[])) {
    if (!entry.endsWith('.json') || !isStorageId(entry.slice(0, -'.json'.length))) continue;
    const record = parseExtensionRecord((await readPlainFile(path.posix.join(folder, entry), MAX_EXTENSION_RECORD_BYTES)) ?? '');
    if (record !== undefined) records.push(record);
  }
  return records;
}

/** Plan step 11H3: the plain files of each folder of the cache (a missing folder has none; links are left out). */
export async function cachedExtensionFiles(root: string): Promise<Record<ExtensionFolder, string[]>> {
  const files = {} as Record<ExtensionFolder, string[]>;
  for (const folder of EXTENSION_FOLDERS) {
    const dir = path.posix.join(root, STORE_EXTENSION_FOLDER, folder);
    const names: string[] = [];
    const stat = await fs.promises.lstat(dir).catch(() => undefined);
    if (stat?.isDirectory() === true) {
      for (const entry of (await fs.promises.readdir(dir).catch(() => [] as string[])).sort()) {
        if ((await fs.promises.lstat(path.posix.join(dir, entry)).catch(() => undefined))?.isFile() === true) names.push(entry);
      }
    }
    files[folder] = names;
  }
  return files;
}

/** Plan step 11H3: the failed entries of the monitor (`extensions/failures.json`); the text, or '' when it is missing. */
export async function readExtensionFailures(root: string): Promise<string> {
  return (await readPlainFile(path.posix.join(root, STORE_EXTENSION_FOLDER, EXTENSION_FAILURES_FILE), MAX_EXTENSION_RECORD_BYTES)) ?? '';
}

/** Plan step 11H3: writes the failed entries of the monitor atomically (`{ "<entry>": <time> }`). */
export async function writeExtensionFailures(root: string, failures: ReadonlyMap<string, number>): Promise<void> {
  const folder = await plainFolder(root, [STORE_EXTENSION_FOLDER], [0o755]);
  await writeAtomically(folder, EXTENSION_FAILURES_FILE, `${JSON.stringify(Object.fromEntries([...failures].sort(([a], [b]) => a.localeCompare(b))))}\n`);
}

/** Plan step 11H3: what ensureExtension uses (the monitor's: its store, its HTTPS, the lock of a file). */
export interface ExtensionStoreDeps {
  root: string;
  /** The HTTPS of the proxy of the daemon (proxiedHttpsTransport, decision C1 of 2026-10-05). */
  transport: HttpStreamTransport;
  /** Takes the lock of the file `cacheName` (extensionLockFile), waiting at most `waitSeconds`; resolves with its release. */
  lock: (cacheName: string, waitSeconds: number, signal: AbortSignal) => Promise<() => void>;
  logger?: Pick<Logger, 'warn'>;
  /** Default MAX_VSIX_BYTES. */
  maxBytes?: number;
  /** Default VSIX_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** The first bytes of a `.vsix` (a ZIP archive). */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Plan step 11H3 (the brief, item 3): makes sure that the store has the `.vsix` of `chosen`
 * (`extensions/<folder>/<cache name>`). Present (a plain file): `present`, no lock, no network. Otherwise, under the
 * lock of that file (extensionLockFile; a bounded wait), it checks again, removes the leftovers of an earlier download of
 * the same file (`extensions/tmp/<cache name>-*`), downloads the VSIX URL (`https:` only, every redirect too, at most
 * `maxBytes`, streamed; downloadToFile of 11H1) into a temporary file of its own, checks that it is a ZIP archive (the
 * Marketplace gives no hash), makes it readable for all, and renames it into place: `downloaded`. The temporary file goes
 * on every outcome. Rejects with the reason (the caller logs it); the time limit of the whole fetch is `timeoutMs`.
 */
export async function ensureExtension(deps: ExtensionStoreDeps, chosen: ChosenExtension, signal: AbortSignal): Promise<'present' | 'downloaded'> {
  const target = extensionFile(deps.root, chosen.folder, chosen.cacheName);
  if ((await fs.promises.lstat(target).catch(() => undefined))?.isFile() === true) return 'present';
  const timeoutMs = deps.timeoutMs ?? VSIX_FETCH_TIMEOUT_MS;
  const limit = AbortSignal.timeout(timeoutMs);
  const both = AbortSignal.any([signal, limit]);
  try {
    const release = await deps.lock(chosen.cacheName, Math.max(1, Math.ceil(timeoutMs / 1000)), both);
    try {
      if ((await fs.promises.lstat(target).catch(() => undefined))?.isFile() === true) return 'present';
      const temp = await plainFolder(deps.root, [STORE_EXTENSION_FOLDER, EXTENSION_TEMP_FOLDER], [0o755, 0o700]);
      // Under the lock of this file no other download of it runs: a file of it here was left by one that ended without its
      // cleanup. The files of other downloads are never touched.
      for (const entry of await fs.promises.readdir(temp)) {
        if (entry.startsWith(`${chosen.cacheName}-`)) await fs.promises.rm(path.posix.join(temp, entry), { force: true, recursive: true });
      }
      const own = path.posix.join(temp, `${chosen.cacheName}-${randomBytes(6).toString('hex')}`);
      try {
        await downloadToFile(deps.transport, chosen.vsix, own, deps.maxBytes ?? MAX_VSIX_BYTES, both);
        const head = Buffer.alloc(ZIP_MAGIC.length);
        const handle = await fs.promises.open(own, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          await handle.read(head, 0, head.length, 0);
        } finally {
          await handle.close();
        }
        if (!head.equals(ZIP_MAGIC)) throw new Error('the download is no VSIX (ZIP) file');
        await fs.promises.chmod(own, 0o644);
        const folder = await plainFolder(deps.root, [STORE_EXTENSION_FOLDER, chosen.folder], [0o755, 0o755]);
        await fs.promises.rename(own, path.posix.join(folder, chosen.cacheName));
      } finally {
        await fs.promises.rm(own, { force: true }).catch((error: unknown) => {
          deps.logger?.warn(`A temporary file of the shared extension cache could not be removed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      return 'downloaded';
    } finally {
      release();
    }
  } catch (error) {
    if (signal.aborted) throw new Error('the run was ended');
    if (limit.aborted) throw new Error(`the download took longer than ${Math.round(timeoutMs / 1000)} s`);
    throw error;
  }
}
