// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import type { SpawnOptions } from 'child_process';
import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../core/ports';
import { StoragePaths } from '../core/storage/paths';
import { SessionFiles } from '../core/storage/sessionFiles';
import { ATOMIC_TEMPORARY_FILE } from '../core/storage/storageSweep';
import type { ExtensionSettings, WindowStatus } from '../core/types';
import { MONITOR_PROTOCOL_VERSION } from '../monitor/lock';
import { HEARTBEAT_INTERVAL_MS, MONITOR_START_GRACE_MS, SessionCoordinator, type SessionCoordinatorDeps } from './sessionCoordinator';

// Versions reset to 1 (user decision 2026-09-27), 2 since review round 3 of PR #58, 3 since review round 1 of PR #85
// (A-R1-1). To test the retirement of an older monitor, a test sets the protocol version of the window to a future
// version 4 (`windowVersion.value`); the
// protocol version of the monitor module stays the real one otherwise.
const windowVersion = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock('../monitor/lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../monitor/lock')>();
  return {
    ...actual,
    get MONITOR_PROTOCOL_VERSION(): number {
      return windowVersion.value ?? actual.MONITOR_PROTOCOL_VERSION;
    },
  };
});

const ID_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ID_B = '7c1d2e3f-0000-4000-8000-000000000002';
const T0 = Date.parse('2026-09-24T17:00:00.000Z');
const OWN_PID = 4242;
const OTHER_PID = 4343;
const DEAD_PID = 5151;
const SCRIPT = '/ext/dist/sessionMonitor.js';
const EXEC_PATH = '/Applications/Code.app/Contents/Frameworks/Code Helper (Plugin)';

const iso = (ms: number): string => new Date(ms).toISOString();

const SETTINGS: ExtensionSettings = {
  reopenLastOnStartup: true,
  stopOnClose: true,
  waitingTimeSeconds: 45,
  updateImagesOnConnect: true,
  respectShutdownActionNone: false,
  owners: [],
  includeArchived: false,
  includeForks: true,
  refreshIntervalMinutes: 60,
  hostAccessChecksOff: [],
};

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

class MemoryLogger implements Logger {
  lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
  output(): void {}
}

interface Harness {
  root: string;
  paths: StoragePaths;
  sessionFiles: SessionFiles;
  clock: { time: number; now(): number };
  spawns: SpawnCall[];
  alive: Set<number>;
  logger: MemoryLogger;
  settings: ExtensionSettings;
  coordinator: SessionCoordinator;
  create(overrides?: Partial<SessionCoordinatorDeps>): SessionCoordinator;
}

let harnesses: Harness[] = [];

function createHarness(): Harness {
  // A sub-folder that does not exist yet: start() creates it.
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-')), 'storage');
  const paths = new StoragePaths(root);
  const clock = {
    time: T0,
    now(): number {
      return this.time;
    },
  };
  const sessionFiles = new SessionFiles(paths, clock);
  const spawns: SpawnCall[] = [];
  const alive = new Set<number>([OWN_PID, OTHER_PID]);
  const logger = new MemoryLogger();
  const harness = { root, paths, sessionFiles, clock, spawns, alive, logger, settings: { ...SETTINGS } } as Harness;
  harness.create = (overrides = {}) =>
    new SessionCoordinator({
      paths,
      sessionFiles,
      logger,
      monitorScript: SCRIPT,
      settings: () => harness.settings,
      clock,
      windowId: 'window-1',
      pid: OWN_PID,
      isAlive: (pid) => alive.has(pid),
      execPath: EXEC_PATH,
      spawnProcess: (command, args, options) => {
        spawns.push({ command, args, options });
        return { unref: () => {}, on: () => undefined };
      },
      ...overrides,
    });
  harness.coordinator = harness.create();
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses) {
    harness.coordinator.dispose();
    fs.rmSync(path.dirname(harness.root), { recursive: true, force: true });
  }
  harnesses = [];
});

function readStatus(h: Harness, windowId = 'window-1'): WindowStatus | undefined {
  try {
    return JSON.parse(fs.readFileSync(h.paths.sessionFile(windowId), 'utf8')) as WindowStatus;
  } catch {
    return undefined;
  }
}

