// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H3 (decision of 2026-10-09, "11H: the shared VS Code server and the Session Monitor's daily run"; live check
// 3 of the user): the files of the shared extension cache in the store (the layout is in vscodeExtensions.ts): the record
// of an open's extension list (the worker), the listing of the cached `.vsix` files (the worker's seed, the monitor's
// cleanup), the read of the records (the monitor), and the download of one `.vsix` under the lock of its file (the
// monitor), streamed into a temporary file and renamed into place, as 11H1 fetches a server. Review round 1 of 11H3
// (A-L5, B-D4): the records, the failures and the chosen files are in the volume of the Session Monitor (`stateDir`:
// LOCK_STATE_DIR in the worker, REMOTE_MONITOR_STATE_DIR in the monitor), which no dev container mounts. No `vscode`.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { isStorageId } from '../storage/paths';
import type { HttpStreamTransport } from '../http';
import type { Logger } from '../ports';
import {
  EXTENSION_FOLDERS,
  MAX_EXTENSION_RECORD_BYTES,
  MAX_EXTENSION_CHOICES_BYTES,
  RECORDED_LIST_MS,
  combinedExtensions,
  formatExtensionChoices,
  formatExtensionRecord,
  isMarketplaceDownloadUrl,
  parseExtensionChoices,
  parseExtensionRecord,
  type ChosenExtension,
  type ExtensionFolder,
  type ExtensionRecord,
  type ExtensionRef,
} from '../vscodeExtensions';
import { STORE_LOCK_FOLDER, downloadToFile } from './vscodeServerStore';

/** Plan step 11H3: the folder of the extension cache in the store. */
export const STORE_EXTENSION_FOLDER = 'extensions';
/** Review round 1 of 11H3 (A-L5, B-D4): the folder of the extension lists in the volume of the Session Monitor. */
export const STATE_EXTENSION_FOLDER = 'extensions';
/** Plan step 11H3: the folder of the recorded lists (`<state>/extensions/wanted`). */
export const EXTENSION_WANTED_FOLDER = 'wanted';
/** Plan step 11H3: the folder of the downloads (`<store>/extensions/tmp`). */
export const EXTENSION_TEMP_FOLDER = 'tmp';
/** Plan step 11H3: the file of the monitor's failed entries (`<state>/extensions/failures.json`). */
export const EXTENSION_FAILURES_FILE = 'failures.json';
/** Review round 1 of 11H3 (A-L3, B-D1): the file of the files that the monitor's runs chose (`<state>/extensions/chosen.json`). */
export const EXTENSION_CHOICES_FILE = 'chosen.json';
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
 * folder (never a link); 0755 folders get that mode back (the dev containers read the cache as their remote user), and
 * (review round 1 of 11H3) 0700 folders theirs.
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
    if ((stat.mode & 0o777) !== modes[index]) await fs.promises.chmod(folder, modes[index]);
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
 * Plan step 11H3 (the brief, item 1): records the extension list of an open of the environment `environmentId`
 * (`extensions/wanted/<environment-id>.json`, written atomically, at most MAX_EXTENSION_RECORD_BYTES): the
 * configuration's extensions and the user's defaults, with the time of the open. `configuration` undefined (the open
 * could not read its configuration): the recorded configuration's list stays. Resolves with the list of the open
 * (combinedExtensions); rejects with the cause (the caller logs it). Review round 1 of 11H3 (A-L5, B-D4): under
 * `stateDir`, the volume of the Session Monitor (folders 0700), not in the store that the dev containers mount.
 */
