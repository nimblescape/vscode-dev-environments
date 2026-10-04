// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11D2 (decision of 2026-10-03): the operation `monitorEnsure` of the worker: the ensure of the Session Monitor
// container (RemoteSessionMonitor over engineMonitor) with the worker's own helper image and socket and the script of its
// bundle, against a small engine in memory.
import { describe, expect, it } from 'vitest';
import { bundleHash, encodeBundle } from '../core/loader/pipeLoader';
import { parseMonitorEnsureParams, parseMonitorEnsureValue } from '../core/helperChannel/protocol';
import { IMAGE_MAINTENANCE_LABEL_PART, LABEL_MONITOR_CREATE, LABEL_SESSION_MONITOR, remoteMonitorLabelValue } from '../core/remoteMonitor/protocol';
import type { MonitorCreated, MonitorRunSpec } from '../core/remoteMonitor/monitorEngine';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { OwnHelper } from '../core/worker/ownHelper';
import { monitorEnsureOperation } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const SCRIPT = 'console.log("the monitor of the test")';
const OWN: OwnHelper = { image: { tag: 'devenv-helper:0123456789ab', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const IMAGES = { prefixes: [] as string[], schedule: '7 6 * * *', timeZone: 'UTC' };
const RUNNING_ID = 'feed'.padEnd(64, '1');

function contextOf(secrets: Record<string, string> = {}) {
  const controller = new AbortController();
  const lines: string[] = [];
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets(secrets),
    progress: () => {},
    log: (text) => lines.push(text),
    output: () => {},
    docker: async () => {
      throw new Error('No Docker CLI call.');
    },
  };
  return { context, controller, lines };
}

function engineWith(state: { existing?: unknown; created?: MonitorCreated }) {
  const specs: MonitorRunSpec[] = [];
  const inputs: string[] = [];
  const removed: string[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    inspect: async () => state.existing,
    createAttached: async (spec, options) => {
      specs.push(spec);
      inputs.push(options.input);
      return state.created ?? { kind: 'ready' };
    },
    containerIds: async () => ['c0ffee'.padEnd(64, '0')],
    removeContainer: async (id) => void removed.push(id),
  };
  return { engine, specs, inputs, removed };
}

describe('the ensure of the Session Monitor in the worker (plan step 11D2)', () => {
  it('creates a missing monitor with the worker\'s helper image, its socket and the script of its bundle', async () => {
    const { engine, specs, inputs } = engineWith({});
    const value = await monitorEnsureOperation(() => engine, async () => OWN, () => SCRIPT)({ images: IMAGES }, contextOf().context);
    expect(parseMonitorEnsureValue(value)).toEqual({ outcome: 'created' });
    expect(specs).toHaveLength(1);
    const [spec] = specs;
    // The label names the tag; the container runs from the checked image ID.
    expect(spec.image).toBe(OWN.image.id);
    expect(spec.labels[LABEL_SESSION_MONITOR]).toBe(remoteMonitorLabelValue(SCRIPT, OWN.image.tag, []));
    expect(spec.labels[LABEL_MONITOR_CREATE]).toMatch(/^[0-9a-f-]{36}$/);
    expect(spec.mounts).toEqual({ socket: OWN.socket, volume: 'devenv-session-monitor', volumeTarget: '/state' });
    expect(spec.network).toBe('none');
    expect(spec.command.slice(-2)).toEqual([bundleHash(SCRIPT), 'startMonitor']);
    expect(inputs).toEqual([encodeBundle(SCRIPT)]);
  });

  it('with image maintenance: its part of the label, the default network and the settings of this computer', async () => {
    const { engine, specs } = engineWith({});
    const images = { prefixes: ['ghcr.io/acme/base'], schedule: '0 5 * * 1-5', timeZone: 'Europe/Vienna' };
    await monitorEnsureOperation(() => engine, async () => OWN, () => SCRIPT)({ images }, contextOf().context);
    expect(specs[0].labels[LABEL_SESSION_MONITOR]).toBe(remoteMonitorLabelValue(SCRIPT, OWN.image.tag, [IMAGE_MAINTENANCE_LABEL_PART]));
    expect(specs[0].network).toBe('default');
    expect(specs[0].env).toEqual({ DEVENV_IMAGE_PREFIXES: JSON.stringify(images.prefixes), DEVENV_IMAGE_SCHEDULE: images.schedule, DEVENV_IMAGE_TZ: images.timeZone });
  });

  it('keeps a running monitor of this version', async () => {
    const existing = { Id: RUNNING_ID, State: { Status: 'running', ExitCode: 0 }, Config: { Labels: { [LABEL_SESSION_MONITOR]: remoteMonitorLabelValue(SCRIPT, OWN.image.tag, []) } }, RestartCount: 0 };
    const { engine, specs } = engineWith({ existing });
    expect(await monitorEnsureOperation(() => engine, async () => OWN, () => SCRIPT)({ images: IMAGES }, contextOf().context)).toEqual({ outcome: 'running' });
    expect(specs).toEqual([]);
  });

  it('a failed create fails the operation with its cause, and removes the container of its nonce', async () => {
    const { engine, removed } = engineWith({ created: { kind: 'exited', detail: 'No such image', conflict: false } });
    await expect(monitorEnsureOperation(() => engine, async () => OWN, () => SCRIPT)({ images: IMAGES }, contextOf().context)).rejects.toMatchObject({
      code: 'failed',
      message: 'docker run failed: No such image',
    });
    expect(removed).toEqual(['c0ffee'.padEnd(64, '0')]);
    // The worker's own helper that cannot be read fails it too.
    await expect(
      monitorEnsureOperation(() => engine, async () => Promise.reject(new Error('no socket mount')), () => SCRIPT)({ images: IMAGES }, contextOf().context),
    ).rejects.toMatchObject({ code: 'failed', message: 'no socket mount' });
  });

  it('refuses parameters that do not fit and a secret before anything runs; a cancel is cancelled', async () => {
    const { engine, specs } = engineWith({});
    const operation = monitorEnsureOperation(() => engine, async () => OWN, () => SCRIPT);
    for (const odd of [{}, { images: { ...IMAGES, schedule: 'daily' } }, { images: IMAGES, extra: 1 }]) {
      await expect(operation(odd, contextOf().context), JSON.stringify(odd)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(operation({ images: IMAGES }, contextOf({ token: 'gho_x' }).context)).rejects.toMatchObject({ code: 'invalid' });
    expect(specs).toEqual([]);
    const { context, controller } = contextOf();
    const cancelled = monitorEnsureOperation(() => ({ ...engine, createAttached: async () => (controller.abort(), { kind: 'aborted' as const }) }), async () => OWN, () => SCRIPT);
    await expect(cancelled({ images: IMAGES }, context)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('the strict checks of its parameters and its value', () => {
    expect(parseMonitorEnsureParams({ images: IMAGES })).toEqual({ images: IMAGES });
    expect(parseMonitorEnsureParams({ images: { ...IMAGES, timeZone: 'Mars/Base' } })).toBeUndefined();
    expect(parseMonitorEnsureParams({ images: { ...IMAGES, prefixes: ['docker.io/library'] } })).toBeUndefined();
    expect(parseMonitorEnsureValue({ outcome: 'started' })).toEqual({ outcome: 'started' });
    for (const odd of [{ outcome: 'failed' }, { outcome: 'running', more: 1 }, null]) expect(parseMonitorEnsureValue(odd)).toBeUndefined();
  });
});
