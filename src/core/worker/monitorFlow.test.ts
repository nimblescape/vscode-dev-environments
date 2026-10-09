// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D1 (decision of 2026-10-03): the commands of the Session Monitor as the worker sends them over the Engine
// API (monitorFlow). Ported from the tests of RemoteSessionMonitor.heartbeat, images and imageSettings (removed): the
// same commands, time limit, failure details and missing monitor. Plan step 11I (U2, decision of 2026-10-08): the
// commands are the entries of the registry (scriptCommand), in place of the removed builders of protocol.ts, with the
// same command lines.
import { describe, expect, it } from 'vitest';
import { REMOTE_MONITOR_CONTAINER, REMOTE_MONITOR_SCRIPT_PATH } from '../remoteMonitor/protocol';
import { scriptCommand } from './containerScripts';
import { EngineError, type DockerEngine, type EngineExecOptions, type EngineExecResult } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { MONITOR_EXEC_TIMEOUT_MS, forgetRecord, monitorCommand, sendHeartbeat, sendMonitorSettings } from './monitorFlow';

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

describe('the commands of the Session Monitor in the worker (plan step 11D1)', () => {
  it('sends a heartbeat to the monitor container under the lock of the records, within its time limit and the signal', async () => {
    const { engine, calls } = engineWith(async () => result(0));
    const controller = new AbortController();
    expect(await sendHeartbeat(engine, HEARTBEAT, controller.signal)).toEqual({ ok: true });
    // Plan step 11I (U2, decision of 2026-10-08): the command of the entry monitorHeartbeat (heartbeatCommand before).
    expect(calls).toEqual([{ container: REMOTE_MONITOR_CONTAINER, command: scriptCommand('monitorHeartbeat', [JSON.stringify(HEARTBEAT)]), options: { timeoutMs: 20_000, signal: controller.signal } }]);
    expect(MONITOR_EXEC_TIMEOUT_MS).toBe(20_000);
    expect(calls[0].command.slice(-4)).toEqual(['node', REMOTE_MONITOR_SCRIPT_PATH, 'heartbeat', JSON.stringify(HEARTBEAT)]);
    expect(calls[0].command[0]).toBe('flock');
  });

  it('tells a missing or stopped monitor from another failure, and names the busy lock, a kill and the time limit', async () => {
    const answer = async (thrown: unknown) => sendHeartbeat(engineWith(() => Promise.reject(thrown)).engine, HEARTBEAT);
    expect(await answer(new EngineError('No such container: devenv-session-monitor', 404))).toMatchObject({ ok: false, missing: true });
    expect(await answer(new EngineError('Container 1234 is not running', 409))).toMatchObject({ ok: false, missing: true });
    expect(await answer(new EngineError('Container 1234 is paused', 409))).toMatchObject({ ok: false, missing: false });
    expect(await answer(new Error('connect ENOENT'))).toEqual({ ok: false, missing: false, detail: 'connect ENOENT' });
    const exited = async (value: EngineExecResult) => sendHeartbeat(engineWith(async () => value).engine, HEARTBEAT);
    expect(await exited(result(2, '', 'Invalid heartbeat.'))).toEqual({ ok: false, missing: false, detail: 'Invalid heartbeat.' });
    expect(await exited(result(75))).toEqual({ ok: false, missing: false, detail: 'the heartbeat records stayed locked by another command for 5 s' });
    expect(await exited(result(137))).toMatchObject({ detail: 'the command was killed (its limit of 10 s, or a kill from outside)' });
    expect(await exited(result(null, '', '', true))).toEqual({ ok: false, missing: false, detail: 'docker exec did not end within 20 seconds.' });
    // A command without the lock gets the bare exit code; a long detail is clipped. Plan step 11I (U2, decision of
    // 2026-10-08): changed test, the command is an entry of the registry without the lock (monitorSettings; `['true']`
    // before, which no caller may build any more).
    expect(await monitorCommand(engineWith(async () => result(4)).engine, 'monitorSettings', [], { input: '{}' })).toMatchObject({ detail: 'exit code 4' });
    const long = await exited(result(1, '', 'x'.repeat(5000)));
    expect(long.ok === false && long.detail.length).toBe(2000);
  });

  it('passes a cancel on as an AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    const { engine } = engineWith(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    await expect(sendHeartbeat(engine, HEARTBEAT, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('gives the monitor the image settings and the image list on the input of their commands', async () => {
    const { engine, calls } = engineWith(async () => result(0));
    expect(await sendMonitorSettings(engine, { settings: IMAGES })).toEqual({ ok: true });
    expect(await sendMonitorSettings(engine, { repositories: ['ghcr.io/majikmate/devcontainer-dev'] })).toEqual({ ok: true });
    expect(calls.map((call) => [call.container, call.command, call.options?.input])).toEqual([
      [REMOTE_MONITOR_CONTAINER, ['node', REMOTE_MONITOR_SCRIPT_PATH, 'settings', '-'], JSON.stringify(IMAGES)],
      [REMOTE_MONITOR_CONTAINER, ['node', REMOTE_MONITOR_SCRIPT_PATH, 'images', '-'], JSON.stringify({ repositories: ['ghcr.io/majikmate/devcontainer-dev'] })],
    ]);
    expect(await sendMonitorSettings(engineWith(async () => result(2, '', 'Invalid image list.')).engine, { repositories: [] })).toEqual({ ok: false, missing: false, detail: 'Invalid image list.' });
  });

  it("removes Delete's record of the computer, and a test may name its own monitor container", async () => {
    const { engine, calls } = engineWith(async () => result(0));
    await forgetRecord(engine, SOURCE, ID);
    await sendHeartbeat(engine, HEARTBEAT, undefined, 'devenv-test-monitor');
    // Plan step 11I (U2, decision of 2026-10-08): the commands of the entries monitorForget and monitorHeartbeat
    // (forgetCommand and heartbeatCommand before), the same command lines.
    expect(calls.map((call) => [call.container, call.command])).toEqual([
      [REMOTE_MONITOR_CONTAINER, scriptCommand('monitorForget', [SOURCE, ID])],
      ['devenv-test-monitor', scriptCommand('monitorHeartbeat', [JSON.stringify(HEARTBEAT)])],
    ]);
  });

  // Plan step 11I (U2, decision of 2026-10-08): the failure text of a command under the lock of the records still names the
  // busy lock or the kill (isUnderRecordsLock of the command of the entry), Delete's forget as the heartbeat; the image
  // settings and list, without the lock, get the bare exit code.
  it('names the busy lock and the kill for the commands under the lock of the records only (plan step 11I, U2)', async () => {
    const forget = async (code: number) => forgetRecord(engineWith(async () => result(code)).engine, SOURCE, ID);
    expect(await forget(75)).toEqual({ ok: false, missing: false, detail: 'the heartbeat records stayed locked by another command for 5 s' });
    expect(await forget(137)).toEqual({ ok: false, missing: false, detail: 'the command was killed (its limit of 10 s, or a kill from outside)' });
    const images = async (code: number) => sendMonitorSettings(engineWith(async () => result(code)).engine, { repositories: [] });
    expect(await images(75)).toEqual({ ok: false, missing: false, detail: 'exit code 75' });
    expect(await images(137)).toEqual({ ok: false, missing: false, detail: 'exit code 137' });
  });

  // Plan step 11I (U2, decision of 2026-10-08): only the image settings and list carry an input; the heartbeat and the
  // forget carry none (their arguments are on the command line, as before).
  it('gives an input to the image settings and list only (plan step 11I, U2)', async () => {
    const { engine, calls } = engineWith(async () => result(0));
    await sendHeartbeat(engine, HEARTBEAT);
    await forgetRecord(engine, SOURCE, ID);
    await sendMonitorSettings(engine, { settings: IMAGES });
    expect(calls.map((call) => call.options?.input)).toEqual([undefined, undefined, JSON.stringify(IMAGES)]);
    expect(calls.every((call) => call.options?.secretInputName === undefined)).toBe(true);
  });
});
