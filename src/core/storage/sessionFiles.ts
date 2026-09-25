// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Coordination files in the global storage folder (concept 7.9, 7.10, 7.14; implementation notes 4): window status files,
// pending connection files, pending operations, the reopen record, and the settings for the Session Monitor.
// Every write is atomic. Reads skip files that are missing, unreadable, or invalid.
import * as fs from 'fs';
import * as path from 'path';
import { isoTime, systemClock, type Clock } from '../ports';
import type {
  Environment,
  MonitorSettings,
  PendingConnection,
  PendingOperation,
  PendingOperationKind,
  ReopenRecord,
  WindowStatus,
} from '../types';
import { listJsonFiles, removeFile, writeJsonAtomic, writeJsonAtomicSync } from './atomicJson';
import {
  CLAIM_MARKER,
  errorCode,
  isStorageId,
  listNames,
  parseClaimedOperationName,
  parseJson,
  readJsonTolerant,
  readJsonTolerantSync,
  readTextFile,
  retryTransient,
  retryTransientSync,
  type StoragePaths,
} from './paths';

/** Default age after which `cleanupStaleClaims` removes a claimed operation file. */
export const DEFAULT_CLAIM_MAX_AGE_MS = 60 * 60 * 1000;

export class SessionFiles {
  constructor(
    private readonly paths: StoragePaths,
    private readonly clock: Clock = systemClock,
  ) {}

  // --- Window status files (sessions/<window-id>.json) -------------------------------------------------------------

  async writeWindowStatus(status: WindowStatus): Promise<void> {
    const file = this.paths.sessionFile(status.windowId);
    await retryTransient(() => writeJsonAtomic(file, status));
  }

  /** Synchronous write, for `deactivate()` (implementation notes 4). */
  writeWindowStatusSync(status: WindowStatus): void {
    const file = this.paths.sessionFile(status.windowId);
    retryTransientSync(() => writeJsonAtomicSync(file, status));
  }

  /** All valid window status files. Invalid files, and files whose name does not match their window ID, are skipped. */
  async readWindowStatuses(): Promise<WindowStatus[]> {
    return readAll(this.paths.sessionsDir, isWindowStatus, (status) => status.windowId);
  }

  async removeWindowStatus(windowId: string): Promise<void> {
    const file = this.paths.sessionFile(windowId);
    await retryTransient(() => removeFile(file));
  }

  // --- Pending connection files (pending/<environment-id>.json) ----------------------------------------------------

  /** Writes the pending connection file with `createdAt` = now. */
  async writePending(environmentId: string, windowId: string): Promise<void> {
    const pending: PendingConnection = { environmentId, windowId, createdAt: isoTime(this.clock) };
    const file = this.paths.pendingFile(environmentId);
    await retryTransient(() => writeJsonAtomic(file, pending));
  }

  async readPendings(): Promise<PendingConnection[]> {
    return readAll(this.paths.pendingDir, isPendingConnection, (pending) => pending.environmentId);
  }

  async removePending(environmentId: string): Promise<void> {
    const file = this.paths.pendingFile(environmentId);
    await retryTransient(() => removeFile(file));
  }

  // --- Pending operations (operations/<environment-id>.json) -------------------------------------------------------

  async writeOperation(operation: PendingOperation): Promise<void> {
    const file = this.paths.operationFile(operation.environmentId);
    await retryTransient(() => writeJsonAtomic(file, operation));
  }

  /** Pending operations that no window has claimed yet. */
  async readOperations(): Promise<PendingOperation[]> {
    return readAll(this.paths.operationsDir, isPendingOperation, (operation) => operation.environmentId);
  }

