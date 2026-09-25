import { describe, expect, it } from 'vitest';
import type { MonitorSettings, PendingConnection, WindowStatus } from '../core/types';
import {
  computeInUse,
  containerStatesNeeded,
  decide,
  DEFAULT_WAITING_TIME_SECONDS,
  DOCKER_UNKNOWN_MAX_MS,
  HEARTBEAT_MAX_AGE_MS,
  initialMonitorState,
  PENDING_MAX_AGE_MS,
  SLEEP_GAP_MS,
  SLEEP_GRACE_MS,
  sleepGraceAt,
  STOPPED_RECHECK_MS,
  TICK_MS,
  waitingTimeMs,
  type DecideInput,
  type MonitorDecision,
  type MonitorEnvironment,
  type MonitorState,
  type MonitorWindow,
} from './rules';

const T0 = Date.parse('2026-09-24T17:00:00.000Z');
/** Windows write their status file every 15 seconds (concept 7.9). */
const WINDOW_UPDATE_MS = 15_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function settings(overrides: Partial<MonitorSettings> = {}): MonitorSettings {
  return {
    waitingTimeSeconds: 30,
    stopOnClose: true,
    respectShutdownActionNone: false,
    updatedAt: iso(T0),
    ...overrides,
  };
}

function env(id: string, overrides: Partial<MonitorEnvironment> = {}): MonitorEnvironment {
  return { id, busy: false, shutdownActionNone: false, ...overrides };
}

function win(
  windowId: string,
  environmentId: string | null,
  updatedAt: number,
  overrides: { state?: WindowStatus['state']; alive?: boolean; pid?: number } = {},
): MonitorWindow {
  return {
    status: {
      windowId,
      pid: overrides.pid ?? 1000,
      environmentId,
      state: overrides.state ?? 'active',
      updatedAt: iso(updatedAt),
    },
    alive: overrides.alive ?? true,
  };
}

function pending(environmentId: string, createdAt: number): PendingConnection {
  return { environmentId, windowId: 'w-pending', createdAt: iso(createdAt) };
}

/** A state as if the monitor has been ticking regularly until `lastTickAt` (no sleep grace). */
function runningState(lastTickAt: number, overrides: Partial<MonitorState> = {}): MonitorState {
  return { ...initialMonitorState(), lastTickAt, ...overrides };
}

interface SimWindow {
  status: WindowStatus;
  alive: boolean;
  /** Time of the next update of the status file; undefined: the window does not write anymore. */
  nextUpdate: number | undefined;
}

/**
 * Simulates the Session Monitor process and the windows around it: one tick every TICK_MS, windows update their
 * status file every 15 seconds, stops take effect at once, removed window files disappear. Docker is asked only for
 * the environments of containerStatesNeeded(), as the real monitor does.
 */
class Sim {
  now = T0;
  state: MonitorState = initialMonitorState();
  settings = settings();
  readonly environments = new Map<string, MonitorEnvironment>();
  readonly windows = new Map<string, SimWindow>();
  readonly pendings = new Map<string, PendingConnection>();
  /** Environments whose container runs. */
  readonly containers = new Set<string>();
  dockerUp = true;
  /** Pass the state of every container, not only the needed ones (a caller that ignores containerStatesNeeded). */
  reportAllContainers = false;
  /** Simulates a `docker stop` that fails. */
  stopFails = false;
  readonly stops: Array<{ id: string; at: number }> = [];
  readonly dockerQueries: number[] = [];
  readonly removedWindowFiles: Array<{ id: string; at: number }> = [];
  exitAt: number | undefined;
  last: MonitorDecision | undefined;
  private nextPid = 40_000;
  private nextTick = T0;

  environment(id: string, options: Partial<Omit<MonitorEnvironment, 'id'>> & { running?: boolean } = {}): this {
    const { running = true, ...rest } = options;
    this.environments.set(id, env(id, rest));
    if (running) this.containers.add(id);
    return this;
  }

  /** A window activates (or connects) and writes its status file. */
  openWindow(windowId: string, environmentId: string | null): this {
    this.windows.set(windowId, {
      status: { windowId, pid: this.nextPid++, environmentId, state: 'active', updatedAt: iso(this.now) },
      alive: true,
      nextUpdate: this.now + WINDOW_UPDATE_MS,
    });
    return this;
  }

  /** deactivate(): the state changes to `closing` with a synchronous write. */
  closeWindow(windowId: string): this {
    const window = this.window(windowId);
    window.status = { ...window.status, state: 'closing', updatedAt: iso(this.now) };
    window.nextUpdate = undefined;
    return this;
  }

  /** The extension host process ends (close, quit, crash, reload). */
  endProcess(windowId: string): this {
    const window = this.window(windowId);
    window.alive = false;
    window.nextUpdate = undefined;
    return this;
  }

  /** The extension host hangs: the process exists, but it does not write its file anymore. */
  hang(windowId: string): this {
    this.window(windowId).nextUpdate = undefined;
    return this;
  }

  removeWindowFile(windowId: string): this {
    this.windows.delete(windowId);
    return this;
  }

  /** The open pipeline writes the pending connection file before it opens the folder URI. */
  writePending(environmentId: string, windowId = 'w-any'): this {
    this.pendings.set(environmentId, { environmentId, windowId, createdAt: iso(this.now) });
    return this;
  }

  removePending(environmentId: string): this {
    this.pendings.delete(environmentId);
    return this;
  }

