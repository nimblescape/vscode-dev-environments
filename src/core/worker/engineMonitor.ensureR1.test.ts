// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #100 (B, mutation probes): engineMonitor.
import { describe, expect, it, vi } from 'vitest';
import { REMOTE_MONITOR_SCRIPT_PATH } from '../remoteMonitor/protocol';
import { EngineError, type DockerEngine, type EngineExecResult } from './dockerEngine';
import { unusedEngine } from './dockerEngine.testkit';
import { engineMonitor, limited, monitorInspected } from './engineMonitor';

const ID = 'feed'.padEnd(64, '1');
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const with_ = (methods: Partial<DockerEngine>) => engineMonitor({ ...unusedEngine(), ...methods });
const result = (exitCode: number | null, stdout = '', stderr = '', timedOut = false): EngineExecResult => ({ exitCode, stdout, stderr, timedOut });
/** A call that answers after 30 ms, unless its signal aborted by then. */
const slow = <T>(value: T) => async (signal?: AbortSignal): Promise<T> => {
  await delay(30);
  if (signal?.aborted) throw abortError();
  return value;
};
/** A call that rejects with an AbortError once its signal aborts. */
const untilAborted = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(abortError())));

describe('engineMonitor probes (review round 1 of PR #100, B)', () => {
  it('limited: a cancel passes as such also when the time limit ran out meanwhile', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(limited(1, controller.signal, async () => (await delay(30), Promise.reject(abortError())))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('monitorInspected: null labels, a fractional restart count and an ID with more than 64 hex digits are not read', () => {
    expect(monitorInspected({ Config: { Labels: null }, RestartCount: 1.5, Id: `x${ID}` })).toMatchObject({ label: '', restartCount: 0, id: undefined });
  });

  it('each call has the time limit of a Docker call (60 s), not less', async () => {
    expect(await with_({ inspect: (_kind, _name, signal) => slow({ Id: ID })(signal) }).inspect('m')).toMatchObject({ exists: true, id: ID });
    expect(await with_({ systemTime: (signal) => slow('2026-10-04T12:00:00Z')(signal) }).daemonTime()).toBe(Date.parse('2026-10-04T12:00:00Z'));
    await expect(with_({ removeContainer: (_id, signal) => slow(undefined)(signal) }).remove(ID)).resolves.toBeUndefined();
    await expect(with_({ start: (_id, signal) => slow(undefined)(signal) }).start(ID)).resolves.toBeUndefined();
    expect(await with_({ containerIds: (_filters, signal) => slow([ID])(signal) }).idsWithLabel('a=b')).toEqual([ID]);
  });

  it('a cancel passes from the clock, the removal, the start and the list', async () => {
    const cancelled = () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      return controller.signal;
    };
    await expect(with_({ systemTime: untilAborted }).daemonTime(cancelled())).rejects.toMatchObject({ name: 'AbortError' });
    await expect(with_({ removeContainer: (_id, signal) => untilAborted(signal) }).remove(ID, cancelled())).rejects.toMatchObject({ name: 'AbortError' });
    await expect(with_({ start: (_id, signal) => untilAborted(signal) }).start(ID, cancelled())).rejects.toMatchObject({ name: 'AbortError' });
    await expect(with_({ containerIds: (_filters, signal) => untilAborted(signal) }).idsWithLabel('a=b', cancelled())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('an AbortError without a cancel is a failure of the inspect; a failure after a cancel is a reason of the clock', async () => {
    await expect(with_({ inspect: async () => Promise.reject(abortError()) }).inspect('m')).rejects.toThrow('docker container inspect failed: The operation was aborted.');
    const controller = new AbortController();
    controller.abort();
    expect(await with_({ systemTime: async () => Promise.reject(new Error('socket hang up')) }).daemonTime(controller.signal)).toEqual({ reason: 'socket hang up' });
  });

  it('the clock: an odd answer is cut to 64 characters in the reason', async () => {
    const text = 'y'.repeat(100);
    expect(await with_({ systemTime: async () => text }).daemonTime()).toEqual({ reason: `the engine gave the time ${JSON.stringify('y'.repeat(64))}` });
  });

  it('remove: only the engine\'s refusal (any case) is a removal in progress', async () => {
    await expect(with_({ removeContainer: async () => Promise.reject(new Error(`removal of container ${ID} is already in progress`)) }).remove(ID)).rejects.toThrow('docker rm failed');
    await expect(with_({ removeContainer: async () => Promise.reject(new EngineError(`Removal of container ${ID} is already in progress`, 409)) }).remove(ID)).resolves.toBeUndefined();
  });

  it('start: by the ID', async () => {
    const start = vi.fn(async () => {});
    await with_({ start }).start(ID);
    expect(start).toHaveBeenCalledWith(ID, expect.any(AbortSignal));
  });

  it('storedScript: a check past its time is unknown whatever it printed; the cancel goes to the exec; a 409 alone is no evidence', async () => {
    const timedOut = result(null, '', `sha256sum: ${REMOTE_MONITOR_SCRIPT_PATH}: No such file or directory\n`, true);
    expect(await with_({ exec: async () => timedOut }).storedScript('m')).toBe('unknown');
    const exec = vi.fn(async () => result(0, 'abc'));
    const signal = new AbortController().signal;
    await with_({ exec }).storedScript('m', signal);
    expect(exec).toHaveBeenCalledWith('m', ['sha256sum', REMOTE_MONITOR_SCRIPT_PATH], { timeoutMs: 20_000, signal });
    expect(await with_({ exec: async () => Promise.reject(new EngineError(`Container ${ID} is not running`, 500)) }).storedScript('m')).toBe('unknown');
  });
});
