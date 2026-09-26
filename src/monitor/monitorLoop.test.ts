// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUSY_OWNER_STATUS_MAX_AGE_MS } from '../core/busy';
import type { ContainerInfo } from '../core/docker/containerAdapter';
import { gitSummaryCommand } from '../core/git/gitSummary';
import { LABEL_ENVIRONMENT_ID } from '../core/names';
import type { Logger, RunResult } from '../core/ports';
import { StoragePaths } from '../core/storage/paths';
import { EnvironmentRegistry } from '../core/storage/registry';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { Environment, GitSummary, MonitorSettings, WindowStatus } from '../core/types';
import {
  BUSY_MARK_MAX_AGE_MS,
  GIT_SUMMARY_TIMEOUT_MS,
  MAX_FAILED_TICKS,
  MonitorLoop,
  environmentLabel,
  type MonitorDocker,
  type MonitorLoopDeps,
  type TickResult,
} from './monitorLoop';
import { DOCKER_UNKNOWN_MAX_MS, SLEEP_GRACE_MS, TICK_MS } from './rules';

const ID_A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const ID_B = '7c1d2e3f-0000-4000-8000-000000000002';
const ID_UNKNOWN = '99999999-0000-4000-8000-000000000009';
const T0 = Date.parse('2026-09-24T17:00:00.000Z');
const LIVE_PID = 4242;
const LIVE_PID_2 = 4343;
const DEAD_PID = 5151;
const WAITING_MS = 30_000;
const OLD_SUMMARY: GitSummary = {
  branch: 'old-branch',
  uncommittedFiles: 9,
  unpushedCommits: 9,
  stashes: 9,
  recordedAt: '2026-09-20T10:00:00.000Z',
};
const GIT_OUTPUT = 'main\n2\n3\n1\n';

const iso = (ms: number): string => new Date(ms).toISOString();

function environment(id: string, repository: string, extra: Partial<Environment> = {}): Environment {
  const name = `devenv-${repository.replace('/', '-')}-${id.slice(0, 8)}`;
  return {
    id,
    repository,
    configPath: '.devcontainer/devcontainer.json',
    volumeName: name,
    containerName: name,
    createdAt: iso(T0 - 86_400_000),
    lastUsedAt: iso(T0 - 3_600_000),
    ...extra,
  };
}

function containerOf(env: Environment, state: ContainerInfo['state'] = 'running', suffix = ''): ContainerInfo {
  return {
    id: `id-${env.containerName}${suffix}`,
    name: `${env.containerName}${suffix}`,
    state,
    rawState: state === 'running' ? 'running' : 'exited',
    labels: { [LABEL_ENVIRONMENT_ID]: env.id },
    image: `devenv-${env.id.slice(0, 8)}:1`,
  };
}

function ok(stdout: string): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

class FakeClock {
  time = T0;
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

interface ExecCall {
  container: string;
  command: readonly string[];
  options: { user?: string; timeoutMs?: number };
}

class FakeDocker implements MonitorDocker {
  containers: ContainerInfo[] = [];
  calls: string[] = [];
  execCalls: ExecCall[] = [];
  listError: Error | undefined;
  stopError: Error | undefined;
  execResult: () => RunResult = () => ok(GIT_OUTPUT);
  listHook: (() => Promise<void>) | undefined;
  execHook: (() => Promise<void>) | undefined;
  stopHook: ((id: string) => Promise<void>) | undefined;

  async listEnvironmentContainers(): Promise<ContainerInfo[]> {
    this.calls.push('list');
    await this.listHook?.();
    if (this.listError) throw this.listError;
    return this.containers.map((container) => ({ ...container, labels: { ...container.labels } }));
  }

  async exec(container: string, command: readonly string[], options: { user?: string; timeoutMs?: number }): Promise<RunResult> {
    this.calls.push(`exec ${container}`);
    this.execCalls.push({ container, command, options });
    await this.execHook?.();
    return this.execResult();
  }

  async stopContainer(nameOrId: string): Promise<void> {
    this.calls.push(`stop ${nameOrId}`);
    await this.stopHook?.(nameOrId);
    if (this.stopError) throw this.stopError;
    for (const container of this.containers) {
      if (container.id === nameOrId) {
        container.state = 'stopped';
        container.rawState = 'exited';
      }
    }
  }

  count(prefix: string): number {
    return this.calls.filter((call) => call.startsWith(prefix)).length;
  }
}

class MemoryLogger implements Logger {
  lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string, error?: unknown): void {
    this.lines.push(`error ${message} ${error instanceof Error ? error.message : ''}`);
  }
  output(text: string): void {
    this.lines.push(`output ${text}`);
  }
}