  tick(): MonitorDecision {
    const input = {
      now: this.now,
      environments: [...this.environments.values()],
      windows: [...this.windows.values()].map((window) => ({ status: { ...window.status }, alive: window.alive })),
      pendings: [...this.pendings.values()],
      state: this.state,
      settings: this.settings,
    };
    const needed = containerStatesNeeded(input);
    let running: Set<string> | undefined;
    if (needed.length > 0 || this.reportAllContainers) {
      this.dockerQueries.push(this.now);
      if (this.dockerUp) {
        const asked = this.reportAllContainers ? [...this.environments.keys()] : needed;
        running = new Set(asked.filter((id) => this.containers.has(id)));
      }
    } else {
      running = new Set();
    }
    const decision = decide({ ...input, running });
    this.state = decision.state;
    for (const id of decision.stop) {
      this.stops.push({ id, at: this.now });
      if (!this.stopFails) this.containers.delete(id);
    }
    for (const id of decision.removeWindowFiles) {
      this.windows.delete(id);
      this.removedWindowFiles.push({ id, at: this.now });
    }
    if (decision.exit && this.exitAt === undefined) this.exitAt = this.now;
    this.last = decision;
    return decision;
  }

  /** Lets `ms` pass: windows update their files every 15 s, and the monitor ticks every TICK_MS on a fixed grid. */
  run(ms: number): this {
    const end = this.now + ms;
    while (this.nextTick <= end) {
      this.now = this.nextTick;
      this.updateWindows();
      this.tick();
      this.nextTick = this.now + TICK_MS;
    }
    this.now = end;
    this.updateWindows();
    return this;
  }

  /** The monitor starts (first tick) and runs until its start-up grace has ended. */
  start(): this {
    this.tick();
    this.nextTick = this.now + TICK_MS;
    return this.run(SLEEP_GRACE_MS);
  }

  /** The computer sleeps: no tick, no window update. After wake, the monitor ticks at once, the windows later. */
  sleep(ms: number, windowsWriteAfterMs = 10_000): this {
    this.now += ms;
    for (const window of this.windows.values()) {
      if (window.nextUpdate !== undefined) window.nextUpdate = this.now + windowsWriteAfterMs;
    }
    this.tick();
    this.nextTick = this.now + TICK_MS;
    return this;
  }

  stopTimes(id: string): number[] {
    return this.stops.filter((stop) => stop.id === id).map((stop) => stop.at);
  }

  private updateWindows(): void {
    for (const window of this.windows.values()) {
      while (window.nextUpdate !== undefined && window.nextUpdate <= this.now) {
        window.status = { ...window.status, updatedAt: iso(window.nextUpdate) };
        window.nextUpdate += WINDOW_UPDATE_MS;
      }
    }
  }

  private window(windowId: string): SimWindow {
    const window = this.windows.get(windowId);
    if (!window) throw new Error(`No window ${windowId}`);
    return window;
  }
}

/** The environment was stopped exactly once, one waiting time after `from` (plus at most one tick). */
function expectStoppedOnceAfterWaitingTime(sim: Sim, id: string, from: number, waitingMs = 30_000): void {
  const times = sim.stopTimes(id);
  expect(times).toHaveLength(1);
  expect(times[0]).toBeGreaterThanOrEqual(from + waitingMs);
  expect(times[0]).toBeLessThanOrEqual(from + waitingMs + TICK_MS);
}

describe('computeInUse (rule 1)', () => {
  const now = T0 + 10 * 60_000;
  const base = { now, pendings: [], state: runningState(now - TICK_MS) };

  it('counts an active window with a live process and a fresh file', () => {
    const result = computeInUse({ ...base, environments: [env('A'), env('B')], windows: [win('w1', 'A', now - 1000)] });
    expect([...result.inUse]).toEqual(['A']);
  });

  it('accepts updatedAt up to exactly HEARTBEAT_MAX_AGE_MS old', () => {
    const at = (age: number) =>
      computeInUse({ ...base, environments: [env('A')], windows: [win('w1', 'A', now - age)] }).inUse.has('A');
    expect(at(HEARTBEAT_MAX_AGE_MS)).toBe(true);
    expect(at(HEARTBEAT_MAX_AGE_MS + 1)).toBe(false);
  });

  it('never counts a window in the state closing', () => {
    const windows = [win('w1', 'A', now, { state: 'closing' })];
    expect(computeInUse({ ...base, environments: [env('A')], windows }).inUse.size).toBe(0);
    // Also not during the sleep grace.
    const afterSleep = computeInUse({ ...base, state: runningState(now - 3_600_000), environments: [env('A')], windows });
    expect(afterSleep.state.sleepGraceUntil).toBe(now + SLEEP_GRACE_MS);
    expect(afterSleep.inUse.size).toBe(0);
  });

  it('does not count a window whose process ended', () => {
    const windows = [win('w1', 'A', now, { alive: false })];
    expect(computeInUse({ ...base, environments: [env('A')], windows }).inUse.size).toBe(0);
  });

  it('does not count an invalid updatedAt', () => {
    const window = win('w1', 'A', now);
    window.status.updatedAt = 'not a time';
    expect(computeInUse({ ...base, environments: [env('A')], windows: [window] }).inUse.size).toBe(0);
  });

  it('does not count a file far in the future (clock set back), but a slightly newer one', () => {
    const at = (updatedAt: number) =>
      computeInUse({ ...base, environments: [env('A')], windows: [win('w1', 'A', updatedAt)] }).inUse.has('A');
    expect(at(now + 2000)).toBe(true);
    expect(at(now + HEARTBEAT_MAX_AGE_MS + 1)).toBe(false);
  });

  it('ignores windows without an environment and references to unknown environments', () => {
    const windows = [win('w1', null, now), win('w2', 'X', now)];
    const pendings = [pending('Y', now)];
    const result = computeInUse({ ...base, environments: [env('A')], windows, pendings });
    expect(result.inUse.size).toBe(0);
  });

  it('counts a pending connection file up to exactly PENDING_MAX_AGE_MS old', () => {
    const at = (age: number) =>
      computeInUse({ ...base, environments: [env('A')], windows: [], pendings: [pending('A', now - age)] }).inUse.has('A');
    expect(at(0)).toBe(true);
    expect(at(PENDING_MAX_AGE_MS)).toBe(true);
    expect(at(PENDING_MAX_AGE_MS + 1)).toBe(false);
  });

  it('counts a busy environment', () => {
    const result = computeInUse({ ...base, environments: [env('A', { busy: true }), env('B')], windows: [] });
    expect([...result.inUse]).toEqual(['A']);
  });

  it('sets lastTickAt and does not change the input state', () => {
    const state = runningState(now - TICK_MS, { idleSince: { A: now - 1000 } });
    const copy = structuredClone(state);
    const result = computeInUse({ ...base, state, environments: [env('A')], windows: [] });
    expect(result.state.lastTickAt).toBe(now);
    expect(result.state.idleSince).toEqual({ A: now - 1000 });
    expect(state).toEqual(copy);
  });
});