export async function recordExtensions(
  stateDir: string,
  environmentId: string,
  configuration: readonly ExtensionRef[] | undefined,
  defaults: readonly ExtensionRef[],
  at: number,
): Promise<ExtensionRef[]> {
  if (!isStorageId(environmentId)) throw new Error(`the environment ID ${JSON.stringify(environmentId)} is invalid`);
  const folder = await plainFolder(stateDir, [STATE_EXTENSION_FOLDER, EXTENSION_WANTED_FOLDER], [0o700, 0o700]);
  const name = `${environmentId}.json`;
  const previous = configuration === undefined ? parseExtensionRecord((await readPlainFile(path.posix.join(folder, name), MAX_EXTENSION_RECORD_BYTES)) ?? '') : undefined;
  const record: ExtensionRecord = { at, configuration: [...(configuration ?? previous?.configuration ?? [])], defaults: [...defaults] };
  await writeAtomically(folder, name, formatExtensionRecord(record));
  return combinedExtensions(record.configuration, record.defaults);
}

/**
 * Plan step 11H3: the recorded lists under `stateDir` (a file that is not a valid record of an environment is left out).
 * Review round 1 of 11H3 (A-L4): a missing folder has none; any other failure of its listing rejects (the cleanup then
 * removes nothing as unwanted).
 */
export async function readExtensionRecords(stateDir: string): Promise<ExtensionRecord[]> {
  return (await readExtensionRecordFiles(stateDir)).records;
}

/** Review round 2 of 11H3 (A-L5): the recorded lists, and the names of the record files that are present but not valid. */
export interface ExtensionRecordFiles {
  records: ExtensionRecord[];
  /** The record files (`<environment-id>.json`) that are present but could not be read or are no valid record. */
  unreadable: string[];
}

/**
 * Review round 2 of 11H3 (A-L5): readExtensionRecords, and the names of the record files that are present (not missing
 * when they are read: one removed meanwhile is not counted) but could not be read (a link, too large, a failed read) or
 * parsed; the cleanup then keeps the files of the IDs that no list names. The listing fails as readExtensionRecords.
 */
export async function readExtensionRecordFiles(stateDir: string): Promise<ExtensionRecordFiles> {
  const folder = path.posix.join(stateDir, STATE_EXTENSION_FOLDER, EXTENSION_WANTED_FOLDER);
  const records: ExtensionRecord[] = [];
  const unreadable: string[] = [];
  const entries = await fs.promises.readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json') || !isStorageId(entry.slice(0, -'.json'.length))) continue;
    const file = path.posix.join(folder, entry);
    const text = await readPlainFile(file, MAX_EXTENSION_RECORD_BYTES).catch(() => undefined);
    const record = parseExtensionRecord(text ?? '');
    if (record !== undefined) records.push(record);
    else if (await fs.promises.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT')) unreadable.push(entry);
  }
  return { records, unreadable };
}

/**
 * Review round 2 of 11H3 (A-L3, B R2-D3): a temporary file of writeAtomically (`.<name>.<12 hexadecimal digits>.tmp`)
 * that a killed write left behind.
 */
export const EXTENSION_STATE_TEMPORARY_FILE = /^\..+\.[0-9a-f]{12}\.tmp$/;
/** Review round 2 of 11H3 (A-L3, B R2-D3): such a file whose modification time is more than this from now is removed. */
export const EXTENSION_STATE_TEMPORARY_MAX_AGE_MS = 60 * 60_000;

/**
 * Review round 2 of 11H3 (A-L3, B R2-D3; as removeStaleStateTemporaryFiles of the monitor's own state files): removes,
 * in `<state>/extensions` and its `wanted` folder, the temporary files of writeAtomically whose modification time is
 * more than EXTENSION_STATE_TEMPORARY_MAX_AGE_MS from `now` in either direction (a younger one may belong to a write that
 * runs now), and the records (`wanted/<environment-id>.json`) that were written more than RECORDED_LIST_MS ago and name
 * no time within RECORDED_LIST_MS of `now` (their `at` is older, or the file is no valid record): such a record no longer
 * counts (wantedExtensions), and the next open of its environment writes a new one. Only regular files, never a link;
 * the file is checked again (the same file, unchanged) right before it is removed, as a worker may rename a new record
 * into place meanwhile. Every error is ignored. Returns the names it removed (relative to `<state>/extensions`).
 */
