// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Cleanup C5 (plan step 11J, B4): the waits while the monitor container stays `created` (REMOTE_MONITOR_CREATED_WAITS_MS)
// and after a name conflict (REMOTE_MONITOR_CONFLICT_WAITS_MS) are the wait of ports.ts (sleep), with the semantics of
// the copy it replaces: each wait lasts its time, and a cancellation ends a running wait at once with an AbortError (no
// further look at the container).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../ports';
import type { MonitorEngine, MonitorInspected } from './monitorEngine';
import { REMOTE_MONITOR_CONFLICT_WAITS_MS, REMOTE_MONITOR_CREATED_WAITS_MS, RemoteSessionMonitor } from './remoteSessionMonitor';

const TAG = 'devenv-helper:0123456789ab';
const SOCKET = '/var/run/docker.sock';
const ID = 'feed'.padEnd(64, '1');
const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, output: () => {} };

/** An engine whose container of the name is `found` at each look after the first (`first`); a create meets a conflict. */
function engineOf(first: MonitorInspected, found: MonitorInspected) {
  const calls: string[] = [];
  const engine: MonitorEngine = {
    inspect: async () => (calls.push('inspect'), calls.filter((call) => call === 'inspect').length === 1 ? first : found),
    daemonTime: async () => Date.now(),
    remove: async () => void calls.push('remove'),
    start: async () => void calls.push('start'),
    storedScript: async () => 'unknown',
    idsWithLabel: async () => [],
    create: async () => (calls.push('create'), { kind: 'exited', detail: 'Conflict. The container name is already in use', conflict: true }),
  };
  return { engine, calls };
}

const inState = (status: string): MonitorInspected => ({ exists: true, status, exitCode: undefined, label: 'other', restartCount: 0, id: ID, createdAt: Date.now() });

describe('the waits of the monitor while its container is created (cleanup C5, B4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('each wait lasts its time; a cancellation ends a running wait at once with an AbortError', async () => {
    vi.useFakeTimers();
    const { engine, calls } = engineOf(inState('created'), inState('created'));
    const monitor = new RemoteSessionMonitor({ engine, logger, script: async () => 'console.log("monitor")' });
    const controller = new AbortController();
    const ensured = monitor.ensure(TAG, SOCKET, controller.signal);
    const outcome = ensured.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(REMOTE_MONITOR_CREATED_WAITS_MS[0] - 1);
    expect(calls).toEqual(['inspect']);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['inspect', 'inspect']);
    // In the second wait: the cancellation ends it without the rest of its time.
    await vi.advanceTimersByTimeAsync(REMOTE_MONITOR_CREATED_WAITS_MS[1] - 100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['inspect', 'inspect']);
  });

  it('the waits after a name conflict: each lasts its time; a cancellation ends a running wait at once', async () => {
    vi.useFakeTimers();
    const { engine, calls } = engineOf({ exists: false }, inState('removing'));
    const monitor = new RemoteSessionMonitor({ engine, logger, script: async () => 'console.log("monitor")' });
    const controller = new AbortController();
    const outcome = monitor.ensure(TAG, SOCKET, controller.signal).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['inspect', 'create', 'inspect']);
    await vi.advanceTimersByTimeAsync(REMOTE_MONITOR_CONFLICT_WAITS_MS[0] - 1);
    expect(calls).toEqual(['inspect', 'create', 'inspect']);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['inspect', 'create', 'inspect', 'inspect']);
    await vi.advanceTimersByTimeAsync(REMOTE_MONITOR_CONFLICT_WAITS_MS[1] - 100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter((call) => call === 'inspect')).toHaveLength(3);
  });
});