interface Harness {
  root: string;
  paths: StoragePaths;
  registry: EnvironmentRegistry;
  sessionFiles: SessionFiles;
  docker: FakeDocker;
  clock: FakeClock;
  logger: MemoryLogger;
  alive: Set<number>;
  lock: { held: boolean; refreshes: number };
  /** Called before each readWindowStatuses of the loop. */
  beforeReadWindows?: (call: number) => Promise<void>;
  loop: MonitorLoop;
  newLoop(overrides?: Partial<MonitorLoopDeps>): MonitorLoop;
}

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-test-'));
  roots.push(root);
  const paths = new StoragePaths(root);
  paths.ensureDirectoriesSync();
  const clock = new FakeClock();
  const registry = new EnvironmentRegistry(paths, clock);
  const sessionFiles = new SessionFiles(paths, clock);
  const docker = new FakeDocker();
  const logger = new MemoryLogger();
  const alive = new Set<number>([LIVE_PID, LIVE_PID_2]);
  const lock = { held: true, refreshes: 0 };
  let windowReads = 0;
  const harness = {} as Harness;
  const files: MonitorLoopDeps['sessionFiles'] = {
    readMonitorSettings: () => sessionFiles.readMonitorSettings(),
    readPendings: () => sessionFiles.readPendings(),
    removeWindowStatus: (windowId) => sessionFiles.removeWindowStatus(windowId),
    readWindowStatuses: async () => {
      windowReads++;
      await harness.beforeReadWindows?.(windowReads);
      return sessionFiles.readWindowStatuses();
    },
  };
  const newLoop = (overrides: Partial<MonitorLoopDeps> = {}): MonitorLoop =>
    new MonitorLoop({
      registry,
      sessionFiles: files,
      docker,
      logger,
      clock,
      isAlive: (pid) => alive.has(pid),
      refreshLock: () => {
        lock.refreshes++;
        return lock.held;
      },
      ...overrides,
    });
  Object.assign(harness, { root, paths, registry, sessionFiles, docker, clock, logger, alive, lock, newLoop });
  harness.loop = newLoop();
  return harness;
}

async function writeWindow(
  h: Harness,
  windowId: string,
  environmentId: string | null,
  options: { pid?: number; state?: WindowStatus['state']; at?: number } = {},
): Promise<void> {
  await h.sessionFiles.writeWindowStatus({
    windowId,
    pid: options.pid ?? LIVE_PID,
    environmentId,
    state: options.state ?? 'active',
    updatedAt: iso(options.at ?? h.clock.time),
  });
}

async function writeSettings(h: Harness, overrides: Partial<MonitorSettings> = {}): Promise<void> {
  await h.sessionFiles.writeMonitorSettings({
    waitingTimeSeconds: WAITING_MS / 1000,
    stopOnClose: true,
    respectShutdownActionNone: false,
    updatedAt: iso(T0),
    ...overrides,
  });
}

/** Runs one tick, then advances the clock by TICK_MS. */
async function step(h: Harness): Promise<TickResult> {
  const result = await h.loop.tick();
  h.clock.advance(TICK_MS);
  return result;
}

/** Runs ticks until the clock reaches `until` (exclusive) or the loop ends. Returns the results. */
async function runUntil(h: Harness, until: number, each?: () => Promise<void>): Promise<TickResult[]> {
  const results: TickResult[] = [];
  while (h.clock.time < until) {
    await each?.();
    const result = await step(h);
    results.push(result);
    if (result.end) break;
  }
  return results;
}

/** For `runUntil`: a live window writes its status file (without an environment) every 15 seconds. */
function ownerWritesEvery15s(h: Harness, windowId: string, pid: number): () => Promise<void> {
  let lastWrite = -Infinity;
  return async () => {
    if (h.clock.time - lastWrite >= 15_000) {
      lastWrite = h.clock.time;
      await writeWindow(h, windowId, null, { pid });
    }
  };
}

/** A: connected in window w1 once, the window closed (process ended); its container runs. */
async function closedWindowScenario(h: Harness, extra: Partial<Environment> = {}): Promise<Environment> {
  const env = environment(ID_A, 'acme/api', {
    remoteUser: 'vscode',
    remoteWorkspaceFolder: '/workspaces/api',
    gitSummary: OLD_SUMMARY,
    ...extra,
  });
  await h.registry.add(env);
  await writeSettings(h);
  await writeWindow(h, 'w1', ID_A, { pid: DEAD_PID, state: 'closing' });
  h.docker.containers = [containerOf(env)];
  return env;
}