function nextHeartbeat(coordinator: SessionCoordinator): Promise<void> {
  return new Promise((resolve) => {
    const subscription = coordinator.onDidHeartbeat(() => {
      subscription.dispose();
      resolve();
    });
  });
}

function sessionFileNames(h: Harness): string[] {
  return fs.readdirSync(h.paths.sessionsDir).sort();
}

describe('SessionCoordinator', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('has a random UUID as window ID by default', () => {
    const first = new SessionCoordinator({ paths: h.paths, sessionFiles: h.sessionFiles, logger: h.logger, monitorScript: SCRIPT, settings: () => SETTINGS });
    const second = new SessionCoordinator({ paths: h.paths, sessionFiles: h.sessionFiles, logger: h.logger, monitorScript: SCRIPT, settings: () => SETTINGS });
    expect(first.windowId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.windowId).not.toBe(second.windowId);
    first.dispose();
    second.dispose();
  });

  // Review round 10 of PR #63 (B-R10-1): the status file is written under the name form of atomicTemporaryPath, in the
  // sessions folder, so that the sweep of the storage folder (storageSweep.ts, R8) removes a leftover.
  it('writes the status file through a temporary file that the sweep of the storage folder recognises', async () => {
    // The namespace of the ES module `fs` cannot be spied on; its CommonJS exports can, and syncBuiltinESMExports
    // passes the spy on to the namespace that sessionCoordinator.ts reads.
    const spy = vi.spyOn(createRequire(import.meta.url)('fs') as typeof fs, 'renameSync');
    syncBuiltinESMExports();
    try {
      await h.coordinator.start(ID_A);
      const file = h.paths.sessionFile('window-1');
      const writes = spy.mock.calls.filter(([, target]) => target === file);
      expect(writes.length).toBeGreaterThan(0);
      for (const [temporary] of writes) {
        expect(path.dirname(String(temporary))).toBe(h.paths.sessionsDir);
        expect(path.basename(String(temporary))).toMatch(ATOMIC_TEMPORARY_FILE);
        expect(path.basename(String(temporary)).startsWith(`.window-1.json.${process.pid}.`)).toBe(true);
      }
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('start writes the active status file, removes the pending file, writes monitor.json, and starts the monitor', async () => {
    await h.sessionFiles.writePending(ID_A, 'window-0');
    await h.coordinator.start(ID_A);
    expect(h.coordinator.environmentId).toBe(ID_A);
    expect(readStatus(h)).toEqual({
      windowId: 'window-1',
      pid: OWN_PID,
      environmentId: ID_A,
      state: 'active',
      updatedAt: iso(T0),
    });
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    expect(await h.sessionFiles.readMonitorSettings()).toEqual({
      waitingTimeSeconds: 45,
      stopOnClose: true,
      respectShutdownActionNone: false,
      // Unit 7, PR 2: the time limit of the heartbeats to a remote Session Monitor (the default of 10 minutes).
      // Changed expectation, review round 2 of PR #85, A-R2-3: written again until plan step 8, PR C, for a monitor of
      // version 2 (the setting stopAfterMinutes, default 10 minutes).
      remoteStopAfterSeconds: 600,
      updatedAt: iso(T0),
    });
    expect(h.spawns).toHaveLength(1);
    // No temporary files are left behind.
    expect(sessionFileNames(h)).toEqual(['window-1.json']);
  });

  // Review of the attach context (A2): the status file names the Docker context of the window's authority.
  it('writes the Docker context of the window into its status file, only for a window with an environment', async () => {
    h.coordinator.dispose();
    h.coordinator = h.create({ windowDockerContext: () => 'devenv-remote-5709ff28' });
    await h.coordinator.start(ID_A);
    expect(readStatus(h)).toMatchObject({ environmentId: ID_A, dockerContext: 'devenv-remote-5709ff28' });
    h.coordinator.dispose();
    h.coordinator = h.create({ windowDockerContext: () => 'devenv-remote-5709ff28' });
    await h.coordinator.start(null);
    expect(readStatus(h)).not.toHaveProperty('dockerContext');
  });

  it('start resolves with the fresh pending file of its environment that it removes, so the caller knows the pipeline ran', async () => {
    await h.sessionFiles.writePending(ID_A, 'window-0');
    expect(await h.coordinator.start(ID_A)).toEqual({ environmentId: ID_A, windowId: 'window-0', createdAt: iso(T0) });
    expect(await h.sessionFiles.readPendings()).toEqual([]);
    // A later call finds nothing.
    expect(await h.coordinator.start(ID_A)).toBeUndefined();
  });

  it('start resolves with nothing for a stale pending file, another environment, or no environment', async () => {
    h.clock.time = T0 - 120_001;
    await h.sessionFiles.writePending(ID_A, 'window-0');
    h.clock.time = T0;
    await h.sessionFiles.writePending(ID_B, 'window-0');
    expect(await h.coordinator.start(ID_A)).toBeUndefined();
    expect((await h.sessionFiles.readPendings()).map((pending) => pending.environmentId)).toEqual([ID_B]);
    const other = h.create({ windowId: 'window-2' });
    expect(await other.start(null)).toBeUndefined();
    other.dispose();
  });

  it('keeps the pending files of other environments', async () => {
    await h.sessionFiles.writePending(ID_B, 'window-0');
    await h.coordinator.start(ID_A);
    expect((await h.sessionFiles.readPendings()).map((pending) => pending.environmentId)).toEqual([ID_B]);
    await h.coordinator.start(null);
    expect(readStatus(h)?.environmentId).toBeNull();
    expect((await h.sessionFiles.readPendings()).map((pending) => pending.environmentId)).toEqual([ID_B]);
  });

  it('starts the monitor detached with the VS Code executable as Node.js and the storage folder', async () => {
    await h.coordinator.start(null);
    const [call] = h.spawns;
    expect(call.command).toBe(EXEC_PATH);
    expect(call.args).toEqual([SCRIPT, h.root]);
    expect(call.options).toMatchObject({ detached: true, stdio: 'ignore', cwd: h.root, windowsHide: true });
    expect(call.options.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(call.options.env?.NODE_OPTIONS).toBeUndefined();
    expect(call.options.env?.PATH).toBe(process.env.PATH);
  });

  it('does not start a monitor while monitor.lock holds a live and fresh process ID', async () => {
    fs.mkdirSync(h.root, { recursive: true });
    fs.writeFileSync(h.paths.monitorLock, `${OTHER_PID}\n`);
    // A monitor of the current version (review finding F2 of PR #26: an older one is asked to exit, see below).
    fs.writeFileSync(path.join(h.root, 'monitor.version'), JSON.stringify({ pid: OTHER_PID, version: MONITOR_PROTOCOL_VERSION }));
    await h.coordinator.start(null);
    expect(h.spawns).toEqual([]);

    // The monitor process ended: the next check starts a new one.
    h.alive.delete(OTHER_PID);
    await h.coordinator.ensureMonitorRunning();
    expect(h.spawns).toHaveLength(1);
  });

  // A Session Monitor of an older protocol version may decide wrongly with the files of a newer window. A window asks it
  // to exit and starts the current monitor, which waits for it (monitor protocol version, monitor.version next to
  // monitor.lock). It never sends a signal (round-2 review of PR #26): a monitor without a version is left alone.
  // The window runs as a future version, the older monitor is of the current version.
  describe('a monitor of an older version', () => {
    // Review round 3 of PR #58 (F1): the current version is 2, so the future window is 3 and the older monitor is 2.
    // Changed expectation, review round 1 of PR #85, A-R1-1: the current version is 3, so the future window is 4 and
    // the older monitor is 3.
    const FUTURE_VERSION = 4;
    const OLDER_VERSION = 3;
    beforeEach(() => {
      windowVersion.value = FUTURE_VERSION;
    });
    afterEach(() => {
      windowVersion.value = undefined;
    });
    const versionFile = (): string => path.join(h.root, 'monitor.version');
    const exitFile = (): string => path.join(h.root, 'monitor.exit');
    const writeLock = (ageMs: number): void => {
      fs.mkdirSync(h.root, { recursive: true });
      fs.writeFileSync(h.paths.monitorLock, `${OTHER_PID}\n`);
      const time = new Date(Date.now() - ageMs);
      fs.utimesSync(h.paths.monitorLock, time, time);
    };
    const exitRequestPid = (): number | undefined => {
      try {
        return (JSON.parse(fs.readFileSync(exitFile(), 'utf8')) as { pid: number }).pid;
      } catch {
        return undefined;
      }
    };

    it('asks a monitor of an older version through the control file, and starts the current one', async () => {
      expect(MONITOR_PROTOCOL_VERSION).toBe(FUTURE_VERSION);
      writeLock(3_000);
      fs.writeFileSync(versionFile(), JSON.stringify({ pid: OTHER_PID, version: OLDER_VERSION }));
      await h.coordinator.start(null);
      expect(exitRequestPid()).toBe(OTHER_PID);
      expect(h.spawns).toHaveLength(1);
      expect(h.logger.lines.join('\n')).toContain(
        // Review round 3 of PR #58 (F1): the versions of the fixture moved up by one.
        `Asked the Session Monitor (process ${OTHER_PID}) to exit: it has protocol version ${OLDER_VERSION}, older than ${FUTURE_VERSION}.`,
      );
    });

    // Review round 1 of PR #85, A-R1-1: a live monitor of version 2 (before plan step 8, PR A) reads monitor.json without
    // remoteStopAfterSeconds and would stop kept environments with its defaults; a window of the real current version
    // (3) asks it to exit and starts its own.
    it('retires a live monitor of version 2 from a window of the current version 3', async () => {
      windowVersion.value = undefined;
      expect(MONITOR_PROTOCOL_VERSION).toBe(3);
      writeLock(3_000);
      fs.writeFileSync(versionFile(), JSON.stringify({ pid: OTHER_PID, version: 2 }));
      await h.coordinator.start(null);
      expect(exitRequestPid()).toBe(OTHER_PID);
      expect(h.spawns).toHaveLength(1);
      expect(h.logger.lines.join('\n')).toContain(`Asked the Session Monitor (process ${OTHER_PID}) to exit: it has protocol version 2, older than 3.`);
    });

    it('leaves a monitor of the current version alone', async () => {
      writeLock(3_000);
      fs.writeFileSync(versionFile(), JSON.stringify({ pid: OTHER_PID, version: MONITOR_PROTOCOL_VERSION }));
      await h.coordinator.start(null);
      expect(exitRequestPid()).toBeUndefined();
      expect(h.spawns).toEqual([]);
    });

    it('leaves a monitor of the current version alone while the window is of that version too', async () => {
      windowVersion.value = undefined;
      expect(MONITOR_PROTOCOL_VERSION).toBe(OLDER_VERSION);
      writeLock(3_000);
      fs.writeFileSync(versionFile(), JSON.stringify({ pid: OTHER_PID, version: OLDER_VERSION }));
      await h.coordinator.start(null);
      expect(exitRequestPid()).toBeUndefined();
      expect(h.spawns).toEqual([]);
    });

    it('leaves a monitor without a version alone, also when the version file names another process ID', async () => {
      writeLock(3_000);
      await h.coordinator.start(null);
      expect(exitRequestPid()).toBeUndefined();
      expect(h.spawns).toEqual([]);
      fs.writeFileSync(versionFile(), JSON.stringify({ pid: OTHER_PID + 1, version: OLDER_VERSION }));
      await h.coordinator.ensureMonitorRunning();
      expect(exitRequestPid()).toBeUndefined();
      expect(h.spawns).toEqual([]);
    });

    // Round-2 review finding 3 of PR #26: a version file that cannot be read (on Windows for example while a virus
    // scanner holds it) is an unknown version, never an older one. The window does nothing this time.
    it('does nothing this time when the version file cannot be read', async () => {
      writeLock(3_000);
      fs.mkdirSync(versionFile());
      await h.coordinator.start(null);
      expect(exitRequestPid()).toBeUndefined();
      expect(h.spawns).toEqual([]);
      // Once it can be read again, an older monitor is asked to exit.
      fs.rmdirSync(versionFile());
      fs.writeFileSync(versionFile(), JSON.stringify({ pid: OTHER_PID, version: OLDER_VERSION }));
      await h.coordinator.ensureMonitorRunning();
      expect(exitRequestPid()).toBe(OTHER_PID);
      expect(h.spawns).toHaveLength(1);
    });
  });

  it('does not start a second monitor while the first one is still starting', async () => {
    await h.coordinator.start(null);
    await h.coordinator.ensureMonitorRunning();
    expect(h.spawns).toHaveLength(1);
    h.clock.time += MONITOR_START_GRACE_MS;
    await h.coordinator.ensureMonitorRunning();
    expect(h.spawns).toHaveLength(2);
  });

  it('logs a failed start of the monitor and does not throw', async () => {
    const coordinator = h.create({
      spawnProcess: () => {
        throw new Error('spawn EACCES');
      },
    });
    await expect(coordinator.start(null)).resolves.toBeUndefined();
    expect(h.logger.lines).toContain('error The Session Monitor could not be started.');
    coordinator.dispose();
  });

  it('writes a valid default waiting time for an invalid setting', async () => {
    h.settings = { ...SETTINGS, waitingTimeSeconds: Number.NaN, stopOnClose: false, respectShutdownActionNone: true };
    await h.coordinator.writeMonitorSettings();
    expect(await h.sessionFiles.readMonitorSettings()).toMatchObject({
      waitingTimeSeconds: 30,
      stopOnClose: false,
      respectShutdownActionNone: true,
    });
  });

  // Review round 2 of PR #85, A-R2-3: a monitor of version 2 (main before plan step 8, PR A) requires
  // remoteStopAfterSeconds in monitor.json; without it, it decides with its defaults and stops kept environments.
  it('writes remoteStopAfterSeconds from stopAfterMinutes, so a monitor of version 2 reads valid settings', async () => {
    /** isMonitorSettings of main (the format that a monitor of version 2 reads), copied as it is there. */
    const isMainMonitorSettings = (value: unknown): boolean => {
      if (typeof value !== 'object' || value === null) return false;
      const v = value as Record<string, unknown>;
      return (
        typeof v.waitingTimeSeconds === 'number' &&
        Number.isFinite(v.waitingTimeSeconds) &&
        v.waitingTimeSeconds >= 0 &&
        typeof v.stopOnClose === 'boolean' &&
        typeof v.respectShutdownActionNone === 'boolean' &&
        typeof v.remoteStopAfterSeconds === 'number' &&
        Number.isFinite(v.remoteStopAfterSeconds) &&
        v.remoteStopAfterSeconds > 0 &&
        typeof v.updatedAt === 'string' &&
        Number.isFinite(Date.parse(v.updatedAt))
      );
    };
    h.settings = { ...SETTINGS, stopOnClose: false, stopAfterMinutes: 7 };
    await h.coordinator.writeMonitorSettings();
    const written: unknown = JSON.parse(fs.readFileSync(h.paths.monitorSettings, 'utf8'));
    expect(written).toMatchObject({ stopOnClose: false, remoteStopAfterSeconds: 420 });
    expect(isMainMonitorSettings(written)).toBe(true);
    // This version reads it too (the field is ignored).
    expect(await h.sessionFiles.readMonitorSettings()).toMatchObject({ remoteStopAfterSeconds: 420 });
  });

  it('updates the status file periodically, removes the pending file each time, and fires onDidHeartbeat', async () => {
    const coordinator = h.create({ heartbeatMs: 20 });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(ID_A);
    h.clock.time = T0 + HEARTBEAT_INTERVAL_MS;
    await h.sessionFiles.writePending(ID_A, 'window-1');
    await nextHeartbeat(coordinator);
    expect(readStatus(h)?.updatedAt).toBe(iso(T0 + HEARTBEAT_INTERVAL_MS));
    expect(await h.sessionFiles.readPendings()).toEqual([]);
  });

  // Plan step 8, PR A: the window's tick drives its heartbeats to the Session Monitor container (not awaited).
  it('drives the window heartbeats at each periodic update, and not after dispose', async () => {
    let ticks = 0;
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const coordinator = h.create({
      heartbeatMs: 20,
      windowHeartbeats: {
        tick: () => {
          ticks += 1;
          // A heartbeat that hangs does not hold the status updates back.
          return blocked;
        },
      },
    });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(ID_A);
    expect(ticks).toBe(0);
    await nextHeartbeat(coordinator);
    await nextHeartbeat(coordinator);
    expect(ticks).toBeGreaterThanOrEqual(2);
    coordinator.dispose();
    const after = ticks;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ticks).toBe(after);
    release();
  });

  // Review round 1 of PR #85 (mutant K02): a window that stops during a periodic update sends no more heartbeats.
  it('does not drive the window heartbeats when the coordinator stops during an update', async () => {
    let ticks = 0;
    let disposeOnSpawn = false;
    let spawned = 0;
    const coordinator: SessionCoordinator = h.create({
      heartbeatMs: 20,
      windowHeartbeats: {
        tick: async () => {
          ticks += 1;
        },
      },
      spawnProcess: () => {
        spawned += 1;
        // The window closes while this update runs (between the status write and the heartbeats).
        if (disposeOnSpawn) coordinator.dispose();
        return { unref: () => {}, on: () => undefined };
      },
    });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(ID_A);
    const before = ticks;
    const spawnedBefore = spawned;
    disposeOnSpawn = true;
    h.clock.time += MONITOR_START_GRACE_MS;
    for (let i = 0; i < 50 && spawned === spawnedBefore; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spawned).toBeGreaterThan(spawnedBefore);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ticks).toBe(before);
  });

  it('checks at each update that a monitor runs', async () => {
    const coordinator = h.create({ heartbeatMs: 20 });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(null);
    expect(h.spawns).toHaveLength(1);
    h.clock.time += MONITOR_START_GRACE_MS;
    await nextHeartbeat(coordinator);
    expect(h.spawns).toHaveLength(2);
  });

  it('setEnvironment writes the status file at once', async () => {
    await h.coordinator.start(null);
    await h.coordinator.setEnvironment(ID_B);
    expect(readStatus(h)?.environmentId).toBe(ID_B);
    expect(h.coordinator.environmentId).toBe(ID_B);
  });

  it('a newer status write wins over an older one that is still running', async () => {
    await h.coordinator.start(null);
    const first = h.coordinator.setEnvironment(ID_A);
    const second = h.coordinator.setEnvironment(ID_B);
    await Promise.all([first, second]);
    expect(readStatus(h)?.environmentId).toBe(ID_B);
    expect(sessionFileNames(h)).toEqual(['window-1.json']);
  });

  it('writePending writes the pending file with this window ID', async () => {
    await h.coordinator.writePending(ID_A);
    const [pending] = await h.sessionFiles.readPendings();
    expect(pending).toEqual({ environmentId: ID_A, windowId: 'window-1', createdAt: iso(T0) });
  });

  it('deactivateSync writes closing and the reopen record when the window is connected', async () => {
    await h.coordinator.start(ID_A);
    h.clock.time = T0 + 5000;
    h.coordinator.deactivateSync();
    expect(readStatus(h)).toEqual({
      windowId: 'window-1',
      pid: OWN_PID,
      environmentId: ID_A,
      state: 'closing',
      updatedAt: iso(T0 + 5000),
    });
    expect(await h.sessionFiles.readReopen()).toEqual({ environmentId: ID_A, closedAt: iso(T0 + 5000) });
  });

  it('deactivateSync writes no reopen record for a window without an environment', async () => {
    await h.coordinator.start(null);
    h.coordinator.deactivateSync();
    expect(readStatus(h)?.state).toBe('closing');
    expect(await h.sessionFiles.readReopen()).toBeUndefined();
  });

  it('deactivateSync makes sure that a monitor runs, so that the container stops after the waiting time', async () => {
    await h.coordinator.start(ID_A);
    h.clock.time += MONITOR_START_GRACE_MS;
    h.coordinator.deactivateSync();
    expect(h.spawns).toHaveLength(2);
  });

  it('deactivateSync does nothing for a window that never started', () => {
    h.coordinator.deactivateSync();
    expect(fs.existsSync(h.paths.sessionFile('window-1'))).toBe(false);
    expect(h.spawns).toEqual([]);
  });

  it('deactivateSync is not overtaken by a status write that is still running', async () => {
    // Different moments of the running write: before the temporary file exists, while it is written, and after.
    for (let delayTurns = 0; delayTurns < 12; delayTurns++) {
      const harness = createHarness();
      await harness.coordinator.start(ID_A);
      const running = harness.coordinator.setEnvironment(ID_A);
      for (let turn = 0; turn < delayTurns; turn++) await new Promise((resolve) => setImmediate(resolve));
      harness.coordinator.deactivateSync();
      await running;
      // Give any leftover asynchronous work the chance to run.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readStatus(harness)?.state).toBe('closing');
      expect(sessionFileNames(harness)).toEqual(['window-1.json']);
    }
  });

  it('deactivateSync stops the periodic updates', async () => {
    const coordinator = h.create({ heartbeatMs: 10 });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    let beats = 0;
    coordinator.onDidHeartbeat(() => beats++);
    await coordinator.start(ID_A);
    coordinator.deactivateSync();
    const before = beats;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(beats).toBe(before);
    expect(readStatus(h)?.state).toBe('closing');
  });

  it('deactivateSync still writes closing after dispose()', async () => {
    await h.coordinator.start(ID_A);
    h.coordinator.dispose();
    h.coordinator.deactivateSync();
    expect(readStatus(h)?.state).toBe('closing');
  });

  it('start and setEnvironment after deactivateSync do not write active again', async () => {
    await h.coordinator.start(ID_A);
    h.coordinator.deactivateSync();
    await h.coordinator.setEnvironment(ID_B);
    await h.coordinator.start(ID_B);
    expect(readStatus(h)).toMatchObject({ state: 'closing', environmentId: ID_A });
  });

  it('otherActiveWindows lists only other windows that are alive, active, and updated within 60 seconds', async () => {
    await h.coordinator.start(ID_A);
    const write = (windowId: string, pid: number, state: WindowStatus['state'], at: number) =>
      h.sessionFiles.writeWindowStatus({ windowId, pid, environmentId: ID_B, state, updatedAt: iso(at) });
    await write('other-ok', OTHER_PID, 'active', T0 - 60_000);
    await write('other-dead', DEAD_PID, 'active', T0);
    await write('other-closing', OTHER_PID, 'closing', T0);
    await write('other-old', OTHER_PID, 'active', T0 - 60_001);
    await write('other-future', OTHER_PID, 'active', T0 + 120_000);
    const windows = await h.coordinator.otherActiveWindows();
    expect(windows.map((window) => window.windowId)).toEqual(['other-ok']);
  });

  it('a failing heartbeat listener does not stop the others', async () => {
    const coordinator = h.create({ heartbeatMs: 10 });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    coordinator.onDidHeartbeat(() => {
      throw new Error('listener failed');
    });
    const disposables: Array<{ dispose(): unknown }> = [];
    let calls = 0;
    const receiver = { count(): void { calls++; } };
    coordinator.onDidHeartbeat(receiver.count, receiver, disposables);
    expect(disposables).toHaveLength(1);
    await coordinator.start(null);
    await nextHeartbeat(coordinator);
    expect(calls).toBeGreaterThan(0);
    disposables[0].dispose();
    const before = calls;
    await nextHeartbeat(coordinator);
    expect(calls).toBe(before);
    expect(h.logger.lines).toContain('error A listener of the window heartbeat failed.');
  });

  it('logs a failed status write and does not throw', async () => {
    fs.mkdirSync(h.root, { recursive: true });
    // A file where the sessions folder should be.
    fs.writeFileSync(h.paths.sessionsDir, 'not a folder');
    await expect(h.coordinator.start(ID_A)).resolves.toBeUndefined();
    expect(h.logger.lines.some((line) => line.startsWith('warn The window status file could not be written.'))).toBe(true);
  });
});
