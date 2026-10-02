// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Session Coordinator (concept 7.2, 7.9, 7.10): the window side of the stop-on-close mechanism. It writes the window
// status file at activation and every 15 seconds (and then drives the window's heartbeats to the Session Monitor
// container of each engine, plan step 8 PR A), removes the pending connection file of the connected environment, and
// writes `closing` plus the reopen record in deactivate().
//
// Plan step 8, PR C: the local Node.js Session Monitor (src/monitor) is removed, with monitor.json, its lock, version,
// exit and log files and its protocol version. The window does its remaining work:
//   - when the window leaves its environment (setEnvironment to another one or none, a second start) and when it closes
//     (deactivate), the short release of the environment it leaves (user decisions Q1 and Q2 of 2026-10-02:
//     src/core/session/windowRelease.ts, which records the Git state first), bounded; deactivate() waits for it, within
//     CLOSE_RELEASE_BOUNDS, after the synchronous `closing` write; nothing while another window of this computer uses it
//     (otherWindowUses; review round 1 of PR #87, A-R1-2);
//   - review round 1 of PR #87 (A-R1-1): the first heartbeat of an environment right after its first status write (at
//     start, and when the window changes to another environment), not after the first interval;
//   - at activation and every hour, the sweep of the storage folder (sweepStorage) and the removal of the status files of
//     other windows whose process ended (cleanUpStorage).
//
// It needs only types from `vscode` (the event is a small own emitter), so it runs in unit tests without VS Code.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { HEARTBEAT_MAX_AGE_MS, PENDING_MAX_AGE_MS, waitingTimeMs } from '../core/busy';
import { errorMessage } from '../core/errors';
import { isoTime, systemClock, type Clock, type Logger } from '../core/ports';
import { isProcessAlive } from '../core/session/sessionRules';
import { CLOSE_RELEASE_BOUNDS, SWITCH_RELEASE_BOUNDS, otherWindowHoldsEnvironment, type ReleaseBounds } from '../core/session/windowRelease';
import { atomicTemporaryPath } from '../core/storage/atomicJson';
import { retryTransient, retryTransientSync, type StoragePaths } from '../core/storage/paths';
import type { SessionFiles } from '../core/storage/sessionFiles';
import { STORAGE_SWEEP_INTERVAL_MS, sweepStorage } from '../core/storage/storageSweep';
import type { Environment, ExtensionSettings, PendingConnection, WindowStatus } from '../core/types';

/** Interval of the window status file updates (concept 7.9). */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface SessionCoordinatorDeps {
  paths: StoragePaths;
  sessionFiles: SessionFiles;
  logger: Logger;
  settings: () => ExtensionSettings;
  /** The Docker context in the authority of this window (ConnectionAdapter.currentDockerContext), for its status file. */
  windowDockerContext?: () => string | undefined;
  clock?: Clock;
  // For tests:
  /** Default: `crypto.randomUUID()`. */
  windowId?: string;
  /** Process ID of this extension host. Default: `process.pid`. */
  pid?: number;
  /** Default: `isProcessAlive`. */
  isAlive?: (pid: number) => boolean;
  /** Default: HEARTBEAT_INTERVAL_MS. */
  heartbeatMs?: number;
  /** Plan step 8, PR C: the interval of cleanUpStorage after the one at activation. Default: STORAGE_SWEEP_INTERVAL_MS. */
  cleanupMs?: number;
  /**
   * Plan step 8, PR A: the heartbeats of this window to the Session Monitor container of each engine
   * (src/core/session/windowHeartbeats.ts), driven by this tick after each status write. Not awaited (a heartbeat over
   * SSH, or the repair of a missing monitor, must not hold the status file back); it skips a tick while one runs.
   */
  windowHeartbeats?: { tick(): Promise<void> };
  /**
   * Plan step 8, PR C (user decisions Q1 and Q2 of 2026-10-02): the release of an environment this window leaves
   * (releaseEnvironment of src/core/session/windowRelease.ts, the recorded state of its repository first, then the short
   * release), within `bounds`. Without it: no release (the long limit of the heartbeats applies).
   */
  release?: (environmentId: string, bounds: ReleaseBounds) => Promise<unknown>;
}

