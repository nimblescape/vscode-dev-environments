// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of cleanup PR C2 (reviewer B, probes): the commands in the Session Monitor container read "missing"
// with isNotRunning without `restarting` (as before the PR: only 409 "is not running"), so a monitor container that
// restarts is not started again by the window.
import { describe, expect, it } from 'vitest';
import { REMOTE_MONITOR_CONTAINER } from '../remoteMonitor/protocol';
import { EngineError, type DockerEngine } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { sendHeartbeat } from './monitorFlow';

const ID = 'feed'.padEnd(64, '1');

describe('the commands of the Session Monitor and a restarting container (PR C2, B5, review round 1)', () => {
  it('a 409 "is restarting" is a failure, not a missing monitor', async () => {
    const error = new EngineError(`Container ${ID} is restarting, wait until the container is running`, 409);
    const engine: DockerEngine = { ...unusedEngine(), exec: async () => Promise.reject(error) };
    const answer = await sendHeartbeat(engine, { source: '0'.repeat(32), limitSeconds: 600, environments: [] }, undefined, REMOTE_MONITOR_CONTAINER);
    expect(answer).toEqual({ ok: false, missing: false, detail: error.message });
  });
});
