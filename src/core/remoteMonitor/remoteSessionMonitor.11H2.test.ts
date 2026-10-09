// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, D1, and the user's decision "unless-stopped" of the same day): the container of
// the Session Monitor by its mode: a permanent monitor (a remote engine, or a local one with stopLocalMonitorWhenIdle
// off) has the restart policy `unless-stopped` and its part of the label, one that ends when idle `on-failure`; both have
// the default network and the shared VS Code server store of the worker. A change of the mode replaces the container,
// except that an ensure of a monitor that ends when idle takes a running permanent one of the same version as current.
import { describe, expect, it } from 'vitest';
import type { Logger } from '../ports';
import type { MonitorCreated, MonitorEngine, MonitorInspected, MonitorRunSpec } from './monitorEngine';
import { PERMANENT_MONITOR_LABEL_PART, remoteMonitorLabelValue } from './protocol';
import { RemoteSessionMonitor, monitorLabel } from './remoteSessionMonitor';

const SCRIPT = 'console.log("monitor")';
const TAG = 'devenv-helper:0123456789ab';
const SOCKET = '/var/run/docker.sock';
const ID = 'feed'.padEnd(64, '1');
const IMAGES = { prefixes: [] as string[], schedule: '17', timeZone: 'UTC' };
const IDLE = monitorLabel(SCRIPT, TAG, false);
const PERMANENT = monitorLabel(SCRIPT, TAG, true);

const logger = (): Logger => ({ info: () => {}, warn: () => {}, error: () => {}, output: () => {} });

/** A MonitorEngine in memory: the container of the name (`found`, one per inspect, the last one repeats), and its calls. */
function fakeEngine(found: MonitorInspected[], created: MonitorCreated[] = [{ kind: 'ready' }]) {
  const calls: string[] = [];
  const specs: MonitorRunSpec[] = [];
  let looks = 0;
  let creates = 0;
  const engine: MonitorEngine = {
    inspect: async () => {
      calls.push('inspect');
      return found[Math.min(looks++, found.length - 1)];
    },
    daemonTime: async () => Date.now(),
    remove: async (id) => void calls.push(`remove ${id}`),
    start: async (id) => void calls.push(`start ${id}`),
    storedScript: async () => 'unknown',
    idsWithLabel: async () => [],
    create: async (spec) => {
      calls.push('create');
      specs.push(spec);
      return created[Math.min(creates++, created.length - 1)];
    },
  };
  return { engine, calls, specs };
}

const running = (label: string): MonitorInspected => ({ exists: true, status: 'running', exitCode: 0, label, restartCount: 0, id: ID, createdAt: undefined });
const exited = (label: string): MonitorInspected => ({ exists: true, status: 'exited', exitCode: 0, label, restartCount: 0, id: ID, createdAt: undefined });

function monitorOf(engine: MonitorEngine, permanent: boolean | undefined, store?: string): RemoteSessionMonitor {
  return new RemoteSessionMonitor({
    engine,
    logger: logger(),
    script: async () => SCRIPT,
    imageMaintenance: () => ({ ...IMAGES, ...(permanent !== undefined ? { permanent } : {}) }),
    ...(store !== undefined ? { vscodeStoreVolume: store } : {}),
  });
}