describe('sleep rule', () => {
  const now = T0 + 3_600_000;
  const staleWindow = win('w1', 'A', now - 10 * 60_000);

  it('after a gap larger than SLEEP_GAP_MS, counts active live windows whatever the age of updatedAt', () => {
    const result = computeInUse({
      now,
      environments: [env('A')],
      windows: [staleWindow],
      pendings: [],
      state: runningState(now - SLEEP_GAP_MS - 1),
    });
    expect(result.state.sleepGraceUntil).toBe(now + SLEEP_GRACE_MS);
    expect(result.inUse.has('A')).toBe(true);
  });

  it('does not start the grace for a gap of exactly SLEEP_GAP_MS', () => {
    const result = computeInUse({
      now,
      environments: [env('A')],
      windows: [staleWindow],
      pendings: [],
      state: runningState(now - SLEEP_GAP_MS),
    });
    expect(result.state.sleepGraceUntil).toBeUndefined();
    expect(result.inUse.has('A')).toBe(false);
  });

  it('does not extend the grace to pending connection files or dead processes', () => {
    const result = computeInUse({
      now,
      environments: [env('A'), env('B')],
      windows: [win('w1', 'A', now - 10 * 60_000, { alive: false })],
      pendings: [pending('B', now - PENDING_MAX_AGE_MS - 1)],
      state: runningState(now - 3_600_000),
    });
    expect(result.inUse.size).toBe(0);
  });

  it('ends the grace SLEEP_GRACE_MS after the gap', () => {
    let state = runningState(now - 3_600_000);
    const input = { environments: [env('A')], windows: [staleWindow], pendings: [] };
    state = computeInUse({ ...input, now, state }).state;
    let t = now;
    while (t + TICK_MS < now + SLEEP_GRACE_MS) {
      t += TICK_MS;
      const result = computeInUse({ ...input, now: t, state });
      expect(result.inUse.has('A')).toBe(true);
      state = result.state;
    }
    const after = computeInUse({ ...input, now: now + SLEEP_GRACE_MS, state });
    expect(after.inUse.has('A')).toBe(false);
    expect(after.state.sleepGraceUntil).toBeUndefined();
  });

  it('starts the grace at the first tick of a monitor that just started', () => {
    const result = computeInUse({ now, environments: [env('A')], windows: [staleWindow], pendings: [], state: initialMonitorState() });
    expect(result.state.sleepGraceUntil).toBe(now + SLEEP_GRACE_MS);
    expect(result.inUse.has('A')).toBe(true);
  });

  it('treats a clock that was set back like a gap, and restarts waiting times that lie in the future', () => {
    const later = now + 3_600_000;
    const state = runningState(later, { idleSince: { A: later - 10_000 }, deadWindowSince: { w9: later } });
    const decision = decide({
      now,
      environments: [env('A')],
      windows: [win('w9', null, now, { alive: false })],
      pendings: [],
      state,
      settings: settings(),
      running: new Set(['A']),
    });
    expect(decision.state.sleepGraceUntil).toBe(now + SLEEP_GRACE_MS);
    expect(decision.state.idleSince).toEqual({ A: now });
    expect(decision.state.deadWindowSince).toEqual({ w9: now });
    expect(decision.stop).toEqual([]);
  });

  it('sleepGraceAt tells whether computeInUse ignores the age of updatedAt in the same tick', () => {
    const input = { environments: [env('A')], windows: [staleWindow], pendings: [] };
    const states = [
      initialMonitorState(),
      runningState(now - SLEEP_GAP_MS - 1),
      runningState(now - SLEEP_GAP_MS),
      runningState(now - TICK_MS, { sleepGraceUntil: now + 1 }),
      runningState(now - TICK_MS, { sleepGraceUntil: now }),
      runningState(now + 3_600_000),
    ];
    const graces = states.map((state) => sleepGraceAt(state, now));
    expect(graces).toEqual([true, true, false, true, false, true]);
    for (const [index, state] of states.entries()) {
      expect(computeInUse({ ...input, now, state }).inUse.has('A')).toBe(graces[index]);
    }
  });

  it('gives the same decision with the previous state and with the state of computeInUse', () => {
    const input = {
      now,
      environments: [env('A'), env('B')],
      windows: [staleWindow],
      pendings: [],
      settings: settings(),
      running: new Set(['A', 'B']),
    };
    const previous = runningState(now - 3_600_000, { idleSince: { B: now - 60_000 } });
    const fromPrevious = decide({ ...input, state: previous });
    const fromInUse = decide({ ...input, state: computeInUse({ ...input, state: previous }).state });
    expect(fromInUse).toEqual(fromPrevious);
    expect(fromPrevious.stop).toEqual(['B']);
  });
});