/** Minimal `vscode.EventEmitter` replacement, so that this module has no runtime dependency on `vscode`. */
class Emitter<T> {
  private readonly listeners = new Set<(event: T) => void>();

  constructor(private readonly logger: Logger) {}

  readonly event: vscode.Event<T> = (listener, thisArgs?, disposables?) => {
    const entry = (event: T): void => {
      listener.call(thisArgs, event);
    };
    this.listeners.add(entry);
    const disposable: vscode.Disposable = { dispose: () => this.listeners.delete(entry) };
    disposables?.push(disposable);
    return disposable;
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error('A listener of the window heartbeat failed.', error);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** `promise`, but resolved after `ms` at the latest. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise.then(() => undefined, () => undefined), deadline]).finally(() => clearTimeout(timer));
}

export class SessionCoordinator implements vscode.Disposable {
  /** Random ID of this window, new at each activation (a window reload creates a new ID, concept 7.9). */
  readonly windowId: string;
  /** Fired after each periodic status file update (every 15 seconds). */
  readonly onDidHeartbeat: vscode.Event<void>;

  private readonly paths: StoragePaths;
  private readonly sessionFiles: SessionFiles;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly heartbeatMs: number;
  private readonly cleanupMs: number;
  private readonly heartbeatEmitter: Emitter<void>;

  private currentEnvironmentId: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private cleanupRunning = false;
  private started = false;
  private heartbeatRunning = false;
  /** Set by deactivateSync() and dispose(): no further asynchronous status writes. */
  private stopped = false;
  private deactivated = false;
  /** Incremented by each status write. Only the newest write may replace the file. */
  private writeGeneration = 0;
  /** Plan step 8, PR C: the releases of a switch that still run (deactivate waits for them within its bound). */
  private readonly releases = new Set<Promise<void>>();

  constructor(private readonly deps: SessionCoordinatorDeps) {
    this.paths = deps.paths;
    this.sessionFiles = deps.sessionFiles;
    this.logger = deps.logger;
    this.clock = deps.clock ?? systemClock;
    this.windowId = deps.windowId ?? crypto.randomUUID();
    this.pid = deps.pid ?? process.pid;
    this.isAlive = deps.isAlive ?? isProcessAlive;
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
    this.cleanupMs = deps.cleanupMs ?? STORAGE_SWEEP_INTERVAL_MS;
    this.heartbeatEmitter = new Emitter<void>(deps.logger);
    this.onDidHeartbeat = this.heartbeatEmitter.event;
  }

  /** Environment that this window is connected to, `null` for a window without an environment. */
  get environmentId(): string | null {
    return this.currentEnvironmentId;
  }

  /**
   * Writes the status file (`active`) at once and then every 15 seconds; each write removes the pending connection file
   * of the environment (concept 7.9: the window that connects deletes this file when it writes its status file).
   * Plan step 8, PR C: then cleans up the storage folder (cleanUpStorage), and again every hour. A second call works like
   * `setEnvironment`. Never throws: errors are logged, and the next update tries again.
   *
   * Resolves with the pending connection file of the environment that existed before this call removed it, if it is
   * younger than PENDING_MAX_AGE_MS: the open pipeline has just run for this window (it was opened by our own
   * `vscode.openFolder`). The file itself is gone afterwards, so a caller that needs this must use the result.
   */
  async start(environmentId: string | null): Promise<PendingConnection | undefined> {
    if (this.stopped) return undefined;
    if (this.started) {
      const previous = this.currentEnvironmentId;
      this.currentEnvironmentId = environmentId;
      const pending = await this.freshPending(environmentId);
      await this.writeStatus();
      this.tickNow(previous, environmentId);
      this.releaseLeft(previous, environmentId);
      return pending;
    }
    this.currentEnvironmentId = environmentId;
    this.started = true;
    try {
      await this.paths.ensureDirectories();
    } catch (error) {
      this.logger.warn(`The storage folder could not be created. ${errorMessage(error)}`);
    }
    // Read before the first status write, which removes the file.
    const pending = await this.freshPending(environmentId);
    if (this.stopped) return undefined;
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.timer.unref?.();
    this.cleanupTimer = setInterval(() => void this.cleanUpStorage(), this.cleanupMs);
    this.cleanupTimer.unref?.();
    await this.writeStatus();
    // Review round 1 of PR #87 (A-R1-1): the first heartbeat at once, not after the first interval: a reload of this
    // window follows the short release of its previous activation, which must not run out before this window's long
    // heartbeat reaches the monitor. Not awaited; never throws.
    if (!this.stopped && environmentId !== null) void this.deps.windowHeartbeats?.tick();
    await this.cleanUpStorage();
    return pending;
  }

