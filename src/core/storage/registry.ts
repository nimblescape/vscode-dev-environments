// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Environment Registry (concept 7.5): registry.json in the global storage folder.
// Several VS Code windows and the Session Monitor process change it. Every read-modify-write runs under the lock folder
// registry.lock, and every write is atomic (temporary file, then rename), so a read without the lock sees either the old
// or the new content (implementation notes 4).
import * as fs from 'fs';
import * as path from 'path';
import { isoTime, silentLogger, sleep, systemClock, type Clock, type Logger } from '../ports';
import type { BuildRecord, BusyMark, BusyOperation, Environment, GitHubAccount, GitSummary, RefusedUpdate, RegistryFile } from '../types';
import { writeJsonAtomic } from './atomicJson';
import { errorCode, isStorageId, isTransientFsError, parseJson, readTextFile, retryTransient, type StoragePaths } from './paths';

/** The registry format that this version reads and writes. */
export const REGISTRY_VERSION = 1;

// User-visible text that messages.ts lacks; to be moved there.
/** Shown when registry.json was written by a newer version of the extension. */
export const REGISTRY_NEWER_VERSION_MESSAGE =
  'The list of environments was saved by a newer version of Dev Environments. Update the extension to change it.';

/** Thrown by a change of a registry file with a newer format version. The file is not changed. */
export class RegistryVersionError extends Error {
  constructor(readonly version: number) {
    super(REGISTRY_NEWER_VERSION_MESSAGE);
    this.name = 'RegistryVersionError';
  }
}

export interface RegistryOptions {
  logger?: Logger;
  /** A lock folder older than this counts as stale (the holder crashed). Default: 10 seconds. */
  lockStaleMs?: number;
  /** Maximum wait for the lock. Default: 15 seconds. */
  lockTimeoutMs?: number;
}

const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
// Shorter than the default of withDirectoryLock (50 ms): a mkdir every 20 ms costs little, and a waiting window or the
// Session Monitor gets the lock sooner.
const LOCK_RETRY_MS = 20;
// On Windows, a lock folder that its last holder is still removing cannot be created again for a moment (EPERM). On
// macOS and Linux these errors are permanent, so they are thrown after about one second instead of a lock timeout.
const MAX_TRANSIENT_LOCK_ERRORS = 50;
const DEFAULT_CONFIG_PATH = '.devcontainer/devcontainer.json';
const EPOCH = new Date(0).toISOString();