describe('results for typical situations (concept 7.9)', () => {
  it('window closed, or VS Code quit: state closing, process ended → stop after the waiting time', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    expect(sim.stops).toEqual([]);
    const closedAt = sim.now;
    sim.closeWindow('w1');
    sim.run(1000);
    sim.endProcess('w1');
    sim.run(25_000);
    expect(sim.stops).toEqual([]);
    expect(sim.last?.exit).toBe(false);
    sim.run(10_000);
    expectStoppedOnceAfterWaitingTime(sim, 'A', closedAt);
    expect(sim.containers.has('A')).toBe(false);
    sim.run(30_000);
    // The status file of the ended process is removed, and the monitor ends.
    expect(sim.windows.size).toBe(0);
    expect(sim.exitAt).toBeDefined();
    expect(sim.stopTimes('A')).toHaveLength(1);
  });

  it('switch to another environment in the same window: the old one stops after the waiting time, the new one not', () => {
    const sim = new Sim().environment('A').environment('B', { running: false }).openWindow('w1', 'A').start();
    // The open pipeline starts B and writes the pending connection file; the window stays connected to A meanwhile.
    sim.containers.add('B');
    sim.writePending('B', 'w1');
    sim.run(20_000);
    // vscode.openFolder: the extension host of the window restarts and connects to B.
    const switchedAt = sim.now;
    sim.closeWindow('w1').endProcess('w1');
    sim.run(3000);
    sim.openWindow('w2', 'B').removePending('B');
    sim.run(120_000);
    expectStoppedOnceAfterWaitingTime(sim, 'A', switchedAt);
    expect(sim.stopTimes('B')).toEqual([]);
    expect(sim.containers.has('B')).toBe(true);
  });

  it('switch: the new environment is kept by its pending file while the window is not connected yet', () => {
    const sim = new Sim().environment('A').environment('B', { running: false }).openWindow('w1', 'A').start();
    sim.containers.add('B');
    sim.writePending('B', 'w1');
    sim.closeWindow('w1').endProcess('w1');
    // The connection takes long, but less than the life time of the pending file.
    sim.run(PENDING_MAX_AGE_MS - TICK_MS);
    expect(sim.stopTimes('B')).toEqual([]);
    expect(sim.stopTimes('A')).toHaveLength(1);
  });

  it('window reload shorter than the waiting time → no stop, and the waiting time starts from zero next time', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    sim.closeWindow('w1');
    sim.run(2000);
    sim.endProcess('w1');
    sim.run(18_000);
    expect(sim.state.idleSince.A).toBeDefined();
    // The reloaded window has a new window ID and a new process.
    sim.openWindow('w2', 'A');
    sim.run(TICK_MS);
    expect(sim.state.idleSince.A).toBeUndefined();
    sim.run(5 * 60_000);
    expect(sim.stops).toEqual([]);
    expect(sim.windows.has('w1')).toBe(false);
    expect(sim.windows.has('w2')).toBe(true);
  });

  it('window reload where the old status file is removed at once → no stop', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    sim.removeWindowFile('w1');
    sim.run(25_000);
    sim.openWindow('w2', 'A');
    sim.run(5 * 60_000);
    expect(sim.stops).toEqual([]);
  });

  it('window reload longer than the waiting time → stop (the waiting time must cover a reload, V-4)', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    const closedAt = sim.now;
    sim.closeWindow('w1').endProcess('w1');
    sim.run(40_000);
    sim.openWindow('w2', 'A');
    sim.run(60_000);
    expectStoppedOnceAfterWaitingTime(sim, 'A', closedAt);
  });

  it('VS Code crash or forced termination: process ended, no closing state → stop after the waiting time', () => {
    const sim = new Sim().environment('A').environment('B').openWindow('w1', 'A').openWindow('w2', 'B').start();
    const crashedAt = sim.now;
    sim.endProcess('w1').endProcess('w2');
    sim.run(2 * 60_000);
    expectStoppedOnceAfterWaitingTime(sim, 'A', crashedAt);
    expectStoppedOnceAfterWaitingTime(sim, 'B', crashedAt);
    expect(sim.windows.size).toBe(0);
    expect(sim.exitAt).toBeDefined();
  });

  it('extension host does not respond: updatedAt older than 60 seconds → stop after the waiting time', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    sim.hang('w1');
    const lastUpdate = Date.parse(sim.windows.get('w1')!.status.updatedAt);
    sim.run(3 * 60_000);
    const [stoppedAt] = sim.stopTimes('A');
    expect(sim.stopTimes('A')).toHaveLength(1);
    // Not in use from the first tick with an age above 60 s, then the waiting time.
    expect(stoppedAt).toBeGreaterThan(lastUpdate + HEARTBEAT_MAX_AGE_MS + 30_000);
    expect(stoppedAt).toBeLessThanOrEqual(lastUpdate + HEARTBEAT_MAX_AGE_MS + 30_000 + 2 * TICK_MS);
  });

  it('computer sleep: after wake all updatedAt values are old → no stop', () => {
    const sim = new Sim().environment('A').environment('B').openWindow('w1', 'A').openWindow('w2', 'B').start();
    sim.run(60_000);
    sim.sleep(8 * 3_600_000, 20_000);
    expect(sim.last?.inUse).toEqual(new Set(['A', 'B']));
    sim.run(10 * 60_000);
    expect(sim.stops).toEqual([]);
    expect(sim.removedWindowFiles).toEqual([]);
    expect(sim.state.idleSince).toEqual({});
  });

  it('computer sleep: a window that does not write again within the grace stops after grace and waiting time', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    sim.hang('w1');
    sim.sleep(3_600_000);
    const wokeAt = sim.now;
    sim.run(SLEEP_GRACE_MS - TICK_MS);
    expect(sim.stops).toEqual([]);
    sim.run(2 * 60_000);
    expectStoppedOnceAfterWaitingTime(sim, 'A', wokeAt + SLEEP_GRACE_MS);
  });

  it('computer sleep: an environment that was already unused before the sleep still stops', () => {
    const sim = new Sim().environment('A').environment('B').openWindow('w1', 'A').openWindow('w2', 'B').start();
    sim.closeWindow('w2').endProcess('w2');
    sim.run(10_000);
    sim.sleep(3_600_000);
    // Its waiting time ran out during the sleep: B stops at the first tick after wake. A keeps running.
    expect(sim.stopTimes('B')).toEqual([sim.now]);
    sim.run(5 * 60_000);
    expect(sim.stopTimes('A')).toEqual([]);
  });

  it('computer shutdown or Docker restart: Docker stops all containers → nothing to stop, the next connection starts them', () => {
    const sim = new Sim().environment('A').environment('B').openWindow('w1', 'A').openWindow('w2', 'B').start();
    // B runs without a window and is waiting; then Docker stops, and with it all containers.
    sim.closeWindow('w2').endProcess('w2');
    sim.run(10_000);
    expect(sim.state.idleSince.B).toBeDefined();
    sim.dockerUp = false;
    sim.containers.clear();
    sim.run(DOCKER_UNKNOWN_MAX_MS + TICK_MS);
    expect(sim.stops).toEqual([]);
    expect(sim.state.idleSince).toEqual({});
    // Docker runs again (restart), the containers stay stopped.
    sim.dockerUp = true;
    sim.run(5 * 60_000);
    expect(sim.stops).toEqual([]);
    // The next connection starts A: pending connection file, then the window writes its status file.
    sim.writePending('A', 'w1');
    sim.containers.add('A');
    sim.run(10_000);
    sim.openWindow('w1b', 'A').removePending('A');
    sim.run(5 * 60_000);
    expect(sim.stops).toEqual([]);
  });

  it('computer shutdown: at the next start, stale files of ended processes are removed and nothing is stopped', () => {
    const sim = new Sim().environment('A', { running: false }).environment('B', { running: false });
    sim.openWindow('old1', 'A').openWindow('old2', 'B').endProcess('old1').endProcess('old2');
    sim.now += 12 * 3_600_000;
    sim.openWindow('w1', null);
    sim.start();
    expect(sim.stops).toEqual([]);
    expect(sim.windows.has('old1')).toBe(false);
    expect(sim.windows.has('old2')).toBe(false);
    expect(sim.windows.has('w1')).toBe(true);
  });

  it('update, rebuild, or delete in progress: environment busy → no stop', () => {
    const sim = new Sim().environment('A', { busy: true }).start();
    sim.run(10 * 60_000);
    expect(sim.stops).toEqual([]);
    expect(sim.last?.inUse.has('A')).toBe(true);
    expect(sim.last?.exit).toBe(false);
    // The operation ends and no window connects.
    const doneAt = sim.now;
    sim.environments.set('A', env('A', { busy: false }));
    sim.run(60_000);
    expectStoppedOnceAfterWaitingTime(sim, 'A', doneAt);
  });
});