  /**
   * Changes the environment of this window and writes the status file at once. Plan step 8, PR C (Q1): the environment
   * that the window leaves gets its release (not awaited here; deactivate waits for it within its bound).
   */
  async setEnvironment(environmentId: string | null): Promise<void> {
    if (this.stopped) return;
    const previous = this.currentEnvironmentId;
    this.currentEnvironmentId = environmentId;
    if (!this.started) return;
    await this.writeStatus();
    this.tickNow(previous, environmentId);
    this.releaseLeft(previous, environmentId);
  }

  /**
   * Review round 1 of PR #87 (A-R1-1): after a change to another environment, its first heartbeat at once (it may have
   * been released a moment ago, by this window or by a reload of it). Not awaited; never throws.
   */
  private tickNow(previous: string | null, next: string | null): void {
    if (this.stopped || next === null || next === previous) return;
    void this.deps.windowHeartbeats?.tick();
  }

  /**
   * Writes the pending connection file of an environment (concept 7.9), so that another window does not take the
   * environment for unused while this window connects. Throws if the file cannot be written: the caller relies on the
   * protection.
   */
  async writePending(environmentId: string): Promise<void> {
    await this.sessionFiles.writePending(environmentId, this.windowId);
  }

  /** Status files of OTHER windows whose process exists, whose state is `active`, and that were updated ≤ 60 s ago. */
  async otherActiveWindows(): Promise<WindowStatus[]> {
    const now = this.clock.now();
    const statuses = await this.sessionFiles.readWindowStatuses();
    return statuses.filter((status) => {
      if (status.windowId === this.windowId || status.state !== 'active') return false;
      const updatedAt = Date.parse(status.updatedAt);
      if (!Number.isFinite(updatedAt) || Math.abs(now - updatedAt) > HEARTBEAT_MAX_AGE_MS) return false;
      return this.isAlive(status.pid);
    });
  }

  /**
   * Review round 1 of PR #87 (A-R1-2): whether another window of this computer uses `environment`, so this window must
   * not release it (otherWindowHoldsEnvironment: a status file, a fresh pending connection file, or a live busy mark of
   * another window). True when the files cannot be read (not known: nothing is released, the long limit stays). Never
   * throws.
   */
  async otherWindowUses(environment: Environment): Promise<boolean> {
    try {
      const [windowStatuses, pendings] = await Promise.all([this.sessionFiles.readWindowStatuses(), this.sessionFiles.readPendings()]);
      return otherWindowHoldsEnvironment(environment, this.windowId, { now: this.clock.now(), isAlive: this.isAlive, windowStatuses, pendings });
    } catch (error) {
      this.logger.warn(`It is not known whether another window uses ${environment.repository}; it is not released. ${errorMessage(error)}`);
      return true;
    }
  }

