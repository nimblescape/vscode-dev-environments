// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 1 of PR #126 (reviewer B), mutation probes of the loop of the Session Monitor over the Engine API
// (src/remoteMonitor/main.ts): the failure of the list under the lock of an environment (mutant M20), the log of a
// failed stop once per series (mutant M32), and the records of a volume without the folder of the records, which only
// a deleted test of the removed subcommand `records` covered (mutant DT3). Each test names the mutant it kills.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LABEL_ENVIRONMENT_ID } from '../core/names';
import { abortError } from '../core/ports';
import { heartbeatFileName } from '../core/remoteMonitor/protocol';
import { EngineError, type EngineContainerSummary } from '../core/worker/dockerEngine';
import type { LoopEngine } from './engine';
import { RemoteMonitorLoop, heartbeatDir, readRecords } from './main';
import { REMOTE_GAP_MS, REMOTE_TICK_MS } from './rules';

const A = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const SOURCE = '0123456789abcdef0123456789abcdef';
const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const MINUTE = 60_000;
const DEV_ID = 'a'.repeat(64);

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devenv-remote-monitor-11imr1-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/**
 * The dev container of A as the list of the engine gives it (running unless `rawState` says otherwise). Review round 1
 * of PR #126 (F1): changed fixture, the summary of the list-only `containerSummaries` (its `state` is the word of the
 * list, the `rawState` of the container before; no image) in place of the container of `containers`, which the loop no
 * longer calls. The loop reads the same ID, name, state and labels as before.
 */
function devContainer(rawState = 'running'): EngineContainerSummary {
  return { id: DEV_ID, name: 'devenv-api', state: rawState, labels: { [LABEL_ENVIRONMENT_ID]: A } };
}

/** A record of A that is past its limit: A is to be stopped. */
function staleRecord(): void {
  const dir = heartbeatDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, heartbeatFileName(SOURCE, A)), JSON.stringify({ at: T0 - 30 * MINUTE, keepRunning: false, limitSeconds: 600, seq: 0 }));
}

/** A loop over `engine` whose stops need no wait after its start (no grace), with its log lines and a clock. */
function loopOf(engine: LoopEngine): { loop: RemoteMonitorLoop; lines: string[]; at: (time: number) => Promise<string[]> } {
  const lines: string[] = [];
  let now = T0;
  const loop = new RemoteMonitorLoop({
    engine,
    removeRecord: async () => false,
    dir: heartbeatDir(stateDir),
    lockEnvironment: async () => ({ kind: 'locked', release: () => {} }),
    now: () => now,
    log: (message) => lines.push(message),
    timing: { gapMs: REMOTE_GAP_MS, graceMs: 0 },
  });
  const at = async (time: number) => {
    now = time;
    const stopped = await loop.tick();
    await loop.removals;
    return stopped;
  };
  return { loop, lines, at };
}

describe('the loop of the Session Monitor over the Engine API (review round 1 of PR #126, B)', () => {
  // Kills M20 (the failure of the list under the lock names the 60 s of a stop): the list of the containers of an
  // environment under its lock that does not answer within its time limit names that limit, the 30 s of a list.
  it('names the time limit of the list when the list under the lock does not answer (M20)', async () => {
    staleRecord();
    // Review round 1 of PR #126 (F1): changed fixture, the list-only containerSummaries in place of containers (the same
    // label filters: the label alone for the tick, `<label>=<A>` under the lock); the assertions are unchanged.
    const { lines, at } = loopOf({
      containerSummaries: async (label) => (label === LABEL_ENVIRONMENT_ID ? [devContainer()] : Promise.reject(abortError())),
      stop: async () => {},
    });
    expect(await at(T0)).toEqual([]);
    expect(lines).toContain(`${A} is not stopped: its containers could not be listed again. Docker did not answer within 30 seconds.`);
  });

  // Kills M32 (a stop that succeeded does not end the series of failures): a failed stop is logged once per series, so
  // a stop that fails again after one succeeded (the container was started again meanwhile) is logged again.
  it('logs a failed stop again in a new series, after a stop of the environment succeeded (M32)', async () => {
    staleRecord();
    let failure: Error | undefined = new EngineError('cannot stop', 500);
    // Review round 1 of PR #126 (F1): changed fixture, the list-only containerSummaries in place of containers; the
    // assertions are unchanged.
    const { lines, at } = loopOf({
      containerSummaries: async () => [devContainer()],
      stop: async () => {
        if (failure !== undefined) throw failure;
      },
    });
    expect(await at(T0)).toEqual([]);
    expect(await at(T0 + REMOTE_TICK_MS)).toEqual([]);
    failure = undefined;
    expect(await at(T0 + 2 * REMOTE_TICK_MS)).toEqual([A]);
    // The container runs again (a user started it), and its stop fails again: a new series.
    failure = new EngineError('cannot stop it again', 500);
    expect(await at(T0 + 3 * REMOTE_TICK_MS)).toEqual([]);
    expect(await at(T0 + 4 * REMOTE_TICK_MS)).toEqual([]);
    expect(lines.filter((line) => line.includes('could not be stopped'))).toEqual([
      'The container devenv-api could not be stopped: cannot stop',
      'The container devenv-api could not be stopped: cannot stop it again',
    ]);
  });

  // Kills DT3 (readRecords rejects for a folder that does not exist): the deleted test 'prints no records when the folder
  // does not exist yet' of the removed subcommand `records` was the only one that read the records of a volume without
  // the folder of the records, which readRecords (kept: the loop reads them) answers with none.
  it('reads no records from a volume without the folder of the records, and a tick then stops nothing without a failure (DT3)', async () => {
    expect(fs.existsSync(heartbeatDir(stateDir))).toBe(false);
    expect(await readRecords(heartbeatDir(stateDir))).toEqual([]);
    // Review round 1 of PR #126 (F1): changed fixture, the list-only containerSummaries in place of containers (with the
    // old key the list of the tick failed, so the tick did not reach its records); the assertions are unchanged.
    const { lines, at } = loopOf({ containerSummaries: async () => [devContainer()], stop: async () => {} });
    expect(await at(T0)).toEqual([]);
    expect(lines.filter((line) => line.includes('could not be read'))).toEqual([]);
  });
});