describe('rule 2 details', () => {
  it('uses the waiting time of the settings', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A');
    sim.settings = settings({ waitingTimeSeconds: 10 });
    sim.start();
    const closedAt = sim.now;
    sim.closeWindow('w1').endProcess('w1');
    sim.run(60_000);
    expectStoppedOnceAfterWaitingTime(sim, 'A', closedAt, 10_000);
  });

  it('stops at the first tick with a waiting time of 0', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A');
    sim.settings = settings({ waitingTimeSeconds: 0 });
    sim.start();
    const closedAt = sim.now;
    sim.closeWindow('w1').endProcess('w1');
    sim.run(TICK_MS);
    expect(sim.stopTimes('A')).toEqual([closedAt + TICK_MS]);
  });

  it('uses the default waiting time for an invalid value', () => {
    expect(waitingTimeMs({ waitingTimeSeconds: 12.5 })).toBe(12_500);
    expect(waitingTimeMs({ waitingTimeSeconds: 0 })).toBe(0);
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '30' as unknown as number, undefined as unknown as number]) {
      expect(waitingTimeMs({ waitingTimeSeconds: value })).toBe(DEFAULT_WAITING_TIME_SECONDS * 1000);
    }
  });

  it('resets the waiting time when the environment is in use again', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    sim.closeWindow('w1').endProcess('w1');
    sim.run(25_000);
    sim.writePending('A');
    sim.run(TICK_MS);
    expect(sim.state.idleSince.A).toBeUndefined();
    const releasedAt = sim.now;
    sim.removePending('A');
    // 25 s + 25 s would pass the waiting time if the first 25 s still counted.
    sim.run(25_000);
    expect(sim.stops).toEqual([]);
    sim.run(15_000);
    expectStoppedOnceAfterWaitingTime(sim, 'A', releasedAt);
  });

  it('never stops with stopOnClose = false, and never asks Docker', () => {
    const sim = new Sim().environment('A').environment('B').openWindow('w1', 'A');
    sim.settings = settings({ stopOnClose: false });
    sim.start();
    sim.closeWindow('w1').endProcess('w1');
    sim.run(10 * 60_000);
    expect(sim.stops).toEqual([]);
    expect(sim.dockerQueries).toEqual([]);
    expect(sim.state.idleSince).toEqual({});
    expect(sim.exitAt).toBeDefined();
  });

  it('respects "shutdownAction": "none" only with respectShutdownActionNone', () => {
    const run = (respect: boolean) => {
      const sim = new Sim().environment('A', { shutdownActionNone: true }).environment('B');
      sim.settings = settings({ respectShutdownActionNone: respect });
      sim.start();
      return sim;
    };
    const respected = run(true);
    expect(respected.stopTimes('A')).toEqual([]);
    expect(respected.stopTimes('B')).toHaveLength(1);
    const ignored = run(false);
    expect(ignored.stopTimes('A')).toHaveLength(1);
    expect(ignored.stopTimes('B')).toHaveLength(1);
  });

  it('stops an environment with a busy mark of an ended process (passed as busy = false)', () => {
    const sim = new Sim().environment('A', { busy: false }).start();
    // start() runs 60 s: the first tick starts the waiting time, so the stop comes after 30 s.
    expectStoppedOnceAfterWaitingTime(sim, 'A', T0);
  });

  it('stops after the pending connection file expired, when no window connected', () => {
    const sim = new Sim().environment('A').start();
    expect(sim.stopTimes('A')).toHaveLength(1);
    // The pipeline starts A again, but the window never connects.
    sim.containers.add('A');
    const writtenAt = sim.now;
    sim.writePending('A');
    sim.run(PENDING_MAX_AGE_MS);
    expect(sim.stopTimes('A')).toHaveLength(1);
    sim.run(60_000);
    const times = sim.stopTimes('A');
    expect(times).toHaveLength(2);
    expect(times[1]).toBeGreaterThan(writtenAt + PENDING_MAX_AGE_MS + 30_000 - TICK_MS);
    expect(times[1]).toBeLessThanOrEqual(writtenAt + PENDING_MAX_AGE_MS + 30_000 + TICK_MS);
  });

  it('repeats a failed stop in the next tick', () => {
    const sim = new Sim().environment('A');
    sim.stopFails = true;
    sim.start();
    const first = sim.stopTimes('A')[0];
    expect(sim.stopTimes('A').slice(0, 3)).toEqual([first, first + TICK_MS, first + 2 * TICK_MS]);
    expect(sim.last?.exit).toBe(false);
    sim.stopFails = false;
    sim.run(2 * TICK_MS);
    expect(sim.containers.has('A')).toBe(false);
    expect(sim.state.idleSince).toEqual({});
  });

  it('forgets the waiting time when the container stops in another way (action Stop)', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    sim.closeWindow('w1').endProcess('w1');
    sim.run(10_000);
    expect(sim.state.idleSince.A).toBeDefined();
    sim.containers.delete('A');
    sim.run(TICK_MS);
    expect(sim.state.idleSince).toEqual({});
    sim.run(60_000);
    expect(sim.stops).toEqual([]);
  });

  it('stops only environments of the registry, and forgets removed environments', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    sim.containers.add('not-in-registry');
    sim.closeWindow('w1').endProcess('w1');
    sim.run(10_000);
    // Delete removes the registry entry during the waiting time.
    sim.environments.delete('A');
    sim.run(60_000);
    expect(sim.stops).toEqual([]);
    expect(sim.state.idleSince).toEqual({});
    expect(sim.state.stoppedConfirmedAt).toEqual({});
  });

  it('accepts a state with only the fields of the contract', () => {
    const state = { lastTickAt: T0 - TICK_MS, idleSince: { A: T0 - 60_000 }, deadWindowSince: {} } as unknown as MonitorState;
    const input = { now: T0, environments: [env('A')], windows: [], pendings: [], state, settings: settings() };
    expect(containerStatesNeeded(input)).toEqual(['A']);
    const decision = decide({ ...input, running: new Set(['A']) });
    expect(decision.stop).toEqual(['A']);
    expect(decision.state.stoppedConfirmedAt).toEqual({});
  });

  it('does not change the input state', () => {
    const state = runningState(T0 - TICK_MS, { idleSince: { A: T0 - 60_000 }, deadWindowSince: { w1: T0 - 60_000 } });
    const copy = structuredClone(state);
    const decision = decide({
      now: T0,
      environments: [env('A')],
      windows: [win('w1', 'A', T0 - 60_000, { alive: false })],
      pendings: [],
      state,
      settings: settings(),
      running: new Set(['A']),
    });
    expect(decision.stop).toEqual(['A']);
    expect(decision.removeWindowFiles).toEqual(['w1']);
    expect(decision.state.lastTickAt).toBe(T0);
    expect(state).toEqual(copy);
  });
});

