// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review round 1 of PR #100 (B, mutation probes): the ensure over MonitorEngine (runSpec, create, the clock of the daemon)
// and parseDockerTime.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../ports';
import { parseDockerTime, type MonitorEngine } from './monitorEngine';
import { REMOTE_MONITOR_READY_TEXT } from './protocol';
import { RemoteSessionMonitor } from './remoteSessionMonitor';

const SCRIPT = 'console.log("monitor")';
const unused = (): never => {
  throw new Error('not expected');
};

function logger(lines: string[]): Logger {
  return { info: (text) => lines.push(text), warn: (text) => lines.push(text), error: (text) => lines.push(text), output: () => {} };
}

function engine(methods: Partial<MonitorEngine>): MonitorEngine {
  return { inspect: unused, daemonTime: unused, remove: unused, start: unused, storedScript: unused, idsWithLabel: unused, create: unused, ...methods };
}

describe('the ensure over MonitorEngine, probes (review round 1 of PR #100, B)', () => {
  afterEach(() => vi.useRealTimers());

  it('image maintenance without prefixes sets no variables', () => {
    const monitor = new RemoteSessionMonitor({ engine: engine({}), logger: logger([]), script: async () => SCRIPT });
    // Plan step 11H2 (D2, decision of 2026-10-09): changed expectation, the schedule and the time zone of the background run
    // go to the container also without prefixes (the VS Code server and the cleanup always run); was no variable. Still no
    // prefixes.
    expect(monitor.runSpec('img', '/sock', 'label', SCRIPT, { prefixes: [], schedule: '7 6 * * *', timeZone: 'UTC' }, 'n1').env).toEqual({ DEVENV_IMAGE_SCHEDULE: '7 6 * * *', DEVENV_IMAGE_TZ: 'UTC' });
  });

  it('the create waits for the ready text of the monitor', async () => {
    const create = vi.fn(async () => ({ kind: 'ready' as const }));
    const monitor = new RemoteSessionMonitor({ engine: engine({ inspect: async () => ({ exists: false }), create }), logger: logger([]), script: async () => SCRIPT });
    expect(await monitor.ensureOrThrow('devenv-helper:0123456789ab', '/sock')).toBe('created');
    expect(create).toHaveBeenCalledWith(expect.anything(), expect.any(String), REMOTE_MONITOR_READY_TEXT, undefined);
  });

  it('logs why the clock of the daemon cannot be read', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const created = { exists: true as const, status: 'created', exitCode: 0, label: 'x', restartCount: 0, id: 'feed'.padEnd(64, '1'), createdAt: 1 };
    const monitor = new RemoteSessionMonitor({ engine: engine({ inspect: async () => created, daemonTime: async () => ({ reason: 'clock gone' }) }), logger: logger(lines), script: async () => SCRIPT });
    const ensuring = monitor.ensureOrThrow('devenv-helper:0123456789ab', '/sock');
    ensuring.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(ensuring).rejects.toThrow('its age cannot be read');
    expect(lines).toContain('The time of the Docker host cannot be read: clock gone');
  });

  it('parseDockerTime: no second 60', () => {
    expect(parseDockerTime('2026-10-04T12:00:60Z')).toBeUndefined();
  });
});
