// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #126 (reviewer B), mutation probes of the loop of the Session Monitor on the summaries of the list
// of the engine (src/remoteMonitor/main.ts, review round 1 of PR #126, F1): a summary that remoteContainersOf skips (a
// label of an environment whose value is no environment ID) neither hides the summaries after it (mutant L22: `break` in
// place of `continue`) nor counts as a running environment container for the idle exit (mutant L10: the activity of the
// tick read from the summaries before remoteContainersOf); a stopped container is a container of its environment for the
// records, which stay however old (mutant L12: only the running summaries reach the rules); and over the real port
// (src/helperChannel/engineClient.ts), a list that the engine never answers ends at the time limit of the list (mutant S4
// of engineClient.ts: the signal of containerSummaries is not given to the request), and a stop that it never answers
// ends at the time limit of the stop and releases the lock of the environment (mutant P1 of engineClient.ts: the signal of
// DockerEngine.stop, code from before this PR, is not given to the request). Each test names the mutant it kills.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LABEL_COMPOSE_SERVICE, LABEL_ENVIRONMENT_ID } from '../core/names';
import { abortError } from '../core/ports';
import { heartbeatFileName } from '../core/remoteMonitor/protocol';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import type { EngineAnswer, EngineApi, EngineRequest } from '../helperChannel/engineApi';
import { dockerEngine } from '../helperChannel/engineClient';
import type { LoopEngine } from './engine';
import { LIST_TIMEOUT_MS, RemoteMonitorLoop, STOP_TIMEOUT_MS, heartbeatDir, remoteContainersOf } from './main';
import { REMOTE_GAP_MS, type RemoteRecord } from './rules';
import type { StopLockAttempt } from './stopLock';

const A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const MINUTE = 60_000;
const DEV_ID = 'a'.repeat(64);
const DB_ID = 'b'.repeat(64);
const FOREIGN_ID = 'f'.repeat(64);

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-monitor-11imr2-'));
});

afterEach(() => {
  // The spy of AbortSignal.timeout stays only when a probe failed in its middle (a tick that never ended).
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** A summary of the list of the engine with the label of an environment (`environmentId` as it is, valid or not). */
function summary(id: string, name: string, environmentId: string, composeService?: string, state = 'running'): EngineContainerSummary {
  const labels: Record<string, string> = { [LABEL_ENVIRONMENT_ID]: environmentId };
  if (composeService !== undefined) labels[LABEL_COMPOSE_SERVICE] = composeService;
  return { id, name, state, labels };
}

/**
 * A running container whose label of an environment is no environment ID (a container that another tool or a person
 * labelled), listed first: the engine lists the newest container first.
 */
const foreign = () => summary(FOREIGN_ID, 'labelled-by-hand', 'not-an-environment-id');

/** A record of A that is past its limit: A is to be stopped. */
function staleRecord(): void {
  const dir = heartbeatDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, heartbeatFileName(SOURCE, A)), JSON.stringify({ at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600, seq: 0 }));
}

/**
 * A loop over `engine` whose stops need no wait after its start (no grace), with its log lines; its monotonic clock, the
 * removal of a record (none by default) and the lock of an environment (always taken by default) as the test gives them.
 */
function loopOf(
  engine: LoopEngine,
  options: {
    monotonic?: () => number;
    removeRecord?: (record: RemoteRecord) => Promise<boolean>;
    lockEnvironment?: (environmentId: string) => Promise<StopLockAttempt>;
  } = {},
): { loop: RemoteMonitorLoop; lines: string[] } {
  const lines: string[] = [];
  const loop = new RemoteMonitorLoop({
    engine,
    removeRecord: options.removeRecord ?? (async () => false),
    dir: heartbeatDir(stateDir),
    lockEnvironment: options.lockEnvironment ?? (async () => ({ kind: 'locked', release: () => {} })),
    now: () => T0,
    log: (message) => lines.push(message),
    timing: { gapMs: REMOTE_GAP_MS, graceMs: 0 },
    monotonic: options.monotonic ?? (() => 0),
  });
  return { loop, lines };
}