describe('Docker does not answer', () => {
  it('keeps a running waiting time through a short failure, and does not end the monitor', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    const closedAt = sim.now;
    sim.closeWindow('w1').endProcess('w1');
    sim.run(20_000);
    sim.dockerUp = false;
    sim.run(10_000);
    expect(sim.stops).toEqual([]);
    expect(sim.state.idleSince.A).toBeDefined();
    expect(sim.exitAt).toBeUndefined();
    sim.dockerUp = true;
    sim.run(TICK_MS);
    // The waiting time was not restarted by the failure.
    expectStoppedOnceAfterWaitingTime(sim, 'A', closedAt, 30_000 + 5000);
  });

  it('does not end the monitor while the first query after the last window fails', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    sim.dockerUp = false;
    sim.closeWindow('w1').endProcess('w1');
    sim.run(DOCKER_UNKNOWN_MAX_MS - TICK_MS);
    expect(sim.exitAt).toBeUndefined();
    sim.dockerUp = true;
    sim.run(60_000);
    expect(sim.stopTimes('A')).toHaveLength(1);
  });

  it('counts Docker as not running after DOCKER_UNKNOWN_MAX_MS: nothing runs, the monitor can end', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    sim.closeWindow('w1').endProcess('w1');
    sim.run(10_000);
    sim.dockerUp = false;
    sim.containers.clear();
    const failedAt = sim.now + TICK_MS;
    sim.run(DOCKER_UNKNOWN_MAX_MS + 2 * TICK_MS);
    expect(sim.stops).toEqual([]);
    expect(sim.state.idleSince).toEqual({});
    expect(sim.exitAt).toBeGreaterThanOrEqual(failedAt + DOCKER_UNKNOWN_MAX_MS);
  });
});