  /**
   * Atomically claims the pending operation: renames it to `<environment-id>.claimed.<time>.<window-id>`. A rename of one
   * source succeeds only once, also across processes, so only one window wins. Returns the operation if this window won;
   * `undefined` if another window was first or no operation exists. An invalid claimed file is removed.
   */
  async claimOperation(environmentId: string, windowId: string): Promise<PendingOperation | undefined> {
    const source = this.paths.operationFile(environmentId);
    const claimed = this.paths.claimedOperationFile(environmentId, windowId, this.clock.now());
    try {
      await retryTransient(() => fs.promises.rename(source, claimed));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    // Read errors other than invalid content are thrown, and the claimed file stays: the operation is not lost silently.
    const text = await readTextFile(claimed);
    const operation = text === undefined ? undefined : parseJson(text);
    if (!isPendingOperation(operation) || operation.environmentId !== environmentId) {
      await retryTransient(() => removeFile(claimed)).catch(() => {});
      return undefined;
    }
    return operation;
  }

  /** Removes the operation file and the claimed files of this environment. */
  async removeOperation(environmentId: string): Promise<void> {
    const file = this.paths.operationFile(environmentId);
    await retryTransient(() => removeFile(file));
    const dir = this.paths.operationsDir;
    for (const name of await listNames(dir)) {
      if (parseClaimedOperationName(name)?.environmentId === environmentId) {
        await retryTransient(() => removeFile(path.join(dir, name)));
      }
    }
  }

  /**
   * Removes claimed files older than `maxAgeMs` (default 1 hour). The age counts from the claim time in the file name.
   * A claimed file is only a trace of work in progress: the claiming window has the operation in memory. Best effort.
   */
  async cleanupStaleClaims(maxAgeMs: number = DEFAULT_CLAIM_MAX_AGE_MS): Promise<void> {
    const dir = this.paths.operationsDir;
    const now = this.clock.now();
    for (const name of await listNames(dir)) {
      if (!name.includes(CLAIM_MARKER)) continue;
      const file = path.join(dir, name);
      try {
        const claimedAt = parseClaimedOperationName(name)?.claimedAtMs ?? (await fs.promises.stat(file)).mtimeMs;
        // A claim time far in the future (the clock was changed) also counts as stale.
        if (Math.abs(now - claimedAt) > maxAgeMs) await retryTransient(() => removeFile(file));
      } catch {
        // Removed by another window in the meantime, or not removable now: the next cleanup tries again.
      }
    }
  }

  // --- Reopen record (reopen.json) ---------------------------------------------------------------------------------

  /** Synchronous write, for `deactivate()`. */
  writeReopenSync(record: ReopenRecord): void {
    retryTransientSync(() => writeJsonAtomicSync(this.paths.reopen, record));
  }

  async readReopen(): Promise<ReopenRecord | undefined> {
    const value = await readJsonTolerant(this.paths.reopen);
    return isReopenRecord(value) ? value : undefined;
  }

  async removeReopen(): Promise<void> {
    await retryTransient(() => removeFile(this.paths.reopen));
  }

  // --- Settings for the Session Monitor (monitor.json) -------------------------------------------------------------

  async writeMonitorSettings(settings: MonitorSettings): Promise<void> {
    await retryTransient(() => writeJsonAtomic(this.paths.monitorSettings, settings));
  }

  async readMonitorSettings(): Promise<MonitorSettings | undefined> {
    const value = await readJsonTolerant(this.paths.monitorSettings);
    return isMonitorSettings(value) ? value : undefined;
  }

  readMonitorSettingsSync(): MonitorSettings | undefined {
    const value = readJsonTolerantSync(this.paths.monitorSettings);
    return isMonitorSettings(value) ? value : undefined;
  }
}

/** Reads all `*.json` files of a folder, in name order. Keeps a value only if it is valid and its key matches the file name. */
async function readAll<T>(dir: string, isValid: (value: unknown) => value is T, key: (value: T) => string): Promise<T[]> {
  const files = (await listJsonFiles(dir)).sort();
  const results: Array<T | undefined> = [];
  await Promise.all(
    files.map(async (file, index) => {
      const value = await readJsonTolerant(file);
      if (isValid(value) && `${key(value)}.json` === path.basename(file)) results[index] = value;
    }),
  );
  return results.filter((value): value is T => value !== undefined);
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation of the file contents. Unknown fields are allowed.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isWindowStatus(value: unknown): value is WindowStatus {
  return (
    isRecord(value) &&
    isStorageId(value.windowId) &&
    isPid(value.pid) &&
    (value.environmentId === null || isNonEmptyString(value.environmentId)) &&
    (value.state === 'active' || value.state === 'closing') &&
    isTime(value.updatedAt)
  );
}

export function isPendingConnection(value: unknown): value is PendingConnection {
  return (
    isRecord(value) &&
    isStorageId(value.environmentId) &&
    isNonEmptyString(value.windowId) &&
    isTime(value.createdAt)
  );
}

// Records over the union types of types.ts, so that the compiler reports a kind or reason that is missing here.
// A missing kind would make readOperations skip, and claimOperation delete, every operation of that kind.
const OPERATION_KINDS: Record<PendingOperationKind, true> = { rebuild: true, delete: true, stop: true };
const OPERATION_REASONS: Record<PendingOperation['reason'], true> = {
  manual: true,
  update: true,
  configChanged: true,
  configurationSelected: true,
};

function isKeyOf<K extends string>(record: Record<K, true>, value: unknown): value is K {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(record, value);
}

export function isPendingOperation(value: unknown): value is PendingOperation {
  return (
    isRecord(value) &&
    isStorageId(value.environmentId) &&
    isKeyOf(OPERATION_KINDS, value.operation) &&
    isTime(value.requestedAt) &&
    typeof value.requestedBy === 'string' &&
    isKeyOf(OPERATION_REASONS, value.reason) &&
    (value.configPath === undefined || isNonEmptyString(value.configPath)) &&
    (value.additionalVolumesToRemove === undefined ||
      (Array.isArray(value.additionalVolumesToRemove) && value.additionalVolumesToRemove.every(isNonEmptyString))) &&
    (value.removeAdditionalVolumes === undefined || typeof value.removeAdditionalVolumes === 'boolean')
  );
}

/**
 * The additional volumes that a pending delete removes: the confirmed list, or for the request of an earlier version
 * (`removeAdditionalVolumes`), the volumes that `environment` records, which its question listed.
 */
export function pendingVolumesToRemove(operation: PendingOperation, environment: Environment): string[] {
  if (operation.additionalVolumesToRemove) return operation.additionalVolumesToRemove;
  return operation.removeAdditionalVolumes === true ? [...(environment.additionalVolumes ?? [])] : [];
}

export function isReopenRecord(value: unknown): value is ReopenRecord {
  return isRecord(value) && isNonEmptyString(value.environmentId) && isTime(value.closedAt);
}

export function isMonitorSettings(value: unknown): value is MonitorSettings {
  return (
    isRecord(value) &&
    typeof value.waitingTimeSeconds === 'number' &&
    Number.isFinite(value.waitingTimeSeconds) &&
    value.waitingTimeSeconds >= 0 &&
    typeof value.stopOnClose === 'boolean' &&
    typeof value.respectShutdownActionNone === 'boolean' &&
    isTime(value.updatedAt)
  );
}
