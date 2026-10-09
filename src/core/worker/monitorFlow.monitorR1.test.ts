// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review B, round 1 of plan step 11D1 (mutation probes): monitorCommand and its senders.
import { describe, expect, it } from 'vitest';
import { REMOTE_MONITOR_CONTAINER } from '../remoteMonitor/protocol';
import { scriptCommand } from './containerScripts';
import { EngineError, type DockerEngine, type EngineExecOptions, type EngineExecResult } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { forgetRecord, monitorCommand, sendHeartbeat, sendMonitorSettings } from './monitorFlow';

const SOURCE = '0123456789abcdef0123456789abcdef';
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const HEARTBEAT = { source: SOURCE, limitSeconds: 600, environments: [{ id: ID, keepRunning: true, seq: 1 }] };
const IMAGES = { prefixes: ['ghcr.io/majikmate/devcontainer-dev'], schedule: '7 6 * * *', timeZone: 'Europe/Vienna' };
const result = (exitCode: number | null, stdout = '', stderr = '', timedOut = false): EngineExecResult => ({ exitCode, stdout, stderr, timedOut });

function engineWith(answer: () => Promise<EngineExecResult>) {
  const calls: { container: string; command: readonly string[]; options?: EngineExecOptions }[] = [];
  const engine: DockerEngine = { ...unusedEngine(), exec: async (container, command, options) => (calls.push({ container, command, options }), answer()) };
  return { engine, calls };
}
const exited = (value: EngineExecResult) => sendHeartbeat(engineWith(async () => value).engine, HEARTBEAT);
const thrown = (error: unknown) => sendHeartbeat(engineWith(() => Promise.reject(error)).engine, HEARTBEAT);

describe('monitorCommand (review B-R1 probes, plan step 11D1)', () => {
  it('a command that timed out is a failure even with exit code 0 (MF6)', async () => {
    expect(await exited(result(0, '', '', true))).toEqual({ ok: false, missing: false, detail: 'docker exec did not end within 20 seconds.' });
  });

  it('the detail is stderr, else stdout (MF8, MF9)', async () => {
    expect(await exited(result(1, 'from stdout', ''))).toEqual({ ok: false, missing: false, detail: 'from stdout' });
    expect(await exited(result(1, 'from stdout', 'from stderr'))).toEqual({ ok: false, missing: false, detail: 'from stderr' });
  });

  it('a command without the lock of the records gets the bare exit code for 75 and 137 (MF11)', async () => {
    // Plan step 11I (U2, decision of 2026-10-08): changed test, the command is an entry of the registry without the lock
    // (monitorImages; `['node', 'x']` before, which no caller may build any more).
    const bare = async (code: number) => monitorCommand(engineWith(async () => result(code)).engine, 'monitorImages', [], { input: '{"repositories":[]}' });
    expect(await bare(75)).toEqual({ ok: false, missing: false, detail: 'exit code 75' });
    expect(await bare(137)).toEqual({ ok: false, missing: false, detail: 'exit code 137' });
  });

  it('only a 409 "is not running" (in any case) or a 404 is missing (MF16, MF18)', async () => {
    expect(await thrown(new EngineError('Container 1234 is not running', 500))).toMatchObject({ ok: false, missing: false });
    expect(await thrown(new EngineError('Container 1234 Is Not Running', 409))).toMatchObject({ ok: false, missing: true });
  });

  it('clips a long error and keeps a detail of exactly the limit (MF20, MF21)', async () => {
    const long = await thrown(new Error('y'.repeat(5000)));
    expect(long.ok === false && long.detail.length).toBe(2000);
    expect(long.ok === false && long.detail.endsWith('…')).toBe(true);
    const exact = 'z'.repeat(2000);
    expect(await exited(result(1, '', exact))).toEqual({ ok: false, missing: false, detail: exact });
  });

  it('the image settings and list carry the signal; forget may name its container (MF26, MF27, MF33)', async () => {
    const { engine, calls } = engineWith(async () => result(0));
    const signal = new AbortController().signal;
    await sendMonitorSettings(engine, { settings: IMAGES }, signal);
    await sendMonitorSettings(engine, { repositories: ['ghcr.io/majikmate/devcontainer-dev'] }, signal);
    expect(calls.map((call) => call.options?.signal)).toEqual([signal, signal]);
    await forgetRecord(engine, SOURCE, ID, 'devenv-test-monitor');
    // Plan step 11I (U2, decision of 2026-10-08): the command of the entry monitorForget (forgetCommand before).
    expect(calls[2]).toMatchObject({ container: 'devenv-test-monitor', command: scriptCommand('monitorForget', [SOURCE, ID]) });
    expect(calls[2].container).not.toBe(REMOTE_MONITOR_CONTAINER);
  });
});