export async function removeStaleExtensionStateFiles(stateDir: string, now: number): Promise<string[]> {
  const removed: string[] = [];
  const base = path.posix.join(stateDir, STATE_EXTENSION_FOLDER);
  for (const sub of ['', EXTENSION_WANTED_FOLDER]) {
    const folder = sub === '' ? base : path.posix.join(base, sub);
    for (const entry of (await fs.promises.readdir(folder).catch(() => [] as string[])).sort()) {
      const file = path.posix.join(folder, entry);
      try {
        const stat = await fs.promises.lstat(file);
        if (!stat.isFile()) continue;
        if (EXTENSION_STATE_TEMPORARY_FILE.test(entry)) {
          if (Math.abs(now - stat.mtimeMs) <= EXTENSION_STATE_TEMPORARY_MAX_AGE_MS) continue;
        } else {
          if (sub !== EXTENSION_WANTED_FOLDER || !entry.endsWith('.json') || !isStorageId(entry.slice(0, -'.json'.length))) continue;
          if (now - stat.mtimeMs < RECORDED_LIST_MS) continue;
          const record = parseExtensionRecord((await readPlainFile(file, MAX_EXTENSION_RECORD_BYTES).catch(() => undefined)) ?? '');
          if (record !== undefined && now - record.at < RECORDED_LIST_MS) continue;
          const again = await fs.promises.lstat(file);
          if (!again.isFile() || again.ino !== stat.ino || again.mtimeMs !== stat.mtimeMs) continue;
        }
        await fs.promises.unlink(file);
        removed.push(sub === '' ? entry : `${sub}/${entry}`);
      } catch {
        // Removed meanwhile, or not removable: left alone.
      }
    }
  }
  return removed;
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

/** Plan step 11H3: the failed entries of the monitor (`<state>/extensions/failures.json`); the text, or '' when it is missing. */
export async function readExtensionFailures(stateDir: string): Promise<string> {
  return (await readPlainFile(path.posix.join(stateDir, STATE_EXTENSION_FOLDER, EXTENSION_FAILURES_FILE), MAX_EXTENSION_RECORD_BYTES)) ?? '';
}

/** Plan step 11H3: writes the failed entries of the monitor atomically (`{ "<entry>": <time> }`). */
export async function writeExtensionFailures(stateDir: string, failures: ReadonlyMap<string, number>): Promise<void> {
  const folder = await plainFolder(stateDir, [STATE_EXTENSION_FOLDER], [0o700]);
  await writeAtomically(folder, EXTENSION_FAILURES_FILE, `${JSON.stringify(Object.fromEntries([...failures].sort(([a], [b]) => a.localeCompare(b))))}\n`);
}

/** Review round 1 of 11H3 (A-L3, B-D1): the files that the monitor's runs chose (parseExtensionChoices; none when missing). */
export async function readExtensionChoices(stateDir: string): Promise<Map<string, string>> {
  return parseExtensionChoices((await readPlainFile(path.posix.join(stateDir, STATE_EXTENSION_FOLDER, EXTENSION_CHOICES_FILE), MAX_EXTENSION_CHOICES_BYTES)) ?? '');
}

/** Review round 1 of 11H3 (A-L3, B-D1): writes the files that the monitor's runs chose atomically. */
export async function writeExtensionChoices(stateDir: string, choices: ReadonlyMap<string, string>): Promise<void> {
  const folder = await plainFolder(stateDir, [STATE_EXTENSION_FOLDER], [0o700]);
  await writeAtomically(folder, EXTENSION_CHOICES_FILE, formatExtensionChoices(choices));
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
  /**
   * Review round 2 of 11H3 (A-L1): told the length of every chunk of the download as it arrives (downloadToFile), also of
   * a download that fails afterwards (the monitor's bound of a run counts the transferred bytes).
   */
  onBytes?: (bytes: number) => void;
}

/** The first bytes of a `.vsix` (a ZIP archive). */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** The first bytes of a gzip stream. */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** The first `length` bytes of the plain file `file` (never through a link). */
async function headOf(file: string, length: number): Promise<Buffer> {
  const head = Buffer.alloc(length);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const { bytesRead } = await handle.read(head, 0, length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/** The temporary file of one download of `cacheName` (`<cache name>-<12 hexadecimal digits>`, as the cleanup knows it). */
function temporaryName(temp: string, cacheName: string): string {
  return path.posix.join(temp, `${cacheName}-${randomBytes(6).toString('hex')}`);
}

/**
 * Review round 1 of 11H3 (A-M1): decodes the gzip file `source` into the new file `target` (0600), streamed, at most
 * `maxBytes` after decoding (a small file that decodes to much more stops there).
 */
async function gunzipFile(source: string, target: string, maxBytes: number, signal: AbortSignal): Promise<void> {
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > maxBytes) {
        done(new Error(`the download is larger than ${maxBytes} bytes after its gzip decoding`));
        return;
      }
      done(null, chunk);
    },
  });
  const input = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  await pipeline(input.createReadStream(), createGunzip(), counter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
}

