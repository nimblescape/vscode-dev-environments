// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Layout of the global storage folder (implementation notes 4), and small file system helpers for the storage modules.
import * as fs from 'fs';
import * as path from 'path';

const STORAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * True if `id` can be part of a file name in the storage folders: 1 to 128 letters, digits, `_` or `-`.
 * Environment IDs (`crypto.randomUUID()`) and window IDs qualify. No dots and no separators, so an ID can never
 * leave its folder, hide a file (leading dot), or look like a `.json` or claimed file name.
 */
export function isStorageId(id: unknown): id is string {
  return typeof id === 'string' && STORAGE_ID_PATTERN.test(id);
}

function checkedId(kind: string, id: string): string {
  if (!isStorageId(id)) {
    throw new Error(`Invalid ${kind} for a storage file name: ${JSON.stringify(id)}`);
  }
  return id;
}

/** Marker in the name of a claimed operation file. The name does not end in `.json`, so `listJsonFiles` skips it. */
export const CLAIM_MARKER = '.claimed.';

const CLAIMED_NAME_PATTERN = /^([A-Za-z0-9_-]{1,128})\.claimed\.(\d{1,16})\.([A-Za-z0-9_-]{1,128})$/;

/** Parts of a claimed operation file name, or `undefined` if the name has another form. */
export function parseClaimedOperationName(
  name: string,
): { environmentId: string; claimedAtMs: number; windowId: string } | undefined {
  const match = CLAIMED_NAME_PATTERN.exec(name);
  if (!match) return undefined;
  return { environmentId: match[1], claimedAtMs: Number(match[2]), windowId: match[3] };
}

/** Paths of the files and folders in the global storage folder of the extension (implementation notes 4). */
export class StoragePaths {
  /** Environment Registry. */
  readonly registry: string;
  /** Lock folder for read-modify-write of the registry. */
  readonly registryLock: string;
  /** Stored result of the discovery of version 1, shared by all accounts. It is removed (repositoriesFile replaces it). */
  readonly legacyRepositories: string;
  /** Window status files, `<window-id>.json`. */
  readonly sessionsDir: string;
  /** Pending connection files, `<environment-id>.json`. */
  readonly pendingDir: string;
  /** Pending operations, `<environment-id>.json`, and claimed operations. */
  readonly operationsDir: string;
  /** Reopen record. */
  readonly reopen: string;
  /** Settings for the Session Monitor. */
  readonly monitorSettings: string;
  /** Process ID of the running Session Monitor. */
  readonly monitorLock: string;
  /** Log file of the Session Monitor. */
  readonly monitorLog: string;
  /** State of the workspace helper images: base image digests, last check, last use, last cleanup. */
  readonly helperState: string;

  constructor(readonly root: string) {
    this.registry = path.join(root, 'registry.json');
    this.registryLock = path.join(root, 'registry.lock');
    this.legacyRepositories = path.join(root, 'repositories.json');
    this.sessionsDir = path.join(root, 'sessions');
    this.pendingDir = path.join(root, 'pending');
    this.operationsDir = path.join(root, 'operations');
    this.reopen = path.join(root, 'reopen.json');
    this.monitorSettings = path.join(root, 'monitor.json');
    this.monitorLock = path.join(root, 'monitor.lock');
    this.monitorLog = path.join(root, 'monitor.log');
    this.helperState = path.join(root, 'helper.json');
  }

  /**
   * Stored result of the discovery of one GitHub account: `repositories-<account ID>.json` (a list holds the repository
   * names of one account, and is never shown to another). Throws for an ID that is not a valid file name part.
   */
  repositoriesFile(accountId: string): string {
    return path.join(this.root, `repositories-${checkedId('account ID', accountId)}.json`);
  }

  /** `sessions/<window-id>.json`. Throws for an ID that is not a valid file name part (see `isStorageId`). */
  sessionFile(windowId: string): string {
    return path.join(this.sessionsDir, `${checkedId('window ID', windowId)}.json`);
  }

