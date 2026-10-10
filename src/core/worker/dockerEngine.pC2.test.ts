// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup after plan step 11 (PR C2, B5): isNotRunning, the one rule for "the container of an exec does not exist or does
// not run", and what it changed for its callers (a 404 that names no container is no evidence any more).
import { describe, expect, it } from 'vitest';
import { REMOTE_MONITOR_CONTAINER } from '../remoteMonitor/protocol';
import { EngineError, isNotRunning, type DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { engineMonitor } from './engineMonitor';
import { sendHeartbeat } from './monitorFlow';

const ID = 'feed'.padEnd(64, '1');

describe('isNotRunning (PR C2, B5)', () => {
  it('a missing container (404 "No such container") or one that does not run (409 "is not running"); "restarting" only when asked', () => {
    const cases: [unknown, boolean, boolean][] = [
      [new EngineError(`No such container: ${ID}`, 404), true, true],
      // Podman's compatible API names it in lower case.
      [new EngineError(`no container with name or ID "x" found: no such container`, 404), true, true],
      [new EngineError(`Container ${ID} is not running`, 409), true, true],
      [new EngineError(`Container ${ID} is restarting, wait until the container is running`, 409), false, true],
      [new EngineError(`Container ${ID} is paused, unpause the container before exec`, 409), false, false],
      [new EngineError(`No such exec instance: ${ID}`, 404), false, false],
      [new EngineError(`Container ${ID} is not running`, 500), false, false],
      [new Error(`No such container: ${ID}`), false, false],
      ['No such container', false, false],
    ];
    for (const [error, plain, restarting] of cases) {
      expect(isNotRunning(error), String(error)).toBe(plain);
      expect(isNotRunning(error, { restarting: true }), String(error)).toBe(restarting);
    }
  });
});

describe('the callers whose rule changed (PR C2, B5, behaviour change)', () => {
  const failingExec = (error: Error): DockerEngine => ({ ...unusedEngine(), exec: async () => Promise.reject(error) });

  // Cleanup after plan step 11 (PR C2, B5): changed behaviour, a 404 that names no container (the exec instance is gone)
  // is no evidence that the monitor container is missing (before: any 404 was `missing`, and the window started the
  // monitor again); the other answers stay as before (monitorFlow.test.ts).
  it('a heartbeat: a 404 "No such exec instance" is a failure, not a missing monitor', async () => {
    const answer = await sendHeartbeat(failingExec(new EngineError(`No such exec instance: ${ID}`, 404)), { source: '0'.repeat(32), limitSeconds: 600, environments: [] }, undefined, REMOTE_MONITOR_CONTAINER);
    expect(answer).toEqual({ ok: false, missing: false, detail: `No such exec instance: ${ID}` });
  });

  // Cleanup after plan step 11 (PR C2, B5): changed behaviour, as above for the check of the stored script: `unknown`
  // (no evidence), not `none` (before: any 404); "restarting" stays evidence (engineMonitor.test.ts).
  it('the stored script: a 404 "No such exec instance" is unknown, not none', async () => {
    expect(await engineMonitor(failingExec(new EngineError(`No such exec instance: ${ID}`, 404))).storedScript('devenv-session-monitor')).toBe('unknown');
    expect(await engineMonitor(failingExec(new EngineError('No such container: devenv-session-monitor', 404))).storedScript('devenv-session-monitor')).toBe('none');
  });
});