/** The Environment Registry. Used by the windows and by the Session Monitor process. It keeps no cache. */
export class EnvironmentRegistry {
  private readonly logger: Logger;
  private readonly lockStaleMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly paths: StoragePaths,
    private readonly clock: Clock = systemClock,
    options: RegistryOptions = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  /** True if registry.json exists. */
  async exists(): Promise<boolean> {
    try {
      await retryTransient(() => fs.promises.stat(this.paths.registry));
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * Reads the registry without the lock. A missing or invalid file, and a file of a newer format version, give
   * `{ version: 1, environments: [] }`. Invalid entries are left out. Throws only if the file exists but cannot be read.
   */
  async read(): Promise<RegistryFile> {
    return parseRegistry(await readTextFile(this.paths.registry)).file;
  }

  /**
   * Concept 7.5 "registry lost": true when registry.json lost content that the volume labels can restore. That is, the
   * file is missing, is not valid (not JSON, an unknown format version, `environments` is not a list), or has entries
   * that the registry leaves out as invalid (the next write drops them). False for a valid file, and for a file of a
   * newer format version, which this version must not change. Throws only if the file exists but cannot be read.
   */
  async needsRestore(): Promise<boolean> {
    const parsed = parseRegistry(await readTextFile(this.paths.registry));
    return parsed.state === 'missing' || parsed.state === 'invalid' || (parsed.state === 'ok' && parsed.dropped > 0);
  }

  async list(): Promise<Environment[]> {
    return (await this.read()).environments;
  }

  async get(id: string): Promise<Environment | undefined> {
    return (await this.list()).find((environment) => environment.id === id);
  }

  /** Finds the environment of `owner/name`, ignoring case. */
  async findByRepository(repository: string): Promise<Environment | undefined> {
    const wanted = repository.toLowerCase();
    return (await this.list()).find((environment) => environment.repository.toLowerCase() === wanted);
  }

  /** Finds the environment of a container name, with or without the leading `/` of `docker inspect`. */
  async findByContainerName(containerName: string): Promise<Environment | undefined> {
    const wanted = withoutLeadingSlash(containerName);
    return (await this.list()).find((environment) => withoutLeadingSlash(environment.containerName) === wanted);
  }

  /**
   * Read-modify-write under the lock folder `paths.registryLock` (see `withLockFolder`). The mutator changes `file` in
   * place. The file is written only if the content changed. If the mutator throws, nothing is written.
   * Keep the mutator short: do not call Docker or the network in it, and never call `update` from inside it
   * (the lock is not re-entrant). Throws `RegistryVersionError` for a file of a newer format version.
   */
  async update<T>(mutator: (file: RegistryFile) => T | Promise<T>): Promise<T> {
    return withLockFolder(this.paths.registryLock, () => this.updateLocked(mutator), {
      staleMs: this.lockStaleMs,
      timeoutMs: this.lockTimeoutMs,
    });
  }

  /**
   * Adds an environment. Throws if an environment with the same ID, or of the same repository (ignoring case), exists:
   * one environment per repository (concept D-3). The check runs under the lock, so two windows that start the same
   * repository at the same time cannot both add an environment.
   */
  async add(environment: Environment): Promise<void> {
    const repository = environment.repository.toLowerCase();
    await this.update((file) => {
      if (file.environments.some((existing) => existing.id === environment.id)) {
        throw new Error(`The environment ${environment.id} exists already.`);
      }
      if (file.environments.some((existing) => existing.repository.toLowerCase() === repository)) {
        throw new Error(`An environment of ${environment.repository} exists already.`);
      }
      file.environments.push(environment);
    });
  }

  /**
   * Changes one environment under the lock. Returns the changed environment, or `undefined` if the ID does not exist.
   * An async mutator is awaited before the write (TypeScript accepts one also for a `void` return type).
   */
  async updateEnvironment(
    id: string,
    mutator: (environment: Environment) => void | Promise<void>,
  ): Promise<Environment | undefined> {
    return this.update(async (file) => {
      const environment = file.environments.find((candidate) => candidate.id === id);
      if (!environment) return undefined;
      await mutator(environment);
      return environment;
    });
  }

  /** Removes an environment. A missing ID is not an error. */
  async remove(id: string): Promise<void> {
    await this.update((file) => {
      file.environments = file.environments.filter((environment) => environment.id !== id);
    });
  }

  /**
   * Marks the environment as busy (concept 7.9 rule 1), so the Session Monitor does not stop it. Replaces an existing mark.
   * Throws if the environment does not exist, because the caller relies on the protection.
   */
  async setBusy(id: string, operation: BusyOperation, owner: { windowId: string; pid: number }): Promise<void> {
    const since = isoTime(this.clock);
    const changed = await this.updateEnvironment(id, (environment) => {
      environment.busy = { operation, since, pid: owner.pid, windowId: owner.windowId };
    });
    if (!changed) throw new Error(`The environment ${id} does not exist.`);
  }

  /** Removes the busy mark. A missing environment or a missing mark is not an error. */
  async clearBusy(id: string): Promise<void> {
    await this.updateEnvironment(id, (environment) => {
      delete environment.busy;
    });
  }

  private async updateLocked<T>(mutator: (file: RegistryFile) => T | Promise<T>): Promise<T> {
    const parsed = parseRegistry(await readTextFile(this.paths.registry));
    if (parsed.state === 'newer') throw new RegistryVersionError(parsed.version ?? REGISTRY_VERSION);
    const file = parsed.file;
    const before = JSON.stringify(file);
    const result = await mutator(file);
    file.version = REGISTRY_VERSION;
    if (JSON.stringify(file) !== before) {
      if (parsed.state === 'invalid' || parsed.dropped > 0) await this.backup(parsed);
      await retryTransient(() => writeJsonAtomic(this.paths.registry, file));
    }
    return result;
  }

  /** Keeps a copy of a file whose content the next write would lose (invalid file or invalid entries). */
  private async backup(parsed: ParsedRegistry): Promise<void> {
    const copy = `${this.paths.registry}.backup-${this.clock.now()}`;
    await retryTransient(() => fs.promises.copyFile(this.paths.registry, copy));
    const reason =
      parsed.state === 'invalid' ? 'was not valid' : `contained ${parsed.dropped} invalid environment entries`;
    this.logger.warn(`The environment registry ${reason}. A copy was saved as ${copy}.`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Lock folder

interface LockTimings {
  staleMs: number;
  timeoutMs: number;
}

/**
 * Runs `fn` while holding the lock folder `lockDir`. Same protocol as `withDirectoryLock` of atomicJson.ts (implementation
 * notes 4: created with mkdir, removed after `fn`, stale when older than `staleMs`), which it replaces here because:
 * - two waiters that both see a stale folder must not both get the lock. With a plain "remove, then mkdir", the slower
 *   one removes the fresh lock of the faster one, and one of the two changes is lost;
 * - the holder refreshes the folder time while `fn` runs, so a slow `fn` is not taken for stale;
 * - transient errors of Windows are tried again instead of failing the change.
 */
async function withLockFolder<T>(lockDir: string, fn: () => Promise<T>, timings: LockTimings): Promise<T> {
  await acquireLockFolder(lockDir, timings);
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.promises.utimes(lockDir, now, now).catch(() => {});
  }, Math.max(10, Math.floor(timings.staleMs / 4)));
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await removeFolder(lockDir);
  }
}

async function acquireLockFolder(lockDir: string, { staleMs, timeoutMs }: LockTimings): Promise<void> {
  const start = Date.now();
  await retryTransient(() => fs.promises.mkdir(path.dirname(lockDir), { recursive: true }));
  let transientErrors = 0;
  for (;;) {
    try {
      await fs.promises.mkdir(lockDir);
      return;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        if (await removeStaleLockFolder(lockDir, staleMs)) continue;
      } else if (!isTransientFsError(error) || ++transientErrors > MAX_TRANSIENT_LOCK_ERRORS) {
        throw error;
      }
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout while waiting for the lock ${lockDir}.`);
    await sleep(LOCK_RETRY_MS);
  }
}

/**
 * Removes `lockDir` if it is stale (its holder crashed). Returns true if the folder is gone, so that the caller tries
 * mkdir again at once. Only one waiter at a time removes a stale folder: it holds the guard folder `<lockDir>.takeover`
 * and checks the age again, because another waiter may have replaced the stale folder with its own fresh lock meanwhile.
 */
async function removeStaleLockFolder(lockDir: string, staleMs: number): Promise<boolean> {
  const age = await folderAge(lockDir);
  if (age === undefined) return true;
  if (age <= staleMs) return false;
  const guard = `${lockDir}.takeover`;
  try {
    await fs.promises.mkdir(guard);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      // Another waiter removes the stale lock right now. Its guard is stale only if it crashed while doing so.
      const guardAge = await folderAge(guard);
      if (guardAge !== undefined && guardAge > staleMs) await removeFolder(guard);
      return false;
    }
    if (isTransientFsError(error)) return false;
    throw error;
  }
  try {
    const current = await folderAge(lockDir);
    if (current === undefined) return true;
    if (current <= staleMs) return false;
    await removeFolder(lockDir);
    return true;
  } finally {
    await removeFolder(guard);
  }
}

/** Milliseconds since the last change of a folder, or `undefined` if it does not exist. */
async function folderAge(dir: string): Promise<number | undefined> {
  try {
    return Date.now() - (await fs.promises.stat(dir)).mtimeMs;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    // Windows: a folder that another process is removing cannot be opened for a moment. It is not stale.
    if (isTransientFsError(error)) return 0;
    throw error;
  }
}

async function removeFolder(dir: string): Promise<void> {
  await retryTransient(() => fs.promises.rm(dir, { recursive: true, force: true })).catch(() => {});
}

// ---------------------------------------------------------------------------------------------------------------------
// Normalization

interface ParsedRegistry {
  /** `invalid`: not JSON, not an object, an unknown version, or `environments` is not a list. */
  state: 'missing' | 'ok' | 'invalid' | 'newer';
  file: RegistryFile;
  /** Version of a newer file. */
  version?: number;
  /** Number of entries left out (invalid, or a repeated ID). */
  dropped: number;
}

function emptyRegistry(): RegistryFile {
  return { version: REGISTRY_VERSION, environments: [] };
}

function parseRegistry(text: string | undefined): ParsedRegistry {
  if (text === undefined) return { state: 'missing', file: emptyRegistry(), dropped: 0 };
  const value = parseJson(text);
  if (!isRecord(value)) return { state: 'invalid', file: emptyRegistry(), dropped: 0 };

  // A file without a version is taken as version 1: only this extension writes the file.
  const version = value.version;
  if (version !== undefined && version !== REGISTRY_VERSION) {
    if (typeof version === 'number' && Number.isFinite(version) && version > REGISTRY_VERSION) {
      return { state: 'newer', file: emptyRegistry(), version, dropped: 0 };
    }
    return { state: 'invalid', file: emptyRegistry(), dropped: 0 };
  }
  if (value.environments !== undefined && !Array.isArray(value.environments)) {
    return { state: 'invalid', file: emptyRegistry(), dropped: 0 };
  }

  const entries: unknown[] = Array.isArray(value.environments) ? value.environments : [];
  const ids = new Set<string>();
  const environments: Environment[] = [];
  for (const entry of entries) {
    const environment = normalizeEnvironment(entry);
    if (!environment || ids.has(environment.id)) continue;
    ids.add(environment.id);
    environments.push(environment);
  }
  // The parsed object is kept, so fields that this version does not know survive a read-modify-write.
  value.version = REGISTRY_VERSION;
  value.environments = environments;
  return { state: 'ok', file: value as unknown as RegistryFile, dropped: entries.length - environments.length };
}

type Check = (value: unknown) => boolean;

const OPTIONAL_FIELDS: ReadonlyArray<readonly [keyof Environment, Check]> = [
  ['gitSummary', isGitSummary],
  ['buildRecord', isBuildRecord],
  ['busy', isBusyMark],
  ['remoteUser', isString],
  ['remoteWorkspaceFolder', isString],
  ['shutdownActionNone', (value) => typeof value === 'boolean'],
  ['additionalVolumes', (value) => Array.isArray(value) && value.every(isNonEmptyString)],
  ['lastBuildNumber', isCount],
  ['owner', isOwner],
  ['refusedUpdate', isRefusedUpdate],
];

/**
 * Checks one entry in place. An entry without a usable ID, repository, volume name, or container name is left out.
 * Missing configuration path and times get defaults. Invalid optional fields are removed. Unknown fields are kept.
 */
function normalizeEnvironment(value: unknown): Environment | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.id) ||
    !isRepositoryName(value.repository) ||
    !isNonEmptyString(value.volumeName) ||
    !isNonEmptyString(value.containerName)
  ) {
    return undefined;
  }
  if (!isNonEmptyString(value.configPath)) value.configPath = DEFAULT_CONFIG_PATH;
  if (!isString(value.createdAt)) value.createdAt = EPOCH;
  if (!isString(value.lastUsedAt)) value.lastUsedAt = value.createdAt;
  for (const [key, check] of OPTIONAL_FIELDS) {
    if (key in value && !check(value[key])) delete value[key];
  }
  return value as unknown as Environment;
}

function isGitSummary(value: unknown): value is GitSummary {
  return (
    isRecord(value) &&
    (value.branch === null || isString(value.branch)) &&
    isCount(value.uncommittedFiles) &&
    isCount(value.unpushedCommits) &&
    isCount(value.stashes) &&
    isString(value.recordedAt)
  );
}

function isBuildRecord(value: unknown): value is BuildRecord {
  return (
    isRecord(value) &&
    isString(value.builtAt) &&
    isNonEmptyString(value.environmentImage) &&
    isCount(value.buildNumber) &&
    isString(value.configPath) &&
    isString(value.configHash) &&
    isStringRecord(value.images) &&
    isStringRecord(value.features)
  );
}

function isRefusedUpdate(value: unknown): value is RefusedUpdate {
  return (
    isRecord(value) &&
    isString(value.configPath) &&
    isString(value.configHash) &&
    isStringRecord(value.images) &&
    isStringRecord(value.features) &&
    isString(value.items)
  );
}

/** The owner account: a GitHub user ID and a login (empty after a restore from the volume labels). */
function isOwner(value: unknown): value is GitHubAccount {
  return isRecord(value) && isStorageId(value.id) && isString(value.login);
}

function isBusyMark(value: unknown): value is BusyMark {
  // Any operation name is accepted: a mark of a newer version must still protect the container.
  return (
    isRecord(value) &&
    isNonEmptyString(value.operation) &&
    isString(value.since) &&
    isCount(value.pid) &&
    value.pid > 0 &&
    isString(value.windowId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}

function isRepositoryName(value: unknown): value is string {
  return typeof value === 'string' && /^[^/\s]+\/[^/\s]+$/.test(value);
}

function withoutLeadingSlash(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}