  /** `pending/<environment-id>.json`. Throws for an invalid ID. */
  pendingFile(environmentId: string): string {
    return path.join(this.pendingDir, `${checkedId('environment ID', environmentId)}.json`);
  }

  /** `operations/<environment-id>.json`. Throws for an invalid ID. */
  operationFile(environmentId: string): string {
    return path.join(this.operationsDir, `${checkedId('environment ID', environmentId)}.json`);
  }

  /** `operations/<environment-id>.claimed.<time in ms>.<window-id>`. Throws for an invalid ID. */
  claimedOperationFile(environmentId: string, windowId: string, claimedAtMs: number): string {
    const time = Math.max(0, Math.floor(claimedAtMs));
    return path.join(
      this.operationsDir,
      `${checkedId('environment ID', environmentId)}${CLAIM_MARKER}${time}.${checkedId('window ID', windowId)}`,
    );
  }

  /** Creates the storage folder and its sub-folders, if they are missing. */
  async ensureDirectories(): Promise<void> {
    for (const dir of this.directories()) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  ensureDirectoriesSync(): void {
    for (const dir of this.directories()) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private directories(): string[] {
    return [this.root, this.sessionsDir, this.pendingDir, this.operationsDir];
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// File system helpers

/** The `code` of a Node.js system error, for example `ENOENT`. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

// Windows returns these codes for a short time while another process holds the file open without delete sharing,
// for example a virus scanner or the search indexer, also during a rename over the file. On macOS and Linux they are
// permanent, and a retry only costs a few milliseconds.
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function isTransientFsError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && TRANSIENT_CODES.has(code);
}

export interface RetryOptions {
  /** Total number of attempts. Default: 6 (async), 4 (sync). */
  attempts?: number;
  /** Delay before the second attempt. It doubles for each further attempt, up to 200 ms. Default: 10 ms. */
  delayMs?: number;
}

const MAX_RETRY_DELAY_MS = 200;

/** Runs `fn` again after a short delay when it fails with a transient file system error (see `isTransientFsError`). */
export async function retryTransient<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 6);
  let delay = options.delayMs ?? 10;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isTransientFsError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Synchronous variant of `retryTransient`, for `deactivate()`. It blocks the thread during the delays. */
export function retryTransientSync<T>(fn: () => T, options: RetryOptions = {}): T {
  // Assumption (V-3): deactivate() has only little time, so the default retry budget is small (about 70 ms).
  const attempts = Math.max(1, options.attempts ?? 4);
  let delay = options.delayMs ?? 10;
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (attempt >= attempts || !isTransientFsError(error)) throw error;
      sleepSync(delay);
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

/**
 * Reads a text file. Returns `undefined` if the file does not exist. Retries transient errors, and throws other errors,
 * so that a caller never takes an unreadable file for a missing one.
 */
export async function readTextFile(file: string): Promise<string | undefined> {
  return retryTransient(async () => {
    try {
      return await fs.promises.readFile(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  });
}

export function readTextFileSync(file: string): string | undefined {
  return retryTransientSync(() => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  });
}

/** Parses JSON. A byte order mark (for example from a manual edit) is ignored. Returns `undefined` for invalid JSON. */
export function parseJson(text: string): unknown {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads and parses a JSON file. Returns `undefined` if the file is missing, cannot be read, or is not valid JSON. */
export async function readJsonTolerant(file: string): Promise<unknown> {
  try {
    const text = await readTextFile(file);
    return text === undefined ? undefined : parseJson(text);
  } catch {
    return undefined;
  }
}

export function readJsonTolerantSync(file: string): unknown {
  try {
    const text = readTextFileSync(file);
    return text === undefined ? undefined : parseJson(text);
  } catch {
    return undefined;
  }
}

/** Names of the entries of a folder, sorted. A missing folder gives an empty list. */
export async function listNames(dir: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(dir)).sort();
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return [];
    throw error;
  }
}