describe('the container of the Session Monitor by its mode (plan step 11H2)', () => {
  it('a permanent monitor: unless-stopped, its variable, its label part; one that ends when idle: on-failure, neither', () => {
    const { engine } = fakeEngine([{ exists: false }]);
    const permanent = monitorOf(engine, true).runSpec(TAG, SOCKET, PERMANENT, SCRIPT, { ...IMAGES, permanent: true });
    expect(permanent.restartPolicy).toBe('unless-stopped');
    expect(permanent.env.DEVENV_MONITOR_PERMANENT).toBe('1');
    expect(PERMANENT).toBe(remoteMonitorLabelValue(SCRIPT, TAG, [PERMANENT_MONITOR_LABEL_PART]));
    expect(PERMANENT).not.toBe(IDLE);
    for (const images of [{ ...IMAGES, permanent: false }, IMAGES, undefined]) {
      const idle = monitorOf(engine, false).runSpec(TAG, SOCKET, IDLE, SCRIPT, images);
      expect(idle.restartPolicy).toBe('on-failure');
      expect(idle.env).not.toHaveProperty('DEVENV_MONITOR_PERMANENT');
    }
  });

  it('always has the default network, with or without prefixes, in either mode', () => {
    const { engine } = fakeEngine([{ exists: false }]);
    for (const images of [undefined, IMAGES, { ...IMAGES, prefixes: ['ghcr.io/acme/base'] }, { ...IMAGES, permanent: true }]) {
      expect(monitorOf(engine, undefined).runSpec(TAG, SOCKET, IDLE, SCRIPT, images).network).toBe('default');
    }
  });

  it('mounts the store of the worker read-write at /vscode and names it; without one, no store', () => {
    const { engine } = fakeEngine([{ exists: false }]);
    const spec = monitorOf(engine, false, 'devenv-test-vscode').runSpec(TAG, SOCKET, IDLE, SCRIPT, IMAGES);
    expect(spec.mounts).toEqual({ socket: SOCKET, volume: 'devenv-session-monitor', volumeTarget: '/state', store: { volume: 'devenv-test-vscode', target: '/vscode' } });
    expect(spec.env.DEVENV_VSCODE_STORE).toBe('devenv-test-vscode');
    const without = monitorOf(engine, false).runSpec(TAG, SOCKET, IDLE, SCRIPT, IMAGES);
    expect(without.mounts).toEqual({ socket: SOCKET, volume: 'devenv-session-monitor', volumeTarget: '/state' });
    expect(without.env).not.toHaveProperty('DEVENV_VSCODE_STORE');
  });

  it('creates a missing monitor with the label of its mode', async () => {
    for (const [permanent, label] of [
      [true, PERMANENT],
      [false, IDLE],
    ] as const) {
      const { engine, specs } = fakeEngine([{ exists: false }]);
      expect(await monitorOf(engine, permanent).ensureOrThrow(TAG, SOCKET)).toBe('created');
      expect(specs[0].labels['nimblescape.devenv.session-monitor']).toBe(label);
      expect(specs[0].restartPolicy).toBe(permanent ? 'unless-stopped' : 'on-failure');
    }
  });
});

describe('the change of the mode at the next ensure (plan step 11H2, D1)', () => {
  it('keeps a running monitor of the same mode', async () => {
    for (const [permanent, label] of [
      [true, PERMANENT],
      [false, IDLE],
    ] as const) {
      const { engine, calls } = fakeEngine([running(label)]);
      expect(await monitorOf(engine, permanent).ensureOrThrow(TAG, SOCKET)).toBe('running');
      expect(calls).toEqual(['inspect']);
    }
  });

  it('replaces a running monitor that ends when idle by a permanent one (a remote engine, or the setting turned off)', async () => {
    const { engine, calls, specs } = fakeEngine([running(IDLE)]);
    expect(await monitorOf(engine, true).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(calls).toEqual(['inspect', `remove ${ID}`, 'create']);
    expect(specs[0].restartPolicy).toBe('unless-stopped');
  });

  it('a window that sees the engine as local keeps a running permanent monitor of the same version', async () => {
    const { engine, calls } = fakeEngine([running(PERMANENT)]);
    expect(await monitorOf(engine, false).ensureOrThrow(TAG, SOCKET)).toBe('running');
    expect(calls).toEqual(['inspect']);
    // Without the mode (an older wiring): the same.
    const unset = fakeEngine([running(PERMANENT)]);
    expect(await monitorOf(unset.engine, undefined).ensureOrThrow(TAG, SOCKET)).toBe('running');
  });

  it('a permanent monitor of another version, or one that does not run, is replaced by one that ends when idle', async () => {
    const other = fakeEngine([running(monitorLabel('console.log("older")', TAG, true))]);
    expect(await monitorOf(other.engine, false).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(other.specs[0].restartPolicy).toBe('on-failure');
    const stopped = fakeEngine([exited(PERMANENT)]);
    expect(await monitorOf(stopped.engine, false).ensureOrThrow(TAG, SOCKET)).toBe('created');
    expect(stopped.calls).toEqual(['inspect', `remove ${ID}`, 'create']);
  });

  it('a name conflict of the create: a running permanent monitor of another window counts as current for one that ends when idle', async () => {
    const conflict: MonitorCreated = { kind: 'exited', detail: 'Conflict. The container name "/devenv-session-monitor" is already in use', conflict: true };
    const { engine, calls } = fakeEngine([{ exists: false }, running(PERMANENT)], [conflict]);
    expect(await monitorOf(engine, false).ensureOrThrow(TAG, SOCKET)).toBe('running');
    expect(calls).toEqual(['inspect', 'create', 'inspect']);
    // A permanent ensure does not take one that ends when idle there.
    const other = fakeEngine([{ exists: false }, running(IDLE)], [conflict]);
    await expect(monitorOf(other.engine, true).ensureOrThrow(TAG, SOCKET)).rejects.toThrow(/docker run failed/);
  });
});