describe('Docker Desktop Resource Saver', () => {
  it('does not call Docker while every environment is in use or known to be stopped', () => {
    const sim = new Sim().environment('A').environment('B', { running: false }).environment('C', { running: false });
    sim.openWindow('w1', 'A').openWindow('w2', null).start();
    const queriesAtStart = sim.dockerQueries.length;
    expect(queriesAtStart).toBe(1);
    sim.run(STOPPED_RECHECK_MS - 2 * 60_000);
    expect(sim.dockerQueries).toHaveLength(queriesAtStart);
    // A is closed: Docker is asked until its container is stopped and confirmed.
    sim.closeWindow('w1').endProcess('w1');
    sim.run(60_000);
    expect(sim.stopTimes('A')).toHaveLength(1);
    const queriesAfterStop = sim.dockerQueries.length;
    sim.run(STOPPED_RECHECK_MS - 2 * 60_000);
    expect(sim.dockerQueries).toHaveLength(queriesAfterStop);
  });

  it('asks Docker again after STOPPED_RECHECK_MS and stops a container that was started without a window', () => {
    const sim = new Sim().environment('A', { running: false }).openWindow('w1', null).start();
    const firstQuery = sim.dockerQueries[0];
    // Started outside of the extension, for example with `docker start`.
    sim.containers.add('A');
    sim.run(STOPPED_RECHECK_MS + 60_000);
    expect(sim.dockerQueries[1]).toBe(firstQuery + STOPPED_RECHECK_MS);
    expectStoppedOnceAfterWaitingTime(sim, 'A', firstQuery + STOPPED_RECHECK_MS);
  });

  it('asks Docker again when a known stopped environment was in use', () => {
    const sim = new Sim().environment('A', { running: false }).openWindow('w1', null).start();
    const queries = sim.dockerQueries.length;
    sim.writePending('A', 'w1');
    sim.containers.add('A');
    sim.run(10_000);
    expect(sim.dockerQueries).toHaveLength(queries);
    const releasedAt = sim.now;
    sim.removePending('A');
    sim.run(60_000);
    expect(sim.dockerQueries.length).toBeGreaterThan(queries);
    expectStoppedOnceAfterWaitingTime(sim, 'A', releasedAt);
  });

  it('lists only unused environments that may be stopped', () => {
    const now = T0 + 60_000;
    const needed = containerStatesNeeded({
      now,
      environments: [
        env('used'),
        env('busy', { busy: true }),
        env('pending'),
        env('none', { shutdownActionNone: true }),
        env('stopped'),
        env('stale-check'),
        env('idle'),
      ],
      windows: [win('w1', 'used', now)],
      pendings: [pending('pending', now)],
      state: runningState(now - TICK_MS, {
        stoppedConfirmedAt: { stopped: now - 1000, 'stale-check': now - STOPPED_RECHECK_MS },
      }),
      settings: settings({ respectShutdownActionNone: true }),
    });
    expect(needed).toEqual(['stale-check', 'idle']);
  });

  it('honors a caller that reports all containers, also known stopped ones', () => {
    const sim = new Sim().environment('A', { running: false }).openWindow('w1', null).start();
    sim.reportAllContainers = true;
    sim.containers.add('A');
    const startedAt = sim.now;
    sim.run(60_000);
    expectStoppedOnceAfterWaitingTime(sim, 'A', startedAt + TICK_MS);
  });

  it('checks known stopped containers again when the last window closes, and does not end while one runs', () => {
    const sim = new Sim().environment('A', { running: false }).openWindow('w1', null).start();
    // The open pipeline failed after `devcontainer up` and before the pending connection file: A runs, nobody uses it.
    sim.containers.add('A');
    sim.run(60_000);
    expect(sim.stops).toEqual([]);
    const queries = sim.dockerQueries.length;
    sim.closeWindow('w1').endProcess('w1');
    sim.run(TICK_MS);
    expect(sim.dockerQueries.length).toBeGreaterThan(queries);
    expect(sim.exitAt).toBeUndefined();
    sim.run(60_000);
    const [stoppedAt] = sim.stopTimes('A');
    expect(sim.stopTimes('A')).toHaveLength(1);
    expect(sim.containers.has('A')).toBe(false);
    expect(sim.exitAt).toBeGreaterThan(stoppedAt);
  });

  it('asks Docker once before it ends when all containers are known to be stopped', () => {
    const sim = new Sim().environment('A', { running: false }).openWindow('w1', null).start();
    const queries = sim.dockerQueries.length;
    sim.closeWindow('w1').endProcess('w1');
    sim.run(TICK_MS);
    expect(sim.dockerQueries).toHaveLength(queries + 1);
    expect(sim.exitAt).toBe(sim.now);
    expect(sim.stops).toEqual([]);
  });

  it('stops asking Docker when it does not run', () => {
    const sim = new Sim().environment('A', { running: false }).openWindow('w1', null);
    sim.dockerUp = false;
    sim.start();
    sim.run(DOCKER_UNKNOWN_MAX_MS + TICK_MS);
    const queries = sim.dockerQueries.length;
    sim.run(STOPPED_RECHECK_MS - 2 * 60_000);
    expect(sim.dockerQueries).toHaveLength(queries);
  });
});

