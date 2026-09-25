// Session Coordinator (concept 7.2, 7.9, 7.10): the window side of the stop-on-close mechanism. It writes the window
// status file at activation and every 15 seconds, removes the pending connection file of the connected environment,
// writes monitor.json, starts the Session Monitor process when none runs, and writes `closing` plus the reopen record in
// deactivate().
//
// It needs only types from `vscode` (the event is a small own emitter), so it runs in unit tests without VS Code.
import { spawn, type SpawnOptions } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import { isoTime, systemClock, type Clock, type Logger } from '../core/ports';
import { retryTransient, retryTransientSync, type StoragePaths } from '../core/storage/paths';
import type { SessionFiles } from '../core/storage/sessionFiles';
import type { ExtensionSettings, MonitorSettings, PendingConnection, WindowStatus } from '../core/types';
import { isMonitorRunning, isProcessAlive } from '../monitor/lock';
import { DEFAULT_WAITING_TIME_SECONDS, HEARTBEAT_MAX_AGE_MS, PENDING_MAX_AGE_MS } from '../monitor/rules';

/** Interval of the window status file updates (concept 7.9). */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * A monitor that was started less than this time ago is not started again, although its lock file does not exist yet:
 * the new process needs a moment until it has taken the lock.
 */
export const MONITOR_START_GRACE_MS = 10_000;

