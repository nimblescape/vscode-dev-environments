// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../core/ports';
import { StoragePaths } from '../core/storage/paths';
import { SessionFiles } from '../core/storage/sessionFiles';
import { ATOMIC_TEMPORARY_FILE, STALE_PENDING_MAX_AGE_MS } from '../core/storage/storageSweep';
import type { Environment, ExtensionSettings, WindowStatus } from '../core/types';
import { CLOSE_RELEASE_BOUNDS, SWITCH_RELEASE_BOUNDS, type ReleaseBounds } from '../core/session/windowRelease';
import { HEARTBEAT_INTERVAL_MS, SessionCoordinator, type SessionCoordinatorDeps } from './sessionCoordinator';

const ID_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ID_B = '7c1d2e3f-0000-4000-8000-000000000002';
const T0 = Date.parse('2026-09-24T17:00:00.000Z');
const OWN_PID = 4242;
const OTHER_PID = 4343;
const DEAD_PID = 5151;

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
  alive: Set<number>;
  /** Plan step 8, PR C: the releases the coordinator asked for, in order. */
  releases: Array<{ environmentId: string; bounds: ReleaseBounds }>;
  /** Plan step 8, PR C: what the next release does (default: resolves at once). */
  releaseImpl: (environmentId: string, bounds: ReleaseBounds) => Promise<unknown>;
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
  const alive = new Set<number>([OWN_PID, OTHER_PID]);
  const logger = new MemoryLogger();
  const harness = { root, paths, sessionFiles, clock, alive, logger, settings: { ...SETTINGS }, releases: [] } as unknown as Harness;
  harness.releaseImpl = async () => undefined;
  harness.create = (overrides = {}) =>
    new SessionCoordinator({
      paths,
      sessionFiles,
      logger,
      settings: () => harness.settings,
      clock,
      windowId: 'window-1',
      pid: OWN_PID,
      isAlive: (pid) => alive.has(pid),
      release: (environmentId, bounds) => {
        harness.releases.push({ environmentId, bounds });
        return harness.releaseImpl(environmentId, bounds);
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
    const first = new SessionCoordinator({ paths: h.paths, sessionFiles: h.sessionFiles, logger: h.logger, settings: () => SETTINGS });
    const second = new SessionCoordinator({ paths: h.paths, sessionFiles: h.sessionFiles, logger: h.logger, settings: () => SETTINGS });
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

  // Changed expectation, plan step 8 PR C: no monitor.json and no Session Monitor process any more (src/monitor removed).
  it('start writes the active status file and removes the pending file; it writes no monitor.json and starts nothing', async () => {
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
    expect(fs.existsSync(path.join(h.root, 'monitor.json'))).toBe(false);
    expect(fs.existsSync(path.join(h.root, 'monitor.lock'))).toBe(false);
    expect(h.releases).toEqual([]);
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
    // Changed expectation, review round 1 of PR #87, A-R1-1: the first heartbeat goes at once after the first status write.
    expect(ticks).toBe(1);
    await nextHeartbeat(coordinator);
    await nextHeartbeat(coordinator);
    expect(ticks).toBeGreaterThanOrEqual(3);
    coordinator.dispose();
    const after = ticks;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ticks).toBe(after);
    release();
  });

  // Review round 1 of PR #85 (mutant K02): a window that stops during a periodic update sends no more heartbeats.
  // Changed setup, plan step 8 PR C: the window closes during the status write of the update (the hook was the start of
  // the removed local Session Monitor, between the status write and the heartbeats).
  it('does not drive the window heartbeats when the coordinator stops during an update', async () => {
    let ticks = 0;
    let disposeOnWrite = false;
    let writes = 0;
    const coordinator: SessionCoordinator = h.create({
      heartbeatMs: 20,
      windowHeartbeats: {
        tick: async () => {
          ticks += 1;
        },
      },
      windowDockerContext: () => {
        writes += 1;
        // The window closes while this update runs.
        if (disposeOnWrite) coordinator.dispose();
        return undefined;
      },
    });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(ID_A);
    const before = ticks;
    const writesBefore = writes;
    disposeOnWrite = true;
    for (let i = 0; i < 50 && writes === writesBefore; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes).toBeGreaterThan(writesBefore);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ticks).toBe(before);
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

  it('deactivateSync does nothing for a window that never started', () => {
    h.coordinator.deactivateSync();
    expect(fs.existsSync(h.paths.sessionFile('window-1'))).toBe(false);
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

// Plan step 8, PR C (user decision Q1 of 2026-10-02): the window releases the environment it leaves (close, switch).
describe('SessionCoordinator: the release of the environment the window leaves (plan step 8, PR C, Q1)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases the old environment on a switch, with the bounds of a switch, after the new status is written', async () => {
    await h.coordinator.start(ID_A);
    let statusAtRelease: WindowStatus | undefined;
    h.releaseImpl = async () => {
      statusAtRelease = readStatus(h);
    };
    await h.coordinator.setEnvironment(ID_B);
    await vi.waitFor(() => expect(h.releases).toHaveLength(1));
    expect(h.releases[0]).toEqual({ environmentId: ID_A, bounds: SWITCH_RELEASE_BOUNDS });
    expect(statusAtRelease?.environmentId).toBe(ID_B);
  });

  it('releases the old environment when the window leaves it (no environment) and on a second start with another one', async () => {
    await h.coordinator.start(ID_A);
    await h.coordinator.setEnvironment(null);
    await h.coordinator.start(ID_B);
    await h.coordinator.start(ID_A);
    await vi.waitFor(() => expect(h.releases.map((release) => release.environmentId)).toEqual([ID_A, ID_B]));
  });

  it('releases nothing when the environment stays the same, when there was none, or before start', async () => {
    await h.coordinator.setEnvironment(ID_A);
    await h.coordinator.start(ID_A);
    await h.coordinator.setEnvironment(ID_A);
    await h.coordinator.start(ID_A);
    const other = h.create({ windowId: 'window-2' });
    await other.start(null);
    await other.setEnvironment(ID_B);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.releases).toEqual([]);
    other.dispose();
  });

  it('deactivate writes closing synchronously, then releases the connected environment with the bounds of a close', async () => {
    await h.coordinator.start(ID_A);
    let resolveRelease: () => void = () => {};
    let stateAtRelease: string | undefined;
    h.releaseImpl = () => {
      stateAtRelease = readStatus(h)?.state;
      return new Promise<void>((resolve) => (resolveRelease = resolve));
    };
    let done = false;
    const deactivated = h.coordinator.deactivate().then(() => (done = true));
    // Before any await: closing and the reopen record are written.
    expect(readStatus(h)?.state).toBe('closing');
    expect(stateAtRelease).toBe('closing');
    expect(h.releases).toEqual([{ environmentId: ID_A, bounds: CLOSE_RELEASE_BOUNDS }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // deactivate (and so the disposal of the worker channels that waits for it) ends only after the release.
    expect(done).toBe(false);
    resolveRelease();
    await deactivated;
    expect(done).toBe(true);
    expect(await h.sessionFiles.readReopen()).toEqual({ environmentId: ID_A, closedAt: iso(T0) });
  });

  it('deactivate ends after the bound of a close when the release hangs, and a second call releases nothing', async () => {
    await h.coordinator.start(ID_A);
    vi.useFakeTimers();
    h.releaseImpl = () => new Promise(() => {});
    let done = false;
    const deactivated = h.coordinator.deactivate().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(CLOSE_RELEASE_BOUNDS.totalMs - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await deactivated;
    expect(done).toBe(true);
    await h.coordinator.deactivate();
    expect(h.releases).toHaveLength(1);
  });

  it('deactivate tolerates a release that rejects or throws, and logs it', async () => {
    await h.coordinator.start(ID_A);
    h.releaseImpl = () => Promise.reject(new Error('engine gone'));
    await expect(h.coordinator.deactivate()).resolves.toBeUndefined();
    expect(h.logger.lines.some((line) => line.includes('engine gone'))).toBe(true);
    const throwing = h.create({
      windowId: 'window-3',
      release: () => {
        throw new Error('sync failure');
      },
    });
    await throwing.start(ID_B);
    await expect(throwing.deactivate()).resolves.toBeUndefined();
    expect(h.logger.lines.some((line) => line.includes('sync failure'))).toBe(true);
    throwing.dispose();
  });

  it('deactivate waits for the release of a switch that still runs, and releases no environment for a window without one', async () => {
    await h.coordinator.start(ID_A);
    let resolveSwitch: () => void = () => {};
    h.releaseImpl = () => new Promise<void>((resolve) => (resolveSwitch = resolve));
    await h.coordinator.setEnvironment(null);
    await vi.waitFor(() => expect(h.releases).toHaveLength(1));
    let done = false;
    const deactivated = h.coordinator.deactivate().then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    resolveSwitch();
    await deactivated;
    // Only the release of the switch: the window had no environment when it closed.
    expect(h.releases.map((release) => release.environmentId)).toEqual([ID_A]);
  });

  it('deactivate of a window that never started releases nothing', async () => {
    await h.coordinator.deactivate();
    expect(h.releases).toEqual([]);
  });
});

// Plan step 8, PR C: the cleanup of the removed local Session Monitor moves to the window.
describe('SessionCoordinator: the cleanup of the storage folder (plan step 8, PR C)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  const writeStatusFile = (windowId: string, pid: number, at: number, state: WindowStatus['state'] = 'active') =>
    h.sessionFiles.writeWindowStatus({ windowId, pid, environmentId: ID_B, state, updatedAt: iso(at) });

  it('at activation: removes the status files of other windows whose process ended and that are older than 60 s plus the waiting time', async () => {
    fs.mkdirSync(h.paths.sessionsDir, { recursive: true });
    // waitingTimeSeconds is 45 in SETTINGS: the limit is 105 s.
    await writeStatusFile('dead-old', DEAD_PID, T0 - 105_001, 'closing');
    await writeStatusFile('dead-fresh', DEAD_PID, T0 - 105_000, 'closing');
    await writeStatusFile('alive-old', OTHER_PID, T0 - 3_600_000);
    await h.coordinator.start(ID_A);
    expect(sessionFileNames(h)).toEqual(['alive-old.json', 'dead-fresh.json', 'window-1.json']);
    expect(h.logger.lines).toContain('info Removed the status file of the closed window dead-old.');
  });

  it('at activation: sweeps the storage folder (an outdated pending connection file)', async () => {
    h.clock.time = T0 - STALE_PENDING_MAX_AGE_MS - 1;
    await h.sessionFiles.writePending(ID_B, 'window-0');
    h.clock.time = T0;
    await h.coordinator.start(ID_A);
    expect(await h.sessionFiles.readPendings()).toEqual([]);
  });

  it('runs again every interval, and not after the window closed', async () => {
    const coordinator = h.create({ cleanupMs: 20 });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    await coordinator.start(ID_A);
    await writeStatusFile('dead-old', DEAD_PID, T0 - 3_600_000);
    await vi.waitFor(() => expect(sessionFileNames(h)).toEqual(['window-1.json']), { timeout: 2000 });
    coordinator.deactivateSync();
    await writeStatusFile('dead-later', DEAD_PID, T0 - 3_600_000);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sessionFileNames(h)).toContain('dead-later.json');
  });

  it('never throws when the status files cannot be read', async () => {
    fs.mkdirSync(h.root, { recursive: true });
    fs.writeFileSync(h.paths.sessionsDir, 'not a folder');
    await expect(h.coordinator.cleanUpStorage()).resolves.toBeUndefined();
  });
});

// Review round 1 of PR #87: the first heartbeat at once (A-R1-1), the other windows that hold an environment (A-R1-2),
// and the bounds and failures of the close (mutants C07 and C24).
describe('SessionCoordinator: review round 1 of PR #87', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function withTicks(): { ticks: () => number } {
    let ticks = 0;
    const coordinator = h.create({
      heartbeatMs: 60_000,
      windowHeartbeats: {
        tick: async () => {
          ticks += 1;
        },
      },
    });
    h.coordinator.dispose();
    h.coordinator = coordinator;
    return { ticks: () => ticks };
  }

  it('A-R1-1: start sends the first heartbeat right after the first status write, not after the first interval', async () => {
    const counter = withTicks();
    let statusAtTick: WindowStatus | undefined;
    const coordinator = h.create({
      heartbeatMs: 60_000,
      windowHeartbeats: {
        tick: async () => {
          statusAtTick = readStatus(h);
        },
      },
    });
    await coordinator.start(ID_A);
    expect(statusAtTick?.environmentId).toBe(ID_A);
    coordinator.dispose();
    // A window without an environment has nothing to send.
    await h.coordinator.start(null);
    expect(counter.ticks()).toBe(0);
  });

  it('A-R1-1: setEnvironment and a second start to another environment send its heartbeat at once; none for no environment or the same one', async () => {
    const counter = withTicks();
    await h.coordinator.start(ID_A);
    expect(counter.ticks()).toBe(1);
    await h.coordinator.setEnvironment(ID_B);
    expect(counter.ticks()).toBe(2);
    await h.coordinator.setEnvironment(ID_B);
    await h.coordinator.setEnvironment(null);
    expect(counter.ticks()).toBe(2);
    await h.coordinator.start(ID_A);
    expect(counter.ticks()).toBe(3);
    await h.coordinator.start(ID_A);
    expect(counter.ticks()).toBe(3);
    // Not after the window closed.
    h.coordinator.deactivateSync();
    await h.coordinator.setEnvironment(ID_B);
    expect(counter.ticks()).toBe(3);
  });

  it('A-R1-2: otherWindowUses counts a status file, a fresh pending connection file, and a live busy mark of another window', async () => {
    await h.coordinator.start(null);
    const env = (extra: Partial<Environment> = {}): Environment => ({ id: ID_B, repository: 'acme/web', ...extra }) as Environment;
    expect(await h.coordinator.otherWindowUses(env())).toBe(false);
    // A pending connection file of another window.
    await h.sessionFiles.writePending(ID_B, 'window-2');
    expect(await h.coordinator.otherWindowUses(env())).toBe(true);
    await h.sessionFiles.removePending(ID_B);
    // A status file of another live window.
    await h.sessionFiles.writeWindowStatus({ windowId: 'window-2', pid: OTHER_PID, environmentId: ID_B, state: 'active', updatedAt: iso(T0) });
    expect(await h.coordinator.otherWindowUses(env())).toBe(true);
    // A live busy mark of another window (its status file names another environment).
    await h.sessionFiles.writeWindowStatus({ windowId: 'window-2', pid: OTHER_PID, environmentId: null, state: 'active', updatedAt: iso(T0) });
    expect(await h.coordinator.otherWindowUses(env())).toBe(false);
    expect(await h.coordinator.otherWindowUses(env({ busy: { operation: 'rebuild', since: iso(T0), pid: OTHER_PID, windowId: 'window-2' } }))).toBe(true);
    // Not a busy mark of this window.
    expect(await h.coordinator.otherWindowUses(env({ busy: { operation: 'rebuild', since: iso(T0), pid: OWN_PID, windowId: 'window-1' } }))).toBe(false);
  });

  it('A-R1-2: otherWindowUses says yes when the files cannot be read (nothing is released), and logs it', async () => {
    await h.coordinator.start(null);
    h.sessionFiles.readPendings = async () => {
      throw new Error('pending unreadable');
    };
    expect(await h.coordinator.otherWindowUses({ id: ID_B, repository: 'acme/web' } as Environment)).toBe(true);
    expect(h.logger.lines.some((line) => line.startsWith('warn') && line.includes('pending unreadable'))).toBe(true);
  });

  // B-R1-3 (mutant C07): the bound of a close holds also for a switch release that still runs (its own bound is longer).
  it('B-R1-3: deactivate ends after the bound of a close also while the release of a switch hangs', async () => {
    await h.coordinator.start(ID_A);
    h.releaseImpl = () => new Promise(() => {});
    await h.coordinator.setEnvironment(ID_B);
    await vi.waitFor(() => expect(h.releases).toHaveLength(1));
    vi.useFakeTimers();
    let done = false;
    const deactivated = h.coordinator.deactivate().then(() => (done = true));
    expect(h.releases.map((release) => release.bounds)).toEqual([SWITCH_RELEASE_BOUNDS, CLOSE_RELEASE_BOUNDS]);
    await vi.advanceTimersByTimeAsync(CLOSE_RELEASE_BOUNDS.totalMs - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await deactivated;
    expect(done).toBe(true);
    expect(CLOSE_RELEASE_BOUNDS.totalMs).toBeLessThan(SWITCH_RELEASE_BOUNDS.totalMs);
  });

  // B-R1-5 (mutant C24): a failed sweep is logged, start() still resolves, and the status files are still cleaned up.
  it('B-R1-5: a failed sweep of the storage folder does not reject start(); it is logged and the status cleanup still runs', async () => {
    fs.mkdirSync(h.paths.sessionsDir, { recursive: true });
    await h.sessionFiles.writeWindowStatus({ windowId: 'dead-old', pid: DEAD_PID, environmentId: ID_B, state: 'closing', updatedAt: iso(T0 - 3_600_000) });
    Object.defineProperty(h.paths, 'disconnectDir', {
      get: () => {
        throw new Error('sweep broken');
      },
    });
    await expect(h.coordinator.start(ID_A)).resolves.toBeUndefined();
    expect(h.logger.lines).toContain('warn The storage folder could not be cleaned up. sweep broken');
    expect(sessionFileNames(h)).toEqual(['window-1.json']);
  });
});