describe('window status files', () => {
  it('removes the file of an ended process after the waiting time, not before', () => {
    const sim = new Sim().openWindow('w1', null).openWindow('w2', null).start();
    const endedAt = sim.now;
    sim.endProcess('w1');
    sim.run(25_000);
    expect(sim.windows.has('w1')).toBe(true);
    sim.run(10_000);
    expect(sim.removedWindowFiles).toEqual([{ id: 'w1', at: endedAt + TICK_MS + 30_000 }]);
    sim.run(TICK_MS);
    expect(sim.state.deadWindowSince).toEqual({});
  });

  it('forgets the time of death when the process is seen alive again', () => {
    const state = runningState(T0 - TICK_MS, { deadWindowSince: { w1: T0 - 20_000 } });
    const decision = decide({
      now: T0,
      environments: [],
      windows: [win('w1', null, T0)],
      pendings: [],
      state,
      settings: settings(),
      running: new Set(),
    });
    expect(decision.state.deadWindowSince).toEqual({});
    expect(decision.removeWindowFiles).toEqual([]);
  });

  it('removes a file of a live process that is not updated anymore (reused process ID)', () => {
    const sim = new Sim().environment('A', { running: false });
    // A file from before a restart of the computer; another program has its process ID now.
    sim.openWindow('old', 'A').hang('old');
    sim.now += 3_600_000;
    sim.tick();
    // Not during the start-up grace.
    expect(sim.windows.has('old')).toBe(true);
    expect(sim.last?.exit).toBe(false);
    sim.run(SLEEP_GRACE_MS);
    expect(sim.windows.has('old')).toBe(false);
    expect(sim.exitAt).toBe(sim.removedWindowFiles[0].at);
  });

  it('keeps the file of a hanging window until HEARTBEAT_MAX_AGE_MS plus the waiting time', () => {
    const sim = new Sim().environment('A').openWindow('w1', 'A').start();
    sim.hang('w1');
    const lastUpdate = Date.parse(sim.windows.get('w1')!.status.updatedAt);
    sim.run(3 * 60_000);
    const [removal] = sim.removedWindowFiles;
    expect(removal.id).toBe('w1');
    expect(removal.at).toBeGreaterThan(lastUpdate + HEARTBEAT_MAX_AGE_MS + 30_000);
    expect(removal.at).toBeLessThanOrEqual(lastUpdate + HEARTBEAT_MAX_AGE_MS + 30_000 + TICK_MS);
  });
});

describe('exit', () => {
  const now = T0 + 60_000;
  const base = (overrides: Partial<DecideInput> = {}): DecideInput => ({
    now,
    environments: [env('A')],
    windows: [],
    pendings: [],
    state: runningState(now - TICK_MS),
    settings: settings(),
    running: new Set(),
    ...overrides,
  });

  it('ends when no window is alive, no waiting time runs, and no pending file is fresh', () => {
    expect(decide(base()).exit).toBe(true);
    expect(decide(base({ environments: [] })).exit).toBe(true);
  });

  it('stays while a window is alive, also an empty one', () => {
    expect(decide(base({ windows: [win('w1', null, now)] })).exit).toBe(false);
    expect(decide(base({ windows: [win('w1', 'A', now)] })).exit).toBe(false);
  });

  it('does not count closing windows and ended processes as alive', () => {
    const windows = [win('w1', 'A', now, { state: 'closing' }), win('w2', null, now, { alive: false })];
    expect(decide(base({ windows })).exit).toBe(true);
  });

  it('stays while a waiting time runs, and in the tick of a stop', () => {
    const running = decide(base({ running: new Set(['A']) }));
    expect(running.stop).toEqual([]);
    expect(running.exit).toBe(false);
    const stopping = decide(base({ running: new Set(['A']), state: runningState(now - TICK_MS, { idleSince: { A: now - 30_000 } }) }));
    expect(stopping.stop).toEqual(['A']);
    expect(stopping.exit).toBe(false);
  });

  it('stays while a pending connection file is fresh, also for an environment that is not in the registry yet', () => {
    expect(decide(base({ pendings: [pending('A', now)] })).exit).toBe(false);
    expect(decide(base({ pendings: [pending('new', now)] })).exit).toBe(false);
    expect(decide(base({ pendings: [pending('A', now - PENDING_MAX_AGE_MS - 1)] })).exit).toBe(true);
  });

  it('stays while an environment is busy', () => {
    expect(decide(base({ environments: [env('A', { busy: true })] })).exit).toBe(false);
  });

  it('stays while Docker did not answer a needed query, until DOCKER_UNKNOWN_MAX_MS', () => {
    expect(decide(base({ running: undefined })).exit).toBe(false);
    const unknownSince = runningState(now - TICK_MS, { dockerUnknownSince: now - DOCKER_UNKNOWN_MAX_MS });
    expect(decide(base({ running: undefined, state: unknownSince })).exit).toBe(true);
    // Nothing needed: no Docker answer is necessary.
    expect(decide(base({ running: undefined, settings: settings({ stopOnClose: false }) })).exit).toBe(true);
  });
});