describe('environmentLabel (concept D-3: one environment per repository and GitHub account)', () => {
  const API = { id: ID_A, repository: 'acme/api' };
  it.each<[string, Array<Pick<Environment, 'id' | 'repository'>>, string]>([
    ['the only environment of its repository', [API, { id: ID_B, repository: 'acme/web' }], 'acme/api'],
    ['another environment of the repository (of another account)', [API, { id: ID_B, repository: 'acme/api' }], 'acme/api (3f2a9c1e)'],
    ['the same, with the repository in another case', [API, { id: ID_B, repository: 'ACME/Api' }], 'acme/api (3f2a9c1e)'],
    ['an environment that the list does not have', [{ id: ID_B, repository: 'acme/web' }], 'acme/api'],
  ])('%s', (_name, environments, expected) => {
    expect(environmentLabel(API, environments)).toBe(expected);
  });
});

describe('MonitorLoop.tick', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('ends at once without environments and windows, without asking Docker', async () => {
    const result = await h.loop.tick();
    expect(result.end).toBe('idle');
    expect(h.docker.calls).toEqual([]);
  });

  it('uses the default settings when monitor.json is missing', async () => {
    const env = environment(ID_A, 'acme/api');
    await h.registry.add(env);
    await writeWindow(h, 'w1', ID_A, { pid: DEAD_PID, state: 'closing' });
    h.docker.containers = [containerOf(env)];
    const results = await runUntil(h, T0 + 30_000);
    expect(results.every((result) => result.stopped.length === 0)).toBe(true);
    expect((await step(h)).stopped).toEqual([ID_A]);
  });

  it('does not call Docker while every environment is in use by a live window', async () => {
    const env = environment(ID_A, 'acme/api');
    await h.registry.add(env);
    await writeSettings(h);
    h.docker.containers = [containerOf(env)];
    let lastWrite = -Infinity;
    const results = await runUntil(h, T0 + 5 * 60_000, async () => {
      if (h.clock.time - lastWrite >= 15_000) {
        lastWrite = h.clock.time;
        await writeWindow(h, 'w1', ID_A);
      }
    });
    expect(results.some((result) => result.end)).toBe(false);
    expect(h.docker.calls).toEqual([]);
  });

  it('stops the container after the waiting time when its window closed, and records the Git state first', async () => {
    await closedWindowScenario(h);
    const before = await runUntil(h, T0 + WAITING_MS);
    expect(before.every((result) => result.stopped.length === 0 && !result.end)).toBe(true);
    expect(h.docker.count('stop')).toBe(0);
    expect(h.logger.lines.some((line) => line.includes('acme/api runs, and no window uses it. It stops in 30 seconds.'))).toBe(true);

    const stopTime = h.clock.time;
    const result = await step(h);
    expect(result.stopped).toEqual([ID_A]);
    const container = `id-devenv-acme-api-3f2a9c1e`;
    expect(h.docker.calls.slice(-2)).toEqual([`exec ${container}`, `stop ${container}`]);
    expect(h.docker.execCalls).toEqual([
      {
        container,
        command: gitSummaryCommand('/workspaces/api'),
        options: { user: 'vscode', timeoutMs: GIT_SUMMARY_TIMEOUT_MS },
      },
    ]);
    expect((await h.registry.get(ID_A))?.gitSummary).toEqual({
      branch: 'main',
      uncommittedFiles: 2,
      unpushedCommits: 3,
      stashes: 1,
      recordedAt: iso(stopTime),
    });
    // The status file of the ended window is removed after the waiting time.
    expect(await h.sessionFiles.readWindowStatuses()).toEqual([]);

    // The next tick sees the stopped container, and the monitor has no more work.
    const next = await step(h);
    expect(next.stopped).toEqual([]);
    expect(next.end).toBe('idle');
    expect(h.docker.count('stop')).toBe(1);
  });

  it('records the Git state before the stop in the registry file', async () => {
    await closedWindowScenario(h);
    let summaryAtStop: GitSummary | undefined;
    h.docker.stopHook = async () => {
      summaryAtStop = (await h.registry.get(ID_A))?.gitSummary;
    };
    await runUntil(h, T0 + WAITING_MS + 1);
    expect(summaryAtStop?.branch).toBe('main');
  });

  it('keeps the previous Git state when Git is missing in the container, and still stops', async () => {
    await closedWindowScenario(h);
    h.docker.execResult = () => ({ exitCode: 127, stdout: '', stderr: 'Git is not installed.', timedOut: false });
    await runUntil(h, T0 + WAITING_MS + 1);
    expect(h.docker.count('stop')).toBe(1);
    expect((await h.registry.get(ID_A))?.gitSummary).toEqual(OLD_SUMMARY);
    expect(h.logger.lines.some((line) => line.includes('Git is not available'))).toBe(true);
  });

  it('keeps the previous Git state when the output is invalid, Git fails, or docker exec throws', async () => {
    const results: Array<() => RunResult> = [
      () => ok('not the expected output'),
      () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', timedOut: false }),
      () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
      () => {
        throw new Error('docker exec failed');
      },
    ];
    for (const execResult of results) {
      h = createHarness();
      await closedWindowScenario(h);
      h.docker.execResult = execResult;
      await runUntil(h, T0 + WAITING_MS + 1);
      expect(h.docker.count('stop')).toBe(1);
      expect((await h.registry.get(ID_A))?.gitSummary).toEqual(OLD_SUMMARY);
    }
  });

  it('runs Git as the default user in /workspaces/<name> when the registry has no remote user and folder', async () => {
    await closedWindowScenario(h, { remoteUser: undefined, remoteWorkspaceFolder: undefined });
    await runUntil(h, T0 + WAITING_MS + 1);
    expect(h.docker.execCalls[0].command).toEqual(gitSummaryCommand('/workspaces/api'));
    expect(h.docker.execCalls[0].options.user).toBeUndefined();
  });

  it('does not stop when a pending connection file appears after the decision', async () => {
    await closedWindowScenario(h);
    await runUntil(h, T0 + WAITING_MS);
    h.docker.listHook = async () => {
      await h.sessionFiles.writePending(ID_A, 'w2');
    };
    const result = await step(h);
    expect(result.decision?.stop).toEqual([ID_A]);
    expect(result.stopped).toEqual([]);
    expect(h.docker.count('exec')).toBe(0);
    expect(h.docker.count('stop')).toBe(0);
    expect(h.logger.lines.some((line) => line.includes('acme/api is in use again. Its container is not stopped.'))).toBe(true);
  });

  // User decision 2026-09-26, "go with the proposal for closing": Keep Running When Closed, stored in the registry.
  it('never stops a kept environment: no Docker call, and the monitor ends while its container runs', async () => {
    await closedWindowScenario(h, { keepRunning: true });
    const results = await runUntil(h, T0 + 10 * WAITING_MS);
    expect(results[0]?.end).toBe('idle');
    expect(h.docker.count('stop')).toBe(0);
    expect(h.docker.calls).toEqual([]);
  });

  it('does not stop when the environment becomes kept after the decision', async () => {
    await closedWindowScenario(h);
    await runUntil(h, T0 + WAITING_MS);
    h.docker.listHook = async () => {
      await h.registry.updateEnvironment(ID_A, (environment) => {
        environment.keepRunning = true;
      });
    };
    const result = await step(h);
    expect(result.decision?.stop).toEqual([ID_A]);
    expect(result.stopped).toEqual([]);
    expect(h.docker.count('stop')).toBe(0);
    expect(h.logger.lines).toContain('info acme/api keeps running when closed. Its container is not stopped.');
    h.docker.listHook = undefined;
    await step(h);
    expect(h.logger.lines).toContain('info acme/api keeps running when closed. The waiting time ends.');
    expect(h.docker.count('stop')).toBe(0);
  });

  it('does not stop when a window connects while the Git state is read', async () => {
    await closedWindowScenario(h);
    await runUntil(h, T0 + WAITING_MS);
    h.docker.execHook = async () => {
      await writeWindow(h, 'w2', ID_A, { pid: LIVE_PID_2 });
    };
    const result = await step(h);
    expect(result.stopped).toEqual([]);
    expect(h.docker.count('exec')).toBe(1);
    expect(h.docker.count('stop')).toBe(0);
  });

  it('does not stop and does not record when the environment becomes busy while the Git state is read', async () => {
    await closedWindowScenario(h);
    await runUntil(h, T0 + WAITING_MS);
    h.docker.execHook = async () => {
      await writeWindow(h, 'w2', null, { pid: LIVE_PID_2 });
      await h.registry.setBusy(ID_A, 'rebuild', { windowId: 'w2', pid: LIVE_PID_2 });
    };
    const result = await step(h);
    expect(result.stopped).toEqual([]);
    expect(h.docker.count('stop')).toBe(0);
    expect((await h.registry.get(ID_A))?.gitSummary).toEqual(OLD_SUMMARY);
  });

  it('does not stop an environment that was removed from the registry meanwhile', async () => {
    await closedWindowScenario(h);
    await runUntil(h, T0 + WAITING_MS);
    h.docker.execHook = async () => {
      await h.registry.remove(ID_A);
    };
    const result = await step(h);
    expect(result.stopped).toEqual([]);
    expect(h.docker.count('stop')).toBe(0);
  });

  it('stops the container also when the Git state cannot be written to the registry', async () => {
    await closedWindowScenario(h);
    await runUntil(h, T0 + WAITING_MS);
    h.loop = h.newLoop({
      registry: {
        list: () => h.registry.list(),
        updateEnvironment: async () => {
          throw new Error('Timeout while waiting for the lock');
        },
      },
    });
    // A new loop starts with a fresh state: run it through its own waiting time.
    await runUntil(h, h.clock.time + 2 * WAITING_MS);
    expect(h.docker.count('stop')).toBe(1);
    expect(h.logger.lines.some((line) => line.includes('could not be recorded'))).toBe(true);
  });

  it('never stops containers of environments that are not in the registry', async () => {
    const env = environment(ID_B, 'acme/web');
    await h.registry.add(env);
    await writeSettings(h);
    const stranger = containerOf(environment(ID_UNKNOWN, 'other/thing'));
    h.docker.containers = [containerOf(env, 'stopped'), stranger];
    const results = await runUntil(h, T0 + 5 * WAITING_MS);
    expect(results.at(-1)?.end).toBe('idle');
    expect(h.docker.count('stop')).toBe(0);
    expect(h.docker.count('exec')).toBe(0);
  });

  it('stops nothing while Docker does not answer, and ends only after DOCKER_UNKNOWN_MAX_MS', async () => {
    await closedWindowScenario(h);
    h.docker.listError = new Error('Cannot connect to the Docker daemon');
    const results = await runUntil(h, T0 + 10 * 60_000);
    const end = results.findIndex((result) => result.end !== undefined);
    expect(results[end].end).toBe('idle');
    expect(end * TICK_MS).toBeGreaterThanOrEqual(DOCKER_UNKNOWN_MAX_MS);
    expect(h.docker.count('stop')).toBe(0);
    expect(h.docker.count('exec')).toBe(0);
    // Logged once, not every tick.
    expect(h.logger.lines.filter((line) => line.includes('Docker does not answer')).length).toBe(1);
  });

  it('keeps a running waiting time through a short Docker failure', async () => {
    await closedWindowScenario(h);
    await runUntil(h, T0 + 20_000);
    h.docker.listError = new Error('timeout');
    await runUntil(h, T0 + 30_000);
    h.docker.listError = undefined;
    const result = await step(h);
    expect(result.stopped).toEqual([ID_A]);
    expect(h.logger.lines.some((line) => line.includes('Docker answers again.'))).toBe(true);
  });

  it('tries a failed stop again with a growing pause', async () => {
    await closedWindowScenario(h);
    h.docker.stopError = new Error('docker stop timed out');
    await runUntil(h, T0 + WAITING_MS + 1);
    expect(h.docker.count('stop')).toBe(1);
    // 1st failure → pause of 10 s, 2nd failure → 20 s.
    await runUntil(h, T0 + WAITING_MS + 10_000);
    expect(h.docker.count('stop')).toBe(1);
    await runUntil(h, T0 + WAITING_MS + 10_001);
    expect(h.docker.count('stop')).toBe(2);
    await runUntil(h, T0 + WAITING_MS + 30_000);
    expect(h.docker.count('stop')).toBe(2);
    h.docker.stopError = undefined;
    const results = await runUntil(h, T0 + WAITING_MS + 30_001);
    expect(results.at(-1)?.stopped).toEqual([ID_A]);
    expect(h.docker.count('stop')).toBe(3);
  });

  it('ends at once without Docker calls when another monitor took over the lock', async () => {
    await closedWindowScenario(h);
    h.lock.held = false;
    const result = await h.loop.tick();
    expect(result.end).toBe('lockLost');
    expect(h.docker.calls).toEqual([]);
  });

  it('stops no further container after losing the lock between two stops', async () => {
    const envA = await closedWindowScenario(h);
    const envB = environment(ID_B, 'acme/web');
    await h.registry.add(envB);
    h.docker.containers = [containerOf(envA), containerOf(envB)];
    h.docker.stopHook = async () => {
      h.lock.held = false;
    };
    const results = await runUntil(h, T0 + WAITING_MS + 1);
    const last = results.at(-1);
    expect(last?.end).toBe('lockLost');
    expect(last?.decision?.stop.sort()).toEqual([ID_A, ID_B].sort());
    expect(last?.stopped.length).toBe(1);
    expect(h.docker.count('stop')).toBe(1);
  });

  it('with stopOnClose false stops nothing, makes no Docker call, and ends without windows', async () => {
    await closedWindowScenario(h);
    await writeSettings(h, { stopOnClose: false });
    const result = await h.loop.tick();
    expect(result.end).toBe('idle');
    expect(h.docker.calls).toEqual([]);
  });

  it('respects "shutdownAction": "none" only with respectShutdownActionNone', async () => {
    await closedWindowScenario(h, { shutdownActionNone: true });
    await writeSettings(h, { respectShutdownActionNone: true });
    expect((await h.loop.tick()).end).toBe('idle');
    expect(h.docker.calls).toEqual([]);

    h = createHarness();
    await closedWindowScenario(h, { shutdownActionNone: true });
    await runUntil(h, T0 + WAITING_MS + 1);
    expect(h.docker.count('stop')).toBe(1);
  });

  it('a busy mark protects the environment only while its owner process exists and the mark is not too old', async () => {
    // Live owner window (process exists, status file of the same process written every 15 s): in use, no Docker call,
    // the monitor keeps running.
    await closedWindowScenario(h, { busy: { operation: 'update', since: iso(T0), pid: LIVE_PID_2, windowId: 'w9' } });
    const live = await runUntil(h, T0 + 3 * BUSY_OWNER_STATUS_MAX_AGE_MS, ownerWritesEvery15s(h, 'w9', LIVE_PID_2));
    expect(live.some((result) => result.end)).toBe(false);
    expect(h.docker.calls).toEqual([]);

    // Owner process ended: the container stops after the waiting time.
    h = createHarness();
    await closedWindowScenario(h, { busy: { operation: 'update', since: iso(T0), pid: DEAD_PID, windowId: 'w9' } });
    await runUntil(h, T0 + WAITING_MS + 1);
    expect(h.docker.count('stop')).toBe(1);

    // A process with the owner's ID exists, but the mark is older than BUSY_MARK_MAX_AGE_MS: the ID was reused.
    h = createHarness();
    const since = iso(T0 - BUSY_MARK_MAX_AGE_MS - 1);
    await closedWindowScenario(h, { busy: { operation: 'update', since, pid: LIVE_PID_2, windowId: 'w9' } });
    await runUntil(h, T0 + WAITING_MS + 1);
    expect(h.docker.count('stop')).toBe(1);
  });

  it('a busy mark does not protect the environment without a recent status file of its owner (reused process ID)', async () => {
    const mark = { operation: 'rebuild' as const, since: iso(T0), pid: LIVE_PID_2, windowId: 'w9' };

    // The owner window ended without a status file; another program got its process ID.
    await closedWindowScenario(h, { busy: mark });
    await runUntil(h, T0 + WAITING_MS + 1);
    expect(h.docker.count('stop')).toBe(1);
    expect((await h.registry.get(ID_A))?.gitSummary?.branch).toBe('main');

    // The status file of the owner window names another process (the window was reloaded).
    h = createHarness();
    await closedWindowScenario(h, { busy: mark });
    await runUntil(h, T0 + WAITING_MS + 1, ownerWritesEvery15s(h, 'w9', LIVE_PID));
    expect(h.docker.count('stop')).toBe(1);

    // The owner window left an old status file of the same process: after the sleep grace at the start of the monitor,
    // the mark does not count, and the container stops after the waiting time.
    h = createHarness();
    await closedWindowScenario(h, { busy: mark });
    await writeWindow(h, 'w9', null, { pid: LIVE_PID_2, state: 'closing', at: T0 - BUSY_OWNER_STATUS_MAX_AGE_MS - 1 });
    await runUntil(h, T0 + SLEEP_GRACE_MS + WAITING_MS);
    expect(h.docker.count('stop')).toBe(0);
    await runUntil(h, T0 + SLEEP_GRACE_MS + WAITING_MS + 1);
    expect(h.docker.count('stop')).toBe(1);
  });

  it('after computer sleep, a busy mark protects its environment until the owner writes its status file again', async () => {
    await closedWindowScenario(h, { busy: { operation: 'update', since: iso(T0), pid: LIVE_PID_2, windowId: 'w9' } });
    const owner = ownerWritesEvery15s(h, 'w9', LIVE_PID_2);
    await runUntil(h, T0 + 60_000, owner);
    expect(h.docker.calls).toEqual([]);

    // The computer sleeps for 10 minutes. At the wake-up, the status file of the owner is 10 minutes old; the owner
    // writes it again within the sleep grace.
    h.clock.advance(10 * 60_000);
    const wake = h.clock.time;
    await runUntil(h, wake + 20_000);
    expect(h.docker.calls).toEqual([]);
    expect(h.loop.state.idleSince).toEqual({});
    const results = await runUntil(h, wake + SLEEP_GRACE_MS + 3 * WAITING_MS, owner);
    expect(results.some((result) => result.end)).toBe(false);
    expect(h.docker.calls).toEqual([]);
  });

  it('removes status files of ended windows after the waiting time, but not a file that was written again', async () => {
    await writeSettings(h);
    await writeWindow(h, 'w1', null, { pid: DEAD_PID, state: 'closing' });
    await writeWindow(h, 'w2', null, { pid: DEAD_PID });
    await writeWindow(h, 'w3', null);
    let tickAt = -1;
    let readsInTick = 0;
    h.beforeReadWindows = async () => {
      if (tickAt !== h.clock.time) {
        tickAt = h.clock.time;
        readsInTick = 0;
      }
      readsInTick++;
      // The second read of the tick at the end of the waiting time is the check right before the removal.
      if (h.clock.time === T0 + WAITING_MS && readsInTick === 2) {
        await writeWindow(h, 'w2', null, { pid: DEAD_PID, at: h.clock.time });
      }
    };
    let lastWrite = T0;
    const results = await runUntil(h, T0 + WAITING_MS + 1, async () => {
      if (h.clock.time - lastWrite >= 15_000) {
        lastWrite = h.clock.time;
        await writeWindow(h, 'w3', null);
      }
    });
    expect(results.at(-1)?.decision?.removeWindowFiles.sort()).toEqual(['w1', 'w2']);
    const ids = (await h.sessionFiles.readWindowStatuses()).map((status) => status.windowId);
    expect(ids).toEqual(['w2', 'w3']);
    expect(h.logger.lines.some((line) => line.includes('Removed the status file of window w1'))).toBe(true);
  });

  it('asks Docker once after a stop, and not again while other windows keep the monitor running', async () => {
    const envA = await closedWindowScenario(h);
    const envB = environment(ID_B, 'acme/web');
    await h.registry.add(envB);
    h.docker.containers = [containerOf(envA), containerOf(envB)];
    let lastWrite = -Infinity;
    const keepB = async (): Promise<void> => {
      if (h.clock.time - lastWrite >= 15_000) {
        lastWrite = h.clock.time;
        await writeWindow(h, 'w2', ID_B, { pid: LIVE_PID_2 });
      }
    };
    await runUntil(h, T0 + WAITING_MS + 1, keepB);
    expect(h.docker.count('stop')).toBe(1);
    await runUntil(h, T0 + WAITING_MS + 2 * TICK_MS, keepB);
    const listsAfterConfirmation = h.docker.count('list');
    const results = await runUntil(h, T0 + 5 * 60_000, keepB);
    expect(results.some((result) => result.end)).toBe(false);
    expect(h.docker.count('list')).toBe(listsAfterConfirmation);
  });

  it('stops each environment of one repository on its own (two GitHub accounts), and names them apart in the log', async () => {
    const envA = await closedWindowScenario(h, { owner: { id: '1001', login: 'octo' } });
    const envB = environment(ID_B, 'acme/api', { owner: { id: '2002', login: 'someone' } });
    await h.registry.add(envB);
    h.docker.containers = [containerOf(envA), containerOf(envB)];
    // A window of the other account uses its environment of the same repository.
    let lastWrite = -Infinity;
    const keepB = async (): Promise<void> => {
      if (h.clock.time - lastWrite >= 15_000) {
        lastWrite = h.clock.time;
        await writeWindow(h, 'w2', ID_B, { pid: LIVE_PID_2 });
      }
    };
    const results = await runUntil(h, T0 + WAITING_MS + 1, keepB);
    expect(results.flatMap((result) => result.stopped)).toEqual([ID_A]);
    expect(h.docker.calls.filter((call) => call.startsWith('stop'))).toEqual([`stop ${containerOf(envA).id}`]);
    expect(h.docker.containers.map((container) => container.state)).toEqual(['stopped', 'running']);
    expect(h.logger.lines).toContain('info acme/api (3f2a9c1e) runs, and no window uses it. It stops in 30 seconds.');
    expect(h.logger.lines).toContain(`info Stopping the container ${envA.containerName} of acme/api (3f2a9c1e): no window uses it.`);
    expect(h.logger.lines.some((line) => line.includes('7c1d2e3f'))).toBe(false);
  });

  it('logs when an environment is in use again during its waiting time', async () => {
    await closedWindowScenario(h);
    await runUntil(h, T0 + 10_000);
    await writeWindow(h, 'w2', ID_A, { pid: LIVE_PID_2 });
    await step(h);
    expect(h.logger.lines).toContain('info acme/api is in use again. The waiting time ends.');
    expect(h.loop.state.idleSince).toEqual({});
  });

  it('stops every running container of an environment, and reads Git in the one with the registry name', async () => {
    const env = await closedWindowScenario(h);
    const extra = containerOf(env, 'running', '-old');
    h.docker.containers = [extra, containerOf(env)];
    await runUntil(h, T0 + WAITING_MS + 1);
    expect(h.docker.execCalls.map((call) => call.container)).toEqual([`id-${env.containerName}`]);
    expect(h.docker.calls.filter((call) => call.startsWith('stop')).sort()).toEqual(
      [`stop id-${env.containerName}`, `stop id-${env.containerName}-old`].sort(),
    );
  });

  it('passes the state from one tick to the next (sleep grace at the start, waiting times)', async () => {
    await closedWindowScenario(h);
    await step(h);
    expect(h.loop.state.sleepGraceUntil).toBeGreaterThan(T0);
    expect(h.loop.state.idleSince[ID_A]).toBe(T0);
    await step(h);
    expect(h.loop.state.idleSince[ID_A]).toBe(T0);
  });
});