/**
 * Plan step 11H3 (the brief, item 3): makes sure that the store has the `.vsix` of `chosen`
 * (`extensions/<folder>/<cache name>`). Present (a plain file): `present`, no lock, no network. Otherwise, under the
 * lock of that file (extensionLockFile; a bounded wait), it checks again, removes the leftovers of an earlier download of
 * the same file (`extensions/tmp/<cache name>-<12 hexadecimal digits>`, exactly: review round 1 of 11H3, A-L2/B-D2),
 * downloads the VSIX URL (`https:` on a host of the Marketplace, every redirect too: isMarketplaceDownloadUrl, review
 * round 1 of 11H3, A-L6; at most `maxBytes`, streamed; downloadToFile of 11H1) into a temporary file of its own, decodes
 * it when it is gzip (review round 1 of 11H3, A-M1: the Marketplace's CDN may answer with `Content-Encoding: gzip`, which
 * the HTTPS transport does not decode; a gzip stream starts with 1f 8b, a ZIP archive never does; at most `maxBytes` after
 * the decoding), checks that it is a ZIP archive (the Marketplace gives no hash), makes it readable for all, and renames it
 * into place: `downloaded`. The temporary files go on every outcome. Rejects with the reason (the caller logs it); the
 * time limit of the whole fetch is `timeoutMs`.
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
      // cleanup. The files of other downloads are never touched (review round 1 of 11H3, A-L2/B-D2: the name exactly, as
      // the universal `a.b-1.0.0` is a prefix of the temporary files of `a.b-1.0.0-linux-x64`, under another lock).
      const leftover = new RegExp(`^${escapeRegExp(chosen.cacheName)}-[0-9a-f]{12}$`);
      for (const entry of await fs.promises.readdir(temp)) {
        if (leftover.test(entry)) await fs.promises.rm(path.posix.join(temp, entry), { force: true, recursive: true });
      }
      const maxBytes = deps.maxBytes ?? MAX_VSIX_BYTES;
      const own = temporaryName(temp, chosen.cacheName);
      let decoded: string | undefined;
      try {
        await downloadToFile(deps.transport, chosen.vsix, own, maxBytes, both, isMarketplaceDownloadUrl, deps.onBytes);
        let file = own;
        if ((await headOf(own, GZIP_MAGIC.length)).equals(GZIP_MAGIC)) {
          decoded = temporaryName(temp, chosen.cacheName);
          await gunzipFile(own, decoded, maxBytes, both);
          file = decoded;
        }
        if (!(await headOf(file, ZIP_MAGIC.length)).equals(ZIP_MAGIC)) throw new Error('the download is no VSIX (ZIP) file');
        await fs.promises.chmod(file, 0o644);
        const folder = await plainFolder(deps.root, [STORE_EXTENSION_FOLDER, chosen.folder], [0o755, 0o755]);
        await fs.promises.rename(file, path.posix.join(folder, chosen.cacheName));
      } finally {
        for (const name of decoded !== undefined ? [own, decoded] : [own]) {
          await fs.promises.rm(name, { force: true }).catch((error: unknown) => {
            deps.logger?.warn(`A temporary file of the shared extension cache could not be removed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
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