  /**
   * Plan step 8, PR C (moved from the removed local Session Monitor, monitor cleanup of 2026-09-29): the sweep of the
   * storage folder (sweepStorage: stale pending files, disconnect requests, temporary files), and the removal of the status
   * files of other windows whose process ended and that were not updated for HEARTBEAT_MAX_AGE_MS plus the waiting time
   * (a window that just closed keeps its `closing` file that long). At activation and every hour; one at a time. Never
   * throws.
   */
  async cleanUpStorage(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const now = this.clock.now();
      try {
        const removed = await sweepStorage(this.paths, now);
        const files = [...removed.pending, ...removed.disconnect, ...removed.temporary];
        if (files.length > 0) this.logger.info(`Removed outdated files from the storage folder: ${files.join(', ')}`);
      } catch (error) {
        this.logger.warn(`The storage folder could not be cleaned up. ${errorMessage(error)}`);
      }
      const maxAgeMs = HEARTBEAT_MAX_AGE_MS + waitingTimeMs(this.deps.settings());
      let statuses: WindowStatus[] = [];
      try {
        statuses = await this.sessionFiles.readWindowStatuses();
      } catch (error) {
        this.logger.warn(`The window status files could not be read. ${errorMessage(error)}`);
      }
      for (const status of statuses) {
        if (status.windowId === this.windowId || this.isAlive(status.pid)) continue;
        const updatedAt = Date.parse(status.updatedAt);
        if (Number.isFinite(updatedAt) && Math.abs(now - updatedAt) <= maxAgeMs) continue;
        try {
          await this.sessionFiles.removeWindowStatus(status.windowId);
          this.logger.info(`Removed the status file of the closed window ${status.windowId}.`);
        } catch (error) {
          this.logger.warn(`The status file of the closed window ${status.windowId} could not be removed. ${errorMessage(error)}`);
        }
      }
    } finally {
      this.cleanupRunning = false;
    }
  }

  /**
   * For `deactivate()`: synchronous write of the state `closing`, plus the reopen record when the window is connected
   * (concept 7.9, 7.10). Stops the updates first; an update that is still running cannot replace the file afterwards
   * (see `writeActiveStatus`). Never throws.
   */
  deactivateSync(): void {
    if (this.deactivated) return;
    this.deactivated = true;
    this.stopTimer();
    // A window that never started has no status file to change.
    if (!this.started) return;
    const environmentId = this.currentEnvironmentId;
    const now = isoTime(this.clock);
    try {
      this.sessionFiles.writeWindowStatusSync({
        windowId: this.windowId,
        pid: this.pid,
        environmentId,
        state: 'closing',
        updatedAt: now,
      });
    } catch (error) {
      this.logger.error('The window status could not be set to closing.', error);
    }
    if (environmentId !== null) {
      try {
        this.sessionFiles.writeReopenSync({ environmentId, closedAt: now });
      } catch (error) {
        this.logger.error('The reopen record could not be written.', error);
      }
    }
  }

  /**
   * Plan step 8, PR C: `deactivate()` of the extension. First deactivateSync() (synchronously, before any await), then
   * the release of the connected environment (user decision Q1 of 2026-10-02; the recorded state of its repository first,
   * Q2) and of the releases of a switch that still run, all within CLOSE_RELEASE_BOUNDS.totalMs. Never rejects. A second
   * call releases nothing more.
   */
  deactivate(): Promise<void> {
    const first = !this.deactivated;
    this.deactivateSync();
    if (!first || !this.started) return Promise.resolve();
    const work = [...this.releases];
    const environmentId = this.currentEnvironmentId;
    if (environmentId !== null) work.push(this.runRelease(environmentId, CLOSE_RELEASE_BOUNDS));
    if (work.length === 0) return Promise.resolve();
    return settledWithin(Promise.all(work), CLOSE_RELEASE_BOUNDS.totalMs);
  }

  dispose(): void {
    this.stopTimer();
    this.heartbeatEmitter.dispose();
  }

  private stopTimer(): void {
    this.stopped = true;
    // A write that started before cannot replace the file anymore.
    this.writeGeneration++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /** Plan step 8, PR C (Q1): the release of `previous` when the window left it for `next`. Not awaited; tracked. */
  private releaseLeft(previous: string | null, next: string | null): void {
    if (previous === null || previous === next) return;
    const running = this.runRelease(previous, SWITCH_RELEASE_BOUNDS);
    this.releases.add(running);
    void running.finally(() => this.releases.delete(running));
  }

  /** The release of `environmentId` within `bounds`. Never rejects. */
  private runRelease(environmentId: string, bounds: ReleaseBounds): Promise<void> {
    const release = this.deps.release;
    if (release === undefined) return Promise.resolve();
    let started: Promise<unknown>;
    try {
      started = release(environmentId, bounds);
    } catch (error) {
      started = Promise.reject(error);
    }
    return settledWithin(
      started.catch((error: unknown) => this.logger.warn(`The release of the environment could not be sent. ${errorMessage(error)}`)),
      bounds.totalMs,
    );
  }

  private heartbeat(): void {
    // A slow file system must not pile up writes.
    if (this.stopped || this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    (async () => {
      try {
        await this.writeStatus();
        if (!this.stopped) {
          // Plan step 8, PR A: never throws; not awaited.
          void this.deps.windowHeartbeats?.tick();
          this.heartbeatEmitter.fire();
        }
      } finally {
        this.heartbeatRunning = false;
      }
    })().catch((error: unknown) => this.logger.error('The window status update failed.', error));
  }

  /** The pending connection file of the environment if it is not older than PENDING_MAX_AGE_MS. Never throws. */
  private async freshPending(environmentId: string | null): Promise<PendingConnection | undefined> {
    if (environmentId === null) return undefined;
    try {
      const pending = (await this.sessionFiles.readPendings()).find((item) => item.environmentId === environmentId);
      const createdAt = pending === undefined ? Number.NaN : Date.parse(pending.createdAt);
      return Number.isFinite(createdAt) && Math.abs(this.clock.now() - createdAt) <= PENDING_MAX_AGE_MS ? pending : undefined;
    } catch (error) {
      this.logger.warn(`The pending connection files could not be read. ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** Writes the status file (`active`); after a successful write, removes the pending file of the environment. */
  private async writeStatus(): Promise<void> {
    const environmentId = this.currentEnvironmentId;
    let written = false;
    try {
      written = await this.writeActiveStatus(environmentId);
    } catch (error) {
      this.logger.warn(`The window status file could not be written. ${errorMessage(error)}`);
    }
    if (!written || environmentId === null || this.stopped) return;
    try {
      await this.sessionFiles.removePending(environmentId);
    } catch (error) {
      this.logger.warn(`The pending connection file could not be removed. ${errorMessage(error)}`);
    }
  }

  /**
   * Atomic write of the status file with the state `active`. The temporary file is written asynchronously, but the check
   * and the rename are synchronous: deactivateSync() runs on the same thread, so it cannot run between them. A write
   * that is overtaken by a newer write, by deactivateSync(), or by dispose() is dropped. Returns true if the file was
   * replaced.
   */
  private async writeActiveStatus(environmentId: string | null): Promise<boolean> {
    if (this.stopped) return false;
    const generation = ++this.writeGeneration;
    const dockerContext = environmentId === null ? undefined : this.deps.windowDockerContext?.();
    const status: WindowStatus = {
      windowId: this.windowId,
      pid: this.pid,
      environmentId,
      state: 'active',
      updatedAt: isoTime(this.clock),
      ...(dockerContext ? { dockerContext } : {}),
    };
    const file = this.paths.sessionFile(this.windowId);
    // The name form of writeJsonAtomic, so that the sweep of the storage folder removes a leftover (storageSweep.ts, R8).
    const temp = atomicTemporaryPath(file);
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await retryTransient(() => fs.promises.writeFile(temp, JSON.stringify(status, null, 2), 'utf8'));
      if (this.stopped || generation !== this.writeGeneration) return false;
      retryTransientSync(() => fs.renameSync(temp, file));
      return true;
    } finally {
      // Normally gone after the rename; left over after a dropped or failed write.
      await fs.promises.rm(temp, { force: true }).catch(() => {});
    }
  }
}