describe('MonitorLoop.run', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  /** A pause that only moves the fake clock. */
  function fakeDelay(harness: Harness, count: { value: number }) {
    return async (ms: number): Promise<void> => {
      count.value++;
      harness.clock.advance(ms);
    };
  }

  it('runs ticks until the monitor has no work', async () => {
    await closedWindowScenario(h);
    const pauses = { value: 0 };
    h.loop = h.newLoop({ delay: fakeDelay(h, pauses) });
    expect(await h.loop.run()).toBe('idle');
    expect(h.docker.count('stop')).toBe(1);
    expect(pauses.value).toBeGreaterThanOrEqual(WAITING_MS / TICK_MS);
  });

  it('continues after a failed tick', async () => {
    await closedWindowScenario(h);
    let failures = 1;
    const pauses = { value: 0 };
    h.loop = h.newLoop({
      delay: fakeDelay(h, pauses),
      registry: {
        list: async () => {
          if (failures-- > 0) throw new Error('EACCES: registry.json');
          return h.registry.list();
        },
        updateEnvironment: (id, mutator) => h.registry.updateEnvironment(id, mutator),
      },
    });
    expect(await h.loop.run()).toBe('idle');
    expect(h.docker.count('stop')).toBe(1);
    expect(h.logger.lines.some((line) => line.startsWith('error A check failed (1 in a row).'))).toBe(true);
  });

  it('ends after too many failed ticks in a row', async () => {
    const pauses = { value: 0 };
    h.loop = h.newLoop({
      delay: fakeDelay(h, pauses),
      registry: {
        list: async () => {
          throw new Error('EACCES: registry.json');
        },
        updateEnvironment: async () => undefined,
      },
    });
    expect(await h.loop.run()).toBe('failing');
    expect(pauses.value).toBe(MAX_FAILED_TICKS - 1);
  });

  it('ends when stop() is called during the pause', async () => {
    await writeWindow(h, 'w1', null);
    h.loop = h.newLoop({ tickMs: 60_000 });
    const running = h.loop.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.loop.stop();
    expect(await running).toBe('stopRequested');
  });

  it('ends when the lock is lost', async () => {
    // The window keeps the monitor alive, so only the lost lock ends the loop.
    await writeWindow(h, 'w1', null);
    let pauses = 0;
    h.loop = h.newLoop({
      delay: async (ms) => {
        pauses++;
        h.clock.advance(ms);
        if (pauses === 3) h.lock.held = false;
      },
    });
    expect(await h.loop.run()).toBe('lockLost');
    expect(pauses).toBe(3);
  });
});