/**
 * AbortSignal.timeout as a signal that the test aborts (the limits in the order the loop asks for them), for the duration
 * of `body`.
 */
async function withLimits(body: (limits: Array<{ ms: number; controller: AbortController }>) => Promise<void>): Promise<void> {
  const limits: Array<{ ms: number; controller: AbortController }> = [];
  const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    limits.push({ ms, controller });
    return controller.signal;
  });
  try {
    await body(limits);
  } finally {
    spy.mockRestore();
  }
}

/** An Engine API answer that never comes: only the signal of the request ends it (with an AbortError, as engineApi). */
function never(request: EngineRequest): Promise<EngineAnswer> {
  return new Promise<EngineAnswer>((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(abortError()), { once: true }));
}

describe('the loop of the Session Monitor on the summaries of the list (review round 2 of PR #126, B)', () => {
  // Kills L22: a summary that is skipped is only that one; the summaries after it are read (the engine lists the newest
  // first, so a newer container with a label that is no environment ID would otherwise hide every older environment
  // container: none of them would be stopped, and the records of their environments would count as without container).
  it('skips a summary with a label that is no environment ID, and reads the summaries after it (L22)', async () => {
    expect(remoteContainersOf([foreign(), summary(DEV_ID, 'devenv-api', A), summary(DB_ID, 'devenv-api-db-1', A, 'db')])).toEqual([
      { id: DEV_ID, state: 'running', name: 'devenv-api', environmentId: A, composeService: '' },
      { id: DB_ID, state: 'running', name: 'devenv-api-db-1', environmentId: A, composeService: 'db' },
    ]);
    staleRecord();
    const stops: string[] = [];
    // The list of the tick (by the label) has the foreign container first; the list under the lock (by `<label>=<A>`)
    // has only the container of A, as the engine filters it.
    const { loop } = loopOf({
      containerSummaries: async (label) => (label === LABEL_ENVIRONMENT_ID ? [foreign(), summary(DEV_ID, 'devenv-api', A)] : [summary(DEV_ID, 'devenv-api', A)]),
      stop: async (id) => void stops.push(id),
    });
    expect(await loop.tick()).toEqual([A]);
    await loop.removals;
    // Only the container of A; never the foreign one.
    expect(stops).toEqual([DEV_ID]);
  });

  // Kills L10: the idle time of the exit (RemoteMonitorLoop.idleMs) counts the environment containers that the rules see;
  // a running container whose label is no environment ID is never one of them (the monitor never acts on it), so it does
  // not keep the monitor from exiting when no environment container runs.
  it('does not count a running container with a label that is no environment ID as activity for the idle exit (L10)', async () => {
    let clock = 0;
    const { loop } = loopOf({ containerSummaries: async () => [foreign()], stop: async () => {} }, { monotonic: () => clock });
    clock = 5 * MINUTE;
    expect(await loop.tick()).toEqual([]);
    await loop.removals;
    expect(loop.idleMs()).toBe(5 * MINUTE);
    // The same container with the ID of an environment counts (the control of this probe).
    const counted = loopOf({ containerSummaries: async () => [summary(FOREIGN_ID, 'devenv-b', A)], stop: async () => {} }, { monotonic: () => clock });
    clock = 10 * MINUTE;
    expect(await counted.loop.tick()).toEqual([]);
    expect(counted.loop.idleMs()).toBe(0);
  });

  // Kills L12: the rules take every summary of an environment, stopped ones included; an environment whose containers are
  // all stopped has containers, so its records stay however old (only the records of an environment without any
  // container, running or not, are removed after 7 days). Otherwise such records are removed as of an environment
  // without a container, and a later start of it outside a window is never acted on.
  it('keeps the old records of an environment whose containers are all stopped, and removes them once it has none (L12)', async () => {
    const B = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
    const dir = heartbeatDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, heartbeatFileName(SOURCE, B)), JSON.stringify({ at: T0 - 9 * 24 * 60 * MINUTE, keepRunning: false, limitSeconds: 600, seq: 0 }));
    let listed: EngineContainerSummary[] = [summary(DB_ID, 'devenv-b', B, undefined, 'exited')];
    const removed: string[] = [];
    const { loop, lines } = loopOf({ containerSummaries: async () => listed, stop: async () => {} }, { removeRecord: async (record) => (removed.push(record.environmentId), true) });
    expect(await loop.tick()).toEqual([]);
    await loop.removals;
    expect(removed).toEqual([]);
    // The control: once no container of B exists, its old record is removed.
    listed = [];
    expect(await loop.tick()).toEqual([]);
    await loop.removals;
    expect(removed).toEqual([B]);
    expect(lines).toContain(`Removed the old record of ${B} (no container of it exists).`);
  });

  // Kills S4 (engineClient.ts: containerSummaries does not give its signal to the request): over the real port, a list
  // that the engine accepts and never answers ends at the time limit of the list of the tick, which then logs that Docker
  // does not answer and stops nothing; without the signal on the request the tick never ends, and the loop
  // (`for (;;) await loop.tick()`) stops nothing on the whole engine and never exits, without a line in the log.
  it('ends a list that the engine never answers at the time limit of the list, over the real port (S4)', async () => {
    await withLimits(async (limits) => {
      // An Engine API that never answers.
      const { loop, lines } = loopOf(dockerEngine(never, async () => Promise.reject(new Error('no exec in this test'))));
      const ticked = loop.tick();
      await vi.waitFor(() => expect(limits.map((limit) => limit.ms)).toEqual([LIST_TIMEOUT_MS]));
      limits[0].controller.abort();
      expect(await ticked).toEqual([]);
      expect(lines).toEqual(['Docker does not answer; nothing is stopped while it does not answer. Docker did not answer within 30 seconds.']);
    });
  });

  // Kills P1 (engineClient.ts: DockerEngine.stop does not give its signal to the request; code from before this PR, which
  // the monitor uses since this PR): over the real port, a stop that the engine never answers (moby's stop waits without a
  // limit for the lock of the container, which a hung operation of it holds: a start, or the cleanup after its exit such
  // as an unmount) ends at the time limit of the stop: the stop fails (logged, tried again at the next tick) and the lock
  // of the environment is released. Without the signal on the request the tick never ends: no stop on the whole engine,
  // and the lock of the environment stays taken, so every operation of a window on it finds it busy.
  it('ends a stop that the engine never answers at the time limit of the stop, over the real port, and releases the lock (P1)', async () => {
    staleRecord();
    await withLimits(async (limits) => {
      const api: EngineApi = async (request) =>
        request.method === 'GET'
          ? { status: 200, body: JSON.stringify([{ Id: DEV_ID, Names: ['/devenv-api'], State: 'running', Labels: { [LABEL_ENVIRONMENT_ID]: A } }]), truncated: false }
          : never(request);
      const events: string[] = [];
      const { loop, lines } = loopOf(dockerEngine(api, async () => Promise.reject(new Error('no exec in this test'))), {
        lockEnvironment: async (environmentId) => (events.push(`lock ${environmentId}`), { kind: 'locked', release: () => void events.push(`release ${environmentId}`) }),
      });
      const ticked = loop.tick();
      // The list of the tick, the list under the lock, the stop.
      await vi.waitFor(() => expect(limits.map((limit) => limit.ms)).toEqual([LIST_TIMEOUT_MS, LIST_TIMEOUT_MS, STOP_TIMEOUT_MS]));
      expect(events).toEqual([`lock ${A}`]);
      limits[2].controller.abort();
      expect(await ticked).toEqual([]);
      expect(events).toEqual([`lock ${A}`, `release ${A}`]);
      expect(lines).toContain('The container devenv-api could not be stopped: Docker did not answer within 60 seconds.');
    });
  });
});