/** The part of a child process that the coordinator uses. */
export interface SpawnedProcess {
  unref(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

export interface SessionCoordinatorDeps {
  paths: StoragePaths;
  sessionFiles: SessionFiles;
  logger: Logger;
  /** Absolute path of dist/sessionMonitor.js. */
  monitorScript: string;
  settings: () => ExtensionSettings;
  clock?: Clock;
  // For tests:
  /** Default: `crypto.randomUUID()`. */
  windowId?: string;
  /** Process ID of this extension host. Default: `process.pid`. */
  pid?: number;
  /** Default: `isProcessAlive`. */
  isAlive?: (pid: number) => boolean;
  /** Default: `child_process.spawn`. */
  spawnProcess?: SpawnFunction;
  /** Default: `process.execPath` (the VS Code executable; it runs as Node.js with ELECTRON_RUN_AS_NODE=1). */
  execPath?: string;
  /** Default: HEARTBEAT_INTERVAL_MS. */
  heartbeatMs?: number;
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
  private readonly spawnProcess: SpawnFunction;
  private readonly execPath: string;
  private readonly heartbeatMs: number;
  private readonly heartbeatEmitter: Emitter<void>;

  private currentEnvironmentId: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private heartbeatRunning = false;
  /** Set by deactivateSync() and dispose(): no further asynchronous status writes. */
  private stopped = false;
  private deactivated = false;
  /** Incremented by each status write. Only the newest write may replace the file. */
  private writeGeneration = 0;
  private monitorStartedAt: number | undefined;

  constructor(private readonly deps: SessionCoordinatorDeps) {
    this.paths = deps.paths;
    this.sessionFiles = deps.sessionFiles;
    this.logger = deps.logger;
    this.clock = deps.clock ?? systemClock;
    this.windowId = deps.windowId ?? crypto.randomUUID();
    this.pid = deps.pid ?? process.pid;
    this.isAlive = deps.isAlive ?? isProcessAlive;
    this.spawnProcess = deps.spawnProcess ?? ((command, args, options) => spawn(command, [...args], options));
    this.execPath = deps.execPath ?? process.execPath;
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
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
   * Writes monitor.json and starts the Session Monitor if none runs. A second call works like `setEnvironment`.
   * Never throws: errors are logged, and the next update tries again.
   *
   * Resolves with the pending connection file of the environment that existed before this call removed it, if it is
   * younger than PENDING_MAX_AGE_MS: the open pipeline has just run for this window (it was opened by our own
   * `vscode.openFolder`). The file itself is gone afterwards, so a caller that needs this must use the result.
   */
  async start(environmentId: string | null): Promise<PendingConnection | undefined> {
    if (this.stopped) return undefined;
    this.currentEnvironmentId = environmentId;
    if (this.started) {
      const pending = await this.freshPending(environmentId);
      await this.writeStatus();
      return pending;
    }
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
    await this.writeStatus();
    await this.writeMonitorSettings();
    await this.ensureMonitorRunning();
    return pending;
  }

  /** Changes the environment of this window and writes the status file at once. */
  async setEnvironment(environmentId: string | null): Promise<void> {
    if (this.stopped) return;
    this.currentEnvironmentId = environmentId;
    if (this.started) await this.writeStatus();
  }

  /**
   * Writes the pending connection file of an environment (concept 7.9), so that the Session Monitor does not stop its
   * container while this window connects. Throws if the file cannot be written: the caller relies on the protection.
   */
  async writePending(environmentId: string): Promise<void> {
    await this.sessionFiles.writePending(environmentId, this.windowId);
  }

  /** Writes monitor.json from the settings. Call at start and when the configuration changes. Never throws. */
  async writeMonitorSettings(): Promise<void> {
    try {
      await this.sessionFiles.writeMonitorSettings(this.monitorSettings());
    } catch (error) {
      this.logger.warn(`The settings for the Session Monitor could not be written. ${errorMessage(error)}`);
    }
  }

  /**
   * Starts the Session Monitor when monitor.lock holds no live, fresh process ID (implementation notes 12). Never throws.
   * Called at start, at each status update, and in deactivateSync(): the monitor ends when it has no work, and a
   * window must not stay without one.
   */
  async ensureMonitorRunning(): Promise<void> {
    this.ensureMonitorRunningSync();
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
   * For `deactivate()`: synchronous write of the state `closing`, plus the reopen record when the window is connected
   * (concept 7.9, 7.10). Stops the updates first; an update that is still running cannot replace the file afterwards
   * (see `writeActiveStatus`). Then makes sure that a Session Monitor runs, which stops the container after the
   * waiting time. Never throws.
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
    this.ensureMonitorRunningSync();
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
  }

  private heartbeat(): void {
    // A slow file system must not pile up writes.
    if (this.stopped || this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    (async () => {
      try {
        await this.writeStatus();
        this.ensureMonitorRunningSync();
        if (!this.stopped) this.heartbeatEmitter.fire();
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
    const status: WindowStatus = {
      windowId: this.windowId,
      pid: this.pid,
      environmentId,
      state: 'active',
      updatedAt: isoTime(this.clock),
    };
    const file = this.paths.sessionFile(this.windowId);
    const temp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
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

  private monitorSettings(): MonitorSettings {
    const settings = this.deps.settings();
    const seconds = settings.waitingTimeSeconds;
    return {
      waitingTimeSeconds:
        typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_WAITING_TIME_SECONDS,
      stopOnClose: settings.stopOnClose !== false,
      respectShutdownActionNone: settings.respectShutdownActionNone === true,
      updatedAt: isoTime(this.clock),
    };
  }

  /** Synchronous, for deactivateSync(). Returns true if a monitor process was started. */
  private ensureMonitorRunningSync(): boolean {
    try {
      if (isMonitorRunning(this.paths.monitorLock, this.isAlive)) return false;
      const now = this.clock.now();
      if (this.monitorStartedAt !== undefined && Math.abs(now - this.monitorStartedAt) < MONITOR_START_GRACE_MS) {
        return false;
      }
      this.monitorStartedAt = now;
      this.startMonitor();
      return true;
    } catch (error) {
      this.logger.error('The Session Monitor could not be started.', error);
      return false;
    }
  }

  /** implementation notes 12: detached, without standard streams, with the Node.js runtime of VS Code. */
  private startMonitor(): void {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    // Options for Node.js (for example --inspect of a debugged extension host) must not reach the monitor.
    delete env.NODE_OPTIONS;
    // Assumption (V-3): a detached process keeps running after VS Code quits, on macOS, Windows, and Linux.
    const child = this.spawnProcess(this.execPath, [this.deps.monitorScript, this.paths.root], {
      detached: true,
      stdio: 'ignore',
      env,
      // The monitor must not keep the folder that VS Code was started in busy (Windows), and needs no console window.
      cwd: this.paths.root,
      windowsHide: true,
    });
    child.on('error', (error) => this.logger.error('The Session Monitor could not be started.', error));
    child.unref();
    this.logger.info('Started the Session Monitor.');
  }
}
