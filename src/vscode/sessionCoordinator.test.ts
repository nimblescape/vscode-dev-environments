import type { SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../core/ports';
import { StoragePaths } from '../core/storage/paths';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { ExtensionSettings, WindowStatus } from '../core/types';
import { HEARTBEAT_INTERVAL_MS, MONITOR_START_GRACE_MS, SessionCoordinator, type SessionCoordinatorDeps } from './sessionCoordinator';

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
      updatedAt: iso(T0),
    });
    expect(h.spawns).toHaveLength(1);
    // No temporary files are left behind.
    expect(sessionFileNames(h)).toEqual(['window-1.json']);
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
    await h.coordinator.start(null);
    expect(h.spawns).toEqual([]);

    // The monitor process ended: the next check starts a new one.
    h.alive.delete(OTHER_PID);
    await h.coordinator.ensureMonitorRunning();
    expect(h.spawns).toHaveLength(1);
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
